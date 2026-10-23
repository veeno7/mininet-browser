const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ENG = {
  google: ['Google', 'https://www.google.com/search?q='], bing: ['Bing', 'https://www.bing.com/search?q='],
  duck: ['DuckDuckGo', 'https://duckduckgo.com/?q='], brave: ['Brave Search', 'https://search.brave.com/search?q=']
};
const engine = ENG[new URLSearchParams(location.search).get('engine')] || ENG.google;
const MININET = new URL('mininet/MiniNet.html', location.href).href;
$('#eng').textContent = 'Searching with ' + engine[0] + ' · change it in Settings';

function resolve(s) {
  s = s.trim();
  if (/^mini:\/\//i.test(s) || /^[a-z0-9-]+\.mini([/?#].*)?$/i.test(s)) return MININET + '?embedded=1#' + encodeURIComponent(s.replace(/^mini:\/\//i, ''));
  if (/^(https?|file):/i.test(s)) return s;
  if (/^(localhost|127\.0\.0\.1)(:\d+)?(\/.*)?$/i.test(s)) return 'http://' + s;
  if (!/\s/.test(s) && /^[^/]+\.[a-z]{2,}(:\d+)?(\/.*)?$/i.test(s)) return 'https://' + s;
  return engine[1] + encodeURIComponent(s);
}
$('#f').onsubmit = e => { e.preventDefault(); const v = $('#q').value; if (v.trim()) location.href = resolve(v); };
$('#portal').onclick = () => location.href = resolve('mini://home.mini');

function tick() {
  const d = new Date(), h = d.getHours();
  $('#clock').textContent = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  $('#hello').textContent = (h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening') + ' · ' + d.toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long' });
}
tick(); setInterval(tick, 10000);

const DEFAULT_DIAL = [
  ['Google', 'https://www.google.com/'], ['YouTube', 'https://www.youtube.com/'], ['WhatsApp', 'https://web.whatsapp.com/'],
  ['Gmail', 'https://mail.google.com/'], ['GitHub', 'https://github.com/'], ['Wikipedia', 'https://en.wikipedia.org/'],
  ['X', 'https://x.com/'], ['Claude', 'https://claude.ai/']
];
let dial;
try { dial = JSON.parse(localStorage.getItem('mb.dial')) || DEFAULT_DIAL; } catch { dial = DEFAULT_DIAL; }
function saveDial() { try { localStorage.setItem('mb.dial', JSON.stringify(dial)); } catch {} }
function host(u) { try { return new URL(u).hostname; } catch { return ''; } }
function paint() {
  $('#dial').innerHTML = dial.map(([n, u], i) => `<a class="d" href="${esc(u)}"><button class="rm" data-i="${i}" title="Remove">×</button>
    <img src="https://www.google.com/s2/favicons?sz=64&domain=${esc(host(u))}" alt=""><div>${esc(n)}</div></a>`).join('') +
    `<div class="d add" id="add"><span>+</span><div>Add shortcut</div></div>`;
  document.querySelectorAll('.rm').forEach(b => b.onclick = e => { e.preventDefault(); e.stopPropagation(); dial.splice(+b.dataset.i, 1); saveDial(); paint(); });
  document.querySelectorAll('.d img').forEach(i => i.onerror = () => { i.src = 'icon.png'; });
  $('#add').onclick = () => { $('#dName').value = ''; $('#dUrl').value = ''; $('#dlg').showModal(); };
}
$('#dlg').addEventListener('close', () => {
  if ($('#dlg').returnValue !== 'ok') return;
  let u = $('#dUrl').value.trim(); if (!u) return;
  if (!/^https?:\/\//.test(u)) u = 'https://' + u;
  const n = $('#dName').value.trim() || host(u).replace(/^www\./, '');
  dial.push([n, u]); saveDial(); paint();
});
paint();
