---
name: mininet-content-studio
description: Use when the owner wants images or videos made and edited — generate in Google Flow, edit in CapCut, save to Downloads, and (after approval) post to YouTube/Instagram/TikTok — all inside MiniNet Browser.
---

# Content studio

## Make
1. Google Flow (`https://flow.google.com/`, owner signed in with Google): type the idea in "What do you want to create?". Images first, then turn the best image into a video. Video uses the owner's free monthly credits — Flow asks before spending; say how many credits it will use.
2. Download the result: get the `<video>`/`<img>` source with `run_js` and use `download`, then `list_downloads` to see the file name.

## Edit
1. CapCut editor (`https://www.capcut.com/editor`). Upload with `upload_file` (selector `input[type=file][multiple]`).
2. Trim or move clips with `drag` on the clip edges. Add a title: Text → Add heading, double-click it, ctrl+a, type.
3. Export → Download → set the name → Export. The file lands in Downloads; confirm with `list_downloads`.

## Publish
- Posting is public: `ask_user` with the file name, title, caption and where, BEFORE pressing the final Publish/Post.
- YouTube: Create → Upload video → `upload_file` → title/description → visibility → Publish (after approval).

## Tips
- Save working steps as skills (`save_skill`) for Flow and CapCut so the next run is faster.
