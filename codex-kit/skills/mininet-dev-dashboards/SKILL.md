---
name: mininet-dev-dashboards
description: Use for GitHub, Render, Vercel, Cloudflare and other developer or deployment dashboards in MiniNet Browser — check deploy status, read logs, open issues and PRs, trigger redeploys when asked.
---

# Developer dashboards

- GitHub: repos at `https://github.com/<owner>/<repo>`; Actions runs under `/actions`; releases under `/releases`. Sign in with Google if needed.
- Render: `https://dashboard.render.com/` → service → Events / Logs. Vercel: `https://vercel.com/dashboard` → project → Deployments.
- Read status and logs with `read_text` + `find` (e.g. find:"Error"). Quote the exact lines.
- Allowed when the owner asked: redeploy, re-run a failed job, open an issue.
- Always `ask_user` before: changing environment variables or secrets, deleting anything, changing billing, transferring or making repos public.
- Never copy secrets, tokens or API keys into chat, files or messages.
- If the work is code on this laptop, you may use the shell too — but web dashboards go through MiniNet.
