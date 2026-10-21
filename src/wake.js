// Waking an idle recipient. Hooks record each agent's session id and whether
// its last turn has ended; when mail arrives for an idle Codex session we
// start a turn in it with a one-line nudge. The nudge is a prompt like any
// other, so the UserPromptSubmit hook attaches the actual messages and
// nothing is delivered twice.
//
// Codex offers two ways in, and we need both:
//   1. `codex queue` hands the nudge to the desktop app. It runs at once if
//      the app has the thread loaded (and shows up live there), but waits
//      indefinitely if it doesn't.
//   2. `codex exec resume <thread>` runs the turn in a separate headless
//      process, appending to the same thread. It always works, but must not
//      run while the app has the thread loaded (two writers).
// So we queue first, and a detached checker falls back to exec resume when
// the mail is still unread after FALLBACK_MS, which means the app did not
// pick the nudge up.
//
// Claude Code has no equivalent command; an idle Claude session is woken by
// `agent-bridge watch` running under its Monitor tool.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import * as store from "./store.js";
import { SELF } from "./self.js";

export const NUDGE_PREFIX = "[agent-bridge nudge]";
const NUDGE_EVERY_MS = 60_000;
// The app starts a queued turn within ~7 s when it has the thread loaded.
const FALLBACK_MS = 15_000;
const SESSION_MAX_AGE_MS = 7 * 24 * 3600_000;

const nudgeText = (from) =>
  `${NUDGE_PREFIX} New message from ${from}; it is attached below. Handle it, replying with the agent-bridge reply tool if needed.`;

export function wakeIfIdle(recipient, from) {
  try {
    const s = store.getSession(recipient);
    if (!s || s.kind !== "codex" || !s.idle || !s.sessionId) return false;
    if (Date.now() - Date.parse(s.at) > SESSION_MAX_AGE_MS) return false;
    // Hold off only while an earlier nudge is still pending: once the session
    // has run hooks since that nudge (s.at moved past it), nudge right away.
    const pending = s.nudgedAt && Date.parse(s.nudgedAt) >= Date.parse(s.at);
    if (pending && Date.now() - Date.parse(s.nudgedAt) < NUDGE_EVERY_MS) return false;
    const codex = findCodex();
    if (!codex) return false;
    const nudgedAt = new Date().toISOString();
    detached(codex, ["queue", "--thread", s.sessionId, "--message", nudgeText(from)]);
    store.updateSession(recipient, { nudgedAt });
    detached(SELF[0], [...SELF.slice(1), "wake-check", "--name", recipient, "--nudged", nudgedAt, "--from", from]);
    return true;
  } catch {
    return false;
  }
}

// Runs in its own detached process (see wakeIfIdle).
export async function wakeCheck({ name, nudgedAt, from }) {
  await new Promise((r) => setTimeout(r, FALLBACK_MS));
  const s = store.getSession(name);
  if (!s?.sessionId) return log(name, "no session recorded; nothing to do");
  if (!store.peekUnread([name]).length) return log(name, "mail was picked up; app woke the thread");
  if (Date.parse(s.at) > Date.parse(nudgedAt) && !s.idle) return log(name, "a turn is already running; its Stop hook will deliver");
  if (s.fallbackAt && Date.parse(s.fallbackAt) > Date.parse(nudgedAt)) return log(name, "fallback already started");
  const codex = findCodex();
  if (!codex) return log(name, "codex CLI not found; cannot fall back");
  store.updateSession(name, { fallbackAt: new Date().toISOString() });
  log(name, `thread ${s.sessionId} not loaded in the app; running codex exec resume`);
  const out = fs.openSync(path.join(store.home(), "wake-exec.log"), "a");
  const child = spawn(codex, ["exec", "--skip-git-repo-check", "resume", s.sessionId, nudgeText(from)], {
    cwd: s.cwd && fs.existsSync(s.cwd) ? s.cwd : os.homedir(),
    stdio: ["ignore", out, out],
    windowsHide: true,
  });
  const code = await new Promise((r) => child.on("exit", r).on("error", () => r(-1)));
  log(name, `codex exec resume exited with ${code}`);
}

// Registers an existing Codex thread the hooks have not seen yet (e.g. one
// last used before install), so it can be messaged without opening it. The
// folder comes from the thread's rollout file (its first line is the
// session_meta record) unless given.
export function linkCodexThread(threadId, { cwd, name } = {}) {
  if (!cwd) {
    const root = path.join(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"), "sessions");
    const file = findFile(root, (f) => f.endsWith(`${threadId}.jsonl`));
    if (!file) throw new Error(`no rollout file for thread ${threadId} under ${root}; pass --cwd`);
    const meta = JSON.parse(fs.readFileSync(file, "utf8").split("\n", 1)[0]);
    cwd = meta?.payload?.cwd;
    if (!cwd) throw new Error(`thread ${threadId} has no cwd in its session_meta; pass --cwd`);
  }
  cwd = cwd.replace(/^\\\\\?\\/, "");
  const n = store.sanitizeName(name || store.defaultName("codex", cwd));
  store.recordSession(n, { kind: "codex", sessionId: threadId, cwd, idle: true });
  return { name: n, sessionId: threadId, cwd };
}

function findFile(dir, match) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return null; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      const hit = findFile(p, match);
      if (hit) return hit;
    } else if (match(e.name)) return p;
  }
  return null;
}

function detached(cmd, args) {
  // cwd: home, so a lingering helper never locks a project folder (Windows).
  const child = spawn(cmd, args, { detached: true, stdio: "ignore", windowsHide: true, cwd: os.homedir() });
  child.on("error", () => {});
  child.unref();
}

function log(name, what) {
  try {
    fs.appendFileSync(path.join(store.home(), "wake.log"), `${new Date().toISOString()} ${name}: ${what}\n`);
  } catch {}
}

let cached;
export function findCodex() {
  if (cached !== undefined) return cached;
  const candidates = [process.env.AGENT_BRIDGE_CODEX];
  try {
    const which = process.platform === "win32" ? "where.exe" : "which";
    candidates.push(execFileSync(which, ["codex"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).split(/\r?\n/)[0].trim());
  } catch {}
  if (process.platform === "win32") {
    // Desktop app install: %LOCALAPPDATA%\OpenAI\Codex\bin\<hash>\codex.exe.
    // The hash changes on every Codex update, so take the newest.
    const bin = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "OpenAI", "Codex", "bin");
    try {
      const dirs = fs.readdirSync(bin).map((d) => path.join(bin, d, "codex.exe")).filter((p) => fs.existsSync(p));
      dirs.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
      candidates.push(...dirs);
    } catch {}
  } else if (process.platform === "darwin") {
    candidates.push("/Applications/Codex.app/Contents/Resources/codex");
  }
  // CODEX_CLI_PATH last: Codex sets it for its own children, and it goes
  // stale when Codex updates while the app keeps running.
  candidates.push(process.env.CODEX_CLI_PATH);
  cached = candidates.find((p) => p && fs.existsSync(p)) || null;
  return cached;
}
