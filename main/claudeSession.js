// Spawns and manages `claude` CLI child processes, one per chat, speaking
// its newline-delimited JSON streaming protocol (`--input-format stream-json
// --output-format stream-json`). Each parsed line is forwarded to the
// renderer as-is (plus a `localId` tag) so the UI does the interpreting.
//
// Cloud-session chats (SessionManager.sendCloud) are a separate, simpler,
// one-shot path — see the comment on that method for why.

const { spawn } = require('child_process');
const { EventEmitter } = require('events');

const CLAUDE_BIN = process.env.CLAUDE_LINGUI_BIN || 'claude';

/**
 * Turns a text turn plus renderer-prepared attachments into a Messages-API
 * `content` value: a plain string when there are no attachments (the common
 * case, and how every chat worked before attachments existed), or a content
 * block array — attachments first, then the caption text — when there are.
 */
function buildContent(text, attachments) {
  if (!attachments || !attachments.length) return text;

  const blocks = [];
  for (const a of attachments) {
    if (a.kind === 'image') {
      blocks.push({ type: 'image', source: { type: 'base64', media_type: a.mediaType, data: a.base64Data } });
    } else if (a.kind === 'pdf') {
      blocks.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: a.base64Data } });
    } else if (a.kind === 'text') {
      blocks.push({
        type: 'document',
        source: { type: 'text', media_type: 'text/plain', data: a.textContent },
        title: a.name || undefined,
      });
    }
  }
  if (text) blocks.push({ type: 'text', text });
  return blocks;
}

class ClaudeSession extends EventEmitter {
  constructor(localId, opts) {
    super();
    this.localId = localId;
    this.opts = opts; // { cwd, model, permissionMode, resumeSessionId }
    this.child = null;
    this.sessionId = opts.resumeSessionId || null;
    this.alive = false;
    this._stdoutBuf = '';
  }

  start() {
    const args = [
      '-p',
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--include-partial-messages',
      '--verbose',
    ];

    if (this.opts.model && this.opts.model !== 'default') {
      args.push('--model', this.opts.model);
    }
    if (this.opts.permissionMode) {
      args.push('--permission-mode', this.opts.permissionMode);
    }
    if (this.opts.resumeSessionId) {
      args.push('--resume', this.opts.resumeSessionId);
    }

    let child;
    try {
      child = spawn(CLAUDE_BIN, args, {
        cwd: this.opts.cwd,
        env: process.env,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (err) {
      this.emit('spawn-error', String(err && err.message ? err.message : err));
      return;
    }

    this.child = child;
    this.alive = true;

    child.stdout.setEncoding('utf-8');
    child.stdout.on('data', (chunk) => this._handleStdout(chunk));

    child.stderr.setEncoding('utf-8');
    child.stderr.on('data', (chunk) => {
      this.emit('stderr', chunk);
    });

    child.on('error', (err) => {
      this.alive = false;
      this.emit('spawn-error', String(err && err.message ? err.message : err));
    });

    child.on('exit', (code, signal) => {
      this.alive = false;
      this.emit('exit', { code, signal });
    });
  }

  _handleStdout(chunk) {
    this._stdoutBuf += chunk;
    const lines = this._stdoutBuf.split('\n');
    this._stdoutBuf = lines.pop();
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let evt;
      try {
        evt = JSON.parse(trimmed);
      } catch {
        this.emit('raw-line', trimmed);
        continue;
      }
      if (evt.session_id) this.sessionId = evt.session_id;
      this.emit('event', evt);
    }
  }

  /**
   * Send one user turn. `attachments` (optional) are renderer-prepared
   * { kind: 'image'|'pdf'|'text', mediaType, base64Data?, textContent?, name }
   * objects — turned into Messages-API content blocks ahead of the text so
   * they land in the same user turn, exactly like pasting an image or
   * attaching a file in the interactive CLI.
   */
  sendMessage(text, attachments) {
    if (!this.alive || !this.child || !this.child.stdin.writable) {
      throw new Error('Session is not running');
    }
    const content = buildContent(text, attachments);
    const payload = {
      type: 'user',
      message: { role: 'user', content },
    };
    this.child.stdin.write(JSON.stringify(payload) + '\n');
  }

  stop() {
    if (this.child && this.alive) {
      try {
        this.child.kill('SIGTERM');
      } catch {
        // already gone
      }
    }
  }
}

class SessionManager {
  constructor() {
    /** @type {Map<string, ClaudeSession>} */
    this.sessions = new Map();
  }

  has(localId) {
    const s = this.sessions.get(localId);
    return !!(s && s.alive);
  }

  create(localId, opts, handlers) {
    this.destroy(localId);
    const session = new ClaudeSession(localId, opts);
    session.on('event', (evt) => handlers.onEvent && handlers.onEvent(evt));
    session.on('raw-line', (line) => handlers.onRawLine && handlers.onRawLine(line));
    session.on('stderr', (chunk) => handlers.onStderr && handlers.onStderr(chunk));
    session.on('spawn-error', (msg) => handlers.onSpawnError && handlers.onSpawnError(msg));
    session.on('exit', (info) => {
      handlers.onExit && handlers.onExit(info);
      this.sessions.delete(localId);
    });
    this.sessions.set(localId, session);
    session.start();
    return session;
  }

  send(localId, text, attachments) {
    const session = this.sessions.get(localId);
    if (!session || !session.alive) {
      throw new Error('No active session for this chat. Send a message to start a new one.');
    }
    session.sendMessage(text, attachments);
  }

  /**
   * Sends one message to an existing cloud session. Unlike local chats this
   * is one-shot, not a persistent process: `claude -p --cloud <target>`
   * only queues the message and returns an acknowledgment + a claude.ai/code
   * URL — it does NOT stream back a reply (confirmed against a real cloud
   * session; --output-format stream-json is outright rejected together with
   * --cloud, and the "json" format's success response carries no reply
   * text). The actual conversation continues on claude.ai/code or the
   * mobile app, not in this window.
   */
  sendCloud(localId, text, opts, handlers) {
    const args = ['-p', text, '--output-format', 'json', '--cloud', opts.cloudTarget];
    if (opts.permissionMode) args.push('--permission-mode', opts.permissionMode);

    const { execFile } = require('child_process');
    execFile(
      CLAUDE_BIN,
      args,
      { cwd: opts.cwd, maxBuffer: 10 * 1024 * 1024, timeout: 30000 },
      (err, stdout, stderr) => {
        const lastLine = (stdout || '').trim().split('\n').pop();
        let parsed = null;
        try {
          parsed = lastLine ? JSON.parse(lastLine) : null;
        } catch {
          parsed = null;
        }
        if (parsed) {
          handlers.onEvent &&
            handlers.onEvent({
              type: 'cloud_message_result',
              ok: !!parsed.ok,
              url: parsed.url || null,
              session_id: parsed.session_id || opts.cloudTarget,
              error: parsed.error || null,
            });
        } else {
          handlers.onSpawnError &&
            handlers.onSpawnError(String((stderr || (err && err.message) || 'No response from claude --cloud.')).trim());
        }
      }
    );
  }

  stop(localId) {
    const session = this.sessions.get(localId);
    if (session) session.stop();
  }

  destroy(localId) {
    const session = this.sessions.get(localId);
    if (session) {
      session.stop();
      this.sessions.delete(localId);
    }
  }

  destroyAll() {
    for (const localId of Array.from(this.sessions.keys())) this.destroy(localId);
  }
}

module.exports = { SessionManager };
