// Registers agent-bridge with Claude Code and Codex for the current user, and
// checks the result (`doctor`). Idempotent: re-running replaces earlier
// agent-bridge entries, and `uninstall` removes exactly what `install` added.
// Every file it edits is backed up next to itself first (*.agent-bridge-backup).
//
// Codex only runs hooks a person has reviewed in Settings > Hooks. The
// installer deliberately does not write that approval itself; doctor checks
// it and says what to do.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";
import * as store from "./store.js";
import { findCodex } from "./wake.js";

const SERVER = "agent-bridge";
// Recognises our hook commands, including ones written by older versions
// whose script path was shortened to "AGENT-~1.JS".
const isOurHook = (h) => /agent-bridge|agent-~\d|\shook --kind (claude|codex)\s*$/i.test(String(h?.command || ""));
// Shown as the hook's title in Codex Settings > Hooks (instead of "Hook 1").
const HOOKS = {
  SessionStart: { snake: "session_start", title: "agent-bridge: introduce this session to other agents and deliver waiting messages" },
  UserPromptSubmit: { snake: "user_prompt_submit", title: "agent-bridge: attach messages from other agents to your prompt" },
  Stop: { snake: "stop", title: "agent-bridge: deliver messages that arrived during the turn" },
};
const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "bin", "agent-bridge.js");

const claudeJson = () => path.join(os.homedir(), ".claude.json");
const claudeSettings = () => path.join(os.homedir(), ".claude", "settings.json");
const codexHome = () => process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
const codexConfig = () => path.join(codexHome(), "config.toml");
const codexHooks = () => path.join(codexHome(), "hooks.json");
const installRecord = () => path.join(store.home(), "install.json");

// Hook commands run under different shells (Codex uses PowerShell on Windows,
// Claude Code uses Git Bash), and a quoted exe path means different things in
// each. On Windows we therefore emit 8.3 short paths with forward slashes and
// no quotes, which cmd, PowerShell and bash all execute the same way.
// Only the folder part is shortened: the file name must stay as it is, since
// Node rejects "AGENT-~1.JS" and the name is how we recognise our own hooks.
function shellPath(p) {
  if (process.platform !== "win32") return /[\s'"$`\\]/.test(p) ? `'${p.replace(/'/g, `'\\''`)}'` : p;
  let folder = path.dirname(p);
  if (/\s/.test(folder)) {
    try {
      folder = execSync(`for %I in ("${folder}") do @echo %~sI`, { shell: "cmd.exe", encoding: "utf8" }).trim();
    } catch {}
  }
  const out = path.join(folder, path.basename(p)).replace(/\\/g, "/");
  return /\s/.test(out) ? `"${out}"` : out;
}
export const hookCommand = (kind) => `${shellPath(process.execPath)} ${shellPath(CLI)} hook --kind ${kind}`;

export function install({ claude = true, codex = true, dryRun = false } = {}) {
  const log = [];
  const oldCodexHooks = readJson(codexHooks());
  if (claude) {
    editJson(claudeJson(), dryRun, log, (cfg) => {
      cfg.mcpServers ??= {};
      cfg.mcpServers[SERVER] = { type: "stdio", command: process.execPath, args: [CLI, "mcp", "--kind", "claude"], env: {} };
    });
    editJson(claudeSettings(), dryRun, log, (cfg) => {
      setHooks(cfg, "claude");
      cfg.permissions ??= {};
      cfg.permissions.allow ??= [];
      if (!cfg.permissions.allow.includes(`mcp__${SERVER}`)) cfg.permissions.allow.push(`mcp__${SERVER}`);
    });
  }
  if (codex) {
    editText(codexConfig(), dryRun, log, (toml) => {
      const block = [
        `[mcp_servers.${SERVER}]`,
        `command = ${tomlStr(process.execPath)}`,
        `args = [${[CLI, "mcp", "--kind", "codex"].map(tomlStr).join(", ")}]`,
        `startup_timeout_sec = 20.0`,
        `tool_timeout_sec = 900.0`,
        `default_tools_approval_mode = "approve"`,
        ``,
      ].join("\n");
      return upsertTomlTable(toml, block);
    });
    editJson(codexHooks(), dryRun, log, (cfg) => setHooks(cfg, "codex"));
  }
  // doctor's "hooks have run since install" counts from the last time the hook
  // config actually changed, so a no-op reinstall doesn't reset it.
  const hooksChanged = log.some((l) => l.startsWith("edited") && /hooks\.json|settings\.json/.test(l));
  if (!dryRun && (hooksChanged || !fs.existsSync(installRecord()))) {
    fs.mkdirSync(store.home(), { recursive: true });
    // Changing hooks.json leaves Codex's old trusted_hash entries in place but
    // void. Remember them, so only a fresh approval counts (codexApproval).
    // Codex approves each hook separately, so snapshot only the hooks whose
    // definition actually changed.
    const toml = readText(codexConfig());
    const trustAtInstall = { ...(readJson(installRecord())?.trustAtInstall || {}) };
    for (const k of codexTrustKeys(readJson(codexHooks()))) {
      if (canonical(handlerAt(oldCodexHooks, k.key)) !== canonical(handlerAt(readJson(codexHooks()), k.key))) trustAtInstall[k.key] = trustedHash(toml, k.key);
    }
    fs.writeFileSync(installRecord(), JSON.stringify({ installedAt: new Date().toISOString(), cli: CLI, node: process.execPath, trustAtInstall }, null, 2));
  }
  return log;
}

export function uninstall({ dryRun = false } = {}) {
  const log = [];
  editJson(claudeJson(), dryRun, log, (cfg) => {
    if (cfg.mcpServers) delete cfg.mcpServers[SERVER];
  }, { skipMissing: true });
  editJson(claudeSettings(), dryRun, log, (cfg) => {
    clearHooks(cfg);
    if (cfg.permissions?.allow) cfg.permissions.allow = cfg.permissions.allow.filter((p) => p !== `mcp__${SERVER}`);
  }, { skipMissing: true });
  editText(codexConfig(), dryRun, log, (toml) => removeTomlTable(toml).trimEnd() + "\n", { skipMissing: true });
  editJson(codexHooks(), dryRun, log, clearHooks, { skipMissing: true });
  return log;
}

// ---------------------------------------------------------------- doctor

// Returns [{ ok, label, fix? }] covering every step needed for both sides,
// in the order a person would do them.
export function doctor() {
  const checks = [];
  const add = (ok, label, fix) => checks.push({ ok: !!ok, label, fix: ok ? undefined : fix });
  // Progress worth showing that needs no action, e.g. hooks not run *yet*.
  const info = (label) => checks.push({ ok: true, info: true, label });
  const read = (f) => { try { return fs.readFileSync(f, "utf8"); } catch { return ""; } };
  const json = (f) => { try { return JSON.parse(read(f)); } catch { return null; } };
  const rec = json(installRecord());
  const reinstall = `node "${CLI}" install`;
  const since = rec ? Date.parse(rec.installedAt) : 0;
  const lastHook = (kind) => lastHookRun(kind, since);

  add(Number(process.versions.node.split(".")[0]) >= 18, `Node ${process.versions.node} (18+ required)`, "Install Node 18 or newer.");

  // Claude Code
  const cMcp = json(claudeJson())?.mcpServers?.[SERVER];
  add(cMcp?.args?.[0] === CLI, "Claude Code: MCP server registered", reinstall);
  add(hooksCurrent(json(claudeSettings()), "claude"), "Claude Code: hooks installed and current", reinstall);
  const cRun = lastHook("claude");
  info(`Claude Code: hooks have run since install${cRun ? ` (last ${cRun})` : ": not yet (they run on the next Claude prompt)"}`);

  // Codex
  const toml = read(codexConfig());
  add(toml.includes(`[mcp_servers.${SERVER}]`) && toml.includes(CLI), "Codex: MCP server registered", reinstall);
  add(hooksCurrent(json(codexHooks()), "codex"), "Codex: hooks installed and current", reinstall);
  const { missing } = codexApproval();
  add(!missing.length, `Codex: hooks approved${missing.length ? ` (missing: ${missing.join(", ")})` : ""}`,
    `In the Codex app, click "Trust" when it asks you to review hooks, or open Settings > Hooks and trust the three "agent-bridge: ..." hooks.`);
  const xRun = lastHook("codex");
  info(`Codex: hooks have run since install${xRun ? ` (last ${xRun})` : ": not yet (they run on the next Codex prompt)"}`);
  add(findCodex(), "Codex: CLI found (used to wake idle Codex sessions)",
    "Set AGENT_BRIDGE_CODEX to the full path of the codex executable.");

  return checks;
}

// Which of our Codex hooks lack a current approval: a trusted_hash that is
// present and differs from the (void) one recorded when the hooks last changed.
export function codexApproval() {
  const toml = readText(codexConfig());
  const before = readJson(installRecord())?.trustAtInstall || {};
  const missing = codexTrustKeys(readJson(codexHooks()))
    .filter((k) => {
      const h = trustedHash(toml, k.key);
      return !h || h === before[k.key];
    })
    .map((k) => k.event);
  return { missing };
}

export function formatDoctor(checks) {
  const lines = checks.map((c) => `${c.info ? "  .. " : c.ok ? "  ok " : "  -- "} ${c.label}`);
  const todo = checks.filter((c) => !c.ok);
  if (!todo.length) return `${lines.join("\n")}\n\nAll set. Claude Code and Codex sessions can now message each other.`;
  const steps = [...new Set(todo.map((c) => c.fix))].map((f, i) => `  ${i + 1}. ${f}`);
  return `${lines.join("\n")}\n\nNext steps:\n${steps.join("\n")}\n\nRun \`agent-bridge doctor\` again afterwards to confirm.`;
}

export function status() {
  return { cli: CLI, node: process.execPath, checks: doctor() };
}

// Codex keys hook approval by "<hooks.json path>:<event>:<group index>:<handler index>".
function codexTrustKeys(cfg) {
  const keys = [];
  for (const [ev, { snake }] of Object.entries(HOOKS)) {
    (cfg?.hooks?.[ev] || []).forEach((g, gi) =>
      (g.hooks || []).forEach((h, hi) => {
        if (isOurHook(h)) keys.push({ event: ev, key: `${codexHooks()}:${snake}:${gi}:${hi}` });
      })
    );
  }
  return keys;
}

// The hook handler a Codex trust key ("<file>:<event>:<group>:<handler>") points at.
function handlerAt(cfg, key) {
  const [gi, hi] = key.split(":").slice(-2).map(Number);
  const snake = key.split(":").slice(-3)[0];
  const ev = Object.keys(HOOKS).find((e) => HOOKS[e].snake === snake);
  return cfg?.hooks?.[ev]?.[gi]?.hooks?.[hi] ?? null;
}

function trustedHash(toml, key) {
  const header = new RegExp(`^\\[hooks\\.state\\.(?:'${escapeRe(key)}'|"${escapeRe(key.replace(/\\/g, "\\\\"))}")\\]\\s*$`, "m");
  const m = header.exec(toml);
  if (!m) return null;
  const body = toml.slice(m.index + m[0].length).split(/^\[/m)[0];
  return body.match(/^\s*trusted_hash\s*=\s*["']([^"']+)["']/m)?.[1] || null;
}

const readText = (f) => { try { return fs.readFileSync(f, "utf8"); } catch { return ""; } };
const readJson = (f) => { try { return JSON.parse(readText(f)); } catch { return null; } };

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function hooksCurrent(cfg, kind) {
  return Object.entries(HOOKS).every(([ev, { title }]) =>
    (cfg?.hooks?.[ev] || []).some((g) => (g.hooks || []).some((h) => h.command === hookCommand(kind) && h.statusMessage === title))
  );
}

function lastHookRun(kind, since) {
  const lines = (() => { try { return fs.readFileSync(path.join(store.home(), "hook.log"), "utf8").trim().split("\n"); } catch { return []; } })();
  for (let i = lines.length - 1; i >= 0; i--) {
    const [ts, k] = lines[i].split(" ");
    if (k === kind && !lines[i].includes("session=?") && !lines[i].includes("session=setup-check")) return Date.parse(ts) >= since ? ts : null;
  }
  return null;
}

function setHooks(cfg, kind) {
  clearHooks(cfg);
  cfg.hooks ??= {};
  for (const [ev, { title }] of Object.entries(HOOKS)) {
    cfg.hooks[ev] ??= [];
    cfg.hooks[ev].push({ hooks: [{ type: "command", command: hookCommand(kind), timeout: 10, statusMessage: title }] });
  }
}

function clearHooks(cfg) {
  if (!cfg.hooks) return;
  for (const ev of Object.keys(cfg.hooks)) {
    if (!Array.isArray(cfg.hooks[ev])) continue;
    cfg.hooks[ev] = cfg.hooks[ev]
      .map((g) => ({ ...g, hooks: (g.hooks || []).filter((h) => !isOurHook(h)) }))
      .filter((g) => g.hooks.length);
    if (!cfg.hooks[ev].length) delete cfg.hooks[ev];
  }
  if (!Object.keys(cfg.hooks).length) delete cfg.hooks;
}

// Removes [mcp_servers.agent-bridge] and its sub-tables up to the next table.
function removeTomlTable(toml) {
  const out = [];
  let skipping = false;
  for (const line of toml.split(/\r?\n/)) {
    const header = line.match(/^\s*\[([^\]]+)\]\s*$/);
    if (header) skipping = header[1] === `mcp_servers.${SERVER}` || header[1].startsWith(`mcp_servers.${SERVER}.`);
    if (!skipping) out.push(line);
  }
  return out.join("\n");
}

// Puts our table where it already is (so a re-run changes nothing), or at the end.
function upsertTomlTable(toml, block) {
  const lines = toml.split(/\r?\n/);
  const isOurs = (h) => h === `mcp_servers.${SERVER}` || h.startsWith(`mcp_servers.${SERVER}.`);
  const start = lines.findIndex((l) => isOurs(l.match(/^\s*\[([^\]]+)\]\s*$/)?.[1] || ""));
  if (start < 0) return `${toml.trimEnd()}\n\n${block}`;
  let end = start + 1;
  while (end < lines.length && !(/^\s*\[([^\]]+)\]\s*$/.test(lines[end]) && !isOurs(lines[end].match(/^\s*\[([^\]]+)\]/)[1]))) end++;
  // Our old table's trailing blank lines are replaced by exactly one; nothing
  // outside our table is touched.
  while (end > start + 1 && lines[end - 1].trim() === "") end--;
  const after = lines.slice(end);
  while (after.length && after[0].trim() === "") after.shift();
  return [...lines.slice(0, start), ...block.trimEnd().split("\n"), ...(after.length ? ["", ...after] : [""])].join("\n");
}

// TOML literal string (no escapes), falling back to a basic string.
const tomlStr = (s) => (s.includes("'") ? JSON.stringify(s) : `'${s}'`);

// JSON with object keys sorted (arrays keep their order).
const canonical = (v) =>
  JSON.stringify(v, (k, x) => (x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map((key) => [key, x[key]])) : x));

function backup(file) {
  if (fs.existsSync(file)) fs.copyFileSync(file, `${file}.agent-bridge-backup`);
}

function editJson(file, dryRun, log, mutate, { skipMissing = false } = {}) {
  const exists = fs.existsSync(file);
  if (!exists && skipMissing) return;
  const before = exists ? fs.readFileSync(file, "utf8") : "{}";
  const cfg = JSON.parse(before || "{}");
  const original = canonical(cfg);
  mutate(cfg);
  // Compare content, not text: don't rewrite a file (e.g. ~/.claude.json) just
  // because its formatting or key order differs.
  if (exists && canonical(cfg) === original) return log.push(`unchanged  ${file}`);
  const after = JSON.stringify(cfg, null, 2) + "\n";
  log.push(`${dryRun ? "would edit" : "edited"}  ${file}`);
  if (dryRun) return;
  backup(file);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, after);
}

function editText(file, dryRun, log, mutate, { skipMissing = false } = {}) {
  const exists = fs.existsSync(file);
  if (!exists && skipMissing) return;
  const before = exists ? fs.readFileSync(file, "utf8") : "";
  const after = mutate(before);
  if (after === before) return log.push(`unchanged  ${file}`);
  log.push(`${dryRun ? "would edit" : "edited"}  ${file}`);
  if (dryRun) return;
  backup(file);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, after);
}
