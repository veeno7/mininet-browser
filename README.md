<p align="center">
  <img src="docs/img/icon.png" width="96" alt="MiniNet Browser logo">
</p>

<h1 align="center">MiniNet Browser</h1>

<p align="center">
  <b>The browser your AI can drive — with you in control.</b><br>
  The eyes and hands for any AI — Claude, ChatGPT, Gemini or your own local model.
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

- 🤖 **Any AI can drive it** — Claude (Desktop, Code, claude.ai connector), ChatGPT (connectors or custom GPT Actions), Cursor, Windsurf, Codex, Gemini, local Ollama models, or your own scripts.
- 👥 **Many AIs at once** — Claude, ChatGPT and Gemini can all work in the browser at the same time, each in its own tab. Any AI can also start **helper agents** (`start_helper`) that work in parallel — one answers messages while another edits or researches. Watch them all side by side in **Team view**.
- 🔗 **Permanent connector link** — set up a free ngrok address once; paste the link into your AI and it keeps working every time the browser is open.
- 🎯 **Missions with proof** — goals, budgets and success checks the browser verifies itself, with a replayable evidence record.
- ✋ **You approve first** — an AI shows its plan; you press **Allow**, **Always allow** or **Deny**. A glowing outline and a "Claude is using the browser · Stop AI" bar show exactly what it's doing.
- 🪐 **Orbit, a built-in assistant** — bring your own key (Claude, ChatGPT, Gemini, Groq, OpenRouter) or run free with Ollama. Talk to it by voice.
- 🧩 **Extensions anyone (or any AI) can write** — tell your AI "build me an extension that…" and it appears.
- 💬 **MiniNet Chat built in** — a tiny local social feed and chat rooms (Chirp, Talk, People), a safe practice ground for people *and* AI agents.
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
| **claude.ai / ChatGPT connectors** | Turn on the **Permanent link** (free ngrok authtoken, one-time), copy the connector link, add it as a custom connector (choose *No sign in*). |
| **ChatGPT custom GPT** | Configure → Actions → *Import from URL* → paste the **ChatGPT Actions link**. |
| **Orbit with any model** | Claude, ChatGPT, Gemini, Grok, DeepSeek, Kimi, Qwen, Mistral, Groq, OpenRouter — or free local Ollama / LM Studio. |
| **Local AI (Ollama, LM Studio)** | Pick *Ollama* in Orbit settings, or point any local MCP client at the **local link** `http://127.0.0.1:7811/t/<key>/mcp`. |
| **Cursor, Windsurf, Codex, others** | Copy the MCP JSON config from the panel. |
| **Your own code** | `POST http://127.0.0.1:7811/api/tools/<tool>` with `Authorization: Bearer <key>` |

### Tools an AI gets (38)

`list_tabs` `open_tab` `navigate` `go_back` `go_forward` `reload` `switch_tab` `close_tab` `close_other_tabs`
`snapshot` `read_text` `click` `type` `select_option` `press_key` `scroll` `hover` `screenshot` `run_js` `wait_for` `download`
`speak` `show_message` `request_permission` `ask_user`
`list_extensions` `get_extension` `save_extension` `toggle_extension` `delete_extension`
`mission_start` `mission_verify` `mission_note` `mission_finish` `mission_report`
`start_helper` `check_helpers` `stop_helper`

Agents see inside embedded frames (payment boxes, embedded forms, MiniNet sites), click by visible text (`click {text:"Reject all"}`), and get warned when a pop-up covers what they're clicking.

## Missions — proof, not promises

For bigger jobs an AI starts a **mission**: a goal, success criteria, an action budget and (optionally) the only sites it may visit.

- Every action is recorded with the page before/after and a screenshot — a black-box record you can replay in the **Missions** panel.
- Success criteria are checked **by the browser itself** on the live page (`text_on_page`, `element_exists`, `element_text`, `url_contains`). The AI can't just claim it's done.
- A mission ends **✓ Verified** only if every check passed — otherwise **Unverified** or **Failed**, with the evidence.
- Budgets and allowed-sites are enforced; password/card fields are hidden in the record.

```text
mission_start  { goal: "Star the MiniNet repo on GitHub", success_criteria: ["The repo shows as starred"], max_steps: 15 }
…navigate / click / type…
mission_verify { criterion: 1, check: "text_on_page", value: "Starred" }
mission_finish { summary: "Starred veeno7/mininet-browser" }   →  ✓ Verified
```

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

- 🧭 Outcome Engine: self-healing steps, reusable tested skills, resumable missions
- ☁️ MiniNet Cloud: run missions on hosted browsers while your computer is off
- ✍️ Code-signed installer + auto-update, macOS build
- 🏪 Extension store
- 💼 **MiniNet Pro** — cloud MiniNet, agent playground with tasks & scoring for AI developers

Want Pro early or have a business use case? [Open an issue](https://github.com/veeno7/mininet-browser/issues/new?title=Pro%20waitlist&body=Tell%20us%20what%20you%27d%20use%20MiniNet%20Pro%20for%3A) and say hi.

## License

MIT © Seyi
