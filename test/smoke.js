// End-to-end check: two MCP servers (one per agent kind) plus the hook,
// all against a throwaway AGENT_BRIDGE_HOME.
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
fs.mkdirSync(PROJECT);
const env = { ...process.env, AGENT_BRIDGE_HOME: path.join(HOME, "store") };

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
  const call = async (name, args = {}) => {
    const r = await rpc("tools/call", { name, arguments: args });
    const text = r.result.content[0].text;
    try { return JSON.parse(text); } catch { return text; }
  };
  return { p, rpc, call };
}

function hook(kind, input) {
  const r = spawnSync(SELF[0], [...SELF.slice(1), "hook", "--kind", kind], { cwd: PROJECT, env, input: JSON.stringify(input) });
  return r.stdout.toString() ? JSON.parse(r.stdout.toString()) : null;
}

const claude = server("claude");
const codex = server("codex");
try {
  const init = await claude.rpc("initialize", { protocolVersion: "2025-06-18", clientInfo: { name: "test" }, capabilities: {} });
  assert.equal(init.result.serverInfo.name, "agent-bridge");
  await codex.rpc("initialize", { protocolVersion: "2025-06-18", clientInfo: { name: "test" }, capabilities: {} });
  const tools = (await claude.rpc("tools/list", {})).result.tools.map((t) => t.name);
  assert.ok(tools.includes("send") && tools.includes("wait"));

  // Codex's server is shared by all its threads; a session exists once its hooks fire.
  hook("codex", { hook_event_name: "SessionStart", session_id: "codex-sess", cwd: PROJECT });
  assert.equal((await codex.call("whoami")).you, "codex@proj");

  const who = await claude.call("whoami");
  assert.equal(who.you, "claude@proj");
  assert.ok(who.agents.some((a) => a.name === "codex@proj" && a.online), "codex should be online");

  // Claude asks by kind and waits; Codex picks it up with wait and replies.
  const asking = claude.call("send", { to: "codex", body: "What is 2+2?", wait_for_reply_seconds: 10 });
  const got = await codex.call("wait", { timeout_seconds: 5 });
  assert.match(got, /What is 2\+2\?/);
  const id = got.match(/message (\S+)/)[1];
  await codex.call("reply", { message_id: id, body: "4" });
  const answer = await asking;
  assert.match(answer.replies, /from codex@proj[\s\S]*\n4$/);

  // Mail that arrives while Claude is idle is delivered by the Stop hook...
  await codex.call("send", { to: "claude", body: "ping from codex" });
  const stop = hook("claude", { hook_event_name: "Stop", session_id: "s1", cwd: PROJECT });
  assert.equal(stop.decision, "block");
  assert.match(stop.reason, /ping from codex/);
  // ...exactly once.
  assert.equal(hook("claude", { hook_event_name: "Stop", session_id: "s1", cwd: PROJECT }), null);

  // UserPromptSubmit attaches mail as context; SessionStart introduces the agent.
  await claude.call("send", { to: "codex@proj", body: "context please" });
  const ups = hook("codex", { hook_event_name: "UserPromptSubmit", session_id: "s2", cwd: PROJECT });
  assert.match(ups.hookSpecificOutput.additionalContext, /context please/);
  const ss = hook("codex", { hook_event_name: "SessionStart", session_id: "s2", cwd: PROJECT });
  assert.match(ss.hookSpecificOutput.additionalContext, /You are "codex@proj"/);

  // A Codex session whose turn ended is idle, so new mail nudges it (once per minute).
  hook("codex", { hook_event_name: "Stop", session_id: "codex-sess", cwd: PROJECT });
  const fakeCodex = { ...env, AGENT_BRIDGE_CODEX: process.execPath }; // stand-in binary; the queue call just fails
  const sendCli = () =>
    spawnSync(SELF[0], [...SELF.slice(1), "send", "--from", "claude@proj", "--to", "codex@proj", "wake up"], { env: fakeCodex }).stdout.toString();
  assert.match(sendCli(), /nudged idle session/);
  assert.doesNotMatch(sendCli(), /nudged/);
  // The nudge counts toward the auto-turn limit rather than resetting it.
  const nudge = hook("codex", { hook_event_name: "UserPromptSubmit", session_id: "codex-sess", cwd: PROJECT, prompt: "[agent-bridge nudge] hi" });
  assert.match(nudge.hookSpecificOutput.additionalContext, /wake up/);
  // Once that nudged turn has ended, a follow-up nudges again straight away.
  hook("codex", { hook_event_name: "Stop", session_id: "codex-sess", cwd: PROJECT });
  assert.match(sendCli(), /nudged idle session/);
  hook("codex", { hook_event_name: "UserPromptSubmit", session_id: "codex-sess", cwd: PROJECT, prompt: "[agent-bridge nudge] hi" });

  // Codex's throwaway forks (no transcript) neither get mail nor take over the name.
  await claude.call("send", { to: "codex@proj", body: "not for forks" });
  assert.equal(hook("codex", { hook_event_name: "Stop", session_id: "fork", cwd: PROJECT, transcript_path: null }), null);
  assert.match(hook("codex", { hook_event_name: "UserPromptSubmit", session_id: "codex-sess", cwd: PROJECT, transcript_path: "x" }).hookSpecificOutput.additionalContext, /not for forks/);

  // A resumed session: SessionStart only announces, the nudge prompt delivers.
  hook("codex", { hook_event_name: "Stop", session_id: "codex-sess", cwd: PROJECT, transcript_path: "x" });
  await claude.call("send", { to: "codex@proj", body: "after resume" });
  const start = hook("codex", { hook_event_name: "SessionStart", session_id: "codex-sess", cwd: PROJECT, transcript_path: "x" });
  assert.match(start.hookSpecificOutput.additionalContext, /1 message\(s\) .* waiting/);
  const prompt = hook("codex", { hook_event_name: "UserPromptSubmit", session_id: "codex-sess", cwd: PROJECT, transcript_path: "x", prompt: "[agent-bridge nudge] x" });
  assert.match(prompt.hookSpecificOutput.additionalContext, /after resume/);
  // A duplicate nudge right after the delivery (exec resume drains the app's
  // queued copy into the same turn) must not add anything.
  assert.equal(hook("codex", { hook_event_name: "UserPromptSubmit", session_id: "codex-sess", cwd: PROJECT, transcript_path: "x", prompt: "[agent-bridge nudge] x" }), null);

  // A linked name reaches its thread even though the folder name differs.
  spawnSync(SELF[0], [...SELF.slice(1), "link", "--codex-thread", "linked-sess", "--cwd", PROJECT, "--name", "codex@nickname"], { env });
  await claude.call("send", { to: "codex@nickname", body: "via link" });
  const linkedOut = hook("codex", { hook_event_name: "UserPromptSubmit", session_id: "linked-sess", cwd: PROJECT, transcript_path: "x" });
  assert.match(linkedOut.hookSpecificOutput.additionalContext, /via link/);

  // Threads keep both directions.
  const thread = (await claude.call("send", { to: "codex", body: "t1" })).sent.thread;
  assert.match(await claude.call("thread", { thread }), /t1/);

  console.log("smoke test passed");
} finally {
  // Children hold PROJECT as cwd; Windows won't delete it until they exit.
  await Promise.all([claude.p, codex.p].map((p) => new Promise((r) => (p.once("exit", r), p.kill()))));
  fs.rmSync(HOME, { recursive: true, force: true, maxRetries: 5 });
}
