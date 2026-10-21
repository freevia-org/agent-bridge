# agent-bridge

Lets Claude Code and Codex sessions on the same machine message each other
the way sessions of one tool message their siblings: send, reply, wait for an
answer, and receive mail without polling.

Zero dependencies. Needs Node 18+. Works on Windows, macOS and Linux.

## Install (once per machine)

```bash
git clone https://github.com/tony-xmelon/agent-bridge.git ~/agent-bridge
node ~/agent-bridge/bin/agent-bridge.js install
```

`install` ends with a setup check that lists what's left. Run it again at any
time:

```bash
node ~/agent-bridge/bin/agent-bridge.js doctor
```

The one manual step is in Codex. Open **Settings → Hooks** and trust the three
hooks titled `agent-bridge: …`. Codex never runs hooks nobody has reviewed, and
any change to them (for example a reinstall from a different folder) needs a new
approval. The installer deliberately doesn't approve them for you. Start a new
Claude Code session to get the MCP tools; hooks apply to open sessions straight
away.

`install` is idempotent and backs up every file before editing it
(`*.agent-bridge-backup`):

| File | What gets added |
|---|---|
| `~/.claude.json` | user-scope MCP server `agent-bridge` |
| `~/.claude/settings.json` | SessionStart / UserPromptSubmit / Stop hooks, `mcp__agent-bridge` allow rule |
| `~/.codex/config.toml` | `[mcp_servers.agent-bridge]` (900 s tool timeout for long waits) |
| `~/.codex/hooks.json` | the same three hooks |

The installer writes absolute paths. If you move the folder, run `install` again.
`agent-bridge uninstall` removes everything it added. `--claude-only` and
`--codex-only` limit the install to one side.

## How it works

```
 Claude session ──MCP──┐                         ┌──MCP── Codex session
   hooks ──────────────┼──> ~/.agent-bridge/ <───┼──────────── hooks
                       │   messages/ mail/ presence/ sessions/
```

* **Identity.** Each session is `<kind>@<project-folder>`, e.g. `claude@h90` or
  `codex@h90`. To reach the best live session of a kind, address it by kind
  alone (`codex`). `set_name` renames a session when several share a folder.
* **Tools** (both sides): `send`, `reply`, `wait`, `inbox`, `thread`, `agents`,
  `whoami`, `set_name`. `send`/`reply` take `wait_for_reply_seconds` for
  request/response exchanges.
* **Push delivery.** Hooks hand unread mail to the agent:
  * **SessionStart:** tells the agent its name, who is online, and any waiting mail.
  * **UserPromptSubmit:** attaches mail to your next prompt.
  * **Stop:** if mail arrived during a turn, the agent continues and handles it.
* **Waking idle sessions.**
  * **Codex:** the bridge runs `codex queue` to start a turn in the recipient's idle session.
  * **Claude Code:** nothing outside can start a turn, so a Claude session runs
    `agent-bridge watch --as <name>` under its Monitor tool. Its SessionStart
    context explains how.
* **Codex specifics.**
  * Codex runs one MCP server for all its threads, so each tool call is matched
    to its thread through the `threadId` Codex sends with it.
  * After each turn, Codex runs a throwaway fork of the thread (no transcript).
    The hooks ignore these forks, so they never receive mail.
* **Safety.** Peer messages are presented as coming from another agent, not the
  user. After 25 automatic turns without the user speaking, automatic delivery
  pauses until the user speaks again, so two agents can't ping-pong forever.

## CLI

```bash
agent-bridge status                         # install state + known agents
agent-bridge agents                         # who is online, unread counts
agent-bridge send --to codex "hello"        # message an agent as "user"
agent-bridge inbox --as user                # read replies sent to you
agent-bridge thread <thread-id>
```

Data lives in `~/.agent-bridge` (override with `AGENT_BRIDGE_HOME`). Messages
are kept for 30 days. Hook activity is logged to `~/.agent-bridge/hook.log`.

## Test

```bash
npm test
```
