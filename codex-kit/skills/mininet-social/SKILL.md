---
name: mininet-social
description: Use for Instagram, Facebook, TikTok, X or LinkedIn tasks in MiniNet Browser — checking messages and notifications, replying, researching trends, preparing posts.
---

# Social media in MiniNet

- `list_accounts` first; if a site is not signed in, use "Continue with Google" or `ask_user`.
- Messages: open the inbox (Instagram `https://www.instagram.com/direct/inbox/`, Facebook `https://www.facebook.com/messages/`, TikTok `https://www.tiktok.com/messages`), open the thread, `read_text`, reply with `type` + `submit:true`.
- Business conversations follow the `mininet-business` skill (client memory, prices, payments).
- Research: search the site or `navigate` with search words; report numbers and names exactly as shown.
- Posting, commenting publicly, following/unfollowing, or messaging people who did not write first → `ask_user` first.
- Respect the speed limit (15 messages a minute). Never spam, never buy followers, never automate likes in bulk.
- Pages change often: if something fails, snapshot, adapt, and save the working method with `save_skill`.
