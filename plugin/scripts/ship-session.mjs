#!/usr/bin/env node
/**
 * ship-session.mjs — mirror Claude Code session transcripts into InventDB.
 *
 * Invoked as a Claude Code hook (reads the hook JSON on stdin), or by hand:
 *
 *   node ship-session.mjs --ping                 connectivity + auth check
 *   node ship-session.mjs --file <path.jsonl>    backfill one transcript
 *   node ship-session.mjs --all                  backfill every transcript
 *   node ship-session.mjs --status               per-session watermarks
 *
 * InventDB API contract:
 *   POST /api/auth/login              -> { ok, token }        JWT, ~8h
 *   POST /api/{ns}/{type}/bulk        -> { ok, insertedCount, ids, error }
 *        body = bare array | { documents: [...] }; ns+type created lazily
 *
 * Invariant: this NEVER fails the hook. Every path exits 0. If InventDB is
 * unreachable the byte watermark is not advanced, so the next hook retries
 * from exactly where this one stopped — no gaps, no duplicates.
 */

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))

// Config and state live in USER space, never beside the script: when this ships
// inside a plugin, the plugin directory is versioned and replaced on update,
// which would destroy watermarks and leak credentials into a distributed tree.
const USER_DIR = path.join(os.homedir(), '.claude', 'inventdb-sync')
const STATE_ROOT = path.join(USER_DIR, 'state')
const LOG = path.join(STATE_ROOT, 'sync.log')

// Watermarks are per TARGET. If one set were shared across instances, repointing at a
// different base or namespace would make every transcript look already-synced, so the
// new target would receive nothing and report no error.
let STATE_DIR = STATE_ROOT

function targetKey(cfg) {
  return `${cfg.base}__${cfg.namespace}`.replace(/[^\w.-]/g, '_').slice(0, 120)
}

/** Point STATE_DIR at this target's own subdirectory. */
function bindState(cfg) {
  STATE_DIR = path.join(STATE_ROOT, targetKey(cfg))
  fs.mkdirSync(STATE_DIR, { recursive: true })
}

/**
 * Resolve the config file: $INVENTDB_SYNC_CONFIG, else the user dir, else beside the
 * script (dev only).
 *
 * An explicit env path is authoritative EVEN IF IT DOES NOT EXIST YET. Falling through
 * to "first file that exists" makes `--set` write to a different file than the caller
 * named, which would overwrite an existing config unexpectedly.
 */
function configPath() {
  if (process.env.INVENTDB_SYNC_CONFIG) return process.env.INVENTDB_SYNC_CONFIG
  const user = path.join(USER_DIR, 'config.json')
  if (fs.existsSync(user)) return user
  const local = path.join(HERE, 'config.json')
  return fs.existsSync(local) ? local : user
}

/* ── config CLI ─────────────────────────────────────────────────────── */

function readRawConfig() {
  try {
    return JSON.parse(fs.readFileSync(configPath(), 'utf8'))
  } catch {
    return {}
  }
}

function writeRawConfig(c) {
  const p = configPath()
  fs.mkdirSync(path.dirname(p), { recursive: true })
  // 0600: the file holds a password. chmod is a no-op on Windows, hence the try.
  fs.writeFileSync(p, `${JSON.stringify(c, null, 2)}\n`, { mode: 0o600 })
  try {
    fs.chmodSync(p, 0o600)
  } catch {
    /* not POSIX */
  }
  return p
}

/** Value following `--name`, or null when absent/another flag follows. */
function flagValue(argv, name) {
  const i = argv.indexOf(name)
  if (i === -1) return null
  const v = argv[i + 1]
  return v === undefined || v.startsWith('--') ? '' : v
}

function redactConfig(c) {
  const out = { ...c }
  if (out.password) out.password = `${'*'.repeat(6)}(${String(out.password).length} chars)`
  if (out.token) out.token = `${String(out.token).slice(0, 8)}...`
  return out
}

/* ── config ─────────────────────────────────────────────────────────── */

function loadConfig() {
  let c = {}
  const cp = configPath()
  try {
    c = JSON.parse(fs.readFileSync(cp, 'utf8'))
  } catch (e) {
    throw new Error(`cannot read ${cp}: ${e.message}`)
  }
  const env = process.env
  const cfg = {
    base: (env.INVENTDB_SYNC_BASE || c.base || '').replace(/\/+$/, ''),
    namespace: env.INVENTDB_SYNC_NAMESPACE || c.namespace,
    lineType: c.lineType || 'session_line',
    eventType: c.eventType || 'session_event',
    username: env.INVENTDB_SYNC_USER || c.username,
    password: env.INVENTDB_SYNC_PASSWORD || c.password,
    token: env.INVENTDB_SYNC_TOKEN || c.token || '',
    // Tuned for large transcripts over a remote connection. Bigger batches or a
    // shorter timeout both fail once a single transcript reaches tens of MB.
    batchRows: c.batchRows || 100,
    batchBytes: c.batchBytes || 1_500_000,
    maxRawBytes: c.maxRawBytes || 200_000,
    readWindowBytes: c.readWindowBytes || 8_000_000,
    maxLineBytes: c.maxLineBytes || 67_108_864,
    hookBudgetMs: c.hookBudgetMs || 20_000,
    requestTimeoutMs: c.requestTimeoutMs || 180_000,
    // Pasted screenshots and other inline base64 payloads are uploaded as real
    // InventDB attachments on the row that carried them.
    uploadAttachments: c.uploadAttachments !== false,
    maxAttachmentBytes: c.maxAttachmentBytes || 25_000_000,
    debug: !!c.debug,
  }
  if (!cfg.base) throw new Error('config.base is empty')
  if (!cfg.namespace) throw new Error('config.namespace is empty')
  if (!cfg.token && !cfg.password) throw new Error('config needs password or token')
  return cfg
}

function log(msg) {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true })
    fs.appendFileSync(LOG, `${new Date().toISOString()} ${msg}\n`)
    // Keep the log from growing without bound.
    if (fs.statSync(LOG).size > 2_000_000) {
      const tail = fs.readFileSync(LOG, 'utf8').slice(-500_000)
      fs.writeFileSync(LOG, tail)
    }
  } catch {
    /* logging must never throw */
  }
}

/* ── auth ───────────────────────────────────────────────────────────── */

const tokenCache = () => path.join(STATE_DIR, 'token.json')

function jwtExp(tok) {
  try {
    const p = JSON.parse(Buffer.from(tok.split('.')[1], 'base64url').toString('utf8'))
    return typeof p.exp === 'number' ? p.exp : 0
  } catch {
    return 0
  }
}

async function login(cfg) {
  const r = await fetch(`${cfg.base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: cfg.username, password: cfg.password }),
    signal: AbortSignal.timeout(cfg.requestTimeoutMs),
  })
  const body = await r.text()
  if (!r.ok) throw new Error(`login HTTP ${r.status}: ${body.slice(0, 200)}`)
  const tok = JSON.parse(body).token
  if (!tok) throw new Error('login returned no token')
  fs.mkdirSync(STATE_DIR, { recursive: true })
  fs.writeFileSync(tokenCache(), JSON.stringify({ token: tok, exp: jwtExp(tok) }))
  return tok
}

async function getToken(cfg, force = false) {
  if (cfg.token) return cfg.token // statically configured, never refreshed
  if (!force) {
    try {
      const c = JSON.parse(fs.readFileSync(tokenCache(), 'utf8'))
      // 120s skew so a token never expires mid-batch.
      if (c.token && c.exp - 120 > Math.floor(Date.now() / 1000)) return c.token
    } catch {
      /* fall through to login */
    }
  }
  return login(cfg)
}

/* ── write path ─────────────────────────────────────────────────────── */

async function postBulk(cfg, type, rows) {
  // No ?disableIndexing — InventDB always maintains indexes on write (that is what
  // backs its consistency promise), so the param is inert. Writes pay full index cost.
  const url = `${cfg.base}/api/${encodeURIComponent(cfg.namespace)}/${encodeURIComponent(type)}/bulk`
  const body = JSON.stringify(rows)

  let reauthed = false
  let last = ''
  // 5xx is retried with backoff: sustained write load can produce transient
  // server errors that succeed on a later attempt.
  for (let attempt = 0; attempt < 5; attempt++) {
    if (attempt) await new Promise((r) => setTimeout(r, 500 * 2 ** (attempt - 1)))
    let r
    try {
      const token = await getToken(cfg, reauthed)
      r = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body,
        signal: AbortSignal.timeout(cfg.requestTimeoutMs),
      })
    } catch (e) {
      last = `network: ${e.message}` // timeout / connection reset -> retry
      continue
    }
    if (r.status === 401 && !reauthed) {
      reauthed = true // stale token -> re-login once, then retry
      continue
    }
    const text = await r.text()
    if (r.status >= 500) {
      last = `HTTP ${r.status}: ${text.slice(0, 200)}`
      continue
    }
    if (!r.ok) throw new Error(`bulk HTTP ${r.status}: ${text.slice(0, 300)}`)
    if (attempt) log(`recovered after ${attempt} retr${attempt > 1 ? 'ies' : 'y'} (${last})`)
    const j = JSON.parse(text)
    if (j.error) log(`partial insert into ${type}: ${String(j.error).slice(0, 300)}`)
    return { count: j.insertedCount ?? rows.length, ids: Array.isArray(j.ids) ? j.ids : [] }
  }
  throw new Error(`bulk failed after retries: ${last}`)
}

/* ── attachments ────────────────────────────────────────────────────── */

/**
 * Every inline base64 payload anywhere in a transcript line — pasted screenshots,
 * images returned inside tool results, nested content blocks. Walks the whole object
 * because the shape differs by producer and nesting depth is not fixed.
 */
function inlineBinaries(node, out = [], depth = 0) {
  if (!node || depth > 8) return out
  if (Array.isArray(node)) {
    for (const v of node) inlineBinaries(v, out, depth + 1)
    return out
  }
  if (typeof node !== 'object') return out
  const src = node.source
  if (src && src.type === 'base64' && typeof src.data === 'string' && src.data.length) {
    out.push({ media: src.media_type || 'application/octet-stream', data: src.data })
    return out // do not descend into the payload itself
  }
  for (const v of Object.values(node)) inlineBinaries(v, out, depth + 1)
  return out
}

const EXT = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'application/pdf': 'pdf',
}

/**
 * Upload one inline payload as a real InventDB attachment on the row that carried it.
 *
 * Best-effort by design: the row is already committed by the time this runs, so a
 * failure here must never fail the batch — retrying the batch would duplicate rows.
 * Misses are logged instead.
 */
async function uploadAttachment(cfg, recordId, att, label) {
  const buf = Buffer.from(att.data, 'base64')
  if (buf.length > cfg.maxAttachmentBytes) {
    log(`attachment ${label} skipped: ${buf.length} bytes over maxAttachmentBytes`)
    return false
  }
  const name = `${label}.${EXT[att.media] || 'bin'}`
  const fd = new FormData()
  fd.append('file', new Blob([buf], { type: att.media }), name)

  const url = `${cfg.base}/attach/${encodeURIComponent(cfg.namespace)}/${encodeURIComponent(cfg.lineType)}/${encodeURIComponent(recordId)}`
  try {
    const token = await getToken(cfg)
    // No content-type header: fetch must set the multipart boundary itself.
    const r = await fetch(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
      body: fd,
      signal: AbortSignal.timeout(cfg.requestTimeoutMs),
    })
    if (!r.ok) {
      log(`attachment ${label} upload HTTP ${r.status}: ${(await r.text()).slice(0, 160)}`)
      return false
    }
    return true
  } catch (e) {
    log(`attachment ${label} upload failed: ${e.message}`)
    return false
  }
}

/* ── transcript parsing ─────────────────────────────────────────────── */

/**
 * Split a line into <=maxBytes pieces without ever cutting a UTF-8 code point.
 * Continuation bytes are 10xxxxxx, so walk back off any we land on.
 */
function splitRaw(line, maxBytes) {
  const buf = Buffer.from(line, 'utf8')
  if (buf.length <= maxBytes) return [line]
  const out = []
  let off = 0
  while (off < buf.length) {
    let end = Math.min(off + maxBytes, buf.length)
    if (end < buf.length) while (end > off && (buf[end] & 0xc0) === 0x80) end--
    if (end === off) end = Math.min(off + maxBytes, buf.length) // pathological guard
    out.push(buf.subarray(off, end).toString('utf8'))
    off = end
  }
  return out
}

/** One transcript line -> one or more InventDB rows (chunked if oversized). */
function rowsForLine(cfg, sessionId, line, seq, origin = {}) {
  let j = null
  try {
    j = JSON.parse(line)
  } catch {
    /* keep unparseable lines verbatim rather than dropping them */
  }
  const m = j?.message ?? {}
  const base = {
    session_id: j?.sessionId || sessionId,
    // Provenance: subagent/workflow transcripts live under <session>/subagents/
    // and share their parent's sessionId, so these are what tell them apart.
    source_file: origin.source_file ?? null,
    agent_id: origin.agent_id ?? null,
    parent_session: origin.parent_session ?? null,
    seq,
    ts: j?.timestamp ?? null,
    kind: j?.type ?? 'unparsed',
    uuid: j?.uuid ?? null,
    parent_uuid: j?.parentUuid ?? null,
    role: m.role ?? null,
    model: m.model ?? null,
    // Claude Code's own derived session name, emitted on a `ai-title` line, and the
    // `last-prompt` line's text. Promoted to columns so sessions are identifiable by
    // name instead of a UUID — see the session-index query in the docs.
    title: j?.aiTitle ?? null,
    last_prompt: j?.lastPrompt ?? null,
    cwd: j?.cwd ?? null,
    git_branch: j?.gitBranch ?? null,
    cc_version: j?.version ?? null,
    is_sidechain: !!j?.isSidechain,
    request_id: j?.requestId ?? null,
    bytes: Buffer.byteLength(line, 'utf8'),
  }
  // `raw` still holds the payload byte-exact — attachments are additional, never a
  // replacement, so the archive can always reconstruct the original line.
  const images = cfg.uploadAttachments ? inlineBinaries(j) : []
  base.attachments = images.length

  const parts = splitRaw(line, cfg.maxRawBytes)
  return {
    rows: parts.map((raw, i) => ({ ...base, chunk_idx: i, chunk_n: parts.length, raw })),
    images,
  }
}

/* ── watermarks ─────────────────────────────────────────────────────── */

const statePath = (id) => path.join(STATE_DIR, `${String(id).replace(/[^\w.-]/g, '_')}.json`)

function loadState(id) {
  try {
    return JSON.parse(fs.readFileSync(statePath(id), 'utf8'))
  } catch {
    return { offset: 0, seq: 0 }
  }
}

function saveState(id, st) {
  fs.mkdirSync(STATE_DIR, { recursive: true })
  const tmp = `${statePath(id)}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(st))
  fs.renameSync(tmp, statePath(id)) // atomic; a crash never leaves a half state
}

function readAt(file, offset, len) {
  const fd = fs.openSync(file, 'r')
  try {
    const buf = Buffer.allocUnsafe(len)
    const n = fs.readSync(fd, buf, 0, len, offset)
    return buf.subarray(0, n)
  } finally {
    fs.closeSync(fd)
  }
}

/* ── the sync loop ──────────────────────────────────────────────────── */

// stateKey defaults to sessionId (hook mode); backfill passes a path-derived key for
// nested files so same-named transcripts never share a watermark.
async function syncTranscript(cfg, sessionId, tpath, budgetMs, origin = {}, stateKey = sessionId) {
  const st = loadState(stateKey)
  const started = Date.now()
  let shipped = 0

  for (;;) {
    let stat
    try {
      stat = fs.statSync(tpath)
    } catch {
      return shipped // transcript not written yet
    }

    // File shrank -> rotated or rewritten. Start over rather than mis-slice it.
    if (stat.size < st.offset) {
      log(`transcript shrank (${stat.size} < ${st.offset}), restarting ${stateKey}`)
      st.offset = 0
      st.seq = 0
    }
    if (stat.size === st.offset) break

    const want = Math.min(cfg.readWindowBytes, stat.size - st.offset)
    let buf = readAt(tpath, st.offset, want)
    let nl = buf.lastIndexOf(0x0a)

    if (nl === -1) {
      // A single line longer than the read window: widen for it.
      const grow = Math.min(cfg.maxLineBytes, stat.size - st.offset)
      if (grow > buf.length) {
        buf = readAt(tpath, st.offset, grow)
        nl = buf.lastIndexOf(0x0a)
      }
      // Still no newline -> the line is mid-write. Leave it for next time.
      if (nl === -1) break
    }

    const consumable = buf.subarray(0, nl + 1)
    const lines = consumable.toString('utf8').split('\n')
    if (lines[lines.length - 1] === '') lines.pop()

    // Ship in batches; advance the watermark only by what actually landed, so
    // a mid-window failure resumes exactly at the first unshipped line.
    let pending = []
    let pendingAtt = [] // { row: index into pending, images, label }
    let pendingRowBytes = 0
    let pendingSrcBytes = 0

    const flush = async () => {
      if (!pending.length) return
      const res = await postBulk(cfg, cfg.lineType, pending)
      shipped += res.count
      // Watermark first: the rows are durable now. Attachment upload is best-effort
      // and must not be able to force a replay that would duplicate them.
      st.offset += pendingSrcBytes
      saveState(stateKey, st)

      for (const a of pendingAtt) {
        const id = res.ids[a.row]
        if (!id) {
          log(`no record id for ${a.label}; ${a.images.length} attachment(s) not uploaded`)
          continue
        }
        for (let i = 0; i < a.images.length; i++) {
          await uploadAttachment(cfg, id, a.images[i], `${a.label}-${i}`)
        }
      }

      pending = []
      pendingAtt = []
      pendingRowBytes = 0
      pendingSrcBytes = 0
    }

    for (const line of lines) {
      const srcBytes = Buffer.byteLength(line, 'utf8') + 1 // + the \n we consumed
      if (!line.trim()) {
        // Blank line: nothing to ship, but its bytes must still be accounted.
        pendingSrcBytes += srcBytes
        continue
      }
      const { rows, images } = rowsForLine(cfg, sessionId, line, st.seq, origin)
      const rowBytes = Buffer.byteLength(line, 'utf8') + 400 * rows.length

      const wouldOverflow =
        pending.length &&
        (pending.length + rows.length > cfg.batchRows || pendingRowBytes + rowBytes > cfg.batchBytes)
      if (wouldOverflow) await flush()

      // Attach to the FIRST chunk only, so a split line does not upload N copies.
      if (images.length) {
        pendingAtt.push({ row: pending.length, images, label: `${sessionId}-${st.seq}` })
      }
      st.seq += 1
      pending.push(...rows)
      pendingRowBytes += rowBytes
      pendingSrcBytes += srcBytes
    }
    await flush()

    if (Date.now() - started > budgetMs) {
      log(`budget hit for ${sessionId}; ${stat.size - st.offset} bytes still pending`)
      break
    }
  }
  return shipped
}

/* ── lifecycle rows ─────────────────────────────────────────────────── */

async function shipEvent(cfg, hook) {
  const row = {
    session_id: hook.session_id ?? null,
    event: hook.hook_event_name ?? null,
    ts: new Date().toISOString(),
    cwd: hook.cwd ?? null,
    transcript_path: hook.transcript_path ?? null,
    permission_mode: hook.permission_mode ?? null,
    source: hook.source ?? null,
    reason: hook.reason ?? null,
    host: os.hostname(),
  }
  await postBulk(cfg, cfg.eventType, [row])
}

/* ── entry points ───────────────────────────────────────────────────── */

function readStdin() {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve('')
    const chunks = []
    process.stdin.on('data', (c) => chunks.push(c))
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    process.stdin.on('error', () => resolve(''))
    setTimeout(() => resolve(Buffer.concat(chunks).toString('utf8')), 5000).unref()
  })
}

/** Best-effort transcript path when the hook payload omits it. */
function guessTranscript(sessionId, cwd) {
  const slug = String(cwd || process.cwd()).replace(/[/\\:]/g, '-')
  const dir = path.join(os.homedir(), '.claude', 'projects')
  for (const cand of [slug, slug.toLowerCase()]) {
    const p = path.join(dir, cand, `${sessionId}.jsonl`)
    if (fs.existsSync(p)) return p
  }
  try {
    for (const d of fs.readdirSync(dir)) {
      const p = path.join(dir, d, `${sessionId}.jsonl`)
      if (fs.existsSync(p)) return p
    }
  } catch {
    /* no projects dir */
  }
  return null
}

/** Serialize overlapping async hooks; a stale lock is stolen after 5 min. */
function acquireLock(id) {
  fs.mkdirSync(STATE_DIR, { recursive: true })
  const lock = path.join(STATE_DIR, `${String(id).replace(/[^\w.-]/g, '_')}.lock`)
  try {
    fs.writeFileSync(lock, String(process.pid), { flag: 'wx' })
    return lock
  } catch {
    try {
      if (Date.now() - fs.statSync(lock).mtimeMs > 300_000) {
        fs.writeFileSync(lock, String(process.pid))
        return lock
      }
    } catch {
      /* vanished between calls; treat as held */
    }
    return null // another run is live and will pick up our lines too
  }
}

async function main() {
  const argv = process.argv.slice(2)

  // --set / --show-config run BEFORE loadConfig(), which throws when the target is
  // not yet configured. They are how you configure it in the first place.
  if (argv.includes('--set')) {
    const c = readRawConfig()
    const url = flagValue(argv, '--url')
    const ns = flagValue(argv, '--namespace')
    const user = flagValue(argv, '--user')
    const pass = flagValue(argv, '--password')
    const tok = flagValue(argv, '--token')

    if (url) c.base = url.replace(/\/+$/, '')
    if (ns) c.namespace = ns
    if (user) c.username = user
    if (pass !== null) c.password = pass
    if (tok !== null) c.token = tok
    c.namespace = c.namespace || 'inventdb_claude'
    c.lineType = c.lineType || 'session_line'
    c.eventType = c.eventType || 'session_event'

    if (/[^\w]/.test(c.namespace)) {
      process.stdout.write(
        `WARNING: namespace "${c.namespace}" is not a bare word — every SQL statement will\n` +
          '         have to quote it. Prefer underscores, e.g. inventdb_claude.\n',
      )
    }
    process.stdout.write(`wrote ${writeRawConfig(c)}\n`)

    // Configuring without verifying just moves the failure to the first hook, where
    // nobody sees it: the shipper logs to a file and never prints into a session.
    try {
      const verified = loadConfig()
      bindState(verified)
      const t = await getToken(verified, true)
      process.stdout.write(
        `auth ok (token ${t.length} chars)\ntarget ${verified.base}/api/${verified.namespace}/${verified.lineType}/bulk\n`,
      )
    } catch (e) {
      process.stdout.write(`config saved, but VERIFICATION FAILED: ${e.message}\n`)
    }
    return
  }

  if (argv.includes('--show-config')) {
    process.stdout.write(`${configPath()}\n${JSON.stringify(redactConfig(readRawConfig()), null, 2)}\n`)
    return
  }

  const cfg = loadConfig()
  bindState(cfg)

  if (argv.includes('--ping')) {
    const t = await getToken(cfg, true)
    process.stdout.write(`auth ok, token ${t.length} chars, exp ${new Date(jwtExp(t) * 1000).toISOString()}\n`)
    process.stdout.write(`target ${cfg.base}/api/${cfg.namespace}/${cfg.lineType}/bulk\n`)
    return
  }

  if (argv.includes('--status')) {
    process.stdout.write(`target ${cfg.base} / ${cfg.namespace}\n`)
    const files = fs.existsSync(STATE_DIR) ? fs.readdirSync(STATE_DIR).filter((f) => f.endsWith('.json') && f !== 'token.json') : []
    for (const f of files) {
      const st = JSON.parse(fs.readFileSync(path.join(STATE_DIR, f), 'utf8'))
      process.stdout.write(`${f.replace(/\.json$/, '')}  offset=${st.offset}  lines=${st.seq}\n`)
    }
    if (!files.length) process.stdout.write('no sessions synced yet\n')
    return
  }

  const PROJECTS = path.join(os.homedir(), '.claude', 'projects')

  /** Every .jsonl under projects/, including nested subagent + workflow runs. */
  function walkTranscripts(dir, out = []) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) walkTranscripts(p, out)
      else if (e.name.endsWith('.jsonl')) out.push(p)
    }
    return out
  }

  /**
   * Subagent/workflow transcripts sit under <session>/subagents/... and carry
   * their PARENT's sessionId inside, so the file path is the only thing that
   * distinguishes them. Capture it as provenance.
   */
  function originFor(p) {
    const rel = path.relative(PROJECTS, p).split(path.sep).join('/')
    const parts = rel.split('/')
    const bn = path.basename(p, '.jsonl')
    return {
      source_file: rel,
      agent_id: bn.startsWith('agent-') ? bn : null,
      parent_session: parts.length > 2 ? parts[1] : null,
    }
  }

  /**
   * Watermark key. Top-level session transcripts key on the session id so a
   * backfill and a live hook share one watermark. Nested files must key on their
   * RELATIVE PATH: many workflow directories contain a file of the same name (e.g.
   * `journal.jsonl`), so keying on basename would make them share one offset — which
   * both skips files and slices a larger one mid-line at another file's offset.
   */
  function stateKeyFor(p) {
    const rel = path.relative(PROJECTS, p).split(path.sep).join('/')
    return rel.split('/').length === 2 ? path.basename(p, '.jsonl') : rel.replace(/\.jsonl$/, '')
  }

  /** Backfill one transcript under the same lock hook mode uses. */
  async function backfill(p) {
    const id = stateKeyFor(p)
    const lock = acquireLock(id)
    if (!lock) return { id, skipped: true }
    try {
      const n = await syncTranscript(
        cfg,
        path.basename(p, '.jsonl'), // row-level fallback identity
        p,
        Number.MAX_SAFE_INTEGER,
        originFor(p),
        id, // unique watermark key
      )
      return { id, rows: n }
    } finally {
      try {
        fs.unlinkSync(lock)
      } catch {
        /* already gone */
      }
    }
  }

  const fileIdx = argv.indexOf('--file')
  if (fileIdx !== -1) {
    const r = await backfill(argv[fileIdx + 1])
    process.stdout.write(`${r.id}: ${r.skipped ? 'SKIPPED (locked)' : `shipped ${r.rows} rows`}\n`)
    return
  }

  if (argv.includes('--all')) {
    const jsonls = walkTranscripts(PROJECTS)
    jsonls.sort((a, b) => fs.statSync(a).size - fs.statSync(b).size) // small first
    const total = jsonls.reduce((s, p) => s + fs.statSync(p).size, 0)
    process.stdout.write(`${jsonls.length} transcripts, ${(total / 1048576).toFixed(1)} MB\n`)

    let done = 0
    let rows = 0
    let failed = 0
    for (const p of jsonls) {
      const mb = (fs.statSync(p).size / 1048576).toFixed(1)
      try {
        const r = await backfill(p)
        rows += r.rows || 0
        done++
        process.stdout.write(
          `[${done}/${jsonls.length}] ${(r.rows ?? 0).toString().padStart(6)} rows  ${mb.padStart(7)} MB  ${path.basename(p)}${r.skipped ? ' (locked)' : ''}\n`,
        )
      } catch (e) {
        failed++
        done++
        process.stdout.write(`[${done}/${jsonls.length}] FAILED ${mb} MB ${path.basename(p)}: ${e.message}\n`)
      }
    }
    process.stdout.write(`\ndone: ${rows} rows from ${jsonls.length - failed}/${jsonls.length} transcripts\n`)
    return
  }

  // ── hook mode ──
  const raw = await readStdin()
  if (!raw.trim()) return
  const hook = JSON.parse(raw)
  const sessionId = hook.session_id
  if (!sessionId) return

  const lock = acquireLock(sessionId)
  if (!lock) return
  try {
    const ev = hook.hook_event_name
    if (ev === 'SessionStart' || ev === 'SessionEnd') {
      try {
        await shipEvent(cfg, hook)
      } catch (e) {
        log(`event ship failed (${ev}): ${e.message}`)
      }
    }
    const tpath = hook.transcript_path || guessTranscript(sessionId, hook.cwd)
    if (!tpath) return log(`no transcript for ${sessionId}`)
    // Same provenance as backfill, so live and imported rows are indistinguishable.
    const n = await syncTranscript(cfg, sessionId, tpath, cfg.hookBudgetMs, originFor(tpath))
    if (cfg.debug && n) log(`${ev}: ${sessionId} shipped ${n} rows`)
  } finally {
    try {
      fs.unlinkSync(lock)
    } catch {
      /* already gone */
    }
  }
}

main()
  .catch((e) => log(`ERROR ${e && e.stack ? e.stack.split('\n')[0] : e}`))
  .finally(() => {
    // A transcript mirror must never take the session down with it. Calling
    // process.exit() here would abort the runtime while upload sockets are still
    // closing, so set the code and let the loop drain. The unref'd timer is the
    // escape hatch if a socket refuses to close; it cannot hold the process open.
    process.exitCode = 0
    setTimeout(() => process.exit(0), 5000).unref()
  })
