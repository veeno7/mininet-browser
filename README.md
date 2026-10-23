<p align="center">
  <img src="docs/img/icon.png" width="96" alt="MiniNet Browser logo">
</p>

<h1 align="center">MiniNet Browser</h1>

<p align="center">
  <b>The browser your AI can drive — with you in control.</b><br>
  The real web, plus a tiny internet of your own.
</p>

<p align="center">
  <a href="https://github.com/veeno7/mininet-browser/releases/latest"><b>⬇ Download for Windows</b></a> ·
  <a href="https://veeno7.github.io/mininet-browser/">Website</a> ·
  <a href="#connect-your-ai">Connect your AI</a> ·
  <a href="#extensions">Extensions</a>
</p>

<p align="center"><img src="docs/img/ai-driving.png" width="860" alt="Claude driving MiniNet Browser"></p>

---

## Why MiniNet Browser?

Most AI assistants can talk about the web. MiniNet Browser lets them **use** it — click, type, shop, post, fill forms, watch videos and build things — while you watch every step and stay in charge.

- 🤖 **Any AI can drive it** — Claude (Desktop, Code, claude.ai connector), ChatGPT, Cursor, Windsurf, Codex, Gemini, local Ollama models, or your own scripts.
- ✋ **You approve first** — an AI shows its plan; you press **Allow**, **Always allow** or **Deny**. A glowing outline and a "Claude is using the browser · Stop AI" bar show exactly what it's doing.
- 🪐 **Orbit, a built-in assistant** — bring your own key (Claude, ChatGPT, Gemini, Groq, OpenRouter) or run free with Ollama. Talk to it by voice.
- 🧩 **Extensions anyone (or any AI) can write** — tell your AI "build me an extension that…" and it appears.
- 🌍 **MiniNet built in** — a whole mini-internet in one file: social network, email, shop, bank, wiki, chat rooms, games and a website builder. A safe playground for people *and* AI agents.
- 🔒 **Core is locked** — AI can only act on web pages and extensions. It can never change the browser's own code, read your files, or open local file pages.
- 🛡️ **Ad blocker, data saver, tabs, bookmarks, history, downloads, themes** — everything you expect from a modern browser.

## Screenshots

| Start page | Orbit doing a task |
|---|---|
| <img src="docs/img/start.png" width="420"> | <img src="docs/img/orbit.png" width="420"> |
| **You approve the plan** | **Connect any AI** |
| <img src="docs/img/permission.png" width="420"> | <img src="docs/img/ai-control.png" width="420"> |

## Install

1. Download the latest **`MiniNet-Browser-…-win-x64.zip`** from [Releases](https://github.com/veeno7/mininet-browser/releases/latest).
2. Unzip it anywhere and run **`MiniNet Browser.exe`**.
   (Windows may say "unknown publisher" until the app is code-signed — click *More info → Run anyway*.)

## Connect your AI

Open the 🔌 **AI control** panel in the sidebar.

| AI | How |
|---|---|
| **Claude Desktop** | Press **Connect Claude Desktop**, restart Claude. |
| **Claude Code** | Copy the one-line `claude mcp add …` command shown in the panel. |
| **claude.ai / ChatGPT connectors** | Press **Create connector link**, then add it as a custom connector (choose *No sign in*). |
| **Cursor, Windsurf, Codex, others** | Copy the MCP JSON config from the panel. |
| **Your own code** | `POST http://127.0.0.1:7811/api/tools/<tool>` with `Authorization: Bearer <key>` |

### Tools an AI gets (31)

`list_tabs` `open_tab` `navigate` `go_back` `go_forward` `reload` `switch_tab` `close_tab` `close_other_tabs`
`snapshot` `read_text` `click` `type` `select_option` `press_key` `scroll` `hover` `screenshot` `run_js` `wait_for` `download`
`speak` `show_message` `request_permission` `ask_user`
`list_extensions` `get_extension` `save_extension` `toggle_extension` `delete_extension`

Agents see inside embedded frames (payment boxes, embedded forms, MiniNet sites), click by visible text (`click {text:"Reject all"}`), and get warned when a pop-up covers what they're clicking.

## Extensions

An extension is a folder with `manifest.json`, `content.js` and/or `content.css`:

```json
{ "name": "Reading Ruler", "description": "Alt+R shows a reading guide", "matches": ["<all_urls>"] }
```

`matches` accepts patterns like `*://*.youtube.com/*`, `mini://*` or `<all_urls>`. Extensions live in your user folder, never inside the browser's core.

## Build from source

```bash
npm install
npm start            # run in development
npm run build        # Windows build into dist/
```

Releases are built automatically by GitHub Actions whenever a `v*` tag is pushed.

## Roadmap

- 🌐 Shared online MiniNet with real accounts (multiplayer)
- 🔗 Permanent connector links
- ✍️ Code-signed installer + auto-update, macOS build
- 🧠 MiniNet residents powered by your own AI
- 🏪 Extension store
- 💼 **MiniNet Pro** — cloud MiniNet, agent playground with tasks & scoring for AI developers

Want Pro early or have a business use case? [Open an issue](https://github.com/veeno7/mininet-browser/issues/new?title=Pro%20waitlist&body=Tell%20us%20what%20you%27d%20use%20MiniNet%20Pro%20for%3A) and say hi.

## License

MIT © Seyi
