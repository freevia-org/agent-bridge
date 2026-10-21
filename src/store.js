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

export function sanitizeName(name) {
  const clean = String(name || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9@._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!clean) throw new Error("agent name is empty");
  return clean.slice(0, 80);
}

export function defaultName(kind, cwd = process.cwd()) {
  const folder = path.basename(path.resolve(cwd)) || "root";
  return sanitizeName(`${kind}@${folder}`);
}

export function kindOf(name) {
  const k = String(name).split("@")[0];
  return KINDS.includes(k) ? k : null;
}

function newId() {
  // Time-ordered: base36 millis (fixed width until 2059) + random suffix.
  return `${Date.now().toString(36)}-${crypto.randomBytes(3).toString("hex")}`;
}

// ---------------------------------------------------------------- presence

export function heartbeat(entry) {
  const now = new Date().toISOString();
  const file = dir("presence", `${entry.name}~${entry.pid}.json`);
  const prev = readJson(file);
  writeJsonAtomic(file, { ...entry, startedAt: prev?.startedAt || now, lastSeen: now });
}

export function clearPresence(name, pid) {
  try { fs.unlinkSync(dir("presence", `${name}~${pid}.json`)); } catch {}
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
}

// One row per agent name, newest heartbeat wins. Stale files are swept.
export function listAgents({ includeOffline = true } = {}) {
  const byName = new Map();
  const sharedAlive = {};
  const now = Date.now();
  for (const f of listJson(dir("presence"))) {
    const p = readJson(dir("presence", f));
    if (!p) continue;
    const age = now - Date.parse(p.lastSeen);
    const online = age < ONLINE_MS && (p.host !== os.hostname() || pidAlive(p.pid));
    if (!online && age > RETENTION_MS) {
      try { fs.unlinkSync(dir("presence", f)); } catch {}
      continue;
    }
    // A shared server (Codex) is not an agent itself; its sessions are, below.
    if (p.shared) {
      sharedAlive[p.kind] ||= online;
      continue;
    }
    const cur = byName.get(p.name);
    if (!cur || (online && !cur.online) || (online === cur.online && p.lastSeen > cur.lastSeen)) {
      byName.set(p.name, { ...p, online });
    }
  }
  // Sessions seen by hooks: online when their kind's shared server is running
  // and they were active in the last day.
  for (const s of listSessions()) {
    if (byName.get(s.name)?.online) continue;
    const online = !!sharedAlive[s.kind] && now - Date.parse(s.at) < 24 * 3600_000;
    byName.set(s.name, { name: s.name, kind: s.kind, cwd: s.cwd, online, lastSeen: s.at, sessionId: s.sessionId, idle: s.idle });
  }
  // Mailboxes that exist without a live server still count as known agents.
  for (const name of safeReaddir(dir("mail"))) {
    if (!byName.has(name)) byName.set(name, { name, kind: kindOf(name), online: false, lastSeen: null });
  }
  return [...byName.values()]
    .filter((a) => includeOffline || a.online)
    .map((a) => ({ ...a, unread: listJson(dir("mail", a.name, "new")).length }))
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
// Hooks record which agent session last ran under each name, and whether its
// turn is still running. Codex shares one MCP server across all its threads,
// so this is how that server learns who is calling (see mcp.js), and how
// wake.js finds the session to nudge.

export function recordSession(name, { kind, sessionId, cwd, idle }) {
  if (!sessionId) return;
  const file = dir("sessions", `${name}.json`);
  const prev = readJson(file);
  writeJsonAtomic(file, {
    ...(prev?.sessionId === sessionId ? prev : {}),
    name, kind, sessionId, cwd, idle, at: new Date().toISOString(),
  });
}

export function getSession(name) {
  return readJson(dir("sessions", `${name}.json`));
}

export function updateSession(name, patch) {
  const s = getSession(name);
  if (s) writeJsonAtomic(dir("sessions", `${name}.json`), { ...s, ...patch });
}

export function listSessions(kind) {
  return listJson(dir("sessions"))
    .map((f) => readJson(dir("sessions", f)))
    .filter((s) => s && (!kind || s.kind === kind))
    .sort((a, b) => b.at.localeCompare(a.at));
}

// ---------------------------------------------------------------- messages

// `to` may be an exact agent name ("codex@h90") or just a kind ("codex"),
// which picks the best live agent of that kind (same project folder first).
export function resolveRecipient(to, from) {
  const want = sanitizeName(to);
  if (want.includes("@") || !KINDS.includes(want)) return want;
  const folder = from.split("@")[1];
  const agents = listAgents().filter((a) => a.kind === want && a.name !== from);
  const pick =
    agents.find((a) => a.online && a.name.split("@")[1] === folder) ||
    agents.find((a) => a.online) ||
    agents.find((a) => a.name.split("@")[1] === folder);
  // Nobody of that kind yet: address the same-project mailbox so the next
  // session of that kind opened in this folder picks it up.
  return pick ? pick.name : `${want}@${folder || "default"}`;
}

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
  ensureDir(dir("mail", recipient, "cur"));
  writeJsonAtomic(dir("mail", recipient, "new", `${id}.json`), msg);
  maybePrune();
  return msg;
}

export function getMessage(id) {
  return readJson(dir("messages", `${String(id).replace(/[^a-z0-9-]/gi, "")}.json`));
}

export function peekUnread(names, { thread } = {}) {
  const out = [];
  for (const n of new Set(names)) {
    for (const f of listJson(dir("mail", n, "new"))) {
      const m = readJson(dir("mail", n, "new", f));
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
    const src = dir("mail", m.to, "new", `${m.id}.json`);
    try {
      ensureDir(dir("mail", m.to, "cur"));
      fs.renameSync(src, dir("mail", m.to, "cur", `${m.id}.json`));
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
