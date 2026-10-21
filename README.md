# agent-bridge

Lets Claude Code and Codex sessions on the same machine message each other
the way sessions of one tool message their siblings: send, reply, wait for an
answer, and receive mail without polling.

Zero dependencies. Needs Node 18+. Works on Windows, macOS and Linux.

## Setup

### Easiest: download one file

Download the file for your machine from the
[latest release](https://github.com/freevia-org/agent-bridge/releases/latest):

| Machine | File |
|---|---|
| Windows | `agent-bridge-windows-x64.exe` |
| Mac (Apple Silicon) | `agent-bridge-macos-arm64` |
| Mac (Intel) | `agent-bridge-macos-x64` |
| Linux | `agent-bridge-linux-x64` |

No GitHub account is needed. The same commands also update an existing install.

**Windows:** double-click the downloaded file, or paste this into PowerShell:

```powershell
$f="$HOME\Downloads\agent-bridge-windows-x64.exe"; curl.exe -fL https://github.com/freevia-org/agent-bridge/releases/latest/download/agent-bridge-windows-x64.exe -o $f; & $f
```

**Mac / Linux:** paste this into Terminal. It picks the right file for Apple
Silicon, Intel or Linux, and avoids Gatekeeper prompts because Terminal
downloads aren't quarantined:

```bash
f="agent-bridge-$([ "$(uname)" = Darwin ] && echo macos || echo linux)-$(uname -m | sed 's/x86_64/x64/;s/aarch64/arm64/')"; curl -fL "https://github.com/freevia-org/agent-bridge/releases/latest/download/$f" -o /tmp/agent-bridge && chmod +x /tmp/agent-bridge && /tmp/agent-bridge
```

It has Node built in, so it needs nothing else installed. It copies itself to
`~/.agent-bridge/bin`, sets everything up, and waits while you click **Trust**
in Codex. Afterwards you can delete the downloaded file. To update, download the
new release and run it the same way; that also works while Codex and Claude are
using the old version.

The files are unsigned:
- **Windows:** SmartScreen may say "Windows protected your PC". Click
  **More info → Run anyway**.
- **Mac:** if you downloaded the file with a browser instead, remove the
  quarantine flag first: `xattr -d com.apple.quarantine agent-bridge-macos-*`.
  The Terminal command above doesn't need this.

### Alternative: from the source (needs Git)

**Windows** (PowerShell):

```powershell
$d="$HOME\.agent-bridge\app"; if (!(Test-Path $d)) { git clone https://github.com/freevia-org/agent-bridge.git $d }; powershell -ExecutionPolicy Bypass -File "$d\setup.ps1"
```

**macOS / Linux**:

```bash
d="$HOME/.agent-bridge/app"; [ -d "$d" ] || git clone https://github.com/freevia-org/agent-bridge.git "$d"; sh "$d/setup.sh"
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

## Test and build

```bash
npm test                 # smoke test + setup end-to-end test (throwaway home), against the source
npm install && npm run build:exe   # standalone executable for this platform, in dist/
AGENT_BRIDGE_EXE=dist/agent-bridge-<os>-<arch> npm test   # same tests against the executable
```

Building needs an official Node.js 20+ build (24 matches CI). Homebrew's
`node` has single-executable support disabled, so on a Mac use the nodejs.org
download instead.

Releases: push a tag like `v0.2.0`. The `release` workflow builds and tests the
executable on Windows, macOS (arm64 and x64) and Linux, then attaches them to
the GitHub release.
