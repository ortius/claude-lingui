// One PermissionBridge per chat session that wants real interactive
// per-tool approval. It opens a Unix domain socket that
// permissionMcpServer.js (a separate process `claude` itself spawns, per
// --mcp-config) connects to for each tool call needing a decision, and
// exposes respond() for the renderer's answer to flow back down.
//
// Protocol on the wire (newline-delimited JSON, one message each way):
//   -> {id, tool_name, input, permission_suggestions}
//   <- {decision: "allow"|"deny", updatedInput?, message?}
'use strict';
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

class PermissionBridge {
  constructor(onRequest) {
    this.onRequest = onRequest; // (request) => void — caller answers via respond()
    this.server = null;
    this.socketPath = null;
    this.pending = new Map(); // requestId -> net.Socket
  }

  /** Starts listening and returns the socket path to hand to the MCP server via env. */
  start() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lingui-perm-'));
    this.socketPath = path.join(dir, `${crypto.randomBytes(6).toString('hex')}.sock`);

    this.server = net.createServer((socket) => {
      let buf = '';
      socket.on('data', (chunk) => {
        buf += chunk.toString('utf-8');
        const idx = buf.indexOf('\n');
        if (idx === -1) return;
        const line = buf.slice(0, idx);
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          socket.end();
          return;
        }
        this.pending.set(msg.id, socket);
        this.onRequest({ id: msg.id, toolName: msg.tool_name, input: msg.input, permissionSuggestions: msg.permission_suggestions });
      });
      socket.on('error', () => {});
    });
    this.server.listen(this.socketPath);
    return this.socketPath;
  }

  /** Answers a pending request; `extra` may carry `updatedInput` (allow) or `message` (deny). */
  respond(requestId, decision, extra) {
    const socket = this.pending.get(requestId);
    if (!socket) return false;
    this.pending.delete(requestId);
    try {
      socket.write(JSON.stringify({ decision, ...extra }) + '\n');
      socket.end();
    } catch {
      // socket already gone — nothing to do
    }
    return true;
  }

  stop() {
    // Any tool calls still waiting get a safe default (deny), not a hang.
    for (const [requestId] of this.pending) this.respond(requestId, 'deny', { message: 'Session ended before this was answered.' });
    if (this.server) {
      try {
        this.server.close();
      } catch {
        // already closed
      }
    }
    if (this.socketPath) {
      try {
        fs.rmSync(path.dirname(this.socketPath), { recursive: true, force: true });
      } catch {
        // best-effort cleanup
      }
    }
  }
}

module.exports = { PermissionBridge };
