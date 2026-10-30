// Session titles, used for the session part of bridge names.
//   Claude: the transcript records the title the app shows as
//           {"type":"custom-title","customTitle":...}; {"aiTitle":...} is the
//           auto-generated fallback. Both repeat, so the file's tail is enough.
//   Codex:  ~/.codex/session_index.jsonl maps thread ids to thread_name; the
//           last line for an id is the current name.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TAIL_BYTES = 1024 * 1024;

export function readTail(file, bytes = TAIL_BYTES) {
  let fd;
  try {
    fd = fs.openSync(file, "r");
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, bytes);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    return buf.toString("utf8");
  } catch {
    return "";
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

const lastMatch = (text, re) => {
  let m, last = null;
  while ((m = re.exec(text))) last = m[1];
  return last;
};

export function claudeTitle(transcript) {
  if (!transcript) return null;
  const tail = readTail(transcript);
  const raw = lastMatch(tail, /"customTitle":"((?:[^"\\]|\\.)*)"/g) || lastMatch(tail, /"aiTitle":"((?:[^"\\]|\\.)*)"/g);
  try { return raw ? JSON.parse(`"${raw}"`) : null; } catch { return raw; }
}

export function codexTitle(threadId) {
  if (!threadId) return null;
  const index = path.join(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"), "session_index.jsonl");
  let lines;
  try { lines = fs.readFileSync(index, "utf8").trimEnd().split("\n"); } catch { return null; }
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].includes(threadId)) continue;
    try {
      const e = JSON.parse(lines[i]);
      if (e.id === threadId && e.thread_name) return e.thread_name;
    } catch {}
  }
  return null;
}

export const sessionTitle = (kind, { sessionId, transcript }) => (kind === "codex" ? codexTitle(sessionId) : claudeTitle(transcript));
