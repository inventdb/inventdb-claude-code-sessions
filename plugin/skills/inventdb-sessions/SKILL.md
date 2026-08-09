---
name: inventdb-sessions
description: Set up, verify, operate and query the InventDB session mirror — storing Claude Code session transcripts in InventDB as a searchable execution record. Invoke as `/inventdb-sessions setup <url>`, `status`, `search <query>`, `import`, `doctor`, or `uninstall`. Use this whenever the user wants to store/mirror/archive Claude Code sessions in InventDB, points at an InventDB URL for session capture, asks to search past sessions ("has anyone debugged this before", "what did we try that failed"), or reports that session capture stopped working.
---

# inventdb-sessions

You are running this skill because the user wants Claude Code sessions mirrored into
InventDB, or wants to query sessions already mirrored there.

## 0. Scope — state this plainly if asked

**Capture works on Claude Code only.** Hooks are a Claude Code feature, and Claude Code
is the only surface that writes local session transcripts. Claude Desktop and Claude on
the web (including Work/Teams/Enterprise) support MCP connectors but have no hooks and
no local transcript files — their session data lives server-side. On those surfaces you
can *query* an existing InventDB archive through MCP, but you cannot capture into it.

**This mirrors; it does not replace local storage.** `--resume`, `--continue`, the
session picker, `/rewind` and compaction all read
`~/.claude/projects/<project>/<session-id>.jsonl` directly from disk, and the shipper
reads those same files as its source. InventDB is the queryable archive; the local
`.jsonl` files remain the working store. Never propose deleting them or lowering
`cleanupPeriodDays` as part of setup.

## 1. Subcommands

| Invocation | Does |
|---|---|
| `/inventdb-sessions setup <url>` | Configure, verify end-to-end, install hooks, register MCP |
| `/inventdb-sessions status` | Target, watermarks, row counts |
| `/inventdb-sessions search <query>` | Query the archive (§4) |
| `/inventdb-sessions import` | Backfill historical transcripts |
| `/inventdb-sessions doctor` | Diagnose capture that stopped working |
| `/inventdb-sessions uninstall` | Remove hooks, keep data |

With no argument, ask which the user wants. Do not guess.

## 2. `setup`

### 2.1 Collect inputs

Ask for whatever is missing — never invent a host, and never echo the password back.

- **base URL**, e.g. `https://acme.inventdb.com` (no trailing slash)
- **namespace**, default `inventdb_claude`. Use underscores: a hyphenated namespace must
  be quoted in every SQL statement, which breaks the examples in §4.
- **credentials**: username and password, or a token.

### 2.2 Set the target

Use the CLI rather than hand-writing the config file:

```
node <plugin>/scripts/ship-session.mjs --set \
  --url https://acme.inventdb.com --namespace inventdb_claude \
  --user <user> --password <pass>
```

`--set` merges into `~/.claude/inventdb-sync/config.json` (created at mode 0600), warns
if the namespace is not a bare word, then verifies by logging in and prints the resolved
target. `--token <jwt>` works instead of a password.

`--show-config` prints the resolved path and the config with secrets redacted.

Config and state live in `~/.claude/inventdb-sync/`, never in the plugin directory,
which is replaced on update.

Every field is overridable by environment variable (`INVENTDB_SYNC_BASE`, `_NAMESPACE`,
`_USER`, `_PASSWORD`, `_TOKEN`, `INVENTDB_SYNC_CONFIG`) — prefer these when a password
on disk is unacceptable. `INVENTDB_SYNC_CONFIG` applies even when the file does not
exist yet.

### 2.3 Verify auth

```
node <plugin>/scripts/ship-session.mjs --ping
```

Expect `auth ok` and the resolved target. A failure here is a configuration problem;
fix it before continuing, because every later step depends on it.

### 2.4 Prove a write round-trips

This is the only step that proves namespace, credentials, permissions and the write path
work together. Write to a throwaway type, read it back, then remove it.

```
POST   <base>/api/<ns>/_probe/bulk     [{"probe":"hello","seq":1}]   -> 201
POST   <base>/sql                      SELECT probe, seq FROM <ns>._probe LIMIT 5
DELETE <base>/api/<ns>/_probe
```

Namespaces and types are created lazily on first write, so nothing needs declaring in
advance and no migration is needed when the transcript format gains fields.

### 2.5 Install the hooks

**As a plugin**, `hooks/hooks.json` ships with it and the five hooks are active once the
plugin is enabled. Skip to §2.6.

**Standalone**, merge into `~/.claude/settings.json` (all projects) or
`.claude/settings.json` (one project, committed for a team). Read the file first and
merge — overwriting silently drops the user's other settings.

Five events: `SessionStart`, `UserPromptSubmit`, `PostToolUse`, `Stop`, `SessionEnd`.
Each entry:

```json
{
  "hooks": [
    {
      "type": "command",
      "command": "node",
      "args": ["<abs path>/ship-session.mjs"],
      "async": true,
      "timeout": 120,
      "statusMessage": "Mirroring session to InventDB"
    }
  ]
}
```

Three requirements:

- **`"async": true`** on every hook, otherwise `PostToolUse` blocks every tool call.
- **Exec form** (`command` + `args`), not a shell string — it spawns node directly, so
  paths containing spaces work on Windows and POSIX alike.
- **No matcher** on `PostToolUse`, so every tool is captured.

If `node` is not on PATH in the hook environment, use an absolute interpreter path.

### 2.6 Register the MCP server

This is the read half — it lets you query the archive mid-conversation. InventDB serves
MCP at `POST <base>/mcp`; `sql`, `search`, `get` and `schema` are the useful tools here.

```
claude mcp add --transport http inventdb <base>/mcp --header "Authorization: Bearer <token>"
```

Prefer a bearer token. If the instance sits behind a reverse proxy, OAuth discovery may
advertise an address the client cannot reach.

### 2.7 Confirm and report

Hooks are picked up without a restart. Confirm rows exist:

```sql
SELECT COUNT(*) AS n FROM <ns>.session_line;
```

Report the target, namespace, active hooks and row count, and state plainly that the
local `.jsonl` files are unchanged. Historical transcripts are **not** imported unless
the user asks (§3).

## 3. `import` — backfilling history

### 3.1 Size it first and say the number

```
find ~/.claude/projects -name '*.jsonl' | wc -l
du -sh ~/.claude/projects
```

A single developer's history is routinely over 1 GB across more than 1,000 files, with
most of the bytes in a handful of very large transcripts. Report the total and let the
user decide. Never start a multi-gigabyte upload unprompted.

### 3.2 Run it

```
node <plugin>/scripts/ship-session.mjs --all        # everything, smallest first
node <plugin>/scripts/ship-session.mjs --file <p>   # one transcript
node <plugin>/scripts/ship-session.mjs --status     # watermarks
```

Run `--all` in the background and watch its output. It walks the projects tree
recursively: subagent and workflow transcripts live under `<session-id>/subagents/…`
and `…/workflows/…`, so a one-level scan misses most files.

### 3.3 What to expect

- **Failures are safe.** The watermark advances only after a successful write, so a
  failed file resumes at the exact byte. Re-running a synced transcript ships 0 rows.
- **Transient 5xx under sustained load is expected** and retried with backoff. Do not
  investigate these as content problems — re-send the same batch first; if it succeeds,
  it was load rather than the data.
- **A large import is real work for the server.** InventDB maintains indexes on write,
  so a bulk backfill does full property and vector indexing as it goes and can saturate
  a small instance until it catches up. Wait rather than restart it. Pace large loads,
  or start from adoption and let the archive build forward.

## 4. `search` — querying the archive

Use the MCP `sql` tool if registered, otherwise `POST <base>/sql`. Schema in §6.

```sql
-- Session index by name rather than UUID
SELECT session_id, title, ts FROM <ns>.session_line
WHERE title IS NOT NULL ORDER BY ts DESC;

-- Has anyone already debugged this error?  (no ORDER BY — see the sorting note)
SELECT session_id, ts, git_branch, cwd FROM <ns>.session_line
WHERE raw LIKE '%<error text>%';

-- What did this file look like before it was edited?
SELECT ts, session_id, raw FROM <ns>.session_line
WHERE raw LIKE '%<filename>%' AND raw LIKE '%old_string%' ORDER BY ts;

-- Who has the most context on a subsystem?
SELECT session_id, COUNT(*) AS lines FROM <ns>.session_line
WHERE raw LIKE '%<symbol>%' GROUP BY session_id ORDER BY lines DESC;

-- Sessions that captured screenshots or other binaries
SELECT session_id, seq, attachments FROM <ns>.session_line
WHERE attachments > 0 AND chunk_idx = 0;

-- Reconstruct a session in order
SELECT seq, kind, role, raw FROM <ns>.session_line
WHERE session_id = '<id>' ORDER BY seq;
```

`raw` holds the original transcript line byte-exact, so `LIKE` over it searches
everything — prompts, tool inputs, command output, pre-edit file contents. `LIKE` is
case-insensitive. For fuzzy recall use the MCP `search` tool (BM25) or `MEANING()`.

**Sorting rule.** Never add `ORDER BY` to a query whose only filter is a single `LIKE` —
it returns a fraction of the matching rows, sometimes none, with no error. Sort
client-side, or add a second predicate. `ORDER BY` is safe with equality filters,
`IS NOT NULL`, `GROUP BY`, and with two or more `LIKE` terms. When a result set matters,
confirm it against `SELECT COUNT(*)` with the same `WHERE`.

Inline binaries are uploaded as InventDB attachments on the row that carried them, named
`<session>-<seq>-<n>.<ext>`. List them with `GET /attach/<ns>/session_line/<record _id>`
or the MCP `attach_list` tool.

**Counting rule.** To check completeness use `SELECT COUNT(*) … WHERE …`, one query per
file. Do not count DISTINCT values client-side from a fetched row set — `/sql` caps the
rows it returns, so any total derived that way is unreliable.

## 5. Behaviour worth knowing

| | |
|---|---|
| **Namespaces** | Use underscores. A hyphen forces quoting in every statement. |
| **Watermarks** | Scoped per target (`state/<base>__<namespace>/`). Repointing at a different instance starts that target from scratch. |
| **State keys** | Session id for top-level transcripts; relative path for nested ones, since many workflow directories contain files of the same name. |
| **Attachments** | Uploaded after rows commit, so a failed upload is logged rather than replayed — replaying would duplicate rows. `raw` still holds the bytes. |
| **Chunking** | Lines above `maxRawBytes` split across rows on UTF-8 boundaries; reassemble by `chunk_idx`. A row count can legitimately exceed a file's line count. |
| **Failure policy** | The shipper exits 0 on every path, including bad config, so it can never break a session. Errors go to `state/sync.log`. |
| **Endpoints** | Type delete is `DELETE /api/:ns/:type`; namespace delete is `DELETE /api/namespaces/:ns`. |

## 6. Schema

`<ns>.session_line` — one row per transcript line:

| Column | Meaning |
|---|---|
| `session_id`, `seq` | Session id; monotonic line index |
| `ts`, `kind`, `role`, `model` | Timestamp; line type; message role; model id |
| `title` | Claude Code's derived session name. Sessions are retitled as they develop, so take the highest `seq`. |
| `last_prompt` | Text of the session's last-prompt line |
| `cwd`, `git_branch`, `cc_version` | Where and on what the work happened |
| `source_file`, `agent_id`, `parent_session` | Provenance. Subagent and workflow transcripts embed their parent's session id, so the path is what distinguishes them. |
| `attachments` | Count of inline binaries on that line |
| `uuid`, `parent_uuid`, `request_id`, `is_sidechain`, `bytes`, `chunk_idx`, `chunk_n` | Identity, threading, size, chunking |
| `raw` | The original line, byte-exact |

`<ns>.session_event` — one row per lifecycle event: `session_id`, `event`, `ts`, `cwd`,
`transcript_path`, `permission_mode`, `source`, `reason`, `host`.

## 7. `doctor`

Check in order and stop at the first failure:

1. `--status` — is it pointed at the instance the user expects? A repointed or stopped
   target is the most common cause of "capture stopped".
2. `--ping` — auth or URL wrong? `ECONNREFUSED` means the instance is not running.
3. `~/.claude/inventdb-sync/state/sync.log` — the shipper logs errors here and never
   prints into a session.
4. Are watermarks advancing? Compare `--status` against the live transcript size.
5. Stale `.lock` files in `state/`, left by a killed process. They clear after 5 minutes.
6. Are the hooks registered? Check `settings.json` or that the plugin is enabled. Ask
   the user to open `/hooks` to review — you cannot open it for them.
7. If TLS connects but nothing responds, the instance is busy indexing. Wait.

## 8. `uninstall`

Remove the five hook entries or disable the plugin, and confirm. Leave the data and
config in place unless the user explicitly asks otherwise — deleting a namespace is
irreversible.
