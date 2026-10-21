// Builds the standalone executable for the current platform with Node's
// single-executable-application support:
//   1. bundle bin/agent-bridge.js and src/ into one CommonJS file (esbuild)
//   2. turn it into a SEA blob (node --experimental-sea-config)
//   3. copy the running node binary and inject the blob (postject)
// Output: dist/agent-bridge-<os>-<arch>[.exe]. Needs `npm install` first
// (esbuild and postject are dev-only; the tool itself has no dependencies).

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIST = path.join(ROOT, "dist");
const os = { win32: "windows", darwin: "macos", linux: "linux" }[process.platform] || process.platform;
const exe = path.join(DIST, `agent-bridge-${os}-${process.arch}${process.platform === "win32" ? ".exe" : ""}`);
const run = (cmd, args) => execFileSync(cmd, args, { stdio: "inherit", cwd: ROOT });

fs.rmSync(DIST, { recursive: true, force: true });
fs.mkdirSync(DIST);

await build({
  entryPoints: [path.join(ROOT, "bin", "agent-bridge.js")],
  outfile: path.join(DIST, "agent-bridge.cjs"),
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  // src/self.js reads import.meta.url only when not running as the executable.
  define: { "import.meta.url": "__agent_bridge_url" },
  banner: { js: 'var __agent_bridge_url = require("url").pathToFileURL(__filename).href;' },
  logLevel: "warning",
});

fs.writeFileSync(
  path.join(DIST, "sea-config.json"),
  JSON.stringify({ main: path.join(DIST, "agent-bridge.cjs"), output: path.join(DIST, "sea-prep.blob"), disableExperimentalSEAWarning: true })
);
run(process.execPath, ["--experimental-sea-config", path.join(DIST, "sea-config.json")]);

fs.copyFileSync(process.execPath, exe);
if (process.platform === "darwin") run("codesign", ["--remove-signature", exe]);
run(process.execPath, [
  path.join(ROOT, "node_modules", "postject", "dist", "cli.js"),
  exe,
  "NODE_SEA_BLOB",
  path.join(DIST, "sea-prep.blob"),
  "--sentinel-fuse",
  "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2",
  ...(process.platform === "darwin" ? ["--macho-segment-name", "NODE_SEA"] : []),
]);
if (process.platform === "darwin") run("codesign", ["--sign", "-", exe]);
if (process.platform !== "win32") fs.chmodSync(exe, 0o755);

for (const f of ["agent-bridge.cjs", "sea-config.json", "sea-prep.blob"]) fs.rmSync(path.join(DIST, f));
console.log(`built ${path.relative(ROOT, exe)} (${(fs.statSync(exe).size / 1e6).toFixed(0)} MB)`);
