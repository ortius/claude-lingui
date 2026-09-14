// Manages real pseudo-terminal sessions (node-pty) — used for things a
// headless `-p --input-format stream-json` session structurally can't do:
// attaching to a background session (`claude attach <id>`), and anything
// that needs a genuine interactive TTY (Remote Control, /rewind, and any
// other terminal-only feature), by just handing the user a real terminal.
'use strict';
const pty = require('node-pty');

class PtyManager {
  constructor() {
    /** @type {Map<string, import('node-pty').IPty>} */
    this.sessions = new Map();
  }

  spawn(id, { command, args, cwd, cols, rows }, handlers) {
    this.kill(id);
    let proc;
    try {
      proc = pty.spawn(command, args || [], {
        name: 'xterm-256color',
        cols: cols || 80,
        rows: rows || 24,
        cwd,
        env: process.env,
      });
    } catch (err) {
      handlers.onExit && handlers.onExit({ exitCode: null, signal: null, error: String(err.message || err) });
      return null;
    }
    this.sessions.set(id, proc);
    proc.onData((data) => handlers.onData && handlers.onData(data));
    proc.onExit(({ exitCode, signal }) => {
      this.sessions.delete(id);
      handlers.onExit && handlers.onExit({ exitCode, signal });
    });
    return proc;
  }

  write(id, data) {
    const proc = this.sessions.get(id);
    if (proc) proc.write(data);
  }

  resize(id, cols, rows) {
    const proc = this.sessions.get(id);
    if (!proc) return;
    try {
      proc.resize(cols, rows);
    } catch {
      // pty already gone — ignore
    }
  }

  kill(id) {
    const proc = this.sessions.get(id);
    if (proc) {
      try {
        proc.kill();
      } catch {
        // already gone
      }
      this.sessions.delete(id);
    }
  }

  killAll() {
    for (const id of Array.from(this.sessions.keys())) this.kill(id);
  }
}

module.exports = { PtyManager };
