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

### Not included, and why

- **Remote Control** (controlling a session from claude.ai/code or the
  mobile app) — tested it directly: passing `--remote-control` alongside the
  headless `--print`/stream-json mode this app uses is accepted but is a
  no-op, since Remote Control mirrors an actual interactive terminal
  session, which headless mode doesn't have. Nothing to wire up.
- **Attaching a real terminal to a background session** (`claude attach`) —
  the Tools panel's Agents tab can list, stop, and remove background
  sessions, but actually attaching one live would mean embedding a real
  terminal emulator (a pty + something like xterm.js) alongside the chat
  view, which is a bigger, separate feature.
- **Per-tool interactive permission prompts** and a **plan-mode approval
  flow** — both would need the CLI's `--permission-prompt-tool` MCP callback
  protocol wired up as a real approve/deny round-trip; see "Permission
  modes" below for what's there instead.
- **`/rewind` checkpoints** — terminal/TTY-only, no scriptable equivalent as
  of the CLI version this was built against.

## Permission modes

The CLI's own interactive permission prompts don't have anywhere to go in
`--print` mode, so the app exposes three modes up front instead of prompting
per-action:

- **Accept edits automatically** — Claude can read/write files freely; other
  actions follow the CLI's normal defaults.
- **Plan mode** — read-only; Claude can't change anything.
- **Full access** — bypasses all permission checks, including running shell
  commands. The app asks you to confirm before starting a chat in this mode.
  Only use it in a directory you trust.

## Project layout

```
main/            Electron main process
  main.js          windows (multi-window aware) + all IPC wiring
  claudeSession.js spawns/manages `claude -p --input-format stream-json
                    --output-format stream-json` subprocesses
  authManager.js   drives `claude auth login/logout/status` for the Account panel
  cliTools.js      wraps `claude mcp/plugin/agents` and past-session listing
                    for the Tools panel
  trayManager.js   system tray icon, global hotkey, desktop notifications
  store.js         local JSON persistence (settings + chat history)
  preload.js       secure bridge to the renderer (also does markdown
                    rendering + sanitization, via marked/highlight.js/DOMPurify)
renderer/        The UI (plain HTML/CSS/JS, no framework/build step)
  index.html, styles.css, app.js
  vendor/          bundled highlight.js light/dark themes, app icon
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

- No inline approval for individual tool calls — see "Permission modes"
  above. A future version could support this via a permission-prompt tool.
- One CLI process per open chat; very large numbers of simultaneously open
  chats will spawn that many subprocesses.
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

## Contributing

Issues and PRs welcome. There's no build step for the renderer (vanilla
JS/HTML/CSS) and no test suite yet — `npm start` and click around is the
current verification loop. If you're changing `main/`, sanity-check with
`node -c main/<file>.js` before opening a PR.

## License

[MIT](LICENSE)
