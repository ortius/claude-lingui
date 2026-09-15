# Claude LinGUI

A clean desktop GUI for [Claude Code](https://claude.com/claude-code). It doesn't
reimplement a chat client — it drives the real `claude` CLI as a subprocess and
renders its structured output (streaming text, tool calls, results) as an
actual chat interface: bubbles, markdown, syntax-highlighted code, and
collapsible tool-call cards instead of a terminal.

Because it wraps the CLI directly, **the app never stores an API key or
touches your credentials directly** — it drives `claude auth login` (the same
OAuth flow the terminal uses) and everything else rides on whatever
authentication `claude` already has on your machine. Sign in from the
Account panel in the sidebar, or `claude auth login`/`ANTHROPIC_API_KEY` from
a terminal — either way, the app just sees a working `claude` CLI.

## Requirements

- [Claude Code](https://claude.com/claude-code) installed and authenticated
  (`claude login`, or `claude doctor` to check status).
- Node.js 18+.

## Running it

```bash
npm install
npm start
```

## Installing it as a standalone app

```bash
npm run dist
```

Produces, in `dist/`:

- `claude-lingui_<version>_amd64.deb` — for Debian/Ubuntu and derivatives:
  `sudo apt install ./dist/claude-lingui_<version>_amd64.deb`
- `claude-lingui-<version>-1-x86_64.pkg.tar.zst` — native for
  CachyOS/Arch: `sudo pacman -U dist/claude-lingui-<version>-1-x86_64.pkg.tar.zst`

Either one installs a "Claude LinGUI" entry in your application menu (with
the terminal-prompt icon in `build/icon.png`) and a `claude-lingui` command
on your `PATH`.

These are built by hand (see `scripts/package-deb.sh` and
`scripts/package-pacman.sh`) rather than via `electron-builder`'s built-in
deb/pacman targets, because those shell out to a bundled `fpm` (a portable
Ruby binary) that fails to load on this system — a glibc/libxcrypt ABI
mismatch (`libcrypt.so.1` not found) that's normally fixed by installing
`libxcrypt-compat`, which needs root. The scripts instead package the
`electron-builder`-produced app bundle (`npm run pack:linux`) directly with
`ar`/`tar` for the `.deb` and Arch's own `makepkg` for the pacman package —
both work with no root needed to *build*, only to *install*. If your build
machine already has a working `dpkg-deb`/`fpm`, `npm run dist:fpm` uses the
conventional electron-builder path instead.

Not (yet) code-signed — Linux doesn't require that to run, unlike Windows/Mac.

**On KDE Plasma, the app icon may not show up** (titlebar or taskbar) right
after installing, even though the `.desktop` file and icon are correctly in
place — Plasma caches desktop entries separately from GTK, in a per-user
cache our package can't rebuild for you during a root-run install. Confirmed
fix: restart Plasma Shell — `kquitapp6 plasmashell && kstart6 plasmashell`
(older KDE: `kstart5`; your desktop will flicker/redraw, that's normal) —
or just log out and back in. Rebuilding the desktop-file cache alone
(`kbuildsycoca6 --noincremental`) plus restarting the app was *not*
sufficient on its own in testing; Plasma Shell itself needed the restart.

## What it does

- **Pick a working directory, model, and permission mode**, then chat. Claude
  runs in that directory exactly as it would from the terminal. Three ways
  to start a chat:
  - **Open folder** — point it at an existing directory.
  - **New project** — give it a name and a parent location; the app creates
    the folder for you before starting the chat.
  - **Cloud session** — send a message to a cloud session that already
    exists (create one with `claude --cloud "description"` in a terminal,
    or from claude.ai/code, then paste its ID/URL here). This is a one-way
    send, not a chat: `claude --cloud` in print mode only queues the message
    and hands back an acknowledgment + link — it can't stream back a reply
    (confirmed directly against a real cloud session; `--output-format
    stream-json` is rejected outright together with `--cloud`, and the
    non-streaming `json` format's success response carries no reply text
    either). So each send just shows a ✓ with a link to view the actual
    reply on claude.ai/code or the mobile app. Starting a *brand-new* cloud
    session isn't supported here either — the CLI requires a real
    interactive terminal for that step, which a GUI can't provide.
- **Streaming responses** render live as markdown, with syntax-highlighted
  code blocks — each with its own copy button, plus a hover copy button on
  every message (user and assistant).
- **Tool calls** (Bash, Read, Edit, WebFetch, …) show as collapsible cards
  with their input and result/error, instead of raw log lines. `Edit` calls
  render as a real red/green line diff instead of raw JSON; `Read`/`Write`/
  `Edit` cards get "Open file" / "Reveal in file manager" buttons; a `Write`
  that produces an `.html` file gets a "Preview" button that opens it live
  in its own window.
- **Extended thinking**, when the model produces it, shows in a collapsed
  "Thinking" section.
- **File and image attachments** — attach via the paperclip button, drag files
  onto the composer, or paste an image straight from the clipboard.
- **Edit, regenerate, and retry** — edit your last message and resend it,
  ask again without retyping, or retry after a failed turn. The CLI can't
  rewrite history, so the superseded exchange collapses into a "Previous
  message" disclosure rather than vanishing.
- **@-file-mention and /slash-command autocomplete** in the composer; the
  slash list is pulled live from each session, not hardcoded.
- **A Tools panel** (sidebar → Tools) covering things the CLI can already do
  but had no GUI for: every interactive/background Claude Code session
  running on the machine (not just this app's), past sessions on disk you
  can resume, MCP server management, plugin enable/disable, and a local
  cost-per-chat rollup.
- **An in-app CLAUDE.md editor**, full-text chat search, exporting a chat to
  Markdown, and an in-chat find bar (Ctrl+F).
- **Chat history** is saved locally (per-chat transcript + Claude's own
  session id) so you can close the app and resume a conversation later —
  each resumed local chat relaunches `claude --resume <id>` under the hood.
  Pin or archive chats to keep the sidebar organized.
- **A system tray icon** with a global show/hide hotkey (default
  `Ctrl+Alt+Space`) and native desktop notifications when a turn finishes
  while you're elsewhere — closing the window hides it to the tray rather
  than quitting, so background chats keep running.
- **Light/dark theme** and an accent color picker, following the system by
  default with a manual override.
- **Multiple windows** — open another window from any chat's topbar to work
  on two chats side by side; they share the same sessions and settings.
- **An embedded terminal** (Tools → Terminal, or "Attach" on a background
  session in the Agents tab) — a real pty running the actual `claude`
  binary, rendered with xterm.js. Because it's a genuine interactive TTY
  and not a re-implementation, everything that only works in a real
  terminal comes along for free: Remote Control (on by default — every
  interactive session prints a claude.ai/code link), `/rewind`, and
  `claude attach <id>` on a background session.
- **Real per-tool permission prompts and plan-mode approval** — see
  "Permission modes" below.

## Permission modes

`--print` mode's own permission prompts have nowhere to go by default, but
`claude` ships exactly the hook this app needs: `--permission-prompt-tool`
lets a named MCP tool decide, per call. The app registers a small
purpose-built MCP server ([`main/permissionMcpServer.js`](main/permissionMcpServer.js))
for this — each pending decision crosses a local Unix socket
([`main/permissionBridge.js`](main/permissionBridge.js)) to the main
process, which asks the chat UI and waits for you to click Allow or Deny.
`ExitPlanMode` (how Claude asks to leave plan mode and start executing) is
just another tool call under the same mechanism, so it gets its own
plan-review card with the rendered plan instead of a raw permission prompt.

Four modes, in the picker on any new chat:

- **Ask for each action** (default) — the CLI's real default behavior: safe
  reads run immediately, anything else shows an inline Allow/Deny card
  (with an "always allow this session" option per tool name).
- **Accept edits automatically** — reads and edits run without asking;
  anything else (Bash, etc.) still prompts.
- **Plan mode** — read-only; Claude can look around and propose a plan, and
  exiting plan mode to start executing shows the plan-review card.
- **Full access** — bypasses all permission checks, including running shell
  commands. No prompts of any kind. The app asks you to confirm before
  starting a chat in this mode. Only use it in a directory you trust.

## Project layout

```
main/            Electron main process
  main.js               windows (multi-window aware) + all IPC wiring
  claudeSession.js       spawns/manages `claude -p --input-format stream-json
                         --output-format stream-json` subprocesses; wires up
                         the permission bridge per chat
  permissionBridge.js    Unix-socket relay between a chat's permission MCP
                         server and the renderer's Allow/Deny UI
  permissionMcpServer.js standalone MCP stdio server `claude` itself spawns
                         for --permission-prompt-tool (see "Permission modes")
  ptyManager.js          real pty sessions (node-pty) backing the embedded
                         terminal — interactive / attach / Remote Control
  authManager.js         drives `claude auth login/logout/status` for the Account panel
  cliTools.js            wraps `claude mcp/plugin/agents` and past-session listing
                         for the Tools panel
  trayManager.js         system tray icon, global hotkey, desktop notifications
  store.js               local JSON persistence (settings + chat history)
  preload.js              secure bridge to the renderer (also does markdown
                         rendering + sanitization, via marked/highlight.js/DOMPurify)
renderer/        The UI (plain HTML/CSS/JS, no framework/build step)
  index.html, styles.css, app.js
  vendor/          bundled highlight.js light/dark themes, xterm.js + its
                    fit addon, app icon
scripts/         package-deb.sh, package-pacman.sh — see "Installing it above"
build/           icon.png (app icon; only build-time asset)
```

No React, no bundler — the renderer is vanilla JS so `npm start` is the whole
build step.

## How it talks to Claude Code

Each chat spawns:

```
claude -p --input-format stream-json --output-format stream-json \
  --include-partial-messages --verbose \
  [--model <alias>] [--permission-mode <mode>] [--resume <session-id>]
```

and keeps writing one JSON line per user turn to its stdin for as long as the
chat stays open, reading back the CLI's newline-delimited JSON event stream
(text/thinking deltas, tool_use blocks, tool_result, and a final `result`
event with cost/duration) to drive the UI. If you stop a chat mid-response,
the next message you send relaunches the process with `--resume` to pick the
conversation back up.

Cloud-session chats don't use any of the above — each message spawns a
short-lived `claude -p "<message>" --output-format json --cloud <target>`
that exits as soon as it gets its ack, since (as covered above) `--cloud`
doesn't support streaming a reply back in print mode at all.

## Known limitations

- Opening a chat only renders its most recent ~150 blocks by default — a
  "Show N earlier messages" button loads the rest. A long-running chat
  genuinely takes real, measured time to render in full (markdown parsing
  + syntax highlighting + sanitization, done once per block): ~4.6s on a
  real 1,491-block chat, synchronous and main-thread-blocking, easily
  read as a hang or crash. Once a block finishes streaming its rendered
  HTML is cached on it, so re-opening the same chat (or clicking "show
  earlier") again in the same app session is fast the second time.
- One CLI process per open chat, plus a small companion MCP-server process
  per chat for the permission relay (skipped only in Full access mode);
  very large numbers of simultaneously open chats will spawn that many
  subprocesses.
- Linux only. A Windows build could be cross-compiled but would be unsigned
  (SmartScreen warning) and untested on real Windows; a Mac build needs an
  actual Mac plus an Apple developer certificate to sign, neither available
  here.
- Cloud-session sends are one-way, as explained above — there's no way for
  this app to show you the reply inline, only a link to go read it.
- Editing/regenerating a message can't rewrite the CLI session's own history
  (it's append-only), so the superseded exchange is hidden locally, not
  actually removed — see "What it does" above.
- Resuming a past session from the Tools panel's Sessions tab starts a fresh
  local view; it doesn't replay the old transcript into the chat pane, only
  the underlying CLI session's context.
- The in-chat find bar (Ctrl+F) is a thin wrapper over Chromium's own
  `findInPage` — if the match counter doesn't update in your environment,
  it's a Chromium/Electron-level issue, not something this app's code does
  differently per-platform.
- If your checkout path contains a space, `npm run dist`'s Electron-native
  rebuild step for `node-pty` (the embedded terminal's dependency) logs a
  `node-gyp`/[space-in-path](https://github.com/nodejs/node-gyp/issues/65)
  error and skips rebuilding — harmless here since `node-pty` 1.1.0 is
  N-API-based (ABI-stable across Node/Electron versions regardless), and
  the packaged terminal works fine either way (verified directly against a
  built package). If you ever need a real from-source rebuild of a
  non-N-API native dependency from a space-containing path, build via a
  space-free symlink instead (`ln -s "$PWD" ~/claude-lingui-build && cd
  ~/claude-lingui-build && npm install`).

## Contributing

Issues and PRs welcome. There's no build step for the renderer (vanilla
JS/HTML/CSS) and no test suite yet — `npm start` and click around is the
current verification loop. If you're changing `main/`, sanity-check with
`node -c main/<file>.js` before opening a PR.

## License

[MIT](LICENSE)
