// System tray icon + global show/hide hotkey + desktop notifications — the
// native-desktop conveniences the web/terminal clients can't offer.

const { Tray, Menu, nativeImage, globalShortcut, Notification } = require('electron');

const DEFAULT_ACCELERATOR = 'Control+Alt+Space';

class TrayManager {
  constructor({ iconPath, getWindow, onNewChat }) {
    this.iconPath = iconPath;
    this.getWindow = getWindow;
    this.onNewChat = onNewChat;
    this.tray = null;
    this.registeredAccelerator = null;
  }

  init() {
    const image = nativeImage.createFromPath(this.iconPath).resize({ width: 22, height: 22 });
    this.tray = new Tray(image);
    this.tray.setToolTip('Claude LinGUI');
    this._rebuildMenu();
    this.tray.on('click', () => this.toggleWindow());
  }

  _rebuildMenu() {
    if (!this.tray) return;
    const menu = Menu.buildFromTemplate([
      { label: 'Show Claude LinGUI', click: () => this.showWindow() },
      { label: 'New chat', click: () => { this.showWindow(); this.onNewChat && this.onNewChat(); } },
      { type: 'separator' },
      { label: 'Quit', role: 'quit' },
    ]);
    this.tray.setContextMenu(menu);
  }

  showWindow() {
    const win = this.getWindow();
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  }

  toggleWindow() {
    const win = this.getWindow();
    if (!win) return;
    if (win.isVisible() && win.isFocused()) win.hide();
    else this.showWindow();
  }

  /** Registers (or re-registers, after a setting change) the global show/hide hotkey. */
  setHotkey(accelerator) {
    if (this.registeredAccelerator) {
      globalShortcut.unregister(this.registeredAccelerator);
      this.registeredAccelerator = null;
    }
    if (!accelerator) return { ok: true };
    const ok = globalShortcut.register(accelerator, () => this.toggleWindow());
    if (ok) this.registeredAccelerator = accelerator;
    return { ok, error: ok ? null : `Couldn't register "${accelerator}" — it may already be in use by another app.` };
  }

  unregisterAll() {
    if (this.registeredAccelerator) globalShortcut.unregister(this.registeredAccelerator);
    this.registeredAccelerator = null;
  }

  destroy() {
    this.unregisterAll();
    if (this.tray) this.tray.destroy();
    this.tray = null;
  }
}

/** Fires a native notification (no-op, quietly, on platforms/environments without notification support). */
function notify({ title, body, onClick }) {
  if (!Notification.isSupported()) return;
  const n = new Notification({ title, body, icon: undefined });
  if (onClick) n.on('click', onClick);
  n.show();
}

module.exports = { TrayManager, notify, DEFAULT_ACCELERATOR };
