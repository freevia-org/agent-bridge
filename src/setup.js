// `agent-bridge setup`: everything needed on a machine, in one go.
//   1. update this checkout (git pull) when it is one
//   2. install (MCP server + hooks for Claude Code and Codex)
//   3. register recent Codex app threads, so they are reachable at once
//   4. run the hook commands the way each app will, to prove they execute
//   5. wait for the one manual step, approving the hooks in Codex
//   6. print the doctor summary
// Safe to re-run any time; that is also how you update.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { IS_EXE, ROOT, SELF, EXE_HOME } from "./self.js";
import * as store from "./store.js";
import { install, doctor, formatDoctor, codexApproval, hookCommand } from "./install.js";
import { linkCodexThread } from "./wake.js";
import { codexTitle, claudeTitle } from "./titles.js";

const CODEX_HOME = () => process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
const say = (s = "") => console.log(s);

export async function setup({ wait = process.stdin.isTTY, update = true, waitMinutes = 15 } = {}) {
  const rerun = (extra) => spawnSync(extra[0], [...extra.slice(1), "setup", "--no-update", ...(wait ? [] : ["--no-wait"])], { stdio: "inherit" }).status ?? 0;

  // The executable installs itself to a fixed place first; hooks point there.
  if (IS_EXE && !sameFile(process.execPath, EXE_HOME)) {
    placeExecutable();
    say(`Installed agent-bridge to ${EXE_HOME}\n`);
    process.exit(rerun([EXE_HOME]));
  }

  if (update && ROOT && fs.existsSync(path.join(ROOT, ".git"))) {
    const before = git("rev-parse", "HEAD");
    const pulled = spawnSync("git", ["-C", ROOT, "pull", "--ff-only", "-q"], { encoding: "utf8" });
    if (pulled.status !== 0) say(`(could not update: ${(pulled.stderr || "").trim().split("\n")[0]}; continuing with this version)`);
    else if (git("rev-parse", "HEAD") !== before) {
      say("Updated agent-bridge; restarting setup with the new version.\n");
      process.exit(rerun(SELF));
    }
  }

  say("1/4 Installing for Claude Code and Codex");
  for (const line of install()) say(`    ${line}`);

  say("2/4 Registering sessions (names: app:session@machine)");
  const migrated = migrateLegacySessions();
  if (migrated) say(`    renamed ${migrated} session(s) from the old app@folder names (old names still work)`);
  const linked = linkRecentCodexThreads();
  say(linked.length ? linked.map((l) => `    ${l.name}`).join("\n") : "    (none new)");

  say("3/4 Checking the hook commands run");
  const broken = checkHookCommands();
  say(broken.length ? broken.map((b) => `    FAILED ${b}`).join("\n") : `    ok (${process.platform === "win32" ? "cmd, PowerShell and bash" : "sh and bash"})`);

  say("4/4 Codex hook approval");
  let approval = codexApproval();
  if (!approval.missing.length) say("    already approved");
  else {
    say(`    Codex needs you to approve ${approval.missing.length} hook(s) once. In the Codex app, either click "Trust" when it`);
    say(`    asks you to review hooks, or open Settings > Hooks and trust the three titled "agent-bridge: ...".`);
    if (wait) {
      say(`    Waiting for the approval (up to ${waitMinutes} min; Ctrl+C to finish later with \`agent-bridge doctor\`)...`);
      const deadline = Date.now() + waitMinutes * 60_000;
      while (approval.missing.length && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 2000));
        approval = codexApproval();
      }
      say(approval.missing.length ? "    still not approved; run `agent-bridge doctor` after approving" : "    approved");
    }
  }

  say("\nSetup check:");
  say(formatDoctor(doctor()));
  say("\nNew Claude Code sessions get the agent-bridge tools; sessions that were already open only get the hooks.");
}

// Same file on disk, whatever the path says: on macOS /var is a symlink to
// /private/var, so the running executable's path and EXE_HOME can differ
// textually while being the same file.
function sameFile(a, b) {
  try {
    const x = fs.statSync(a), y = fs.statSync(b);
    return x.dev === y.dev && x.ino === y.ino;
  } catch {
    return false;
  }
}

// Copies this executable to EXE_HOME. The copy goes to a temporary file first
// and is then moved into place, so the source is never removed. A copy that
// Codex or Claude Code is running can't be replaced on Windows, but it can be
// renamed, so the old one is moved aside (and cleaned up on a later run).
function placeExecutable() {
  const dir = path.dirname(EXE_HOME);
  fs.mkdirSync(dir, { recursive: true });
  for (const f of fs.readdirSync(dir)) {
    if (f.includes(".old-")) try { fs.unlinkSync(path.join(dir, f)); } catch {}
  }
  const tmp = `${EXE_HOME}.new-${process.pid}`;
  fs.copyFileSync(process.execPath, tmp);
  if (process.platform !== "win32") fs.chmodSync(tmp, 0o755);
  if (process.platform === "win32" && fs.existsSync(EXE_HOME)) {
    try { fs.unlinkSync(EXE_HOME); } catch { fs.renameSync(EXE_HOME, `${EXE_HOME}.old-${Date.now()}`); }
  }
  fs.renameSync(tmp, EXE_HOME); // atomic replace on macOS/Linux, even while the old one runs
}

function git(...args) {
  try { return execFileSync("git", ["-C", ROOT, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch { return null; }
}

// Records from v0.2.x are keyed by "app@folder" and have no title. Convert
// each to the current form (named app:title@machine, old name kept as an
// alias), whether or not its session is still active. Titles come from
// Codex's thread index (it keeps archived threads) or the Claude transcript.
export function migrateLegacySessions() {
  const claudeProjects = path.join(os.homedir(), ".claude", "projects");
  let n = 0;
  for (const s of store.listSessions()) {
    if (!s.legacyFiles.length) continue;
    let transcript = s.transcript || null;
    let title = null;
    if (s.kind === "codex") title = codexTitle(s.sessionId);
    else {
      try {
        for (const p of fs.readdirSync(claudeProjects)) {
          const f = path.join(claudeProjects, p, `${s.sessionId}.jsonl`);
          if (fs.existsSync(f)) { transcript = f; break; }
        }
      } catch {}
      title = claudeTitle(transcript);
    }
    store.recordSession({ kind: s.kind, sessionId: s.sessionId, cwd: s.cwd, title, transcript, idle: s.idle });
    n++;
  }
  return n;
}

// Codex app threads used in the last 30 days (not `codex exec` or subagent
// threads), each under its own name "codex:<thread title>@<machine>". Threads
// already known get their title refreshed, which also migrates records from
// older versions to the current naming.
export function linkRecentCodexThreads({ days = 30 } = {}) {
  const root = path.join(CODEX_HOME(), "sessions");
  const cutoff = Date.now() - days * 24 * 3600_000;
  const files = [];
  walk(root, (p, st) => {
    if (/rollout-.*\.jsonl$/.test(p) && st.mtimeMs >= cutoff) files.push({ p, mtime: st.mtimeMs });
  });
  files.sort((a, b) => b.mtime - a.mtime);
  const linked = [];
  for (const { p } of files) {
    const meta = firstLine(p)?.payload;
    if (!meta?.id || !meta.cwd || meta.originator !== "Codex Desktop" || meta.thread_source !== "user") continue;
    const known = store.getSessionById(meta.id);
    if (known) {
      store.recordSession({ kind: "codex", sessionId: meta.id, cwd: known.cwd, title: codexTitle(meta.id) });
      continue;
    }
    try {
      const rec = linkCodexThread(meta.id, { cwd: meta.cwd });
      linked.push({ ...rec, title: codexTitle(meta.id) });
    } catch {}
  }
  return linked;
}

// The first line of a rollout is its session_meta; it can be large, so read
// only as far as the first newline.
function firstLine(file) {
  let fd;
  try {
    fd = fs.openSync(file, "r");
    const chunks = [];
    const buf = Buffer.alloc(64 * 1024);
    for (let pos = 0; pos < 8 * 1024 * 1024; ) {
      const n = fs.readSync(fd, buf, 0, buf.length, pos);
      if (!n) break;
      const nl = buf.subarray(0, n).indexOf(10);
      chunks.push(Buffer.from(buf.subarray(0, nl >= 0 ? nl : n)));
      if (nl >= 0) break;
      pos += n;
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function walk(dir, fn) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, fn);
    else try { fn(p, fs.statSync(p)); } catch {}
  }
}

// Runs each hook command through the shells the apps use, with a no-op event,
// and reports the ones that fail.
function checkHookCommands() {
  const failures = [];
  const input = JSON.stringify({ hook_event_name: "SetupCheck", session_id: "setup-check", cwd: os.homedir() });
  const shells =
    process.platform === "win32"
      ? [
          ["cmd", (c) => ["cmd.exe", ["/d", "/s", "/c", c]]],
          ["PowerShell", (c) => ["powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", c]]],
          ...(gitBash() ? [["bash", (c) => [gitBash(), ["-c", c]]]] : []),
        ]
      : [["sh", (c) => ["/bin/sh", ["-c", c]]], ...(fs.existsSync("/bin/bash") ? [["bash", (c) => ["/bin/bash", ["-c", c]]]] : [])];
  for (const kind of ["claude", "codex"]) {
    for (const [label, build] of shells) {
      const [cmd, args] = build(hookCommand(kind));
      const r = spawnSync(cmd, args, { input, encoding: "utf8", windowsVerbatimArguments: label === "cmd", timeout: 20_000 });
      if (r.status !== 0) failures.push(`${kind} hook under ${label}: ${(r.stderr || r.error?.message || "").trim().split("\n")[0]}`);
    }
  }
  return failures;
}

function gitBash() {
  const p = path.join(process.env.ProgramFiles || "C:\\Program Files", "Git", "bin", "bash.exe");
  return fs.existsSync(p) ? p : null;
}
