// Drives `claude auth login|logout|status` as one-shot child processes so the
// GUI can offer native sign-in instead of requiring a terminal.
//
// `claude auth login` is interactive: it prints a browser URL, then blocks on
// stdin waiting for the user to paste back the authorization code shown on
// that page once they approve. We don't line-buffer its output — the prompt
// itself is written without a trailing newline — so raw chunks are forwarded
// to the renderer as they arrive and it does its own text/URL handling.

const { spawn, execFile } = require('child_process');

const CLAUDE_BIN = process.env.CLAUDE_LINGUI_BIN || 'claude';

class AuthManager {
  constructor() {
    this.child = null;
  }

  status() {
    return new Promise((resolve) => {
      execFile(CLAUDE_BIN, ['auth', 'status', '--json'], { timeout: 10000 }, (err, stdout, stderr) => {
        // `claude auth status --json` exits 1 when logged out even though it
        // still prints valid JSON on stdout — try parsing stdout first and
        // only treat this as a real failure (CLI missing, crashed, etc.) if
        // that JSON isn't there.
        try {
          resolve({ ok: true, data: JSON.parse(stdout) });
        } catch {
          resolve({ ok: false, error: String(stderr || (err && err.message) || 'Unknown error').trim() });
        }
      });
    });
  }

  logout() {
    return new Promise((resolve) => {
      execFile(CLAUDE_BIN, ['auth', 'logout'], { timeout: 10000 }, (err, stdout, stderr) => {
        if (err) {
          resolve({ ok: false, error: String(stderr || err.message || err).trim() });
        } else {
          resolve({ ok: true });
        }
      });
    });
  }

  /**
   * Starts `claude auth login`. Only one login flow runs at a time — a new
   * call cancels any flow already in progress.
   * `method` is 'claudeai' (Claude subscription, the default) or 'console'
   * (Anthropic Console / API billing).
   */
  startLogin(method, handlers) {
    this.cancelLogin();
    const args = ['auth', 'login', method === 'console' ? '--console' : '--claudeai'];

    let child;
    try {
      child = spawn(CLAUDE_BIN, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (err) {
      handlers.onError && handlers.onError(String(err.message || err));
      return;
    }

    this.child = child;
    child.stdout.setEncoding('utf-8');
    child.stdout.on('data', (chunk) => handlers.onOutput && handlers.onOutput(chunk));
    child.stderr.setEncoding('utf-8');
    child.stderr.on('data', (chunk) => handlers.onOutput && handlers.onOutput(chunk));

    child.on('error', (err) => {
      this.child = null;
      handlers.onError && handlers.onError(String(err.message || err));
    });
    child.on('exit', (code, signal) => {
      if (this.child === child) this.child = null;
      handlers.onExit && handlers.onExit({ code, signal });
    });
  }

  /** Writes a pasted authorization code back to the running login process. */
  submitCode(code) {
    if (!this.child || !this.child.stdin.writable) return false;
    this.child.stdin.write(String(code).trim() + '\n');
    return true;
  }

  cancelLogin() {
    if (this.child) {
      try {
        this.child.kill('SIGTERM');
      } catch {
        // already gone
      }
      this.child = null;
    }
  }
}

module.exports = { AuthManager };
