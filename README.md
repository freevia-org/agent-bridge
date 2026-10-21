# agent-bridge

Lets Claude Code and Codex sessions on the same machine message each other
the way sessions of one tool message their siblings: send, reply, wait for an
answer, and receive mail without polling.

Zero dependencies. Needs Node 18+. Works on Windows, macOS and Linux.

## Setup (one command per machine)

**Windows** (PowerShell):

```powershell
$d="$HOME\.agent-bridge\app"; if (!(Test-Path $d)) { git clone https://github.com/tony-xmelon/agent-bridge.git $d }; powershell -ExecutionPolicy Bypass -File "$d\setup.ps1"
```

**macOS / Linux**:

```bash
d="$HOME/.agent-bridge/app"; [ -d "$d" ] || git clone https://github.com/tony-xmelon/agent-bridge.git "$d"; sh "$d/setup.sh"
```

The command needs Git and access to this repo. Setup does the rest:

1. Installs Node.js if it's missing (winget or Homebrew).
2. Updates the checkout (`git pull`).
3. Registers the MCP server and hooks with Claude Code and Codex.
4. Registers your recent Codex app threads, so they can be messaged right away.
5. Runs the hook commands in the shells the apps use, to prove they work.
6. Waits for the one click only you can do: in the Codex app, click **Trust**
   when it asks you to review hooks, or approve the three `agent-bridge: …`
   hooks in **Settings → Hooks**. Codex never runs hooks nobody has reviewed,
   so setup deliberately doesn't approve them for you.
7. Prints a final check.

Run the same command again to update. If nothing changed, it changes nothing,
and your Codex approval stays valid. New Claude Code sessions get the MCP tools;
already-open sessions only get the hooks. `agent-bridge doctor` re-runs the
final check at any time.

Setup is idempotent and backs up every file before editing it
(`*.agent-bridge-backup`):

| File | What gets added |
|---|---|
| `~/.claude.json` | user-scope MCP server `agent-bridge` |
| `~/.claude/settings.json` | SessionStart / UserPromptSubmit / Stop hooks, `mcp__agent-bridge` allow rule |
| `~/.codex/config.toml` | `[mcp_servers.agent-bridge]` (900 s tool timeout for long waits) |
| `~/.codex/hooks.json` | the same three hooks |

The installer writes absolute paths. If you move the folder, run setup again.
`agent-bridge link --codex-thread <id> [--name codex@x]` registers any other
existing Codex thread.
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
  * **Codex:** the bridge queues a nudge with `codex queue`. That runs live in
    the desktop app only when the app has the thread loaded. If the mail is
    still unread 15 s later, the thread isn't loaded, so the bridge runs the turn
    headlessly with `codex exec resume <thread>`. The result lands in the same
    thread. Either way, no one has to open anything. See `~/.agent-bridge/wake.log`.
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
