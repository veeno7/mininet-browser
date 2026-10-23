// MiniNet Browser — user extensions.
// Extensions live in the user's data folder (never inside the app's core code).
// Each extension = a folder with manifest.json, content.js and/or content.css,
// injected into pages whose address matches one of its "matches" patterns.
const fs = require('fs');
const path = require('path');

let ROOT = null;
function init(userData) {
  ROOT = path.join(userData, 'extensions');
  fs.mkdirSync(ROOT, { recursive: true });
  if (!fs.existsSync(path.join(ROOT, 'state.json'))) writeJSON(path.join(ROOT, 'state.json'), {});
  seedExample();
}
function readJSON(p, d) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return d; } }
function writeJSON(p, v) { fs.writeFileSync(p, JSON.stringify(v, null, 2)); }
function safeId(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'extension'; }
function dirOf(id) {
  const d = path.resolve(ROOT, safeId(id));
  if (!d.startsWith(path.resolve(ROOT) + path.sep)) throw new Error('Invalid extension id');
  return d;
}
function state() { return readJSON(path.join(ROOT, 'state.json'), {}); }

function list() {
  const st = state();
  return fs.readdirSync(ROOT, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => {
    const m = readJSON(path.join(ROOT, d.name, 'manifest.json'), null);
    if (!m) return null;
    return {
      id: d.name, name: m.name || d.name, version: m.version || '1.0.0', description: m.description || '',
      matches: m.matches || ['<all_urls>'], author: m.author || '', enabled: st[d.name] !== false,
      hasJs: fs.existsSync(path.join(ROOT, d.name, 'content.js')), hasCss: fs.existsSync(path.join(ROOT, d.name, 'content.css'))
    };
  }).filter(Boolean).sort((a, b) => a.name.localeCompare(b.name));
}
function get(id) {
  const d = dirOf(id);
  const m = readJSON(path.join(d, 'manifest.json'), null);
  if (!m) throw new Error('No extension with id ' + id);
  const read = f => { try { return fs.readFileSync(path.join(d, f), 'utf8'); } catch { return ''; } };
  return { id: safeId(id), ...m, enabled: state()[safeId(id)] !== false, js: read('content.js'), css: read('content.css') };
}
function save({ id, name, description = '', matches, js, css, version, author = 'AI' }) {
  if (!name && !id) throw new Error('An extension needs a name');
  const eid = safeId(id || name);
  const d = dirOf(eid);
  fs.mkdirSync(d, { recursive: true });
  const old = readJSON(path.join(d, 'manifest.json'), {});
  const m = {
    name: name || old.name || eid, description: description || old.description || '',
    version: version || bump(old.version), author: author || old.author || '',
    matches: (Array.isArray(matches) && matches.length) ? matches : (old.matches || ['<all_urls>'])
  };
  writeJSON(path.join(d, 'manifest.json'), m);
  const jsF = path.join(d, 'content.js'), cssF = path.join(d, 'content.css');
  if (js !== undefined || !fs.existsSync(jsF)) fs.writeFileSync(jsF, String(js || ''));
  if (css !== undefined || !fs.existsSync(cssF)) fs.writeFileSync(cssF, String(css || ''));
  return { id: eid, ...m };
}
function bump(v) { if (!v) return '1.0.0'; const p = String(v).split('.').map(n => +n || 0); p[2]++; return p.join('.'); }
function setEnabled(id, on) { const st = state(); st[safeId(id)] = !!on; writeJSON(path.join(ROOT, 'state.json'), st); }
function remove(id) { fs.rmSync(dirOf(id), { recursive: true, force: true }); const st = state(); delete st[safeId(id)]; writeJSON(path.join(ROOT, 'state.json'), st); }
function importFolder(src) {
  const m = readJSON(path.join(src, 'manifest.json'), null);
  if (!m) throw new Error('That folder has no manifest.json');
  const read = f => { try { return fs.readFileSync(path.join(src, f), 'utf8'); } catch { return ''; } };
  return save({ name: m.name || path.basename(src), description: m.description, matches: m.matches, version: m.version, author: m.author, js: read('content.js'), css: read('content.css') });
}

// "*://*.youtube.com/*", "<all_urls>", "mini://*", "https://example.com/path*"
function matchOne(pattern, url) {
  if (pattern === '<all_urls>' || pattern === '*') return /^(https?|mini):/.test(url);
  const re = '^' + pattern.split('*').map(s => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$';
  try { return new RegExp(re, 'i').test(url); } catch { return false; }
}
function forUrl(url) {
  return list().filter(e => e.enabled && e.matches.some(p => matchOne(p, url))).map(e => {
    const d = dirOf(e.id);
    const read = f => { try { return fs.readFileSync(path.join(d, f), 'utf8'); } catch { return ''; } };
    return { ...e, js: read('content.js'), css: read('content.css') };
  });
}

function seedExample() {
  if (fs.existsSync(path.join(ROOT, '.seeded'))) return;
  save({
    id: 'reading-ruler', name: 'Reading Ruler', author: 'MiniNet',
    description: 'Example extension: press Alt+R on any page to show a soft highlight bar that follows your mouse while you read.',
    matches: ['<all_urls>'],
    css: '#mn-ruler{position:fixed;left:0;right:0;height:34px;pointer-events:none;z-index:2147483647;background:rgba(255,210,94,.18);border-top:1px solid rgba(255,154,77,.5);border-bottom:1px solid rgba(255,154,77,.5);display:none}',
    js: `(() => {
  if (window.__mnRuler) return; window.__mnRuler = true;
  const bar = document.createElement('div'); bar.id = 'mn-ruler'; document.documentElement.appendChild(bar);
  addEventListener('mousemove', e => { bar.style.top = (e.clientY - 17) + 'px'; });
  addEventListener('keydown', e => { if (e.altKey && e.key.toLowerCase() === 'r') bar.style.display = bar.style.display === 'block' ? 'none' : 'block'; });
})();`
  });
  setEnabled('reading-ruler', false);
  fs.writeFileSync(path.join(ROOT, '.seeded'), '1');
}

module.exports = { init, list, get, save, setEnabled, remove, importFolder, forUrl, root: () => ROOT };
