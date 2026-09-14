#!/usr/bin/env node
// Standalone MCP stdio server. `claude` spawns this itself (declared via
// --mcp-config) when a chat wants real interactive per-tool approval —
// it's not part of the Electron app's own process tree, just a plain
// script `claude` runs as a subprocess and talks JSON-RPC to over
// stdin/stdout, per the MCP spec.
//
// It exposes exactly one tool, `approval_prompt`, matching the
// {tool_name, input, permission_suggestions} shape Claude Code's
// --permission-prompt-tool protocol calls (confirmed against the CLI
// directly — see the comment on permissionBridge.js for the full picture).
// Each call is relayed over a Unix domain socket (path given via the
// LINGUI_PERM_SOCKET env var, set per-chat in claudeSession.js) to the
// Electron main process, which is the only side that actually knows how to
// ask a human.
'use strict';
const net = require('net');
const readline = require('readline');
const crypto = require('crypto');

const SOCKET_PATH = process.env.LINGUI_PERM_SOCKET;
const ASK_TIMEOUT_MS = 10 * 60 * 1000; // a human may take a while

const rl = readline.createInterface({ input: process.stdin, terminal: false });
function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

function askBridge(toolName, input, permissionSuggestions) {
  return new Promise((resolve) => {
    if (!SOCKET_PATH) {
      resolve({ behavior: 'deny', message: 'Permission bridge not configured for this session.' });
      return;
    }
    const requestId = crypto.randomUUID();
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(result);
    };

    const timeout = setTimeout(() => {
      socket.destroy();
      finish({ behavior: 'deny', message: 'Timed out waiting for a decision.' });
    }, ASK_TIMEOUT_MS);

    const socket = net.createConnection(SOCKET_PATH);
    let buf = '';
    socket.on('connect', () => {
      socket.write(JSON.stringify({ id: requestId, tool_name: toolName, input, permission_suggestions: permissionSuggestions }) + '\n');
    });
    socket.on('data', (chunk) => {
      buf += chunk.toString('utf-8');
      const idx = buf.indexOf('\n');
      if (idx === -1) return;
      const line = buf.slice(0, idx);
      socket.end();
      try {
        const parsed = JSON.parse(line);
        finish(
          parsed.decision === 'allow'
            ? { behavior: 'allow', updatedInput: parsed.updatedInput || input }
            : { behavior: 'deny', message: parsed.message || 'Denied by user.' }
        );
      } catch {
        finish({ behavior: 'deny', message: 'Bridge sent an invalid response.' });
      }
    });
    socket.on('error', () => finish({ behavior: 'deny', message: "Couldn't reach Claude LinGUI to ask for a decision." }));
  });
}

rl.on('line', async (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }

  if (msg.method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id: msg.id,
      result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'lingui-permissions', version: '1.0.0' } },
    });
  } else if (msg.method === 'notifications/initialized') {
    // notification — no response expected
  } else if (msg.method === 'tools/list') {
    send({
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        tools: [
          {
            name: 'approval_prompt',
            description: 'Ask the human user in Claude LinGUI whether a tool call is allowed.',
            inputSchema: {
              type: 'object',
              properties: { tool_name: { type: 'string' }, input: { type: 'object' } },
              required: ['tool_name', 'input'],
            },
          },
        ],
      },
    });
  } else if (msg.method === 'tools/call') {
    const args = (msg.params && msg.params.arguments) || {};
    const result = await askBridge(args.tool_name, args.input, args.permission_suggestions);
    send({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: JSON.stringify(result) }] } });
  } else if (msg.id !== undefined) {
    send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Method not found' } });
  }
});
