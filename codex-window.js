// MiniNet Codex — a stand-alone chat window for OpenAI Codex. Codex works in MiniNet Browser through its tools.
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const load = (k, d) => { try { const v = JSON.parse(localStorage.getItem('mb.' + k)); return v ?? d; } catch { return d; } };
const store = (k, v) => { try { localStorage.setItem('mb.' + k, JSON.stringify(v)); } catch {} };
let log = load('codexChat', []), busy = false, lastPrompt = '';
const prefs = load('codexPrefs', { model: 'gpt-6-luna', effort: 'medium', fallback: true });
$('#model').value = prefs.model; $('#effort').value = prefs.effort; $('#fb').checked = prefs.fallback !== false;
const savePrefs = () => { prefs.model = $('#model').value; prefs.effort = $('#effort').value; prefs.fallback = $('#fb').checked; store('codexPrefs', prefs); };
['#model', '#effort', '#fb'].forEach(s => $(s).onchange = savePrefs);
function save() { log = log.slice(-300); store('codexChat', log); }
function paint() {
  const box = $('#log');
  box.innerHTML = log.length ? log.map(m => `<div class="m ${m.who === 'me' ? 'me' : m.who === 'act' ? 'act' : m.who === 'err' ? 'err' : m.who === 'think' ? 'think' : m.who === 'note' ? 'note' : 'ai'}">${esc(m.text)}</div>`).join('') + (busy ? '<div class="m think">Codex is working…</div>' : '')
    : '<div class="m note">Chat with Codex here. It works in your MiniNet Browser — searching, reading, filling forms, WhatsApp, Gmail, CapCut… — and can use files in your MiniNetCodex folder.<br>Press 🎤 to speak instead of typing (free, works offline).</div>';
  box.scrollTop = box.scrollHeight;
  $('#send').textContent = busy ? 'Stop' : 'Send'; $('#st').textContent = busy ? 'working…' : 'ready';
}
function actLine(it, done) {
  if (it.type === 'mcp_tool_call') return `🧭 ${it.tool || ''}${done ? (it.status === 'failed' || it.error ? ' ✗' : ' ✓') : ' …'}`;
  if (it.type === 'command_execution') return `⌨ ${String(it.command || '').slice(0, 140)}${done ? (it.exit_code ? ' ✗' : ' ✓') : ' …'}`;
  if (it.type === 'file_change') return `📝 ${(it.changes || []).map(c => c.path).join(', ').slice(0, 140)}`;
  if (it.type === 'web_search') return `🔎 ${it.query || 'web search'}`;
  if (it.type === 'todo_list') return '☑ ' + (it.items || []).map(x => (x.completed ? '✓ ' : '· ') + x.text).join('  ');
  return null;
}
function upsertAct(it, done) {
  const l = actLine(it, done); if (!l) return;
  for (let k = log.length - 1; k >= 0; k--) { if (log[k].who === 'me') break; if (log[k].id === it.id) { log[k].text = l; return; } }
  log.push({ who: 'act', id: it.id, text: l });
}
window.app.on('codex-event', ev => {
  if (ev.type === 'start') busy = true;
  else if (ev.type === 'item.started' && ev.item) upsertAct(ev.item, false);
  else if (ev.type === 'item.completed' && ev.item) {
    const it = ev.item;
    if (it.type === 'agent_message' && it.text) log.push({ who: 'ai', text: it.text });
    else if (it.type === 'reasoning' && it.text) log.push({ who: 'think', text: it.text.slice(0, 300) });
    else if (it.type === 'error') log.push({ who: 'err', text: it.message || 'error' });
    else upsertAct(it, true);
  }
  else if ((ev.type === 'turn.failed' || ev.type === 'error') && !/usage limit|rate limit|quota|limit reached/i.test((ev.error && ev.error.message) || ev.message || '')) log.push({ who: 'err', text: (ev.error && ev.error.message) || ev.message || 'Codex error' });
  else if (ev.type === 'limit') {
    log.push({ who: 'err', text: 'Codex reached its usage limit: ' + ev.message });
    if (prefs.fallback !== false && lastPrompt) { log.push({ who: 'note', text: 'Handing this job to MiniNet\'s own AI (Orbit) so it keeps going…' }); window.app.codex('fallback', { text: lastPrompt }); }
  }
  else if (ev.type === 'fallback-report') { log.push({ who: 'ai', text: '(Orbit) ' + ev.text }); }
  else if (ev.type === 'end') { busy = false; if (ev.error && !ev.limit) log.push({ who: 'err', text: ev.error }); }
  save(); paint();
});
async function send() {
  if (busy) { await window.app.codex('stop'); return; }
  const t = $('#in').value.trim(); if (!t) return;
  $('#in').value = ''; lastPrompt = t; log.push({ who: 'me', text: t }); busy = true; save(); paint();
  try { await window.app.codex('send', { text: t, model: prefs.model, effort: prefs.effort }); }
  catch (e) { busy = false; log.push({ who: 'err', text: e.message }); save(); paint(); }
}
$('#send').onclick = send;
$('#in').onkeydown = e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } };
$('#new').onclick = async () => { if (busy) return; await window.app.codex('new'); log = []; save(); paint(); };
$('#browser').onclick = () => window.app.codex('show-browser');
$('#min').onclick = () => window.app.codex('win', { op: 'min' });
$('#close').onclick = () => window.app.codex('win', { op: 'close' });

/* free voice: record → 16 kHz WAV → Whisper on this computer (no key) */
let rec = null, chunks = [];
async function toWav(blob) {
  const ctx = new AudioContext(); const buf = await ctx.decodeAudioData(await blob.arrayBuffer());
  const rate = 16000, len = Math.ceil(buf.duration * rate); const off = new OfflineAudioContext(1, len, rate);
  const src = off.createBufferSource(); src.buffer = buf; src.connect(off.destination); src.start();
  const pcm = (await off.startRendering()).getChannelData(0); const out = new DataView(new ArrayBuffer(44 + pcm.length * 2));
  const w = (o, s) => [...s].forEach((c, i) => out.setUint8(o + i, c.charCodeAt(0)));
  w(0, 'RIFF'); out.setUint32(4, 36 + pcm.length * 2, true); w(8, 'WAVE'); w(12, 'fmt '); out.setUint32(16, 16, true); out.setUint16(20, 1, true); out.setUint16(22, 1, true);
  out.setUint32(24, rate, true); out.setUint32(28, rate * 2, true); out.setUint16(32, 2, true); out.setUint16(34, 16, true); w(36, 'data'); out.setUint32(40, pcm.length * 2, true);
  for (let i = 0; i < pcm.length; i++) out.setInt16(44 + i * 2, Math.max(-1, Math.min(1, pcm[i])) * 0x7fff, true);
  ctx.close(); return new Uint8Array(out.buffer);
}
$('#mic').onclick = async () => {
  if (rec) { rec.stop(); return; }
  try {
    const st = await window.app.voice('status');
    if (!st.installed) { log.push({ who: 'note', text: 'Setting up free voice (one time, about 150 MB)…' }); paint(); const r = await window.app.voice('install'); if (!r || r.ok === false) { log.push({ who: 'err', text: 'Voice setup failed: ' + ((r && r.error) || '') }); paint(); return; } }
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    chunks = []; rec = new MediaRecorder(stream);
    rec.ondataavailable = e => chunks.push(e.data);
    rec.onstop = async () => {
      stream.getTracks().forEach(t => t.stop()); rec = null; $('#mic').classList.remove('rec'); $('#mic').textContent = '🎤'; $('#st').textContent = 'writing down what you said…';
      const r = await window.app.voice('transcribe', { wav: await toWav(new Blob(chunks, { type: 'audio/webm' })), translate: !!prefs.translate });
      $('#st').textContent = busy ? 'working…' : 'ready';
      if (r && r.ok && r.text) { $('#in').value = ($('#in').value ? $('#in').value + ' ' : '') + r.text; $('#in').focus(); }
      else { log.push({ who: 'err', text: (r && r.error) || 'Did not catch that — try again.' }); paint(); }
    };
    rec.start(); $('#mic').classList.add('rec'); $('#mic').textContent = '⏹'; $('#st').textContent = 'listening… press ⏹ when done';
  } catch (e) { rec = null; log.push({ who: 'err', text: 'Microphone: ' + e.message }); paint(); }
};
window.app.codex('status').then(s => { busy = s.running; paint(); });
paint();
