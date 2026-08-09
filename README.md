# inventdb-sessions

Mirror Claude Code sessions into **InventDB** as a queryable execution record, and search
them back through the InventDB MCP server.

Built by [InventDB](https://inventdb.com) ·
[Repository](https://github.com/inventdb/inventdb-claude-code-sessions) ·
[API reference](https://www.inventdb.com/api.html)

A session log is not a transcript — it is an **execution record**: every command with its
output, every file's pre-edit state, every approach that was tried and abandoned. It is
the only engineering artifact that includes the work which *failed*, and Claude Code
removes it on a retention timer (30 days by default, `cleanupPeriodDays`).

---

## Contents

- [What it does](#what-it-does)
- [How it works](#how-it-works)
- [What gets captured](#what-gets-captured)
- [Installation](#installation)
- [Configuration](#configuration)
- [CLI](#cli)
- [Querying the archive](#querying-the-archive)
- [Operations](#operations)
- [Troubleshooting](#troubleshooting)
- [Security](#security)

---

## What it does

| | |
|---|---|
| **Captures** | Every transcript line, byte-exact, into `<ns>.session_line`; lifecycle events into `<ns>.session_event`; Claude Code's derived session name; and inline binaries as real InventDB **attachments** |
| **Queries** | Through the InventDB MCP server (`sql`, `search`, `get`, `schema`) — so Claude can search every past session mid-conversation |
| **Does not** | Replace local storage. `--resume`, `/rewind` and compaction read the local `.jsonl` files, and this plugin reads them as its source. InventDB is the archive, not the store. |

### Two boundaries worth knowing before you roll it out

**Capture works on Claude Code only.** Hooks are a Claude Code feature, and Claude Code is
the only surface that writes local session transcripts.

| Surface | Local transcripts | Hooks | MCP | Result |
|---|---|---|---|---|
| **Claude Code** | yes | yes | yes | **Capture + query** |
| Claude Desktop | no | no | yes | Query only |
| Claude web / Work / Teams | no | no | yes | Query only |

**It mirrors; it does not redirect.** There is no hook event for listing or loading a
session, so Claude Code's own session storage cannot be pointed elsewhere. Never lower
`cleanupPeriodDays` or delete transcripts as part of an install.

## How it works

Two halves, deliberately on different transports.

| Path | Mechanism | Why |
|---|---|---|
| **Write** | 5 async hooks → `ship-session.mjs` → REST `bulk` | Fidelity requires tailing the local `.jsonl`, which only a local process can do. A remote MCP tool cannot read the user's disk. |
| **Read** | InventDB MCP server | Lets Claude query every past session mid-conversation — the useful question is semantic or aggregate, not a list of session UUIDs. |

The shipper tails each transcript from a persisted **byte watermark** and bulk-inserts new
lines. The watermark advances only after a successful write, so an interrupted or failed
run resumes at the exact byte — no gaps, no duplicates. Re-running a fully-synced
transcript inserts 0 rows.

```
inventdb-claude-code-sessions/
├── .claude-plugin/marketplace.json     marketplace manifest
├── plugin/
│   ├── .claude-plugin/plugin.json      plugin manifest
│   ├── .mcp.json                       InventDB MCP server (read path)
│   ├── hooks/hooks.json                5 async capture hooks (write path)
│   ├── scripts/ship-session.mjs        the shipper
│   └── skills/inventdb-sessions/       /inventdb-sessions skill
└── docs/inventdb-sessions-guide.html   the same guide, as a page
```

Config and state live in `~/.claude/inventdb-sync/`, never inside the plugin — the plugin
directory is versioned and replaced on update.

## What gets captured

### `<ns>.session_line` — one row per transcript line

| Column | Meaning |
|---|---|
| `session_id`, `seq` | Session id; monotonic line index |
| `ts`, `kind`, `role`, `model` | Timestamp; line type; message role; model id |
| `title` | Claude Code's derived session name. Sessions are retitled as they develop, so the highest `seq` is the current name. |
| `last_prompt` | Text of the session's last-prompt line |
| `cwd`, `git_branch`, `cc_version` | Where and on what the work happened |
| `source_file`, `agent_id`, `parent_session` | Provenance. Subagent and workflow transcripts embed their *parent's* session id, so the path is what distinguishes them. |
| `attachments` | Count of inline binaries on that line |
| `uuid`, `parent_uuid`, `request_id`, `is_sidechain`, `bytes`, `chunk_idx`, `chunk_n` | Identity, threading, size, chunking |
| `raw` | The original line, **byte-exact** |

### Attachments

Inline base64 payloads — pasted screenshots, images returned inside tool results — are
uploaded as real InventDB attachments on the row that carried them, named
`<session>-<seq>-<n>.<ext>`, and enter the normal extraction and embedding pipeline.
`raw` still holds the original bytes: the attachment is *additional*, never a
replacement, so the archive can always reconstruct the original line.

```
GET /attach/<ns>/session_line/<record _id>      # or the MCP attach_list tool
```

### `<ns>.session_event` — one row per lifecycle event

`session_id`, `event`, `ts`, `cwd`, `transcript_path`, `permission_mode`, `source`,
`reason`, `host`.

## Installation

**Requirements:** Claude Code; `node` on PATH (v18+, for global `fetch`); a reachable
InventDB instance and credentials. The endpoints used here are documented in the
[InventDB API reference](https://www.inventdb.com/api.html).

### A · Marketplace (recommended)

```
/plugin marketplace add inventdb/inventdb-claude-code-sessions
/plugin install inventdb-sessions@inventdb
/inventdb-sessions setup https://acme.inventdb.com
```

To pre-register it for everyone working in a repo, commit to `.claude/settings.json`:

```json
{
  "extraKnownMarketplaces": {
    "inventdb": {
      "source": { "source": "github", "repo": "inventdb/inventdb-claude-code-sessions" }
    }
  },
  "enabledPlugins": { "inventdb-sessions@inventdb": true }
}
```

### B · Local directory (air-gapped or offline)

```
git clone https://github.com/inventdb/inventdb-claude-code-sessions
claude --plugin-dir inventdb-claude-code-sessions/plugin
```

or register the clone as a marketplace:

```
/plugin marketplace add <path-to-clone>
/plugin install inventdb-sessions@inventdb
```

### C · Skill only, no plugin

The skill installs the hooks into `settings.json` itself.

```bash
cp -r plugin/skills/inventdb-sessions ~/.claude/skills/
mkdir -p ~/.claude/inventdb-sync
cp plugin/scripts/ship-session.mjs ~/.claude/inventdb-sync/
```

Then run `/inventdb-sessions setup <url>`. Use `~/.claude/skills/` for personal scope, or
`.claude/skills/` inside a repo to commit it for a team.

### D · Enterprise rollout

Deploy through managed settings (`managed-settings.json`, MDM, or the `ClaudeCode`
registry key), and allowlist the MCP server with `allowedMcpServers`.

> **Use the plugin route in enterprise.** `strictPluginOnlyCustomization` blocks hooks
> from every non-plugin source, and `allowManagedHooksOnly` ignores user and project
> hooks entirely. Under either flag a settings-based install **silently does nothing** —
> no error, no capture — while a plugin install still works.

## Configuration

Set the target with the CLI rather than hand-editing JSON. It merges into
`~/.claude/inventdb-sync/config.json` at mode 0600, warns if the namespace is not a bare
word, and **verifies by logging in** before reporting success.

```
node plugin/scripts/ship-session.mjs --set \
  --url https://acme.inventdb.com \
  --namespace inventdb_claude \
  --user <user> --password <pass>

node plugin/scripts/ship-session.mjs --show-config   # secrets redacted
```

`--token <jwt>` works instead of a password. Every field is overridable by environment
variable — prefer these when a password on disk is unacceptable:

`INVENTDB_SYNC_BASE`, `INVENTDB_SYNC_NAMESPACE`, `INVENTDB_SYNC_USER`,
`INVENTDB_SYNC_PASSWORD`, `INVENTDB_SYNC_TOKEN`, `INVENTDB_SYNC_CONFIG`

`INVENTDB_SYNC_CONFIG` applies even when the file does not exist yet.

MCP: `INVENTDB_MCP_URL` (`<base>/mcp`) and `INVENTDB_MCP_TOKEN`.

Two rules that bite:

- **Namespaces must use underscores** (`inventdb_claude`, not `inventdb-claude`) — a
  hyphen forces every SQL statement to quote the namespace.
- **Prefer a bearer token for MCP over OAuth discovery.** If the instance sits behind a
  reverse proxy, discovery may advertise an address the client cannot reach.

**Watermarks are scoped per target** (`state/<base>__<namespace>/`). Repointing at a
different instance correctly starts that target from scratch — sharing one set across
instances would tell a new target that everything was already synced, so it would
silently receive nothing.

## CLI

| Command | Does |
|---|---|
| `--ping` | Auth and target check |
| `--status` | Configured target plus per-transcript watermarks |
| `--show-config` | Resolved config path, secrets redacted |
| `--set --url … --user … --password …` | Write config, then verify by logging in |
| `--file <p.jsonl>` | Backfill one transcript |
| `--all` | Backfill every transcript, smallest first, walking recursively |

## Querying the archive

```sql
-- Session index by name rather than UUID
SELECT session_id, title, ts FROM <ns>.session_line
WHERE title IS NOT NULL ORDER BY ts DESC;

-- Has anyone already debugged this error?
SELECT session_id, ts, git_branch, cwd FROM <ns>.session_line
WHERE raw LIKE '%<error text>%' ORDER BY ts;

-- What did this file look like before it was edited?
SELECT ts, session_id, raw FROM <ns>.session_line
WHERE raw LIKE '%<filename>%' AND raw LIKE '%old_string%' ORDER BY ts;

-- Sessions that captured screenshots or other binaries
SELECT session_id, seq, attachments FROM <ns>.session_line
WHERE attachments > 0 AND chunk_idx = 0;

-- Reconstruct a session in order
SELECT seq, kind, role, raw FROM <ns>.session_line
WHERE session_id = '<id>' ORDER BY seq;
```

`raw` holds the original line byte-exact, so `LIKE` over it searches everything — prompts,
tool inputs, command output, pre-edit file contents. For fuzzy recall use the MCP `search`
tool (BM25) or `MEANING()`.

**Counting rule.** To verify completeness use `SELECT COUNT(*) … WHERE …`, one query per
file. Do not count DISTINCT values client-side from a fetched row set — `/sql` caps the
rows it returns, so any total derived that way is unreliable.

## Operations

- **Capture never blocks a turn.** All five hooks are `async: true`, and the shipper exits
  0 on every path, so a mirror failure cannot break a session. Errors go to
  `~/.claude/inventdb-sync/state/sync.log`, never into the session.
- **Resumable and exactly-once.** A byte watermark advances only after a successful write.
  Re-running a synced transcript inserts 0 rows.
- **Backfill is heavy.** One developer's history is routinely over 1 GB across more than
  1,000 files. InventDB maintains indexes on write, so a bulk import does full property
  and vector indexing as it goes and can saturate a small instance until it catches up.
  Pace large loads and **wait rather than restart**. Steady-state capture is a few KB per
  turn.
- **Transient 5xx under sustained load is expected** and is retried with backoff. Re-send
  the same batch before suspecting the data.

## Troubleshooting

| Symptom | Check |
|---|---|
| Capture stopped | `--status` first — it prints the target actually configured. The most common cause is a config repointed at a different or stopped instance. |
| `ECONNREFUSED` | The configured instance is not running. Nothing is lost; watermarks do not advance on failure. |
| No errors visible | The shipper never prints into a session by design. Read `state/sync.log`. |
| Rows stopped advancing | Compare `--status` against the live transcript size, then look for stale `.lock` files in `state/` — they clear after 5 minutes. |
| Hooks never fire | Confirm the plugin is enabled, or that the five entries are in `settings.json`. Open `/hooks` to review; the UI only reports hooks that error or run slowly, so silent success is invisible by design. |
| TLS connects, nothing responds | The instance is busy indexing. Wait rather than restart. |

## License

[MIT](LICENSE) — use it, modify it, fork it, ship it commercially. Keep the copyright
notice and licence text in copies. Copyright (c) 2026 InventDB.

## Security

- **Session logs contain whatever was on screen** — command output, file contents, and any
  secrets that passed through a terminal. Treat the namespace as sensitive and scope it
  with row-level security; contractor and staff sessions can share one database under
  different access rules.
- **Credentials never enter this tree.** Config lives in
  `~/.claude/inventdb-sync/config.json` at mode 0600, and `config.json` is gitignored here.
  Prefer the environment variables where a password on disk is unacceptable.
- **Capture is explicit.** Nothing is captured until a target is configured, and
  `/inventdb-sessions uninstall` removes the hooks while leaving the data intact.
