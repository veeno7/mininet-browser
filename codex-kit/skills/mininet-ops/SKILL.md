---
name: mininet-ops
description: Use when checking whether MiniNet and its connections are healthy, troubleshooting a failing tool, or reviewing what AIs did (audit) — and to keep the browser tidy.
---

# Keeping MiniNet healthy

- `business_status` shows the watcher state, WhatsApp state (ok / signed-out / loading) and recent events.
- `audit_log` (optionally a search word) shows every recent action by every AI.
- `list_tabs` — close only tabs you opened yourself when you are done.
- A tool says "Waiting for the owner to press Allow" → the owner must approve in MiniNet; tell them, then retry.
- A page is stuck: `reload` the tab, or open a fresh tab.
- WhatsApp shows a QR code → `ask_user` to scan it.
- Never restart, close, or change MiniNet's own settings or files; never kill processes named MiniNet or ngrok. If MiniNet must restart, ask the owner.
