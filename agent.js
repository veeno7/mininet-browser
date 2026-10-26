// MiniNet Browser — AI control engine.
// One set of tools, used by: the built-in Orbit assistant, the local HTTP API,
// and MCP (Claude Desktop, Claude Code, Cursor, any MCP client).
// Tools can only act on web pages and user extensions — never on the app's own code or the user's files.
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { webContents, nativeImage, app: eApp, session: eSession } = require('electron');
const ext = require('./extensions');

let cfg = { enabled: true, port: 7811, token: '', mode: 'ask', trusted: [] };
let cfgPath = '';
let shellReq = null;       // (op, args) => Promise  — talks to the browser UI
let notify = () => {};     // (event) => void        — activity feed for the UI
let server = null;
let paused = false;
const log = [];

/* ---------------- config ---------------- */
function loadConfig(userData) {
  cfgPath = path.join(userData, 'agent.json');
  try { cfg = Object.assign(cfg, JSON.parse(fs.readFileSync(cfgPath, 'utf8'))); } catch {}
  if (!cfg.token) cfg.token = crypto.randomBytes(24).toString('hex');
  loadNames();
  saveConfig();
}
function saveConfig() { try { fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2)); } catch {} }
function isTrusted(client) { return (cfg.trusted || []).includes(client); }
function trust(client) { cfg.trusted = [...new Set([...(cfg.trusted || []), client])]; saveConfig(); notify({ type: 'approvals' }); }
function getConfig() { return { ...cfg, paused, approved: [...new Set([...(cfg.trusted || []), ...approvals.keys()])].map(client => ({ client, always: isTrusted(client), plan: (approvals.get(client) || {}).plan || '', since: (approvals.get(client) || {}).t })), url: `http://127.0.0.1:${cfg.port}`, mcpUrl: `http://127.0.0.1:${cfg.port}/mcp`, running: !!(server && server.listening) }; }
function setConfig(c) {
  const portChanged = c.port && +c.port !== cfg.port;
  if (typeof c.enabled === 'boolean') cfg.enabled = c.enabled;
  if (c.port) cfg.port = Math.max(1024, Math.min(65535, +c.port || 7811));
  if (c.mode === 'ask' || c.mode === 'auto') cfg.mode = c.mode;
  if (c.revoke) { approvals.delete(c.revoke); cfg.trusted = (cfg.trusted || []).filter(n => n !== c.revoke); }
  if (c.revokeAll) { approvals.clear(); cfg.trusted = []; }
  if (c.regenerate) cfg.token = crypto.randomBytes(24).toString('hex');
  saveConfig();
  if (portChanged || 'enabled' in c) restart();
  return getConfig();
}
function setPaused(p) { paused = !!p; notify({ type: 'paused', paused }); }

/* ---------------- helpers ---------------- */
const sleep = ms => new Promise(r => setTimeout(r, ms));
const text = t => ({ content: [{ type: 'text', text: typeof t === 'string' ? t : JSON.stringify(t, null, 2) }] });

async function tabWC(tab) {
  if (tab != null && +tab > 1000) {   // a sign-in pop-up window
    const p = popupsFn().find(x => x.id === +tab);
    if (!p) throw new Error(`The pop-up window ${tab} is closed (sign-in pop-ups close themselves when done). Use list_tabs.`);
    return { tab: p, wc: webContents.fromId(p.wcId) };
  }
  const tabs = await shellReq('list');
  const t = tab == null ? tabs.find(x => x.active) : tabs.find(x => x.id === +tab);
  if (!t) throw new Error(tab == null ? 'No active tab' : `No tab with id ${tab}. Use list_tabs.`);
  const wc = t.wcId ? webContents.fromId(t.wcId) : null;
  if (!wc || wc.isDestroyed()) throw new Error('That tab is not ready yet, try again in a moment.');
  return { tab: t, wc };
}
// grace: how long to watch for a page load that an action (click, Enter) may start a little later
async function waitLoad(wc, timeout = 15000, grace = 0) {
  const t0 = Date.now();
  await sleep(250);
  if (grace) while (!wc.isLoading() && Date.now() - t0 < grace) await sleep(100);
  const start = Date.now();
  while (wc.isLoading() && Date.now() - start < timeout) await sleep(150);
  await sleep(150);
}
function js(wc, code) { return wc.executeJavaScript(code, true); }

const SNAPSHOT_JS = (maxEl, maxText, start = 1) => `(() => {
  if (innerWidth < 5 || innerHeight < 5) return null;
  if (!window.__mnAll) { window.__mnAll = (sel, root = document) => { const out = [...root.querySelectorAll(sel)]; for (const h of root.querySelectorAll('*')) if (h.shadowRoot) out.push(...window.__mnAll(sel, h.shadowRoot)); return out; }; window.__mnQ = sel => { try { return document.querySelector(sel) || window.__mnAll(sel)[0] || null; } catch (e) { throw e; } }; window.__mnIn = (t, host) => { for (let n = t; n; n = n.parentNode || n.host) { if (n === host) return true; } return false; }; }
  window.__mnAll('[data-mn-ref]').forEach(e => e.removeAttribute('data-mn-ref'));
  const sel = 'a[href],button,input:not([type=hidden]),textarea,select,summary,[role=button],[role=link],[role=checkbox],[role=radio],[role=tab],[role=menuitem],[role=option],[role=switch],[role=textbox],[role=combobox],[role=searchbox],[contenteditable=""],[contenteditable=true],[onclick],[tabindex]:not([tabindex="-1"])';
  const out = []; let n = ${start - 1}; const first = n;
  const vis = e => { const r = e.getBoundingClientRect(); if (r.width < 2 || r.height < 2) return false; const s = getComputedStyle(e); return s.visibility !== 'hidden' && s.display !== 'none' && +s.opacity !== 0; };
  for (const e of window.__mnAll(sel)) {
    if (n - first >= ${maxEl}) break;
    if (!vis(e)) continue;
    n++; e.setAttribute('data-mn-ref', n);
    const r = e.getBoundingClientRect();
    const tag = e.tagName.toLowerCase();
    const role = e.getAttribute('role') || (tag === 'input' ? (e.type || 'text') : '');
    const lab = (e.labels && e.labels[0] && e.labels[0].innerText) || '';
    let name = (e.getAttribute('aria-label') || (tag === 'input' || tag === 'textarea' || tag === 'select' ? (lab || e.placeholder || e.title || e.name) : (e.innerText || e.title || e.alt || e.value)) || '').trim().replace(/\\s+/g, ' ').slice(0, 90);
    if (!name && e.querySelector('img[alt]')) name = e.querySelector('img[alt]').alt;
    let line = '[' + n + '] ' + tag + (role ? '(' + role + ')' : '') + ' "' + name + '"';
    if (tag === 'a') line += ' -> ' + (e.getAttribute('href') || '').slice(0, 100);
    if ((tag === 'input' || tag === 'textarea' || tag === 'select') && e.value) line += ' value="' + String(e.value).slice(0, 60) + '"';
    if (e.checked) line += ' [checked]';
    if (e.disabled) line += ' [disabled]';
    if (r.bottom < 0 || r.top > innerHeight) line += ' (offscreen)';
    out.push(line);
  }
  const body = document.body ? document.body.innerText.replace(/\\n{3,}/g, '\\n\\n') : '';
  return { title: document.title, url: location.href, elements: out, text: body.slice(0, ${maxText}), textLength: body.length,
    scroll: { y: Math.round(scrollY), height: document.documentElement.scrollHeight, viewport: innerHeight } };
})()`;

function displayUrl(u) {
  if (/mininet\/MiniNet\.html/.test(u)) return 'mini://' + decodeURIComponent((u.split('#')[1] || 'home.mini'));
  if (/start\.html/.test(u)) return 'about:start';
  if (/^data:/.test(u)) return u.slice(0, 40) + '…';
  return u;
}

/* ---- frames: AI can see and use content inside iframes (MiniNet sites, embedded forms, payment boxes) ---- */
const refFrames = new Map();   // webContents id -> Map(ref -> frame)
function framesOf(wc) { try { return wc.mainFrame.framesInSubtree.filter(f => !f.detached); } catch { return [wc.mainFrame]; } }
function fjs(frame, code) { return frame.executeJavaScript(code, true); }
async function frameOffset(frame) {
  let x = 0, y = 0, f = frame;
  while (f.parent) {
    const p = f.parent;
    const idx = p.frames.findIndex(c => c.frameTreeNodeId === f.frameTreeNodeId);
    const r = await fjs(p, `(() => { const el = [...document.querySelectorAll('iframe,frame')][${idx}]; if (!el) return null; const b = el.getBoundingClientRect(); return { x: b.left + el.clientLeft, y: b.top + el.clientTop }; })()`).catch(() => null);
    if (!r) return null;
    x += r.x; y += r.y; f = p;
  }
  return { x, y };
}
const LOCATE_JS = (ref, sel, label) => `(() => {
  let e = null, bs = 3;
  const ref = ${ref == null ? 'null' : +ref}, sel = ${JSON.stringify(sel || null)}, label = ${JSON.stringify(label || null)};
  if (!window.__mnAll) { window.__mnAll = (sel, root = document) => { const out = [...root.querySelectorAll(sel)]; for (const h of root.querySelectorAll('*')) if (h.shadowRoot) out.push(...window.__mnAll(sel, h.shadowRoot)); return out; }; window.__mnQ = sel => { try { return document.querySelector(sel) || window.__mnAll(sel)[0] || null; } catch (e) { throw e; } }; window.__mnIn = (t, host) => { for (let n = t; n; n = n.parentNode || n.host) { if (n === host) return true; } return false; }; }
  if (ref != null) e = window.__mnQ('[data-mn-ref="' + ref + '"]');
  else if (sel) { try { e = window.__mnQ(sel); } catch (err) { return { error: 'Bad CSS selector: ' + err.message }; } }
  else {
    const want = label.trim().toLowerCase();
    const cands = window.__mnAll('a,button,input,textarea,select,summary,label,[role],[onclick],[tabindex],li,span,div,h1,h2,h3,h4,p,td')
      .filter(el => { const b = el.getBoundingClientRect(); return b.width > 1 && b.height > 1 && getComputedStyle(el).visibility !== 'hidden'; });
    const txt = el => (el.getAttribute('aria-label') || el.innerText || el.value || el.placeholder || el.title || '').trim().replace(/\\s+/g, ' ').toLowerCase();
    const score = el => { const t = txt(el); if (!t) return 0; if (t === want) return 3; if (t.startsWith(want)) return 2; if (t.includes(want)) return 1; return 0; };
    let best = null; bs = 0;
    for (const el of cands) { const sc = score(el); if (sc > bs || (sc === bs && sc > 0 && best && best.contains(el))) { best = el; bs = sc; } }
    e = best && (best.closest('button,a,[role=button],[role=link],[role=menuitem],[role=tab],[role=checkbox],label,summary,[onclick]') || best);
  }
  if (!e) return null;
  window.__mnAll('[data-mn-target]').forEach(x => x.removeAttribute('data-mn-target'));
  e.setAttribute('data-mn-target', '1');
  e.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
  const host = e.closest('button,a,[role=button],[role=link],label,summary,[onclick]') || e;
  // try several points (multi-line links, odd shapes) and pick one that really hits the element
  const pts = [];
  for (const r of [...e.getClientRects()].slice(0, 6)) if (r.width > 1 && r.height > 1) pts.push([r.left + r.width / 2, r.top + r.height / 2], [r.left + Math.min(8, r.width / 2), r.top + r.height / 2]);
  const b = e.getBoundingClientRect(); pts.push([b.left + b.width / 2, b.top + Math.min(b.height / 2, 20)], [b.left + 6, b.top + 6]);
  let hit = null, firstTop = null;
  for (const [x, y] of pts) {
    if (x < 0 || y < 0 || x > innerWidth || y > innerHeight) continue;
    let t = document.elementFromPoint(x, y);
    while (t && t.shadowRoot) { const inner = t.shadowRoot.elementFromPoint(x, y); if (!inner || inner === t) break; t = inner; }
    if (!firstTop) firstTop = t;
    if (t && (window.__mnIn(t, host) || window.__mnIn(host, t) && t === e)) { hit = [x, y]; break; }
  }
  let covered = null;
  if (!hit) {
    hit = pts[0] || [b.left + b.width / 2, b.top + b.height / 2];
    const t = firstTop;
    if (t) covered = (t.closest('[role=dialog],dialog,[aria-modal=true]') ? 'a dialog/popup: ' : '') + t.tagName.toLowerCase() + (t.id ? '#' + t.id : '') + ' "' + (t.innerText || '').trim().replace(/\\s+/g, ' ').slice(0, 60) + '"';
  }
  return { score: bs, x: hit[0], y: hit[1], tag: e.tagName.toLowerCase(), name: (e.innerText || e.value || e.getAttribute('aria-label') || e.placeholder || '').trim().slice(0, 60), covered };
})()`;
async function pointFor(wc, { ref, selector, x, y, text: label }) {
  if (x != null && y != null) return { x: +x, y: +y, frame: wc.mainFrame };
  if (ref == null && !selector && !label) throw new Error('Give a ref (from snapshot), visible text, a CSS selector, or x/y coordinates.');
  const frames = ref != null ? [(refFrames.get(wc.id) || new Map()).get(+ref) || wc.mainFrame] : framesOf(wc);
  let best = null;
  for (const frame of frames) {
    let r; try { r = await fjs(frame, LOCATE_JS(ref, selector, label)); } catch { continue; }
    if (r && r.error) throw new Error(r.error);
    if (!r) continue;
    const off = frame.parent ? await frameOffset(frame) : { x: 0, y: 0 };
    if (!off) continue;
    const z = wc.getZoomFactor();
    const cand = { score: r.score || 0, x: (r.x + off.x) * z, y: (r.y + off.y) * z, tag: r.tag, name: r.name, covered: r.covered, frame, inFrame: !!frame.parent };
    if (!label) return cand;                       // ref/selector: first match wins
    if (!best || cand.score > best.score) best = cand;
    if (best.score === 3 && !best.inFrame) break;  // exact match on the main page
  }
  if (best) { if (best.inFrame) await fjs(best.frame, LOCATE_JS(ref, selector, label)).catch(() => {}); return best; }
  throw new Error(ref != null ? `No element [${ref}] — take a new snapshot, the page may have changed.` : selector ? `Nothing matches selector ${selector}` : `No visible element with text "${label}". If it is a field that only appears after clicking something (a search icon, a menu), click that first; otherwise take a snapshot and use a [ref].`);
}
// Clicks inside embedded frames are performed from inside the frame (as a real user gesture),
// because the engine does not route simulated mouse events into isolated frames.
const FRAME_CLICK_JS = (count, right) => `(() => {
  let e = (window.__mnQ ? window.__mnQ('[data-mn-target]') : document.querySelector('[data-mn-target]')); if (!e) return false;
  const b = e.getBoundingClientRect(); const o = { bubbles: true, cancelable: true, view: window, clientX: b.left + b.width / 2, clientY: b.top + b.height / 2, button: ${right ? 2 : 0} };
  for (const t of ['pointerover', 'mouseover', 'pointerdown', 'mousedown']) e.dispatchEvent(new (t.startsWith('pointer') ? PointerEvent : MouseEvent)(t, o));
  if (typeof e.focus === 'function') e.focus();
  for (const t of ['pointerup', 'mouseup']) e.dispatchEvent(new (t.startsWith('pointer') ? PointerEvent : MouseEvent)(t, o));
  ${right ? "e.dispatchEvent(new MouseEvent('contextmenu', o));" : "for (let i = 0; i < " + 1 + "; i++) e.click(); if (" + count + " > 1) e.dispatchEvent(new MouseEvent('dblclick', o));"}
  return true; })()`;
async function mouseClick(wc, p, { button = 'left', count = 1 } = {}) {
  if (p.inFrame && p.frame) { await fjs(p.frame, FRAME_CLICK_JS(count, button === 'right')); return; }
  const x = Math.round(p.x), y = Math.round(p.y);
  wc.sendInputEvent({ type: 'mouseMove', x, y });
  for (let c = 1; c <= count; c++) {
    wc.sendInputEvent({ type: 'mouseDown', x, y, button, clickCount: c });
    wc.sendInputEvent({ type: 'mouseUp', x, y, button, clickCount: c });
  }
}
const KEYMAP = { enter: 'Enter', return: 'Enter', esc: 'Escape', escape: 'Escape', tab: 'Tab', backspace: 'Backspace', delete: 'Delete', space: 'Space',
  up: 'Up', down: 'Down', left: 'Left', right: 'Right', arrowup: 'Up', arrowdown: 'Down', arrowleft: 'Left', arrowright: 'Right',
  home: 'Home', end: 'End', pageup: 'PageUp', pagedown: 'PageDown' };
function pressKey(wc, combo) {
  const parts = String(combo).split('+').map(s => s.trim());
  const keyName = parts.pop();
  const mods = parts.map(m => ({ ctrl: 'control', control: 'control', cmd: 'meta', meta: 'meta', win: 'meta', alt: 'alt', shift: 'shift' }[m.toLowerCase()])).filter(Boolean);
  const keyCode = KEYMAP[keyName.toLowerCase()] || (keyName.length === 1 ? keyName : keyName);
  wc.sendInputEvent({ type: 'keyDown', keyCode, modifiers: mods });
  if (keyCode === 'Enter') wc.sendInputEvent({ type: 'char', keyCode: '\r', modifiers: mods });
  else if (keyName.length === 1 && !mods.some(m => m === 'control' || m === 'meta' || m === 'alt')) wc.sendInputEvent({ type: 'char', keyCode: keyName, modifiers: mods });
  wc.sendInputEvent({ type: 'keyUp', keyCode, modifiers: mods });
}
function checkNavUrl(u) {
  const s = String(u || '').trim();
  if (/^(file|chrome|devtools|view-source):/i.test(s)) throw new Error('For safety, AI agents cannot open local files or internal browser pages.');
  return s;
}

/* ---------------- tools ---------------- */
const TAB = { tab: { type: 'integer', description: 'Tab id from list_tabs. Leave out to use your own tab (the active tab, or a tab of your own if another AI is busy there).' } };
const TOOLS = {
  list_tabs: {
    description: 'List open tabs with their ids, titles and addresses. The active tab is marked.',
    schema: {}, run: async () => text((await shellReq('list')).map(t => { const o = busyOwnerOf(t.id); return { id: t.id, active: t.active, title: t.title, url: displayUrl(t.url), loading: t.loading, ...(o ? { ai_working_here: o.client } : {}) }; }).concat(popupsFn().map(p => ({ id: p.id, title: p.title, url: p.url, loading: p.loading, popup_window: true }))))
  },
  open_tab: {
    description: 'Open a new tab. Accepts a web address (example.com), a search phrase, or a MiniNet Chat address (chirp.mini / talk.mini). Returns the new tab id.',
    schema: { url: { type: 'string' }, background: { type: 'boolean', description: 'Open without switching to it' } }, required: ['url'],
    run: async a => { const t = await shellReq('open', { url: checkNavUrl(a.url), background: !!a.background }); const wc = webContents.fromId(t.wcId); if (wc) await waitLoad(wc); return text({ opened: t.id, title: wc ? wc.getTitle() : '', url: wc ? displayUrl(wc.getURL()) : a.url }); }
  },
  navigate: {
    description: 'Go to an address, search phrase or MiniNet address in a tab (active tab by default), and wait for it to load.',
    schema: { url: { type: 'string' }, ...TAB }, required: ['url'],
    run: async a => {
      const { tab, wc } = await tabWC(a.tab);
      const target = await shellReq('resolve', { url: checkNavUrl(a.url) });
      let lastErr = null;
      for (let attempt = 0; attempt < 2; attempt++) {
        try { await wc.loadURL(target); lastErr = null; break; }
        catch (e) { lastErr = e; if (!/ERR_ABORTED|\(-3\)/.test(String(e.message))) break; await sleep(400); }
      }
      await waitLoad(wc);
      const now = wc.getURL();
      const sameDoc = target.split('#')[0] === now.split('#')[0];
      if (lastErr && !sameDoc) throw new Error('Could not open ' + a.url + ': ' + String(lastErr.message).replace(/^.*?(ERR_[A-Z_]+).*$/s, '$1'));
      return text({ tab: tab.id, title: wc.getTitle(), url: displayUrl(now) });
    }
  },
  go_back: { description: 'Go back in a tab.', schema: { ...TAB }, run: async a => { const { wc } = await tabWC(a.tab); if (wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack(); await waitLoad(wc); return text({ url: displayUrl(wc.getURL()) }); } },
  go_forward: { description: 'Go forward in a tab.', schema: { ...TAB }, run: async a => { const { wc } = await tabWC(a.tab); if (wc.navigationHistory.canGoForward()) wc.navigationHistory.goForward(); await waitLoad(wc); return text({ url: displayUrl(wc.getURL()) }); } },
  reload: { description: 'Reload a tab.', schema: { ...TAB }, run: async a => { const { wc } = await tabWC(a.tab); wc.reload(); await waitLoad(wc); return text('reloaded'); } },
  switch_tab: { description: 'Make a tab the active (visible) tab.', schema: { tab: { type: 'integer' } }, required: ['tab'], run: async a => { await shellReq('activate', { id: +a.tab }); return text('ok'); } },
  close_other_tabs: { description: 'Close every tab except one (the active tab unless you give keep).', schema: { keep: { type: 'integer', description: 'Tab id to keep' } },
    run: async a => { const tabs = await shellReq('list'); const keep = a.keep != null ? +a.keep : (tabs.find(t => t.active) || tabs[0]).id; let n = 0; let spared = 0; for (const t of tabs) if (t.id !== keep) { if (busyOwnerOf(t.id)) { spared++; continue; } await shellReq('close', { id: t.id }); n++; } await shellReq('activate', { id: keep }); return text(`closed ${n} tabs, kept tab ${keep}` + (spared ? ` (left ${spared} tab(s) other AIs are working in)` : '')); } },
  close_tab: { description: 'Close a tab.', schema: { tab: { type: 'integer' } }, required: ['tab'], run: async a => { await shellReq('close', { id: +a.tab }); return text('closed'); } },

  snapshot: {
    description: 'Read the page: title, address, numbered list of interactive elements like [12] button "Buy now", and the visible text — including content inside embedded frames. Use the numbers as ref in click/type. Take a fresh snapshot after the page changes.',
    schema: { ...TAB, max_elements: { type: 'integer', description: 'Default 150' }, max_text: { type: 'integer', description: 'Characters of page text, default 4000' } },
    run: async a => {
      const { tab, wc } = await tabWC(a.tab);
      const maxEl = Math.min(+a.max_elements || 150, 600), maxText = Math.min(+a.max_text || 4000, 60000);
      const map = new Map(); let next = 1; let head = null; const els = []; const texts = [];
      for (const f of framesOf(wc)) {
        if (next - 1 >= maxEl) break;
        let snap; try { snap = await fjs(f, SNAPSHOT_JS(maxEl - (next - 1), maxText, next)); } catch { continue; }
        if (!snap) continue;
        if (!head) head = snap;
        else if (!snap.elements.length && !snap.text.trim()) continue;
        const label = f.parent ? `  (inside embedded frame${/srcdoc|about:/.test(f.url) ? ': page content' : ': ' + f.url.slice(0, 60)})` : '';
        snap.elements.forEach((line, i) => { map.set(next + i, f); els.push(line + (label && i === 0 ? label : '')); });
        next += snap.elements.length;
        texts.push((f.parent ? `\n--- embedded frame ${label.replace(/^\s+\(inside embedded frame:?\s?|\)$/g, '')} ---\n` : '') + snap.text);
      }
      refFrames.set(wc.id, map);
      if (!head) throw new Error('Could not read this page (it may still be loading).');
      return text(`TAB ${tab.id} · ${head.title}\nURL ${displayUrl(head.url)}\nSCROLL y=${head.scroll.y} of ${head.scroll.height} (viewport ${head.scroll.viewport})\n\nELEMENTS (${els.length}):\n${els.join('\n')}\n\nTEXT (${head.textLength} chars on main page):\n${texts.join('\n').slice(0, maxText + 2000)}`);
    }
  },
  read_text: {
    description: 'Get the readable text of the page (including embedded frames) or of one element (CSS selector). Good for long articles.',
    schema: { ...TAB, selector: { type: 'string' }, offset: { type: 'integer' }, length: { type: 'integer', description: 'Default 20000' } },
    run: async a => {
      const { wc } = await tabWC(a.tab);
      let t = null;
      if (a.selector) {
        for (const f of framesOf(wc)) { t = await fjs(f, `(() => { const e = document.querySelector(${JSON.stringify(a.selector)}); return e ? e.innerText : null; })()`).catch(() => null); if (t != null) break; }
        if (t == null) throw new Error('Nothing matches that selector');
      } else {
        const parts = [];
        for (const f of framesOf(wc)) { const x = await fjs(f, 'document.body ? document.body.innerText : ""').catch(() => ''); if (x && x.trim()) parts.push((f.parent ? '\n--- embedded frame ---\n' : '') + x); }
        t = parts.join('\n');
      }
      const off = +a.offset || 0, len = Math.min(+a.length || 20000, 100000);
      return text(t.slice(off, off + len) + (t.length > off + len ? `\n\n[… ${t.length - off - len} more characters, use offset ${off + len}]` : ''));
    }
  },
  click: {
    description: 'Click an element with a real mouse click. Target it by ref from snapshot (best), by its visible text (e.g. text:"Reject all"), by CSS selector, or by x/y viewport coordinates. Waits for any page load it causes and warns if a popup was covering the target.',
    schema: { ref: { type: 'integer' }, text: { type: 'string', description: 'Visible text of the thing to click' }, selector: { type: 'string' }, x: { type: 'number' }, y: { type: 'number' }, double: { type: 'boolean' }, right: { type: 'boolean' }, ...TAB },
    run: async a => {
      const { wc } = await tabWC(a.tab); const p = await pointFor(wc, a);
      const before = wc.getURL();
      await mouseClick(wc, p, { count: a.double ? 2 : 1, button: a.right ? 'right' : 'left' }); await waitLoad(wc, 15000, p.tag === 'a' || /submit|button/i.test(p.tag || '') || p.href ? 1200 : 700);
      const out = { clicked: a.ref ?? a.text ?? a.selector ?? [a.x, a.y], element: p.tag ? `${p.tag} "${p.name || ''}"${p.inFrame ? ' (in embedded frame)' : ''}` : undefined, url: displayUrl(wc.getURL()), title: wc.getTitle(), navigated: wc.getURL() !== before };
      if (p.covered) out.warning = `Something was covering the target, so the click landed on ${p.covered}. Close that popup/banner first (snapshot to find its button), then click again.`;
      return text(out);
    }
  },
  type: {
    description: 'Type text into a field. Target the field by ref, CSS selector, or field (its label/placeholder text); it is cleared first unless append=true. Leave all out to type wherever the cursor is. submit=true presses Enter afterwards. Date/time fields take values like 2026-10-22 or 19:30.',
    schema: { text: { type: 'string' }, ref: { type: 'integer' }, selector: { type: 'string' }, field: { type: 'string', description: 'Label or placeholder of the field' }, append: { type: 'boolean' }, submit: { type: 'boolean' }, ...TAB }, required: ['text'],
    run: async a => {
      const { wc } = await tabWC(a.tab);
      if (a.ref != null || a.selector || a.field) {
        const p = await pointFor(wc, a.field && a.ref == null && !a.selector ? { text: a.field } : a);
        const special = await fjs(p.frame, `(() => { let e = (window.__mnQ ? window.__mnQ('[data-mn-target]') : document.querySelector('[data-mn-target]')); if (e && e.tagName === 'LABEL' && e.control) e = e.control; if (!e || e.tagName !== 'INPUT') return false;
          if (!/^(date|time|datetime-local|month|week|color|range)$/.test(e.type)) return false;
          const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(e, ${JSON.stringify(String(a.text))});
          e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); return e.type + '=' + e.value; })()`).catch(() => false);
        if (special) return text({ set: special, note: special.endsWith('=') ? 'The value was rejected — use the format the field expects, e.g. 19:30 for time or 2026-10-22 for date.' : undefined });
        if (p.inFrame) {
          const ok = await fjs(p.frame, `(() => { let e = (window.__mnQ ? window.__mnQ('[data-mn-target]') : document.querySelector('[data-mn-target]')); if (e && e.tagName === 'LABEL' && e.control) e = e.control; if (!e) return false;
            e.focus(); ${a.append ? '' : "if ('value' in e && typeof e.select === 'function') e.select(); else document.execCommand('selectAll');"}
            if (!document.execCommand('insertText', false, ${JSON.stringify(String(a.text))})) { const proto = e.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype; const d = Object.getOwnPropertyDescriptor(proto, 'value'); if (d) d.set.call(e, ${a.append ? "e.value + " : ""}${JSON.stringify(String(a.text))}); e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); }
            return true; })()`);
          if (!ok) throw new Error('Could not focus that field');
          if (a.submit) { await fjs(p.frame, `(() => { const e = document.activeElement; const o = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }; e.dispatchEvent(new KeyboardEvent('keydown', o)); e.dispatchEvent(new KeyboardEvent('keypress', o)); e.dispatchEvent(new KeyboardEvent('keyup', o)); if (e.form) { if (e.form.requestSubmit) e.form.requestSubmit(); else e.form.submit(); } })()`).catch(() => {}); await waitLoad(wc, 15000, 1200); }
          return text({ typed: a.text.length + ' characters', inEmbeddedFrame: true, submitted: !!a.submit, url: displayUrl(wc.getURL()) });
        }
        await mouseClick(wc, p);
        await sleep(30);
        // make sure the click really put the cursor in that field (hidden/collapsed fields can't take typing)
        const focusOk = await fjs(p.frame, `(() => { let t = (window.__mnQ ? window.__mnQ('[data-mn-target]') : document.querySelector('[data-mn-target]')); if (t && t.tagName === 'LABEL' && t.control) t = t.control; let f = document.activeElement; while (f && f.shadowRoot && f.shadowRoot.activeElement) f = f.shadowRoot.activeElement; if (!t) return 'ok'; if (f && (f === t || t.contains(f) || f.contains(t))) return 'ok';
          const r = t.getBoundingClientRect(), cs = getComputedStyle(t); const hidden = !r.width || !r.height || cs.visibility === 'hidden' || cs.display === 'none' || +cs.opacity === 0;
          if (hidden) { t.focus(); if (document.activeElement === t) return 'focused-hidden'; return 'hidden'; } if (f && (f.isContentEditable || /^(INPUT|TEXTAREA)$/.test(f.tagName) || f.getAttribute('role') === 'textbox')) return 'ok'; return 'covered:' + (f ? f.tagName.toLowerCase() + (f.id ? '#' + f.id : '') : 'nothing'); })()`).catch(() => 'ok');
        if (focusOk === 'hidden') throw new Error('That field exists but is hidden or collapsed, so it cannot be typed into yet. Click the button that opens it first (for example a search icon), then type again.');
        if (focusOk.startsWith('covered:')) throw new Error('The click did not land in that field (focus went to ' + focusOk.slice(8) + '). Something may be covering it — take a snapshot, close any popup, then try again.');
        if (!a.append) await fjs(p.frame, `(() => { const e = document.activeElement; if (!e) return; if ('value' in e && typeof e.select === 'function') { e.select(); } else { document.execCommand('selectAll'); } })()`).catch(() => {});
      }
      wc.insertText(String(a.text));
      if ((a.ref != null || a.selector || a.field) && String(a.text).length) {
        await sleep(40);
        const tail = String(a.text).slice(-12);
        const landed = await js(wc, `(() => { let f = document.activeElement; while (f && f.shadowRoot && f.shadowRoot.activeElement) f = f.shadowRoot.activeElement; if (!f || f === document.body || f === document.documentElement) return 'none'; if (f.tagName === 'IFRAME') return 'frame'; const v = ('value' in f ? f.value : f.innerText) || ''; return v.includes(${JSON.stringify(tail)}) ? 'ok' : 'other:' + f.tagName.toLowerCase(); })()`).catch(() => 'ok');
        if (landed === 'none') throw new Error('Nothing took the typing — that field is probably hidden or collapsed. Click the button that opens it first (for example a search icon), then type again.');
      }
      if (a.submit) { await sleep(80); pressKey(wc, 'Enter'); await waitLoad(wc, 15000, 1200); }
      return text({ typed: a.text.length + ' characters', submitted: !!a.submit, url: displayUrl(wc.getURL()) });
    }
  },
  drag: {
    description: 'Drag with the mouse: press on one thing and move it somewhere else before letting go — for moving clips on a video-editor timeline, trimming by pulling an edge, sliders, reordering lists or drag-and-drop. Start at a ref/text/selector or from_x/from_y; end at to_ref/to_selector, to_x/to_y, or move by dx/dy pixels.',
    schema: { ref: { type: 'integer' }, text: { type: 'string' }, selector: { type: 'string' }, from_x: { type: 'number' }, from_y: { type: 'number' }, to_ref: { type: 'integer' }, to_selector: { type: 'string' }, to_x: { type: 'number' }, to_y: { type: 'number' }, dx: { type: 'number' }, dy: { type: 'number' }, steps: { type: 'integer', description: 'Move steps, default 12' }, ...TAB },
    run: async a => {
      const { wc } = await tabWC(a.tab);
      const p = await pointFor(wc, { ref: a.ref, selector: a.selector, text: a.text, x: a.from_x, y: a.from_y });
      let q;
      if (a.to_ref != null || a.to_selector) q = await pointFor(wc, { ref: a.to_ref, selector: a.to_selector });
      else if (a.to_x != null && a.to_y != null) q = { x: +a.to_x, y: +a.to_y };
      else q = { x: p.x + (+a.dx || 0), y: p.y + (+a.dy || 0) };
      const x0 = Math.round(p.x), y0 = Math.round(p.y), x1 = Math.round(q.x), y1 = Math.round(q.y), n = Math.max(3, Math.min(60, +a.steps || 12));
      wc.sendInputEvent({ type: 'mouseMove', x: x0, y: y0 }); await sleep(40);
      wc.sendInputEvent({ type: 'mouseDown', x: x0, y: y0, button: 'left', clickCount: 1 }); await sleep(80);
      for (let i = 1; i <= n; i++) { wc.sendInputEvent({ type: 'mouseMove', x: Math.round(x0 + (x1 - x0) * i / n), y: Math.round(y0 + (y1 - y0) * i / n), button: 'left', modifiers: ['leftButtonDown'] }); await sleep(25); }
      await sleep(60);
      wc.sendInputEvent({ type: 'mouseUp', x: x1, y: y1, button: 'left', clickCount: 1 });
      await waitLoad(wc, 5000);
      return text({ dragged: { from: [x0, y0], to: [x1, y1] }, url: displayUrl(wc.getURL()) });
    }
  },
  select_option: {
    description: 'Choose an option in a <select> dropdown by its visible text or value.',
    schema: { option: { type: 'string' }, ref: { type: 'integer' }, selector: { type: 'string' }, ...TAB }, required: ['option'],
    run: async a => {
      const { wc } = await tabWC(a.tab);
      const frames = a.ref != null ? [(refFrames.get(wc.id) || new Map()).get(+a.ref) || wc.mainFrame] : framesOf(wc);
      const q = a.ref != null ? `[data-mn-ref="${+a.ref}"]` : a.selector;
      let frame = frames[0];
      for (const f of frames) { if (await fjs(f, `!!(window.__mnQ ? window.__mnQ(${JSON.stringify(q)}) : document.querySelector(${JSON.stringify(q)}))`).catch(() => false)) { frame = f; break; } }
      const r = await fjs(frame, `(() => { const s = window.__mnQ ? window.__mnQ(${JSON.stringify(q)}) : document.querySelector(${JSON.stringify(q)}); if (!s || !s.options) return 'not a select';
        const o = [...s.options].find(o => o.text.trim() === ${JSON.stringify(a.option)} || o.value === ${JSON.stringify(a.option)}) || [...s.options].find(o => o.text.toLowerCase().includes(${JSON.stringify(a.option.toLowerCase())}));
        if (!o) return 'no such option. Options: ' + [...s.options].map(o => o.text.trim()).join(' | ');
        s.value = o.value; s.dispatchEvent(new Event('input', { bubbles: true })); s.dispatchEvent(new Event('change', { bubbles: true })); return 'selected ' + o.text.trim(); })()`);
      return text(r);
    }
  },
  press_key: {
    description: 'Press a key or combo, e.g. "Enter", "Escape", "Tab", "ArrowDown", "ctrl+a", "shift+Tab".',
    schema: { key: { type: 'string' }, ...TAB }, required: ['key'],
    run: async a => { const { wc } = await tabWC(a.tab); pressKey(wc, a.key); await waitLoad(wc, 8000, /enter/i.test(a.key) ? 1200 : 0); return text('pressed ' + a.key); }
  },
  scroll: {
    description: 'Scroll the page. direction up/down (default one screen), or to top/bottom, or bring an element (ref/selector) into view.',
    schema: { direction: { type: 'string', enum: ['up', 'down', 'top', 'bottom'] }, amount: { type: 'number', description: 'Pixels' }, ref: { type: 'integer' }, selector: { type: 'string' }, ...TAB },
    run: async a => {
      const { wc } = await tabWC(a.tab);
      if (a.ref != null || a.selector) { await pointFor(wc, a); return text('scrolled element into view'); }
      const d = a.direction || 'down';
      const y = await js(wc, d === 'top' ? 'scrollTo(0,0),scrollY' : d === 'bottom' ? 'scrollTo(0,document.documentElement.scrollHeight),scrollY'
        : `scrollBy(0, ${(d === 'up' ? -1 : 1)} * ${+a.amount || 'innerHeight*0.85'}), scrollY`);
      await sleep(200); return text({ scrollY: Math.round(y) });
    }
  },
  hover: {
    description: 'Move the mouse over an element (opens hover menus).',
    schema: { ref: { type: 'integer' }, text: { type: 'string' }, selector: { type: 'string' }, x: { type: 'number' }, y: { type: 'number' }, ...TAB },
    run: async a => { const { wc } = await tabWC(a.tab); const p = await pointFor(wc, a); wc.sendInputEvent({ type: 'mouseMove', x: Math.round(p.x), y: Math.round(p.y) }); await sleep(300); return text('hovering'); }
  },
  screenshot: {
    description: 'Take a picture of what the tab shows right now (JPEG).',
    schema: { ...TAB, full_quality: { type: 'boolean' } },
    run: async a => {
      const { wc } = await tabWC(a.tab);
      let img = await wc.capturePage();
      if (img.isEmpty() || !img.getSize().width) { await shellReq('peek', { id: (await tabWC(a.tab)).tab.id }).catch(() => {}); await sleep(600); img = await wc.capturePage(); }
      // resize to the page's own pixel grid so x/y read from the picture work directly with click/hover
      const vw = await js(wc, 'innerWidth').catch(() => 0);
      const cssW = vw ? Math.round(vw * wc.getZoomFactor()) : img.getSize().width;
      const w = Math.min(cssW, 1400);
      if (img.getSize().width !== w) img = img.resize({ width: w });
      const scale = cssW / w;
      return { content: [{ type: 'image', data: img.toJPEG(a.full_quality ? 90 : 70).toString('base64'), mimeType: 'image/jpeg' }, { type: 'text', text: `Screenshot of ${displayUrl(wc.getURL())} (${img.getSize().width}x${img.getSize().height}). ` + (scale === 1 ? 'Pixel positions in this picture can be used directly as click x/y.' : `Multiply picture positions by ${scale.toFixed(2)} to get click x/y.`) }] };
    }
  },
  run_js: {
    description: 'Run JavaScript inside the web page (not the browser itself) and return the result. The code is an expression or an async function body using "return".',
    schema: { code: { type: 'string' }, ...TAB }, required: ['code'],
    run: async a => {
      const { wc } = await tabWC(a.tab);
      const code = /\breturn\b/.test(a.code) ? `(async () => { ${a.code} })()` : a.code;
      let r = await js(wc, code);
      try { r = JSON.stringify(r, null, 2); } catch { r = String(r); }
      return text(r === undefined ? 'undefined' : String(r).slice(0, 50000));
    }
  },
  wait_for: {
    description: 'Wait until some text or a CSS selector appears on the page, or just wait some milliseconds.',
    schema: { text: { type: 'string' }, selector: { type: 'string' }, ms: { type: 'integer' }, timeout: { type: 'integer', description: 'ms, default 10000' }, ...TAB },
    run: async a => {
      const { wc } = await tabWC(a.tab);
      if (!a.text && !a.selector) { await sleep(Math.min(+a.ms || 1000, 60000)); return text('waited'); }
      const end = Date.now() + Math.min(+a.timeout || 10000, 120000);
      while (Date.now() < end) {
        const probe = a.selector ? `!!document.querySelector(${JSON.stringify(a.selector)})` : `!!(document.body && document.body.innerText.includes(${JSON.stringify(a.text)}))`;
        for (const f of framesOf(wc)) { if (await fjs(f, probe).catch(() => false)) return text('found'); }
        await sleep(250);
      }
      throw new Error('Timed out waiting');
    }
  },
  list_downloads: {
    description: 'List the newest files in the user\'s Downloads folder (name, size, date). Only this folder can be used with upload_file.',
    schema: {}, run: async () => {
      const dir = eApp.getPath('downloads');
      const items = fs.readdirSync(dir).map(n => { try { const st = fs.statSync(path.join(dir, n)); return st.isFile() ? { name: n, size_kb: Math.round(st.size / 1024), modified: st.mtime.toISOString() } : null; } catch { return null; } }).filter(Boolean).sort((a, b) => b.modified.localeCompare(a.modified)).slice(0, 40);
      return text(items.length ? items : 'The Downloads folder is empty.');
    }
  },
  upload_file: {
    description: 'Put a file into a file-upload field on the page (for example to upload a video to an editor, a photo to a post, or a CV to a form). The file must be in the user\'s Downloads folder — use download first to fetch it, or list_downloads to see what is there. Target the upload field by CSS selector; leave it out to use the first file field on the page.',
    schema: { file: { type: 'string', description: 'File name in the Downloads folder' }, selector: { type: 'string' }, ...TAB }, required: ['file'],
    run: async a => {
      const { wc } = await tabWC(a.tab);
      const dir = eApp.getPath('downloads');
      const full = path.resolve(dir, String(a.file));
      if (!full.startsWith(path.resolve(dir) + path.sep) || !fs.existsSync(full) || !fs.statSync(full).isFile()) throw new Error('No file called "' + a.file + '" in the Downloads folder. Use list_downloads to see what is there.');
      const sel = a.selector || 'input[type=file]';
      const dbg = wc.debugger; let attached = false;
      try {
        if (!dbg.isAttached()) { dbg.attach('1.3'); attached = true; }
        const r = await dbg.sendCommand('Runtime.evaluate', { expression: `document.querySelector(${JSON.stringify(sel)})` });
        if (!r.result || !r.result.objectId || r.result.subtype === 'null') throw new Error('No file-upload field matches ' + sel + ' on this page (it may be inside an embedded frame, or appear only after clicking an Upload button — click it first, then try again).');
        await dbg.sendCommand('DOM.setFileInputFiles', { files: [full], objectId: r.result.objectId });
        await dbg.sendCommand('Runtime.callFunctionOn', { objectId: r.result.objectId, functionDeclaration: 'function(){ this.dispatchEvent(new Event("input", {bubbles:true})); this.dispatchEvent(new Event("change", {bubbles:true})); }' }).catch(() => {});
      } finally { if (attached) try { dbg.detach(); } catch {} }
      await sleep(500);
      return text({ uploaded: path.basename(full), size_kb: Math.round(fs.statSync(full).size / 1024), into: sel });
    }
  },
  download: {
    description: 'Download a file from a link into the user\'s Downloads folder.',
    schema: { url: { type: 'string' }, ...TAB }, required: ['url'],
    run: async a => { const { wc } = await tabWC(a.tab); wc.downloadURL(checkNavUrl(a.url)); return text('download started — it will appear in the Downloads panel'); }
  },
  speak: {
    description: 'Say something out loud to the user with the computer\'s voice.',
    schema: { text: { type: 'string' } }, required: ['text'],
    run: async a => { await shellReq('speak', { text: String(a.text).slice(0, 2000) }); return text('spoken'); }
  },
  show_message: {
    description: 'Show a short pop-up message to the user in the browser.',
    schema: { text: { type: 'string' } }, required: ['text'],
    run: async a => { await shellReq('toast', { text: String(a.text).slice(0, 300) }); return text('shown'); }
  },

  request_permission: {
    description: 'Ask the browser owner to approve your plan before you start acting. Describe in plain words what you will do (e.g. "Sign up on example.com with your email, accept cookies, and order the blue sneakers in size 43"). Once approved you can carry out the plan without asking again.',
    schema: { plan: { type: 'string' } }, required: ['plan'],
    run: async (a, client) => {
      if (approvals.has(client) || isTrusted(client) || cfg.mode === 'auto' || client === 'Orbit') { setApproved(client, a.plan); return text('Approved — go ahead.'); }
      const r = await waitShort(prompt(client + ':approve', 'approve', { client, plan: String(a.plan).slice(0, 2000) }));
      if (r === WAITING) return text('Still waiting — the owner has not pressed Allow yet in MiniNet Browser. Call request_permission again with the same plan to keep waiting.');
      if (r && r.allow) { setApproved(client, a.plan); if (r.always) trust(client); return text('The owner approved your plan. Go ahead and complete it without asking again.'); }
      return { content: [{ type: 'text', text: 'The owner declined this plan.' + (r && r.reason ? ' They said: ' + r.reason : '') + ' Do not act; ask what they would like instead.' }], isError: true };
    }
  },
  ask_user: {
    description: 'Ask the browser owner a question mid-task and wait for their answer (e.g. which size, which account, whether to pay). Give options for quick buttons.',
    schema: { question: { type: 'string' }, options: { type: 'array', items: { type: 'string' } } }, required: ['question'],
    run: async (a, client) => {
      const r = await waitShort(prompt(client + ':ask:' + a.question, 'ask', { client, question: String(a.question).slice(0, 1000), options: (a.options || []).slice(0, 6).map(String) }));
      if (r === WAITING) return text('The owner has not answered yet. Call ask_user again with the same question to keep waiting.');
      return text(r && r.answer ? 'The owner answered: ' + r.answer : 'The owner did not answer.');
    }
  },

  list_extensions: { description: 'List installed MiniNet Browser extensions.', schema: {}, run: async () => text(ext.list()) },
  get_extension: { description: 'Read an extension\'s manifest and code so you can change it.', schema: { id: { type: 'string' } }, required: ['id'], run: async a => text(ext.get(a.id)) },
  save_extension: {
    description: 'Create or update a browser extension. An extension is content.js (JavaScript run inside matching pages after they load) plus optional content.css. matches are address patterns like "*://*.youtube.com/*", "mini://*" or "<all_urls>". Pass an existing id to update it. Matching open tabs are reloaded so it takes effect.',
    schema: { id: { type: 'string' }, name: { type: 'string' }, description: { type: 'string' }, matches: { type: 'array', items: { type: 'string' } }, js: { type: 'string' }, css: { type: 'string' } },
    required: ['name'],
    run: async a => { const r = ext.save({ ...a, author: a.author || 'AI' }); ext.setEnabled(r.id, true); await shellReq('extensions-changed', { reload: true, matches: r.matches || a.matches || ['<all_urls>'] }); return text({ saved: r.id, ...r, enabled: true }); }
  },
  toggle_extension: { description: 'Turn an extension on or off.', schema: { id: { type: 'string' }, enabled: { type: 'boolean' } }, required: ['id', 'enabled'], run: async a => { ext.setEnabled(a.id, a.enabled); const m = (ext.list().find(x => x.id === a.id) || {}).matches; await shellReq('extensions-changed', { reload: true, matches: m || ['<all_urls>'] }); return text('ok'); } },
  delete_extension: { description: 'Remove an extension.', schema: { id: { type: 'string' } }, required: ['id'], run: async a => { ext.remove(a.id); await shellReq('extensions-changed', {}); return text('deleted'); } }
};

/* ================= Missions: goals, proof-carrying actions and a black-box record =================
   An AI starts a mission with a goal and success criteria. Every action it takes is recorded with
   before/after pages and a screenshot. Success criteria are checked by the browser itself against the
   live page — the AI cannot simply claim it is done. Missions are saved to disk so they can be reviewed. */
let missionsDir = '';
const missions = new Map();          // id -> mission
const activeMission = new Map();     // client -> mission id
const ACTION_TOOLS = new Set(['drag', 'upload_file', 'open_tab', 'navigate', 'go_back', 'go_forward', 'reload', 'click', 'type', 'select_option', 'press_key', 'scroll', 'hover', 'run_js', 'download', 'save_extension', 'toggle_extension', 'delete_extension', 'close_tab', 'close_other_tabs', 'switch_tab']);
const SHOT_TOOLS = new Set(['open_tab', 'navigate', 'go_back', 'go_forward', 'click', 'type', 'select_option', 'press_key']);
function missionInit(userData) {
  missionsDir = path.join(userData, 'missions');
  fs.mkdirSync(missionsDir, { recursive: true });
  for (const f of fs.readdirSync(missionsDir)) {
    if (!f.endsWith('.json')) continue;
    try { const m = JSON.parse(fs.readFileSync(path.join(missionsDir, f), 'utf8')); if (m.status === 'running') m.status = 'interrupted'; missions.set(m.id, m); } catch {}
  }
}
const saveTimers = new Map();
function saveMission(m, now) {
  clearTimeout(saveTimers.get(m.id));
  const w = () => { try { fs.writeFileSync(path.join(missionsDir, m.id + '.json'), JSON.stringify(m, null, 1)); } catch {} };
  if (now) w(); else saveTimers.set(m.id, setTimeout(w, 300));
  notify({ type: 'mission', id: m.id, status: m.status });
}
function redact(name, a) {
  const o = { ...(a || {}) };
  const secret = /pass|pwd|card|cvv|cvc|otp|pin|secret|token|iban|account.?num/i;
  if (name === 'type' && (secret.test(String(o.selector || '')) || secret.test(String(o.field || '')))) o.text = '•••• (hidden)';
  if (name === 'run_js' && o.code) o.code = String(o.code).slice(0, 400);
  return o;
}
async function pageState(tab) {
  try { const { wc, tab: t } = await tabWC(tab); return { tab: t.id, url: displayUrl(wc.getURL()), title: wc.getTitle(), wc }; } catch { return null; }
}
async function missionShot(m, wc, label) {
  try {
    let img = await wc.capturePage(); if (img.getSize().width > 640) img = img.resize({ width: 640 });
    const file = `${m.id}-${String(m.steps.length).padStart(3, '0')}-${label}.jpg`;
    fs.writeFileSync(path.join(missionsDir, file), img.toJPEG(60));
    return file;
  } catch { return null; }
}
function hostOf(u) { try { return new URL(/^[a-z]+:\/\//i.test(u) ? u : 'https://' + u).hostname.replace(/^www\./, ''); } catch { return ''; } }
function checkMissionLimits(m, name, args) {
  const used = m.steps.filter(s => ACTION_TOOLS.has(s.tool)).length;
  if (ACTION_TOOLS.has(name) && used >= m.limits.max_steps) throw new Error(`Mission step budget used up (${m.limits.max_steps} actions). Call mission_finish, or ask_user for more steps.`);
  if ((name === 'navigate' || name === 'open_tab') && m.limits.allowed_sites && m.limits.allowed_sites.length) {
    const u = String(args.url || '');
    const looksLikeSite = /\.[a-z]{2,}([/:?#]|$)/i.test(u) || /^[a-z]+:\/\//i.test(u);
    if (looksLikeSite && !/\.mini\b|^mini:/i.test(u)) {
      const h = hostOf(u);
      if (!m.limits.allowed_sites.some(a => h === a.replace(/^www\./, '') || h.endsWith('.' + a.replace(/^www\./, '')))) throw new Error(`${h} is outside this mission's allowed sites (${m.limits.allowed_sites.join(', ')}).`);
    }
  }
}
async function recordStep(m, name, args, run) {
  const before = await pageState(args && args.tab);
  const step = { n: m.steps.length + 1, t: Date.now(), tool: name, summary: summarize(name, args || {}), args: redact(name, args), before: before && { url: before.url, title: before.title } };
  m.steps.push(step);
  try {
    const r = await run();
    step.ok = !(r && r.isError);
    const txt = (r && r.content || []).filter(c => c.type === 'text').map(c => c.text).join(' ');
    step.result = txt.slice(0, 300);
    if (/"warning":/.test(txt)) step.warning = (txt.match(/"warning": "([^"]+)"/) || [])[1];
    const after = await pageState(args && args.tab);
    if (after) { step.after = { url: after.url, title: after.title }; if (SHOT_TOOLS.has(name)) step.shot = await missionShot(m, after.wc, name); }
    saveMission(m);
    return r;
  } catch (e) {
    step.ok = false; step.error = e.message;
    const after = await pageState(args && args.tab);
    if (after) { step.after = { url: after.url, title: after.title }; step.shot = await missionShot(m, after.wc, 'error'); }
    saveMission(m);
    throw e;
  }
}
const CHECKS = {
  text_on_page: (v) => `(() => { const t = document.body ? document.body.innerText : ''; const i = t.toLowerCase().indexOf(${JSON.stringify(String(v).toLowerCase())}); return i < 0 ? null : t.slice(Math.max(0, i - 80), i + ${String(v).length} + 80).replace(/\\s+/g, ' '); })()`,
  element_exists: (v) => `(() => { const e = document.querySelector(${JSON.stringify(String(v))}); return e ? (e.outerHTML.slice(0, 200)) : null; })()`,
  element_text: (v, sel) => `(() => { const e = document.querySelector(${JSON.stringify(String(sel || ''))}); if (!e) return null; const t = (e.innerText || e.value || '').trim(); return t.toLowerCase().includes(${JSON.stringify(String(v).toLowerCase())}) ? t.slice(0, 200) : null; })()`
};
function missionSummary(m) {
  return { id: m.id, goal: m.goal, status: m.status, client: m.client, started: new Date(m.startedAt).toISOString(), ended: m.endedAt ? new Date(m.endedAt).toISOString() : null,
    actions: m.steps.filter(s => ACTION_TOOLS.has(s.tool)).length, failed_actions: m.steps.filter(s => s.ok === false).length,
    criteria: m.criteria.map(c => ({ n: c.n, text: c.text, status: c.status, evidence: c.evidence && (c.evidence.snippet || c.evidence.reason), checked_on: c.evidence && c.evidence.url })), summary: m.summary || '' };
}
function newId() { return new Date().toISOString().slice(0, 10).replace(/-/g, '') + '-' + crypto.randomBytes(3).toString('hex'); }

Object.assign(TOOLS, {
  mission_start: {
    description: 'Start a mission: a goal with success criteria the browser will verify. Every action you take afterwards is recorded with evidence (pages + screenshots). Set max_steps and allowed_sites to keep the mission bounded. Finish with mission_finish.',
    schema: { goal: { type: 'string' }, success_criteria: { type: 'array', items: { type: 'string' }, description: 'Plain-language outcomes that must be true at the end, e.g. "The order confirmation page shows order number"' }, max_steps: { type: 'integer', description: 'Action budget, default 40' }, allowed_sites: { type: 'array', items: { type: 'string' }, description: 'Optional list of domains this mission may visit, e.g. ["github.com"]. MiniNet .mini sites are always allowed.' } },
    required: ['goal', 'success_criteria'],
    run: async (a, client) => {
      const prev = activeMission.get(client) && missions.get(activeMission.get(client));
      if (prev && prev.status === 'running') { prev.status = 'stopped'; prev.endedAt = Date.now(); prev.summary = 'Replaced by a new mission.'; saveMission(prev, true); }
      const crit = (a.success_criteria || []).map(String).filter(Boolean).slice(0, 20);
      if (!crit.length) throw new Error('Give at least one success criterion.');
      const m = { id: newId(), client, goal: String(a.goal).slice(0, 1000), status: 'running', startedAt: Date.now(),
        limits: { max_steps: Math.min(Math.max(+a.max_steps || 40, 1), 500), allowed_sites: (a.allowed_sites || []).map(String).slice(0, 30) },
        criteria: crit.map((t, i) => ({ n: i + 1, text: t, status: 'pending' })), steps: [], notes: [] };
      missions.set(m.id, m); activeMission.set(client, m.id); saveMission(m, true);
      return text({ mission: m.id, criteria: m.criteria.map(c => `${c.n}. ${c.text}`), limits: m.limits, next: 'Work towards the goal. When a criterion should be true, prove it with mission_verify (the browser checks the live page). Then call mission_finish.' });
    }
  },
  mission_verify: {
    description: 'Prove one success criterion. The browser itself checks the current page: text_on_page (value = text that must appear), element_exists (value = CSS selector), element_text (selector + value), or url_contains (value). The result and evidence are stored in the mission record.',
    schema: { criterion: { type: 'integer', description: 'Criterion number from mission_start' }, check: { type: 'string', enum: ['text_on_page', 'element_exists', 'element_text', 'url_contains'] }, value: { type: 'string' }, selector: { type: 'string' }, ...TAB },
    required: ['criterion', 'check', 'value'],
    run: async (a, client) => {
      const m = missions.get(activeMission.get(client));
      if (!m || m.status !== 'running') throw new Error('No running mission. Call mission_start first.');
      const c = m.criteria.find(x => x.n === +a.criterion); if (!c) throw new Error('No criterion ' + a.criterion);
      const { wc } = await tabWC(a.tab);
      let snippet = null;
      if (a.check === 'url_contains') snippet = wc.getURL().includes(a.value) ? displayUrl(wc.getURL()) : null;
      else {
        if (!CHECKS[a.check]) throw new Error('Unknown check ' + a.check);
        for (const f of framesOf(wc)) { snippet = await fjs(f, CHECKS[a.check](a.value, a.selector)).catch(() => null); if (snippet) break; }
      }
      const shot = await missionShot(m, wc, 'verify-' + c.n);
      c.status = snippet ? 'passed' : 'failed';
      c.evidence = { t: Date.now(), check: a.check, value: a.value, selector: a.selector, url: displayUrl(wc.getURL()), title: wc.getTitle(), snippet: snippet || null, reason: snippet ? null : 'Not found on the page when checked', shot };
      m.steps.push({ n: m.steps.length + 1, t: Date.now(), tool: 'mission_verify', summary: `verify #${c.n}: ${c.status}`, ok: !!snippet, after: { url: c.evidence.url, title: c.evidence.title }, shot });
      saveMission(m);
      return text({ criterion: c.n, status: c.status, evidence: snippet || 'not found', remaining: m.criteria.filter(x => x.status !== 'passed').map(x => x.n) });
    }
  },
  mission_note: {
    description: 'Add an observation or decision to the mission record (e.g. why you chose an option, what you could not verify).',
    schema: { text: { type: 'string' } }, required: ['text'],
    run: async (a, client) => { const m = missions.get(activeMission.get(client)); if (!m) throw new Error('No mission'); m.notes.push({ t: Date.now(), text: String(a.text).slice(0, 2000) }); m.steps.push({ n: m.steps.length + 1, t: Date.now(), tool: 'mission_note', summary: String(a.text).slice(0, 120), ok: true }); saveMission(m); return text('noted'); }
  },
  mission_finish: {
    description: 'End the mission. It is marked VERIFIED only if every success criterion passed a browser check; otherwise UNVERIFIED (or FAILED if you gave up). Returns the evidence report.',
    schema: { summary: { type: 'string' }, gave_up: { type: 'boolean' } }, required: ['summary'],
    run: async (a, client) => {
      const m = missions.get(activeMission.get(client)); if (!m || m.status !== 'running') throw new Error('No running mission.');
      m.summary = String(a.summary).slice(0, 3000); m.endedAt = Date.now();
      const allPassed = m.criteria.every(c => c.status === 'passed');
      m.status = a.gave_up ? 'failed' : allPassed ? 'verified' : 'unverified';
      activeMission.delete(client); saveMission(m, true);
      return text(missionSummary(m));
    }
  },
  mission_report: {
    description: 'Get a mission record (the current or last mission, or one by id) — goal, criteria with evidence, actions and results.',
    schema: { id: { type: 'string' }, include_steps: { type: 'boolean' } },
    run: async (a, client) => {
      const id = a.id || activeMission.get(client) || [...missions.values()].filter(x => x.client === client).sort((x, y) => y.startedAt - x.startedAt).map(x => x.id)[0];
      const m = missions.get(id); if (!m) throw new Error('No mission found');
      const r = missionSummary(m);
      if (a.include_steps) r.steps = m.steps.map(s => ({ n: s.n, tool: s.tool, summary: s.summary, ok: s.ok, error: s.error, warning: s.warning, url: s.after && s.after.url }));
      return text(r);
    }
  }
});
const MISSION_TOOLS = new Set(['mission_start', 'mission_verify', 'mission_note', 'mission_finish', 'mission_report']);
function listMissions() { return [...missions.values()].sort((a, b) => b.startedAt - a.startedAt).map(m => ({ ...missionSummary(m), steps: m.steps.length })); }
function getMission(id) { return missions.get(id) || null; }
function deleteMission(id) {
  const m = missions.get(id); if (!m) return false;
  for (const f of fs.readdirSync(missionsDir)) if (f.startsWith(id)) { try { fs.unlinkSync(path.join(missionsDir, f)); } catch {} }
  missions.delete(id); notify({ type: 'mission', id, status: 'deleted' }); return true;
}

Object.assign(TOOLS, {
  list_accounts: {
    description: 'See which sites the owner is already signed in to in this browser (Google, YouTube, CapCut, GitHub, Instagram, Facebook, TikTok, X, LinkedIn, WhatsApp) and which Google accounts are available. On sites with "Continue with Google", pick one of these Google accounts instead of typing a password.',
    schema: {}, run: async () => { if (!accountsFn) throw new Error('Not available'); const a = await accountsFn(); return text({ signed_in: a.sites.filter(s => s.signedIn).map(s => s.name), not_signed_in: a.sites.filter(s => !s.signedIn).map(s => s.name), google_accounts: a.google.map(g => g.email) }); }
  },
  answer_dialog: {
    description: 'Choose how the NEXT pop-up (alert / confirm "Are you sure?" / prompt asking for text) in a tab is answered. Without this, pop-ups in a tab you are working in are answered OK (prompts get their default text) and the result tells you what was shown.',
    schema: { accept: { type: 'boolean', description: 'true = OK, false = Cancel' }, text: { type: 'string', description: 'Text to enter if it is a prompt' }, ...TAB }, required: ['accept'],
    run: async a => { const { tab } = await tabWC(a.tab); dialogAnswers.set(tab.id, { accept: !!a.accept, text: a.text }); return text(`The next pop-up in tab ${tab.id} will be answered ${a.accept ? 'OK' : 'Cancel'}${a.text != null ? ' with "' + a.text + '"' : ''}.`); }
  }
});

/* ---------------- sign-in codes from Gmail ---------------- */
// Reads the owner's unread Gmail (the Google account signed in to this browser) for a fresh
// verification code sent by the site the AI is signing in to. The owner approves each use,
// and only codes from that same site, from the last 15 minutes, are given out.
const codeTrust = new Set();   // hosts the owner said "always allow" for (this run only)
function siteWord(host) { const parts = host.replace(/^www\./, '').split('.'); return (parts.length > 2 && parts[parts.length - 2].length <= 3 ? parts[parts.length - 3] : parts[parts.length - 2] || parts[0]).toLowerCase(); }
function pickCode(t) {
  const s = String(t || '');
  const near = s.match(/(?:code|otp|pin|verif\w*|one[- ]time|passcode|kode|código)[^0-9A-Z]{0,40}([A-Z0-9]{0,3}-?\d{4,8}|\d{3}[ -]\d{3})/i);
  if (near) return near[1].replace(/[ ]/g, '');
  const g = s.match(/\bG-\d{6}\b/); if (g) return g[0];
  const sp = s.match(/\b(\d{3})[ -](\d{3})\b/); if (sp) return sp[1] + sp[2];
  const d = s.match(/(?<![\d$£€₦.,:])\b\d{4,8}\b(?![.,:]\d)/); return d ? d[0] : null;
}
async function gmailFeed() {
  const ses = eSession.fromPartition('persist:main');
  const all = [];
  for (let u = 0; u < 4; u++) {
    let xml = '';
    try { const r = await ses.fetch(`https://mail.google.com/mail/u/${u}/feed/atom`, { redirect: 'follow' }); if (!r.ok) break; xml = await r.text(); } catch { break; }
    if (!/<feed/.test(xml)) break;
    const acct = (xml.match(/<title>Gmail - Inbox for ([^<]+)<\/title>/) || [])[1] || `account ${u}`;
    if (all.some(e => e.account === acct)) break;   // Gmail falls back to account 0 when u is too high
    const dec = x => String(x || '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
    for (const m of xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)) {
      const e = m[1], g = k => dec((e.match(new RegExp(`<${k}>([\\s\\S]*?)</${k}>`)) || [])[1]);
      all.push({ account: acct, title: g('title'), summary: g('summary'), from: g('name') + ' <' + g('email') + '>', time: Date.parse(g('issued') || g('modified')) || 0 });
    }
  }
  return all;
}
Object.assign(TOOLS, {
  get_email_code: {
    description: 'Get a sign-in / verification code that a site just emailed to the owner\'s Gmail, so you can type it into that site. Pass the tab where the code is asked for: only a fresh (last 15 min) email from that same site is used, and the owner approves sharing it. Ask the site to send the code to email first, then call this (it waits up to 60 s for the email to arrive). Type the code into the site and never repeat it anywhere else.',
    schema: { from: { type: 'string', description: 'Optional: the sender name if it differs from the site (e.g. "TikTok" for a ByteDance site)' }, ...TAB },
    run: async (a, client) => {
      const { tab, wc } = await tabWC(a.tab);
      let host = ''; try { host = new URL(wc.getURL()).hostname; } catch {}
      if (!host || /(^|\.)(google\.com|gmail\.com)$/.test(host) && !a.from) throw new Error('Call this with the tab of the site that is asking for the code (not Gmail).');
      const words = [siteWord(host), ...(a.from ? [String(a.from).toLowerCase()] : [])].filter(w => w && w.length > 1);
      if (!codeTrust.has(host)) {
        const r = await waitShort(prompt(client + ':code:' + host, 'ask', { client, question: `${client} is signing in to ${host} and wants the code that ${words.map(w => w[0].toUpperCase() + w.slice(1)).join(' / ')} emailed to your Gmail. Let it read that one code and type it in?`, options: ['Allow', `Always allow for ${host}`, 'No'] }));
        if (r === WAITING) return text('Waiting for the owner to allow reading the code — call get_email_code again to keep waiting.');
        const ans = String(r && r.answer || '');
        if (!/^(allow|always)/i.test(ans)) return { content: [{ type: 'text', text: 'The owner did not allow reading the email code. Use ask_user so they can type it themselves.' }], isError: true };
        if (/^always/i.test(ans)) codeTrust.add(host);
      }
      const until = Date.now() + 60000;
      let seen = 0;
      while (true) {
        const feed = await gmailFeed();
        if (!feed.length && !seen) { /* maybe signed out or empty */ }
        seen = feed.length;
        const fresh = feed.filter(e => Date.now() - e.time < 15 * 60000 && words.some(w => (e.from + ' ' + e.title).toLowerCase().includes(w))).sort((x, y) => y.time - x.time);
        for (const e of fresh) {
          const code = pickCode(e.title + ' ' + e.summary);
          if (code) { notify({ type: 'log', text: `${client} read a sign-in code from ${e.from.replace(/<.*>/, '').trim()} (Gmail ${e.account})` }); return text({ code, from: e.from.replace(/<.*>/, '').trim(), subject: e.title, gmail: e.account, received_minutes_ago: Math.round((Date.now() - e.time) / 60000) }); }
        }
        if (fresh.length && Date.now() > until - 45000) return text({ code: null, note: `Found the email "${fresh[0].title}" from ${fresh[0].from} but the code is not in its preview. Open Gmail (https://mail.google.com) in a new tab, open that email, read_text to find the code, then type it back in tab ${tab.id}.` });
        if (Date.now() > until) return text({ code: null, note: feed.length || seen ? `No unread email from ${words.join('/')} in the last 15 minutes yet. Make sure the site sent the code to email (press "Resend" if needed), then call again.` : 'Could not read Gmail — the owner may not be signed in to Gmail in this browser. Use ask_user.' });
        await sleep(5000);
      }
    }
  }
});

/* ---------------- helper agents: an AI can start more AIs, each in its own tab ---------------- */
Object.assign(TOOLS, {
  start_helper: {
    description: 'Start a helper AI agent that works on its own task in its own tab, at the same time as you (uses the AI model chosen in Orbit settings — can be a free local Ollama model). Use it to split a big job into parallel parts, e.g. one helper checks Instagram messages while another researches prices. Returns at once; use check_helpers to follow progress and read each helper\'s final report.',
    schema: { task: { type: 'string', description: 'Clear, self-contained instructions for the helper, including what to report back' }, url: { type: 'string', description: 'Optional address to start at' } },
    required: ['task'],
    run: async (a, client) => text(await shellReq('helper', { op: 'start', task: String(a.task), url: a.url || '', by: client }))
  },
  check_helpers: {
    description: 'See every helper agent: its task, status (running/done/failed/stopped), its tab, how many steps it took and its final report. Set wait_seconds to wait until all running helpers finish (max 300).',
    schema: { wait_seconds: { type: 'integer' } },
    run: async a => {
      const until = Date.now() + Math.min(300, Math.max(0, +a.wait_seconds || 0)) * 1000;
      let list = await shellReq('helper', { op: 'list' });
      while (Date.now() < until && list.some(h => h.status === 'running')) { await sleep(2000); list = await shellReq('helper', { op: 'list' }); }
      return text(list.length ? list : 'No helpers yet. Start one with start_helper.');
    }
  },
  stop_helper: {
    description: 'Stop a helper agent by name (e.g. "Orbit · Helper 2"), or all helpers with name "all".',
    schema: { name: { type: 'string' } }, required: ['name'],
    run: async a => text(await shellReq('helper', { op: 'stop', name: String(a.name) }))
  }
});

function toolList() {
  return Object.entries(TOOLS).map(([name, t]) => ({
    name, description: t.description,
    inputSchema: { type: 'object', properties: t.schema, ...(t.required ? { required: t.required } : {}) }
  }));
}

function summarize(name, a) {
  if (name === 'click') return a.ref != null ? `click [${a.ref}]` : a.text ? `click “${String(a.text).slice(0, 30)}”` : 'click';
  if (name === 'type') return `type “${String(a.text || '').slice(0, 30)}”`;
  if (name === 'navigate' || name === 'open_tab') return `${name === 'navigate' ? 'go to' : 'open'} ${String(a.url || '').slice(0, 50)}`;
  if (name === 'save_extension') return `build extension “${a.name}”`;
  return name.replace(/_/g, ' ');
}

const APPROVAL_WAIT = 10 * 60 * 1000;   // how long a card stays open
const TOOL_WAIT = 80 * 1000;            // how long one tool call waits (tunnels cut requests at ~100s)
const WAITING = Symbol('waiting');
const prompts = new Map();              // key -> promise of the user's answer (card stays open across calls)
function prompt(key, op, args) {
  if (!prompts.has(key)) {
    const p = shellReq(op, args, APPROVAL_WAIT).catch(() => null).finally(() => { if (prompts.get(key) === p) prompts.delete(key); });
    prompts.set(key, p);
  }
  return prompts.get(key);
}
function waitShort(p) { return Promise.race([p, new Promise(r => setTimeout(() => r(WAITING), TOOL_WAIT))]); }
const approvals = new Map();   // client -> { plan, t }
const NO_APPROVAL_NEEDED = new Set(['list_accounts', 'list_downloads', 'answer_dialog', 'check_helpers', 'mission_report', 'list_tabs', 'snapshot', 'read_text', 'screenshot', 'wait_for', 'list_extensions', 'get_extension', 'request_permission', 'ask_user', 'show_message']);
function setApproved(client, plan) { approvals.set(client, { plan: plan || '', t: Date.now() }); notify({ type: 'approvals' }); }
async function ensureApproved(client, name, args) {
  if (cfg.mode === 'auto' || client === 'Orbit' || /^Orbit · Helper \d+$/.test(client) || approvals.has(client) || isTrusted(client) || NO_APPROVAL_NEEDED.has(name)) return;
  const r = await waitShort(prompt(client + ':approve', 'approve', { client, plan: '', action: summarize(name, args || {}) }));
  if (r === WAITING) throw new Error('Waiting for the owner to press Allow in MiniNet Browser. Try this action again in a moment (the request is still showing).');
  if (r && r.allow) { if (!approvals.has(client)) setApproved(client, '(approved from first action: ' + summarize(name, args || {}) + ')'); if (r.always) trust(client); return; }
  throw new Error('The browser owner did not allow ' + client + ' to control the browser.' + (r && r.reason ? ' They said: ' + r.reason : '') + ' Use request_permission to explain your plan, then wait for approval.');
}

/* ---------------- many AIs at once: each AI (and each helper agent) works in its own tab ---------------- */
const owners = new Map();            // owner key -> { tab (current), tabs: Map(tabId -> last use), client, at, color }
const IDLE_MS = 3 * 60 * 1000;       // an AI that has been quiet this long gives its tabs back
const AGENT_COLORS = ['#2dd4bf', '#f59e0b', '#a78bfa', '#f472b6', '#60a5fa', '#34d399', '#fb7185', '#facc15'];
let colorSeq = 0;
function busyOwnerOf(tabId, exceptKey) { for (const [k, o] of owners) { const t = o.tabs.get(tabId); if (k !== exceptKey && t && Date.now() - t < IDLE_MS) return { key: k, ...o }; } return null; }
function anotherBusy(key) { for (const [k, o] of owners) if (k !== key && Date.now() - o.at < 60000) return true; return false; }
function badge(tabId) { // show the most recent AI working in a tab (or none)
  let best = null; for (const o of owners.values()) { const t = o.tabs.get(tabId); if (t && Date.now() - t < IDLE_MS && (!best || t > best.t)) best = { t, o }; }
  shellReq('owner', { id: tabId, name: best ? best.o.client : null, color: best ? best.o.color : null }).catch(() => {});
}
function claim(key, client, tabId) {
  let o = owners.get(key);
  if (!o) { o = { color: AGENT_COLORS[colorSeq++ % AGENT_COLORS.length], tabs: new Map() }; owners.set(key, o); }
  const fresh = !o.tabs.has(tabId) || Date.now() - o.tabs.get(tabId) > 20000;
  Object.assign(o, { tab: tabId, client, at: Date.now() }); o.tabs.set(tabId, Date.now());
  if (fresh) badge(tabId);
  return o;
}
function release(key) {
  const o = owners.get(key); if (!o) return;
  owners.delete(key);
  for (const id of o.tabs.keys()) badge(id);
}
setInterval(() => {
  for (const [k, o] of owners) {
    for (const [id, t] of o.tabs) if (Date.now() - t > IDLE_MS) { o.tabs.delete(id); badge(id); }
    if (!o.tabs.size) owners.delete(k);
  }
}, 20000).unref?.();

/* page pop-ups: an AI working in a tab answers them (OK by default, or as set with answer_dialog); otherwise the owner does */
const dialogAnswers = new Map(), dialogLog = new Map();
async function pageDialog(wcId, d) {
  const t = (await shellReq('list')).find(x => x.wcId === wcId); if (!t) return undefined;
  const pre = dialogAnswers.get(t.id), busy = busyOwnerOf(t.id);
  if (!pre && !busy) return undefined;
  if (pre) dialogAnswers.delete(t.id);
  const accept = pre ? pre.accept : true;
  const value = d.type === 'alert' ? undefined : d.type === 'confirm' ? accept : (accept ? (pre && pre.text != null ? String(pre.text) : d.def) : null);
  const said = d.type === 'alert' ? 'OK' : !accept ? 'Cancel' : d.type === 'prompt' ? `OK with "${value}"` : 'OK';
  const entry = `${d.type} pop-up "${String(d.message).slice(0, 200)}" was answered ${said}`;
  if (!dialogLog.has(t.id)) dialogLog.set(t.id, []); dialogLog.get(t.id).push(entry);
  shellReq('toast', { text: (busy ? busy.client : 'AI') + ': ' + entry.slice(0, 120) }).catch(() => {});
  return { value };
}
async function ownTab(key, client) {
  const tabs = await shellReq('list');
  const mine = owners.get(key);
  if (mine && Date.now() - mine.at < IDLE_MS && tabs.some(t => t.id === mine.tab)) { claim(key, client, mine.tab); return { id: mine.tab }; }
  const act = tabs.find(t => t.active);
  const other = act && busyOwnerOf(act.id, key);
  if (act && !other) { claim(key, client, act.id); return { id: act.id }; }
  const t = await shellReq('open', { url: '', background: true });
  claim(key, client, t.id);
  return { id: t.id, note: `${other ? other.client + ' is working in tab ' + other.tab : 'Another AI is busy'}, so you were given your own tab ${t.id} (in the background). Keep using it — pass tab ids to work in several tabs at once.` };
}
const TAB_TOOLS = new Set(Object.entries(TOOLS).filter(([n, t]) => t.schema && t.schema.tab && !['switch_tab', 'close_tab'].includes(n)).map(([n]) => n));
function agentsSummary() { return [...owners.entries()].filter(([, o]) => Date.now() - o.at < IDLE_MS).map(([k, o]) => ({ agent: o.client, tab: o.tab, last_action_seconds_ago: Math.round((Date.now() - o.at) / 1000) })); }

async function call(name, args = {}, client = 'AI agent', ownerKey) {
  if (paused) throw new Error('The user has paused AI control of MiniNet Browser. Ask them to press Resume.');
  const t = TOOLS[name];
  if (!t) throw new Error(`Unknown tool ${name}`);
  await ensureApproved(client, name, args);
  const key = ownerKey || client;
  args = Object.assign({}, args);
  let note = '';
  if (TAB_TOOLS.has(name)) {
    if (args.tab == null) { const r = await ownTab(key, client); args.tab = r.id; note = r.note || ''; }
    else claim(key, client, +args.tab);
  }
  if (name === 'open_tab' && args.background == null && anotherBusy(key)) args.background = true;
  if (args.tab != null && +args.tab < 1000) shellReq('follow', { id: +args.tab }).catch(() => {});
  const popsBefore = new Set(popupsFn().map(p => p.id));
  const entry = { t: Date.now(), client, tool: name, summary: summarize(name, args || {}), ok: null };
  log.unshift(entry); if (log.length > 200) log.pop();
  notify({ type: 'activity', ...entry, status: 'start' });
  try {
    const mid = activeMission.get(client), m = mid && missions.get(mid);
    let r;
    if (m && m.status === 'running' && !MISSION_TOOLS.has(name)) { checkMissionLimits(m, name, args || {}); r = await recordStep(m, name, args || {}, () => t.run(args || {}, client)); }
    else r = await t.run(args || {}, client);
    if (name === 'open_tab') { try { const id = JSON.parse(r.content[0].text).opened; if (id) { claim(key, client, id); shellReq('follow', { id }).catch(() => {}); } } catch {} }
    if (name === 'switch_tab') claim(key, client, +args.tab);
    if (args.tab != null && dialogLog.has(+args.tab)) { note = (note ? note + ' ' : '') + dialogLog.get(+args.tab).join('; ') + '. (Use answer_dialog first to choose Cancel or a different answer.)'; dialogLog.delete(+args.tab); }
    const newPops = popupsFn().filter(p => !popsBefore.has(p.id));
    if (newPops.length) note = (note ? note + ' ' : '') + newPops.map(p => `A pop-up window opened (tab ${p.id}: ${p.title || p.url}) — usually a sign-in window. Work in it by passing tab ${p.id}; it closes itself when the sign-in is done.`).join(' ');
    if (note && r && r.content) r = { ...r, content: [...r.content, { type: 'text', text: 'Note: ' + note }] };
    entry.ok = true; notify({ type: 'activity', ...entry, status: 'done' });
    return r;
  } catch (e) {
    if (args && +args.tab > 1000 && /destroyed/i.test(e.message)) {   // the sign-in pop-up closed itself after the click
      entry.ok = true; notify({ type: 'activity', ...entry, status: 'done' });
      return text('Done — the pop-up window closed itself, which usually means the sign-in finished. Continue in the original tab (snapshot it to check).');
    }
    entry.ok = false; entry.error = e.message; notify({ type: 'activity', ...entry, status: 'error' });
    throw e;
  }
}

/* ---------------- HTTP + MCP server ---------------- */
const INSTRUCTIONS = `You are controlling MiniNet Browser, the user's own web browser, on their behalf.
Before acting, call request_permission with a short plain-language plan. Once the owner approves, carry the plan out fully by yourself — sign up, log in, accept or reject cookies, press Continue, fill forms — without asking again. If something comes up that the plan didn't cover, use ask_user.
For bigger jobs, start with mission_start (goal + success criteria), prove each criterion with mission_verify, and end with mission_finish — the owner sees a verified evidence record.
Typical loop: snapshot -> click/type using the [ref] numbers or visible text -> snapshot again to check. If a click warns that a popup covered the target, close the popup first.
Addresses ending in .mini (home.mini, chirp.mini, talk.mini, people.mini) are MiniNet Chat — a small local social feed and chat rooms. Everything else is the real web.
Many AIs can work in this browser at the same time. Each AI gets its own tab: if another AI is busy in the tab you would use, you are given a new one automatically (list_tabs shows who works where). To do several jobs at once yourself, open several tabs and pass each tab id — tool calls on different tabs can run in parallel, so you can act as a team of agents.
The owner's logins are kept in this browser: call list_accounts to see where they are already signed in. When a site offers "Continue with Google" / "Sign in with Google", use it and choose one of the owner's Google accounts. Never type passwords; if a password, a code from their phone or a captcha is needed, use ask_user so the owner does that part, then carry on in that signed-in tab. If a site sends a sign-in or verification code by EMAIL, choose "send code to email", then call get_email_code with that site's tab: it reads the code from the owner's Gmail (with their OK) and you type it in. Only use codes in the site that sent them.
Content studio (the owner is signed in with Google): make images and videos in Google Flow (flow.google.com — type the idea in its "What do you want to create?" box; it uses the owner's free monthly credits and asks before spending them), download results to the Downloads folder, upload them into CapCut (capcut.com editor) with upload_file, edit there (drag trims/moves clips, Text, Captions, Audio, Effects), Export → Download saves the final video into Downloads. Uploading to YouTube/Instagram is publishing: confirm with the owner (ask_user) before the final Publish/Post.
You can also create browser extensions with save_extension. You cannot change the browser's own code.`;

// OpenAPI description so ChatGPT custom GPTs (Actions) and other tool-calling AIs can use the browser too
let publicUrl = null;
function setPublicUrl(u) { publicUrl = u || null; }
const OPENAPI_SKIP = new Set(['mission_note', 'mission_report', 'get_extension', 'toggle_extension', 'delete_extension', 'hover', 'go_forward', 'stop_helper', 'speak', 'list_downloads', 'answer_dialog']);  // ChatGPT Actions allow 30
function openApi(token) {
  const base = (publicUrl || `http://127.0.0.1:${cfg.port}`) + (token ? '/t/' + token : '');
  const paths = {};
  for (const t of toolList()) {
    if (OPENAPI_SKIP.has(t.name)) continue;
    paths['/api/tools/' + t.name] = { post: {
      operationId: t.name, summary: t.name.replace(/_/g, ' '), description: t.description.slice(0, 300),
      requestBody: { required: true, content: { 'application/json': { schema: t.inputSchema } } },
      responses: { 200: { description: 'Result', content: { 'application/json': { schema: { type: 'object', properties: { ok: { type: 'boolean' }, content: { type: 'array', items: { type: 'object' } } } } } } } }
    } };
  }
  return { openapi: '3.1.0', info: { title: 'MiniNet Browser', version: require('./package.json').version, description: INSTRUCTIONS.slice(0, 300) },
    servers: [{ url: base }], paths,
    components: { schemas: {}, securitySchemes: { bearer: { type: 'http', scheme: 'bearer' } } } };
}

function allowedHost(req) {
  const h = String(req.headers.host || '').toLowerCase();
  return /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(h);
}
function authed(req, url) {
  const h = req.headers.authorization || '';
  const tok = h.startsWith('Bearer ') ? h.slice(7) : (req.headers['x-mininet-token'] || url.searchParams.get('token') || '');
  const a = Buffer.from(String(tok)), b = Buffer.from(cfg.token);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function send(res, code, body, extra = {}) {
  const s = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(code, { 'Content-Type': typeof body === 'string' ? 'text/plain' : 'application/json', ...extra });
  res.end(s);
}
function readBody(req) {
  return new Promise((ok, bad) => { let d = ''; req.on('data', c => { d += c; if (d.length > 20e6) req.destroy(); }); req.on('end', () => ok(d)); req.on('error', bad); });
}

let clientNames = new Map();
// remember which app each MCP session belongs to, so names survive a browser restart
function namesFile() { return cfgPath ? path.join(path.dirname(cfgPath), 'clients.json') : null; }
function loadNames() { try { clientNames = new Map(JSON.parse(fs.readFileSync(namesFile(), 'utf8'))); } catch {} }
function saveNames() { try { fs.writeFileSync(namesFile(), JSON.stringify([...clientNames].slice(-200))); } catch {} }
async function handleRpc(msg, sessionKey) {
  const { id, method, params = {} } = msg;
  const ok = result => ({ jsonrpc: '2.0', id, result });
  const err = (code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });
  if (method === 'initialize') {
    const name = (params.clientInfo && params.clientInfo.name) || 'MCP client';
    clientNames.set(sessionKey, outsideName(prettyClient(name))); clientNames.set('default', outsideName(prettyClient(name))); saveNames();
    return ok({ protocolVersion: params.protocolVersion || '2025-06-18', capabilities: { tools: { listChanged: false } },
      serverInfo: { name: 'mininet-browser', title: 'MiniNet Browser', version: require('./package.json').version }, instructions: INSTRUCTIONS });
  }
  if (method && method.startsWith('notifications/')) return null;
  if (method === 'ping') return ok({});
  if (method === 'tools/list') return ok({ tools: toolList() });
  if (method === 'tools/call') {
    try { return ok(await call(params.name, params.arguments || {}, clientNames.get(sessionKey) || clientNames.get('default') || 'AI agent', 'mcp:' + sessionKey)); }
    catch (e) { return ok({ content: [{ type: 'text', text: 'Error: ' + e.message }], isError: true }); }
  }
  if (method === 'resources/list') return ok({ resources: [] });
  if (method === 'prompts/list') return ok({ prompts: [] });
  return id === undefined ? null : err(-32601, 'Method not found: ' + method);
}
// Outside programs can never pass themselves off as the built-in Orbit assistant
function outsideName(n) { const t = String(n || 'AI agent').slice(0, 60).trim() || 'AI agent'; return /^\s*orbit\b/i.test(t) ? t + ' (outside app)' : t; }
function prettyClient(n) {
  const s = String(n).toLowerCase();
  if (s.includes('mininet-bridge') && s.includes('claude')) return 'Claude Desktop';
  if (s.includes('claude-code') || s.includes('claude code')) return 'Claude Code';
  if (s.includes('claude')) return 'Claude';
  if (s.includes('cursor')) return 'Cursor';
  if (s.includes('chatgpt') || s.includes('openai')) return 'ChatGPT';
  if (s.includes('mininet-bridge')) return String(n).replace(/\s*\(mininet-bridge\)/, '');
  return n;
}

async function onRequest(req, res) {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (!allowedHost(req)) return send(res, 403, { error: 'Only local connections are allowed' });
  // Connector links carry the key in the path: /t/<key>/mcp
  const tm = url.pathname.match(/^\/t\/([A-Za-z0-9]+)(\/.*)?$/);
  if (tm) { url.searchParams.set('token', tm[1]); url.pathname = tm[2] || '/mcp'; }
  // This server uses a secret key, not OAuth — tell clients there is nothing to discover
  if (url.pathname.startsWith('/.well-known/')) return send(res, 404, { error: 'Not found' });
  // Web pages inside a browser may not drive it unless they hold the secret key
  if (req.headers.origin && !/^null$|^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(req.headers.origin) && !authed(req, url)) return send(res, 403, { error: 'Requests from web pages are not allowed' });
  if (url.pathname === '/' && req.method === 'GET') return send(res, 200, { name: 'MiniNet Browser agent API', mcp: '/mcp', tools: '/api/tools', auth: 'Authorization: Bearer <token from Settings → AI control>' });
  if (!cfg.enabled) return send(res, 503, { error: 'AI control is switched off in MiniNet Browser settings' });
  if (!authed(req, url)) return send(res, 401, { error: 'Missing or wrong token. Find it in MiniNet Browser → AI control.' });

  if (url.pathname === '/mcp' || url.pathname === '/mcp/') {
    if (req.method === 'GET') return send(res, 405, { error: 'Use POST' }, { Allow: 'POST' });
    if (req.method === 'DELETE') return send(res, 200, {});
    let body; try { body = JSON.parse(await readBody(req)); } catch { return send(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); }
    const sid = req.headers['mcp-session-id'] || (Array.isArray(body) ? null : body.method === 'initialize' ? crypto.randomUUID() : null) || 'default';
    const msgs = Array.isArray(body) ? body : [body];
    const out = [];
    for (const m of msgs) { const r = await handleRpc(m, sid); if (r) out.push(r); }
    const hdr = { 'Mcp-Session-Id': sid };
    if (!out.length) return send(res, 202, '', hdr);
    return send(res, 200, Array.isArray(body) ? out : out[0], hdr);
  }
  if (url.pathname === '/api/tools' && req.method === 'GET') return send(res, 200, toolList());
  if ((url.pathname === '/openapi.json' || url.pathname === '/openapi') && req.method === 'GET') return send(res, 200, openApi(url.searchParams.get('token')));
  const m = url.pathname.match(/^\/api\/tools\/([a-z_]+)$/);
  if (m && req.method === 'POST') {
    let args = {}; try { const b = await readBody(req); args = b ? JSON.parse(b) : {}; } catch { return send(res, 400, { error: 'Body must be JSON' }); }
    try { return send(res, 200, { ok: true, ...(await call(m[1], args, outsideName(req.headers['x-agent-name'] || 'API client'), req.headers['x-agent-id'] ? 'api:' + String(req.headers['x-agent-id']).slice(0, 80) : undefined)) }); }
    catch (e) { return send(res, 400, { ok: false, error: e.message }); }
  }
  if (url.pathname === '/api/log') return send(res, 200, log.slice(0, 50));
  send(res, 404, { error: 'Not found' });
}

function start() {
  if (server || !cfg.enabled) return;
  server = http.createServer((req, res) => onRequest(req, res).catch(e => send(res, 500, { error: e.message })));
  server.on('error', e => { notify({ type: 'server', error: e.code === 'EADDRINUSE' ? `Port ${cfg.port} is busy — choose another in AI control settings` : e.message }); server = null; });
  server.listen(cfg.port, '127.0.0.1', () => notify({ type: 'server', running: true }));
}
function stop() { if (server) { server.close(); server = null; } }
function restart() { stop(); start(); }

let accountsFn = null, popupsFn = () => [];
function init({ userData, shell, onEvent, accounts, popups }) {
  shellReq = shell; notify = onEvent || notify; accountsFn = accounts || null; if (popups) popupsFn = popups;
  loadConfig(userData);
  missionInit(userData);
  start();
}

module.exports = { init, listMissions, getMission, deleteMission, missionsDir: () => missionsDir, call, toolList, getConfig, setConfig, setPaused, getLog: () => log.slice(0, 100), INSTRUCTIONS, displayUrl, setPublicUrl, release, agentsSummary, pageDialog };
