// Small JSON-file persistence layer for app settings and chat history.
// Lives entirely on disk under Electron's userData directory — nothing
// leaves the machine.

const fs = require('fs');
const path = require('path');

class Store {
  constructor(app) {
    this.dir = app.getPath('userData');
    this.file = path.join(this.dir, 'lingui-data.json');
    this.data = this._load();
  }

  _load() {
    try {
      const raw = fs.readFileSync(this.file, 'utf-8');
      return JSON.parse(raw);
    } catch {
      return { settings: {}, chats: {} };
    }
  }

  _save() {
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2), 'utf-8');
    } catch (err) {
      console.error('Failed to persist store:', err);
    }
  }

  getSettings() {
    return this.data.settings || {};
  }

  setSettings(patch) {
    this.data.settings = { ...this.data.settings, ...patch };
    this._save();
    return this.data.settings;
  }

  listChats() {
    return Object.values(this.data.chats || {}).sort(
      (a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)
    );
  }

  getChat(id) {
    return this.data.chats[id] || null;
  }

  upsertChat(chat) {
    this.data.chats[chat.id] = { ...this.data.chats[chat.id], ...chat, updatedAt: Date.now() };
    this._save();
    return this.data.chats[chat.id];
  }

  deleteChat(id) {
    delete this.data.chats[id];
    this._save();
  }
}

module.exports = { Store };
