/* MiniNet Browser — AI features: Orbit assistant, agent connections, extensions, live "AI is driving" bar.
   Runs in the browser UI after shell.js (uses its tabs/active/newTab/resolve/showPanel/toast helpers). */

/* ================= AI-is-driving indicator ================= */
let driveTimer = null, aiPaused = false;
const aiBar = $('#aiBar');
window.app.on('agent-event', ev => {
  if (ev.type === 'activity') {
    if (ev.status === 'start') {
      aiBar.classList.add('show'); aiBar.classList.remove('paused');
      $('#views').classList.add('driving');
      $('#aiText').textContent = `${ev.client} is using the browser · ${ev.summary}`;
      $('#aiStop').textContent = 'Stop AI';
      clearTimeout(driveTimer);
    } else {
      clearTimeout(driveTimer);
      driveTimer = setTimeout(() => { if (!aiPaused) { aiBar.classList.remove('show'); $('#views').classList.remove('driving'); } }, 4000);
    }
    if (panelOpen === 'agents') renderAgentLog();
  }
  if (ev.type === 'paused') {
    aiPaused = ev.paused;
    $('#views').classList.remove('driving');
    if (aiPaused) { aiBar.classList.add('show', 'paused'); $('#aiText').textContent = 'AI control is paused'; $('#aiStop').textContent = 'Resume'; }
    else { aiBar.classList.remove('show', 'paused'); }
    if (panelOpen === 'agents') showPanel('agents');
  }
  if (ev.type === 'server' && ev.error) toast(ev.error);
  if (ev.type === 'approvals' && panelOpen === 'agents') showPanel('agents');
});
$('#aiStop').onclick = () => { window.app.agentPause(!aiPaused); if (!aiPaused) orbitAbort(); };

/* ================= Permission & questions from AIs ================= */
const openCards = new Map();
function card(id, html, wire) {
  const el = document.createElement('div'); el.className = 'perm'; el.innerHTML = html;
  $('#permWrap').appendChild(el); openCards.set(id, el);
  return new Promise(resolve => wire(el, v => { el.remove(); openCards.delete(id); resolve(v); }));
}
window.app.on('agent-req-cancel', ({ id }) => { const el = openCards.get(id); if (el) { el.remove(); openCards.delete(id); } });
AGENT_OPS.approve = ({ client, plan, action }, id) => card(id, `
  <div class="hd"><img src="icon.png"><b>${esc(client)} wants to use your browser</b></div>
  ${plan ? `<div class="plan">${esc(plan)}</div>` : `<div class="plan">First step: ${esc(action || 'act on a page')}</div>`}
  <small>If you allow it, it will carry on by itself — signing in, accepting cookies, clicking Continue — until the job is done. You can press Stop AI any time.</small>
  <input placeholder="Optional message to the AI">
  <div class="acts"><button class="btn sun" data-a="allow">Allow</button><button class="btn" data-a="deny">Deny</button></div>`,
  (el, done) => {
    const msg = () => el.querySelector('input').value.trim();
    el.querySelector('[data-a=allow]').onclick = () => done({ allow: true, reason: msg() });
    el.querySelector('[data-a=deny]').onclick = () => done({ allow: false, reason: msg() });
  });
AGENT_OPS.ask = ({ client, question, options = [] }, id) => card(id, `
  <div class="hd"><img src="icon.png"><b>${esc(client)} is asking you</b></div>
  <div class="plan">${esc(question)}</div>
  ${options.length ? `<div class="acts" style="margin-bottom:8px">${options.map((o, i) => `<button class="btn" data-o="${i}">${esc(o)}</button>`).join('')}</div>` : ''}
  <input placeholder="Type your answer…"><div class="acts"><button class="btn sun" data-a="send">Send answer</button></div>`,
  (el, done) => {
    el.querySelectorAll('[data-o]').forEach(b => b.onclick = () => done({ answer: options[+b.dataset.o] }));
    const inp = el.querySelector('input');
    const send = () => inp.value.trim() && done({ answer: inp.value.trim() });
    el.querySelector('[data-a=send]').onclick = send; inp.onkeydown = e => { if (e.key === 'Enter') send(); };
    setTimeout(() => inp.focus(), 50);
  });

/* ================= Orbit — built-in AI assistant ================= */
const PROVIDERS = {
  anthropic: { name: 'Claude (Anthropic)', kind: 'anthropic', url: 'https://api.anthropic.com/v1/messages', model: 'claude-sonnet-5-5', key: true, vision: true, keyHelp: 'console.anthropic.com' },
  openai: { name: 'ChatGPT (OpenAI)', kind: 'openai', url: 'https://api.openai.com/v1/chat/completions', model: 'gpt-4.1', key: true, vision: true, keyHelp: 'platform.openai.com' },
  groq: { name: 'Groq (fast, free tier)', kind: 'openai', url: 'https://api.groq.com/openai/v1/chat/completions', model: 'llama-3.3-70b-versatile', key: true, vision: false, keyHelp: 'console.groq.com' },
  gemini: { name: 'Gemini (Google)', kind: 'openai', url: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions', model: 'gemini-3.8-flash', key: true, vision: true, keyHelp: 'aistudio.google.com/apikey' },
  openrouter: { name: 'OpenRouter (hundreds of models)', kind: 'openai', url: 'https://openrouter.ai/api/v1/chat/completions', model: 'anthropic/claude-sonnet-4.5', key: true, vision: true, keyHelp: 'openrouter.ai' },
  ollama: { name: 'Ollama (free, runs on this computer)', kind: 'openai', url: 'http://localhost:11434/v1/chat/completions', model: 'qwen2.5:7b', key: false, vision: false, keyHelp: 'ollama.com' },
  custom: { name: 'Custom (OpenAI-compatible)', kind: 'openai', url: '', model: '', key: true, vision: false, keyHelp: '' }
};
const orbit = Object.assign({ provider: 'ollama', models: {}, urls: {}, speak: false, instructions: '', voice: 'auto' }, load('orbit', {}));
function saveOrbit() { store('orbit', orbit); }
function prov() { return PROVIDERS[orbit.provider] || PROVIDERS.ollama; }
function modelName() { return orbit.models[orbit.provider] || prov().model; }
function provUrl() { return orbit.urls[orbit.provider] || prov().url; }

let convo = [];          // neutral format: {role:'user',text} | {role:'assistant',text,calls:[]} | {role:'tool',results:[]}
let running = false, abortFlag = false, toolDefs = null;
function orbitAbort() { abortFlag = true; }

PANELS.orbit = { title: 'Orbit', wide: true, render: renderOrbit };
function renderOrbit(body) {
  body.className = 'chat';
  body.innerHTML = `<div id="oMsgs"></div>
    <div id="oInput">
      <textarea id="oText" rows="2" placeholder="Ask Orbit to do anything on the web…  (Enter to send)"></textarea>
      <div class="orow">
        <button class="ic sm mic" id="oMic" title="Speak (voice input)"><svg viewBox="0 0 24 24"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></svg></button>
        <button class="ic sm ${orbit.speak ? 'active' : ''}" id="oSpeak" title="Speak replies out loud"><svg viewBox="0 0 24 24"><path d="M4 9h4l5-4v14l-5-4H4zM16 9a4 4 0 0 1 0 6M18.5 6.5a8 8 0 0 1 0 11"/></svg></button>
        <span class="oModel" id="oModel"></span><span class="grow"></span>
        <button class="ic sm" id="oNew" title="New chat"><svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg></button>
        <button class="ic sm" id="oSet" title="Orbit settings"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M5.3 18.7l2.1-2.1M16.6 7.4l2.1-2.1"/></svg></button>
        <button class="btn sun sm" id="oSend">${running ? 'Stop' : 'Send'}</button>
      </div>
    </div>`;
  $('#oModel').textContent = prov().name.split(' (')[0] + ' · ' + (modelName() || 'no model');
  paintConvo();
  const ta = $('#oText');
  ta.onkeydown = e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendOrbit(); } };
  ta.oninput = () => { ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight, 160) + 'px'; };
  $('#oSend').onclick = () => running ? orbitAbort() : sendOrbit();
  $('#oNew').onclick = () => { if (running) return; convo = []; paintConvo(); };
  $('#oSet').onclick = () => renderOrbitSettings(body);
  $('#oSpeak').onclick = e => { orbit.speak = !orbit.speak; saveOrbit(); e.currentTarget.classList.toggle('active', orbit.speak); if (!orbit.speak) speechSynthesis.cancel(); toast(orbit.speak ? 'Orbit will speak its replies' : 'Spoken replies off'); };
  $('#oMic').onclick = toggleMic;
  setTimeout(() => ta.focus(), 50);
}
function mdLite(s) {
  return esc(s).replace(/```([\s\S]*?)```/g, (m, c) => '<pre>' + c.replace(/^\w*\n/, '') + '</pre>')
    .replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
    .replace(/(https?:\/\/[^\s<)]+)/g, '<a data-href="$1">$1</a>').replace(/\n/g, '<br>');
}
function paintConvo() {
  const box = $('#oMsgs'); if (!box) return;
  if (!convo.length) {
    box.innerHTML = `<div class="oHello"><img src="icon.png"><b>Hi, I'm Orbit</b>I can browse, click, type, shop, post and build for you — on the real web and inside MiniNet.
      <div class="chips">${['Summarize this page', 'Post a chirp on MiniNet saying hello', 'Find the cheapest laptop on MiniMart and buy it', 'Build an extension that adds a dark mode to every site', 'Search YouTube for afrobeats mixes'].map(c => `<span class="chip">${c}</span>`).join('')}</div></div>`;
    box.querySelectorAll('.chip').forEach(c => c.onclick = () => { $('#oText').value = c.textContent; sendOrbit(); });
    return;
  }
  let html = '';
  for (const m of convo) {
    if (m.role === 'user') html += `<div class="om u">${esc(m.text)}</div>`;
    if (m.role === 'assistant') {
      if (m.text) html += `<div class="om a">${mdLite(m.text)}</div>`;
      for (const c of m.calls || []) html += `<div class="step" data-call="${esc(c.id)}">⚙ <b>${esc(stepLabel(c))}</b><span class="st">${c.status === 'ok' ? '<span class="ok">✓</span>' : c.status === 'err' ? '<span class="bad">✗</span>' : '…'}</span></div>`;
    }
    if (m.role === 'error') html += `<div class="om err">⚠ ${esc(m.text)}</div>`;
  }
  if (running) html += '<div class="thinking"><i></i><i></i><i></i></div>';
  box.innerHTML = html;
  box.querySelectorAll('a[data-href]').forEach(a => a.onclick = () => newTab(a.dataset.href));
  box.scrollTop = box.scrollHeight;
  const sb = $('#oSend'); if (sb) sb.textContent = running ? 'Stop' : 'Send';
}
function stepLabel(c) {
  const a = c.args || {};
  if (c.name === 'click') return a.ref != null ? `Click [${a.ref}]` : 'Click';
  if (c.name === 'type') return `Type “${String(a.text || '').slice(0, 40)}”`;
  if (c.name === 'navigate' || c.name === 'open_tab') return (c.name === 'navigate' ? 'Go to ' : 'Open ') + String(a.url || '').slice(0, 50);
  if (c.name === 'snapshot') return 'Read the page';
  if (c.name === 'screenshot') return 'Look at the page';
  if (c.name === 'save_extension') return `Build extension “${a.name}”`;
  return c.name.replace(/_/g, ' ');
}

async function systemPrompt() {
  const base = await window.app.agentInstructions();
  const tab = active ? `The user is currently looking at tab ${active.id}: "${active.title}" — ${display(active.url) || 'the start page'}.` : '';
  return `You are Orbit, the AI assistant built into MiniNet Browser. You act for the user inside their own browser using tools.
${base}
${tab}
Today is ${new Date().toDateString()}.
Work step by step: use snapshot to see the page, act with click/type using [ref] numbers, then check the result. Keep going until the task is done, then reply briefly in plain language.
The user's request is your permission: carry it out fully by yourself — sign up, log in, accept or reject cookies, press Continue, fill forms, check out — without stopping to ask.
Only use ask_user when you need a choice the request didn't cover (which size, which account, a price much higher than expected, or a payment they didn't ask for).
${orbit.instructions ? 'User\'s custom instructions: ' + orbit.instructions : ''}`;
}

async function getTools() { if (!toolDefs) toolDefs = await window.app.agentTools(); return toolDefs; }
function contentText(content) { return (content || []).filter(c => c.type === 'text').map(c => c.text).join('\n'); }

function toAnthropic(sys, tools) {
  const msgs = [];
  const toolRounds = convo.filter(m => m.role === 'tool').length;
  let roundIdx = 0;
  const push = (role, blocks) => { const last = msgs[msgs.length - 1]; if (last && last.role === role) last.content.push(...blocks); else msgs.push({ role, content: blocks }); };
  for (const m of convo) {
    if (m.role === 'user') push('user', [{ type: 'text', text: m.text }]);
    if (m.role === 'assistant') {
      const b = []; if (m.text) b.push({ type: 'text', text: m.text });
      for (const c of m.calls || []) b.push({ type: 'tool_use', id: c.id, name: c.name, input: c.args || {} });
      if (b.length) push('assistant', b);
    }
    if (m.role === 'tool') {
      roundIdx++;
      const recent = toolRounds - roundIdx < 2;
      push('user', m.results.map(r => ({
        type: 'tool_result', tool_use_id: r.id, is_error: !!r.isError,
        content: r.content.map(c => c.type === 'image'
          ? (recent ? { type: 'image', source: { type: 'base64', media_type: c.mimeType, data: c.data } } : { type: 'text', text: '[older screenshot removed]' })
          : { type: 'text', text: recent ? c.text : c.text.slice(0, 1500) })
      })));
    }
  }
  return { model: modelName(), max_tokens: 4096, system: sys, tools: tools.map(t => ({ name: t.name, description: t.description, input_schema: t.inputSchema })), messages: msgs };
}
function toOpenAI(sys, tools) {
  const msgs = [{ role: 'system', content: sys }];
  const toolRounds = convo.filter(m => m.role === 'tool').length;
  let roundIdx = 0;
  for (const m of convo) {
    if (m.role === 'user') msgs.push({ role: 'user', content: m.text });
    if (m.role === 'assistant') {
      const o = { role: 'assistant', content: m.text || '' };
      if (m.calls && m.calls.length) o.tool_calls = m.calls.map(c => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args || {}) } }));
      msgs.push(o);
    }
    if (m.role === 'tool') {
      roundIdx++;
      const recent = toolRounds - roundIdx < 2;
      const imgs = [];
      for (const r of m.results) {
        let t = contentText(r.content); if (!recent) t = t.slice(0, 1500);
        msgs.push({ role: 'tool', tool_call_id: r.id, content: (r.isError ? 'ERROR: ' : '') + (t || 'done') });
        r.content.filter(c => c.type === 'image').forEach(c => imgs.push(c));
      }
      if (imgs.length && recent && prov().vision) msgs.push({ role: 'user', content: [{ type: 'text', text: 'Screenshot from the tool above:' }, ...imgs.map(c => ({ type: 'image_url', image_url: { url: `data:${c.mimeType};base64,${c.data}` } }))] });
    }
  }
  return { model: modelName(), messages: msgs, tools: tools.map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.inputSchema } })), tool_choice: 'auto' };
}

async function callModel() {
  const p = prov(), tools = await getTools(), sys = await systemPrompt();
  const url = provUrl();
  if (!url) throw new Error('Set the API address for the custom provider in Orbit settings.');
  if (!modelName()) throw new Error('Choose a model in Orbit settings.');
  if (p.kind === 'anthropic') {
    const r = await window.app.llm({ url, headers: { 'anthropic-version': '2023-06-01' }, body: toAnthropic(sys, tools), keyName: 'key.' + orbit.provider, keyHeader: 'x-api-key', keyPrefix: '' });
    if (!r.ok) throw new Error(r.error);
    const blocks = r.data.content || [];
    return { text: blocks.filter(b => b.type === 'text').map(b => b.text).join('\n').trim(), calls: blocks.filter(b => b.type === 'tool_use').map(b => ({ id: b.id, name: b.name, args: b.input || {} })) };
  }
  const extra = orbit.provider === 'openrouter' ? { 'HTTP-Referer': 'https://mininet.browser', 'X-Title': 'MiniNet Browser' } : {};
  const r = await window.app.llm({ url, headers: extra, body: toOpenAI(sys, tools), keyName: p.key ? 'key.' + orbit.provider : null });
  if (!r.ok) {
    if (orbit.provider === 'ollama' && /fetch failed|ECONNREFUSED/i.test(r.error)) throw new Error('Ollama is not running. Start Ollama on this computer (and pull a model that supports tools, e.g. "ollama pull qwen2.5:7b").');
    throw new Error(r.error);
  }
  const msg = (r.data.choices && r.data.choices[0] && r.data.choices[0].message) || {};
  return {
    text: (msg.content || '').trim(),
    calls: (msg.tool_calls || []).map((c, i) => { let a = {}; try { a = JSON.parse(c.function.arguments || '{}'); } catch {} return { id: c.id || ('call_' + Date.now() + i), name: c.function.name, args: a }; })
  };
}

async function sendOrbit(textOverride) {
  if (running) return;
  const ta = $('#oText');
  const text = (textOverride || (ta && ta.value) || '').trim();
  if (!text) return;
  if (prov().key && !(await window.app.secretHas('key.' + orbit.provider))) { toast('Add your ' + prov().name + ' API key first'); return renderOrbitSettings($('#panelBody')); }
  if (ta) ta.value = '';
  convo.push({ role: 'user', text });
  running = true; abortFlag = false; paintConvo();
  let finalText = '';
  try {
    for (let step = 0; step < 40; step++) {
      if (abortFlag) { convo.push({ role: 'error', text: 'Stopped.' }); break; }
      const res = await callModel();
      const msg = { role: 'assistant', text: res.text, calls: res.calls.map(c => ({ ...c, status: 'run' })) };
      convo.push(msg); paintConvo();
      if (res.text) finalText = res.text;
      if (!res.calls.length) break;
      const results = [];
      for (const c of msg.calls) {
        if (abortFlag) { results.push({ id: c.id, name: c.name, content: [{ type: 'text', text: 'Stopped by user' }], isError: true }); c.status = 'err'; continue; }
        const r = await window.app.agentCall(c.name, c.args, 'Orbit');
        c.status = r.ok && !r.result.isError ? 'ok' : 'err';
        results.push({ id: c.id, name: c.name, content: r.ok ? r.result.content : [{ type: 'text', text: 'Error: ' + r.error }], isError: !r.ok });
        paintConvo();
      }
      convo.push({ role: 'tool', results });
    }
  } catch (e) {
    convo.push({ role: 'error', text: e.message });
  }
  running = false; paintConvo();
  if (orbit.speak && finalText) speak(finalText);
}

function renderOrbitSettings(body) {
  body.className = '';
  body.style.padding = '';
  const p = prov();
  body.innerHTML = `
    <div class="set"><b>AI provider</b><small>Orbit uses your own account — your key is stored encrypted on this computer only.</small>
      <select class="inp" id="osProv">${Object.entries(PROVIDERS).map(([k, v]) => `<option value="${k}" ${orbit.provider === k ? 'selected' : ''}>${v.name}</option>`).join('')}</select>
      <label style="display:block">Model<input class="inp" id="osModel" value="${esc(modelName())}" placeholder="model name"></label>
      ${orbit.provider === 'custom' || orbit.provider === 'ollama' ? `<label style="display:block">API address<input class="inp" id="osUrl" value="${esc(provUrl())}" placeholder="https://…/v1/chat/completions"></label>` : ''}
      ${p.key ? `<label style="display:block">API key <span id="osHas" style="color:var(--dim)"></span><input class="inp" id="osKey" type="password" placeholder="paste your key"></label>
        <small>Get a key at ${esc(p.keyHelp)}</small>` : `<small>No key needed. Install Ollama, then run <code>ollama pull ${esc(modelName())}</code>. Pick a model that supports tools (qwen2.5, llama3.1, mistral-nemo).</small>`}
    </div>
    <div class="set"><b>Voice input</b><small>Talking to Orbit needs a Groq, OpenAI or Gemini key.</small>
      <select class="inp" id="osVoice"><option value="auto">Automatic</option><option value="groq" ${orbit.voice === 'groq' ? 'selected' : ''}>Groq Whisper (key from Groq)</option><option value="openai" ${orbit.voice === 'openai' ? 'selected' : ''}>OpenAI Whisper (key from OpenAI)</option><option value="gemini" ${orbit.voice === 'gemini' ? 'selected' : ''}>Gemini (key from Google)</option></select></div>
    <div class="set"><b>Custom instructions</b><small>Anything Orbit should always know or do.</small>
      <textarea class="inp" id="osInst" style="font:inherit;min-height:80px">${esc(orbit.instructions)}</textarea></div>
    <button class="btn sun wide" id="osSave">Save</button>
    <button class="btn wide" id="osBack">Back to chat</button>`;
  if (p.key) window.app.secretHas('key.' + orbit.provider).then(h => { const el = $('#osHas'); if (el) el.textContent = h ? '· saved ✓ (leave empty to keep)' : '· not set'; });
  $('#osProv').onchange = e => { orbit.provider = e.target.value; saveOrbit(); toolDefs = null; renderOrbitSettings(body); };
  $('#osSave').onclick = async () => {
    orbit.models[orbit.provider] = $('#osModel').value.trim();
    if ($('#osUrl')) orbit.urls[orbit.provider] = $('#osUrl').value.trim();
    orbit.voice = $('#osVoice').value; orbit.instructions = $('#osInst').value.trim();
    const k = $('#osKey') && $('#osKey').value.trim();
    if (k) await window.app.secretSet('key.' + orbit.provider, k);
    saveOrbit(); toast('Orbit settings saved'); renderOrbit(body);
  };
  $('#osBack').onclick = () => renderOrbit(body);
}

/* voice input */
let rec = null, chunks = [];
async function toggleMic() {
  const btn = $('#oMic');
  if (rec && rec.state === 'recording') { rec.stop(); return; }
  let which = orbit.voice;
  if (which === 'auto') which = ['groq', 'openai', 'gemini'].includes(orbit.provider) ? orbit.provider : (await window.app.secretHas('key.groq')) ? 'groq' : (await window.app.secretHas('key.openai')) ? 'openai' : (await window.app.secretHas('key.gemini')) ? 'gemini' : null;
  if (!which) { toast('Voice needs a Groq, OpenAI or Gemini key — add one in Orbit settings'); return; }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    rec = new MediaRecorder(stream); chunks = [];
    rec.ondataavailable = e => chunks.push(e.data);
    rec.onstop = async () => {
      stream.getTracks().forEach(t => t.stop()); btn && btn.classList.remove('rec');
      const blob = new Blob(chunks, { type: 'audio/webm' });
      toast('Listening done — transcribing…');
      let r;
      if (which === 'gemini') r = await geminiTranscribe(blob);
      else {
        const cfg = which === 'groq' ? { url: 'https://api.groq.com/openai/v1/audio/transcriptions', model: 'whisper-large-v3-turbo' } : { url: 'https://api.openai.com/v1/audio/transcriptions', model: 'whisper-1' };
        r = await window.app.transcribe({ ...cfg, keyName: 'key.' + which, audio: new Uint8Array(await blob.arrayBuffer()), mime: 'audio/webm' });
      }
      if (!r.ok) return toast('Voice: ' + r.error);
      if (r.text.trim()) sendOrbit(r.text.trim());
    };
    rec.start(); btn && btn.classList.add('rec'); toast('Listening… press the mic again to send');
  } catch (e) { toast('Microphone not available: ' + e.message); }
}
// Gemini listens to audio directly: convert the recording to 16 kHz mono WAV and ask it for a transcript
async function toWavBase64(blob) {
  const ctx = new AudioContext();
  const buf = await ctx.decodeAudioData(await blob.arrayBuffer());
  const rate = 16000, len = Math.ceil(buf.duration * rate);
  const off = new OfflineAudioContext(1, len, rate);
  const src = off.createBufferSource(); src.buffer = buf; src.connect(off.destination); src.start();
  const pcm = (await off.startRendering()).getChannelData(0);
  const out = new DataView(new ArrayBuffer(44 + pcm.length * 2));
  const w = (o, str) => [...str].forEach((c, i) => out.setUint8(o + i, c.charCodeAt(0)));
  w(0, 'RIFF'); out.setUint32(4, 36 + pcm.length * 2, true); w(8, 'WAVE'); w(12, 'fmt ');
  out.setUint32(16, 16, true); out.setUint16(20, 1, true); out.setUint16(22, 1, true); out.setUint32(24, rate, true);
  out.setUint32(28, rate * 2, true); out.setUint16(32, 2, true); out.setUint16(34, 16, true); w(36, 'data'); out.setUint32(40, pcm.length * 2, true);
  for (let i = 0; i < pcm.length; i++) out.setInt16(44 + i * 2, Math.max(-1, Math.min(1, pcm[i])) * 0x7fff, true);
  ctx.close();
  let bin = ''; const bytes = new Uint8Array(out.buffer);
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
async function geminiTranscribe(blob) {
  try {
    const data = await toWavBase64(blob);
    const r = await window.app.llm({ url: PROVIDERS.gemini.url, keyName: 'key.gemini', body: { model: orbit.models.gemini || PROVIDERS.gemini.model,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Transcribe this audio exactly. Reply with only the words spoken, nothing else.' }, { type: 'input_audio', input_audio: { data, format: 'wav' } }] }] } });
    if (!r.ok) return { ok: false, error: r.error };
    return { ok: true, text: ((r.data.choices && r.data.choices[0].message.content) || '').trim() };
  } catch (e) { return { ok: false, error: e.message }; }
}

window.app.on('ask-orbit', text => { showPanel('orbit'); setTimeout(() => { $('#oText').value = 'About this: "' + text.slice(0, 2000) + '"\n'; $('#oText').focus(); }, 60); });

/* ================= Connect AI agents ================= */
PANELS.agents = { title: 'AI control', render: renderAgents };
async function renderAgents(body) {
  body.className = '';
  const c = await window.app.agentConfig();
  const m = await window.app.mcpConfigs();
  body.innerHTML = `
    <div class="set"><label>Let AI agents control this browser <input type="checkbox" class="tog" id="agOn" ${c.enabled ? 'checked' : ''}></label>
      <small>${c.enabled ? (c.running ? `<span class="ok">● Running</span> on ${esc(c.url)} — only programs on this computer with your secret key can connect.` : '<span class="bad">● Not running</span>') : 'Off — no AI can control the browser.'}</small>
      <button class="btn wide" id="agPause" style="margin-top:8px">${c.paused ? '▶ Resume AI control' : '⏸ Pause all AI control'}</button></div>

    <div class="set"><b>Before an AI starts</b>
      <select class="inp" id="agMode"><option value="ask" ${c.mode !== 'auto' ? 'selected' : ''}>Ask me first — once I allow its plan, it carries on by itself</option><option value="auto" ${c.mode === 'auto' ? 'selected' : ''}>Don't ask — any connected AI can act straight away</option></select>
      <small>Orbit never needs approval: what you type to it is your permission.</small>
      ${c.approved.length ? '<div style="margin-top:8px">' + c.approved.map(a => `<div class="pi"><div class="tx"><div>✓ ${esc(a.client)}</div><small>${esc(a.plan || 'allowed')}</small></div><button class="btn sm" data-revoke="${esc(a.client)}">Revoke</button></div>`).join('') + '</div>' : ''}</div>

    <div class="set"><b>🌍 Connector link — Claude.ai, ChatGPT &amp; any AI on the internet</b>
      <small>Creates a private, secure web link to this browser so cloud AIs can use it as their browser. Paste it into Claude → Customize → Connectors → Add custom connector (or ChatGPT → Settings → Connectors). Approval cards still protect you.</small>
      <div id="tunBox"></div></div>

    <div class="set"><b>Claude Desktop</b><small>One click adds MiniNet Browser to Claude's tools. Restart Claude afterwards.</small>
      <button class="btn sun wide" id="agClaude">Connect Claude Desktop</button></div>

    <div class="set"><b>Claude Code</b><small>Run this once in a terminal:</small>
      <div class="codebox">${esc(m.claudeCode.replace(c.token, '<your-key>'))}</div><button class="btn sm" data-copy-raw="${esc(m.claudeCode)}">Copy</button></div>

    <div class="set"><b>Cursor, Windsurf, Codex &amp; other MCP apps</b><small>Add this to the app's MCP settings:</small>
      <div class="codebox" id="agJson">${esc(JSON.stringify(m.stdio, null, 2))}</div><button class="btn sm" data-copy="agJson">Copy</button>
      <small style="margin-top:8px">Or connect over HTTP: <code>${esc(m.http.url)}</code> with header <code>Authorization: Bearer &lt;key&gt;</code></small></div>

    <div class="set"><b>ChatGPT &amp; your own scripts</b><small>Use Orbit with your OpenAI key, or call the HTTP API from any program or agent:</small>
      <div class="codebox">${esc(m.curl.replace(c.token, '<your-key>'))}</div><button class="btn sm" data-copy-raw="${esc(m.curl)}">Copy</button></div>

    <div class="set"><b>Secret key</b><small>Anyone with this key on your computer can drive the browser. Keep it private.</small>
      <div class="codebox" id="agTok">${'•'.repeat(24)}</div>
      <button class="btn sm" id="agShow">Show</button> <button class="btn sm" data-copy-raw="${esc(c.token)}">Copy</button> <button class="btn sm" id="agNew">Make a new key</button>
      <label style="margin-top:10px">Port <input class="inp" id="agPort" value="${c.port}" style="width:90px;margin:0"></label></div>

    <div class="set" style="border:0"><b>Recent AI activity</b><div id="agLog"></div></div>
    <div class="set" style="border:0"><b>What AI can do here</b><small id="agTools"></small>
      <small style="margin-top:6px">AI can control web pages, tabs and extensions. It can never change MiniNet Browser's own code, read your files, or open local file:// pages.</small></div>`;
  $('#agOn').onchange = async e => { await window.app.agentConfig({ enabled: e.target.checked }); setTimeout(() => showPanel('agents'), 300); };
  $('#agPause').onclick = () => window.app.agentPause(!c.paused);
  $('#agMode').onchange = async e => { await window.app.agentConfig({ mode: e.target.value }); toast(e.target.value === 'auto' ? 'AIs can now act without asking' : 'AIs will ask you first'); };
  body.querySelectorAll('[data-revoke]').forEach(b => b.onclick = async () => { await window.app.agentConfig({ revoke: b.dataset.revoke }); showPanel('agents'); });
  $('#agClaude').onclick = async () => { try { const r = await window.app.connectClaudeDesktop(); toast('Done! Restart Claude Desktop to use MiniNet Browser.'); } catch (e) { toast('Could not update Claude config: ' + e.message); } };
  body.querySelectorAll('[data-copy]').forEach(b => b.onclick = () => { window.app.copy($('#' + b.dataset.copy).textContent); toast('Copied'); });
  body.querySelectorAll('[data-copy-raw]').forEach(b => b.onclick = () => { window.app.copy(b.dataset.copyRaw); toast('Copied'); });
  $('#agShow').onclick = () => { $('#agTok').textContent = c.token; };
  $('#agNew').onclick = async () => { if (confirm('Make a new key? Apps using the old key will need the new one (Claude Desktop updates automatically).')) { await window.app.agentConfig({ regenerate: true }); showPanel('agents'); } };
  $('#agPort').onchange = async e => { await window.app.agentConfig({ port: +e.target.value }); setTimeout(() => showPanel('agents'), 300); };
  paintTunnel(await window.app.tunnel('status'), c.token);
  window.app.agentTools().then(t => { const el = $('#agTools'); if (el) el.textContent = t.map(x => x.name).join(' · '); });
  renderAgentLog();
}
let tunState = { status: 'off' };
function paintTunnel(t, token) {
  tunState = t || tunState;
  const box = $('#tunBox'); if (!box) return;
  const tk = token || box.dataset.token || ''; box.dataset.token = tk;
  const t2 = tunState;
  if (t2.status === 'on' && t2.url) {
    const link = `${t2.url}/t/${tk}/mcp`;
    box.innerHTML = `<div class="codebox">${esc(t2.url)}/t/••••••/mcp</div>
      <button class="btn sun sm" id="tunCopy">Copy connector link</button> <button class="btn sm" id="tunStop">Turn off</button>
      <small style="margin-top:8px">In Claude: <b>Customize → Connectors → + Add → Add custom connector</b>, name it "MiniNet Browser", paste the link, choose <b>No sign in</b>. The link changes each time you turn it on — paste the new one when it does.</small>`;
    $('#tunCopy').onclick = () => { window.app.copy(link); toast('Connector link copied — keep it private'); };
    $('#tunStop').onclick = () => window.app.tunnel('stop');
  } else if (t2.status === 'downloading') box.innerHTML = `<small>Downloading the secure tunnel tool (one time)… ${t2.progress || 0}%</small><div class="bar"><b style="width:${t2.progress || 0}%"></b></div>`;
  else if (t2.status === 'starting') box.innerHTML = '<small>Opening a secure link…</small>';
  else {
    box.innerHTML = `${t2.error ? `<small class="bad">${esc(t2.error)}</small>` : ''}<button class="btn sun wide" id="tunStart">Create connector link</button>`;
    $('#tunStart').onclick = () => window.app.tunnel('start');
  }
}
window.app.on('tunnel', t => { tunState = t; paintTunnel(t); if (t.status === 'on' && panelOpen !== 'agents') toast('Connector link is ready — open AI control to copy it'); });

async function renderAgentLog() {
  const el = $('#agLog'); if (!el) return;
  const log = await window.app.agentLog();
  el.innerHTML = log.length ? log.slice(0, 30).map(l => `<div class="pi"><div class="tx"><div>${esc(l.client)} · ${esc(l.summary)}</div><small>${new Date(l.t).toLocaleTimeString()} ${l.ok === false ? '<span class="bad">✗ ' + esc(l.error || '') + '</span>' : l.ok ? '<span class="ok">✓</span>' : '…'}</small></div></div>`).join('')
    : '<small>Nothing yet. When an AI uses the browser, every step shows up here.</small>';
}

/* ================= Extensions ================= */
PANELS.extensions = { title: 'Extensions', render: renderExtensions };
async function renderExtensions(body) {
  body.className = '';
  const list = await window.app.ext('list');
  body.innerHTML = `
    <button class="btn sun wide" id="exAi">✨ Ask Orbit to build an extension</button>
    <div class="orow" style="margin:4px 0 10px"><button class="btn sm" id="exNew">+ New</button><button class="btn sm" id="exImp">Import folder</button><button class="btn sm" id="exDir">Open folder</button></div>
    ${list.length ? list.map(e => `<div class="ext"><div class="row"><b style="flex:1">${esc(e.name)}</b><input type="checkbox" class="tog" data-tog="${esc(e.id)}" ${e.enabled ? 'checked' : ''}></div>
      <small>${esc(e.description || 'No description')}</small><small>v${esc(e.version)} · ${esc(e.author || 'you')} · runs on ${esc(e.matches.join(', '))}</small>
      <div class="acts"><button class="btn sm" data-edit="${esc(e.id)}">Edit</button><button class="btn sm" data-ai="${esc(e.id)}">Improve with Orbit</button><button class="btn sm" data-del="${esc(e.id)}">Delete</button></div></div>`).join('')
      : '<p style="color:var(--dim)">No extensions yet.</p>'}
    <small style="color:var(--dim);display:block;margin-top:10px">Extensions change how websites look and work. They live in your own folder, separate from the browser's core.</small>`;
  $('#exAi').onclick = () => { showPanel('orbit'); setTimeout(() => { $('#oText').value = 'Build me an extension that '; $('#oText').focus(); }, 60); };
  $('#exNew').onclick = () => editExtension(body, null);
  $('#exImp').onclick = async () => { try { const r = await window.app.ext('import'); if (r) { toast('Imported ' + r.name); renderExtensions(body); } } catch (e) { toast(e.message); } };
  $('#exDir').onclick = () => window.app.ext('folder');
  body.querySelectorAll('[data-tog]').forEach(t => t.onchange = async () => { await window.app.ext('toggle', { id: t.dataset.tog, enabled: t.checked }); toast(t.checked ? 'On — reload pages to apply' : 'Off'); });
  body.querySelectorAll('[data-edit]').forEach(b => b.onclick = () => editExtension(body, b.dataset.edit));
  body.querySelectorAll('[data-ai]').forEach(b => b.onclick = () => { showPanel('orbit'); setTimeout(() => { $('#oText').value = `Improve my extension "${b.dataset.ai}" (read it with get_extension first): `; $('#oText').focus(); }, 60); });
  body.querySelectorAll('[data-del]').forEach(b => b.onclick = async () => { if (confirm('Delete this extension?')) { await window.app.ext('remove', { id: b.dataset.del }); renderExtensions(body); } });
}
async function editExtension(body, id) {
  const e = id ? await window.app.ext('get', { id }) : { name: '', description: '', matches: ['<all_urls>'], js: '// Runs on every matching page after it loads\n', css: '' };
  body.innerHTML = `
    <label>Name<input class="inp" id="eName" value="${esc(e.name)}"></label>
    <label>Description<input class="inp" id="eDesc" value="${esc(e.description || '')}"></label>
    <label>Runs on (one pattern per line, e.g. *://*.youtube.com/* or mini://*)<textarea class="inp" id="eMatch" style="min-height:60px">${esc((e.matches || []).join('\n'))}</textarea></label>
    <label>JavaScript (content.js)<textarea class="inp" id="eJs" style="min-height:200px">${esc(e.js || '')}</textarea></label>
    <label>CSS (content.css)<textarea class="inp" id="eCss">${esc(e.css || '')}</textarea></label>
    <button class="btn sun wide" id="eSave">Save extension</button><button class="btn wide" id="eBack">Cancel</button>`;
  $('#eSave').onclick = async () => {
    const name = $('#eName').value.trim(); if (!name) return toast('Give it a name');
    await window.app.ext('save', { data: { id: e.id, name, description: $('#eDesc').value.trim(), matches: $('#eMatch').value.split('\n').map(s => s.trim()).filter(Boolean), js: $('#eJs').value, css: $('#eCss').value, author: e.author || 'you' } });
    toast('Saved — reload a page to see it'); renderExtensions(body);
  };
  $('#eBack').onclick = () => renderExtensions(body);
}
