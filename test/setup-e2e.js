// End-to-end check of `agent-bridge setup` in a throwaway home folder:
// install, thread registration, hook commands under the real shells, the
// approval wait, doctor, re-run idempotency and uninstall. CI runs it on
// Windows, macOS (arm64 + x64) and Linux, against source and executable.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "bin", "agent-bridge.js");
const EXE = process.env.AGENT_BRIDGE_EXE;
// A space in the home path exercises the hook-command quoting.
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "ab home "));
const env = { ...process.env, HOME, USERPROFILE: HOME, AGENT_BRIDGE_CODEX: process.execPath };
for (const k of ["CODEX_HOME", "AGENT_BRIDGE_HOME"]) delete env[k];

// A downloaded copy, like a user would run it, so setup has to install itself.
let SELF = [process.execPath, CLI];
if (EXE) {
  fs.mkdirSync(path.join(HOME, "Downloads"));
  const dl = path.join(HOME, "Downloads", path.basename(EXE));
  fs.copyFileSync(EXE, dl);
  fs.chmodSync(dl, 0o755);
  SELF = [dl];
}
const run = (args, opts = {}) => spawnSync(SELF[0], [...SELF.slice(1), ...args], { env, encoding: "utf8", timeout: 120_000, ...opts });

// A Codex app thread the setup should register.
const project = path.join(HOME, "projects", "demo");
fs.mkdirSync(project, { recursive: true });
const sessions = path.join(HOME, ".codex", "sessions", "2026", "10", "21");
fs.mkdirSync(sessions, { recursive: true });
fs.writeFileSync(
  path.join(sessions, "rollout-2026-10-21T00-00-00-00000000-0000-0000-0000-00000000demo.jsonl"),
  JSON.stringify({ type: "session_meta", payload: { id: "00000000-0000-0000-0000-00000000demo", cwd: project, originator: "Codex Desktop", thread_source: "user" } }) + "\n"
);
fs.writeFileSync(path.join(HOME, ".codex", "config.toml"), 'model = "x"\n\n\n[projects.demo]\ntrust_level = "trusted"\n');

try {
  const first = run(["setup", "--no-wait", "--no-update"]);
  assert.equal(first.status, 0, first.stderr + first.stdout);
  assert.doesNotMatch(first.stdout, /FAILED/, first.stdout);
  assert.match(first.stdout, /codex@demo/, "recent Codex thread registered");
  assert.match(first.stdout, /needs you to approve 3 hook/);
  if (EXE) {
    const installed = path.join(HOME, ".agent-bridge", "bin", process.platform === "win32" ? "agent-bridge.exe" : "agent-bridge");
    assert.ok(fs.existsSync(installed), "executable installed itself");
    SELF = [installed];
  }
  const toml = fs.readFileSync(path.join(HOME, ".codex", "config.toml"), "utf8");
  assert.ok(toml.startsWith('model = "x"\n\n\n[projects.demo]'), "user's config.toml content untouched");
  assert.match(toml, /\[mcp_servers\.agent-bridge\]/);
  const hooks = JSON.parse(fs.readFileSync(path.join(HOME, ".codex", "hooks.json"), "utf8")).hooks;
  assert.deepEqual(Object.keys(hooks).sort(), ["SessionStart", "Stop", "UserPromptSubmit"]);
  assert.equal(run(["doctor"]).status, 1, "doctor fails until the hooks are approved");

  // Simulate clicking Trust in Codex.
  const snake = { SessionStart: "session_start", UserPromptSubmit: "user_prompt_submit", Stop: "stop" };
  let trust = "";
  for (const ev of Object.keys(snake)) trust += `\n[hooks.state.'${path.join(HOME, ".codex", "hooks.json")}:${snake[ev]}:0:0']\ntrusted_hash = "sha256:test-${ev}"\n`;
  fs.appendFileSync(path.join(HOME, ".codex", "config.toml"), trust);
  const doc = run(["doctor"]);
  assert.equal(doc.status, 0, doc.stdout);
  assert.match(doc.stdout, /All set/);

  const again = run(["setup", "--no-wait", "--no-update"]);
  assert.equal((again.stdout.match(/\bunchanged\b/g) || []).length, 4, again.stdout);
  assert.match(again.stdout, /already approved/);

  // An archived thread in a non-Latin folder can be linked and reached by name.
  const cyr = path.join(HOME, "projects", "Термопомпа оферти");
  fs.mkdirSync(cyr, { recursive: true });
  const arch = path.join(HOME, ".codex", "archived_sessions");
  fs.mkdirSync(arch, { recursive: true });
  fs.writeFileSync(
    path.join(arch, "rollout-2026-10-21T00-00-00-00000000-0000-0000-0000-0000000archd.jsonl"),
    JSON.stringify({ type: "session_meta", payload: { id: "00000000-0000-0000-0000-0000000archd", cwd: cyr } }) + "\n"
  );
  const linked = run(["link", "--codex-thread", "00000000-0000-0000-0000-0000000archd"]);
  assert.equal(linked.status, 0, linked.stderr + linked.stdout);
  assert.ok(fs.existsSync(path.join(HOME, ".agent-bridge", "sessions", "codex@термопомпа-оферти.json")), linked.stdout);
  assert.equal(run(["send", "--from", "claude@test", "--to", "codex@термопомпа-оферти", "здравей"]).status, 0);
  const hook = run(["hook", "--kind", "codex"], {
    input: JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: "00000000-0000-0000-0000-0000000archd", cwd: cyr, transcript_path: "x" }),
  });
  assert.match(JSON.parse(hook.stdout).hookSpecificOutput.additionalContext, /здравей/);

  assert.equal(run(["uninstall"]).status, 0);
  for (const f of [".claude.json", ".claude/settings.json", ".codex/config.toml", ".codex/hooks.json"]) {
    assert.doesNotMatch(fs.readFileSync(path.join(HOME, f), "utf8"), /agent-bridge/, `${f} cleaned`);
  }
  console.log(`setup e2e passed (${EXE ? "executable" : "source"}, ${process.platform}-${process.arch})`);
} finally {
  // Best effort: the send above starts a detached wake check that runs from
  // HOME for ~15 s, and Windows won't delete a folder a process is in.
  try { fs.rmSync(HOME, { recursive: true, force: true, maxRetries: 5 }); } catch {}
}
