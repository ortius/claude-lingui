const { app, BrowserWindow, ipcMain, dialog, shell, nativeTheme } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');
const https = require('https');
const { execFile } = require('child_process');

const { Store } = require('./store');
const { SessionManager } = require('./claudeSession');
const { AuthManager } = require('./authManager');
const { TrayManager, notify, DEFAULT_ACCELERATOR } = require('./trayManager');
const cliTools = require('./cliTools');
const { PtyManager } = require('./ptyManager');

const ICON_PATH = path.join(__dirname, '..', 'build', 'icon.png');

/** @type {Set<BrowserWindow>} every open app window — sessions are shared across all of them. */
const windows = new Set();
/** The window that hides-to-tray on close instead of quitting; secondary ("New Window") windows just close normally. */
let primaryWindow = null;
let store = null;
let tray = null;
let isQuitting = false;
const manager = new SessionManager();
const authManager = new AuthManager();
const ptyManager = new PtyManager();

const CLAUDE_BIN = process.env.CLAUDE_LINGUI_BIN || 'claude';

function anyWindowFocused() {
  for (const w of windows) if (!w.isDestroyed() && w.isFocused()) return true;
  return false;
}

/** Sends to every open window — a window with no state for `localId` just ignores the event (handleSessionEvent bails on an unknown chat). */
function broadcast(channel, payload) {
  for (const w of windows) {
    if (!w.isDestroyed()) w.webContents.send(channel, payload);
  }
}

function saveWindowBounds(win) {
  if (win !== primaryWindow || win.isDestroyed()) return;
  store.setSettings({ windowBounds: win.getBounds() });
}

function createWindow({ isPrimary = false } = {}) {
  const bounds = isPrimary && store.getSettings().windowBounds;
  const offset = windows.size * 28;

  const win = new BrowserWindow({
    width: (bounds && bounds.width) || 1280,
    height: (bounds && bounds.height) || 820,
    x: bounds ? bounds.x : undefined,
    y: bounds ? bounds.y : undefined,
    minWidth: 760,
    minHeight: 480,
    // Packaged builds get their icon from electron-builder (desktop file +
    // hicolor theme); this covers the window/taskbar icon for `npm start`
    // dev runs, where nothing else points at build/icon.png.
    icon: ICON_PATH,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#1b1a19' : '#faf8f5',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: true,
    },
  });

  if (!bounds && !isPrimary) win.setPosition(win.getPosition()[0] + offset, win.getPosition()[1] + offset);

  windows.add(win);
  if (isPrimary) primaryWindow = win;

  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  win.webContents.on('console-message', (_evt, level, message, line, sourceId) => {
    if (level >= 2) console.error(`[renderer] ${message} (${sourceId}:${line})`);
  });
  win.webContents.on('render-process-gone', (_evt, details) => {
    console.error('[renderer] process gone:', details);
  });
  win.webContents.on('found-in-page', (_evt, result) => {
    win.webContents.send('find:result', result);
  });

  // Dev helper: LINGUI_SCREENSHOT_PATH=/tmp/x.png electron . takes one
  // startup screenshot and quits — handy for visually checking a change
  // without needing a full display session.
  if (isPrimary && process.env.LINGUI_SCREENSHOT_PATH) {
    win.webContents.once('did-finish-load', () => {
      setTimeout(async () => {
        const img = await win.webContents.capturePage();
        fs.writeFileSync(process.env.LINGUI_SCREENSHOT_PATH, img.toPNG());
        app.quit();
      }, 600);
    });
  }

  if (isPrimary) {
    let boundsTimer = null;
    const scheduleSaveBounds = () => {
      clearTimeout(boundsTimer);
      boundsTimer = setTimeout(() => saveWindowBounds(win), 400);
    };
    win.on('resize', scheduleSaveBounds);
    win.on('move', scheduleSaveBounds);

    // The app (and any running Claude sessions) keeps going in the tray —
    // same as Slack/Discord. Tray → Quit (or a real app-level quit) is what
    // actually exits. Secondary windows close normally (see below).
    win.on('close', (event) => {
      if (!isQuitting) {
        event.preventDefault();
        win.hide();
      }
    });
  }

  win.on('closed', () => {
    windows.delete(win);
    if (win === primaryWindow) primaryWindow = null;
  });

  return win;
}

app.whenReady().then(() => {
  store = new Store(app);
  createWindow({ isPrimary: true });

  tray = new TrayManager({
    iconPath: ICON_PATH,
    getWindow: () => primaryWindow,
    onNewChat: () => primaryWindow && primaryWindow.webContents.send('tray:new-chat', null),
  });
  tray.init();
  const settings = store.getSettings();
  if (settings.trayHotkey !== null) tray.setHotkey(settings.trayHotkey || DEFAULT_ACCELERATOR);

  app.on('activate', () => {
    if (windows.size === 0) createWindow({ isPrimary: true });
    else if (primaryWindow) tray.showWindow();
  });
});

app.on('window-all-closed', () => {
  manager.destroyAll();
  authManager.cancelLogin();
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  isQuitting = true;
  manager.destroyAll();
  authManager.cancelLogin();
  ptyManager.killAll();
  if (tray) tray.destroy();
});

// ---------------------------------------------------------------------------
// CLI availability check
// ---------------------------------------------------------------------------

ipcMain.handle('cli:check', () => {
  return new Promise((resolve) => {
    execFile(CLAUDE_BIN, ['--version'], { timeout: 10000 }, (err, stdout) => {
      if (err) {
        resolve({ ok: false, error: err.code === 'ENOENT' ? 'not-found' : String(err.message || err) });
      } else {
        resolve({ ok: true, version: stdout.trim() });
      }
    });
  });
});

// ---------------------------------------------------------------------------
// Native Claude account login (`claude auth ...`)
// ---------------------------------------------------------------------------

ipcMain.handle('auth:status', () => authManager.status());

ipcMain.handle('auth:logout', () => authManager.logout());

ipcMain.handle('auth:login-start', (_evt, method) => {
  authManager.startLogin(method, {
    onOutput: (chunk) => broadcast('auth:login-output', chunk),
    onError: (message) => broadcast('auth:login-error', message),
    onExit: (info) => broadcast('auth:login-exit', info),
  });
  return { ok: true };
});

ipcMain.handle('auth:login-submit-code', (_evt, code) => ({ ok: authManager.submitCode(code) }));

ipcMain.handle('auth:login-cancel', () => {
  authManager.cancelLogin();
  return { ok: true };
});

// ---------------------------------------------------------------------------
// Filesystem / dialogs
// ---------------------------------------------------------------------------

ipcMain.handle('fs:home-dir', () => os.homedir());

// Only ever used for the https:// sign-in URL `claude auth login` prints —
// reject anything else so renderer-side text can't be turned into an
// arbitrary-scheme shell.openExternal call.
ipcMain.handle('shell:open-external', (_evt, url) => {
  if (typeof url === 'string' && /^https:\/\//i.test(url)) {
    shell.openExternal(url);
    return { ok: true };
  }
  return { ok: false, error: 'Refusing to open a non-https URL.' };
});

ipcMain.handle('shell:open-path', async (_evt, filePath) => {
  const err = await shell.openPath(filePath);
  return err ? { ok: false, error: err } : { ok: true };
});

ipcMain.handle('shell:show-in-folder', (_evt, filePath) => {
  shell.showItemInFolder(filePath);
  return { ok: true };
});

ipcMain.handle('dialog:choose-directory', async (evt, defaultPath) => {
  const win = BrowserWindow.fromWebContents(evt.sender);
  const result = await dialog.showOpenDialog(win, {
    properties: ['openDirectory', 'createDirectory'],
    defaultPath: defaultPath || os.homedir(),
    title: 'Choose a working directory for Claude',
  });
  if (result.canceled || !result.filePaths.length) return null;
  return result.filePaths[0];
});

// Creates <parentDir>/<name> (idempotent — a no-op if it already exists as a
// directory) for the "New project" flow. `name` is sanitized to a plain
// path segment so it can't escape parentDir via "../" or an absolute path.
ipcMain.handle('project:create-directory', (_evt, { parentDir, name }) => {
  const safeName = String(name || '').trim().replace(/[\/\\]+/g, '-').replace(/^\.+/, '');
  if (!parentDir || !safeName) {
    return { ok: false, error: 'A project name and location are required.' };
  }
  const fullPath = path.join(parentDir, safeName);
  try {
    const existing = fs.existsSync(fullPath) ? fs.statSync(fullPath) : null;
    if (existing && !existing.isDirectory()) {
      return { ok: false, error: `${fullPath} already exists and isn't a folder.` };
    }
    fs.mkdirSync(fullPath, { recursive: true });
    return { ok: true, path: fullPath };
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  }
});

// ---------------------------------------------------------------------------
// Persistent store (settings + chat history)
// ---------------------------------------------------------------------------

ipcMain.handle('store:get-settings', () => store.getSettings());
ipcMain.handle('store:set-settings', (_evt, patch) => store.setSettings(patch));
ipcMain.handle('store:list-chats', () => store.listChats());
ipcMain.handle('store:get-chat', (_evt, id) => store.getChat(id));
ipcMain.handle('store:upsert-chat', (_evt, chat) => store.upsertChat(chat));
ipcMain.handle('store:delete-chat', (_evt, id) => {
  manager.destroy(id);
  store.deleteChat(id);
});

// ---------------------------------------------------------------------------
// Claude session lifecycle
// ---------------------------------------------------------------------------

ipcMain.handle('session:has-active', (_evt, localId) => manager.has(localId));

ipcMain.handle('session:send', (_evt, { localId, text, opts }) => {
  if (opts && opts.cloudTarget) {
    manager.sendCloud(localId, text, opts, {
      onEvent: (evt) => broadcast('session:event', { localId, evt }),
      onSpawnError: (message) => broadcast('session:spawn-error', { localId, message }),
    });
    return { ok: true };
  }

  if (!manager.has(localId)) {
    manager.create(localId, opts, {
      onEvent: (evt) => {
        broadcast('session:event', { localId, evt });
        // A turn just finished — let the user know if they've tabbed away,
        // same as any chat app. Skipped while some window has focus so it
        // doesn't nag someone who's already watching it happen.
        if (evt.type === 'result' && !anyWindowFocused()) {
          const label = opts && opts.cwd ? path.basename(opts.cwd) : 'Claude';
          const isError = evt.subtype && evt.subtype !== 'success';
          notify({
            title: isError ? `${label} — stopped` : `${label} — done`,
            body: isError ? evt.subtype : evt.result ? String(evt.result).slice(0, 200) : 'Turn complete.',
            onClick: () => tray && tray.showWindow(),
          });
        }
      },
      onRawLine: (line) => broadcast('session:raw-line', { localId, line }),
      onStderr: (chunk) => broadcast('session:stderr', { localId, chunk }),
      onSpawnError: (message) => broadcast('session:spawn-error', { localId, message }),
      onPermissionRequest: (req) => {
        broadcast('session:permission-request', { localId, req });
        if (!anyWindowFocused()) {
          const label = opts && opts.cwd ? path.basename(opts.cwd) : 'Claude';
          notify({
            title: `${label} — needs your OK`,
            body: `Wants to use ${req.toolName}`,
            onClick: () => tray && tray.showWindow(),
          });
        }
      },
      onExit: (info) => broadcast('session:exit', { localId, info }),
    });
    // Give the process a tick to attach stdin before writing. Writing
    // immediately after spawn() is safe in Node (stdin is buffered), so we
    // send right away rather than waiting on the init event.
  }
  try {
    manager.send(localId, text, opts && opts.attachments);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  }
});

ipcMain.handle('session:stop', (_evt, localId) => {
  manager.stop(localId);
  return { ok: true };
});

ipcMain.handle('session:permission-respond', (_evt, { localId, requestId, decision, extra }) => ({
  ok: manager.respondPermission(localId, requestId, decision, extra),
}));

// ---------------------------------------------------------------------------
// Tray hotkey
// ---------------------------------------------------------------------------

ipcMain.handle('tray:set-hotkey', (_evt, accelerator) => {
  store.setSettings({ trayHotkey: accelerator || null });
  return tray ? tray.setHotkey(accelerator) : { ok: true };
});

// ---------------------------------------------------------------------------
// @-mention file listing, CLAUDE.md editor, chat export
// ---------------------------------------------------------------------------

const IGNORED_DIR_NAMES = new Set(['.git', 'node_modules', '.venv', '__pycache__', 'dist', 'build', '.next', 'target']);

// Flat, depth-limited file listing under `root` for @-mention autocomplete.
// Deliberately simple (no .gitignore parsing) and capped hard so a huge repo
// can't stall the picker or balloon memory.
ipcMain.handle('fs:list-files', (_evt, root) => {
  const results = [];
  const MAX_RESULTS = 2000;
  function walk(dir, depth) {
    if (results.length >= MAX_RESULTS || depth > 6) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (results.length >= MAX_RESULTS) return;
      if (entry.name.startsWith('.') && entry.name !== '.') continue;
      if (entry.isDirectory()) {
        if (IGNORED_DIR_NAMES.has(entry.name)) continue;
        walk(path.join(dir, entry.name), depth + 1);
      } else if (entry.isFile()) {
        results.push(path.relative(root, path.join(dir, entry.name)));
      }
    }
  }
  try {
    walk(root, 0);
  } catch {
    // best-effort
  }
  return results;
});

ipcMain.handle('fs:read-claude-md', (_evt, cwd) => {
  const file = path.join(cwd, 'CLAUDE.md');
  try {
    return { ok: true, text: fs.readFileSync(file, 'utf-8'), exists: true };
  } catch (err) {
    if (err.code === 'ENOENT') return { ok: true, text: '', exists: false };
    return { ok: false, error: String(err.message || err) };
  }
});

ipcMain.handle('fs:write-claude-md', (_evt, { cwd, text }) => {
  try {
    fs.writeFileSync(path.join(cwd, 'CLAUDE.md'), text, 'utf-8');
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  }
});

ipcMain.handle('dialog:export-chat', async (evt, { defaultName, markdown }) => {
  const win = BrowserWindow.fromWebContents(evt.sender);
  const result = await dialog.showSaveDialog(win, {
    title: 'Export chat',
    defaultPath: defaultName,
    filters: [{ name: 'Markdown', extensions: ['md'] }],
  });
  if (result.canceled || !result.filePath) return { ok: false, canceled: true };
  try {
    fs.writeFileSync(result.filePath, markdown, 'utf-8');
    return { ok: true, path: result.filePath };
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  }
});

// ---------------------------------------------------------------------------
// Tools panel: MCP servers, plugins, and the machine-wide agents list
// ---------------------------------------------------------------------------

ipcMain.handle('tools:mcp-list', () => cliTools.mcp.list());
ipcMain.handle('tools:mcp-add', (_evt, { name, json, scope }) => cliTools.mcp.addJson(name, json, scope));
ipcMain.handle('tools:mcp-remove', (_evt, name) => cliTools.mcp.remove(name));

ipcMain.handle('tools:plugin-list', () => cliTools.plugins.list());
ipcMain.handle('tools:plugin-enable', (_evt, name) => cliTools.plugins.enable(name));
ipcMain.handle('tools:plugin-disable', (_evt, name) => cliTools.plugins.disable(name));

ipcMain.handle('tools:agents-list', () => cliTools.agents.list());
ipcMain.handle('tools:agents-stop', (_evt, id) => cliTools.agents.stop(id));
ipcMain.handle('tools:agents-remove', (_evt, id) => cliTools.agents.remove(id));

ipcMain.handle('tools:project-sessions', (_evt, cwd) => cliTools.listProjectSessions(cwd));

// ---------------------------------------------------------------------------
// Live HTML preview — a separate, unsandboxed-by-CSP window (see the
// renderer-side comment on openPreview for why this isn't an in-app iframe).
// ---------------------------------------------------------------------------

ipcMain.handle('preview:open', (_evt, { title, html }) => {
  const win = new BrowserWindow({
    width: 900,
    height: 700,
    title: title || 'Preview',
    icon: ICON_PATH,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });
  win.setMenuBarVisibility(false);
  win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(String(html || '')));
  return { ok: true };
});

// ---------------------------------------------------------------------------
// In-chat find — thin wrapper over Chromium's own find-in-page, scoped to
// whichever window's renderer asked (each chat view lives in one window).
// ---------------------------------------------------------------------------

ipcMain.handle('find:start', (evt, { text, forward, findNext }) => {
  const win = BrowserWindow.fromWebContents(evt.sender);
  if (!win || !text) return { ok: false };
  win.webContents.findInPage(text, { forward, findNext });
  return { ok: true };
});

ipcMain.handle('find:stop', (evt) => {
  const win = BrowserWindow.fromWebContents(evt.sender);
  if (win) win.webContents.stopFindInPage('clearSelection');
  return { ok: true };
});

// ---------------------------------------------------------------------------
// Extra windows ("open chat in a new window")
// ---------------------------------------------------------------------------

ipcMain.handle('window:new', () => {
  createWindow({ isPrimary: false });
  return { ok: true };
});

// ---------------------------------------------------------------------------
// Launch on login — Electron's app.setLoginItemSettings is darwin/win32 only
// (its own type declarations say so); Linux needs a hand-written XDG
// autostart .desktop file instead.
// ---------------------------------------------------------------------------

const autostartDesktopPath = path.join(os.homedir(), '.config', 'autostart', 'claude-lingui.desktop');

function getLinuxAutostart() {
  return fs.existsSync(autostartDesktopPath);
}

function setLinuxAutostart(enabled) {
  if (!enabled) {
    try {
      fs.unlinkSync(autostartDesktopPath);
    } catch {
      // already absent
    }
    return;
  }
  // Dev runs (`npx electron .`) need the app path passed explicitly; a
  // packaged install's execPath alone is the whole app.
  const exec = app.isPackaged ? `"${process.execPath}"` : `"${process.execPath}" "${app.getAppPath()}"`;
  const contents = ['[Desktop Entry]', 'Type=Application', 'Name=Claude LinGUI', `Exec=${exec}`, 'Icon=claude-lingui', 'Terminal=false', 'X-GNOME-Autostart-enabled=true', ''].join('\n');
  fs.mkdirSync(path.dirname(autostartDesktopPath), { recursive: true });
  fs.writeFileSync(autostartDesktopPath, contents, 'utf-8');
}

ipcMain.handle('app:get-login-item', () => {
  if (process.platform === 'linux') return { openAtLogin: getLinuxAutostart() };
  return { openAtLogin: app.getLoginItemSettings().openAtLogin };
});

ipcMain.handle('app:set-login-item', (_evt, openAtLogin) => {
  if (process.platform === 'linux') setLinuxAutostart(!!openAtLogin);
  else app.setLoginItemSettings({ openAtLogin: !!openAtLogin });
  return { ok: true };
});

// ---------------------------------------------------------------------------
// Update check — reads the GitHub repo slug from package.json's
// "repository" field (empty until this project is actually published), and
// compares its latest release tag against the running version.
// ---------------------------------------------------------------------------

ipcMain.handle('app:check-update', () => {
  return new Promise((resolve) => {
    let pkg;
    try {
      pkg = require('../package.json');
    } catch {
      resolve({ ok: false, error: "Couldn't read package.json." });
      return;
    }
    const repoUrl = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository && pkg.repository.url;
    const match = repoUrl && repoUrl.match(/github\.com[:/]+([^/]+)\/([^/.]+)/);
    if (!match) {
      resolve({ ok: false, error: 'No GitHub repository configured yet.' });
      return;
    }
    const [, owner, repo] = match;
    const req = https.request(
      { hostname: 'api.github.com', path: `/repos/${owner}/${repo}/releases/latest`, headers: { 'User-Agent': 'claude-lingui' }, timeout: 8000 },
      (res) => {
        let body = '';
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => {
          if (res.statusCode !== 200) {
            resolve({ ok: false, error: `GitHub returned ${res.statusCode}.` });
            return;
          }
          try {
            const data = JSON.parse(body);
            const latest = String(data.tag_name || '').replace(/^v/, '');
            const current = pkg.version;
            resolve({ ok: true, current, latest, url: data.html_url, hasUpdate: latest && latest !== current });
          } catch {
            resolve({ ok: false, error: "Couldn't parse GitHub's response." });
          }
        });
      }
    );
    req.on('error', (err) => resolve({ ok: false, error: String(err.message || err) }));
    req.on('timeout', () => req.destroy(new Error('Timed out reaching GitHub.')));
    req.end();
  });
});

// ---------------------------------------------------------------------------
// Embedded terminal — a real pty running `claude`, for things a headless
// `-p` session structurally can't do: attaching to a background session,
// and anything that needs a genuine interactive TTY (Remote Control,
// /rewind, and any other terminal-only feature all just work here, native,
// because it IS a real terminal).
// ---------------------------------------------------------------------------

ipcMain.handle('terminal:start', (evt, { id, mode, targetId, cwd, cols, rows }) => {
  const win = BrowserWindow.fromWebContents(evt.sender);
  let args;
  if (mode === 'attach') args = ['attach', targetId];
  else if (mode === 'remote-control') args = ['--remote-control'];
  else args = [];

  ptyManager.spawn(
    id,
    { command: CLAUDE_BIN, args, cwd: cwd || os.homedir(), cols, rows },
    {
      onData: (data) => win && !win.isDestroyed() && win.webContents.send('terminal:data', { id, data }),
      onExit: (info) => win && !win.isDestroyed() && win.webContents.send('terminal:exit', { id, info }),
    }
  );
  return { ok: true };
});

ipcMain.handle('terminal:write', (_evt, { id, data }) => {
  ptyManager.write(id, data);
  return { ok: true };
});

ipcMain.handle('terminal:resize', (_evt, { id, cols, rows }) => {
  ptyManager.resize(id, cols, rows);
  return { ok: true };
});

ipcMain.handle('terminal:stop', (_evt, id) => {
  ptyManager.kill(id);
  return { ok: true };
});
