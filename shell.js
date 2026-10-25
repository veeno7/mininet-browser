/* MiniNet Browser — browser UI */
const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const MININET = new URL('mininet/MiniNet.html', location.href).href;
const START = new URL('start.html', location.href).href;
const PARTITION = 'persist:main';

/* ---------------- stored data ---------------- */
function load(k, d) { try { const v = JSON.parse(localStorage.getItem('mb.' + k)); return v ?? d; } catch { return d; } }
function store(k, v) { try { localStorage.setItem('mb.' + k, JSON.stringify(v)); } catch {} }
const settings = Object.assign({
  theme: 'sunset', engine: 'google', home: 'start', homeUrl: '', startup: 'restore',
  adblock: true, datasaver: false, bookbar: true, sidebar: true
}, load('settings', {}));
let bookmarks = load('bookmarks', [
  { url: 'mini://home.mini', title: 'MiniNet Chat' },
  { url: 'https://www.google.com/', title: 'Google' },
  { url: 'https://www.youtube.com/', title: 'YouTube' },
  { url: 'https://web.whatsapp.com/', title: 'WhatsApp' },
  { url: 'https://en.wikipedia.org/', title: 'Wikipedia' },
  { url: 'https://github.com/', title: 'GitHub' }
]);
let sideSites = load('sideSites', [
  { url: 'https://web.whatsapp.com/', title: 'WhatsApp' },
  { url: 'https://www.youtube.com/', title: 'YouTube' },
  { url: 'https://mail.google.com/', title: 'Gmail' },
  { url: 'https://x.com/', title: 'X' }
]);
let history = load('history', []);
let downloads = load('downloads', []);
const blocked = { ad: 0, data: 0 };
function saveSettings() { store('settings', settings); window.app.settings({ adblock: settings.adblock, datasaver: settings.datasaver }); applySettings(); }

const ENGINES = {
  google: { name: 'Google', q: 'https://www.google.com/search?q=' },
  bing: { name: 'Bing', q: 'https://www.bing.com/search?q=' },
  duck: { name: 'DuckDuckGo', q: 'https://duckduckgo.com/?q=' },
  brave: { name: 'Brave Search', q: 'https://search.brave.com/search?q=' }
};

/* ---------------- address helpers ---------------- */
function startUrl() { return START + '?engine=' + settings.engine; }
function homeUrl() {
  if (settings.home === 'mininet') return resolve('mini://home.mini');
  if (settings.home === 'custom' && settings.homeUrl) return resolve(settings.homeUrl);
  return startUrl();
}
function resolve(input) {
  let s = String(input || '').trim();
  if (!s) return startUrl();
  if (/^mini:\/\//i.test(s) || /^[a-z0-9-]+\.mini([/?#].*)?$/i.test(s)) {
    s = s.replace(/^mini:\/\//i, '');
    return MININET + '?embedded=1#' + encodeURIComponent(s);
  }
  if (/^(https?|file|data):/i.test(s)) return s;
  if (/^(localhost|127\.0\.0\.1)(:\d+)?(\/.*)?$/i.test(s)) return 'http://' + s;
  if (!/\s/.test(s) && /^[^/]+\.[a-z]{2,}(:\d+)?(\/.*)?$/i.test(s)) return 'https://' + s;
  return ENGINES[settings.engine].q + encodeURIComponent(s);
}
function display(url) {
  if (!url) return '';
  if (url.startsWith(START)) return '';
  if (url.startsWith(MININET)) {
    const h = url.split('#')[1] || 'home.mini';
    return 'mini://' + decodeURIComponent(h);
  }
  return url;
}
function favicon(url) {
  if (!url) return 'icon.png';
  if (url.startsWith('mini://') || url.startsWith(MININET) || url.startsWith(START)) return 'icon.png';
  try { return 'https://www.google.com/s2/favicons?sz=64&domain=' + new URL(url).hostname; } catch { return 'icon.png'; }
}

/* ---------------- tabs ---------------- */
let tabs = [], active = null, closed = [];
let seq = 0;
function newTab(url, { background = false, after = true } = {}) {
  const t = { id: ++seq, url: url || startUrl(), title: 'New tab', fav: null, loading: true, zoom: 0 };
  const wv = document.createElement('webview');
  wv.setAttribute('partition', PARTITION);
  wv.setAttribute('allowpopups', '');
  wv.setAttribute('webpreferences', 'contextIsolation=yes');
  wv.src = t.url;
  t.wv = wv;
  $('#views').appendChild(wv);
  wireWebview(t);
  const idx = after && active ? tabs.indexOf(active) + 1 : tabs.length;
  tabs.splice(idx, 0, t);
  if (!background || !active) activate(t); else renderTabs();
  saveSession();
  return t;
}
function activate(t) {
  active = t;
  tabs.forEach(x => x.wv.classList.toggle('on', x === t));
  renderTabs(); updateToolbar();
  if (!t.url || t.url.startsWith(START)) setTimeout(() => $('#addr').focus(), 30);
  saveSession();
}
function closeTab(t) {
  const i = tabs.indexOf(t); if (i < 0) return;
  closed.push(t.url); if (closed.length > 25) closed.shift();
  t.wv.remove(); tabs.splice(i, 1);
  if (!tabs.length) { newTab(); return; }
  if (active === t) activate(tabs[Math.min(i, tabs.length - 1)]); else renderTabs();
  saveSession();
}
function renderTabs() {
  const box = $('#tabs');
  const narrow = tabs.length > 9;
  box.innerHTML = '';
  tabs.forEach(t => {
    const el = document.createElement('div');
    el.className = 'tab' + (t === active ? ' on' : '') + (narrow ? ' narrow' : '');
    el.title = t.title + '\n' + display(t.url);
    el.innerHTML = (t.loading ? '<span class="spin"></span>' : `<img class="fav" src="${esc(t.fav || favicon(display(t.url) || t.url))}">`) +
      `<span class="tt">${esc(t.title)}</span><button class="x" title="Close tab (Ctrl+W)"><svg viewBox="0 0 24 24"><path d="M7 7l10 10M17 7L7 17"/></svg></button>`;
    el.onmousedown = e => { if (e.button === 1) { e.preventDefault(); closeTab(t); } else if (e.button === 0 && !e.target.closest('.x')) activate(t); };
    el.querySelector('.x').onclick = e => { e.stopPropagation(); closeTab(t); };
    const img = el.querySelector('img'); if (img) img.onerror = () => { img.src = 'icon.png'; };
    box.appendChild(el);
  });
  document.title = active ? active.title + ' — MiniNet Browser' : 'MiniNet Browser';
}
function wireWebview(t) {
  const wv = t.wv;
  const nav = (url) => { t.url = url; if (t === active) updateToolbar(); saveSession(); };
  wv.addEventListener('did-start-loading', () => { t.loading = true; renderTabs(); if (t === active) updateToolbar(); });
  wv.addEventListener('did-stop-loading', () => { t.loading = false; renderTabs(); if (t === active) updateToolbar(); });
  wv.addEventListener('did-navigate', e => { nav(e.url); t.fav = null; addHistory(e.url, t.title); });
  wv.addEventListener('did-navigate-in-page', e => { if (e.isMainFrame) { nav(e.url); if (e.url.startsWith(MININET)) addHistory(e.url, t.title); } });
  wv.addEventListener('page-title-updated', e => {
    t.title = e.title || display(t.url) || 'New tab';
    if (t.url.startsWith(START)) t.title = 'New tab';
    const h = history[0]; if (h && h.url === t.url) { h.title = t.title; storeHistory(); }
    renderTabs();
  });
  wv.addEventListener('page-favicon-updated', e => { if (e.favicons && e.favicons[0] && !t.url.startsWith('file:')) { t.fav = e.favicons[0]; renderTabs(); } });
  wv.addEventListener('did-fail-load', e => {
    if (!e.isMainFrame || e.errorCode === -3) return;
    const msg = `<html><body style="background:#0c0822;color:#f3efff;font-family:Segoe UI,system-ui,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;text-align:center">
      <div><div style="font-size:64px">🛰️</div><h2>This page can't be reached</h2><p style="color:#a69fcc">${esc(e.validatedURL)}<br>${esc(e.errorDescription)} (${e.errorCode})</p>
      <p style="color:#a69fcc">Check your internet or data connection, then press Reload.</p></div></body></html>`;
    wv.executeJavaScript(`document.open();document.write(${JSON.stringify(msg)});document.close();`).catch(() => {});
  });
  wv.addEventListener('enter-html-full-screen', () => document.body.classList.add('htmlfull'));
  wv.addEventListener('leave-html-full-screen', () => document.body.classList.remove('htmlfull'));
  wv.addEventListener('found-in-page', e => { const r = e.result; if (r.finalUpdate !== false) $('#findN').textContent = r.matches ? `${r.activeMatchOrdinal}/${r.matches}` : '0/0'; });
  wv.addEventListener('dom-ready', () => { if (t.zoom) wv.setZoomLevel(t.zoom); }, { once: false });
}

/* ---------------- toolbar ---------------- */
function updateToolbar() {
  const t = active; if (!t) return;
  const wv = t.wv;
  let canBack = false, canFwd = false;
  try { canBack = wv.canGoBack(); canFwd = wv.canGoForward(); } catch {}
  $('#bBack').disabled = !canBack; $('#bFwd').disabled = !canFwd;
  $('#reloadIc').innerHTML = t.loading ? '<path d="M7 7l10 10M17 7L7 17"/>' : '<path d="M19 12a7 7 0 1 1-2.05-4.95M19 4v4h-4"/>';
  $('#bReload').title = t.loading ? 'Stop' : 'Reload (Ctrl+R)';
  if (document.activeElement !== $('#addr')) $('#addr').value = display(t.url);
  const b = $('#badge'), d = display(t.url);
  b.className = '';
  if (d.startsWith('mini://')) { b.className = 'mini'; b.innerHTML = 'MiniNet'; b.title = 'A site inside your own MiniNet'; }
  else if (d.startsWith('https://')) { b.className = 'secure'; b.innerHTML = '<svg viewBox="0 0 24 24"><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>'; b.title = 'Secure connection'; }
  else if (d.startsWith('http://')) { b.className = 'warn'; b.textContent = 'Not secure'; b.title = 'This page is not encrypted'; }
  else b.innerHTML = '';
  $('#bStar').classList.toggle('on', bookmarks.some(x => x.url === d && d));
  $$('#sideSites .sb[data-url]').forEach(el => el.classList.toggle('on', !!d && sameSite(el.dataset.url, d)));
}
function sameSite(a, b) {
  if (a.startsWith('mini://')) return b.startsWith('mini://');
  try { return new URL(a).hostname === new URL(b).hostname; } catch { return false; }
}
$('#bBack').onclick = () => active && active.wv.goBack();
$('#bFwd').onclick = () => active && active.wv.goForward();
$('#bReload').onclick = () => { if (!active) return; active.loading ? active.wv.stop() : active.wv.reload(); };
$('#bHome').onclick = () => go(homeUrl());
$('#newTab').onclick = () => newTab();
function go(url) { if (!active) return newTab(url); active.wv.loadURL(url).catch(() => {}); active.url = url; updateToolbar(); }

/* ---------------- omnibox + suggestions ---------------- */
const addr = $('#addr'), sugg = $('#sugg');
let sIdx = -1, sItems = [];
addr.addEventListener('focus', () => setTimeout(() => addr.select(), 0));
addr.addEventListener('blur', () => setTimeout(() => { sugg.classList.remove('show'); updateToolbar(); }, 150));
addr.addEventListener('input', buildSugg);
addr.addEventListener('keydown', e => {
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    if (!sItems.length) return; e.preventDefault();
    sIdx = (sIdx + (e.key === 'ArrowDown' ? 1 : -1) + sItems.length) % sItems.length;
    paintSugg(); addr.value = sItems[sIdx].fill;
  } else if (e.key === 'Enter') {
    const v = sIdx >= 0 ? sItems[sIdx].go : addr.value;
    sugg.classList.remove('show');
    if (e.altKey) newTab(resolve(v)); else go(resolve(v));
    active && active.wv.focus();
  } else if (e.key === 'Escape') { addr.value = display(active && active.url); addr.select(); sugg.classList.remove('show'); }
});
function buildSugg() {
  const q = addr.value.trim().toLowerCase();
  sIdx = -1; sItems = [];
  if (!q) { sugg.classList.remove('show'); return; }
  const r = resolve(addr.value);
  const isSearch = r.startsWith(ENGINES[settings.engine].q);
  sItems.push(isSearch
    ? { k: '⌕', t: addr.value, u: 'Search ' + ENGINES[settings.engine].name, go: addr.value, fill: addr.value }
    : { k: '→', t: display(r) || r, u: 'Go to address', go: addr.value, fill: addr.value });
  const seen = new Set();
  const pool = [...bookmarks.map(b => ({ ...b, star: 1 })), ...history.map(h => ({ url: display(h.url), title: h.title }))];
  for (const p of pool) {
    if (!p.url || seen.has(p.url)) continue;
    if (p.url.toLowerCase().includes(q) || (p.title || '').toLowerCase().includes(q)) {
      seen.add(p.url); sItems.push({ k: p.star ? '★' : '◷', t: p.title || p.url, u: p.url, go: p.url, fill: p.url });
      if (sItems.length >= 7) break;
    }
  }
  if (sItems.length < 8 && /^[a-z0-9-]+$/.test(q))
    sItems.push({ k: '◉', t: q + '.mini', u: 'Visit on MiniNet', go: 'mini://' + q + '.mini', fill: 'mini://' + q + '.mini' });
  paintSugg();
}
function paintSugg() {
  sugg.innerHTML = sItems.map((s, i) => `<div class="sg${i === sIdx ? ' on' : ''}" data-i="${i}"><span class="k">${esc(s.k)}</span><span class="t">${esc(s.t)}</span><span class="u">${esc(s.u)}</span></div>`).join('');
  sugg.classList.toggle('show', sItems.length > 0);
  $$('.sg').forEach(el => el.onmousedown = e => { e.preventDefault(); const s = sItems[+el.dataset.i]; sugg.classList.remove('show'); go(resolve(s.go)); });
}

/* ---------------- bookmarks ---------------- */
function storeBookmarks() { store('bookmarks', bookmarks); renderBookbar(); updateToolbar(); if (panelOpen === 'bookmarks') showPanel('bookmarks'); }
function toggleBookmark() {
  if (!active) return; const d = display(active.url); if (!d) return toast('Open a page first');
  const i = bookmarks.findIndex(b => b.url === d);
  if (i >= 0) { bookmarks.splice(i, 1); toast('Bookmark removed'); }
  else { bookmarks.push({ url: d, title: active.title || d }); toast('Bookmarked ★'); }
  storeBookmarks();
}
$('#bStar').onclick = toggleBookmark;
function renderBookbar() {
  const bar = $('#bookbar');
  bar.innerHTML = bookmarks.map((b, i) => `<div class="bm" data-i="${i}" title="${esc(b.title)}\n${esc(b.url)}"><img src="${esc(favicon(b.url))}"><span>${esc(b.title)}</span></div>`).join('');
  bar.querySelectorAll('.bm').forEach(el => {
    const b = bookmarks[+el.dataset.i];
    el.onmousedown = e => { if (e.button === 1) { e.preventDefault(); newTab(resolve(b.url), { background: true }); } };
    el.onclick = e => e.ctrlKey ? newTab(resolve(b.url), { background: true }) : go(resolve(b.url));
    el.querySelector('img').onerror = function () { this.src = 'icon.png'; };
  });
}

/* ---------------- sidebar ---------------- */
function renderSide() {
  const box = $('#sideSites');
  box.innerHTML = `<button class="sb minibtn" data-url="mini://home.mini" title="MiniNet Chat"><img src="icon.png"></button>` +
    sideSites.map((s, i) => `<button class="sb" data-url="${esc(s.url)}" data-i="${i}" title="${esc(s.title)} (right-click to remove)"><img src="${esc(favicon(s.url))}"></button>`).join('') +
    `<button class="sb add" title="Add current site to sidebar"><svg viewBox="0 0 24 24"><path d="M12 6v12M6 12h12"/></svg></button>`;
  box.querySelectorAll('.sb[data-url]').forEach(el => {
    el.onclick = () => openSide(el.dataset.url);
    el.oncontextmenu = e => { e.preventDefault(); if (el.dataset.i !== undefined && confirm('Remove ' + sideSites[+el.dataset.i].title + ' from the sidebar?')) { sideSites.splice(+el.dataset.i, 1); store('sideSites', sideSites); renderSide(); } };
    const img = el.querySelector('img'); img.onerror = () => { img.src = 'icon.png'; };
  });
  box.querySelector('.add').onclick = () => {
    const d = active && display(active.url);
    if (!d || d.startsWith('mini://')) return toast('Open a website first, then press + to pin it');
    if (sideSites.some(s => sameSite(s.url, d))) return toast('Already in the sidebar');
    let title = active.title; try { title = new URL(d).hostname.replace(/^www\./, ''); } catch {}
    sideSites.push({ url: d, title }); store('sideSites', sideSites); renderSide(); toast('Pinned to sidebar');
  };
  updateToolbar();
}
function openSide(url) {
  const existing = tabs.find(t => sameSite(url, display(t.url) || ''));
  if (existing) activate(existing); else newTab(resolve(url));
}
$$('#side [data-panel], #toolbar [data-panel]').forEach(b => b.onclick = () => togglePanel(b.dataset.panel));

/* ---------------- history ---------------- */
let histTimer;
function storeHistory() { clearTimeout(histTimer); histTimer = setTimeout(() => store('history', history.slice(0, 3000)), 400); }
function addHistory(url, title) {
  if (!url || url.startsWith(START) || url.startsWith('data:')) return;
  if (history[0] && history[0].url === url) return;
  history.unshift({ url, title: title || display(url), t: Date.now() });
  if (history.length > 3000) history.length = 3000;
  storeHistory();
  if (panelOpen === 'history') showPanel('history');
}

/* ---------------- downloads ---------------- */
window.app.on('download', d => {
  const i = downloads.findIndex(x => x.id === d.id);
  if (i >= 0) downloads[i] = d; else { downloads.unshift(d); toast('Downloading ' + d.name); }
  if (d.status === 'completed') toast('Downloaded ' + d.name);
  if (d.status !== 'progressing') store('downloads', downloads.slice(0, 200));
  $('#dlDot').style.display = downloads.some(x => x.status === 'progressing') ? 'block' : 'none';
  if (panelOpen === 'downloads') showPanel('downloads');
});
$('#bDl').onclick = () => togglePanel('downloads');
function fmtBytes(n) { if (!n) return '0 B'; const u = ['B', 'KB', 'MB', 'GB']; let i = 0; while (n >= 1024 && i < 3) { n /= 1024; i++; } return n.toFixed(i ? 1 : 0) + ' ' + u[i]; }

/* ---------------- side panel ---------------- */
let panelOpen = null;
function togglePanel(name) { if (panelOpen === name) hidePanel(); else showPanel(name); }
function hidePanel() { panelOpen = null; $('#panel').classList.remove('open'); $$('#side [data-panel], #toolbar [data-panel]').forEach(b => b.classList.remove('on')); }
$('#panelClose').onclick = hidePanel;
const PANELS = {};
function showPanel(name) {
  panelOpen = name;
  $('#panel').classList.add('open');
  $('#panel').classList.toggle('wide', !!(PANELS[name] && PANELS[name].wide));
  $$('#side [data-panel], #toolbar [data-panel]').forEach(b => b.classList.toggle('on', b.dataset.panel === name));
  const body = $('#panelBody');
  body.className = '';
  if (PANELS[name]) { $('#panelTitle').textContent = PANELS[name].title; PANELS[name].render(body); return; }
  const titles = { bookmarks: 'Bookmarks', history: 'History', downloads: 'Downloads', settings: 'Settings' };
  $('#panelTitle').textContent = titles[name];
  if (name === 'bookmarks') {
    body.innerHTML = `<button class="btn sun wide" id="pAddBm">★ Bookmark this page</button>` + (bookmarks.length ? bookmarks.map((b, i) =>
      `<div class="pi" data-i="${i}"><img src="${esc(favicon(b.url))}"><div class="tx"><div>${esc(b.title)}</div><small>${esc(b.url)}</small></div>
       <button class="ic sm" data-up="${i}" title="Move up"><svg viewBox="0 0 24 24"><path d="M6 15l6-6 6 6"/></svg></button>
       <button class="ic sm" data-del="${i}" title="Delete"><svg viewBox="0 0 24 24"><path d="M7 7l10 10M17 7L7 17"/></svg></button></div>`).join('') : '<p style="color:var(--dim)">No bookmarks yet.</p>');
    $('#pAddBm').onclick = toggleBookmark;
    body.querySelectorAll('.pi').forEach(el => el.onclick = e => { if (e.target.closest('button')) return; go(resolve(bookmarks[+el.dataset.i].url)); });
    body.querySelectorAll('[data-del]').forEach(b => b.onclick = () => { bookmarks.splice(+b.dataset.del, 1); storeBookmarks(); });
    body.querySelectorAll('[data-up]').forEach(b => b.onclick = () => { const i = +b.dataset.up; if (i > 0) { [bookmarks[i - 1], bookmarks[i]] = [bookmarks[i], bookmarks[i - 1]]; storeBookmarks(); } });
  }
  if (name === 'history') {
    const prevQ = ($('#hq') || {}).value || '';
    body.innerHTML = `<input class="inp" id="hq" placeholder="Search history" value="${esc(prevQ)}"><div id="hl"></div><button class="btn wide" id="hClear">Clear all history</button>`;
    const paint = () => {
      const q = $('#hq').value.toLowerCase();
      let last = '', html = '';
      history.filter(h => !q || (h.title || '').toLowerCase().includes(q) || display(h.url).toLowerCase().includes(q)).slice(0, 300).forEach((h, i) => {
        const day = new Date(h.t).toDateString();
        if (day !== last) { html += `<div class="day">${day === new Date().toDateString() ? 'Today' : esc(day)}</div>`; last = day; }
        html += `<div class="pi" data-u="${esc(h.url)}"><img src="${esc(favicon(display(h.url)))}"><div class="tx"><div>${esc(h.title)}</div><small>${new Date(h.t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} · ${esc(display(h.url))}</small></div></div>`;
      });
      $('#hl').innerHTML = html || '<p style="color:var(--dim)">Nothing here.</p>';
      $('#hl').querySelectorAll('.pi').forEach(el => el.onclick = () => go(el.dataset.u));
      $('#hl').querySelectorAll('img').forEach(i => i.onerror = () => i.src = 'icon.png');
    };
    $('#hq').oninput = paint; paint();
    $('#hClear').onclick = () => { if (confirm('Clear all browsing history?')) { history = []; store('history', []); showPanel('history'); toast('History cleared'); } };
  }
  if (name === 'downloads') {
    body.innerHTML = (downloads.length ? downloads.map((d, i) => `<div class="pi" data-i="${i}"><div class="tx"><div>${esc(d.name)}</div>
      <small>${d.status === 'progressing' ? fmtBytes(d.received) + ' of ' + fmtBytes(d.total) : d.status === 'completed' ? fmtBytes(d.total) + ' · click to open' : esc(d.status)}</small>
      ${d.status === 'progressing' ? `<div class="bar"><b style="width:${d.total ? Math.round(d.received / d.total * 100) : 30}%"></b></div>` : ''}</div>
      ${d.status === 'completed' ? `<button class="ic sm" data-folder="${i}" title="Show in folder"><svg viewBox="0 0 24 24"><path d="M3 7h6l2 2h10v10H3z"/></svg></button>` : ''}</div>`).join('') :
      '<p style="color:var(--dim)">Files you download will show up here. They are saved to your Downloads folder.</p>') +
      (downloads.length ? '<button class="btn wide" id="dClear">Clear list</button>' : '');
    body.querySelectorAll('.pi').forEach(el => el.onclick = e => { const d = downloads[+el.dataset.i]; if (e.target.closest('[data-folder]')) return window.app.showItem(d.path); if (d.status === 'completed') window.app.openPath(d.path); });
    const c = $('#dClear'); if (c) c.onclick = () => { downloads = downloads.filter(d => d.status === 'progressing'); store('downloads', downloads); showPanel('downloads'); };
  }
  if (name === 'settings') {
    body.innerHTML = `
      <div class="set"><b>Theme</b><select class="inp" id="sTheme">${Object.entries(THEMES).map(([k, t]) => `<option value="${k}" ${settings.theme === k ? 'selected' : ''}>${t.name}</option>`).join('')}</select></div>
      <div class="set"><b>Search engine</b><select class="inp" id="sEngine">${Object.entries(ENGINES).map(([k, e]) => `<option value="${k}" ${settings.engine === k ? 'selected' : ''}>${e.name}</option>`).join('')}</select></div>
      <div class="set"><b>Home button opens</b><select class="inp" id="sHome">
        <option value="start" ${settings.home === 'start' ? 'selected' : ''}>Start page</option>
        <option value="mininet" ${settings.home === 'mininet' ? 'selected' : ''}>MiniNet Chat (mini://home.mini)</option>
        <option value="custom" ${settings.home === 'custom' ? 'selected' : ''}>A website…</option></select>
        <input class="inp" id="sHomeUrl" placeholder="e.g. google.com" value="${esc(settings.homeUrl)}" style="display:${settings.home === 'custom' ? 'block' : 'none'}"></div>
      <div class="set"><b>When the browser opens</b><select class="inp" id="sStartup">
        <option value="restore" ${settings.startup === 'restore' ? 'selected' : ''}>Reopen my tabs</option>
        <option value="home" ${settings.startup === 'home' ? 'selected' : ''}>Open the home page</option></select></div>
      <div class="set"><label>Block ads &amp; trackers <input type="checkbox" class="tog" id="sAd" ${settings.adblock ? 'checked' : ''}></label><small>Pages load faster and use less data. ${blocked.ad} blocked this session.</small></div>
      <div class="set"><label>Data saver <input type="checkbox" class="tog" id="sData" ${settings.datasaver ? 'checked' : ''}></label><small>Stops images and videos from loading to save mobile data. ${blocked.data} blocked this session.</small></div>
      <div class="set"><label>Show bookmarks bar <input type="checkbox" class="tog" id="sBar" ${settings.bookbar ? 'checked' : ''}></label></div>
      <div class="set"><label>Show sidebar <input type="checkbox" class="tog" id="sSide" ${settings.sidebar ? 'checked' : ''}></label></div>
      <div class="set"><b>Privacy</b>
        <button class="btn wide" id="sClrCache">Clear cached files</button>
        <button class="btn wide" id="sClrData">Clear cookies &amp; site data (signs you out)</button></div>
      <div class="set" style="border:0;text-align:center;color:var(--dim)"><img src="icon.png" style="width:44px"><br><b style="color:var(--ink)">MiniNet Browser</b> <span id="ver"></span><br>The real web, plus a tiny internet of your own.</div>`;
    $('#sTheme').onchange = e => { settings.theme = e.target.value; saveSettings(); };
    $('#sEngine').onchange = e => { settings.engine = e.target.value; saveSettings(); toast('Search engine: ' + ENGINES[settings.engine].name); };
    $('#sHome').onchange = e => { settings.home = e.target.value; $('#sHomeUrl').style.display = settings.home === 'custom' ? 'block' : 'none'; saveSettings(); };
    $('#sHomeUrl').onchange = e => { settings.homeUrl = e.target.value.trim(); saveSettings(); };
    $('#sStartup').onchange = e => { settings.startup = e.target.value; saveSettings(); };
    $('#sAd').onchange = e => { settings.adblock = e.target.checked; saveSettings(); };
    $('#sData').onchange = e => { settings.datasaver = e.target.checked; saveSettings(); toast(settings.datasaver ? 'Data saver on — reload pages to apply' : 'Data saver off'); };
    $('#sBar').onchange = e => { settings.bookbar = e.target.checked; saveSettings(); };
    $('#sSide').onchange = e => { settings.sidebar = e.target.checked; saveSettings(); };
    $('#sClrCache').onclick = async () => { await window.app.clearData('cache'); toast('Cache cleared'); };
    $('#sClrData').onclick = async () => { if (confirm('This signs you out of websites and erases MiniNet data too. Continue?')) { await window.app.clearData('all'); toast('Cookies & site data cleared'); tabs.forEach(t => t.wv.reload()); } };
    window.app.version().then(v => { const el = $('#ver'); if (el) el.textContent = 'v' + v; });
  }
}

/* ---------------- shield / data saver buttons ---------------- */
window.app.on('blocked', kind => {
  blocked[kind]++;
  const n = blocked.ad + blocked.data, el = $('#shieldN');
  el.style.display = n ? 'block' : 'none'; el.textContent = n > 999 ? '999+' : n;
});
$('#bShield').onclick = () => { settings.adblock = !settings.adblock; saveSettings(); toast(settings.adblock ? `Ad blocker on (${blocked.ad} blocked)` : 'Ad blocker off'); };
$('#bData').onclick = () => { settings.datasaver = !settings.datasaver; saveSettings(); toast(settings.datasaver ? 'Data saver on — images & videos paused. Reload to apply.' : 'Data saver off'); };
const THEMES = {
  sunset: { name: 'Sunset (default)', v: {} },
  ocean: { name: 'Ocean', v: { '--bg0': '#06121f', '--bg1': '#0b1c2e', '--bg2': '#10263d', '--bg3': '#1b3a59', '--line': '#1e3a5a', '--sun1': '#3b82f6', '--sun2': '#22d3ee', '--sun3': '#a5f3fc', '--teal': '#5eead4', '--mute': '#93acc7', '--dim': '#5d7894' } },
  forest: { name: 'Forest', v: { '--bg0': '#08130c', '--bg1': '#0d1d13', '--bg2': '#13281b', '--bg3': '#1f3d2a', '--line': '#21402c', '--sun1': '#84cc16', '--sun2': '#facc15', '--sun3': '#fde68a', '--teal': '#34d399', '--mute': '#9dbba6', '--dim': '#62806b' } },
  rose: { name: 'Midnight Rose', v: { '--bg0': '#16070f', '--bg1': '#220b18', '--bg2': '#2e1021', '--bg3': '#4a1a36', '--line': '#4a1d38', '--sun1': '#f43f5e', '--sun2': '#ec4899', '--sun3': '#f9a8d4', '--teal': '#c4b5fd', '--mute': '#c99bb3', '--dim': '#8a6177' } },
  mono: { name: 'Graphite', v: { '--bg0': '#0b0b0d', '--bg1': '#131316', '--bg2': '#1b1b1f', '--bg3': '#2a2a30', '--line': '#2c2c33', '--sun1': '#e5e5e5', '--sun2': '#bdbdbd', '--sun3': '#ffffff', '--teal': '#a3e635', '--mute': '#a1a1aa', '--dim': '#71717a' } }
};
function applyTheme() {
  const root = document.documentElement;
  ['--bg0', '--bg1', '--bg2', '--bg3', '--line', '--sun1', '--sun2', '--sun3', '--teal', '--mute', '--dim'].forEach(k => root.style.removeProperty(k));
  const t = THEMES[settings.theme] || THEMES.sunset;
  for (const [k, v] of Object.entries(t.v)) root.style.setProperty(k, v);
}
function applySettings() {
  applyTheme();
  $('#bShield').classList.toggle('off', !settings.adblock);
  $('#bShield').classList.toggle('active', settings.adblock);
  $('#bShield').title = 'Ad blocker: ' + (settings.adblock ? 'on' : 'off');
  $('#bData').classList.toggle('active', settings.datasaver);
  $('#bData').title = 'Data saver: ' + (settings.datasaver ? 'on' : 'off');
  $('#bookbar').classList.toggle('hide', !settings.bookbar);
  document.body.classList.toggle('nobar', !settings.bookbar);
  $('#side').classList.toggle('hide', !settings.sidebar);
}

/* ---------------- main menu ---------------- */
const menu = $('#menu');
$('#bMenu').onclick = e => { e.stopPropagation(); menu.classList.contains('show') ? menu.classList.remove('show') : openMenu(); };
document.addEventListener('mousedown', e => { if (!e.target.closest('#menu') && !e.target.closest('#bMenu')) menu.classList.remove('show'); });
function openMenu() {
  const z = active ? Math.round(Math.pow(1.2, active.zoom) * 100) : 100;
  const items = [
    ['New tab', 'Ctrl+T', () => newTab()],
    ['Reopen closed tab', 'Ctrl+Shift+T', reopen],
    ['Open MiniNet Chat', '', () => openSide('mini://home.mini')],
    '-', ['zoom'], '-',
    ['Find in page', 'Ctrl+F', openFind],
    ['Print…', 'Ctrl+P', () => active && active.wv.print()],
    ['Full screen', 'F11', () => window.app.win('full')],
    '-',
    ['Bookmarks', '', () => showPanel('bookmarks')],
    ['History', 'Ctrl+H', () => showPanel('history')],
    ['Downloads', 'Ctrl+J', () => showPanel('downloads')],
    ['Settings', '', () => showPanel('settings')],
    '-',
    ['Developer tools', 'F12', () => active && active.wv.openDevTools()]
  ];
  menu.innerHTML = items.map((it, i) => it === '-' ? '<div class="msep"></div>' : it[0] === 'zoom'
    ? `<div class="zoomrow"><span>Zoom</span><span><button class="ic sm" id="zOut">−</button> <b style="display:inline-block;width:44px;text-align:center">${z}%</b> <button class="ic sm" id="zIn">+</button></span></div>`
    : `<div class="mi" data-i="${i}"><span>${it[0]}</span><kbd>${it[1]}</kbd></div>`).join('');
  menu.querySelectorAll('.mi').forEach(el => el.onclick = () => { menu.classList.remove('show'); items[+el.dataset.i][2](); });
  $('#zIn').onclick = () => { zoom(1); openMenu(); };
  $('#zOut').onclick = () => { zoom(-1); openMenu(); };
  menu.classList.add('show');
}
function reopen() { const u = closed.pop(); if (u) newTab(u); else toast('No recently closed tabs'); }
function zoom(dir) {
  if (!active) return;
  active.zoom = dir === 0 ? 0 : Math.max(-5, Math.min(6, active.zoom + dir * 0.5));
  active.wv.setZoomLevel(active.zoom);
  const tip = $('#zoomTip'); tip.textContent = Math.round(Math.pow(1.2, active.zoom) * 100) + '%'; tip.style.display = 'block';
  clearTimeout(tip._h); tip._h = setTimeout(() => tip.style.display = 'none', 1200);
}

/* ---------------- find in page ---------------- */
function openFind() { $('#findbar').classList.add('show'); $('#findIn').focus(); $('#findIn').select(); }
function closeFind() { $('#findbar').classList.remove('show'); active && active.wv.stopFindInPage('clearSelection'); $('#findN').textContent = ''; }
$('#findIn').oninput = e => { if (!active) return; if (e.target.value) active.wv.findInPage(e.target.value); else { active.wv.stopFindInPage('clearSelection'); $('#findN').textContent = ''; } };
$('#findIn').onkeydown = e => { if (e.key === 'Enter' && e.target.value) active.wv.findInPage(e.target.value, { forward: !e.shiftKey, findNext: true }); if (e.key === 'Escape') closeFind(); };
$('#findNext').onclick = () => $('#findIn').value && active.wv.findInPage($('#findIn').value, { findNext: true });
$('#findPrev').onclick = () => $('#findIn').value && active.wv.findInPage($('#findIn').value, { forward: false, findNext: true });
$('#findClose').onclick = closeFind;

/* ---------------- keyboard shortcuts ---------------- */
function shortcut({ key, ctrl, shift, alt }) {
  const k = key.length === 1 ? key.toLowerCase() : key;
  if (ctrl && k === 't' && shift) return reopen();
  if (ctrl && k === 't') return newTab();
  if (ctrl && k === 'n') return newTab();
  if (ctrl && k === 'w') return active && closeTab(active);
  if (ctrl && k === 'l') { addr.focus(); addr.select(); return; }
  if ((ctrl && k === 'r') || k === 'F5') return active && active.wv.reload();
  if (ctrl && k === 'd') return toggleBookmark();
  if (ctrl && k === 'h') return togglePanel('history');
  if (ctrl && k === 'j') return togglePanel('downloads');
  if (ctrl && k === 'f') return openFind();
  if (ctrl && k === 'k') return togglePanel('orbit');
  if (ctrl && k === 'p') return active && active.wv.print();
  if (ctrl && k === 'Tab') { const i = tabs.indexOf(active); return activate(tabs[(i + (shift ? -1 : 1) + tabs.length) % tabs.length]); }
  if (ctrl && (k === '=' || k === '+')) return zoom(1);
  if (ctrl && k === '-') return zoom(-1);
  if (ctrl && k === '0') return zoom(0);
  if (alt && k === 'ArrowLeft') return active && active.wv.goBack();
  if (alt && k === 'ArrowRight') return active && active.wv.goForward();
  if (alt && k === 'Home') return go(homeUrl());
  if (k === 'F11') return window.app.win('full');
  if (k === 'F12') return active && active.wv.openDevTools();
}
window.app.on('shortcut', shortcut);
document.addEventListener('keydown', e => {
  const ctrl = e.ctrlKey || e.metaKey;
  if (ctrl || e.altKey || ['F5', 'F11', 'F12'].includes(e.key)) {
    const before = e.defaultPrevented;
    if (ctrl && ['c', 'v', 'x', 'a', 'z', 'y'].includes(e.key.toLowerCase())) return;
    shortcut({ key: e.key, ctrl, shift: e.shiftKey, alt: e.altKey });
    if (!before && (ctrl || ['F5', 'F11', 'F12'].includes(e.key))) e.preventDefault();
  }
  if (e.key === 'Escape' && $('#findbar').classList.contains('show')) closeFind();
});

/* ---------------- window controls ---------------- */
$$('[data-win]').forEach(b => b.onclick = () => window.app.win(b.dataset.win));
$('#top').addEventListener('dblclick', e => { if (e.target.id === 'top' || e.target.classList.contains('drag')) window.app.win('max'); });
window.app.on('win-state', s => {
  $('#maxBtn').innerHTML = s === 'max'
    ? '<svg viewBox="0 0 24 24"><rect x="5.5" y="8.5" width="10" height="10" rx="2"/><path d="M8.5 8.5V6.5a1 1 0 0 1 1-1h8a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1h-2"/></svg>'
    : '<svg viewBox="0 0 24 24"><rect x="6.5" y="6.5" width="11" height="11" rx="2"/></svg>';
});
window.app.on('open-tab', url => newTab(url, { background: false }));
window.app.on('search-tab', text => newTab(resolve(text)));

/* ---------------- toast ---------------- */
function toast(m) { const t = $('#toast'); t.textContent = m; t.classList.add('show'); clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove('show'), 2400); }

/* ---------------- session ---------------- */
let sessTimer;
function saveSession() {
  clearTimeout(sessTimer);
  sessTimer = setTimeout(() => store('session', { tabs: tabs.map(t => t.url), active: tabs.indexOf(active) }), 300);
}

/* ---------------- requests from the AI engine ---------------- */
function wcIdOf(t) { try { return t.wv.getWebContentsId(); } catch { return null; } }
function tabInfo(t) { return { id: t.id, wcId: wcIdOf(t), url: t.url, title: t.title, active: t === active, loading: t.loading }; }
async function waitWc(t, ms = 8000) { const end = Date.now() + ms; while (!wcIdOf(t) && Date.now() < end) await new Promise(r => setTimeout(r, 50)); return wcIdOf(t); }
const AGENT_OPS = {
  list: () => tabs.map(tabInfo),
  open: async ({ url, background }) => { const t = newTab(resolve(url), { background }); await waitWc(t); return tabInfo(t); },
  navigate: ({ id, url }) => { const t = tabs.find(x => x.id === id); if (!t) throw new Error('No such tab'); t.wv.loadURL(resolve(url)).catch(() => {}); t.url = resolve(url); if (t === active) updateToolbar(); return true; },
  resolve: ({ url }) => resolve(url),
  activate: ({ id }) => { const t = tabs.find(x => x.id === id); if (!t) throw new Error('No such tab'); activate(t); return true; },
  close: ({ id }) => { const t = tabs.find(x => x.id === id); if (!t) throw new Error('No such tab'); closeTab(t); return true; },
  speak: ({ text }) => { speak(text); return true; },
  toast: ({ text }) => { toast(text); return true; },
  'extensions-changed': ({ reload }) => { if (panelOpen === 'extensions') showPanel('extensions'); if (reload && active && !active.url.startsWith(START)) active.wv.reload(); return true; }
};
window.app.on('agent-req', async ({ id, op, args }) => {
  try { const result = await AGENT_OPS[op](args || {}, id); window.app.agentRespond({ id, ok: true, result }); }
  catch (e) { window.app.agentRespond({ id, ok: false, error: e.message }); }
});
function speak(text) {
  try { speechSynthesis.cancel(); const u = new SpeechSynthesisUtterance(String(text).replace(/[*_`#>]/g, '')); u.rate = 1.03; speechSynthesis.speak(u); } catch {}
}

/* ---------------- start ---------------- */
window.app.settings({ adblock: settings.adblock, datasaver: settings.datasaver });
applySettings(); renderBookbar(); renderSide();
const sess = load('session', null);
if (settings.startup === 'restore' && sess && sess.tabs && sess.tabs.length) {
  sess.tabs.forEach(u => newTab(u.startsWith('file:') && u.includes('start.html') ? startUrl() : u.startsWith('file:') && u.includes('mininet/MiniNet.html') ? MININET + '?embedded=1#' + (u.split('#')[1] || 'home.mini') : u, { background: true, after: false }));
  activate(tabs[Math.max(0, Math.min(sess.active, tabs.length - 1))]);
} else newTab(homeUrl() === startUrl() ? startUrl() : homeUrl());
setInterval(updateToolbar, 1000);
