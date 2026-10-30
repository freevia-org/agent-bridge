// End-to-end check: two MCP servers (one per app) plus the hooks, against a
// throwaway AGENT_BRIDGE_HOME and CODEX_HOME. Covers naming
// (app:session@machine, aliases, renames), caller identification, the
// Claude<->Codex-only rule, delivery, nudges and threads.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "bin", "agent-bridge.js");
// AGENT_BRIDGE_EXE=path/to/agent-bridge.exe runs the same checks against the standalone executable.
const SELF = process.env.AGENT_BRIDGE_EXE ? [process.env.AGENT_BRIDGE_EXE] : [process.execPath, CLI];
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "agent-bridge-test-"));
const PROJECT = path.join(HOME, "proj");
const CODEX_HOME = path.join(HOME, "codex");
fs.mkdirSync(PROJECT);
fs.mkdirSync(CODEX_HOME);
// The machine part of names is pinned: macOS hosts can report an IP address as
// their hostname, and the bridge deliberately avoids that (see machineName).
const M = "testbox";
const env = { ...process.env, AGENT_BRIDGE_HOME: path.join(HOME, "store"), CODEX_HOME, AGENT_BRIDGE_MACHINE: M };

// Session titles: a Claude transcript and a Codex thread index.
const transcript = path.join(HOME, "claude-sess.jsonl");
fs.writeFileSync(transcript, JSON.stringify({ type: "custom-title", customTitle: "Port Review", sessionId: "claude-sess" }) + "\n");
const setCodexTitle = (id, name) => fs.appendFileSync(path.join(CODEX_HOME, "session_index.jsonl"), JSON.stringify({ id, thread_name: name }) + "\n");
setCodexTitle("codex-sess", "Device Tests");

function server(kind) {
  const p = spawn(SELF[0], [...SELF.slice(1), "mcp", "--kind", kind], { cwd: PROJECT, env, stdio: ["pipe", "pipe", "inherit"] });
  let buf = "";
  const pending = new Map();
  let next = 1;
  p.stdout.on("data", (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const msg = JSON.parse(buf.slice(0, i));
      buf = buf.slice(i + 1);
      pending.get(msg.id)?.(msg);
    }
  });
  const rpc = (method, params) =>
    new Promise((res) => {
      const id = next++;
      pending.set(id, res);
      p.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  let toolUse = 0;
  const call = async (name, args = {}, meta) => {
    // Each app identifies its caller the way the real clients do.
    if (!meta && kind === "claude") {
      const id = `toolu_test_${++toolUse}`;
      fs.appendFileSync(transcript, JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id }] } }) + "\n");
      meta = { "claudecode/toolUseId": id };
    }
    if (!meta && kind === "codex") meta = { threadId: "codex-sess" };
    const r = await rpc("tools/call", { name, arguments: args, _meta: meta });
    const text = r.result.content[0].text;
    try { return JSON.parse(text); } catch { return text; }
  };
  return { p, rpc, call };
}

function hook(kind, input) {
  const r = spawnSync(SELF[0], [...SELF.slice(1), "hook", "--kind", kind], { cwd: PROJECT, env, input: JSON.stringify(input) });
  return r.stdout.toString() ? JSON.parse(r.stdout.toString()) : null;
}
const codexHook = (event, extra = {}) => hook("codex", { hook_event_name: event, session_id: "codex-sess", cwd: PROJECT, transcript_path: "x", ...extra });
const claudeHook = (event, extra = {}) => hook("claude", { hook_event_name: event, session_id: "claude-sess", cwd: PROJECT, transcript_path: transcript, ...extra });

const CODEX = `codex:device-tests@${M}`;
const CLAUDE = `claude:port-review@${M}`;

const claude = server("claude");
const codex = server("codex");
try {
  const init = await claude.rpc("initialize", { protocolVersion: "2025-06-18", clientInfo: { name: "test" }, capabilities: {} });
  assert.equal(init.result.serverInfo.name, "agent-bridge");
  assert.match(init.result.instructions, /ONLY for Claude <-> Codex/);
  await codex.rpc("initialize", { protocolVersion: "2025-06-18", clientInfo: { name: "test" }, capabilities: {} });
  const tools = (await claude.rpc("tools/list", {})).result.tools.map((t) => t.name);
  assert.ok(tools.includes("send") && tools.includes("wait"));

  // Hooks record each session under app:session-title@machine.
  const ssCodex = codexHook("SessionStart");
  assert.match(ssCodex.hookSpecificOutput.additionalContext, new RegExp(`Your bridge name is "${CODEX}"`));
  assert.match(ssCodex.hookSpecificOutput.additionalContext, /send_message_to_thread/);
  const ssClaude = claudeHook("SessionStart");
  assert.match(ssClaude.hookSpecificOutput.additionalContext, new RegExp(`Your bridge name is "${CLAUDE}"`));
  assert.match(ssClaude.hookSpecificOutput.additionalContext, /SendMessage/);

  // Each server works out which session is calling.
  const whoCodex = await codex.call("whoami");
  assert.equal(whoCodex.you, CODEX);
  assert.ok(whoCodex.aliases.includes("codex@proj"), "folder name kept as an alias");
  const who = await claude.call("whoami");
  assert.equal(who.you, CLAUDE);
  assert.ok(who.codex_sessions.some((a) => a.name === CODEX && a.online), "codex session listed as online");

  // Claude asks by app and waits; Codex picks it up with wait and replies.
  const asking = claude.call("send", { to: "codex", body: "What is 2+2?", wait_for_reply_seconds: 10 });
  const got = await codex.call("wait", { timeout_seconds: 5 });
  assert.match(got, /What is 2\+2\?/);
  const id = got.match(/message (\S+)/)[1];
  await codex.call("reply", { message_id: id, body: "4" });
  const answer = await asking;
  assert.match(answer.replies, new RegExp(`from ${CODEX}[\\s\\S]*\\n4$`));

  // Same-app messages are refused with a pointer to the app's own messaging.
  const sameClaude = await claude.call("send", { to: CLAUDE, body: "hi me" });
  assert.match(sameClaude, /only carries messages between Claude and Codex.*SendMessage/s);
  const sameCodex = await codex.call("send", { to: "codex", body: "hi" });
  assert.match(sameCodex, /only carries messages between Claude and Codex.*send_message_to_thread/s);

  // Mail that arrives while Claude is idle is delivered by the Stop hook...
  await codex.call("send", { to: "claude", body: "ping from codex" });
  const stop = claudeHook("Stop");
  assert.equal(stop.decision, "block");
  assert.match(stop.reason, /ping from codex/);
  // ...exactly once.
  assert.equal(claudeHook("Stop"), null);

  // The old folder-based name still reaches the session.
  await claude.call("send", { to: "codex@proj", body: "via old name" });
  assert.match(codexHook("UserPromptSubmit").hookSpecificOutput.additionalContext, /via old name/);

  // Renaming the thread renames the session; the previous name keeps working.
  setCodexTitle("codex-sess", "Hardware Tests");
  codexHook("UserPromptSubmit");
  const renamed = await codex.call("whoami");
  assert.equal(renamed.you, `codex:hardware-tests@${M}`);
  assert.ok(renamed.aliases.includes(CODEX), "old name kept as alias");
  await claude.call("send", { to: CODEX, body: "to the old name" });
  assert.match(codexHook("UserPromptSubmit").hookSpecificOutput.additionalContext, /to the old name/);

  // A Codex session whose turn ended is idle, so new mail nudges it.
  codexHook("Stop");
  const fakeCodex = { ...env, AGENT_BRIDGE_CODEX: process.execPath }; // stand-in binary; the queue call just fails
  const sendCli = () =>
    spawnSync(SELF[0], [...SELF.slice(1), "send", "--from", CLAUDE, "--to", "codex@proj", "wake up"], { env: fakeCodex }).stdout.toString();
  assert.match(sendCli(), /nudged idle session/);
  assert.doesNotMatch(sendCli(), /nudged/);
  // The nudge counts toward the auto-turn limit rather than resetting it.
  const nudge = codexHook("UserPromptSubmit", { prompt: "[agent-bridge nudge] hi" });
  assert.match(nudge.hookSpecificOutput.additionalContext, /wake up/);
  // Once that nudged turn has ended, a follow-up nudges again straight away.
  codexHook("Stop");
  assert.match(sendCli(), /nudged idle session/);
  codexHook("UserPromptSubmit", { prompt: "[agent-bridge nudge] hi" });

  // Codex's throwaway forks (no transcript) neither get mail nor take over the name.
  await claude.call("send", { to: "codex@proj", body: "not for forks" });
  assert.equal(hook("codex", { hook_event_name: "Stop", session_id: "fork", cwd: PROJECT, transcript_path: null }), null);
  assert.match(codexHook("UserPromptSubmit").hookSpecificOutput.additionalContext, /not for forks/);

  // A resumed session: SessionStart only announces, the nudge prompt delivers.
  codexHook("Stop");
  await claude.call("send", { to: "codex@proj", body: "after resume" });
  assert.match(codexHook("SessionStart").hookSpecificOutput.additionalContext, /1 message\(s\) .* waiting/);
  assert.match(codexHook("UserPromptSubmit", { prompt: "[agent-bridge nudge] x" }).hookSpecificOutput.additionalContext, /after resume/);
  // A duplicate nudge right after the delivery must not add anything.
  assert.equal(codexHook("UserPromptSubmit", { prompt: "[agent-bridge nudge] x" }), null);

  // A linked thread is named by its title; --name adds an alias that reaches it.
  setCodexTitle("linked-sess", "Linux Port");
  const linkOut = spawnSync(SELF[0], [...SELF.slice(1), "link", "--codex-thread", "linked-sess", "--cwd", PROJECT, "--name", "codex@nickname"], { env }).stdout.toString();
  assert.match(linkOut, new RegExp(`codex:linux-port@${M}`));
  await claude.call("send", { to: "codex@nickname", body: "via link" });
  assert.match(hook("codex", { hook_event_name: "UserPromptSubmit", session_id: "linked-sess", cwd: PROJECT, transcript_path: "x" }).hookSpecificOutput.additionalContext, /via link/);

  // Two Codex threads in one folder share its old name; sending to it is
  // refused with the exact names instead of guessing.
  setCodexTitle("second-sess", "Second Thread");
  hook("codex", { hook_event_name: "UserPromptSubmit", session_id: "second-sess", cwd: PROJECT, transcript_path: "x" });
  const ambiguous = await claude.call("send", { to: "codex@proj", body: "which one?" });
  assert.match(ambiguous, /old name shared by \d+ sessions: .*codex:second-thread@/s);

  // Threads keep both directions.
  const thread = (await claude.call("send", { to: "codex", body: "t1" })).sent.thread;
  assert.match(await claude.call("thread", { thread }), /t1/);

  console.log("smoke test passed");
} finally {
  // Children hold PROJECT as cwd; Windows won't delete it until they exit.
  await Promise.all([claude.p, codex.p].map((p) => new Promise((r) => (p.once("exit", r), p.kill()))));
  try { fs.rmSync(HOME, { recursive: true, force: true, maxRetries: 5 }); } catch {}
}
