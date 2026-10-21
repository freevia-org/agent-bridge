// Waking an idle recipient. Hooks record each agent's session id and whether
// its last turn has ended; when mail arrives for an idle Codex session we
// queue a one-line nudge into it with `codex queue`. The nudge starts a turn,
// and the UserPromptSubmit hook then attaches the actual messages, so nothing
// is delivered twice. (Claude Code has no equivalent command; an idle Claude
// session is woken by `agent-bridge watch` running under its Monitor tool.)

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import * as store from "./store.js";

export const NUDGE_PREFIX = "[agent-bridge nudge]";
const NUDGE_EVERY_MS = 60_000;
const SESSION_MAX_AGE_MS = 7 * 24 * 3600_000;

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
    const message = `${NUDGE_PREFIX} New message from ${from}; it is attached below. Handle it, replying with the agent-bridge reply tool if needed.`;
    const child = spawn(codex, ["queue", "--thread", s.sessionId, "--message", message], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.on("error", () => {});
    child.unref();
    store.updateSession(recipient, { nudgedAt: new Date().toISOString() });
    return true;
  } catch {
    return false;
  }
}

let cached;
export function findCodex() {
  if (cached !== undefined) return cached;
  const candidates = [process.env.AGENT_BRIDGE_CODEX, process.env.CODEX_CLI_PATH];
  try {
    const which = process.platform === "win32" ? "where.exe" : "which";
    candidates.push(execFileSync(which, ["codex"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).split(/\r?\n/)[0].trim());
  } catch {}
  if (process.platform === "win32") {
    // Desktop app install: %LOCALAPPDATA%\OpenAI\Codex\bin\<hash>\codex.exe (newest wins).
    const bin = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "OpenAI", "Codex", "bin");
    try {
      const dirs = fs.readdirSync(bin).map((d) => path.join(bin, d, "codex.exe")).filter((p) => fs.existsSync(p));
      dirs.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
      candidates.push(...dirs);
    } catch {}
  } else if (process.platform === "darwin") {
    candidates.push("/Applications/Codex.app/Contents/Resources/codex");
  }
  cached = candidates.find((p) => p && fs.existsSync(p)) || null;
  return cached;
}
