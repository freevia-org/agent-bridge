// Hook handler shared by Claude Code and Codex (both use the same hook JSON
// shape). It turns mailbox messages into context the agent sees without
// polling:
//   SessionStart      -> tell the agent its bridge name, peers, and unread mail
//   UserPromptSubmit  -> attach unread mail to the user's prompt
//   Stop              -> if mail arrived during the turn, keep the agent going
//                        so it can handle it (like a message from a sibling session)

import fs from "node:fs";
import path from "node:path";
import { SELF } from "./self.js";
import * as store from "./store.js";
import { NUDGE_PREFIX } from "./wake.js";
import { sessionTitle } from "./titles.js";

// Two agents replying to each other forever would burn tokens unattended, so
// Stop only re-opens a turn this many times before the user speaks again.
const MAX_AUTO_TURNS = 25;

export async function runHook({ kind }) {
  let input = {};
  try {
    const raw = (await readStdin()).replace(/^﻿/, ""); // PowerShell pipes add a BOM
    input = raw.trim() ? JSON.parse(raw) : {};
  } catch {}
  let out = null;
  let err = null;
  try {
    out = handle(kind, input);
    if (out) process.stdout.write(JSON.stringify(out));
  } catch (e) {
    // Never break the agent because of the bridge.
    err = e;
    process.stderr.write(`agent-bridge hook: ${e.message}\n`);
  }
  log(kind, input, out, err);
  process.exit(0);
}

// One line per invocation in hook.log (rotated at 1 MB) for `agent-bridge doctor`.
function log(kind, input, out, err) {
  try {
    const f = path.join(store.home(), "hook.log");
    if (fs.existsSync(f) && fs.statSync(f).size > 1_000_000) fs.renameSync(f, `${f}.1`);
    const what = err
      ? `error ${err.message}`
      : isEphemeral(kind, input)
        ? "skipped (ephemeral fork)"
        : out?.decision ? "blocked stop (delivered mail)" : out ? "added context" : "nothing to do";
    fs.appendFileSync(f, `${new Date().toISOString()} ${kind} ${input.hook_event_name || "?"} session=${input.session_id || "?"} ${what}\n`);
    // Latest input per kind+event (prompt/response text dropped), for diagnosing what a client sends.
    const { prompt, last_assistant_message, ...meta } = input;
    fs.writeFileSync(path.join(store.home(), `last-hook-input-${kind}-${input.hook_event_name || "unknown"}.json`), JSON.stringify(meta, null, 2));
  } catch {}
}

// Codex forks a throwaway copy of a thread after each turn for its own
// bookkeeping; those have no transcript and must not receive mail or take
// over the thread's name.
export const isEphemeral = (kind, input) => kind === "codex" && input.transcript_path === null;

const EVENTS = ["SessionStart", "UserPromptSubmit", "Stop"];

function handle(kind, input) {
  if (isEphemeral(kind, input)) return null;
  const event = input.hook_event_name || input.hookEventName;
  // Only real session events are recorded (setup's hook check sends a dummy one).
  if (!EVENTS.includes(event)) return null;
  const cwd = input.cwd || process.cwd();
  const sessionId = input.session_id;
  const transcript = input.transcript_path || null;
  // Refresh the record first so the name below reflects the current title.
  const rec = store.recordSession({ kind, sessionId, cwd, transcript, title: sessionTitle(kind, { sessionId, transcript }) });
  const names = rec ? rec.names : [store.defaultName(kind, cwd)];
  const out = respond(event, kind, input, names);
  // Busy while a turn runs; idle once Stop lets it end (wake.js nudges idle Codex sessions).
  if (rec) store.updateSession(sessionId, { idle: event === "Stop" && !out?.decision });
  return out;
}

const OTHER = { claude: "codex", codex: "claude" };
const APP = { claude: "Claude", codex: "Codex" };

function respond(event, kind, input, names) {
  if (event === "SessionStart") {
    const other = OTHER[kind];
    const peers = store.listAgents({ includeOffline: false }).filter((a) => a.kind === other);
    // Only announce waiting mail here; UserPromptSubmit (which always follows)
    // delivers it, so a nudge prompt can tell a stale nudge from a live one.
    const waiting = store.peekUnread(names).length;
    const lines = [
      `[agent-bridge] Your bridge name is "${names[0]}" (app:session@machine). agent-bridge is only for messaging ${APP[other]} sessions on this machine: use its MCP tools (send, reply, wait, inbox, agents). ${store.NATIVE_MESSAGING[kind]}`,
      peers.length ? `${APP[other]} sessions online now: ${peers.map((p) => p.name).join(", ")}.` : `No ${APP[other]} sessions are online right now.`,
    ];
    if (kind === "claude") {
      // Claude Code can't be poked from outside, but its Monitor tool wakes the
      // session on each line a background command prints.
      const self = SELF.map((p) => `"${p.replace(/\\/g, "/")}"`).join(" ");
      lines.push(
        `When you expect replies from Codex, or the user asks you to stay reachable, run \`${self} watch --as ${names[0]}\` with the Monitor tool (persistent) so messages wake you while idle.`
      );
    }
    if (waiting) lines.push(`${waiting} message(s) from other agents are waiting; they are attached to the prompt below.`);
    return context(event, lines.join("\n"));
  }

  if (event === "UserPromptSubmit") {
    // A nudge queued by another agent is not the user speaking, so it counts
    // toward the auto-turn limit instead of resetting it.
    const nudged = String(input.prompt || "").startsWith(NUDGE_PREFIX);
    if (!nudged) resetAutoTurns(input.session_id);
    else if (bumpAutoTurns(input.session_id) > MAX_AUTO_TURNS) {
      return context(event, `[agent-bridge] ${MAX_AUTO_TURNS} automatic turns have run without the user. Do not reply to agents again until the user speaks.`);
    }
    const mail = store.takeUnread(names);
    if (mail.length) {
      store.updateSession(input.session_id, { deliveredAt: new Date().toISOString() });
      return context(event, `[agent-bridge] Messages from other agents arrived:\n\n${store.formatMessages(mail)}`);
    }
    if (!nudged) return null;
    // A nudge without mail is a duplicate: `codex exec resume` also drains the
    // app's queued copy into the same turn, or the app runs it long after the
    // mail went out another way. Right after a delivery, say nothing (the
    // agent is handling it); otherwise let the agent know there's nothing new.
    const s = store.getSessionById(input.session_id);
    if (s?.deliveredAt && Date.now() - Date.parse(s.deliveredAt) < 10 * 60_000) return null;
    return context(event, `[agent-bridge] No new messages came with this nudge; they were already delivered earlier. If nothing else is pending, just stop.`);
  }

  if (event === "Stop") {
    if (!store.peekUnread(names).length) return null;
    if (bumpAutoTurns(input.session_id) > MAX_AUTO_TURNS) {
      return { systemMessage: `agent-bridge: unread messages are waiting, but ${MAX_AUTO_TURNS} automatic turns have run; they will be delivered on your next prompt.` };
    }
    const mail = store.takeUnread(names);
    if (!mail.length) return null;
    return {
      decision: "block",
      reason:
        `[agent-bridge] New messages from other agents arrived while you were working:\n\n${store.formatMessages(mail)}\n\n` +
        `Handle them now: answer with the agent-bridge reply tool if a response is needed (use judgement; ask the user before anything risky). ` +
        `If nothing needs doing, just finish.`,
    };
  }
  return null;
}

function context(event, text) {
  return { hookSpecificOutput: { hookEventName: event, additionalContext: text } };
}

function stateFile(sessionId) {
  return path.join(store.home(), "state", `turns-${String(sessionId || "unknown").replace(/[^a-z0-9-]/gi, "")}.json`);
}

function bumpAutoTurns(sessionId) {
  const f = stateFile(sessionId);
  let n = 0;
  try { n = JSON.parse(fs.readFileSync(f, "utf8")).n || 0; } catch {}
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify({ n: n + 1 }));
  return n + 1;
}

function resetAutoTurns(sessionId) {
  try { fs.unlinkSync(stateFile(sessionId)); } catch {}
}

function readStdin() {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve("");
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => (data += c));
    process.stdin.on("end", () => resolve(data));
    setTimeout(() => resolve(data), 3000).unref();
  });
}
