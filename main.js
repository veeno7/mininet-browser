// MiniNet Browser — main process
const { app, BrowserWindow, session, ipcMain, Menu, shell, clipboard, dialog, safeStorage, webContents } = require('electron');
const path = require('path');
const os = require('os');
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
  if (argv.includes('--codex')) { openCodexWindow(); return; }   // the "MiniNet Codex" desktop icon
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
  // a plain Chrome user agent: some sites (WhatsApp Web, banks) refuse browsers whose name they don't know
  const plat = process.platform === 'win32' ? 'Windows NT 10.0; Win64; x64' : process.platform === 'darwin' ? 'Macintosh; Intel Mac OS X 10_15_7' : 'X11; Linux x86_64';
  const ua = `Mozilla/5.0 (${plat}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${process.versions.chrome} Safari/537.36`;
  ses.setUserAgent(ua);
  app.userAgentFallback = ua;
  // our own alert/confirm/prompt in every page frame (so pop-ups never freeze the page or an AI)
  const pre = path.join(__dirname, 'page-preload.js');
  try { if (ses.registerPreloadScript) ses.registerPreloadScript({ type: 'frame', id: 'mn-dialogs', filePath: pre }); else ses.setPreloads([pre]); } catch (e) { console.error('preload', e); }

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
  ses.setPermissionCheckHandler((wc, perm) => allow.includes(perm) || perm === 'clipboard-write' || perm === 'background-sync');
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

// windows must fit the screen (laptops with display scaling have a small work area, e.g. 1536×824)
function fitSize(w, h) { const wa = require('electron').screen.getPrimaryDisplay().workAreaSize; return { width: Math.min(w, wa.width - 20), height: Math.min(h, wa.height - 20) }; }
function createWindow() {
  const sz = fitSize(1300, 840);
  win = new BrowserWindow({
    width: sz.width, height: sz.height, center: true, minWidth: 460, minHeight: 420,
    backgroundColor: '#120d33', title: 'MiniNet Browser',
    icon: path.join(__dirname, 'icon.ico'),
    frame: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), webviewTag: true, contextIsolation: true, nodeIntegration: false }
  });
  Menu.setApplicationMenu(null);
  // right-click menu in the browser's own boxes (address bar, settings, AI control): cut / copy / paste
  win.webContents.on('context-menu', (ev, p) => {
    const t = [];
    if (p.isEditable) t.push({ label: 'Cut', role: 'cut', enabled: p.editFlags.canCut }, { label: 'Copy', role: 'copy', enabled: p.editFlags.canCopy }, { label: 'Paste', role: 'paste' }, { type: 'separator' }, { label: 'Select all', role: 'selectAll' });
    else if (p.selectionText) t.push({ label: 'Copy', role: 'copy' });
    if (t.length) Menu.buildFromTemplate(t).popup({ window: win });
  });
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

/* ---------------- sign-in pop-up windows (AIs can see and click them as tabs 1001, 1002 …) ---------------- */
const popups = new Map(); let popupSeq = 1000;
function registerPopup(pw) {
  const id = ++popupSeq; popups.set(id, pw);
  try { pw.setMenu(null); } catch {}
  pw.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  pw.on('closed', () => popups.delete(id));
  win && win.webContents.send('agent-event', { type: 'popup', id });
}
function popupList() { return [...popups.entries()].filter(([, w]) => !w.isDestroyed()).map(([id, w]) => ({ id, wcId: w.webContents.id, url: w.webContents.getURL(), title: w.webContents.getTitle() || 'Sign-in window', active: false, loading: w.webContents.isLoading(), popup: true })); }

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

  wc.setWindowOpenHandler(({ url, disposition, features }) => {
    // Sign-in pop-ups ("Continue with Google / Facebook / Apple") must stay real pop-up windows so the site gets the answer back
    const signIn = /^about:blank|^https:\/\/(accounts\.google\.com|www\.facebook\.com\/(v\d+\.\d+\/)?dialog|appleid\.apple\.com|login\.microsoftonline\.com|login\.live\.com|github\.com\/login|api\.twitter\.com|x\.com\/i\/oauth|www\.tiktok\.com\/(auth|login)|discord\.com\/oauth2)/i.test(url || '');
    if (disposition === 'new-window' || signIn || /width|height|popup/i.test(features || '')) {
      return { action: 'allow', overrideBrowserWindowOptions: { width: 520, height: 680, parent: win || undefined, autoHideMenuBar: true, backgroundColor: '#ffffff', title: 'Sign in', webPreferences: { partition: PARTITION, contextIsolation: true, sandbox: true } } };
    }
    if (win) win.webContents.send('open-tab', url);
    return { action: 'deny' };
  });
  wc.on('did-create-window', (pw) => registerPopup(pw));

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

/* ---------------- page pop-ups (alert / confirm / prompt) ---------------- */
let dialogSeq = 0; const dialogWait = new Map();
ipcMain.on('mn-dialog', async (e, d) => {
  const reply = v => { try { e.returnValue = v; } catch {} };
  try {
    const ai = await agent.pageDialog(e.sender.id, d);
    if (ai !== undefined) return reply(ai.value);
    if (!win || win.isDestroyed()) return reply(d.type === 'confirm' ? false : d.type === 'prompt' ? null : undefined);
    const id = ++dialogSeq;
    const v = await new Promise(ok => { dialogWait.set(id, ok); win.webContents.send('page-dialog', { id, ...d }); });
    reply(v);
  } catch { reply(d.type === 'confirm' ? false : d.type === 'prompt' ? null : undefined); }
});
ipcMain.on('page-dialog-answer', (e, { id, value }) => { const f = dialogWait.get(id); if (f) { dialogWait.delete(id); f(value); } });

/* ---------------- IPC: AI control ---------------- */
ipcMain.handle('agent-tools', () => agent.toolList());
ipcMain.handle('agent-call', async (e, { name, args, client, owner }) => {
  try { return { ok: true, result: await agent.call(name, args, client || 'Orbit', owner) }; }
  catch (err) { return { ok: false, error: err.message }; }
});
ipcMain.handle('agent-config', (e, c) => c ? agent.setConfig(c) : agent.getConfig());
ipcMain.handle('agent-log', () => agent.getLog());
ipcMain.on('agent-pause', (e, p) => agent.setPaused(p));
ipcMain.handle('agent-instructions', () => agent.INSTRUCTIONS);
ipcMain.handle('agent-release', (e, key) => agent.release(key));

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

/* ---------------- Public connector link (ngrok permanent link, or Cloudflare quick link) ---------------- */
const { spawn, execFile } = require('child_process');
const tunnel = { proc: null, url: null, status: 'off', error: null, progress: 0 };
function tunnelFile() { return path.join(app.getPath('userData'), 'tunnel.json'); }
function tunnelConf(patch) {
  let c = { on: false, provider: 'ngrok', domain: '' };
  try { c = Object.assign(c, JSON.parse(fs.readFileSync(tunnelFile(), 'utf8'))); } catch {}
  if (patch) { c = Object.assign(c, patch); fs.writeFileSync(tunnelFile(), JSON.stringify(c)); }
  return c;
}
function tunnelLog(line) { try { const f = path.join(app.getPath('userData'), 'tunnel.log'); fs.appendFileSync(f, new Date().toISOString() + ' ' + String(line).slice(0, 500) + '\n'); if (fs.statSync(f).size > 200000) fs.writeFileSync(f, ''); } catch {} }
// The ngrok key also lives in its own encrypted file, so the permanent link survives even if the main key store has a problem
function ngrokKeyFile() { return path.join(app.getPath('userData'), 'link-key.bin'); }
function getNgrokKey() {
  const k = readSecrets().ngrok; if (k) { if (!fs.existsSync(ngrokKeyFile())) try { setNgrokKey(k); } catch {} return k; }
  try { const b = fs.readFileSync(ngrokKeyFile()); const v = safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(b) : b.toString('utf8'); if (v) { try { const s = readSecrets(true); s.ngrok = v; writeSecrets(s); } catch {} return v; } } catch {}
  return null;
}
function setNgrokKey(v) {
  if (v) fs.writeFileSync(ngrokKeyFile(), safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(v) : Buffer.from(v));
  else { try { fs.unlinkSync(ngrokKeyFile()); } catch {} }
}
function tunnelState() { const c = tunnelConf(); return { status: tunnel.status, url: tunnel.url, error: tunnel.error, progress: tunnel.progress, provider: c.provider, domain: c.domain, hasNgrokKey: !!getNgrokKey() }; }
function tunnelEmit() { agent.setPublicUrl(tunnel.status === 'on' ? tunnel.url : null); win && !win.isDestroyed() && win.webContents.send('tunnel', tunnelState()); }
function binPath(name) { return path.join(app.getPath('userData'), 'bin', process.platform === 'win32' ? name + '.exe' : name); }
async function downloadTo(url, file) {
  tunnel.status = 'downloading'; tunnel.progress = 0; tunnelEmit();
  const r = await fetch(url);
  if (!r.ok) throw new Error('Could not download the tunnel tool (HTTP ' + r.status + ')');
  const total = +r.headers.get('content-length') || 0;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.part'; const out = fs.createWriteStream(tmp);
  let got = 0, last = 0;
  for await (const chunk of r.body) {
    out.write(chunk); got += chunk.length;
    if (total && Date.now() - last > 400) { tunnel.progress = Math.round(got / total * 100); tunnelEmit(); last = Date.now(); }
  }
  await new Promise(ok => out.end(ok));
  fs.renameSync(tmp, file);
}
async function ensureCloudflared() {
  const exe = binPath('cloudflared');
  if (fs.existsSync(exe) && fs.statSync(exe).size > 1e6) return exe;
  const asset = process.platform === 'win32' ? 'cloudflared-windows-amd64.exe' : process.platform === 'darwin' ? null : 'cloudflared-linux-amd64';
  if (!asset) throw new Error('On Mac, install cloudflared with "brew install cloudflared" first.');
  await downloadTo('https://github.com/cloudflare/cloudflared/releases/latest/download/' + asset, exe);
  if (process.platform !== 'win32') fs.chmodSync(exe, 0o755);
  return exe;
}
async function ensureNgrok() {
  const exe = binPath('ngrok');
  if (fs.existsSync(exe) && fs.statSync(exe).size > 1e6) return exe;
  const plat = process.platform === 'win32' ? 'windows-amd64.zip' : process.platform === 'darwin' ? 'darwin-arm64.zip' : 'linux-amd64.tgz';
  const arch = path.join(path.dirname(exe), 'ngrok-dl.' + (plat.endsWith('zip') ? 'zip' : 'tgz'));
  await downloadTo('https://bin.equinox.io/c/bNyj1mQVY4c/ngrok-v3-stable-' + plat, arch);
  tunnel.status = 'starting'; tunnelEmit();
  await new Promise((ok, bad) => {
    const done = err => err ? bad(new Error('Could not unpack ngrok: ' + err.message)) : ok();
    if (process.platform === 'win32') execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `Expand-Archive -Force -LiteralPath '${arch}' -DestinationPath '${path.dirname(exe)}'`], { windowsHide: true }, done);
    else if (arch.endsWith('.zip')) execFile('unzip', ['-o', arch, '-d', path.dirname(exe)], done);
    else execFile('tar', ['-xzf', arch, '-C', path.dirname(exe)], done);
  });
  try { fs.unlinkSync(arch); } catch {}
  if (!fs.existsSync(exe)) throw new Error('ngrok did not unpack correctly.');
  if (process.platform !== 'win32') fs.chmodSync(exe, 0o755);
  return exe;
}
function cleanDomain(d) { return String(d || '').trim().replace(/^https?:\/\//i, '').replace(/\/.*$/, '').toLowerCase(); }
async function tunnelStart() {
  if (tunnel.proc) return;
  tunnel.error = null; tunnel.url = null;
  const conf = tunnelConf();
  const port = agent.getConfig().port;
  try {
    let p;
    if (conf.provider === 'ngrok') {
      const key = getNgrokKey();
      if (!key) throw new Error('Paste your free ngrok authtoken first.');
      const dom = cleanDomain(conf.domain);
      // a link that is still running from before (MiniNet restarted): keep using it, no gap for connected AIs
      const live = await ngrokApi();
      if (live && live.url && (!dom || live.url.includes(dom)) && live.port === String(port)) { tunnelAdopt(live.url, 'reused running link'); return; }
      if (live) await ngrokKill();
      const exe = await ensureNgrok();
      tunnel.status = 'starting'; tunnelEmit();
      const logf = path.join(app.getPath('userData'), 'ngrok.log'); try { fs.writeFileSync(logf, ''); } catch {}
      // ngrok's local status page (used to check the link and to find it again after a restart) is set in a config file
      const cfgf = path.join(app.getPath('userData'), 'ngrok-mininet.yml');
      fs.writeFileSync(cfgf, `version: "3"\nagent:\n  web_addr: 127.0.0.1:${NGROK_API_PORT}\n`);
      const args = ['http', `127.0.0.1:${port}`, '--host-header=rewrite', `--config=${cfgf}`, `--log=${logf}`, '--log-format=json', '--pooling-enabled'];
      if (dom) args.push('--url=https://' + dom);
      // detached: the link keeps running while MiniNet restarts (updates), so AI connectors don't drop
      const p = spawn(exe, args, { windowsHide: true, detached: true, stdio: 'ignore', env: Object.assign({}, process.env, { NGROK_AUTHTOKEN: key }) });
      p.unref();
      try { fs.writeFileSync(path.join(app.getPath('userData'), 'ngrok.pid'), String(p.pid)); } catch {}
      tunnel.proc = { pid: p.pid, detached: true }; tunnel.started = Date.now();
      p.on('error', err => { tunnel.error = err.message; tunnelEmit(); });
      tunnelWatch();
      return;
    } else {
      const exe = await ensureCloudflared();
      tunnel.status = 'starting'; tunnelEmit();
      p = spawn(exe, ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${port}`, '--http-host-header', `127.0.0.1:${port}`], { windowsHide: true });
      const onData = d => {
        const m = String(d).match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
        if (m && !tunnel.url) { tunnel.url = m[0]; tunnel.status = 'on'; tunnelEmit(); }
      };
      p.stdout.on('data', onData); p.stderr.on('data', onData);
    }
    tunnel.proc = p;
    p.on('error', err => { tunnel.error = err.message; });
    p.on('exit', code => {
      if (tunnel.proc !== p) return;
      tunnel.proc = null;
      if (tunnel.status !== 'off') {
        tunnel.status = 'off'; tunnel.url = null;
        if (code && !tunnel.error) tunnel.error = 'The link stopped (code ' + code + ').';
        tunnelLog('exit code ' + code + (tunnel.error ? ' — ' + tunnel.error : ''));
        // keep the permanent link alive: retry with a growing pause (5s, 15s, 30s, then every 60s)
        if (tunnelConf().on && !tunnel.retryT) { const n = (tunnel.tries = (tunnel.tries || 0) + 1); const wait = [5, 15, 30][n - 1] || 60; tunnel.retryT = setTimeout(() => { tunnel.retryT = null; if (tunnelConf().on && !tunnel.proc) tunnelStart(); }, wait * 1000); }
      }
      tunnelEmit();
    });
    setTimeout(() => { if (tunnel.proc === p && !tunnel.url && !tunnel.error) { tunnel.error = 'The link is taking long to start — check your internet connection.'; tunnelEmit(); } }, 30000);
  } catch (e) { tunnel.status = 'off'; tunnel.error = e.message; tunnelLog('start failed: ' + e.message); tunnelEmit(); }
}
function tunnelStop() { clearTimeout(tunnel.retryT); tunnel.retryT = null; clearInterval(tunnel.watchT); tunnel.status = 'off'; tunnel.url = null; const p = tunnel.proc; tunnel.proc = null; if (p && p.detached) ngrokKill(); else if (p) p.kill(); tunnelEmit(); }
/* ngrok runs as its own process; MiniNet checks it through ngrok's local status page */
const NGROK_API_PORT = 4041;
function ngrokApi() {
  return new Promise(res => {
    const req = require('http').get({ host: '127.0.0.1', port: NGROK_API_PORT, path: '/api/tunnels', timeout: 3000 }, r => {
      let b = ''; r.on('data', d => b += d); r.on('end', () => { try { const t = (JSON.parse(b).tunnels || []).find(x => /^https:/.test(x.public_url)); res({ url: t ? t.public_url.replace(/\/$/, '') : null, port: t ? String((t.config && t.config.addr || '').split(':').pop()) : null }); } catch { res({ url: null }); } });
    });
    req.on('error', () => res(null)); req.on('timeout', () => { req.destroy(); res(null); });
  });
}
async function ngrokKill() {
  let pid = null; try { pid = +fs.readFileSync(path.join(app.getPath('userData'), 'ngrok.pid'), 'utf8'); } catch {}
  if (pid) { try { process.kill(pid); } catch {} }
  if (process.platform === 'win32') await new Promise(r => execFile('taskkill', ['/F', '/IM', 'ngrok.exe'], () => r()));
  await new Promise(r => setTimeout(r, 800));
}
function tunnelAdopt(url, how) {
  tunnel.proc = tunnel.proc || { detached: true }; tunnel.url = url; tunnel.status = 'on'; tunnel.error = null; tunnel.tries = 0;
  tunnelLog('online ' + url + (how ? ' (' + how + ')' : ''));
  if (!cleanDomain(tunnelConf().domain)) tunnelConf({ domain: cleanDomain(url) });
  tunnelEmit(); tunnelWatch();
}
function ngrokLogError() {
  try { const lines = fs.readFileSync(path.join(app.getPath('userData'), 'ngrok.log'), 'utf8').trim().split('\n').slice(-30).reverse(); for (const l of lines) { try { const j = JSON.parse(l); if (j.lvl === 'eror' || j.lvl === 'crit') return String(j.err || j.msg).replace(/\s+/g, ' ').slice(0, 300); } catch {} } } catch {}
  return null;
}
// health check every 10 s: notices when the link comes up, goes down or ngrok stops, and restarts it
function tunnelWatch() {
  clearInterval(tunnel.watchT); let misses = 0;
  tunnel.watchT = setInterval(async () => {
    if (!tunnelConf().on || tunnelConf().provider !== 'ngrok') return;
    const a = await ngrokApi();
    if (a && a.url) { misses = 0; if (tunnel.status !== 'on' || tunnel.url !== a.url) tunnelAdopt(a.url); return; }
    const err = ngrokLogError(); if (err && err !== tunnel.error) { tunnel.error = err; tunnelEmit(); }
    if (!a) misses++;
    if (misses >= 3 || (tunnel.started && Date.now() - tunnel.started > 45000 && tunnel.status !== 'on' && !a)) {
      clearInterval(tunnel.watchT); tunnelLog('link down — restarting' + (err ? ': ' + err : ''));
      tunnel.proc = null; tunnel.status = 'off'; tunnel.url = null; tunnelEmit();
      const n = (tunnel.tries = (tunnel.tries || 0) + 1); const wait = [5, 15, 30][n - 1] || 60;
      tunnel.retryT = setTimeout(() => { tunnel.retryT = null; if (tunnelConf().on && !tunnel.proc) tunnelStart(); }, wait * 1000);
    }
  }, 10000);
}
ipcMain.handle('tunnel', async (e, op, opts = {}) => {
  if (op === 'start') { tunnelConf({ on: true }); tunnelStart(); }
  if (op === 'stop') { tunnelConf({ on: false }); tunnelStop(); }
  if (op === 'setup') {
    const patch = {};
    if (opts.provider === 'ngrok' || opts.provider === 'cloudflare') patch.provider = opts.provider;
    if (opts.domain !== undefined) patch.domain = cleanDomain(opts.domain);
    if (opts.ngrokKey !== undefined) { const v = opts.ngrokKey ? String(opts.ngrokKey).trim() : ''; setNgrokKey(v); const s = readSecrets(true); if (v) s.ngrok = v; else delete s.ngrok; writeSecrets(s); }
    const was = tunnelConf(); tunnelConf(patch);
    if (tunnel.proc && (patch.provider && patch.provider !== was.provider || patch.domain !== undefined || opts.ngrokKey)) { tunnelStop(); tunnelConf({ on: true }); tunnelStart(); }
  }
  return tunnelState();
});
app.on('before-quit', () => { const p = tunnel.proc; if (p && !p.detached) { tunnel.proc = null; p.kill(); } });   // a detached ngrok link keeps running for the next start

/* ---------------- IPC: missions ---------------- */
ipcMain.handle('missions', (e, { op, id }) => {
  if (op === 'list') return agent.listMissions();
  if (op === 'get') { const m = agent.getMission(id); return m && { ...m, dir: require('url').pathToFileURL(agent.missionsDir()).href }; }
  if (op === 'delete') return agent.deleteMission(id);
  if (op === 'folder') { shell.openPath(agent.missionsDir()); return true; }
});

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
function readSecrets(strict) {
  let buf; try { buf = fs.readFileSync(secretsFile()); } catch { return {}; }   // no file yet
  try {
    const json = safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(buf) : buf.toString('utf8');
    return JSON.parse(json);
  } catch (e) {
    // never overwrite saved keys because of a failed read — keep a backup and refuse to write
    try { fs.copyFileSync(secretsFile(), secretsFile() + '.bak'); } catch {}
    if (strict) throw new Error('Could not read your saved keys (' + e.message + '). Nothing was changed.');
    return {};
  }
}
function writeSecrets(s) {
  const json = JSON.stringify(s);
  fs.writeFileSync(secretsFile(), safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(json) : Buffer.from(json));
}
ipcMain.handle('secret-set', (e, { key, value }) => { const s = readSecrets(true); if (value) s[key] = value; else delete s[key]; writeSecrets(s); return true; });
ipcMain.handle('secret-has', (e, key) => !!readSecrets()[key]);
/* other Gmails, read with Google app passwords (stored encrypted with the other secrets) */
const mail = require('./mail');
// app passwords live in their OWN encrypted file, so a problem with the main key store can never block them
function mailKeysFile() { return path.join(app.getPath('userData'), 'mail-keys.bin'); }
function readMailKeys() { try { const b = fs.readFileSync(mailKeysFile()); return JSON.parse(safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(b) : b.toString('utf8')); } catch { return {}; } }
function writeMailKeys(o) { const j = JSON.stringify(o); fs.writeFileSync(mailKeysFile(), safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(j) : Buffer.from(j)); }
function initMail() { mail.init({ userData: app.getPath('userData'), getPass: em => readMailKeys()[em] || null, setPass: (em, v) => { const s = readMailKeys(); if (v) s[em] = v; else delete s[em]; writeMailKeys(s); } }); }
ipcMain.handle('mail', async (e, op, a = {}) => {
  if (op === 'list') return mail.accounts();
  if (op === 'add') { try { const r = await mail.add(a.email, a.pass); agent.biz.audit('owner', 'mail', 'Connected ' + r.email + ' with an app password'); return { ok: true, ...r }; } catch (err) { agent.biz.audit('owner', 'mail-error', 'Connecting ' + String(a.email || '') + ' failed: ' + err.message); return { ok: false, error: err.message }; } }
  if (op === 'remove') return mail.remove(a.email);
  return null;
});

// Orbit's requests to AI providers go from here (no browser CORS limits; keys never touch web pages)
function localHttp(url, opts, limit) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = require('http').request({ hostname: u.hostname, port: u.port || 80, path: u.pathname + u.search, method: opts.method, headers: opts.headers, timeout: limit }, res => {
      const chunks = []; res.on('data', c => chunks.push(c));
      res.on('end', () => { const body = Buffer.concat(chunks).toString('utf8'); resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, text: async () => body }); });
    });
    req.on('timeout', () => req.destroy(new Error('timed out after ' + Math.round(limit / 60000) + ' min')));
    req.on('error', reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}
ipcMain.handle('llm', async (e, { url, method = 'POST', headers = {}, body, keyName, keyHeader = 'Authorization', keyPrefix = 'Bearer ', timeoutMs = 180000 }) => {
  if (!/^https:\/\/|^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//i.test(url)) return { ok: false, error: 'Only https:// or local AI endpoints are allowed' };
  const key = keyName ? readSecrets()[keyName] : null;
  if (keyName && !key) return { ok: false, error: 'No API key saved for this provider yet. Add it in Orbit settings.' };
  try {
    const opts = { method: method === 'GET' ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json', ...headers, ...(key ? { [keyHeader]: keyPrefix + key } : {}) }, body: method === 'GET' ? undefined : JSON.stringify(body) };
    const limit = Math.min(+timeoutMs || 180000, 900000);
    // local AI (Ollama / LM Studio) can think for many minutes on a laptop; Node's fetch gives up after 5 min with
    // "fetch failed", so talk to it with plain http and only our own time limit
    const r = /^http:\/\//i.test(url) ? await localHttp(url, opts, limit) : await fetch(url, { ...opts, signal: AbortSignal.timeout(limit) });
    const t = await r.text();
    let j; try { j = JSON.parse(t); } catch { j = null; }
    if (!r.ok) { const m = (j && (j.error && (j.error.message || j.error))) || t.slice(0, 400); return { ok: false, status: r.status, error: 'HTTP ' + r.status + (m ? ': ' + (typeof m === 'string' ? m : JSON.stringify(m)).slice(0, 400) : '') }; }
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

/* ---------------- accounts: stay signed in, see which sites you're signed in to ---------------- */
const SITES = [
  { id: 'google', name: 'Google (Gmail, YouTube, Drive…)', url: 'https://accounts.google.com/', login: 'https://accounts.google.com/ServiceLogin', domain: '.google.com', cookies: ['SID', '__Secure-1PSID'] },
  { id: 'gmail', name: 'Gmail', url: 'https://mail.google.com/', login: 'https://accounts.google.com/ServiceLogin?service=mail&continue=https://mail.google.com/', domain: '.google.com', cookies: ['SID', '__Secure-1PSID'] },
  { id: 'youtube', name: 'YouTube', url: 'https://www.youtube.com/', login: 'https://www.youtube.com/signin', domain: '.youtube.com', cookies: ['LOGIN_INFO', 'SID'] },
  { id: 'capcut', name: 'CapCut', url: 'https://www.capcut.com/my-edit', login: 'https://www.capcut.com/login', domain: '.capcut.com', cookies: ['sessionid', 'sid_tt', 'sessionid_ss'] },
  { id: 'github', name: 'GitHub', url: 'https://github.com/', login: 'https://github.com/login', domain: 'github.com', cookies: ['logged_in=yes', 'user_session'] },
  { id: 'instagram', name: 'Instagram', url: 'https://www.instagram.com/', login: 'https://www.instagram.com/accounts/login/', domain: '.instagram.com', cookies: ['sessionid'] },
  { id: 'facebook', name: 'Facebook', url: 'https://www.facebook.com/', login: 'https://www.facebook.com/login', domain: '.facebook.com', cookies: ['c_user'] },
  { id: 'tiktok', name: 'TikTok', url: 'https://www.tiktok.com/', login: 'https://www.tiktok.com/login', domain: '.tiktok.com', cookies: ['sessionid', 'sid_tt'] },
  { id: 'x', name: 'X (Twitter)', url: 'https://x.com/home', login: 'https://x.com/i/flow/login', domain: '.x.com', cookies: ['auth_token'] },
  { id: 'linkedin', name: 'LinkedIn', url: 'https://www.linkedin.com/feed/', login: 'https://www.linkedin.com/login', domain: '.linkedin.com', cookies: ['li_at'] },
  { id: 'flow', name: 'Google Flow (AI video & images)', url: 'https://flow.google.com/', login: 'https://flow.google.com/', domain: '.google.com', cookies: ['SID', '__Secure-1PSID'] },
  { id: 'whatsapp', name: 'WhatsApp Web', url: 'https://web.whatsapp.com/', login: 'https://web.whatsapp.com/', domain: 'web.whatsapp.com', cookies: [], storage: true }
];
async function accountsStatus() {
  const ses = session.fromPartition(PARTITION);
  const out = [];
  for (const s of SITES) {
    let signedIn = false;
    if (s.storage) {
      // WhatsApp keeps its login in site storage, not cookies
      try { signedIn = fs.existsSync(path.join(app.getPath('userData'), 'Partitions', 'main', 'IndexedDB', 'https_web.whatsapp.com_0.indexeddb.leveldb')); } catch {}
    } else {
      const list = await ses.cookies.get({ domain: s.domain.replace(/^\./, '') }).catch(() => []);
      signedIn = s.cookies.some(c => { const [n, v] = c.split('='); return list.some(k => k.name === n && (!v || k.value === v) && k.value); });
    }
    out.push({ id: s.id, name: s.name, url: s.url, login: s.login, signedIn });
  }
  let google = [];
  if (out[0].signedIn) {
    try {
      const r = await ses.fetch('https://accounts.google.com/ListAccounts?gpsia=1&source=ChromiumBrowser&json=standard', { method: 'POST' });
      const t = await r.text(); const j = JSON.parse(t.replace(/^\)\]\}'/, ''));
      // keep each account's position: it is the number Google sites use (/u/0, /u/1 … or ?authuser=)
      google = (j[1] || []).map((a, i) => ({ name: a[2] || '', email: a[3] || '', index: typeof a[7] === 'number' ? a[7] : i, signedOut: !!a[14] })).filter(a => a.email && !a.signedOut);
    } catch {}
  }
  return { sites: out, google };
}
ipcMain.handle('accounts', () => accountsStatus());
/* ---------------- free voice input: Whisper running on this computer (whisper.cpp), no API key ---------------- */
const VOICE = { dir: () => path.join(app.getPath('userData'), 'whisper'), busy: null };
const WHISPER_ZIP = 'https://github.com/ggml-org/whisper.cpp/releases/download/v1.9.2/whisper-bin-x64.zip';
const WHISPER_MODELS = { base: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin', small: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin' };
function findFile(dir, name) { try { for (const f of fs.readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir, f.name); if (f.isDirectory()) { const r = findFile(p, name); if (r) return r; } else if (f.name.toLowerCase() === name) return p; } } catch {} return null; }
function voiceCli() { return findFile(path.join(VOICE.dir(), 'bin'), 'whisper-cli.exe') || findFile(path.join(VOICE.dir(), 'bin'), 'main.exe'); }
function voiceModel() { for (const m of ['small', 'base']) { const f = path.join(VOICE.dir(), `ggml-${m}.bin`); if (fs.existsSync(f) && fs.statSync(f).size > 5e7) return f; } return null; }
function voiceEmit(x) { win && !win.isDestroyed() && win.webContents.send('voice-progress', x); }
async function fetchTo(url, file, label) {
  const r = await fetch(url); if (!r.ok) throw new Error(label + ': download failed (HTTP ' + r.status + ')');
  const total = +r.headers.get('content-length') || 0; const tmp = file + '.part'; const out = fs.createWriteStream(tmp); let got = 0, last = 0;
  for await (const c of r.body) { out.write(c); got += c.length; if (Date.now() - last > 500) { voiceEmit({ label, pct: total ? Math.round(got / total * 100) : 0 }); last = Date.now(); } }
  await new Promise(ok => out.end(ok)); fs.renameSync(tmp, file);
}
async function voiceInstall(model = 'base') {
  if (VOICE.busy) return VOICE.busy;
  VOICE.busy = (async () => {
    const d = VOICE.dir(); fs.mkdirSync(d, { recursive: true });
    if (!voiceCli()) {
      const zip = path.join(d, 'whisper.zip'); await fetchTo(WHISPER_ZIP, zip, 'Voice engine');
      const bin = path.join(d, 'bin'); fs.mkdirSync(bin, { recursive: true });
      await new Promise((ok, bad) => execFile('tar', ['-xf', zip, '-C', bin], err => err ? bad(new Error('Could not unpack the voice engine: ' + err.message)) : ok()));
      try { fs.unlinkSync(zip); } catch {}
      if (!voiceCli()) throw new Error('The voice engine did not unpack correctly.');
    }
    const mf = path.join(d, `ggml-${model}.bin`);
    if (!fs.existsSync(mf)) await fetchTo(WHISPER_MODELS[model] || WHISPER_MODELS.base, mf, 'Voice model');
    voiceEmit({ label: 'ready', pct: 100 });
    return { ok: true };
  })().finally(() => { VOICE.busy = null; });
  return VOICE.busy;
}
ipcMain.handle('voice', async (e, op, a = {}) => {
  if (op === 'status') return { installed: !!(voiceCli() && voiceModel()), model: voiceModel() ? path.basename(voiceModel()) : null, installing: !!VOICE.busy };
  if (op === 'install') { try { return await voiceInstall(a.model); } catch (err) { return { ok: false, error: err.message }; } }
  if (op === 'transcribe') {
    if (!voiceCli() || !voiceModel()) { const r = await voiceInstall().catch(err => ({ ok: false, error: err.message })); if (r && r.ok === false) return r; }
    const wav = path.join(os.tmpdir(), 'mininet-voice-' + Date.now() + '.wav');
    fs.writeFileSync(wav, Buffer.from(a.wav));
    const threads = String(Math.max(2, Math.min(8, os.cpus().length)));
    const args = ['-m', voiceModel(), '-f', wav, '-l', a.lang || 'auto', '-nt', '-np', '-t', threads, '-bs', '1', '-bo', '1', ...(a.translate ? ['-tr'] : [])];
    const runWith = cli => new Promise(res => execFile(cli, args, { windowsHide: true, timeout: 180000, maxBuffer: 4e6, cwd: path.dirname(cli) }, (err, stdout, stderr) => res({ err, stdout, stderr })));
    const r = await runWith(voiceCli());
    try { fs.unlinkSync(wav); } catch {}
    if (r.err) return { ok: false, error: 'Voice engine error: ' + (String(r.stderr || r.err.message).split('\n').filter(Boolean).slice(-2).join(' ')).slice(0, 300) };
    return { ok: true, text: String(r.stdout).replace(/\[[^\]]*\]/g, ' ').replace(/\s+/g, ' ').trim() };
  }
  return null;
});
/* ---------------- Codex chat (OpenAI Codex CLI on this laptop, driving MiniNet through its MCP tools) ---------------- */
const codexRun = { proc: null, thread: null };
function codexDir() { const d = path.join(app.getPath('home'), 'MiniNetCodex'); fs.mkdirSync(d, { recursive: true }); return d; }
function codexExe() {
  const cands = [path.join(process.env.LOCALAPPDATA || '', 'Programs', 'OpenAI', 'Codex', 'bin', 'codex.exe'), 'codex'];
  return cands.find(c => c === 'codex' || fs.existsSync(c));
}
function codexSend(ev) { for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send('codex-event', ev); }
let codexWin = null;
function openCodexWindow() {
  if (codexWin && !codexWin.isDestroyed()) { if (codexWin.isMinimized()) codexWin.restore(); codexWin.show(); codexWin.focus(); return; }
  const csz = fitSize(720, 780);
  codexWin = new BrowserWindow({ width: csz.width, height: csz.height, center: true, minWidth: 420, minHeight: 420, title: 'MiniNet Codex', backgroundColor: '#120d33', frame: false, icon: path.join(__dirname, 'icon.ico'),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false } });
  codexWin.loadFile('codex.html');
  codexWin.on('closed', () => { codexWin = null; });
}
// a desktop icon that opens the Codex chat window straight away (made once)
function makeCodexShortcut() {
  if (process.platform !== 'win32' || !app.isPackaged) return;
  try {
    const flag = path.join(app.getPath('userData'), '.codex-shortcut-v1'); if (fs.existsSync(flag)) return;
    const lnk = path.join(app.getPath('desktop'), 'MiniNet Codex.lnk');
    shell.writeShortcutLink(lnk, 'create', { target: process.execPath, args: '--codex', icon: process.execPath, iconIndex: 0, description: 'Chat with Codex — it works in MiniNet Browser' });
    fs.writeFileSync(flag, String(Date.now()));
  } catch (err) { console.error('shortcut', err); }
}
const LIMIT_RE = /usage limit|rate limit|quota|limit reached|exceeded your|too many requests|try again (in|at|after)|upgrade to (pro|plus)/i;
// when Codex hits its limit, MiniNet's own AI (Orbit, e.g. the free local model) carries on with the same job
async function codexFallback(text) {
  try {
    const r = await shellReq('helper', { op: 'start', task: 'The owner asked Codex this, but Codex reached its usage limit, so you take over and do it fully: ' + text + '\nWhen finished, reply with a short report.', by: 'Codex (limit reached)' }, 60000);
    const name = r && r.started; if (!name) throw new Error('helper did not start');
    for (let i = 0; i < 180; i++) {
      await new Promise(z => setTimeout(z, 5000));
      const list = await shellReq('helper', { op: 'list' }, 30000).catch(() => []);
      const h = (list || []).find(x => x.name === name);
      if (h && h.status !== 'running') { codexSend({ type: 'fallback-report', text: h.report || h.error || h.status }); return; }
    }
    codexSend({ type: 'fallback-report', text: 'Orbit is still working on it — check the Orbit panel in MiniNet.' });
  } catch (err) { codexSend({ type: 'error', message: 'Could not hand the job to Orbit: ' + err.message }); }
}
ipcMain.handle('codex', async (e, op, a = {}) => {
  if (op === 'status') { try { codexRun.thread = codexRun.thread || fs.readFileSync(path.join(codexDir(), '.mininet-thread'), 'utf8').trim() || null; } catch {} return { running: !!codexRun.proc, thread: codexRun.thread, exe: codexExe(), dir: codexDir() }; }
  if (op === 'new') { codexRun.thread = null; try { fs.unlinkSync(path.join(codexDir(), '.mininet-thread')); } catch {} return true; }
  if (op === 'stop') { const p = codexRun.proc; if (p) { if (process.platform === 'win32') execFile('taskkill', ['/T', '/F', '/PID', String(p.pid)], () => {}); else p.kill(); } return true; }
  if (op === 'open-window') { openCodexWindow(); return true; }
  if (op === 'show-browser') { if (win) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); } return true; }
  if (op === 'win') { const w = BrowserWindow.fromWebContents(e.sender); if (w) { if (a.op === 'min') w.minimize(); if (a.op === 'close') w.close(); } return true; }
  if (op === 'fallback') { codexFallback(String(a.text || '')); return true; }
  if (op !== 'send') return null;
  if (codexRun.proc) throw new Error('Codex is still working — wait or press Stop.');
  const prompt = String(a.text || '').trim(); if (!prompt) return false;
  const common = ['--json', '--skip-git-repo-check', '-c', 'sandbox_mode="workspace-write"', ...(a.model && /^[\w.\-]+$/.test(a.model) ? ['-m', String(a.model)] : []), ...(/^(low|medium|high|xhigh)$/.test(a.effort || '') ? ['-c', `model_reasoning_effort="${a.effort}"`] : [])];
  let hitLimit = false;
  const args = codexRun.thread ? ['exec', 'resume', codexRun.thread, ...common, '-'] : ['exec', ...common, '-C', codexDir(), '-'];
  const p = spawn(codexExe(), args, { cwd: codexDir(), windowsHide: true, env: process.env });
  codexRun.proc = p; codexSend({ type: 'start' });
  p.stdin.end(prompt);
  let buf = '', err = '';
  p.stdout.on('data', d => {
    buf += String(d); const lines = buf.split('\n'); buf = lines.pop();
    for (const l of lines) { let j; try { j = JSON.parse(l); } catch { continue; }
      if (j.type === 'thread.started' && j.thread_id) { codexRun.thread = j.thread_id; try { fs.writeFileSync(path.join(codexDir(), '.mininet-thread'), j.thread_id); } catch {} }
      const msg = (j.error && j.error.message) || j.message || (j.item && j.item.type === 'error' && j.item.message) || '';
      if (!hitLimit && msg && LIMIT_RE.test(msg)) { hitLimit = true; codexSend({ type: 'limit', message: msg }); }
      codexSend(j); }
  });
  p.stderr.on('data', d => { err += String(d); if (err.length > 4000) err = err.slice(-4000); });
  p.on('error', er => { codexRun.proc = null; codexSend({ type: 'error', message: 'Could not start Codex: ' + er.message + '. Is the Codex CLI installed and signed in?' }); });
  p.on('exit', code => { codexRun.proc = null; const tail = err.split('\n').filter(x => x.trim() && !/Reading additional input/.test(x)).slice(-3).join(' ');
    if (!hitLimit && code && LIMIT_RE.test(tail)) { hitLimit = true; codexSend({ type: 'limit', message: tail.slice(0, 300) }); }
    codexSend({ type: 'end', code, limit: hitLimit, error: code ? (tail || 'Codex stopped (code ' + code + ')') : '' }); });
  return true;
});
ipcMain.handle('business', async (e, op, a = {}) => {
  const biz = agent.biz;
  if (op === 'data') return biz.panelData();
  if (op === 'save') return biz.saveSettings(a);
  if (op === 'confirm') return biz.confirmOwner(a.dealId);
  if (op === 'test-alerts') { try { const r = await biz.gmailSearch(biz.settings().alertSenders.map(x => 'from:' + x.replace(/^@/, '')).join(' OR '), { open: 2 }); return { ok: true, found: r.rows.length, sample: r.opened.map(m => ({ from: m.from, trusted: biz.trustedSender(m.from), subject: m.subject, date: m.date, parsed: biz.parseAlert(m.subject + '\n' + m.body) })) }; } catch (err) { return { ok: false, error: err.message }; } }
  return null;
});
// The owner presses "Use the token from the ngrok page": find it on their open ngrok dashboard tab
ipcMain.handle('ngrok-token-from-page', async () => {
  for (const wc of webContents.getAllWebContents()) {
    if (wc.getType() !== 'webview' || !/^https:\/\/dashboard\.ngrok\.com\//.test(wc.getURL())) continue;
    const t = await wc.executeJavaScript(`(() => { const txt = [document.body.innerText, ...[...document.querySelectorAll('input,textarea,code,pre')].map(e => e.value || e.textContent)].join(' '); const m = txt.match(/\\b[0-9][A-Za-z0-9]{20,40}_[A-Za-z0-9]{15,40}\\b/); return m ? m[0] : null; })()`).catch(() => null);
    if (t) return { token: t };
    return { error: 'The ngrok page is open but the token is hidden. Press the eye / "Show" button next to your Authtoken on that page, then try again.' };
  }
  return { error: 'Open your ngrok dashboard first (Your Authtoken page), then press this again.' };
});
ipcMain.handle('clipboard-read', () => clipboard.readText());
ipcMain.handle('account-signout', async (e, id) => {
  const s = SITES.find(x => x.id === id); if (!s || s.storage) return false;
  const ses = session.fromPartition(PARTITION);
  const list = await ses.cookies.get({ domain: s.domain.replace(/^\./, '') });
  for (const c of list) await ses.cookies.remove((c.secure ? 'https://' : 'http://') + c.domain.replace(/^\./, '') + c.path, c.name).catch(() => {});
  return true;
});

// "Keep me signed in": sites that use session-only cookies would sign you out every time the browser closes.
// Save them (encrypted) when the browser closes and put them back when it opens.
function keepFile() { return path.join(app.getPath('userData'), 'kept-sessions.bin'); }
async function saveSessionCookies() {
  try {
    const ses = session.fromPartition(PARTITION);
    await ses.cookies.flushStore();
    const all = (await ses.cookies.get({})).filter(c => c.session && c.value && c.value.length < 4096).slice(0, 3000);
    const json = JSON.stringify({ t: Date.now(), cookies: all });
    fs.writeFileSync(keepFile(), safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(json) : Buffer.from(json));
  } catch (e) { console.error('keep sessions', e.message); }
}
async function restoreSessionCookies() {
  try {
    const buf = fs.readFileSync(keepFile());
    const { t, cookies } = JSON.parse(safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(buf) : buf.toString('utf8'));
    if (Date.now() - t > 30 * 864e5) return;   // older than 30 days: let them go
    const ses = session.fromPartition(PARTITION);
    for (const c of cookies) {
      const host = c.domain.replace(/^\./, '');
      const d = { url: (c.secure ? 'https://' : 'http://') + host + (c.path || '/'), name: c.name, value: c.value, path: c.path, secure: c.secure, httpOnly: c.httpOnly, sameSite: c.sameSite, expirationDate: Date.now() / 1000 + 14 * 86400 };
      if (c.domain.startsWith('.')) d.domain = c.domain;
      if (c.name.startsWith('__Host-')) delete d.domain;
      await ses.cookies.set(d).catch(() => {});
    }
  } catch {}
}
let savedOnQuit = false;
// on quit: save sign-in cookies AND flush site storage (WhatsApp keeps its login in IndexedDB) before closing
async function saveEverything() { await saveSessionCookies().catch(() => {}); try { await session.fromPartition(PARTITION).flushStorageData(); } catch {} }
app.on('before-quit', e => { if (savedOnQuit) return; e.preventDefault(); savedOnQuit = true; Promise.race([saveEverything(), new Promise(r => setTimeout(r, 8000))]).finally(() => app.quit()); });
setInterval(() => { try { session.fromPartition(PARTITION).flushStorageData(); } catch {} }, 60000);   // also every minute, in case of a power cut
setInterval(saveSessionCookies, 5 * 60 * 1000).unref?.();   // also every 5 minutes, in case the laptop switches off

/* ---------------- start ---------------- */
app.whenReady().then(async () => {
  setupSession();
  await restoreSessionCookies();
  ext.init(app.getPath('userData'));
  try { writeBridge(); } catch (err) { console.error('bridge', err); }
  createWindow();
  initMail();
  makeCodexShortcut();
  if (process.argv.includes('--codex')) { win.once('ready-to-show', () => win.minimize()); setTimeout(() => { if (win && !win.isMinimized()) win.minimize(); }, 2500); openCodexWindow(); }
  agent.init({
    userData: app.getPath('userData'),
    shell: shellReq,
    onEvent: ev => win && win.webContents.send('agent-event', ev),
    accounts: () => accountsStatus(),
    popups: () => popupList(),
    mail,
    quit: () => { tunnelLog('closing for update/restart'); setTimeout(() => app.quit(), 200); }
  });
  if (tunnelConf().on) setTimeout(() => { tunnelLog('auto-start ' + tunnelConf().provider); tunnelStart(); }, 3000);   // reopen the connector link if it was on
});
app.on('window-all-closed', () => app.quit());
