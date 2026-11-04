# Pino IDE

A quiet, fast, true-black code editor for macOS with the AI models you already use built in. Local-first: it detects LM Studio and Ollama on its own, and also works with Claude, OpenAI, Grok and DeepSeek.

Built with [Tauri 2](https://tauri.app) and the [Monaco](https://microsoft.github.io/monaco-editor/) editor engine. The app is small (about 10 MB) and the interface is plain HTML, CSS and JavaScript, so it is easy to restyle.

## What it does

- **Folders and files.** Open a folder, browse it in the sidebar, create, rename and trash files, jump to any file with `⌘P`.
- **Editor.** Monaco with syntax highlighting for dozens of languages, tabs, breadcrumbs, a diff review view, and detection of changes made outside the app.
- **Chat with your code.** The open file is shared automatically. Add other files or a selection with one click.
  - **Ask** mode answers questions.
  - **Edit** mode has the model propose changes. You review each one as a side-by-side diff before anything is written.
- **Inline autocomplete.** Ghost-text suggestions from the model you choose. Chat-style or fill-in-the-middle.
- **Models.** LM Studio and Ollama are detected automatically. Any other local server (llama.cpp, vLLM, Jan, KoboldCpp, anything OpenAI-compatible) can be added by address, or found with **Scan for local servers**. Cloud: Claude API, OpenAI, Grok (xAI), DeepSeek.
- **Claude subscription.** If you have [Claude Code](https://claude.com/claude-code) installed and signed in, Pino can drive it, so your subscription works without an API key. Ask mode is read-only; Edit mode lets Claude Code change files in the open folder.

## Run it from source

You need macOS 12+, [Node.js](https://nodejs.org) 20+, and [Rust](https://rustup.rs).

```bash
npm install
npm run tauri dev
```

## Build the app (unsigned DMG)

```bash
npm run tauri build -- --bundles dmg,app
```

The DMG is written to `src-tauri/target/release/bundle/dmg/`.

Or let GitHub build it: push the repo, open **Actions → Build macOS app → Run workflow**, then download the DMG from the run's artifacts. Pushing a tag such as `v0.1.0` also attaches the DMGs to a GitHub release. The workflow builds for both Apple Silicon and Intel.

### Opening an unsigned app

Pino is not signed with a paid Apple Developer account, so macOS quarantines it after download and may say **"Pino IDE is damaged and can't be opened"**. The app is fine. Drag it to Applications, then run this once in Terminal:

```bash
xattr -cr "/Applications/Pino IDE.app"
```

If macOS still refuses, sign it locally (free, no account) and try again:

```bash
codesign --force --deep --sign - "/Applications/Pino IDE.app"
```

If macOS instead says it is from an unidentified developer, go to **System Settings → Privacy & Security** and click **Open Anyway**.

## Connecting models

Open **Settings (`⌘,`) → Models**.

| Provider | Setup |
| --- | --- |
| LM Studio | Start its local server (Developer tab). Pino finds it at `localhost:1234` and lists every model. |
| Ollama | Detected at `localhost:11434`. |
| Another local server | **Add custom server** and paste the address (usually ending in `/v1`), or press **Scan for local servers**. Change the port any time. |
| Claude Code | Install it, run `claude` once in Terminal to sign in. Pino finds it automatically. |
| Claude API, OpenAI, Grok, DeepSeek | Paste an API key. |

API keys are stored in the macOS Keychain, never in a file, and are never sent to the page's JavaScript after saving. A key is only sent over plain `http` to local network addresses.

## Autocomplete

**Settings → Autocomplete.** Pick a provider and model, turn it on, and press `Tab` to accept a suggestion. A small local coding model gives the best speed. If your model supports fill-in-the-middle (Qwen Coder, DeepSeek Coder base models), choose that method.

## Keyboard shortcuts

| Shortcut | Action |
| --- | --- |
| `⌘O` | Open folder |
| `⌘P` / `⇧⌘P` | Find a file / command palette |
| `⌘S` / `⌥⌘S` | Save / save all |
| `⌘W` | Close tab |
| `⌘B` | Toggle sidebar |
| `⌘J` / `⌘L` | Toggle chat / focus chat |
| `⇧⌘L` | Add selected code to the chat |
| `⌘,` | Settings |

## Safety notes

- File access is limited to the folder you opened. Paths that escape it (including through symbolic links) are refused.
- Deleting moves items to the Trash.
- In Edit mode with an API or local model, nothing is written until you press Apply.
- In Edit mode with Claude Code, Claude Code edits files itself, as it does in Terminal. Use Ask mode when you only want answers.
- Your open file and anything you attach is sent to the model you choose. For local models that stays on your machine.

## Project layout

```
src/            Interface (vanilla JS modules, no framework)
  editor.js       Monaco, tabs, diff review
  chat.js         Chat panel, Ask/Edit, change cards
  providers.js    Model lists and streaming for every provider
  edits.js        SEARCH/REPLACE parsing and safe application
  completion.js   Inline autocomplete
  settings.js     Settings screens
src-tauri/      Rust backend (files, Keychain, streaming HTTP, Claude Code runner)
```

## Contributing

Issues and pull requests are welcome. Run `cargo test` inside `src-tauri` for the backend tests.

## License

MIT
