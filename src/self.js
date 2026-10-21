// How to run this tool again (for hooks, MCP config and background helpers).
// It ships two ways: as source (`node bin/agent-bridge.js`) and as one
// standalone executable built with Node's single-executable support, where
// process.execPath is agent-bridge(.exe) itself.

import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const IS_EXE = !/^node(\.exe)?$/i.test(path.basename(process.execPath));

// The source checkout (null for the executable).
export const ROOT = IS_EXE ? null : path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// argv prefix that runs this tool: [exe] or [node, bin/agent-bridge.js].
export const SELF = IS_EXE ? [process.execPath] : [process.execPath, path.join(ROOT, "bin", "agent-bridge.js")];

// Where the executable installs itself, so hooks keep working after the
// downloaded file is moved or deleted.
export const EXE_HOME = path.join(os.homedir(), ".agent-bridge", "bin", process.platform === "win32" ? "agent-bridge.exe" : "agent-bridge");
