// Thin wrappers around the read-only/scriptable corners of the `claude` CLI
// that back the Tools panel: MCP servers, plugins, and the machine-wide
// background/interactive agents list. Each function shells out once and
// resolves a plain result object — no long-lived state here.

const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const CLAUDE_BIN = process.env.CLAUDE_LINGUI_BIN || 'claude';

function run(args, opts = {}) {
  return new Promise((resolve) => {
    execFile(CLAUDE_BIN, args, { timeout: 15000, ...opts }, (err, stdout, stderr) => {
      resolve({ err, stdout: stdout || '', stderr: stderr || '' });
    });
  });
}

const mcp = {
  // `claude mcp list` has no --json — surfaced as raw text; still gives
  // users visibility without us guessing at a brittle text-parsing scheme.
  async list() {
    const { err, stdout, stderr } = await run(['mcp', 'list']);
    if (err && !stdout) return { ok: false, error: String(stderr || err.message).trim() };
    return { ok: true, text: stdout.trim() };
  },
  async addJson(name, json, scope) {
    const { err, stdout, stderr } = await run(['mcp', 'add-json', ...(scope ? ['-s', scope] : []), name, json]);
    if (err) return { ok: false, error: String(stderr || stdout || err.message).trim() };
    return { ok: true, text: stdout.trim() };
  },
  async remove(name) {
    const { err, stdout, stderr } = await run(['mcp', 'remove', name]);
    if (err) return { ok: false, error: String(stderr || stdout || err.message).trim() };
    return { ok: true };
  },
};

const plugins = {
  async list() {
    const { err, stdout, stderr } = await run(['plugin', 'list', '--json']);
    if (err && !stdout) return { ok: false, error: String(stderr || err.message).trim() };
    try {
      return { ok: true, data: JSON.parse(stdout) };
    } catch {
      return { ok: false, error: "Couldn't parse `claude plugin list --json` output." };
    }
  },
  async enable(name) {
    const { err, stdout, stderr } = await run(['plugin', 'enable', name]);
    if (err) return { ok: false, error: String(stderr || stdout || err.message).trim() };
    return { ok: true };
  },
  async disable(name) {
    const { err, stdout, stderr } = await run(['plugin', 'disable', name]);
    if (err) return { ok: false, error: String(stderr || stdout || err.message).trim() };
    return { ok: true };
  },
};

const agents = {
  // Machine-wide, not just this app's own chats — `claude agents --json`
  // lists every interactive and background Claude Code session running
  // under this user, including ones started from a terminal.
  async list() {
    const { err, stdout, stderr } = await run(['agents', '--json', '--all']);
    if (err && !stdout) return { ok: false, error: String(stderr || err.message).trim() };
    try {
      return { ok: true, data: JSON.parse(stdout) };
    } catch {
      return { ok: false, error: "Couldn't parse `claude agents --json` output." };
    }
  },
  async stop(id) {
    const { err, stdout, stderr } = await run(['stop', id]);
    if (err) return { ok: false, error: String(stderr || stdout || err.message).trim() };
    return { ok: true };
  },
  async remove(id) {
    const { err, stdout, stderr } = await run(['rm', id]);
    if (err) return { ok: false, error: String(stderr || stdout || err.message).trim() };
    return { ok: true };
  },
};

// `claude` slugifies a cwd into its projects-dir folder name by replacing
// every non-alphanumeric character with `-` (verified against real
// ~/.claude/projects entries: "/home/ort/Claude LinGUI" -> the space AND
// the slashes both become "-", giving "-home-ort-Claude-LinGUI").
function encodeProjectDir(cwd) {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-');
}

/** Lists resumable past sessions for a working directory, newest first. */
function listProjectSessions(cwd) {
  const dir = path.join(os.homedir(), '.claude', 'projects', encodeProjectDir(cwd));
  let files;
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
  } catch {
    return [];
  }
  const sessions = [];
  for (const file of files) {
    const full = path.join(dir, file);
    let stat;
    try {
      stat = fs.statSync(full);
    } catch {
      continue;
    }
    let preview = '';
    try {
      // A session file's first lines can be queue-operation bookkeeping, not
      // the opening message — scan the first few lines (still capped, so a
      // large file doesn't get read in full just to build a picker list).
      const fd = fs.openSync(full, 'r');
      const buf = Buffer.alloc(16384);
      const bytesRead = fs.readSync(fd, buf, 0, 16384, 0);
      fs.closeSync(fd);
      const lines = buf.toString('utf-8', 0, bytesRead).split('\n');
      for (const line of lines) {
        let parsed;
        try {
          parsed = JSON.parse(line);
        } catch {
          continue;
        }
        if (parsed.type !== 'user' || parsed.isMeta || !parsed.message) continue;
        const content = parsed.message.content;
        preview = typeof content === 'string' ? content : Array.isArray(content) ? content.find((c) => c.type === 'text')?.text || '' : '';
        if (preview) break;
      }
    } catch {
      // best-effort only
    }
    sessions.push({
      sessionId: file.replace(/\.jsonl$/, ''),
      mtime: stat.mtimeMs,
      preview: preview.slice(0, 140),
    });
  }
  sessions.sort((a, b) => b.mtime - a.mtime);
  return sessions;
}

module.exports = { mcp, plugins, agents, listProjectSessions };
