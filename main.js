// MiniNet Browser — main process
const { app, BrowserWindow, session, ipcMain, Menu, shell, clipboard, dialog, safeStorage, webContents } = require('electron');
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

function createWindow() {
  win = new BrowserWindow({
    width: 1300, height: 840, minWidth: 460, minHeight: 420,
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
      const exe = await ensureNgrok();
      tunnel.status = 'starting'; tunnelEmit();
      const args = ['http', `127.0.0.1:${port}`, '--host-header=rewrite', '--log=stdout', '--log-format=json', '--pooling-enabled'];
      const dom = cleanDomain(conf.domain);
      if (dom) args.push('--url=https://' + dom);
      p = spawn(exe, args, { windowsHide: true, env: Object.assign({}, process.env, { NGROK_AUTHTOKEN: key }) });
      let buf = '';
      const onData = d => {
        buf += String(d); const lines = buf.split('\n'); buf = lines.pop();
        for (const line of lines) {
          let j; try { j = JSON.parse(line); } catch { if (line.trim()) { tunnelLog('ngrok: ' + line); if (/ERR_NGROK|error/i.test(line)) { tunnel.error = line.trim().slice(0, 300); tunnelEmit(); } } continue; }
          if (j.url && /^https:/.test(j.url) && !tunnel.url) { tunnelLog('online ' + j.url); tunnel.tries = 0; tunnel.url = j.url.replace(/\/$/, ''); tunnel.status = 'on'; if (!dom) tunnelConf({ domain: cleanDomain(tunnel.url) }); tunnelEmit(); }
          if (j.lvl === 'eror' || j.lvl === 'crit' || j.lvl === 'warn') tunnelLog(line);
          if (j.lvl === 'eror' || j.lvl === 'crit') { tunnel.error = String(j.err || j.msg || 'ngrok error').replace(/\s+/g, ' ').slice(0, 300); tunnelEmit(); }
        }
      };
      p.stdout.on('data', onData); p.stderr.on('data', onData);
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
function tunnelStop() { clearTimeout(tunnel.retryT); tunnel.retryT = null; tunnel.status = 'off'; tunnel.url = null; const p = tunnel.proc; tunnel.proc = null; if (p) p.kill(); tunnelEmit(); }
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
app.on('before-quit', () => { const p = tunnel.proc; tunnel.proc = null; if (p) p.kill(); });

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

// Orbit's requests to AI providers go from here (no browser CORS limits; keys never touch web pages)
ipcMain.handle('llm', async (e, { url, method = 'POST', headers = {}, body, keyName, keyHeader = 'Authorization', keyPrefix = 'Bearer ', timeoutMs = 180000 }) => {
  if (!/^https:\/\/|^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//i.test(url)) return { ok: false, error: 'Only https:// or local AI endpoints are allowed' };
  const key = keyName ? readSecrets()[keyName] : null;
  if (keyName && !key) return { ok: false, error: 'No API key saved for this provider yet. Add it in Orbit settings.' };
  try {
    const r = await fetch(url, { method: method === 'GET' ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json', ...headers, ...(key ? { [keyHeader]: keyPrefix + key } : {}) }, body: method === 'GET' ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(Math.min(+timeoutMs || 180000, 900000)) });
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
  { id: 'youtube', name: 'YouTube', url: 'https://www.youtube.com/', login: 'https://www.youtube.com/signin', domain: '.youtube.com', cookies: ['LOGIN_INFO', 'SID'] },
  { id: 'capcut', name: 'CapCut', url: 'https://www.capcut.com/my-edit', login: 'https://www.capcut.com/login', domain: '.capcut.com', cookies: ['sessionid', 'sid_tt', 'sessionid_ss'] },
  { id: 'github', name: 'GitHub', url: 'https://github.com/', login: 'https://github.com/login', domain: 'github.com', cookies: ['logged_in=yes', 'user_session'] },
  { id: 'instagram', name: 'Instagram', url: 'https://www.instagram.com/', login: 'https://www.instagram.com/accounts/login/', domain: '.instagram.com', cookies: ['sessionid'] },
  { id: 'facebook', name: 'Facebook', url: 'https://www.facebook.com/', login: 'https://www.facebook.com/login', domain: '.facebook.com', cookies: ['c_user'] },
  { id: 'tiktok', name: 'TikTok', url: 'https://www.tiktok.com/', login: 'https://www.tiktok.com/login', domain: '.tiktok.com', cookies: ['sessionid', 'sid_tt'] },
  { id: 'x', name: 'X (Twitter)', url: 'https://x.com/home', login: 'https://x.com/i/flow/login', domain: '.x.com', cookies: ['auth_token'] },
  { id: 'linkedin', name: 'LinkedIn', url: 'https://www.linkedin.com/feed/', login: 'https://www.linkedin.com/login', domain: '.linkedin.com', cookies: ['li_at'] },
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
      google = (j[1] || []).map(a => ({ name: a[2] || '', email: a[3] || '', signedOut: !!a[14] })).filter(a => a.email && !a.signedOut);
    } catch {}
  }
  return { sites: out, google };
}
ipcMain.handle('accounts', () => accountsStatus());
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
app.on('before-quit', e => { if (savedOnQuit) return; e.preventDefault(); savedOnQuit = true; saveSessionCookies().finally(() => app.quit()); });
setInterval(saveSessionCookies, 5 * 60 * 1000).unref?.();   // also every 5 minutes, in case the laptop switches off

/* ---------------- start ---------------- */
app.whenReady().then(async () => {
  setupSession();
  await restoreSessionCookies();
  ext.init(app.getPath('userData'));
  try { writeBridge(); } catch (err) { console.error('bridge', err); }
  createWindow();
  agent.init({
    userData: app.getPath('userData'),
    shell: shellReq,
    onEvent: ev => win && win.webContents.send('agent-event', ev),
    accounts: () => accountsStatus()
  });
  if (tunnelConf().on) setTimeout(() => { tunnelLog('auto-start ' + tunnelConf().provider); tunnelStart(); }, 3000);   // reopen the connector link if it was on
});
app.on('window-all-closed', () => app.quit());
