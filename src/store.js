// File-based mailbox shared by every agent on this machine.
//
// Layout (under AGENT_BRIDGE_HOME, default ~/.agent-bridge):
//   messages/<id>.json          canonical copy of every message
//   mail/<name>/new/<id>.json   unread delivery for <name>
//   mail/<name>/cur/<id>.json   delivered (moved here atomically when read)
//   presence/<name>~<pid>.json  heartbeat of each running MCP server
//
// Everything is plain files written with tmp+rename, so several processes
// (MCP servers, hooks, the CLI) can share it without a daemon or a lock.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

export const KINDS = ["claude", "codex"];
const ONLINE_MS = 90_000;
const RETENTION_MS = 30 * 24 * 3600_000;

export function home() {
  return process.env.AGENT_BRIDGE_HOME || path.join(os.homedir(), ".agent-bridge");
}

const dir = (...p) => path.join(home(), ...p);

// Mailbox folders are named after agents, but Windows forbids ":" in file
// names, so it is stored as "~" (which never occurs in a sanitized name).
const toMailDir = (name) => String(name).replace(/:/g, "~");
const fromMailDir = (folder) => String(folder).replace(/~/g, ":");
const mailDir = (name, ...rest) => dir("mail", toMailDir(name), ...rest);

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
  return p;
}

function writeJsonAtomic(file, data) {
  ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(3).toString("hex")}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  for (let i = 0; ; i++) {
    try {
      fs.renameSync(tmp, file);
      return;
    } catch (e) {
      // Windows refuses to replace a file another process has open; retry briefly.
      if (i >= 20 || (e.code !== "EPERM" && e.code !== "EACCES" && e.code !== "EBUSY")) {
        try { fs.unlinkSync(tmp); } catch {}
        throw e;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function listJson(d) {
  try {
    return fs.readdirSync(d).filter((f) => f.endsWith(".json")).sort();
  } catch {
    return [];
  }
}

// Names look like "claude:agent-bridge@alitop": app, session title, machine.
// Older "codex@h90" (app@folder) names still resolve, as aliases.
// Letters and digits in any script are kept, so "Термопомпа оферти" or "über"
// stay distinct (they are also valid file names).
export function sanitizeName(name) {
  const clean = String(name || "")
    .normalize("NFC")
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}@:._-]+/gu, "-")
    .replace(/-*([@:])-*/g, "$1")
    .replace(/^-+|-+$/g, "");
  if (!clean) throw new Error("agent name is empty");
  return clean.slice(0, 100);
}

// One component of a name: no "@" or ":" (those separate the parts).
const part = (s) => sanitizeName(String(s || "").replace(/[@:]/g, " ") || "x").replace(/[@:]/g, "-");

export const machineName = () => part(os.hostname() || "machine");

export function canonicalName(kind, title, cwd = process.cwd()) {
  const label = String(title || "").trim() || path.basename(path.resolve(cwd)) || "session";
  return `${kind}:${part(label)}@${machineName()}`;
}

// The old folder-based name, kept as an alias.
export function defaultName(kind, cwd = process.cwd()) {
  const folder = path.basename(path.resolve(cwd)) || "root";
  const name = sanitizeName(`${kind}@${folder}`);
  // A folder name with nothing usable (only punctuation) must not yield "kind@".
  return name.endsWith("@") ? `${name}folder` : name;
}

export function kindOf(name) {
  const k = String(name).match(/^([a-z]+)[:@]/)?.[1];
  return KINDS.includes(k) ? k : null;
}

function newId() {
  // Time-ordered: base36 millis (fixed width until 2059) + random suffix.
  return `${Date.now().toString(36)}-${crypto.randomBytes(3).toString("hex")}`;
}

// ---------------------------------------------------------------- presence

// Each running MCP server says "a <kind> app is running here (in <cwd>)".
export function heartbeat(entry) {
  const now = new Date().toISOString();
  const file = dir("presence", `${entry.kind}~${entry.pid}.json`);
  const prev = readJson(file);
  writeJsonAtomic(file, { ...entry, startedAt: prev?.startedAt || now, lastSeen: now });
}

export function clearPresence(kind, pid) {
  try { fs.unlinkSync(dir("presence", `${kind}~${pid}.json`)); } catch {}
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
}

// Live MCP servers by kind (stale presence files are swept).
function liveServers() {
  const live = [];
  const now = Date.now();
  for (const f of listJson(dir("presence"))) {
    const p = readJson(dir("presence", f));
    if (!p) continue;
    const age = now - Date.parse(p.lastSeen);
    if (age < ONLINE_MS && (p.host !== os.hostname() || pidAlive(p.pid))) live.push(p);
    else if (age > ONLINE_MS * 10) try { fs.unlinkSync(dir("presence", f)); } catch {}
  }
  return live;
}

const samePath = (a, b) => !!a && !!b && path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

// One row per session. Online = its app is running (for Claude, a server in
// the session's folder; Codex runs one server for all threads) and the session
// was active in the last day. Mailboxes no session claims are listed offline.
export function listAgents({ includeOffline = true } = {}) {
  const live = liveServers();
  const now = Date.now();
  const rows = listSessions().map((s) => ({
    name: s.name,
    aliases: s.names.slice(1),
    kind: s.kind,
    title: s.title,
    cwd: s.cwd,
    sessionId: s.sessionId,
    idle: s.idle,
    lastSeen: s.at,
    online: now - Date.parse(s.at) < 24 * 3600_000 && live.some((p) => p.kind === s.kind && (s.kind === "codex" || samePath(p.cwd, s.cwd))),
    unread: s.names.reduce((n, name) => n + listJson(mailDir(name, "new")).length, 0),
  }));
  const claimed = new Set(rows.flatMap((r) => [r.name, ...r.aliases]));
  for (const name of safeReaddir(dir("mail")).map(fromMailDir)) {
    if (!claimed.has(name)) rows.push({ name, aliases: [], kind: kindOf(name), online: false, lastSeen: null, unread: listJson(mailDir(name, "new")).length });
  }
  return rows
    .filter((a) => includeOffline || a.online)
    .sort((a, b) => Number(b.online) - Number(a.online) || String(b.lastSeen).localeCompare(String(a.lastSeen)));
}

function safeReaddir(d) {
  try {
    return fs.readdirSync(d);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------- sessions
// One record per agent session (Claude session id / Codex thread id), in
// sessions/<sessionId>.json:
//   { sessionId, kind, name, names, title, cwd, transcript, host, idle, at, ... }
// `name` is the canonical "kind:title@machine". `names` starts with it and also
// holds aliases: earlier canonical names (a renamed session keeps receiving
// mail sent to its old name), the folder-based "kind@folder" name, and names
// given with `link --name` or set_name. A session reads mail sent to any of them.
// Hooks keep records current; Codex shares one MCP server across all its
// threads, so records are also how that server learns who is calling, and how
// wake.js finds the session to nudge.

const idFile = (sessionId) => dir("sessions", `${String(sessionId).replace(/[^A-Za-z0-9-]/g, "")}.json`);

// Records written by v0.2.x were keyed by name ("codex@h90.json", no `names`).
function normalize(rec, file) {
  if (!rec?.sessionId || !rec.kind) return null;
  // A session only answers to names of its own app (or app-less aliases).
  const ownApp = (n) => !kindOf(n) || kindOf(n) === rec.kind;
  const names = [...new Set([rec.name, ...(rec.names || [])].filter((n) => n && !n.endsWith("@") && !n.endsWith(":") && ownApp(n)))];
  return { ...rec, names, name: names[0], legacyFiles: rec.names ? [] : [file] };
}

export function listSessions(kind) {
  const byId = new Map();
  for (const f of listJson(dir("sessions"))) {
    const rec = normalize(readJson(dir("sessions", f)), f);
    if (!rec || (kind && rec.kind !== kind) || !rec.names.length) continue;
    const prev = byId.get(rec.sessionId);
    if (prev && prev.kind !== rec.kind) continue; // ids never span apps; ignore a stray
    // A legacy record and a current one for the same session: merge their names.
    if (prev) {
      const [newer, older] = prev.at >= rec.at ? [prev, rec] : [rec, prev];
      byId.set(rec.sessionId, { ...older, ...newer, names: [...new Set([...newer.names, ...older.names])], legacyFiles: [...older.legacyFiles, ...newer.legacyFiles] });
    } else byId.set(rec.sessionId, rec);
  }
  return [...byId.values()].sort((a, b) => String(b.at).localeCompare(String(a.at)));
}

export const getSessionById = (sessionId) => (sessionId ? listSessions().find((s) => s.sessionId === sessionId) : null);
export const findSession = (name) => listSessions().find((s) => s.names.includes(name)) || null;

// Creates or refreshes a session's record. Pass `title` when known; it decides
// the canonical name. `idle` is left as it was when undefined.
export function recordSession({ kind, sessionId, cwd, title, transcript, idle, aliases = [] }) {
  if (!sessionId || !kind) return null;
  const prev = getSessionById(sessionId);
  const t = title || prev?.title || null;
  const where = cwd || prev?.cwd || process.cwd();
  const name = canonicalName(kind, t, where);
  const names = [...new Set([name, ...(prev?.names || []), defaultName(kind, where), ...aliases.map(sanitizeName)])];
  const { legacyFiles = [], ...keep } = prev || {};
  const rec = {
    ...keep,
    sessionId, kind, name, names, title: t, cwd: where,
    transcript: transcript || prev?.transcript || null,
    host: os.hostname(),
    idle: idle === undefined ? (prev?.idle ?? false) : idle,
    at: new Date().toISOString(),
  };
  writeJsonAtomic(idFile(sessionId), rec);
  removeLegacy(legacyFiles);
  return rec;
}

export function updateSession(sessionId, patch) {
  const s = getSessionById(sessionId);
  if (!s) return;
  const { legacyFiles = [], ...keep } = s;
  writeJsonAtomic(idFile(sessionId), { ...keep, ...patch });
  removeLegacy(legacyFiles);
}

// Old name-keyed files are replaced by the id-keyed record just written.
function removeLegacy(files) {
  for (const f of files) if (f.includes("@")) try { fs.unlinkSync(dir("sessions", f)); } catch {}
}

export function addAlias(sessionId, alias) {
  const s = getSessionById(sessionId);
  if (!s) throw new Error("this session is not known to the bridge yet; send any prompt first");
  updateSession(sessionId, { names: [...new Set([...s.names, sanitizeName(alias)])] });
}

// ---------------------------------------------------------------- messages

// `to` may be any name or alias of a session ("codex:x32-research@alitop",
// "codex@h90") or just a kind ("codex"), which picks the best live session of
// that kind (same project folder as the sender first).
export function resolveRecipient(to, from) {
  const want = sanitizeName(to);
  if (!KINDS.includes(want)) {
    const matches = listSessions().filter((s) => s.names.includes(want));
    const exact = matches.find((s) => s.name === want);
    if (exact) return exact.name;
    // An old folder name ("codex@h90") is shared by every session in that
    // folder; picking one silently could reach the wrong session.
    if (matches.length > 1) {
      throw new Error(`"${want}" is an old name shared by ${matches.length} sessions: ${matches.map((s) => s.name).join(", ")}. Send to one of those names instead.`);
    }
    return matches[0]?.name || want;
  }
  const senderCwd = findSession(from)?.cwd;
  const agents = listAgents().filter((a) => a.kind === want && a.name !== from && a.sessionId);
  const pick =
    agents.find((a) => a.online && samePath(a.cwd, senderCwd)) ||
    agents.find((a) => a.online) ||
    agents.find((a) => samePath(a.cwd, senderCwd));
  // Nobody of that kind yet: address the folder mailbox so the next session of
  // that kind opened in the sender's folder picks it up.
  return pick ? pick.name : senderCwd ? defaultName(want, senderCwd) : `${want}@default`;
}

// The bridge only carries messages between different apps. Each app already
// has its own way to reach its other sessions.
export const NATIVE_MESSAGING = {
  claude: "To message another Claude session, use the SendMessage tool (ListAgents lists the sessions).",
  codex: "To message another Codex thread, use Codex's own thread messaging (the codex_app send_message_to_thread tool).",
};

export function send({ from, to, body, thread, replyTo }) {
  from = sanitizeName(from);
  if (!body || !String(body).trim()) throw new Error("message body is empty");
  let original = null;
  if (replyTo) {
    original = getMessage(replyTo);
    if (!original) throw new Error(`no message with id ${replyTo}`);
  }
  const recipient = to ? resolveRecipient(to, from) : original?.from;
  if (!recipient) throw new Error("`to` is required unless replying to a message");
  const fromKind = kindOf(from);
  const toKind = findSession(recipient)?.kind || kindOf(recipient);
  if (fromKind && fromKind === toKind) {
    throw new Error(`agent-bridge only carries messages between Claude and Codex. ${NATIVE_MESSAGING[fromKind]}`);
  }
  const id = newId();
  const msg = {
    id,
    from,
    to: recipient,
    thread: thread || original?.thread || id,
    replyTo: original?.id || null,
    body: String(body),
    createdAt: new Date().toISOString(),
  };
  writeJsonAtomic(dir("messages", `${id}.json`), msg);
  ensureDir(mailDir(recipient, "cur"));
  writeJsonAtomic(mailDir(recipient, "new", `${id}.json`), msg);
  maybePrune();
  return msg;
}

export function getMessage(id) {
  return readJson(dir("messages", `${String(id).replace(/[^a-z0-9-]/gi, "")}.json`));
}

export function peekUnread(names, { thread } = {}) {
  const out = [];
  for (const n of new Set(names)) {
    for (const f of listJson(mailDir(n, "new"))) {
      const m = readJson(mailDir(n, "new", f));
      if (m && (!thread || m.thread === thread)) out.push(m);
    }
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

// Moves unread messages to cur/. The rename is the claim: if two readers race
// (e.g. a hook and a tool call), exactly one of them gets each message.
export function takeUnread(names, opts = {}) {
  const taken = [];
  for (const m of peekUnread(names, opts)) {
    const src = mailDir(m.to, "new", `${m.id}.json`);
    try {
      ensureDir(mailDir(m.to, "cur"));
      fs.renameSync(src, mailDir(m.to, "cur", `${m.id}.json`));
      taken.push(m);
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
    }
  }
  return taken;
}

export async function waitForMessages(names, { timeoutMs, thread, signal } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const got = takeUnread(names, { thread });
    if (got.length || Date.now() >= deadline || signal?.aborted) return got;
    await new Promise((r) => setTimeout(r, Math.min(500, Math.max(0, deadline - Date.now()))));
  }
}

export function readThread(thread, { limit = 50 } = {}) {
  const msgs = [];
  for (const f of listJson(dir("messages"))) {
    const m = readJson(dir("messages", f));
    if (m && m.thread === thread) msgs.push(m);
  }
  return msgs.slice(-limit);
}

export function recentFor(name, { limit = 20 } = {}) {
  const files = listJson(dir("messages")).slice(-2000);
  const msgs = [];
  for (const f of files) {
    const m = readJson(dir("messages", f));
    if (m && (m.to === name || m.from === name)) msgs.push(m);
  }
  return msgs.slice(-limit);
}

let lastPrune = 0;
function maybePrune() {
  if (Date.now() - lastPrune < 3600_000) return;
  lastPrune = Date.now();
  const cutoff = Date.now() - RETENTION_MS;
  const stale = (f) => parseInt(f.split("-")[0], 36) < cutoff;
  for (const f of listJson(dir("messages"))) if (stale(f)) try { fs.unlinkSync(dir("messages", f)); } catch {}
  for (const n of safeReaddir(dir("mail")))
    for (const f of listJson(dir("mail", n, "cur"))) if (stale(f)) try { fs.unlinkSync(dir("mail", n, "cur", f)); } catch {}
}

// ---------------------------------------------------------------- formatting

export function formatMessages(msgs) {
  return msgs
    .map(
      (m) =>
        `--- message ${m.id} | from ${m.from} | to ${m.to} | thread ${m.thread}` +
        (m.replyTo ? ` | reply to ${m.replyTo}` : "") +
        ` | ${m.createdAt}\n${m.body}`
    )
    .join("\n\n");
}
