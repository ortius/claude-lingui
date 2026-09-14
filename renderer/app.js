'use strict';

// ===========================================================================
// Constants
// ===========================================================================

const MODELS = [
  { value: 'default', label: 'Default (account setting)' },
  { value: 'sonnet', label: 'Sonnet 5' },
  { value: 'opus', label: 'Opus 5' },
  { value: 'fable', label: 'Fable 5.1' },
  { value: 'haiku', label: 'Haiku 4.5' },
];

const PERMISSION_MODES = [
  { value: 'acceptEdits', label: 'Accept edits automatically' },
  { value: 'plan', label: 'Plan mode (read-only)' },
  { value: 'bypassPermissions', label: 'Full access (bypass all checks)' },
];

// Fallback for the "/" palette before any session has started (so we don't
// yet know the live, session-reported list) — a small set of genuinely
// common commands, not an attempt at the full catalog.
const FALLBACK_SLASH_COMMANDS = [
  { name: 'compact', desc: 'Compact the conversation to save context' },
  { name: 'clear', desc: 'Clear conversation history' },
  { name: 'cost', desc: 'Show cost and usage for this session' },
  { name: 'model', desc: 'Change the model' },
  { name: 'effort', desc: 'Set the reasoning effort level' },
  { name: 'context', desc: 'Show context window usage' },
  { name: 'agents', desc: 'Manage background agents' },
  { name: 'doctor', desc: "Check this project's Claude Code health" },
  { name: 'config', desc: 'View or edit configuration' },
  { name: 'review', desc: 'Review the current diff' },
];

const TOOL_FIELD_HINTS = {
  Bash: (i) => i.command,
  Read: (i) => i.file_path,
  Write: (i) => i.file_path,
  Edit: (i) => i.file_path,
  Grep: (i) => i.pattern,
  Glob: (i) => i.pattern,
  WebFetch: (i) => i.url,
  WebSearch: (i) => i.query,
  Task: (i) => i.description,
};

// ===========================================================================
// Global state
// ===========================================================================

/** @type {Map<string, ChatState>} in-memory state for every known chat */
const chats = new Map();
let activeChatId = null;
let settings = {};
const saveTimers = new Map(); // chatId -> timeout handle (debounced persistence)
const domIndex = new Map(); // blockId -> HTMLElement (active chat only)
let currentAssistantStackEl = null; // wrapper .assistant-stack for the in-flight turn
const dirtyTextBlocks = new Set(); // block ids needing a re-render this frame
let rafScheduled = false;
let homeDirPath = '';
let welcomeMode = 'folder'; // 'folder' | 'new' | 'cloud'
let chatSearchQuery = '';

const ACCENT_SWATCHES = [
  { name: 'terracotta', light: '#c15f3c', dark: '#e0835f' },
  { name: 'violet', light: '#7c5cc1', dark: '#a98ce0' },
  { name: 'teal', light: '#2f8f83', dark: '#5fc4b6' },
  { name: 'blue', light: '#3f6fc1', dark: '#7aa3e0' },
  { name: 'rose', light: '#c1477f', dark: '#e07aab' },
  { name: 'olive', light: '#7d8c3a', dark: '#aebf5f' },
];

// ===========================================================================
// Chat state shape
// chat = {
//   id, title, cwd, model, permissionMode, sessionId,
//   createdAt, updatedAt, busy, lastStatus, blocks: [...]
// }
// block kinds: 'user' | 'text' | 'tool'
// ===========================================================================

function newId() {
  return crypto.randomUUID();
}

function createChat({ cwd, model, permissionMode, mode, cloudTarget }) {
  const chat = {
    id: newId(),
    title: 'New chat',
    cwd,
    model,
    permissionMode,
    mode: mode || 'local', // 'local' | 'cloud'
    cloudTarget: cloudTarget || null,
    sessionId: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    busy: false,
    lastStatus: null,
    blocks: [],
  };
  chats.set(chat.id, chat);
  return chat;
}

function scheduleSave(chatId) {
  clearTimeout(saveTimers.get(chatId));
  saveTimers.set(
    chatId,
    setTimeout(() => {
      const chat = chats.get(chatId);
      if (chat) window.lingui.upsertChat(chat);
    }, 350)
  );
}

// ===========================================================================
// Rendering helpers
// ===========================================================================

function el(tag, className, text) {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}

function fromTemplate(id) {
  const tpl = document.getElementById(id);
  return tpl.content.firstElementChild.cloneNode(true);
}

function toolSummaryFor(name, input) {
  if (!input) return '';
  const hint = TOOL_FIELD_HINTS[name];
  let val = hint ? hint(input) : null;
  if (!val) {
    try {
      val = JSON.stringify(input);
    } catch {
      val = '';
    }
  }
  if (typeof val !== 'string') val = JSON.stringify(val);
  return val.length > 90 ? val.slice(0, 90) + '…' : val;
}

function stringifyToolResult(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => {
        if (typeof c === 'string') return c;
        if (c && c.type === 'text') return c.text;
        if (c && c.type === 'image') return '[image]';
        return JSON.stringify(c);
      })
      .join('\n');
  }
  try {
    return JSON.stringify(content, null, 2);
  } catch {
    return String(content);
  }
}

/** Line-level LCS diff — fine for Edit's old_string/new_string (targeted snippets, not whole files). */
function computeLineDiff(oldText, newText) {
  const a = (oldText ?? '').split('\n');
  const b = (newText ?? '').split('\n');
  const n = a.length;
  const m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const ops = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ type: 'context', text: a[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push({ type: 'remove', text: a[i] });
      i++;
    } else {
      ops.push({ type: 'add', text: b[j] });
      j++;
    }
  }
  while (i < n) ops.push({ type: 'remove', text: a[i++] });
  while (j < m) ops.push({ type: 'add', text: b[j++] });
  return ops;
}

function renderDiffInto(container, oldText, newText) {
  container.innerHTML = '';
  const a = (oldText ?? '').split('\n');
  const b = (newText ?? '').split('\n');
  if (a.length * b.length > 4_000_000) {
    container.appendChild(el('div', 'diff-line', 'Diff too large to render — see the result below.'));
    return;
  }
  for (const op of computeLineDiff(oldText, newText)) {
    const node = fromTemplate('tpl-diff-line');
    if (op.type === 'add') {
      node.classList.add('add');
      node.querySelector('.diff-marker').textContent = '+';
    } else if (op.type === 'remove') {
      node.classList.add('remove');
      node.querySelector('.diff-marker').textContent = '−';
    } else {
      node.querySelector('.diff-marker').textContent = ' ';
    }
    node.querySelector('.diff-text').textContent = op.text;
    container.appendChild(node);
  }
}

/**
 * Opens generated HTML in its own native window rather than an in-app
 * iframe — this app's CSP (no 'unsafe-inline' scripts) would otherwise
 * apply to a same-document iframe/data: preview too (data: navigations
 * inherit the initiating document's CSP), silently breaking any inline
 * `<script>` in the previewed page. A separate BrowserWindow is a fresh,
 * unrelated navigation with no inherited policy — same trust boundary as
 * opening a local HTML file in a browser tab — and main.js still runs it
 * with nodeIntegration off and the OS sandbox on.
 */
function openPreview(title, htmlContent) {
  window.lingui.openPreview(title, htmlContent);
}

/** Builds (or refreshes) the DOM node for a single block. */
function renderBlockNode(block) {
  // 'user' blocks are created once in appendBlockToDom and never re-rendered
  // (their text is immutable after send), so only 'text'/'thinking'/'tool' land here.
  let node = domIndex.get(block.id);

  if (block.kind === 'text') {
    if (!node) {
      node = fromTemplate('tpl-block-text');
      node.dataset.blockId = block.id;
      domIndex.set(block.id, node);
    }
    const content = node.querySelector('.block-text-content');
    content.innerHTML = window.lingui.renderMarkdown(block.text || '');
    if (block.streaming) {
      const cursor = el('span', 'typing-cursor');
      content.appendChild(cursor);
    }
    return node;
  }

  if (block.kind === 'thinking') {
    if (!node) {
      node = fromTemplate('tpl-block-thinking');
      domIndex.set(block.id, node);
    }
    node.open = !!block.streaming;
    node.querySelector('.thinking-body').textContent = block.text || '';
    return node;
  }

  if (block.kind === 'cloud-ack') {
    if (!node) {
      node = fromTemplate('tpl-block-cloud-ack');
      domIndex.set(block.id, node);
    }
    node.className = 'block block-cloud-ack ' + (block.ok ? 'ok' : 'err');
    node.innerHTML = '';
    if (block.ok) {
      node.appendChild(document.createTextNode('✓ Sent to the cloud session. '));
      if (block.url) {
        const a = el('a', null, 'View the reply on claude.ai/code ↗');
        a.href = block.url;
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        node.appendChild(a);
      } else {
        node.appendChild(document.createTextNode('Check claude.ai/code or the mobile app for the reply.'));
      }
    } else {
      node.appendChild(document.createTextNode('✕ ' + (block.error || "Couldn't send to the cloud session.")));
    }
    return node;
  }

  if (block.kind === 'tool') {
    if (!node) {
      node = fromTemplate('tpl-block-tool');
      domIndex.set(block.id, node);
    }
    node.querySelector('.tool-icon').textContent = (block.name || '?').slice(0, 2).toUpperCase();
    node.querySelector('.tool-name').textContent = block.name || 'tool';
    node.querySelector('.tool-summary').textContent = toolSummaryFor(block.name, block.input);

    const statusEl = node.querySelector('.tool-status');
    statusEl.className = 'tool-status ' + block.status;
    statusEl.textContent = block.status === 'running' ? 'running…' : block.status === 'error' ? 'error' : 'done';
    node.open = block.status === 'running';

    const diffEl = node.querySelector('.tool-diff');
    const inputEl = node.querySelector('.tool-input');
    const isEdit = block.name === 'Edit' && block.input && typeof block.input.old_string === 'string' && typeof block.input.new_string === 'string';
    if (isEdit) {
      inputEl.hidden = true;
      inputEl.innerHTML = '';
      renderDiffInto(diffEl, block.input.old_string, block.input.new_string);
    } else {
      diffEl.innerHTML = '';
      inputEl.hidden = false;
      inputEl.innerHTML = '';
      if (block.inputText) {
        inputEl.appendChild(el('span', 'tool-input-label', 'Input'));
        inputEl.appendChild(document.createTextNode(block.inputText));
      }
    }

    const resultEl = node.querySelector('.tool-result');
    resultEl.innerHTML = '';
    if (block.resultText) {
      resultEl.appendChild(el('span', 'tool-result-label', block.status === 'error' ? 'Error' : 'Result'));
      const text = block.resultText.length > 6000 ? block.resultText.slice(0, 6000) + '\n…(truncated)' : block.resultText;
      resultEl.appendChild(document.createTextNode(text));
    }

    const previewBtn = node.querySelector('.tool-preview-btn');
    const isHtmlWrite = block.name === 'Write' && block.input && typeof block.input.file_path === 'string' && /\.html?$/i.test(block.input.file_path) && typeof block.input.content === 'string';
    previewBtn.hidden = !isHtmlWrite;
    if (isHtmlWrite) previewBtn.onclick = () => openPreview(baseName(block.input.file_path), block.input.content);

    const fileActionsEl = node.querySelector('.tool-file-actions');
    const filePath = block.input && typeof block.input.file_path === 'string' ? block.input.file_path : null;
    const showFileActions = !!filePath && ['Read', 'Write', 'Edit'].includes(block.name);
    fileActionsEl.hidden = !showFileActions;
    if (showFileActions) {
      fileActionsEl.querySelector('.tool-open-btn').onclick = () => window.lingui.openPath(filePath);
      fileActionsEl.querySelector('.tool-reveal-btn').onclick = () => window.lingui.showInFolder(filePath);
    }
    return node;
  }

  return null;
}

function appendBlockToDom(block, targetEl) {
  const messagesEl = targetEl || document.getElementById('messages');

  if (block.kind === 'user') {
    const wrap = fromTemplate('tpl-msg-user');
    const bubble = wrap.querySelector('.bubble-user');
    bubble.dataset.blockId = block.id;
    bubble.querySelector('.bubble-text').textContent = block.text || '';
    if (block.attachments && block.attachments.length) {
      const row = bubble.querySelector('.attachment-row');
      for (const a of block.attachments) row.appendChild(attachmentNode(a, null));
    }
    domIndex.set(block.id, bubble);
    messagesEl.appendChild(wrap);
    currentAssistantStackEl = null; // next assistant block starts a fresh group
  } else {
    if (!currentAssistantStackEl) {
      const wrap = fromTemplate('tpl-msg-assistant');
      currentAssistantStackEl = wrap.querySelector('.assistant-stack');
      messagesEl.appendChild(wrap);
    }
    const node = renderBlockNode(block);
    if (node) currentAssistantStackEl.appendChild(node);
  }
  scrollMessagesToBottom(true);
}

function scrollMessagesToBottom(onlyIfNearBottom) {
  const messagesEl = document.getElementById('messages');
  if (onlyIfNearBottom) {
    const distance = messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight;
    if (distance > 200) return;
  }
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function markTextBlockDirty(blockId) {
  dirtyTextBlocks.add(blockId);
  if (rafScheduled) return;
  rafScheduled = true;
  requestAnimationFrame(flushDirtyBlocks);
}

function flushDirtyBlocks() {
  rafScheduled = false;
  const chat = chats.get(activeChatId);
  if (!chat) {
    dirtyTextBlocks.clear();
    return;
  }
  for (const blockId of dirtyTextBlocks) {
    const block = chat.blocks.find((b) => b.id === blockId);
    if (block) renderBlockNode(block);
  }
  dirtyTextBlocks.clear();
  scrollMessagesToBottom(true);
}

/** A run of blocks superseded by Regenerate/Edit-and-resend (the old question and its answer), collapsed behind a disclosure instead of shown inline. */
function appendSupersededGroup(blocks) {
  const messagesEl = document.getElementById('messages');
  const details = el('details', 'superseded-turn');
  details.appendChild(el('summary', null, 'Previous message'));
  const container = el('div', 'superseded-content');
  const savedStack = currentAssistantStackEl;
  currentAssistantStackEl = null;
  for (const b of blocks) appendBlockToDom(b, container);
  currentAssistantStackEl = savedStack;
  details.appendChild(container);
  messagesEl.appendChild(details);
}

/** Full rebuild of #messages from a chat's persisted/live block list. */
function renderChatFull(chat) {
  const messagesEl = document.getElementById('messages');
  messagesEl.innerHTML = '';
  domIndex.clear();
  currentAssistantStackEl = null;
  let i = 0;
  while (i < chat.blocks.length) {
    const block = chat.blocks[i];
    if (block.superseded) {
      const start = i;
      while (i < chat.blocks.length && chat.blocks[i].superseded) i++;
      appendSupersededGroup(chat.blocks.slice(start, i));
      currentAssistantStackEl = null;
      continue;
    }
    appendBlockToDom(block);
    i++;
  }
  scrollMessagesToBottom(false);
  updateLastUserMessageActions(chat);
}

// ===========================================================================
// Sidebar
// ===========================================================================

function relativeTime(ts) {
  const diff = Date.now() - ts;
  const min = Math.floor(diff / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day}d ago`;
  return new Date(ts).toLocaleDateString();
}

function baseName(p) {
  if (!p) return '';
  const parts = p.replace(/\/+$/, '').split('/');
  return parts[parts.length - 1] || p;
}

/** True if any text in the chat (title, directory, or message content) contains the query. */
function chatMatchesSearch(chat, query) {
  if (!query) return true;
  const q = query.toLowerCase();
  if ((chat.title || '').toLowerCase().includes(q)) return true;
  if ((chat.cwd || '').toLowerCase().includes(q)) return true;
  for (const block of chat.blocks || []) {
    if (block.text && block.text.toLowerCase().includes(q)) return true;
  }
  return false;
}

let showArchived = false;

function renderChatItem(chat) {
  const item = fromTemplate('tpl-chat-list-item');
  item.dataset.id = chat.id;
  item.classList.toggle('active', chat.id === activeChatId);
  const titleEl = item.querySelector('.chat-item-title');
  titleEl.textContent = chat.title || 'New chat';
  if (chat.pinned) {
    const mark = el('span', 'chat-item-pin-mark', '📌');
    titleEl.prepend(mark);
  }
  const locationLabel = chat.mode === 'cloud' ? '☁ Cloud session' : baseName(chat.cwd);
  item.querySelector('.chat-item-sub').textContent = `${locationLabel} · ${relativeTime(chat.updatedAt || chat.createdAt)}`;
  item.addEventListener('click', (ev) => {
    if (ev.target.closest('.chat-item-action')) return;
    openChat(chat.id);
  });
  const pinBtn = item.querySelector('.chat-item-pin');
  pinBtn.classList.toggle('active', !!chat.pinned);
  pinBtn.addEventListener('click', (ev) => {
    ev.stopPropagation();
    togglePinChat(chat);
  });
  item.querySelector('.chat-item-archive').addEventListener('click', (ev) => {
    ev.stopPropagation();
    toggleArchiveChat(chat);
  });
  item.querySelector('.chat-item-delete').addEventListener('click', async (ev) => {
    ev.stopPropagation();
    if (!confirm(`Delete "${chat.title || 'New chat'}"? This can't be undone.`)) return;
    await window.lingui.deleteChat(chat.id);
    chats.delete(chat.id);
    if (activeChatId === chat.id) showWelcome();
    refreshSidebarList();
  });
  return item;
}

async function refreshSidebarList() {
  const persisted = await window.lingui.listChats();
  // Merge with any in-memory chats not yet persisted (brand new, empty)
  const byId = new Map(persisted.map((c) => [c.id, c]));
  for (const chat of chats.values()) {
    if (!byId.has(chat.id)) byId.set(chat.id, chat);
  }
  let list = Array.from(byId.values()).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  if (chatSearchQuery) list = list.filter((c) => chatMatchesSearch(c, chatSearchQuery));

  const pinned = list.filter((c) => c.pinned && !c.archived);
  const archived = list.filter((c) => c.archived);
  const regular = list.filter((c) => !c.pinned && !c.archived);

  const container = document.getElementById('chatList');
  container.innerHTML = '';

  if (pinned.length) {
    container.appendChild(el('div', 'sidebar-section-label', 'Pinned'));
    for (const chat of pinned) container.appendChild(renderChatItem(chat));
  }
  container.appendChild(el('div', 'sidebar-section-label', 'Chats'));
  if (!regular.length) container.appendChild(el('p', 'empty-hint', chatSearchQuery ? 'No matches.' : 'No chats yet.'));
  for (const chat of regular) container.appendChild(renderChatItem(chat));

  if (archived.length) {
    const toggle = el('button', 'sidebar-section-label sidebar-section-toggle', `${showArchived ? '▾' : '▸'} Archived (${archived.length})`);
    toggle.type = 'button';
    toggle.addEventListener('click', () => {
      showArchived = !showArchived;
      refreshSidebarList();
    });
    container.appendChild(toggle);
    if (showArchived) for (const chat of archived) container.appendChild(renderChatItem(chat));
  }
}

// ===========================================================================
// View switching
// ===========================================================================

function showWelcome() {
  activeChatId = null;
  document.getElementById('welcomeScreen').hidden = false;
  document.getElementById('chatView').hidden = true;
  closeFindBar();
  window.lingui.setSettings({ lastOpenChatId: null });
  refreshSidebarList();
  setWelcomeMode('folder');
  document.getElementById('newProjectName').value = '';
  document.getElementById('cloudSessionInput').value = '';
  updateNewProjectPreview();
  clearAttachments(welcomeAttachCtx);
  const ta = document.getElementById('welcomeTextarea');
  ta.value = '';
  autoResize(ta);
  ta.focus();
}

async function openChat(chatId) {
  let chat = chats.get(chatId);
  if (!chat) {
    const persisted = await window.lingui.getChat(chatId);
    if (!persisted) return;
    persisted.busy = false;
    chats.set(chatId, persisted);
    chat = persisted;
  }
  activeChatId = chatId;
  document.getElementById('welcomeScreen').hidden = true;
  document.getElementById('chatView').hidden = false;
  document.getElementById('chatTitle').textContent = chat.title || 'New chat';
  const dirChip = document.getElementById('chatDirChip');
  if (chat.mode === 'cloud') {
    dirChip.textContent = '☁ Cloud session';
    dirChip.title = chat.cloudTarget || '';
  } else {
    dirChip.textContent = '📁 ' + baseName(chat.cwd);
    dirChip.title = chat.cwd;
  }
  document.getElementById('chatModelChip').textContent = labelFor(MODELS, chat.model);
  document.getElementById('chatPermChip').hidden = chat.mode === 'cloud';
  document.getElementById('chatPermChip').textContent = labelFor(PERMISSION_MODES, chat.permissionMode);
  document.getElementById('cloudNotice').hidden = chat.mode !== 'cloud';
  document.getElementById('composerTextarea').placeholder =
    chat.mode === 'cloud' ? 'Message to send to the cloud session…' : 'Message Claude… (Enter to send, Shift+Enter for a new line)';
  // Attachments need a local `claude` process (stream-json input) — cloud
  // sends are a plain-text one-shot CLI call and can't carry content blocks.
  document.getElementById('composerAttachBtn').hidden = chat.mode === 'cloud';
  clearAttachments(composerAttachCtx);
  closeFindBar();
  updatePinButton(chat);
  renderChatFull(chat);
  updateStatusBar(chat);
  updateComposerBusyState(chat);
  window.lingui.setSettings({ lastOpenChatId: chatId });
  refreshSidebarList();
  document.getElementById('composerTextarea').focus();
}

function labelFor(list, value) {
  const found = list.find((x) => x.value === value);
  return found ? found.label : value || '';
}

// ===========================================================================
// Attachments — file picker, drag & drop, and clipboard image paste for the
// welcome screen and the active-chat composer. Each is its own "context" (a
// pending-attachments array + the strip it renders into) since both forms
// can exist in the DOM at once, but only one is ever visible.
// ===========================================================================

const MAX_IMAGE_BYTES = 10 * 1024 * 1024; // 10MB
const MAX_PDF_BYTES = 32 * 1024 * 1024; // 32MB
const MAX_TEXT_BYTES = 5 * 1024 * 1024; // 5MB
const TEXT_EXTENSIONS = /\.(txt|md|markdown|json|csv|tsv|py|js|jsx|ts|tsx|mjs|cjs|log|yaml|yml|html?|css|scss|sh|bash|zsh|toml|ini|cfg|conf|xml|sql|rb|go|rs|java|c|h|cpp|hpp|cs|php|swift|kt|env)$/i;

const welcomeAttachCtx = { attachments: [], stripId: 'welcomeAttachStrip' };
const composerAttachCtx = { attachments: [], stripId: 'composerAttachStrip' };

function classifyFile(file) {
  const type = file.type || '';
  if (type.startsWith('image/')) return 'image';
  if (type === 'application/pdf' || /\.pdf$/i.test(file.name)) return 'pdf';
  if (type.startsWith('text/') || type === 'application/json' || TEXT_EXTENSIONS.test(file.name)) return 'text';
  return 'unsupported';
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

/** Reads a File into our in-memory attachment shape, or null (+ an alert) if it can't be used. */
async function readAttachment(file) {
  const kind = classifyFile(file);
  const id = newId();

  if (kind === 'unsupported') {
    alert(`${file.name} isn't a supported attachment type yet — try an image, PDF, or text/code file.`);
    return null;
  }
  if (kind === 'image') {
    if (file.size > MAX_IMAGE_BYTES) {
      alert(`${file.name} is too large to attach (images are capped at 10MB).`);
      return null;
    }
    const dataUrl = await fileToDataUrl(file);
    return {
      id,
      name: file.name,
      size: file.size,
      mediaType: file.type || 'image/png',
      kind,
      base64Data: dataUrl.slice(dataUrl.indexOf(',') + 1),
      dataUrl,
    };
  }
  if (kind === 'pdf') {
    if (file.size > MAX_PDF_BYTES) {
      alert(`${file.name} is too large to attach (PDFs are capped at 32MB).`);
      return null;
    }
    const dataUrl = await fileToDataUrl(file);
    return {
      id,
      name: file.name,
      size: file.size,
      mediaType: 'application/pdf',
      kind,
      base64Data: dataUrl.slice(dataUrl.indexOf(',') + 1),
    };
  }
  // text-ish fallback
  if (file.size > MAX_TEXT_BYTES) {
    alert(`${file.name} is too large to attach as text (capped at 5MB).`);
    return null;
  }
  try {
    return { id, name: file.name, size: file.size, mediaType: 'text/plain', kind: 'text', textContent: await file.text() };
  } catch {
    alert(`Couldn't read ${file.name}.`);
    return null;
  }
}

async function addFilesToContext(ctx, files) {
  for (const file of files) {
    const attachment = await readAttachment(file);
    if (attachment) ctx.attachments.push(attachment);
  }
  renderAttachmentStrip(ctx);
}

/** Builds the DOM for one attachment: an image thumbnail, or a name chip. Pass `onRemove` to make it removable (pending strips); omit it for read-only display in a sent message. */
function attachmentNode(a, onRemove) {
  const useThumb = a.kind === 'image' && a.dataUrl;
  const node = fromTemplate(useThumb ? 'tpl-attachment-thumb' : 'tpl-attachment-chip');
  if (useThumb) {
    const img = node.querySelector('.attachment-thumb');
    img.src = a.dataUrl;
    img.alt = a.name;
  } else {
    node.querySelector('.attachment-chip-icon').textContent = a.kind === 'pdf' ? '📄' : '📝';
    node.querySelector('.attachment-chip-name').textContent = a.name;
    node.title = a.name;
  }
  if (onRemove) {
    const removeBtn = node.querySelector('.attachment-chip-remove');
    removeBtn.hidden = false;
    removeBtn.addEventListener('click', onRemove);
  }
  return node;
}

function renderAttachmentStrip(ctx) {
  const strip = document.getElementById(ctx.stripId);
  strip.innerHTML = '';
  strip.hidden = ctx.attachments.length === 0;
  for (const a of ctx.attachments) {
    strip.appendChild(
      attachmentNode(a, () => {
        ctx.attachments = ctx.attachments.filter((x) => x.id !== a.id);
        renderAttachmentStrip(ctx);
      })
    );
  }
}

function clearAttachments(ctx) {
  ctx.attachments = [];
  renderAttachmentStrip(ctx);
}

/** Strips a pending attachment down to what's worth persisting in chat history (no need to keep full text/base64 around once it's been sent — images keep their dataUrl so history still shows a thumbnail). */
function attachmentForBlock(a) {
  const out = { id: a.id, name: a.name, size: a.size, mediaType: a.mediaType, kind: a.kind };
  if (a.kind === 'image') out.dataUrl = a.dataUrl;
  return out;
}

/** Full payload sent over IPC so the main process can build Messages-API content blocks. */
function attachmentForIpc(a) {
  const out = { kind: a.kind, mediaType: a.mediaType, name: a.name };
  if (a.kind === 'text') out.textContent = a.textContent;
  else out.base64Data = a.base64Data;
  return out;
}

function wireAttachUI(ctx, attachBtnId, fileInputId, dropZoneEl, textareaEl) {
  const btn = document.getElementById(attachBtnId);
  const input = document.getElementById(fileInputId);
  btn.addEventListener('click', () => input.click());
  input.addEventListener('change', async () => {
    await addFilesToContext(ctx, Array.from(input.files));
    input.value = '';
  });

  dropZoneEl.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropZoneEl.classList.add('drag-over');
  });
  dropZoneEl.addEventListener('dragleave', () => dropZoneEl.classList.remove('drag-over'));
  dropZoneEl.addEventListener('drop', async (e) => {
    e.preventDefault();
    dropZoneEl.classList.remove('drag-over');
    if (e.dataTransfer && e.dataTransfer.files.length) await addFilesToContext(ctx, Array.from(e.dataTransfer.files));
  });

  // Pasted images (e.g. a copied screenshot) arrive as clipboard files, not
  // text — text pastes go through untouched.
  textareaEl.addEventListener('paste', async (e) => {
    const items = e.clipboardData && e.clipboardData.items;
    if (!items) return;
    const files = [];
    for (const item of items) {
      if (item.kind === 'file') {
        const f = item.getAsFile();
        if (f) files.push(f);
      }
    }
    if (files.length) {
      e.preventDefault();
      await addFilesToContext(ctx, files);
    }
  });
}

// ===========================================================================
// @-mention / slash-command autocomplete
// ===========================================================================

/**
 * Wires a floating suggestion list onto `textarea`: typing "@" anywhere
 * offers files under `getFileRoot()`; typing "/" at the very start of the
 * message (matching how Claude Code itself treats slash commands) offers
 * `getSlashCommands()`. Returns a controller whose `handleKeydown` the
 * textarea's own keydown handler should consult first, so Enter/Tab/Arrows
 * navigate the list instead of submitting while it's open.
 */
function createAutocomplete(textarea, list, getFileRoot, getSlashCommands) {
  const state = { trigger: null, start: -1, items: [], activeIndex: 0 };

  function close() {
    state.trigger = null;
    list.hidden = true;
    list.innerHTML = '';
  }

  function renderList() {
    list.innerHTML = '';
    if (!state.items.length) {
      close();
      return;
    }
    list.hidden = false;
    state.items.forEach((item, idx) => {
      const row = el('div', 'suggest-item' + (idx === state.activeIndex ? ' active' : ''));
      row.appendChild(el('span', 'suggest-main', item.main));
      if (item.sub) row.appendChild(el('span', 'suggest-sub', item.sub));
      // mousedown (not click) fires before the textarea's blur, so the
      // selection lands before our blur-triggered close() can beat it.
      row.addEventListener('mousedown', (e) => {
        e.preventDefault();
        select(idx);
      });
      list.appendChild(row);
    });
  }

  function select(idx) {
    const item = state.items[idx];
    if (!item || state.start < 0) return;
    const value = textarea.value;
    const before = value.slice(0, state.start);
    const after = value.slice(textarea.selectionStart);
    const inserted = state.trigger + item.insertText + ' ';
    textarea.value = before + inserted + after;
    const caret = (before + inserted).length;
    textarea.setSelectionRange(caret, caret);
    close();
    autoResize(textarea);
    textarea.focus();
  }

  async function updateSuggestions() {
    const value = textarea.value;
    const caret = textarea.selectionStart;
    let start = caret;
    while (start > 0 && !/\s/.test(value[start - 1])) start--;
    const word = value.slice(start, caret);
    const trigger = word[0];
    if (trigger !== '@' && trigger !== '/') {
      close();
      return;
    }
    if (trigger === '/' && start !== 0) {
      close();
      return;
    }
    const fragment = word.slice(1).toLowerCase();
    state.trigger = trigger;
    state.start = start;
    state.activeIndex = 0;

    if (trigger === '@') {
      const root = getFileRoot();
      if (!root) {
        close();
        return;
      }
      const files = await window.lingui.listFiles(root);
      // Bail if the trigger word changed while listFiles() was in flight.
      if (textarea.value.slice(start, textarea.selectionStart) !== word) return;
      state.items = files
        .filter((f) => f.toLowerCase().includes(fragment))
        .slice(0, 30)
        .map((f) => ({ main: f, insertText: f }));
    } else {
      state.items = getSlashCommands()
        .filter((c) => c.name.toLowerCase().includes(fragment))
        .slice(0, 30)
        .map((c) => ({ main: '/' + c.name, sub: c.desc, insertText: c.name }));
    }
    renderList();
  }

  textarea.addEventListener('input', updateSuggestions);
  textarea.addEventListener('blur', () => setTimeout(close, 120));

  return {
    handleKeydown(e) {
      if (list.hidden) return false;
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        state.activeIndex = Math.min(state.activeIndex + 1, state.items.length - 1);
        renderList();
        return true;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        state.activeIndex = Math.max(state.activeIndex - 1, 0);
        renderList();
        return true;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        select(state.activeIndex);
        return true;
      }
      if (e.key === 'Escape') {
        close();
        return true;
      }
      return false;
    },
  };
}

// ===========================================================================
// Sending messages
// ===========================================================================

async function sendFromWelcome() {
  const text = document.getElementById('welcomeTextarea').value.trim();
  const attachments = welcomeAttachCtx.attachments;
  if (!text && !attachments.length) return;
  const model = document.getElementById('welcomeModelSelect').value;
  const permissionMode = document.getElementById('welcomePermSelect').value;

  if (permissionMode === 'bypassPermissions' && welcomeMode !== 'cloud') {
    const ok = confirm(
      'Full access mode lets Claude run commands and edit files without asking for approval. Only use this in a directory you trust.\n\nContinue?'
    );
    if (!ok) return;
  }

  let chat;

  if (welcomeMode === 'cloud') {
    const target = document.getElementById('cloudSessionInput').value.trim();
    if (!target) {
      alert('Paste a cloud session ID or claude.ai/code URL first.');
      return;
    }
    chat = createChat({ cwd: homeDirPath, model, permissionMode, mode: 'cloud', cloudTarget: target });
  } else if (welcomeMode === 'new') {
    const name = document.getElementById('newProjectName').value.trim();
    const location = document.getElementById('newProjectLocationLabel').dataset.path;
    if (!name || !location) {
      alert('Give the project a name and a location first.');
      return;
    }
    const result = await window.lingui.createProjectDirectory(location, name);
    if (!result.ok) {
      alert(result.error || "Couldn't create that folder.");
      return;
    }
    chat = createChat({ cwd: result.path, model, permissionMode });
    window.lingui.setSettings({ lastNewProjectLocation: location });
    saveProjectDefaults(result.path, model, permissionMode);
  } else {
    const cwd = document.getElementById('welcomeDirLabel').dataset.path;
    if (!cwd) {
      alert('Choose a working directory first.');
      return;
    }
    chat = createChat({ cwd, model, permissionMode });
    window.lingui.setSettings({ lastCwd: cwd });
    saveProjectDefaults(cwd, model, permissionMode);
  }

  await window.lingui.upsertChat(chat);
  window.lingui.setSettings({ lastModel: model, lastPermissionMode: permissionMode });

  await openChat(chat.id);
  await dispatchUserMessage(chat.id, text, attachments);
  clearAttachments(welcomeAttachCtx);
}

function setWelcomeMode(mode) {
  welcomeMode = mode;
  document.querySelectorAll('.mode-tab').forEach((tab) => tab.classList.toggle('active', tab.dataset.mode === mode));
  document.getElementById('modePane-folder').hidden = mode !== 'folder';
  document.getElementById('modePane-new').hidden = mode !== 'new';
  document.getElementById('modePane-cloud').hidden = mode !== 'cloud';
  // Permission mode is meaningless once Claude is running in a cloud
  // sandbox we don't control locally — hide the picker in that mode.
  document.getElementById('modePane-permissions').hidden = mode === 'cloud';
  // Attachments need a local `claude` process (stream-json input) — cloud
  // sends are a plain-text one-shot CLI call and can't carry content blocks.
  document.getElementById('welcomeAttachBtn').hidden = mode === 'cloud';
  if (mode === 'cloud') clearAttachments(welcomeAttachCtx);
}

function updateNewProjectPreview() {
  const name = document.getElementById('newProjectName').value.trim();
  const location = document.getElementById('newProjectLocationLabel').dataset.path || '';
  const preview = document.getElementById('newProjectPreview');
  preview.textContent = name && location ? `${location.replace(/\/+$/, '')}/${name}` : '';
}

async function sendFromComposer() {
  const ta = document.getElementById('composerTextarea');
  const text = ta.value.trim();
  const attachments = composerAttachCtx.attachments;
  if ((!text && !attachments.length) || !activeChatId) return;
  ta.value = '';
  autoResize(ta);
  await dispatchUserMessage(activeChatId, text, attachments);
  clearAttachments(composerAttachCtx);
}

async function dispatchUserMessage(chatId, text, attachments) {
  const chat = chats.get(chatId);
  if (!chat || chat.busy) return;
  const atts = attachments || [];
  if (!text && !atts.length) return;

  const block = { id: newId(), kind: 'user', text, attachments: atts.length ? atts.map(attachmentForBlock) : undefined };
  chat.blocks.push(block);
  chat.busy = true;
  chat.busyLabel = '● Sending…';
  chat.updatedAt = Date.now();
  if (!chat.title || chat.title === 'New chat') chat.title = deriveTitle(text || atts[0].name);

  if (text) pushComposerHistory(chatId, text);

  if (chatId === activeChatId) {
    appendBlockToDom(block);
    document.getElementById('chatTitle').textContent = chat.title;
    updateComposerBusyState(chat);
    updateStatusBar(chat);
  }
  scheduleSave(chatId);
  refreshSidebarList();

  const res = await window.lingui.sendMessage(chatId, text, {
    cwd: chat.cwd,
    model: chat.model,
    permissionMode: chat.permissionMode,
    resumeSessionId: chat.sessionId || undefined,
    cloudTarget: chat.mode === 'cloud' ? chat.cloudTarget || chat.sessionId : undefined,
    attachments: atts.length ? atts.map(attachmentForIpc) : undefined,
  });

  if (!res.ok) {
    chat.busy = false;
    if (chatId === activeChatId) {
      updateComposerBusyState(chat);
      showBanner(res.error || 'Failed to reach the Claude CLI.', true, () => dispatchUserMessage(chatId, text, attachments));
    }
  }
}

function deriveTitle(text) {
  const words = text.trim().split(/\s+/).slice(0, 8).join(' ');
  return words.length > 60 ? words.slice(0, 60) + '…' : words;
}

function showBanner(message, isError, onRetry) {
  const messagesEl = document.getElementById('messages');
  const banner = el('div', 'banner' + (isError ? ' banner-error' : ''));
  banner.appendChild(document.createTextNode(message));
  if (onRetry) {
    const btn = el('button', 'banner-retry-btn', 'Retry');
    btn.type = 'button';
    btn.addEventListener('click', onRetry);
    banner.appendChild(btn);
  }
  messagesEl.appendChild(banner);
  scrollMessagesToBottom(false);
}

// ===========================================================================
// Composer UI state
// ===========================================================================

function updateComposerBusyState(chat) {
  const sendBtn = document.getElementById('composerSendBtn');
  const stopBtn = document.getElementById('stopBtn');
  const ta = document.getElementById('composerTextarea');
  const busy = !!(chat && chat.busy);
  sendBtn.hidden = busy;
  stopBtn.hidden = !busy;
  ta.disabled = busy;
  if (chat) updateLastUserMessageActions(chat);
}

function updateStatusBar(chat) {
  const statusEl = document.getElementById('chatStatus');
  if (!chat) {
    statusEl.textContent = '';
    return;
  }
  if (chat.busy) {
    statusEl.textContent = chat.busyLabel || '● Working…';
    return;
  }
  if (chat.lastStatus) {
    const { seconds, cost, turns } = chat.lastStatus;
    const parts = [];
    if (seconds != null) parts.push(`${seconds}s`);
    if (cost != null) parts.push(`$${cost}`);
    if (turns != null) parts.push(`${turns} turn${turns === 1 ? '' : 's'}`);
    statusEl.textContent = parts.join(' · ');
  } else {
    statusEl.textContent = '';
  }
}

function autoResize(ta) {
  ta.style.height = 'auto';
  ta.style.height = Math.min(ta.scrollHeight, 200) + 'px';
}

// ===========================================================================
// Streaming event handling
// ===========================================================================

/** Per-chat transient map of the in-flight assistant turn's blocks, keyed by content index. */
const liveTurns = new Map(); // chatId -> Map<index, block>

function handleSessionEvent(localId, evt) {
  const chat = chats.get(localId);
  if (!chat) return; // stray event for a chat we don't know about (shouldn't happen)

  switch (evt.type) {
    case 'system': {
      if (evt.subtype === 'init' && evt.session_id) chat.sessionId = evt.session_id;
      // Feeds the "/" command palette with whatever this session actually
      // has available (built-ins plus any plugin-provided commands) instead
      // of a hardcoded guess.
      if (evt.subtype === 'init' && Array.isArray(evt.slash_commands)) chat.slashCommands = evt.slash_commands;
      break;
    }

    case 'stream_event': {
      handleStreamEvent(chat, evt.event);
      break;
    }

    case 'assistant': {
      finalizeAssistantMessage(chat, evt.message);
      break;
    }

    case 'user': {
      applyToolResults(chat, evt.message);
      break;
    }

    case 'result': {
      chat.busy = false;
      chat.busyLabel = null;
      liveTurns.delete(chat.id);
      chat.lastStatus = {
        seconds: evt.duration_api_ms != null ? (evt.duration_api_ms / 1000).toFixed(1) : null,
        cost: evt.total_cost_usd != null ? evt.total_cost_usd.toFixed(4) : null,
        turns: evt.num_turns ?? null,
      };
      // `total_cost_usd` is already the running total for this CLI session
      // (not a per-turn delta), so store — don't accumulate — it for the
      // cost dashboard.
      if (evt.total_cost_usd != null) chat.totalCostUsd = evt.total_cost_usd;
      if (evt.subtype && evt.subtype !== 'success') {
        showBannerIfActive(chat, `Claude stopped: ${evt.subtype}${evt.result ? ' — ' + evt.result : ''}`, true, () => resendLastMessage(chat.id));
      }
      chat.updatedAt = Date.now();
      if (chat.id === activeChatId) {
        updateComposerBusyState(chat);
        updateStatusBar(chat);
      }
      scheduleSave(chat.id);
      refreshSidebarList();
      break;
    }

    case 'cloud_message_result': {
      chat.busy = false;
      chat.busyLabel = null;
      if (evt.session_id) chat.sessionId = evt.session_id;
      const block = { id: newId(), kind: 'cloud-ack', ok: evt.ok, url: evt.url, error: evt.error };
      chat.blocks.push(block);
      if (chat.id === activeChatId) {
        appendBlockToDom(block);
        updateComposerBusyState(chat);
        updateStatusBar(chat);
      }
      chat.updatedAt = Date.now();
      scheduleSave(chat.id);
      refreshSidebarList();
      break;
    }

    default:
      break; // system/status, rate_limit_event, etc. — nothing to render
  }
}

function turnMapFor(chat) {
  let map = liveTurns.get(chat.id);
  if (!map) {
    map = new Map();
    liveTurns.set(chat.id, map);
  }
  return map;
}

// NOTE ON PROTOCOL QUIRK: the top-level "assistant" stream-json event does
// NOT carry a cumulative, index-matched content array — Claude Code emits
// one "assistant" event per finished content block, each as a one-element
// array reset to position 0. So finalized content can't be matched back to
// a stream_event content index by array position. Instead, the stream
// deltas (content_block_start/delta/stop) are treated as the sole source of
// truth for block content; "assistant" events are only used as a fallback
// for the (unexpected) case where no partial events arrived at all for a
// turn — see finalizeAssistantMessage below.

function handleStreamEvent(chat, event) {
  if (!event) return;
  const turn = turnMapFor(chat);

  if (event.type === 'message_start') {
    turn.clear();
    turn.sawBlock = false;
    chat.busyLabel = '● Thinking…';
    if (chat.id === activeChatId) updateStatusBar(chat);
    return;
  }

  if (event.type === 'content_block_start') {
    const cb = event.content_block;
    if (!cb) return;
    let block;
    if (cb.type === 'text') {
      block = { id: newId(), kind: 'text', text: cb.text || '', streaming: true };
    } else if (cb.type === 'thinking') {
      block = { id: newId(), kind: 'thinking', text: cb.thinking || '', streaming: true };
    } else if (cb.type === 'tool_use') {
      block = {
        id: newId(),
        kind: 'tool',
        toolUseId: cb.id,
        name: cb.name,
        input: cb.input || {},
        inputText: '',
        _rawInput: '',
        status: 'running',
        resultText: '',
      };
      chat.busyLabel = `● Running ${cb.name}…`;
      if (chat.id === activeChatId) updateStatusBar(chat);
    } else {
      return;
    }
    turn.sawBlock = true;
    turn.set(event.index, block);
    chat.blocks.push(block);
    if (chat.id === activeChatId) appendBlockToDom(block);
    return;
  }

  if (event.type === 'content_block_delta') {
    const block = turn.get(event.index);
    if (!block) return;
    const delta = event.delta || {};
    if (delta.type === 'text_delta') {
      block.text = (block.text || '') + (delta.text || '');
      if (chat.id === activeChatId) markTextBlockDirty(block.id);
    } else if (delta.type === 'thinking_delta') {
      block.text = (block.text || '') + (delta.thinking || '');
      if (chat.id === activeChatId) markTextBlockDirty(block.id);
    } else if (delta.type === 'input_json_delta') {
      block._rawInput = (block._rawInput || '') + (delta.partial_json || '');
      block.inputText = block._rawInput;
      if (chat.id === activeChatId) markTextBlockDirty(block.id);
    }
    return;
  }

  if (event.type === 'content_block_stop') {
    const block = turn.get(event.index);
    if (!block) return;
    if (block.kind === 'text' || block.kind === 'thinking') {
      block.streaming = false;
    } else if (block.kind === 'tool') {
      // The streamed input arrives as a raw partial-JSON string; now that
      // the block is complete it should parse cleanly.
      try {
        block.input = block._rawInput ? JSON.parse(block._rawInput) : {};
        block.inputText = JSON.stringify(block.input, null, 2);
      } catch {
        // Leave the raw accumulated text as a best-effort display.
      }
      delete block._rawInput;
    }
    if (chat.id === activeChatId) renderBlockNode(block);
    scheduleSave(chat.id);
    return;
  }
}

/**
 * Fallback only: reconstructs blocks straight from a final "assistant"
 * message when no stream_events were seen for this turn at all (e.g. an
 * older CLI without --include-partial-messages support). When partial
 * events did arrive, this is a deliberate no-op — see the note above.
 */
function finalizeAssistantMessage(chat, message) {
  const turn = turnMapFor(chat);
  if (turn.sawBlock) return;
  if (!message || !Array.isArray(message.content)) return;

  for (const cb of message.content) {
    let block;
    if (cb.type === 'text') {
      block = { id: newId(), kind: 'text', text: cb.text || '', streaming: false };
    } else if (cb.type === 'thinking') {
      block = { id: newId(), kind: 'thinking', text: cb.thinking || '', streaming: false };
    } else if (cb.type === 'tool_use') {
      block = {
        id: newId(),
        kind: 'tool',
        toolUseId: cb.id,
        name: cb.name,
        input: cb.input || {},
        inputText: JSON.stringify(cb.input || {}, null, 2),
        status: 'running',
        resultText: '',
      };
    } else {
      continue;
    }
    chat.blocks.push(block);
    if (chat.id === activeChatId) appendBlockToDom(block);
  }

  chat.updatedAt = Date.now();
  scheduleSave(chat.id);
}

function applyToolResults(chat, message) {
  if (!message || !Array.isArray(message.content)) return;
  for (const item of message.content) {
    if (!item || item.type !== 'tool_result') continue;
    const block = [...chat.blocks].reverse().find((b) => b.kind === 'tool' && b.toolUseId === item.tool_use_id);
    if (!block) continue;
    block.status = item.is_error ? 'error' : 'done';
    block.resultText = stringifyToolResult(item.content);
    if (chat.id === activeChatId) renderBlockNode(block);
  }
  scheduleSave(chat.id);
}

function showBannerIfActive(chat, message, isError, onRetry) {
  if (chat.id === activeChatId) showBanner(message, isError, onRetry);
}

// ===========================================================================
// Theme
// ===========================================================================

function applyTheme(theme) {
  const root = document.documentElement;
  if (theme === 'light' || theme === 'dark') {
    root.setAttribute('data-theme', theme);
  } else {
    root.removeAttribute('data-theme');
  }
  const dark = theme === 'dark' || (theme !== 'light' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.getElementById('hljsLight').disabled = dark;
  document.getElementById('hljsDark').disabled = !dark;
  document.getElementById('themeToggleText').textContent = theme === 'system' || !theme ? 'Theme: System' : theme === 'dark' ? 'Theme: Dark' : 'Theme: Light';
  applyAccentColor(settings.accentColor || ACCENT_SWATCHES[0].name);
}

function cycleTheme() {
  const order = ['system', 'light', 'dark'];
  const current = settings.theme || 'system';
  const next = order[(order.indexOf(current) + 1) % order.length];
  settings.theme = next;
  window.lingui.setSettings({ theme: next });
  applyTheme(next);
}

// ===========================================================================
// Accent color
// ===========================================================================

function hexToRgb(hex) {
  const h = hex.replace('#', '');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}
function rgbToHex(rgb) {
  return '#' + rgb.map((v) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, '0')).join('');
}
function mixHex(hexA, hexB, t) {
  const a = hexToRgb(hexA);
  const b = hexToRgb(hexB);
  return rgbToHex(a.map((v, i) => v + (b[i] - v) * t));
}

/** Overrides the CSS accent tokens with the chosen swatch, computed for the currently active light/dark theme. */
function applyAccentColor(name) {
  const swatch = ACCENT_SWATCHES.find((s) => s.name === name) || ACCENT_SWATCHES[0];
  const dark =
    document.documentElement.getAttribute('data-theme') === 'dark' ||
    (document.documentElement.getAttribute('data-theme') !== 'light' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  const base = dark ? swatch.dark : swatch.light;
  const style = document.documentElement.style;
  style.setProperty('--accent', base);
  style.setProperty('--accent-hover', dark ? mixHex(base, '#ffffff', 0.16) : mixHex(base, '#000000', 0.12));
  style.setProperty('--accent-soft', dark ? mixHex(base, '#000000', 0.78) : mixHex(base, '#ffffff', 0.83));
}

function setAccentColor(name) {
  settings.accentColor = name;
  window.lingui.setSettings({ accentColor: name });
  applyAccentColor(name);
  renderAccentSwatches();
}

function renderAccentSwatches() {
  const row = document.getElementById('accentSwatchRow');
  if (!row) return;
  row.innerHTML = '';
  const current = settings.accentColor || ACCENT_SWATCHES[0].name;
  for (const swatch of ACCENT_SWATCHES) {
    const btn = el('button', 'color-swatch' + (swatch.name === current ? ' active' : ''));
    btn.type = 'button';
    btn.title = swatch.name;
    btn.style.background = `linear-gradient(135deg, ${swatch.light}, ${swatch.dark})`;
    btn.addEventListener('click', () => setAccentColor(swatch.name));
    row.appendChild(btn);
  }
}

// ===========================================================================
// Account / native login
// ===========================================================================

let authLoginActive = false;
let authLoginOutput = '';
let authLoginLastUrl = null;

function setAuthPane(name) {
  for (const pane of ['loading', 'signedin', 'signedout', 'login']) {
    document.getElementById(`authPane-${pane}`).hidden = pane !== name;
  }
}

function subscriptionLabel(data) {
  const parts = [];
  if (data.subscriptionType) parts.push(data.subscriptionType);
  if (data.authMethod) parts.push(data.authMethod === 'claude.ai' ? 'Claude account' : data.authMethod);
  return parts.join(' · ');
}

/** Refreshes the sidebar footer button; does not touch the modal. */
function refreshAccountButton(status) {
  const dot = document.getElementById('accountStatusDot');
  const text = document.getElementById('accountStatusText');
  dot.className = 'status-dot';
  if (status.ok && status.data.loggedIn) {
    dot.classList.add('ok');
    text.textContent = status.data.email || 'Signed in';
  } else {
    text.textContent = 'Sign in';
  }
}

async function fetchAuthStatus() {
  const status = await window.lingui.authStatus();
  refreshAccountButton(status);
  return status;
}

function renderAuthStatusPane(status) {
  if (status.ok && status.data.loggedIn) {
    document.getElementById('authEmail').textContent = status.data.email || 'Signed in';
    document.getElementById('authSub').textContent = subscriptionLabel(status.data);
    setAuthPane('signedin');
  } else {
    const errEl = document.getElementById('authSignedOutError');
    if (!status.ok && status.error) {
      errEl.textContent = status.error;
      errEl.hidden = false;
    } else {
      errEl.hidden = true;
    }
    setAuthPane('signedout');
  }
}

async function openAuthModal() {
  document.getElementById('authModalOverlay').hidden = false;
  if (authLoginActive) {
    setAuthPane('login');
    return;
  }
  setAuthPane('loading');
  renderAuthStatusPane(await fetchAuthStatus());
}

function closeAuthModal() {
  if (authLoginActive) {
    window.lingui.authLoginCancel();
    authLoginActive = false;
  }
  document.getElementById('authModalOverlay').hidden = true;
}

function appendAuthLog(text) {
  authLoginOutput += text;
  const logEl = document.getElementById('authLog');
  logEl.textContent = authLoginOutput;
  logEl.scrollTop = logEl.scrollHeight;

  const urls = authLoginOutput.match(/https:\/\/\S+/g);
  if (urls && urls.length) {
    authLoginLastUrl = urls[urls.length - 1];
    const btn = document.getElementById('authOpenLinkBtn');
    btn.hidden = false;
  }
}

async function startAuthLogin(method) {
  authLoginActive = true;
  authLoginOutput = '';
  authLoginLastUrl = null;
  document.getElementById('authLog').textContent = '';
  document.getElementById('authOpenLinkBtn').hidden = true;
  document.getElementById('authCodeInput').value = '';
  setAuthPane('login');
  await window.lingui.authLoginStart(method);
}

async function submitAuthCode() {
  const input = document.getElementById('authCodeInput');
  const code = input.value.trim();
  if (!code) return;
  await window.lingui.authLoginSubmitCode(code);
  appendAuthLog(`\n› Submitted code, waiting…\n`);
  input.value = '';
}

async function cancelAuthLogin() {
  await window.lingui.authLoginCancel();
  authLoginActive = false;
  renderAuthStatusPane(await fetchAuthStatus());
}

async function logoutOfAccount() {
  const result = await window.lingui.authLogout();
  if (!result.ok) {
    alert(result.error || "Couldn't log out.");
    return;
  }
  renderAuthStatusPane(await fetchAuthStatus());
}

// ===========================================================================
// Tools panel — machine-wide agents, past sessions, MCP servers, plugins,
// a local cost rollup, and app settings (accent color, hotkey).
// ===========================================================================

let toolsActiveTab = 'agents';

function toolListItem({ title, sub, actions }) {
  const item = el('div', 'tool-list-item');
  const main = el('div', 'tool-list-item-main');
  main.appendChild(el('div', 'tool-list-item-title', title));
  if (sub) main.appendChild(el('div', 'tool-list-item-sub', sub));
  item.appendChild(main);
  if (actions && actions.length) {
    const actionsEl = el('div', 'tool-list-item-actions');
    for (const a of actions) {
      const btn = el('button', a.danger ? 'danger' : '', a.label);
      btn.type = 'button';
      btn.addEventListener('click', a.onClick);
      actionsEl.appendChild(btn);
    }
    item.appendChild(actionsEl);
  }
  return item;
}

async function loadAgentsTab() {
  const container = document.getElementById('agentsList');
  container.innerHTML = 'Loading…';
  const res = await window.lingui.agentsList();
  container.innerHTML = '';
  if (!res.ok) {
    container.appendChild(el('p', 'empty-hint', res.error || "Couldn't list agents."));
    return;
  }
  if (!res.data.length) {
    container.appendChild(el('p', 'empty-hint', 'No active or background Claude Code sessions right now.'));
    return;
  }
  for (const agent of res.data) {
    const actions = [];
    if (agent.kind === 'background') {
      actions.push({
        label: 'Stop',
        onClick: async () => {
          await window.lingui.agentsStop(agent.name);
          loadAgentsTab();
        },
      });
      actions.push({
        label: 'Remove',
        danger: true,
        onClick: async () => {
          if (!confirm(`Remove background session "${agent.name}"? This deletes it (and its worktree, if safe).`)) return;
          await window.lingui.agentsRemove(agent.name);
          loadAgentsTab();
        },
      });
    }
    container.appendChild(
      toolListItem({
        title: `${agent.name || agent.sessionId} — ${agent.kind}`,
        sub: `${baseName(agent.cwd)} · started ${relativeTime(agent.startedAt)}`,
        actions,
      })
    );
  }
}

async function loadSessionsTab() {
  const container = document.getElementById('sessionsList');
  const chat = chats.get(activeChatId);
  container.innerHTML = '';
  if (!chat || chat.mode === 'cloud') {
    container.appendChild(el('p', 'empty-hint', 'Open a local chat first — sessions are listed per working directory.'));
    return;
  }
  container.innerHTML = 'Loading…';
  const sessions = await window.lingui.projectSessions(chat.cwd);
  container.innerHTML = '';
  if (!sessions.length) {
    container.appendChild(el('p', 'empty-hint', `No past sessions found for ${chat.cwd}.`));
    return;
  }
  for (const s of sessions) {
    container.appendChild(
      toolListItem({
        title: s.preview || s.sessionId,
        sub: relativeTime(s.mtime),
        actions: [
          {
            label: 'Resume in new chat',
            onClick: async () => {
              const newChat = createChat({ cwd: chat.cwd, model: chat.model, permissionMode: chat.permissionMode });
              newChat.sessionId = s.sessionId;
              newChat.title = s.preview ? deriveTitle(s.preview) : 'Resumed chat';
              await window.lingui.upsertChat(newChat);
              closeToolsModal();
              await openChat(newChat.id);
            },
          },
        ],
      })
    );
  }
}

async function loadMcpTab() {
  const textEl = document.getElementById('mcpListText');
  textEl.textContent = 'Loading…';
  const res = await window.lingui.mcpList();
  textEl.textContent = res.ok ? res.text : res.error || "Couldn't reach the Claude CLI.";
}

async function loadPluginsTab() {
  const container = document.getElementById('pluginsList');
  container.innerHTML = 'Loading…';
  const res = await window.lingui.pluginList();
  container.innerHTML = '';
  if (!res.ok) {
    container.appendChild(el('p', 'empty-hint', res.error || "Couldn't list plugins."));
    return;
  }
  if (!res.data.length) {
    container.appendChild(el('p', 'empty-hint', 'No plugins installed.'));
    return;
  }
  for (const p of res.data) {
    const enabled = p.enabled !== false;
    container.appendChild(
      toolListItem({
        title: p.name,
        sub: enabled ? 'Enabled' : 'Disabled',
        actions: [
          {
            label: enabled ? 'Disable' : 'Enable',
            onClick: async () => {
              await (enabled ? window.lingui.pluginDisable(p.name) : window.lingui.pluginEnable(p.name));
              loadPluginsTab();
            },
          },
        ],
      })
    );
  }
}

async function loadCostTab() {
  const container = document.getElementById('costSummary');
  container.innerHTML = 'Loading…';
  const chatsList = await window.lingui.listChats();
  container.innerHTML = '';
  // Chats saved before cost tracking existed only have the older
  // `lastStatus.cost` string (that turn's total, same number) — fall back
  // to it so history isn't blank.
  const costOf = (c) => (c.totalCostUsd != null ? c.totalCostUsd : c.lastStatus && c.lastStatus.cost != null ? parseFloat(c.lastStatus.cost) : null);
  const withCost = chatsList.map((c) => ({ c, cost: costOf(c) })).filter(({ cost }) => cost != null && !Number.isNaN(cost));
  withCost.sort((a, b) => b.cost - a.cost);
  if (!withCost.length) {
    container.appendChild(el('p', 'empty-hint', 'No cost data yet — it fills in as chats run turns.'));
    return;
  }
  let total = 0;
  for (const { c, cost } of withCost) {
    total += cost;
    const row = el('div', 'cost-row');
    row.appendChild(el('span', null, c.title || 'New chat'));
    row.appendChild(el('span', 'amount', `$${cost.toFixed(4)}`));
    container.appendChild(row);
  }
  const totalRow = el('div', 'cost-row cost-total');
  totalRow.appendChild(el('span', null, `Total across ${withCost.length} chat${withCost.length === 1 ? '' : 's'}`));
  totalRow.appendChild(el('span', 'amount', `$${total.toFixed(4)}`));
  container.appendChild(totalRow);
}

function loadSettingsTab() {
  renderAccentSwatches();
  const hotkeyInput = document.getElementById('hotkeyInput');
  hotkeyInput.value = settings.trayHotkey || 'Control+Alt+Space';
  document.getElementById('updateStatus').textContent = '';
  loadLoginItemState();
}

const TOOLS_TAB_LOADERS = {
  agents: loadAgentsTab,
  sessions: loadSessionsTab,
  mcp: loadMcpTab,
  plugins: loadPluginsTab,
  cost: loadCostTab,
  settings: loadSettingsTab,
};

function setToolsTab(tab) {
  toolsActiveTab = tab;
  document.querySelectorAll('#toolsTabs .modal-tab').forEach((btn) => btn.classList.toggle('active', btn.dataset.tab === tab));
  for (const name of Object.keys(TOOLS_TAB_LOADERS)) {
    document.getElementById(`toolsPane-${name}`).hidden = name !== tab;
  }
  TOOLS_TAB_LOADERS[tab]();
}

function openToolsModal() {
  document.getElementById('toolsModalOverlay').hidden = false;
  setToolsTab(toolsActiveTab);
}

function closeToolsModal() {
  document.getElementById('toolsModalOverlay').hidden = true;
}

// ===========================================================================
// CLAUDE.md editor
// ===========================================================================

async function openClaudeMdModal() {
  const chat = chats.get(activeChatId);
  if (!chat || chat.mode === 'cloud') return;
  document.getElementById('claudeMdOverlay').hidden = false;
  document.getElementById('claudeMdPath').textContent = `${chat.cwd}/CLAUDE.md`;
  const editor = document.getElementById('claudeMdEditor');
  editor.value = 'Loading…';
  editor.disabled = true;
  const res = await window.lingui.readClaudeMd(chat.cwd);
  editor.disabled = false;
  editor.value = res.ok ? res.text : '';
  if (!res.ok) alert(res.error || "Couldn't read CLAUDE.md.");
}

function closeClaudeMdModal() {
  document.getElementById('claudeMdOverlay').hidden = true;
}

async function saveClaudeMd() {
  const chat = chats.get(activeChatId);
  if (!chat) return;
  const text = document.getElementById('claudeMdEditor').value;
  const res = await window.lingui.writeClaudeMd(chat.cwd, text);
  if (!res.ok) {
    alert(res.error || "Couldn't save CLAUDE.md.");
    return;
  }
  closeClaudeMdModal();
}

// ===========================================================================
// Export chat to Markdown
// ===========================================================================

function chatToMarkdown(chat) {
  const lines = [`# ${chat.title || 'Claude chat'}`, '', `_${chat.mode === 'cloud' ? 'Cloud session' : chat.cwd} · exported ${new Date().toLocaleString()}_`, ''];
  for (const block of chat.blocks || []) {
    if (block.kind === 'user') {
      lines.push('## You', '', block.text || '', '');
      for (const a of block.attachments || []) lines.push(`_Attached: ${a.name}_`);
      if (block.attachments && block.attachments.length) lines.push('');
    } else if (block.kind === 'text') {
      lines.push(block.text || '', '');
    } else if (block.kind === 'thinking') {
      lines.push('<details><summary>Thinking</summary>', '', block.text || '', '', '</details>', '');
    } else if (block.kind === 'tool') {
      lines.push(`**${block.name}**${block.inputText ? `: \`${block.inputText.slice(0, 120).replace(/\n/g, ' ')}\`` : ''}`, '');
      if (block.resultText) lines.push('```', block.resultText.slice(0, 4000), '```', '');
    }
  }
  return lines.join('\n');
}

async function exportActiveChat() {
  const chat = chats.get(activeChatId);
  if (!chat) return;
  const markdown = chatToMarkdown(chat);
  const defaultName = `${(chat.title || 'chat').replace(/[^\w\- ]+/g, '').trim() || 'chat'}.md`;
  const res = await window.lingui.exportChat(defaultName, markdown);
  if (!res.ok && !res.canceled) alert(res.error || "Couldn't export this chat.");
}

// ===========================================================================
// Message actions — copy, edit & resend, regenerate ("ask again")
// ===========================================================================

function lastUserBlock(chat) {
  for (let i = chat.blocks.length - 1; i >= 0; i--) {
    if (chat.blocks[i].kind === 'user') return chat.blocks[i];
  }
  return null;
}

/** Marks the last user message and everything after it as superseded (collapsed on next render) — shared by Regenerate and Edit & resend. */
function supersedeFromLastUserMessage(chat) {
  const block = lastUserBlock(chat);
  if (!block) return null;
  const idx = chat.blocks.indexOf(block);
  for (let i = idx; i < chat.blocks.length; i++) chat.blocks[i].superseded = true;
  return block;
}

/**
 * Resends the chat's last user message as a fresh turn. Text-only: a
 * message with attachments can't be reconstructed from persisted history
 * (attachmentForBlock deliberately drops the base64/text payload to keep
 * the store small — see its comment), so those are left alone rather than
 * silently sent without their attachments.
 */
function resendLastMessage(chatId) {
  const chat = chats.get(chatId);
  if (!chat || chat.busy) return;
  const block = lastUserBlock(chat);
  if (!block || (block.attachments && block.attachments.length)) return;
  dispatchUserMessage(chatId, block.text);
}

function regenerateLastResponse(chatId) {
  const chat = chats.get(chatId);
  if (!chat || chat.busy) return;
  const block = lastUserBlock(chat);
  if (!block || (block.attachments && block.attachments.length)) return;
  const text = block.text;
  if (!supersedeFromLastUserMessage(chat)) return;
  if (chatId === activeChatId) renderChatFull(chat);
  dispatchUserMessage(chatId, text);
}

function editAndResendLastMessage(chatId, newText) {
  const chat = chats.get(chatId);
  const text = newText.trim();
  if (!chat || chat.busy || !text) return;
  if (!supersedeFromLastUserMessage(chat)) return;
  if (chatId === activeChatId) renderChatFull(chat);
  dispatchUserMessage(chatId, text);
}

/** Shows Edit/Regenerate only on the chat's last user message, and only when there's something safe to act on (not busy, no attachments, not a cloud one-shot). */
function updateLastUserMessageActions(chat) {
  if (!chat || chat.id !== activeChatId) return;
  const last = lastUserBlock(chat);
  const eligible = last && !chat.busy && chat.mode !== 'cloud' && !(last.attachments && last.attachments.length);
  document.querySelectorAll('#messages > .msg-user .bubble-user').forEach((bubble) => {
    const isLast = eligible && bubble.dataset.blockId === last.id;
    bubble.querySelector('.msg-edit-btn').classList.toggle('unavailable', !isLast);
    bubble.querySelector('.msg-regen-btn').classList.toggle('unavailable', !isLast);
  });
}

async function copyToClipboard(text, btn) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    return;
  }
  if (!btn) return;
  const original = btn.innerHTML;
  btn.classList.add('copied');
  btn.innerHTML = '<svg viewBox="0 0 24 24" width="13" height="13"><path d="M5 12l5 5 9-9" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  setTimeout(() => {
    btn.classList.remove('copied');
    btn.innerHTML = original;
  }, 1200);
}

function startEditingUserMessage(bubble, chatId, blockId) {
  const chat = chats.get(chatId);
  const block = chat && chat.blocks.find((b) => b.id === blockId);
  if (!block) return;
  const textEl = bubble.querySelector('.bubble-text');
  const original = block.text || '';

  const ta = document.createElement('textarea');
  ta.className = 'bubble-edit-textarea';
  ta.value = original;
  textEl.replaceWith(ta);
  bubble.classList.add('editing');
  ta.focus();
  ta.setSelectionRange(ta.value.length, ta.value.length);
  autoResize(ta);
  ta.addEventListener('input', () => autoResize(ta));

  const actions = document.createElement('div');
  actions.className = 'bubble-edit-actions';
  const saveBtn = el('button', 'bubble-edit-save', 'Save & resend');
  saveBtn.type = 'button';
  const cancelBtn = el('button', 'bubble-edit-cancel', 'Cancel');
  cancelBtn.type = 'button';
  actions.appendChild(cancelBtn);
  actions.appendChild(saveBtn);
  ta.after(actions);

  const finish = (resend) => {
    if (resend && ta.value.trim() && ta.value.trim() !== original) {
      editAndResendLastMessage(chatId, ta.value);
      return; // renderChatFull (from editAndResendLastMessage) rebuilds the DOM
    }
    ta.replaceWith(textEl);
    actions.remove();
    bubble.classList.remove('editing');
  };
  saveBtn.addEventListener('click', () => finish(true));
  cancelBtn.addEventListener('click', () => finish(false));
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      finish(true);
    } else if (e.key === 'Escape') {
      finish(false);
    }
  });
}

/** One delegated click listener covers copy/edit/regenerate on every message, present or future — no per-node wiring needed. */
function wireMessageActionDelegation() {
  document.getElementById('messages').addEventListener('click', (e) => {
    const copyMsgBtn = e.target.closest('.msg-copy-btn');
    if (copyMsgBtn) {
      const bubble = copyMsgBtn.closest('.bubble-user');
      const chat = chats.get(activeChatId);
      const block = chat && chat.blocks.find((b) => b.id === bubble.dataset.blockId);
      if (block) copyToClipboard(block.text || '', copyMsgBtn);
      return;
    }
    const copyBlockBtn = e.target.closest('.block-copy-btn');
    if (copyBlockBtn) {
      const container = copyBlockBtn.closest('.block-text');
      const chat = chats.get(activeChatId);
      const block = chat && chat.blocks.find((b) => b.id === container.dataset.blockId);
      if (block) copyToClipboard(block.text || '', copyBlockBtn);
      return;
    }
    const copyCodeBtn = e.target.closest('.code-copy-btn');
    if (copyCodeBtn) {
      const code = copyCodeBtn.closest('.code-block').querySelector('pre code');
      if (code) copyToClipboard(code.textContent, copyCodeBtn);
      return;
    }
    const editBtn = e.target.closest('.msg-edit-btn');
    if (editBtn && !editBtn.classList.contains('unavailable')) {
      const bubble = editBtn.closest('.bubble-user');
      startEditingUserMessage(bubble, activeChatId, bubble.dataset.blockId);
      return;
    }
    const regenBtn = e.target.closest('.msg-regen-btn');
    if (regenBtn && !regenBtn.classList.contains('unavailable')) {
      regenerateLastResponse(activeChatId);
      return;
    }
    const lightboxImg = e.target.closest('.attachment-thumb');
    if (lightboxImg && lightboxImg.tagName === 'IMG' && lightboxImg.src) {
      openLightbox(lightboxImg.src);
    }
  });
}

// ===========================================================================
// Image lightbox
// ===========================================================================

function openLightbox(src) {
  document.getElementById('lightboxImg').src = src;
  document.getElementById('lightboxOverlay').hidden = false;
}

function closeLightbox() {
  document.getElementById('lightboxOverlay').hidden = true;
  document.getElementById('lightboxImg').src = '';
}

// ===========================================================================
// Composer history (↑/↓ recall, per chat)
// ===========================================================================

const composerHistory = new Map(); // chatId -> string[] (oldest first)
const composerHistoryIndex = new Map(); // chatId -> current browse position, or -1 when not browsing

function pushComposerHistory(chatId, text) {
  const list = composerHistory.get(chatId) || [];
  list.push(text);
  if (list.length > 100) list.shift();
  composerHistory.set(chatId, list);
  composerHistoryIndex.set(chatId, -1);
}

/** Returns true if it handled the key (caller should skip its own handling). */
function handleComposerHistoryKey(e, ta, chatId) {
  const list = composerHistory.get(chatId);
  if (!list || !list.length) return false;
  if (e.key === 'ArrowUp' && ta.selectionStart === 0 && ta.selectionEnd === 0) {
    const idx = composerHistoryIndex.get(chatId) ?? -1;
    const next = Math.min(idx + 1, list.length - 1);
    composerHistoryIndex.set(chatId, next);
    ta.value = list[list.length - 1 - next];
    ta.setSelectionRange(0, 0);
    autoResize(ta);
    return true;
  }
  if (e.key === 'ArrowDown' && ta.selectionEnd === ta.value.length) {
    const idx = composerHistoryIndex.get(chatId) ?? -1;
    if (idx < 0) return false;
    const next = idx - 1;
    composerHistoryIndex.set(chatId, next);
    ta.value = next < 0 ? '' : list[list.length - 1 - next];
    ta.setSelectionRange(ta.value.length, ta.value.length);
    autoResize(ta);
    return true;
  }
  return false;
}

// ===========================================================================
// Jump-to-bottom
// ===========================================================================

function wireJumpToBottom() {
  const messagesEl = document.getElementById('messages');
  const btn = document.getElementById('jumpBottomBtn');
  messagesEl.addEventListener('scroll', () => {
    const distance = messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight;
    btn.hidden = distance < 200;
  });
  btn.addEventListener('click', () => scrollMessagesToBottom(false));
}

// ===========================================================================
// In-chat find (Ctrl+F) — thin UI over Chromium's native find-in-page
// ===========================================================================

let findActive = false;

function isAnyModalOpen() {
  return [...document.querySelectorAll('.modal-overlay, .lightbox-overlay')].some((el) => !el.hidden);
}

function openFindBar() {
  if (!activeChatId) return;
  findActive = true;
  const bar = document.getElementById('findBar');
  bar.hidden = false;
  const input = document.getElementById('findInput');
  input.focus();
  input.select();
}

function closeFindBar() {
  findActive = false;
  document.getElementById('findBar').hidden = true;
  document.getElementById('findStatus').textContent = '';
  window.lingui.findStop();
}

function runFind(forward, findNext) {
  const text = document.getElementById('findInput').value;
  if (!text) {
    window.lingui.findStop();
    document.getElementById('findStatus').textContent = '';
    return;
  }
  window.lingui.findStart(text, forward, findNext);
}

function wireFindBar() {
  const input = document.getElementById('findInput');
  input.addEventListener('input', () => runFind(true, false));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      runFind(!e.shiftKey, true);
    } else if (e.key === 'Escape') {
      closeFindBar();
    }
  });
  document.getElementById('findPrevBtn').addEventListener('click', () => runFind(false, true));
  document.getElementById('findNextBtn').addEventListener('click', () => runFind(true, true));
  document.getElementById('findCloseBtn').addEventListener('click', closeFindBar);
  window.lingui.onFindResult((result) => {
    const statusEl = document.getElementById('findStatus');
    statusEl.textContent = result.matches ? `${result.activeMatchOrdinal}/${result.matches}` : 'No matches';
  });
  document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'f' && activeChatId && !isAnyModalOpen()) {
      e.preventDefault();
      openFindBar();
    } else if (e.key === 'Escape' && findActive) {
      closeFindBar();
    }
  });
}

// ===========================================================================
// Pin / archive chats
// ===========================================================================

async function togglePinChat(chat) {
  chat.pinned = !chat.pinned;
  await window.lingui.upsertChat(chat);
  refreshSidebarList();
  if (chat.id === activeChatId) updatePinButton(chat);
}

async function toggleArchiveChat(chat) {
  chat.archived = !chat.archived;
  await window.lingui.upsertChat(chat);
  if (chat.id === activeChatId && chat.archived) showWelcome();
  else refreshSidebarList();
}

function updatePinButton(chat) {
  const btn = document.getElementById('pinChatBtn');
  btn.classList.toggle('active', !!(chat && chat.pinned));
  btn.title = chat && chat.pinned ? 'Unpin chat' : 'Pin chat';
}

// ===========================================================================
// Settings tab: launch on login, update check
// ===========================================================================

async function loadLoginItemState() {
  const { openAtLogin } = await window.lingui.getLoginItem();
  document.getElementById('loginItemCheckbox').checked = !!openAtLogin;
}

async function checkForUpdate() {
  const statusEl = document.getElementById('updateStatus');
  statusEl.textContent = 'Checking…';
  const res = await window.lingui.checkUpdate();
  if (!res.ok) {
    statusEl.textContent = res.error || "Couldn't check for updates.";
    return;
  }
  statusEl.textContent = res.hasUpdate ? `v${res.latest} available (you have v${res.current})` : `Up to date (v${res.current})`;
}

// ===========================================================================
// Wiring
// ===========================================================================

function populateSelect(selectEl, list, selected) {
  selectEl.innerHTML = '';
  for (const opt of list) {
    const o = el('option', null, opt.label);
    o.value = opt.value;
    if (opt.value === selected) o.selected = true;
    selectEl.appendChild(o);
  }
}

async function pickDirectoryInto(labelEl, defaultPath) {
  const chosen = await window.lingui.chooseDirectory(defaultPath);
  if (!chosen) return null;
  labelEl.textContent = chosen;
  labelEl.dataset.path = chosen;
  return chosen;
}

/** Prefills the welcome screen's model/permission pickers from this cwd's remembered choice, if any. */
function applyProjectDefaultsFor(cwd) {
  const defaults = (settings.projectDefaults || {})[cwd];
  if (!defaults) return;
  const modelSelect = document.getElementById('welcomeModelSelect');
  const permSelect = document.getElementById('welcomePermSelect');
  if (defaults.model && modelSelect.querySelector(`option[value="${defaults.model}"]`)) modelSelect.value = defaults.model;
  if (defaults.permissionMode && permSelect.querySelector(`option[value="${defaults.permissionMode}"]`)) permSelect.value = defaults.permissionMode;
}

function saveProjectDefaults(cwd, model, permissionMode) {
  const projectDefaults = { ...(settings.projectDefaults || {}), [cwd]: { model, permissionMode } };
  settings.projectDefaults = projectDefaults;
  window.lingui.setSettings({ projectDefaults });
}

/** Wires a drop zone so dragging a folder from the file manager sets it as the target path. Ignores plain files (those are for message attachments elsewhere). */
function wireDirectoryDropZone(dropEl, onDropPath) {
  dropEl.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropEl.classList.add('drag-over');
  });
  dropEl.addEventListener('dragleave', () => dropEl.classList.remove('drag-over'));
  dropEl.addEventListener('drop', async (e) => {
    e.preventDefault();
    dropEl.classList.remove('drag-over');
    const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    // Chromium reports dropped directories as a zero-size, typeless File —
    // the same shape a genuinely empty file would have, but good enough to
    // reject an obvious non-directory drop (a .txt, an image, etc.).
    if (!file || file.size > 0 || file.type !== '') return;
    const fsPath = window.lingui.getPathForFile(file);
    if (fsPath) onDropPath(fsPath);
  });
}

async function init() {
  settings = await window.lingui.getSettings();
  applyTheme(settings.theme || 'system');
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (!settings.theme || settings.theme === 'system') applyTheme('system');
  });

  // CLI status
  window.lingui.checkCli().then(({ ok, version, error }) => {
    const dot = document.getElementById('cliStatusDot');
    const text = document.getElementById('cliStatusText');
    if (ok) {
      dot.classList.add('ok');
      text.textContent = version || 'Claude CLI ready';
    } else {
      dot.classList.add('error');
      text.textContent = error === 'not-found' ? 'Claude CLI not found' : 'Claude CLI error';
    }
  });

  // Welcome screen defaults
  const home = await window.lingui.homeDir();
  homeDirPath = home;
  const defaultCwd = settings.lastCwd || home;
  const dirLabel = document.getElementById('welcomeDirLabel');
  dirLabel.textContent = defaultCwd;
  dirLabel.dataset.path = defaultCwd;

  const newProjectLocationLabel = document.getElementById('newProjectLocationLabel');
  const defaultNewProjectLocation = settings.lastNewProjectLocation || home;
  newProjectLocationLabel.textContent = defaultNewProjectLocation;
  newProjectLocationLabel.dataset.path = defaultNewProjectLocation;

  populateSelect(document.getElementById('welcomeModelSelect'), MODELS, settings.lastModel || 'default');
  populateSelect(document.getElementById('welcomePermSelect'), PERMISSION_MODES, settings.lastPermissionMode || 'acceptEdits');
  applyProjectDefaultsFor(defaultCwd);

  document.getElementById('welcomeDirBtn').addEventListener('click', async () => {
    const chosen = await pickDirectoryInto(dirLabel, defaultCwd);
    if (chosen) applyProjectDefaultsFor(chosen);
  });
  wireDirectoryDropZone(document.getElementById('welcomeDirBtn'), (fsPath) => {
    dirLabel.textContent = fsPath;
    dirLabel.dataset.path = fsPath;
    applyProjectDefaultsFor(fsPath);
  });
  document.getElementById('newProjectLocationBtn').addEventListener('click', async () => {
    await pickDirectoryInto(newProjectLocationLabel, defaultNewProjectLocation);
    updateNewProjectPreview();
  });
  document.getElementById('newProjectName').addEventListener('input', updateNewProjectPreview);

  document.querySelectorAll('.mode-tab').forEach((tab) => {
    tab.addEventListener('click', () => setWelcomeMode(tab.dataset.mode));
  });

  document.getElementById('welcomeForm').addEventListener('submit', (e) => {
    e.preventDefault();
    sendFromWelcome();
  });
  document.getElementById('welcomeTextarea').addEventListener('input', (e) => autoResize(e.target));
  const welcomeAutocomplete = createAutocomplete(
    document.getElementById('welcomeTextarea'),
    document.getElementById('welcomeSuggestList'),
    () => document.getElementById('welcomeDirLabel').dataset.path,
    () => FALLBACK_SLASH_COMMANDS
  );
  document.getElementById('welcomeTextarea').addEventListener('keydown', (e) => {
    if (welcomeAutocomplete.handleKeydown(e)) return;
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendFromWelcome();
    }
  });
  document.querySelectorAll('.example-chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      const ta = document.getElementById('welcomeTextarea');
      ta.value = chip.dataset.prompt;
      autoResize(ta);
      ta.focus();
    });
  });
  wireAttachUI(welcomeAttachCtx, 'welcomeAttachBtn', 'welcomeFileInput', document.getElementById('welcomeForm'), document.getElementById('welcomeTextarea'));

  // Composer (active chat)
  document.getElementById('composerForm').addEventListener('submit', (e) => {
    e.preventDefault();
    sendFromComposer();
  });
  document.getElementById('composerTextarea').addEventListener('input', (e) => autoResize(e.target));
  const composerAutocomplete = createAutocomplete(
    document.getElementById('composerTextarea'),
    document.getElementById('composerSuggestList'),
    () => (chats.get(activeChatId) || {}).cwd,
    () => (chats.get(activeChatId) || {}).slashCommands || FALLBACK_SLASH_COMMANDS
  );
  document.getElementById('composerTextarea').addEventListener('keydown', (e) => {
    if (composerAutocomplete.handleKeydown(e)) return;
    if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && activeChatId && handleComposerHistoryKey(e, e.target, activeChatId)) {
      e.preventDefault();
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendFromComposer();
    }
  });
  wireAttachUI(composerAttachCtx, 'composerAttachBtn', 'composerFileInput', document.getElementById('composerForm'), document.getElementById('composerTextarea'));
  document.getElementById('stopBtn').addEventListener('click', () => {
    if (!activeChatId) return;
    window.lingui.stopSession(activeChatId);
  });

  document.getElementById('chatDirChip').addEventListener('click', async () => {
    const chat = chats.get(activeChatId);
    if (!chat) return;
    try {
      await navigator.clipboard.writeText(chat.cwd);
      const chip = document.getElementById('chatDirChip');
      const original = chip.textContent;
      chip.textContent = 'Copied path ✓';
      setTimeout(() => (chip.textContent = original), 1200);
    } catch {
      /* clipboard unavailable — ignore */
    }
  });

  const titleEl = document.getElementById('chatTitle');
  titleEl.addEventListener('dblclick', () => {
    titleEl.contentEditable = 'true';
    titleEl.focus();
    document.execCommand('selectAll', false, null);
  });
  titleEl.addEventListener('blur', () => {
    titleEl.contentEditable = 'false';
    const chat = chats.get(activeChatId);
    if (!chat) return;
    const newTitle = titleEl.textContent.trim() || 'New chat';
    chat.title = newTitle;
    chat.updatedAt = Date.now();
    scheduleSave(chat.id);
    refreshSidebarList();
  });
  titleEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      titleEl.blur();
    }
  });

  // Sidebar
  document.getElementById('newChatBtn').addEventListener('click', showWelcome);
  document.getElementById('themeToggleBtn').addEventListener('click', cycleTheme);
  document.getElementById('accountBtn').addEventListener('click', openAuthModal);
  document.getElementById('collapseSidebarBtn').addEventListener('click', () => {
    document.getElementById('sidebar').classList.add('collapsed');
    document.getElementById('expandSidebarBtn').hidden = false;
  });
  document.getElementById('expandSidebarBtn').addEventListener('click', () => {
    document.getElementById('sidebar').classList.remove('collapsed');
    document.getElementById('expandSidebarBtn').hidden = true;
  });

  // Account modal
  document.getElementById('authModalCloseBtn').addEventListener('click', closeAuthModal);
  document.getElementById('authModalOverlay').addEventListener('click', (e) => {
    if (e.target.id === 'authModalOverlay') closeAuthModal();
  });
  document.getElementById('authLoginClaudeBtn').addEventListener('click', () => startAuthLogin('claudeai'));
  document.getElementById('authLoginConsoleBtn').addEventListener('click', () => startAuthLogin('console'));
  document.getElementById('authLogoutBtn').addEventListener('click', logoutOfAccount);
  document.getElementById('authOpenLinkBtn').addEventListener('click', () => {
    if (authLoginLastUrl) window.lingui.openExternal(authLoginLastUrl);
  });
  document.getElementById('authCodeForm').addEventListener('submit', (e) => {
    e.preventDefault();
    submitAuthCode();
  });
  document.getElementById('authCancelLoginBtn').addEventListener('click', cancelAuthLogin);

  window.lingui.onAuthLoginOutput((chunk) => appendAuthLog(chunk));
  window.lingui.onAuthLoginError((message) => appendAuthLog(`\n[error] ${message}\n`));
  window.lingui.onAuthLoginExit(async ({ code, signal }) => {
    authLoginActive = false;
    if (code !== 0 && signal !== 'SIGTERM') {
      appendAuthLog(`\n› Login process exited (code ${code}).\n`);
    }
    const status = await fetchAuthStatus();
    if (!document.getElementById('authModalOverlay').hidden) renderAuthStatusPane(status);
  });

  fetchAuthStatus();

  // Tools modal
  document.getElementById('toolsBtn').addEventListener('click', openToolsModal);
  document.getElementById('toolsModalCloseBtn').addEventListener('click', closeToolsModal);
  document.getElementById('toolsModalOverlay').addEventListener('click', (e) => {
    if (e.target.id === 'toolsModalOverlay') closeToolsModal();
  });
  document.querySelectorAll('#toolsTabs .modal-tab').forEach((btn) => {
    btn.addEventListener('click', () => setToolsTab(btn.dataset.tab));
  });
  document.getElementById('mcpAddForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = document.getElementById('mcpNameInput').value.trim();
    const json = document.getElementById('mcpJsonInput').value.trim();
    if (!name || !json) return;
    const res = await window.lingui.mcpAdd(name, json);
    if (!res.ok) {
      alert(res.error || "Couldn't add that MCP server.");
      return;
    }
    document.getElementById('mcpNameInput').value = '';
    document.getElementById('mcpJsonInput').value = '';
    loadMcpTab();
  });
  document.getElementById('mcpRemoveForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = document.getElementById('mcpRemoveInput').value.trim();
    if (!name) return;
    const res = await window.lingui.mcpRemove(name);
    if (!res.ok) {
      alert(res.error || "Couldn't remove that MCP server.");
      return;
    }
    document.getElementById('mcpRemoveInput').value = '';
    loadMcpTab();
  });
  document.getElementById('hotkeySaveBtn').addEventListener('click', async () => {
    const accelerator = document.getElementById('hotkeyInput').value.trim();
    const res = await window.lingui.setTrayHotkey(accelerator);
    const statusEl = document.getElementById('hotkeyStatus');
    if (res.ok) {
      settings.trayHotkey = accelerator;
      statusEl.textContent = 'Saved.';
      statusEl.classList.remove('banner-error');
    } else {
      statusEl.textContent = res.error || "Couldn't register that hotkey.";
      statusEl.classList.add('banner-error');
    }
  });

  // CLAUDE.md modal
  document.getElementById('claudeMdBtn').addEventListener('click', openClaudeMdModal);
  document.getElementById('claudeMdCloseBtn').addEventListener('click', closeClaudeMdModal);
  document.getElementById('claudeMdOverlay').addEventListener('click', (e) => {
    if (e.target.id === 'claudeMdOverlay') closeClaudeMdModal();
  });
  document.getElementById('claudeMdSaveBtn').addEventListener('click', saveClaudeMd);

  // Export
  document.getElementById('exportChatBtn').addEventListener('click', exportActiveChat);

  // Sidebar search
  document.getElementById('chatSearchInput').addEventListener('input', (e) => {
    chatSearchQuery = e.target.value.trim();
    refreshSidebarList();
  });

  // Tray
  window.lingui.onTrayNewChat(() => showWelcome());

  // Message actions (copy / edit / regenerate), lightbox, jump-to-bottom, find
  wireMessageActionDelegation();
  wireJumpToBottom();
  wireFindBar();
  document.getElementById('lightboxOverlay').addEventListener('click', closeLightbox);

  // Chat topbar: pin, new window
  document.getElementById('pinChatBtn').addEventListener('click', () => {
    const chat = chats.get(activeChatId);
    if (chat) togglePinChat(chat);
  });
  document.getElementById('newWindowBtn').addEventListener('click', () => window.lingui.newWindow());

  // Settings tab: launch on login, update check
  document.getElementById('loginItemCheckbox').addEventListener('change', (e) => {
    window.lingui.setLoginItem(e.target.checked);
  });
  document.getElementById('checkUpdateBtn').addEventListener('click', checkForUpdate);

  // Session event stream from main process
  window.lingui.onSessionEvent(({ localId, evt }) => handleSessionEvent(localId, evt));
  window.lingui.onSessionExit(({ localId, info }) => {
    const chat = chats.get(localId);
    if (!chat) return;
    chat.busy = false;
    liveTurns.delete(localId);
    if (info && info.code !== 0 && info.signal !== 'SIGTERM') {
      showBannerIfActive(chat, `Claude process exited unexpectedly (code ${info.code}).`, true, () => resendLastMessage(localId));
    }
    if (chat.id === activeChatId) {
      updateComposerBusyState(chat);
      updateStatusBar(chat);
    }
    scheduleSave(localId);
  });
  window.lingui.onSessionSpawnError(({ localId, message }) => {
    const chat = chats.get(localId);
    if (!chat) return;
    chat.busy = false;
    if (chat.id === activeChatId) {
      updateComposerBusyState(chat);
      showBanner(`Couldn't start Claude: ${message}`, true, () => resendLastMessage(localId));
    }
  });

  await refreshSidebarList();

  if (settings.lastOpenChatId) {
    const exists = await window.lingui.getChat(settings.lastOpenChatId);
    if (exists) {
      await openChat(settings.lastOpenChatId);
      return;
    }
  }
  showWelcome();
}

init();
