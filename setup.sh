#!/bin/sh
# One-command setup for macOS and Linux. On a new machine, paste this into a terminal:
#
#   d="$HOME/.agent-bridge/app"; [ -d "$d" ] || git clone https://github.com/freevia-org/agent-bridge.git "$d"; sh "$d/setup.sh"
#
# Re-running it later updates and re-checks everything.
set -e
cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  if command -v brew >/dev/null 2>&1; then
    echo "Installing Node.js with Homebrew..."
    brew install node
  else
    echo "agent-bridge needs Node.js 18+. Install it (https://nodejs.org or your package manager) and run this again." >&2
    exit 1
  fi
fi

exec node bin/agent-bridge.js setup "$@"
