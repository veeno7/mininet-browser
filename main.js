// MiniNet Browser — main process
const { app, BrowserWindow, session, ipcMain, Menu, shell, clipboard, dialog, safeStorage } = require('electron');
const path = require('path');
const fs = require('fs');
const agent = require('./agent');
const ext = require('./extensions');

const PARTITION = 'persist:main';
let win = null;
const state = { adblock: true, datasaver: false };

/* ---------------- ad blocking ---------------- */
const AD_HOSTS = [
  'doubleclick.net', 'googlesyndication.com', 'googleadservices.com', 'google-analytics.com',
  'adservice.google.com', 'adnxs.com', 'taboola.com', 'outbrain.com', 'criteo.com', 'criteo.net',
  'scorecardresearch.com', 'quantserve.com', 'adsrvr.org', 'pubmatic.com', 'rubiconproject.com',
  'openx.net', 'moatads.com', 'amazon-adsystem.com', 'casalemedia.com', 'smartadserver.com',
  'zedo.com', 'popads.net', 'propellerads.com', 'mgid.com', 'revcontent.com', 'hotjar.com'
];
function isAd(url) {
  try { const h = new URL(url).hostname; return AD_HOSTS.some(d => h === d || h.endsWith('.' + d)); }
  catch { return false; }
}

if (!app.requestSingleInstanceLock()) { app.quit(); }
app.on('second-instance', (e, argv) => {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.focus();
  const url = argv.find(a => /^https?:\/\//.test(a));
  if (url) win.webContents.send('open-tab', url);
});

/* ---------------- shell request/response (used by the AI engine) ---------------- */
let reqSeq = 0;
const pending = new Map();
function shellReq(op, args = {}, timeout = 30000) {
  return new Promise((resolve, reject) => {
    if (!win) return reject(new Error('Browser window is closed'));
    const id = ++reqSeq;
    const t = setTimeout(() => { pending.delete(id); win && win.webContents.send('agent-req-cancel', { id }); reject(new Error(op === 'approve' || op === 'ask' ? 'The owner did not respond in time.' : 'Browser did not respond')); }, timeout);
    pending.set(id, { resolve, reject, t });
    win.webContents.send('agent-req', { id, op, args });
    if ((op === 'approve' || op === 'ask') && win) { if (win.isMinimized()) win.restore(); win.flashFrame(true); }
  });
}
ipcMain.on('agent-res', (e, { id, ok, result, error }) => {
  const p = pending.get(id); if (!p) return;
  clearTimeout(p.t); pending.delete(id);
  ok ? p.resolve(result) : p.reject(new Error(error || 'failed'));
});

/* ---------------- sessions ---------------- */
function setupSession() {
  const ses = session.fromPartition(PARTITION);
  const ua = ses.getUserAgent().replace(/\sElectron\/\S+/, '').replace(/\smininet-browser\/\S+/i, '').replace(/\sMiniNet Browser\/\S+/i, '');
  ses.setUserAgent(ua);
  app.userAgentFallback = ua;

  ses.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (d, cb) => {
    if (state.adblock && d.resourceType !== 'mainFrame' && isAd(d.url)) {
      win && win.webContents.send('blocked', 'ad'); return cb({ cancel: true });
    }
    if (state.datasaver && (d.resourceType === 'image' || d.resourceType === 'media')) {
      win && win.webContents.send('blocked', 'data'); return cb({ cancel: true });
    }
    cb({});
  });

  const allow = ['notifications', 'media', 'fullscreen', 'clipboard-sanitized-write', 'clipboard-read', 'pointerLock', 'geolocation', 'speaker-selection'];
  ses.setPermissionRequestHandler((wc, perm, cb) => cb(allow.includes(perm)));
  session.defaultSession.setPermissionRequestHandler((wc, perm, cb) => cb(['media', 'clipboard-sanitized-write', 'speaker-selection'].includes(perm)));

  ses.on('will-download', (e, item) => {
    const id = Date.now() + Math.random().toString(36).slice(2, 6);
    item.setSavePath(path.join(app.getPath('downloads'), item.getFilename()));
    const send = (status) => win && win.webContents.send('download', {
      id, name: item.getFilename(), path: item.getSavePath(), url: item.getURL(),
      received: item.getReceivedBytes(), total: item.getTotalBytes(), status
    });
    send('progressing');
    item.on('updated', (ev, st) => send(st === 'interrupted' ? 'interrupted' : 'progressing'));
    item.once('done', (ev, st) => send(st));
  });
}

function createWindow() {
  win = new BrowserWindow({
    width: 1300, height: 840, minWidth: 460, minHeight: 420,
    backgroundColor: '#120d33', title: 'MiniNet Browser',
    icon: path.join(__dirname, 'icon.ico'),
    frame: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), webviewTag: true, contextIsolation: true, nodeIntegration: false }
  });
  Menu.setApplicationMenu(null);
  win.loadFile('shell.html');
  win.on('maximize', () => win.webContents.send('win-state', 'max'));
  win.on('unmaximize', () => win.webContents.send('win-state', 'normal'));
  win.on('enter-full-screen', () => win.webContents.send('win-state', 'full'));
  win.on('leave-full-screen', () => win.webContents.send('win-state', win.isMaximized() ? 'max' : 'normal'));
  win.on('closed', () => { win = null; });
  // The browser's own UI can never be navigated away or opened in new windows
  win.webContents.on('will-navigate', e => e.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
}

/* ---------------- page views (tabs) ---------------- */
const SHORTCUT_KEYS = new Set(['t', 'w', 'l', 'r', 'd', 'h', 'j', 'f', 'Tab', '=', '+', '-', '0', 'n', 'T', 'p', 'k', 'K']);
function injectExtensions(wc) {
  try {
    const url = agent.displayUrl(wc.getURL());
    for (const e of ext.forUrl(url)) {
      if (e.css) wc.insertCSS(e.css).catch(() => {});
      if (e.js) wc.executeJavaScript(`try{(function(){\n${e.js}\n})()}catch(err){console.error('[MiniNet extension ${e.id}]',err)}`, false).catch(() => {});
    }
  } catch (err) { console.error('extension inject', err); }
}
app.on('web-contents-created', (e, wc) => {
  if (wc.getType() !== 'webview') return;

  wc.on('dom-ready', () => injectExtensions(wc));
  wc.on('did-navigate-in-page', (ev, url, isMain) => { if (isMain && /mininet\/MiniNet\.html/.test(url)) injectExtensions(wc); });

  // Pages inside tabs can never get into the browser's own files
  wc.on('will-navigate', (ev, url) => {
    if (/^file:/i.test(url) && !url.startsWith(fileBase())) ev.preventDefault();
  });

  wc.setWindowOpenHandler(({ url }) => {
    if (win) win.webContents.send('open-tab', url);
    return { action: 'deny' };
  });

  wc.on('before-input-event', (ev, input) => {
    if (input.type !== 'keyDown' || !win) return;
    const k = input.key;
    const ctrl = input.control || input.meta;
    if ((ctrl && SHORTCUT_KEYS.has(k)) || ['F5', 'F11', 'F12'].includes(k) ||
        (input.alt && (k === 'ArrowLeft' || k === 'ArrowRight' || k === 'Home'))) {
      ev.preventDefault();
      win.webContents.send('shortcut', { key: k, ctrl, shift: input.shift, alt: input.alt });
    }
  });

  wc.on('context-menu', (ev, p) => {
    const t = [];
    if (p.linkURL) {
      t.push({ label: 'Open link in new tab', click: () => win.webContents.send('open-tab', p.linkURL) });
      t.push({ label: 'Copy link address', click: () => clipboard.writeText(p.linkURL) });
      t.push({ type: 'separator' });
    }
    if (p.mediaType === 'image') {
      t.push({ label: 'Open image in new tab', click: () => win.webContents.send('open-tab', p.srcURL) });
      t.push({ label: 'Save image', click: () => wc.downloadURL(p.srcURL) });
      t.push({ label: 'Copy image', click: () => wc.copyImageAt(p.x, p.y) });
      t.push({ type: 'separator' });
    }
    if (p.selectionText) {
      const s = p.selectionText.trim().slice(0, 40);
      t.push({ label: 'Copy', role: 'copy' });
      t.push({ label: `Search the web for “${s}${p.selectionText.length > 40 ? '…' : ''}”`, click: () => win.webContents.send('search-tab', p.selectionText) });
      t.push({ label: 'Ask Orbit about this', click: () => win.webContents.send('ask-orbit', p.selectionText) });
      t.push({ type: 'separator' });
    }
    if (p.isEditable) {
      t.push({ label: 'Cut', role: 'cut' }, { label: 'Copy', role: 'copy' }, { label: 'Paste', role: 'paste' }, { label: 'Select all', role: 'selectAll' });
      t.push({ type: 'separator' });
    }
    t.push({ label: 'Back', enabled: wc.navigationHistory.canGoBack(), click: () => wc.navigationHistory.goBack() });
    t.push({ label: 'Forward', enabled: wc.navigationHistory.canGoForward(), click: () => wc.navigationHistory.goForward() });
    t.push({ label: 'Reload', click: () => wc.reload() });
    t.push({ type: 'separator' });
    t.push({ label: 'Inspect', click: () => wc.inspectElement(p.x, p.y) });
    Menu.buildFromTemplate(t).popup({ window: win });
  });
});
function fileBase() { return require('url').pathToFileURL(__dirname).href; }

/* ---------------- IPC: window & basics ---------------- */
ipcMain.on('win', (e, cmd) => {
  if (!win) return;
  if (cmd === 'min') win.minimize();
  if (cmd === 'max') win.isMaximized() ? win.unmaximize() : win.maximize();
  if (cmd === 'close') win.close();
  if (cmd === 'full') win.setFullScreen(!win.isFullScreen());
});
ipcMain.on('settings', (e, s) => { Object.assign(state, s); });
ipcMain.on('open-path', (e, p) => shell.openPath(p));
ipcMain.on('show-item', (e, p) => shell.showItemInFolder(p));
ipcMain.on('open-external', (e, u) => { if (/^https?:/i.test(u)) shell.openExternal(u); });
ipcMain.handle('clear-data', async (e, what) => {
  const ses = session.fromPartition(PARTITION);
  if (what === 'cache') await ses.clearCache(); else await ses.clearStorageData();
  return true;
});
ipcMain.handle('version', () => app.getVersion());
ipcMain.on('copy', (e, t) => clipboard.writeText(String(t)));

/* ---------------- IPC: AI control ---------------- */
ipcMain.handle('agent-tools', () => agent.toolList());
ipcMain.handle('agent-call', async (e, { name, args, client }) => {
  try { return { ok: true, result: await agent.call(name, args, client || 'Orbit') }; }
  catch (err) { return { ok: false, error: err.message }; }
});
ipcMain.handle('agent-config', (e, c) => c ? agent.setConfig(c) : agent.getConfig());
ipcMain.handle('agent-log', () => agent.getLog());
ipcMain.on('agent-pause', (e, p) => agent.setPaused(p));
ipcMain.handle('agent-instructions', () => agent.INSTRUCTIONS);

function bridgePath() { return path.join(app.getPath('userData'), 'mcp-bridge.js'); }
function writeBridge() {
  const src = fs.readFileSync(path.join(__dirname, 'mcp-bridge.js'), 'utf8')
    .replace('__CONFIG_PATH__', JSON.stringify(path.join(app.getPath('userData'), 'agent.json')));
  fs.writeFileSync(bridgePath(), src);
}
function mcpStdioEntry() {
  return { command: process.execPath, args: [bridgePath()], env: { ELECTRON_RUN_AS_NODE: '1' } };
}
ipcMain.handle('mcp-configs', () => {
  const c = agent.getConfig();
  return {
    stdio: { mcpServers: { 'mininet-browser': mcpStdioEntry() } },
    http: { url: c.mcpUrl, token: c.token },
    claudeCode: `claude mcp add --transport http mininet-browser ${c.mcpUrl} --header "Authorization: Bearer ${c.token}"`,
    curl: `curl -X POST ${c.url}/api/tools/snapshot -H "Authorization: Bearer ${c.token}"`
  };
});
ipcMain.handle('connect-claude-desktop', async () => {
  const dir = path.join(app.getPath('appData'), 'Claude');
  const file = path.join(dir, 'claude_desktop_config.json');
  let conf = {};
  try { conf = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
  if (fs.existsSync(file)) fs.copyFileSync(file, file + '.backup-before-mininet');
  conf.mcpServers = conf.mcpServers || {};
  conf.mcpServers['mininet-browser'] = mcpStdioEntry();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(conf, null, 2));
  return { file };
});

/* ---------------- Public connector link (Cloudflare quick tunnel) ---------------- */
const { spawn } = require('child_process');
const tunnel = { proc: null, url: null, status: 'off', error: null, progress: 0 };
function tunnelEmit() { win && win.webContents.send('tunnel', { status: tunnel.status, url: tunnel.url, error: tunnel.error, progress: tunnel.progress }); }
function cloudflaredPath() {
  const name = process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared';
  return path.join(app.getPath('userData'), 'bin', name);
}
async function ensureCloudflared() {
  const exe = cloudflaredPath();
  if (fs.existsSync(exe) && fs.statSync(exe).size > 1e6) return exe;
  const asset = process.platform === 'win32' ? 'cloudflared-windows-amd64.exe' : process.platform === 'darwin' ? 'cloudflared-darwin-amd64.tgz' : 'cloudflared-linux-amd64';
  if (asset.endsWith('.tgz')) throw new Error('On Mac, install cloudflared with "brew install cloudflared" first.');
  tunnel.status = 'downloading'; tunnel.progress = 0; tunnelEmit();
  const r = await fetch('https://github.com/cloudflare/cloudflared/releases/latest/download/' + asset);
  if (!r.ok) throw new Error('Could not download the tunnel tool (HTTP ' + r.status + ')');
  const total = +r.headers.get('content-length') || 0;
  fs.mkdirSync(path.dirname(exe), { recursive: true });
  const tmp = exe + '.part'; const out = fs.createWriteStream(tmp);
  let got = 0, last = 0;
  for await (const chunk of r.body) {
    out.write(chunk); got += chunk.length;
    if (total && Date.now() - last > 400) { tunnel.progress = Math.round(got / total * 100); tunnelEmit(); last = Date.now(); }
  }
  await new Promise(ok => out.end(ok));
  fs.renameSync(tmp, exe);
  if (process.platform !== 'win32') fs.chmodSync(exe, 0o755);
  return exe;
}
async function tunnelStart() {
  if (tunnel.proc) return;
  tunnel.error = null; tunnel.url = null;
  try {
    const exe = await ensureCloudflared();
    const port = agent.getConfig().port;
    tunnel.status = 'starting'; tunnelEmit();
    const p = spawn(exe, ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${port}`, '--http-host-header', `127.0.0.1:${port}`], { windowsHide: true });
    tunnel.proc = p;
    const onData = d => {
      const m = String(d).match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
      if (m && !tunnel.url) { tunnel.url = m[0]; tunnel.status = 'on'; tunnelEmit(); }
    };
    p.stdout.on('data', onData); p.stderr.on('data', onData);
    p.on('exit', code => { tunnel.proc = null; if (tunnel.status !== 'off') { tunnel.status = 'off'; tunnel.url = null; if (code) tunnel.error = 'The tunnel stopped (code ' + code + ').'; } tunnelEmit(); });
    setTimeout(() => { if (tunnel.proc && !tunnel.url) { tunnel.error = 'The tunnel is taking long to start — check your internet connection.'; tunnelEmit(); } }, 30000);
  } catch (e) { tunnel.status = 'off'; tunnel.error = e.message; tunnelEmit(); }
}
function tunnelPref(v) { const f = path.join(app.getPath('userData'), 'tunnel.json'); if (v === undefined) { try { return JSON.parse(fs.readFileSync(f, 'utf8')).on; } catch { return false; } } fs.writeFileSync(f, JSON.stringify({ on: !!v })); }
function tunnelStop() { tunnel.status = 'off'; tunnel.url = null; if (tunnel.proc) { tunnel.proc.kill(); tunnel.proc = null; } tunnelEmit(); }
ipcMain.handle('tunnel', async (e, op) => {
  if (op === 'start') { tunnelPref(true); tunnelStart(); }
  if (op === 'stop') { tunnelPref(false); tunnelStop(); }
  return { status: tunnel.status, url: tunnel.url, error: tunnel.error, progress: tunnel.progress };
});
app.on('before-quit', () => { const keep = tunnelPref(); tunnelStop(); tunnelPref(keep); });

/* ---------------- IPC: extensions ---------------- */
ipcMain.handle('ext', async (e, { op, id, enabled, data }) => {
  if (op === 'list') return ext.list();
  if (op === 'get') return ext.get(id);
  if (op === 'save') return ext.save(data);
  if (op === 'toggle') { ext.setEnabled(id, enabled); return true; }
  if (op === 'remove') { ext.remove(id); return true; }
  if (op === 'folder') { shell.openPath(ext.root()); return true; }
  if (op === 'import') {
    const r = await dialog.showOpenDialog(win, { title: 'Choose an extension folder (with manifest.json)', properties: ['openDirectory'] });
    if (r.canceled || !r.filePaths[0]) return null;
    return ext.importFolder(r.filePaths[0]);
  }
});

/* ---------------- IPC: Orbit (built-in AI) ---------------- */
function secretsFile() { return path.join(app.getPath('userData'), 'secrets.bin'); }
function readSecrets() {
  try {
    const buf = fs.readFileSync(secretsFile());
    const json = safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(buf) : buf.toString('utf8');
    return JSON.parse(json);
  } catch { return {}; }
}
function writeSecrets(s) {
  const json = JSON.stringify(s);
  fs.writeFileSync(secretsFile(), safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(json) : Buffer.from(json));
}
ipcMain.handle('secret-set', (e, { key, value }) => { const s = readSecrets(); if (value) s[key] = value; else delete s[key]; writeSecrets(s); return true; });
ipcMain.handle('secret-has', (e, key) => !!readSecrets()[key]);

// Orbit's requests to AI providers go from here (no browser CORS limits; keys never touch web pages)
ipcMain.handle('llm', async (e, { url, headers = {}, body, keyName, keyHeader = 'Authorization', keyPrefix = 'Bearer ' }) => {
  if (!/^https:\/\/|^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//i.test(url)) return { ok: false, error: 'Only https:// or local AI endpoints are allowed' };
  const key = keyName ? readSecrets()[keyName] : null;
  if (keyName && !key) return { ok: false, error: 'No API key saved for this provider yet. Add it in Orbit settings.' };
  try {
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers, ...(key ? { [keyHeader]: keyPrefix + key } : {}) }, body: JSON.stringify(body) });
    const t = await r.text();
    let j; try { j = JSON.parse(t); } catch { j = null; }
    if (!r.ok) return { ok: false, error: (j && (j.error && (j.error.message || j.error))) || t.slice(0, 400) || ('HTTP ' + r.status) };
    return { ok: true, data: j };
  } catch (err) { return { ok: false, error: err.message }; }
});
ipcMain.handle('transcribe', async (e, { url, model, keyName, audio, mime }) => {
  const key = readSecrets()[keyName];
  if (!key) return { ok: false, error: 'Voice needs an OpenAI or Groq key (Orbit settings → Voice).' };
  try {
    const fd = new FormData();
    fd.append('file', new Blob([Buffer.from(audio)], { type: mime || 'audio/webm' }), 'speech.webm');
    fd.append('model', model);
    const r = await fetch(url, { method: 'POST', headers: { Authorization: 'Bearer ' + key }, body: fd });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) return { ok: false, error: (j.error && j.error.message) || 'HTTP ' + r.status };
    return { ok: true, text: j.text || '' };
  } catch (err) { return { ok: false, error: err.message }; }
});

/* ---------------- start ---------------- */
app.whenReady().then(() => {
  setupSession();
  ext.init(app.getPath('userData'));
  try { writeBridge(); } catch (err) { console.error('bridge', err); }
  createWindow();
  agent.init({
    userData: app.getPath('userData'),
    shell: shellReq,
    onEvent: ev => win && win.webContents.send('agent-event', ev)
  });
  if (tunnelPref()) setTimeout(tunnelStart, 3000);   // reopen the connector link if it was on
});
app.on('window-all-closed', () => app.quit());
