const { contextBridge, ipcRenderer, webUtils } = require('electron');
const { marked } = require('marked');
const hljs = require('highlight.js');
// dompurify self-initializes against the current global `window`, which
// preload already has access to (it runs in the renderer's JS context).
const DOMPurify = require('dompurify');

marked.setOptions({
  gfm: true,
  breaks: false,
});

// Custom renderer: syntax-highlight fenced code blocks with highlight.js.
// marked v18's Renderer.code receives a single token: { text, lang, escaped }.
const renderer = new marked.Renderer();
renderer.code = ({ text: code, lang: infoString }) => {
  const lang = (infoString || '').trim().split(/\s+/)[0];
  let highlighted;
  let langClass = 'hljs';
  if (lang && hljs.getLanguage(lang)) {
    highlighted = hljs.highlight(code, { language: lang }).value;
    langClass += ` language-${lang}`;
  } else {
    highlighted = hljs.highlightAuto(code).value;
  }
  const label = lang ? `<span class="code-lang">${lang}</span>` : '';
  // Copy is wired via delegated click handling in app.js (reading this
  // button's sibling <code> textContent) rather than an inline handler —
  // the app's CSP has no 'unsafe-inline' for script-src.
  const copyBtn =
    '<button type="button" class="code-copy-btn" aria-label="Copy code"><svg viewBox="0 0 24 24" width="13" height="13"><path d="M8 8V5a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1h-3M8 8H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1v-3M8 8h7a1 1 0 0 1 1 1v7" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg></button>';
  return `<div class="code-block"><div class="code-block-header">${label}${copyBtn}</div><pre class="${langClass}"><code>${highlighted}</code></pre></div>`;
};

function renderMarkdown(text) {
  const raw = marked.parse(text ?? '', { renderer });
  return DOMPurify.sanitize(raw, { ADD_ATTR: ['target'] });
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text ?? '';
  return div.innerHTML;
}

contextBridge.exposeInMainWorld('lingui', {
  // --- CLI / environment ---
  checkCli: () => ipcRenderer.invoke('cli:check'),
  homeDir: () => ipcRenderer.invoke('fs:home-dir'),
  chooseDirectory: (defaultPath) => ipcRenderer.invoke('dialog:choose-directory', defaultPath),
  createProjectDirectory: (parentDir, name) => ipcRenderer.invoke('project:create-directory', { parentDir, name }),
  openExternal: (url) => ipcRenderer.invoke('shell:open-external', url),

  // --- Native Claude account login ---
  authStatus: () => ipcRenderer.invoke('auth:status'),
  authLogout: () => ipcRenderer.invoke('auth:logout'),
  authLoginStart: (method) => ipcRenderer.invoke('auth:login-start', method),
  authLoginSubmitCode: (code) => ipcRenderer.invoke('auth:login-submit-code', code),
  authLoginCancel: () => ipcRenderer.invoke('auth:login-cancel'),
  onAuthLoginOutput: (cb) => {
    const listener = (_evt, chunk) => cb(chunk);
    ipcRenderer.on('auth:login-output', listener);
    return () => ipcRenderer.removeListener('auth:login-output', listener);
  },
  onAuthLoginError: (cb) => {
    const listener = (_evt, message) => cb(message);
    ipcRenderer.on('auth:login-error', listener);
    return () => ipcRenderer.removeListener('auth:login-error', listener);
  },
  onAuthLoginExit: (cb) => {
    const listener = (_evt, info) => cb(info);
    ipcRenderer.on('auth:login-exit', listener);
    return () => ipcRenderer.removeListener('auth:login-exit', listener);
  },

  // --- Settings + chat persistence ---
  getSettings: () => ipcRenderer.invoke('store:get-settings'),
  setSettings: (patch) => ipcRenderer.invoke('store:set-settings', patch),
  listChats: () => ipcRenderer.invoke('store:list-chats'),
  getChat: (id) => ipcRenderer.invoke('store:get-chat', id),
  upsertChat: (chat) => ipcRenderer.invoke('store:upsert-chat', chat),
  deleteChat: (id) => ipcRenderer.invoke('store:delete-chat', id),

  // --- Session lifecycle ---
  hasActiveSession: (localId) => ipcRenderer.invoke('session:has-active', localId),
  sendMessage: (localId, text, opts) => ipcRenderer.invoke('session:send', { localId, text, opts }),
  stopSession: (localId) => ipcRenderer.invoke('session:stop', localId),
  respondPermission: (localId, requestId, decision, extra) => ipcRenderer.invoke('session:permission-respond', { localId, requestId, decision, extra }),
  onPermissionRequest: (cb) => {
    const listener = (_evt, payload) => cb(payload);
    ipcRenderer.on('session:permission-request', listener);
    return () => ipcRenderer.removeListener('session:permission-request', listener);
  },

  onSessionEvent: (cb) => {
    const listener = (_evt, payload) => cb(payload);
    ipcRenderer.on('session:event', listener);
    return () => ipcRenderer.removeListener('session:event', listener);
  },
  onSessionExit: (cb) => {
    const listener = (_evt, payload) => cb(payload);
    ipcRenderer.on('session:exit', listener);
    return () => ipcRenderer.removeListener('session:exit', listener);
  },
  onSessionStderr: (cb) => {
    const listener = (_evt, payload) => cb(payload);
    ipcRenderer.on('session:stderr', listener);
    return () => ipcRenderer.removeListener('session:stderr', listener);
  },
  onSessionSpawnError: (cb) => {
    const listener = (_evt, payload) => cb(payload);
    ipcRenderer.on('session:spawn-error', listener);
    return () => ipcRenderer.removeListener('session:spawn-error', listener);
  },

  // --- Rendering helpers (run here so the renderer needs no Node access) ---
  renderMarkdown,
  escapeHtml,

  // Resolves a dropped File to a real filesystem path — needed to tell a
  // dropped folder (which File/FileReader can't read into content) apart
  // from a droppable file attachment.
  getPathForFile: (file) => webUtils.getPathForFile(file),

  // --- Tray / hotkey / notifications ---
  setTrayHotkey: (accelerator) => ipcRenderer.invoke('tray:set-hotkey', accelerator),
  onTrayNewChat: (cb) => {
    const listener = () => cb();
    ipcRenderer.on('tray:new-chat', listener);
    return () => ipcRenderer.removeListener('tray:new-chat', listener);
  },

  // --- @-mention file listing, CLAUDE.md editor, chat export ---
  listFiles: (root) => ipcRenderer.invoke('fs:list-files', root),
  readClaudeMd: (cwd) => ipcRenderer.invoke('fs:read-claude-md', cwd),
  writeClaudeMd: (cwd, text) => ipcRenderer.invoke('fs:write-claude-md', { cwd, text }),
  exportChat: (defaultName, markdown) => ipcRenderer.invoke('dialog:export-chat', { defaultName, markdown }),

  // --- Tools panel: MCP servers, plugins, machine-wide agents, past sessions ---
  mcpList: () => ipcRenderer.invoke('tools:mcp-list'),
  mcpAdd: (name, json, scope) => ipcRenderer.invoke('tools:mcp-add', { name, json, scope }),
  mcpRemove: (name) => ipcRenderer.invoke('tools:mcp-remove', name),
  pluginList: () => ipcRenderer.invoke('tools:plugin-list'),
  pluginEnable: (name) => ipcRenderer.invoke('tools:plugin-enable', name),
  pluginDisable: (name) => ipcRenderer.invoke('tools:plugin-disable', name),
  agentsList: () => ipcRenderer.invoke('tools:agents-list'),
  agentsStop: (id) => ipcRenderer.invoke('tools:agents-stop', id),
  agentsRemove: (id) => ipcRenderer.invoke('tools:agents-remove', id),
  projectSessions: (cwd) => ipcRenderer.invoke('tools:project-sessions', cwd),
  openPreview: (title, html) => ipcRenderer.invoke('preview:open', { title, html }),

  // --- Open/reveal a file the CLI touched ---
  openPath: (filePath) => ipcRenderer.invoke('shell:open-path', filePath),
  showInFolder: (filePath) => ipcRenderer.invoke('shell:show-in-folder', filePath),

  // --- In-chat find (Ctrl+F) ---
  findStart: (text, forward, findNext) => ipcRenderer.invoke('find:start', { text, forward, findNext }),
  findStop: () => ipcRenderer.invoke('find:stop'),
  onFindResult: (cb) => {
    const listener = (_evt, result) => cb(result);
    ipcRenderer.on('find:result', listener);
    return () => ipcRenderer.removeListener('find:result', listener);
  },

  // --- Extra windows ---
  newWindow: () => ipcRenderer.invoke('window:new'),

  // --- Launch on login ---
  getLoginItem: () => ipcRenderer.invoke('app:get-login-item'),
  setLoginItem: (openAtLogin) => ipcRenderer.invoke('app:set-login-item', openAtLogin),

  // --- Update check ---
  checkUpdate: () => ipcRenderer.invoke('app:check-update'),

  // --- Embedded terminal (attach / interactive / Remote Control) ---
  terminalStart: (id, opts) => ipcRenderer.invoke('terminal:start', { id, ...opts }),
  terminalWrite: (id, data) => ipcRenderer.invoke('terminal:write', { id, data }),
  terminalResize: (id, cols, rows) => ipcRenderer.invoke('terminal:resize', { id, cols, rows }),
  terminalStop: (id) => ipcRenderer.invoke('terminal:stop', id),
  onTerminalData: (cb) => {
    const listener = (_evt, payload) => cb(payload);
    ipcRenderer.on('terminal:data', listener);
    return () => ipcRenderer.removeListener('terminal:data', listener);
  },
  onTerminalExit: (cb) => {
    const listener = (_evt, payload) => cb(payload);
    ipcRenderer.on('terminal:exit', listener);
    return () => ipcRenderer.removeListener('terminal:exit', listener);
  },

  platform: process.platform,
});
