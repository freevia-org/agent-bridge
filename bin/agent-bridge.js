#!/usr/bin/env node
import * as store from "../src/store.js";

const USAGE = `agent-bridge: let Claude Code and Codex sessions message each other.

  agent-bridge install [--claude-only|--codex-only] [--dry-run]   register MCP server + hooks
  agent-bridge uninstall [--dry-run]                              remove them again
  agent-bridge doctor                                             check setup step by step, print what is left to do
  agent-bridge status                                             machine-readable install state + known agents
  agent-bridge agents                                             list known agent sessions
  agent-bridge send --to <name|kind> [--from you] <text...>       send a message (from "user" by default)
  agent-bridge inbox --as <name> [--peek]                         read a mailbox
  agent-bridge thread <thread-id>                                 show a thread
  agent-bridge link --codex-thread <id> [--name codex@x]          make an existing Codex thread reachable without opening it
  agent-bridge watch --as <name>                                  print one line per new message (for Claude's Monitor tool)

  (internal) agent-bridge mcp --kind claude|codex [--name n]       stdio MCP server
  (internal) agent-bridge hook --kind claude|codex                 hook handler
  (internal) agent-bridge wake-check --name n --nudged iso        fall back to codex exec resume if a nudge went unanswered

Data lives in $AGENT_BRIDGE_HOME (default ~/.agent-bridge).`;

function parse(argv) {
  const flags = {};
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--") && !["dry-run", "peek", "claude-only", "codex-only", "json"].includes(key)) {
        flags[key] = next;
        i++;
      } else flags[key] = true;
    } else rest.push(a);
  }
  return { flags, rest };
}

const [cmd, ...args] = process.argv.slice(2);
const { flags, rest } = parse(args);
const kind = flags.kind && String(flags.kind).toLowerCase();
const needKind = () => {
  if (!store.KINDS.includes(kind)) throw new Error(`--kind must be one of ${store.KINDS.join(", ")}`);
};

try {
  switch (cmd) {
    case "mcp": {
      needKind();
      const { runMcpServer } = await import("../src/mcp.js");
      runMcpServer({ kind, name: flags.name || process.env.AGENT_BRIDGE_NAME });
      break;
    }
    case "link": {
      const { linkCodexThread } = await import("../src/wake.js");
      if (!flags["codex-thread"]) throw new Error("usage: agent-bridge link --codex-thread <id> [--cwd dir] [--name codex@x]");
      const s = linkCodexThread(flags["codex-thread"], { cwd: flags.cwd, name: flags.name });
      console.log(`linked ${s.name} -> Codex thread ${s.sessionId} (${s.cwd})`);
      break;
    }
    case "wake-check": {
      const { wakeCheck } = await import("../src/wake.js");
      await wakeCheck({ name: flags.name, nudgedAt: flags.nudged, from: flags.from || "another agent" });
      break;
    }
    case "hook": {
      needKind();
      const { runHook } = await import("../src/hook.js");
      await runHook({ kind });
      break;
    }
    case "install":
    case "uninstall": {
      const inst = await import("../src/install.js");
      const log =
        cmd === "install"
          ? inst.install({ claude: !flags["codex-only"], codex: !flags["claude-only"], dryRun: !!flags["dry-run"] })
          : inst.uninstall({ dryRun: !!flags["dry-run"] });
      console.log(log.join("\n"));
      if (cmd === "install" && !flags["dry-run"]) console.log(`\nSetup check:\n${inst.formatDoctor(inst.doctor())}`);
      break;
    }
    case "doctor": {
      const inst = await import("../src/install.js");
      const checks = inst.doctor();
      console.log(inst.formatDoctor(checks));
      process.exit(checks.every((c) => c.ok) ? 0 : 1);
    }
    case "status": {
      const { status } = await import("../src/install.js");
      console.log(JSON.stringify({ home: store.home(), ...status(), agents: store.listAgents() }, null, 2));
      break;
    }
    case "agents":
      for (const a of store.listAgents())
        console.log(`${a.online ? "online " : "offline"}  ${a.name.padEnd(30)} unread ${a.unread}  ${a.cwd || ""}`);
      break;
    case "send": {
      const body = rest.join(" ") || (await stdinText());
      const msg = store.send({ from: flags.from || "user", to: flags.to, body, thread: flags.thread });
      const { wakeIfIdle } = await import("../src/wake.js");
      const woke = wakeIfIdle(msg.to, msg.from);
      console.log(`sent ${msg.id} to ${msg.to} (thread ${msg.thread})${woke ? ", nudged idle session" : ""}`);
      break;
    }
    case "inbox": {
      const name = store.sanitizeName(flags.as || "user");
      const msgs = flags.peek ? store.peekUnread([name]) : store.takeUnread([name]);
      console.log(msgs.length ? store.formatMessages(msgs) : "(no unread messages)");
      break;
    }
    case "thread":
      console.log(store.formatMessages(store.readThread(rest[0])) || "(empty thread)");
      break;
    case "watch": {
      const name = store.sanitizeName(flags.as || (kind ? store.defaultName(kind) : "user"));
      console.log(`watching mailbox ${name}`);
      for (;;) {
        for (const m of await store.waitForMessages([name], { timeoutMs: 60_000 })) {
          const body = m.body.replace(/\s+/g, " ").slice(0, 1500);
          console.log(`agent-bridge message ${m.id} from ${m.from} (thread ${m.thread}): ${body}`);
        }
      }
    }
    default:
      console.log(USAGE);
      process.exit(cmd && cmd !== "help" && cmd !== "--help" ? 1 : 0);
  }
} catch (e) {
  console.error(`agent-bridge: ${e.message}`);
  process.exit(1);
}

function stdinText() {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve("");
    let d = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => (d += c));
    process.stdin.on("end", () => resolve(d));
  });
}
