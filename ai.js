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
  <small>Once allowed, it carries on by itself — signing in, accepting cookies, clicking Continue. <b>Always allow</b> means it never has to ask again (change it any time in AI control). You can press Stop AI whenever you like.</small>
  <input placeholder="Optional message to the AI">
  <div class="acts"><button class="btn sun" data-a="always">Always allow</button><button class="btn" data-a="allow">Just this time</button><button class="btn" data-a="deny">Deny</button></div>`,
  (el, done) => {
    const msg = () => el.querySelector('input').value.trim();
    el.querySelector('[data-a=always]').onclick = () => done({ allow: true, always: true, reason: msg() });
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
  deepseek: { name: 'DeepSeek', kind: 'openai', url: 'https://api.deepseek.com/chat/completions', model: 'deepseek-flash', key: true, vision: false, keyHelp: 'platform.deepseek.com' },
  kimi: { name: 'Kimi (Moonshot AI)', kind: 'openai', url: 'https://api.moonshot.ai/v1/chat/completions', model: 'kimi-k3', key: true, vision: false, keyHelp: 'platform.moonshot.ai' },
  qwen: { name: 'Qwen (Alibaba Model Studio)', kind: 'openai', url: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions', model: 'qwen-plus', key: true, vision: false, keyHelp: 'modelstudio.console.alibabacloud.com' },
  mistral: { name: 'Mistral', kind: 'openai', url: 'https://api.mistral.ai/v1/chat/completions', model: 'mistral-large-latest', key: true, vision: false, keyHelp: 'console.mistral.ai' },
  xai: { name: 'Grok (xAI)', kind: 'openai', url: 'https://api.x.ai/v1/chat/completions', model: 'grok-4', key: true, vision: true, keyHelp: 'console.x.ai' },
  lmstudio: { name: 'LM Studio (free, on this computer)', kind: 'openai', url: 'http://localhost:1234/v1/chat/completions', model: 'local-model', key: false, vision: false, keyHelp: 'lmstudio.ai' },
  ollama: { name: 'Ollama (free, runs on this computer)', kind: 'openai', url: 'http://localhost:11434/v1/chat/completions', model: 'qwen2.5:7b', key: false, vision: false, keyHelp: 'ollama.com' },
  custom: { name: 'Custom (OpenAI-compatible)', kind: 'openai', url: '', model: '', key: true, vision: false, keyHelp: '' }
};
const orbit = Object.assign({ provider: 'ollama', models: {}, urls: {}, speak: false, instructions: '', voice: 'auto', backups: [] }, load('orbit', {}));
function saveOrbit() { store('orbit', orbit); }
function prov(pk = orbit.provider) { return PROVIDERS[pk] || PROVIDERS.ollama; }
function modelName(pk = orbit.provider) { return orbit.models[pk] || prov(pk).model; }
function provUrl(pk = orbit.provider) { return orbit.urls[pk] || prov(pk).url; }

let convo = load('orbitChat', []);   // the chat survives closing the browser (pictures are left out to keep it small)
let saveChatT = 0;
function saveChat() { clearTimeout(saveChatT); saveChatT = setTimeout(() => { try { const slim = convo.slice(-80).map(m => m.role !== 'tool' ? m : { ...m, results: m.results.map(r => ({ ...r, content: r.content.map(c => c.type === 'image' ? { type: 'text', text: '[screenshot]' } : { ...c, text: String(c.text || '').slice(0, 4000) }) })) }); store('orbitChat', slim); } catch {} }, 400); }
let _unused = [];          // neutral format: {role:'user',text} | {role:'assistant',text,calls:[]} | {role:'tool',results:[]}
let running = false, abortFlag = false, toolDefs = null;
function orbitAbort() { abortFlag = true; }

PANELS.orbit = { title: 'Orbit', wide: true, render: renderOrbit };
function renderOrbit(body) {
  body.className = 'chat';
  body.innerHTML = `<div id="oTeam" style="display:none"></div><div id="oMsgs"></div>
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
  paintConvo(); paintHelpers();
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
  saveChat();
  const box = $('#oMsgs'); if (!box) return;
  if (!convo.length) {
    box.innerHTML = `<div class="oHello"><img src="icon.png"><b>Hi, I'm Orbit</b>I can browse, click, type, shop, post and build for you — on the real web and inside MiniNet.
      <div class="chips">${['🎬 Make a short video: create an image in Google Flow, turn it into a video, then edit it in CapCut with a title and save it to my Downloads', '💡 Brainstorm ways I could earn online with my skills, research which are real today, and tell me which you can set up for me in this browser', 'Summarize this page', 'Find the top story on Hacker News and summarize it', 'Search YouTube for afrobeats mixes', 'Build an extension that adds a dark mode to every site'].map(c => `<span class="chip">${c}</span>`).join('')}</div></div>`;
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
    if (m.role === 'note') html += `<div class="step" style="opacity:.85">${esc(m.text)}</div>`;
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

async function systemPrompt(pk = orbit.provider) {
  if (LOCAL_BRAINS.has(pk)) return localPrompt();
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

// Short prompt for small local models (they read every token slowly on a laptop CPU)
function localPrompt() {
  // keep this text identical between steps so the local model can reuse its cache (no changing tab info here)
  return `You are Orbit, an assistant that uses the user's web browser with tools.
Steps: open_tab or navigate to a site, snapshot to see numbered elements, click/type using ref numbers, read_text to read (read_text with find:"word" shows just the lines about that word). Your own tab is already open — use it; do not open new tabs. To search the web: navigate with url set to the search words (e.g. url:"1 dollar to naira"). To search inside a site: type in its search box with submit:true. After each move you get the start of the page text; use read_text with find for the rest.
Rules: every fact in your answer (names, numbers, titles, prices) must be copied exactly from a tool result in this task — never from memory, never guessed. If you could not find it, say "I could not find it" and why.
Do the whole task yourself, then answer in one or two short sentences.
${orbit.instructions ? 'User notes: ' + orbit.instructions : ''}`;
}
async function getTools() { if (!toolDefs) toolDefs = await window.app.agentTools(); return toolDefs; }
function contentText(content) { return (content || []).filter(c => c.type === 'text').map(c => c.text).join('\n'); }

function toAnthropic(sys, tools, convo, pk = orbit.provider) {
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
  return { model: modelName(pk), max_tokens: 4096, system: sys, tools: tools.map(t => ({ name: t.name, description: t.description, input_schema: t.inputSchema })), messages: msgs };
}
function toOpenAI(sys, tools, convo, pk = orbit.provider) {
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
        let t = contentText(r.content); if (!recent) t = t.slice(0, 1500); else if (LOCAL_BRAINS.has(pk) && t.length > 3500) t = t.slice(0, 3500) + '\n[… cut to fit a local model — use read_text with offset for more]';
        msgs.push({ role: 'tool', tool_call_id: r.id, content: (r.isError ? 'ERROR: ' : '') + (t || 'done') });
        r.content.filter(c => c.type === 'image').forEach(c => imgs.push(c));
      }
      if (imgs.length && recent && prov(pk).vision) msgs.push({ role: 'user', content: [{ type: 'text', text: 'Screenshot from the tool above:' }, ...imgs.map(c => ({ type: 'image_url', image_url: { url: `data:${c.mimeType};base64,${c.data}` } }))] });
    }
  }
  return { model: modelName(pk), messages: msgs, tools: tools.map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.inputSchema } })), tool_choice: 'auto', ...(LOCAL_BRAINS.has(pk) ? { max_tokens: 700, temperature: 0.2 } : {}) };
}

// Local Ollama: if the chosen model isn't installed, use the best installed model that can use tools
let ollamaChecked = 0;
async function ollamaPick() {
  if (Date.now() - ollamaChecked < 60000) return; ollamaChecked = Date.now();
  try {
    const base = provUrl('ollama').replace(/\/v1\/chat\/completions.*$/, '');
    const r = await window.app.llm({ url: base + '/api/tags', method: 'GET' });
    const names = ((r.ok && r.data && r.data.models) || []).map(m => m.name);
    if (!names.length) return;
    const tuned = names.find(n => /^orbit-/.test(n));   // a model set up for MiniNet (sized context) wins
    if (tuned && modelName('ollama') !== tuned) { orbit.models.ollama = tuned; saveOrbit(); toast('Orbit is using your local model ' + tuned); return; }
    if (names.includes(modelName('ollama')) || names.includes(modelName('ollama') + ':latest')) return;
    const pref = [/^qwen3/, /^qwen2\.5/, /^llama3\.[123]/, /^mistral/, /^gemma3/, /^granite/, /^phi4/, /./];
    for (const p of pref) { const m = names.find(n => p.test(n) && !/embed/i.test(n)); if (m) { orbit.models.ollama = m; saveOrbit(); toast('Orbit is using your local model ' + m); return; } }
  } catch {}
}
const LOCAL_BRAINS = new Set(['ollama', 'lmstudio']);
const LITE_TOOLS = new Set(['open_tab', 'navigate', 'go_back', 'snapshot', 'read_text', 'click', 'type', 'press_key', 'scroll', 'ask_user', 'get_email_code']);
// Ask one brain (provider) for the next step
async function callBrain(pk, cv, sysExtra = '', exclude = null) {
  const p = prov(pk), sys = (await systemPrompt(pk)) + (sysExtra ? '\n' + sysExtra : '');
  let tools = await getTools(); if (exclude) tools = tools.filter(t => !exclude.has(t.name));
  if (LOCAL_BRAINS.has(pk)) tools = tools.filter(t => LITE_TOOLS.has(t.name)).map(t => ({ ...t, description: t.description.split(/(?<=\.)\s/)[0].slice(0, 140),
    inputSchema: { ...t.inputSchema, properties: Object.fromEntries(Object.entries(t.inputSchema.properties || {}).map(([k, v]) => [k, { type: v.type, ...(v.items ? { items: v.items } : {}), ...(v.enum ? { enum: v.enum } : {}) }])) } }));   // small local models: fewer, shorter tools
  const url = provUrl(pk);
  if (!url) throw new Error('Set the API address for the custom provider in Orbit settings.');
  if (!modelName(pk)) throw new Error('Choose a model in Orbit settings.');
  if (p.kind === 'anthropic') {
    const r = await window.app.llm({ url, headers: { 'anthropic-version': '2023-06-01' }, body: toAnthropic(sys, tools, cv, pk), keyName: 'key.' + pk, keyHeader: 'x-api-key', keyPrefix: '' });
    if (!r.ok) throw new Error(r.error);
    const blocks = r.data.content || [];
    return { text: blocks.filter(b => b.type === 'text').map(b => b.text).join('\n').trim(), calls: blocks.filter(b => b.type === 'tool_use').map(b => ({ id: b.id, name: b.name, args: b.input || {} })) };
  }
  if (pk === 'ollama') await ollamaPick();
  const extra = pk === 'openrouter' ? { 'HTTP-Referer': 'https://mininet.browser', 'X-Title': 'MiniNet Browser' } : {};
  const r = await window.app.llm({ url, headers: extra, body: toOpenAI(sys, tools, cv, pk), keyName: p.key ? 'key.' + pk : null, timeoutMs: LOCAL_BRAINS.has(pk) ? 900000 : 180000 });
  if (!r.ok) {
    if ((pk === 'ollama' || pk === 'lmstudio') && /timed out/i.test(r.error)) throw new Error(p.name.split(' (')[0] + ' took too long to answer (' + r.error + '). The page may be too big for the local model — try a smaller step.');
    if ((pk === 'ollama' || pk === 'lmstudio') && /ECONNREFUSED/i.test(r.error)) throw new Error(p.name.split(' (')[0] + ' is not running. Start it on this computer (and pull a model that supports tools, e.g. "ollama pull qwen2.5:7b").');
    throw new Error(r.error);
  }
  const msg = (r.data.choices && r.data.choices[0] && r.data.choices[0].message) || {};
  return {
    text: (msg.content || '').trim(),
    calls: (msg.tool_calls || []).map((c, i) => { let a = {}; try { a = JSON.parse(c.function.arguments || '{}'); } catch {} return { id: c.id || ('call_' + Date.now() + i), name: c.function.name, args: a }; })
  };
}

async function anyBrainReady() { for (const k of [orbit.provider, ...(orbit.backups || [])]) { if (!PROVIDERS[k]) continue; if (!prov(k).key || await window.app.secretHas('key.' + k)) return true; } return false; }
/* Brain router: try the main brain, and if it is out of quota, offline or failing, switch to the next backup brain.
   A brain that failed rests for a while (longer for quota limits) before it is tried again. */
const brainRest = new Map();   // provider -> { until, why }
function classifyFail(msg) {
  const m = String(msg || '');
  if (/429|quota|rate.?limit|resource.?exhausted|too many requests|insufficient.?(credit|balance|funds)|billing/i.test(m)) return { kind: 'free limit reached', rest: 15 * 60e3 };
  if (/401|403|invalid.*key|unauthori[sz]ed|permission|no api key/i.test(m)) return { kind: 'key refused', rest: 60 * 60e3 };
  if (/not running|fetch failed|ECONN|ENOTFOUND|network|timed? ?out|socket|EAI_AGAIN/i.test(m)) return { kind: 'not reachable', rest: 60e3 };
  if (/\b5\d\d\b|overloaded|unavailable|internal server/i.test(m)) return { kind: 'overloaded', rest: 2 * 60e3 };
  if (/model.*(not found|does not exist|not supported)|no such model|tool.*not supported|does not support tools/i.test(m)) return { kind: 'model unavailable', rest: 30 * 60e3 };
  return null;   // a real error in the request — don't hide it by switching
}
function brainOrder() {
  const list = [orbit.provider, ...(orbit.backups || [])].filter((k, i, a) => PROVIDERS[k] && a.indexOf(k) === i);
  const now = Date.now(), ready = list.filter(k => !(brainRest.get(k) && brainRest.get(k).until > now));
  return ready.length ? ready : list;   // all resting? try them anyway
}
async function callModel(cv = convo, sysExtra = '', exclude = null) {
  const order = brainOrder();
  let lastErr = null; const errs = [];
  for (let i = 0; i < order.length; i++) {
    const pk = order[i];
    if (prov(pk).key && !(await window.app.secretHas('key.' + pk))) { lastErr = new Error(prov(pk).name + ' has no API key'); continue; }
    try {
      const res = await callBrain(pk, cv, sysExtra, exclude);
      brainRest.delete(pk);
      if (pk !== orbit.provider) res.brain = pk;
      return res;
    } catch (e) {
      lastErr = e; errs.push(prov(pk).name.split(' (')[0] + ': ' + e.message);
      const c = classifyFail(e.message);
      if (!c || i === order.length - 1) break;
      brainRest.set(pk, { until: Date.now() + c.rest, why: c.kind });
      const next = order[i + 1];
      cv.push({ role: 'note', text: `🧠 ${prov(pk).name.split(' (')[0]}: ${c.kind} — switching to ${prov(next).name.split(' (')[0]}.` });
      if (cv === convo) paintConvo();
    }
  }
  if (errs.length > 1) throw new Error(errs.join('  •  '));
  throw lastErr || new Error('No AI brain is available. Add a key or start Ollama in Orbit settings.');
}

// One agent loop, shared by Orbit and its helper agents
// Which facts in an answer (numbers, "quoted" names, version numbers) never appeared in any tool result of this task
function unverified(answer, cv) {
  const seen = cv.filter(m => m.role === 'tool').flatMap(m => m.results.map(r => contentText(r.content))).join('\n').toLowerCase().replace(/[,\u00a0]/g, '');
  const task = String((cv.find(m => m.role === 'user') || {}).text || '').toLowerCase().replace(/,/g, '');
  const claims = new Set();
  for (const m of answer.matchAll(/["“]([^"”]{3,80})["”]/g)) claims.add(m[1].trim());
  for (const m of answer.matchAll(/\bv?\d[\d,]*(?:\.\d+)+\b|\b\d[\d,]{2,}\b/g)) claims.add(m[0]);
  return [...claims].filter(c => { const k = c.toLowerCase().replace(/,/g, ''); return !seen.includes(k) && !task.includes(k); }).slice(0, 5);
}
const READ_TOOLS = new Set(['read_text', 'snapshot', 'screenshot']);
const MOVE_TOOLS = new Set(['navigate', 'open_tab', 'click', 'type', 'press_key', 'go_back', 'scroll']);
async function runLoop(cv, { client = 'Orbit', owner, sysExtra = '', exclude = null, shouldStop = () => false, onPaint = () => {}, onStep = () => {}, onTrace = () => {} } = {}) {
  let finalText = '', factChecked = false, readSinceMove = true, nudges = 0;
  for (let step = 0; step < 80; step++) {
    if (shouldStop()) { cv.push({ role: 'error', text: 'Stopped.' }); break; }
    const res = await callModel(cv, sysExtra, exclude);
    const msg = { role: 'assistant', text: res.text, calls: res.calls.map(c => ({ ...c, status: 'run' })) };
    cv.push(msg); onPaint();
    if (res.text) finalText = res.text;
    if (!res.calls.length) {
      if (!readSinceMove && nudges < 2 && cv.some(m => m.role === 'tool')) {
        nudges++; onTrace({ check: 'answered without reading the page' });
        cv.push({ role: 'user', text: 'You have not read the page since your last action. Call read_text now (use find:"<key word>" for long pages), then answer from what it shows.' });
        continue;
      }
      // fact check: numbers and quoted names in the answer must appear in something a tool actually returned
      const unseen = res.text ? unverified(res.text, cv) : [];
      if (unseen.length && !factChecked) {
        factChecked = true; onTrace({ check: 'unverified: ' + unseen.join(', ') });
        cv.push({ role: 'user', text: `Check your answer: ${unseen.map(x => '"' + x + '"').join(', ')} did not appear in any page you read in this task. Do not answer yet: call read_text with find set to a key word from the task, look at what it returns, then answer only with what it shows. Only say you could not find it after you have looked.` });
        continue;
      }
      if (unseen.length) finalText = res.text + '\n\n⚠ Not confirmed on the page: ' + unseen.join(', ');
      break;
    }
    const results = [];
    for (const c of msg.calls) {
      if (shouldStop()) { results.push({ id: c.id, name: c.name, content: [{ type: 'text', text: 'Stopped by user' }], isError: true }); c.status = 'err'; continue; }
      const r = await window.app.agentCall(c.name, c.args, client, owner);
      c.status = r.ok && !r.result.isError ? 'ok' : 'err';
      if (READ_TOOLS.has(c.name) && c.status === 'ok') readSinceMove = true;
      if (MOVE_TOOLS.has(c.name) && c.status === 'ok') {
        readSinceMove = false;
        // small local models often answer without looking: show them the page text right away
        if (LOCAL_BRAINS.has(orbit.provider)) {
          let tabId = c.args && c.args.tab; try { const j = JSON.parse(contentText(r.result.content)); tabId = j.opened || j.tab || tabId; } catch {}
          await new Promise(z => setTimeout(z, 1500));
          const look = await window.app.agentCall('read_text', { ...(tabId ? { tab: tabId } : {}), length: 1800 }, client, owner);
          if (look.ok && !look.result.isError) { r.result.content = [...r.result.content, { type: 'text', text: '\nPage text now (start):\n' + contentText(look.result.content) }]; readSinceMove = true; }
        }
      }
      onTrace({ tool: c.name, args: JSON.stringify(c.args || {}).slice(0, 120), ok: c.status === 'ok', saw: (r.ok ? contentText(r.result.content) : 'Error: ' + r.error).replace(/\s+/g, ' ').slice(0, 160) });
      results.push({ id: c.id, name: c.name, content: r.ok ? r.result.content : [{ type: 'text', text: 'Error: ' + r.error }], isError: !r.ok });
      onStep(c); onPaint();
    }
    cv.push({ role: 'tool', results });
  }
  return finalText;
}

async function sendOrbit(textOverride) {
  if (running) return;
  const ta = $('#oText');
  const text = (textOverride || (ta && ta.value) || '').trim();
  if (!text) return;
  if (!(await anyBrainReady())) { toast('Add your ' + prov().name + ' API key first (or a backup brain)'); return renderOrbitSettings($('#panelBody')); }
  if (ta) ta.value = '';
  convo.push({ role: 'user', text });
  running = true; abortFlag = false; paintConvo();
  await window.app.agentRelease('Orbit');   // a new request starts from the tab you are looking at
  let finalText = '';
  try {
    finalText = await runLoop(convo, { sysExtra: 'For jobs with several independent parts (for example: edit a video, answer Instagram messages and research prices), you may start helper agents with start_helper — each works in its own tab at the same time — then use check_helpers to collect their reports. For a single job, just do it yourself.', shouldStop: () => abortFlag, onPaint: paintConvo });
  } catch (e) {
    convo.push({ role: 'error', text: e.message });
  }
  running = false; paintConvo();
  if (orbit.speak && finalText) speak(finalText);
}

/* ---------------- helper agents (a team of Orbits, each in its own tab) ---------------- */
const helpers = []; let helperSeq = 0;
const HELPER_EXCLUDE = new Set(['start_helper', 'stop_helper', 'check_helpers', 'close_other_tabs']);
function helperView(h) { return { name: h.name, task: h.task.slice(0, 300), status: h.status, tab: h.tab, steps: h.steps, seconds: Math.round(((h.ended || Date.now()) - h.t0) / 1000), started_by: h.by, report: (h.result || '').slice(0, 3000), error: h.error || undefined, trace: (h.trace || []).slice(-15) }; }
async function startHelper({ task, url, by }) {
  if (!task) throw new Error('Give the helper a task.');
  if (helpers.filter(h => h.status === 'running').length >= 8) throw new Error('8 helpers are already running — wait for some to finish (check_helpers) or stop one.');
  if (!(await anyBrainReady())) throw new Error('Helpers use the AI brains chosen in Orbit settings, and none has an API key yet. Ask the owner to add one (or pick free Ollama) in Orbit settings.');
  const n = ++helperSeq, name = 'Orbit · Helper ' + n, owner = 'helper:' + n;
  const h = { n, name, owner, task, by: by || 'Orbit', status: 'running', steps: 0, result: '', tab: null, stop: false, t0: Date.now(), trace: [], cv: [{ role: 'user', text: task }] };
  helpers.push(h);
  const r = await window.app.agentCall('open_tab', { url: url || 'https://www.google.com', background: true }, name, owner);
  if (r.ok) { try { h.tab = JSON.parse(r.result.content[0].text).opened; } catch {} }
  paintHelpers();
  const sys = `You are ${name}, a helper agent started by ${h.by}. Do only this job: ${task}
Your own tab is tab ${h.tab}. Work there (pass tab ${h.tab}, or leave tab out). Other AIs are working in other tabs at the same time — do not touch their tabs.
If the owner must sign in somewhere, use ask_user to let them, then continue. When finished, reply with a short report of what you did and what you found.`;
  runLoop(h.cv, { client: name, owner, sysExtra: sys, exclude: HELPER_EXCLUDE, shouldStop: () => h.stop, onStep: () => { h.steps++; }, onTrace: t => h.trace.push(t), onPaint: paintHelpers })
    .then(t => { h.result = t || '(finished without a report)'; h.status = h.stop ? 'stopped' : 'done'; })
    .catch(e => { h.status = 'failed'; h.error = e.message; })
    .finally(() => { h.ended = Date.now(); paintHelpers(); window.app.agentRelease(owner); toast(name + (h.status === 'done' ? ' finished' : ' ' + h.status)); });
  return { started: name, tab: h.tab, note: 'Working in the background. Use check_helpers to follow it.' };
}
AGENT_OPS.helper = async ({ op, task, url, by, name }) => {
  if (op === 'start') return startHelper({ task, url, by });
  if (op === 'list') return helpers.map(helperView);
  if (op === 'stop') { let k = 0; helpers.forEach(h => { if (h.status === 'running' && (name === 'all' || h.name.toLowerCase() === String(name).toLowerCase())) { h.stop = true; k++; } }); paintHelpers(); return { stopping: k }; }
  throw new Error('bad helper op');
};
let helpersPaintT = 0;
function paintHelpers() {
  clearTimeout(helpersPaintT);
  helpersPaintT = setTimeout(() => {
    const box = $('#oTeam'); if (!box) return;
    if (!helpers.length) { box.innerHTML = ''; box.style.display = 'none'; return; }
    box.style.display = 'block';
    box.innerHTML = `<div class="tmh"><b>Team</b><small>${helpers.filter(h => h.status === 'running').length} working</small></div>` + helpers.slice(-8).map(h => `<div class="tm">
      <span class="dot ${h.status}"></span><div class="tx"><div>${esc(h.name.replace('Orbit · ', ''))} <small>· ${h.steps} steps${h.tab ? ' · tab ' + h.tab : ''}</small></div><small title="${esc(h.task)}">${esc(h.status === 'running' ? h.task : (h.result || h.error || h.task)).slice(0, 140)}</small></div>
      ${h.tab ? `<button class="btn sm" data-ht="${h.tab}">View</button>` : ''}${h.status === 'running' ? `<button class="btn sm" data-hs="${esc(h.name)}">Stop</button>` : ''}</div>`).join('');
    box.querySelectorAll('[data-ht]').forEach(b => b.onclick = () => { const t = tabs.find(x => x.id === +b.dataset.ht); if (t) activate(t); });
    box.querySelectorAll('[data-hs]').forEach(b => b.onclick = () => AGENT_OPS.helper({ op: 'stop', name: b.dataset.hs }));
  }, 80);
}

function renderOrbitSettings(body) {
  body.className = '';
  body.style.padding = '';
  const p = prov();
  body.innerHTML = `
    <div class="set"><b>AI provider</b><small>Orbit uses your own account — your key is stored encrypted on this computer only.</small>
      <select class="inp" id="osProv">${Object.entries(PROVIDERS).map(([k, v]) => `<option value="${k}" ${orbit.provider === k ? 'selected' : ''}>${v.name}</option>`).join('')}</select>
      <label style="display:block">Model<input class="inp" id="osModel" value="${esc(modelName())}" placeholder="model name"></label>
      ${orbit.provider === 'custom' || orbit.provider === 'ollama' || orbit.provider === 'lmstudio' ? `<label style="display:block">API address<input class="inp" id="osUrl" value="${esc(provUrl())}" placeholder="https://…/v1/chat/completions"></label>` : ''}
      ${p.key ? `<label style="display:block">API key <span id="osHas" style="color:var(--dim)"></span><input class="inp" id="osKey" type="password" placeholder="paste your key"></label>
        <small>Get a key at ${esc(p.keyHelp)}</small>` : `<small>No key needed. Install Ollama, then run <code>ollama pull ${esc(modelName())}</code>. Pick a model that supports tools (qwen2.5, llama3.1, mistral-nemo).</small>`}
    </div>
    <div class="set"><b>🧠 Backup brains</b><small>If the main AI runs out of free quota, goes offline or fails, Orbit and its helpers switch to the next one automatically and carry on. Tick the ones you have set up (pick each in the list above once to add its key).</small>
      <div id="osBk">${Object.entries(PROVIDERS).filter(([k]) => k !== orbit.provider && k !== 'custom' || (k === 'custom' && orbit.urls.custom)).map(([k, v]) => `<label style="display:flex;gap:8px;align-items:center;justify-content:flex-start;text-align:left;margin:4px 0"><input type="checkbox" data-bk="${k}" ${(orbit.backups || []).includes(k) ? 'checked' : ''}> <span style="flex:1">${esc(v.name)}</span> <small style="margin:0;color:var(--dim)">${esc(modelName(k) || '')}</small></label>`).join('')}</div></div>
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
    orbit.backups = [...body.querySelectorAll('[data-bk]')].filter(x => x.checked).map(x => x.dataset.bk);
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
      ${c.approved.length ? '<div style="margin-top:8px">' + c.approved.map(a => `<div class="pi"><div class="tx"><div>✓ ${esc(a.client)}${a.always ? ' <span class="ok">· always allowed</span>' : ''}</div><small>${esc(a.plan || (a.always ? 'never needs to ask' : 'allowed'))}</small></div><button class="btn sm" data-revoke="${esc(a.client)}">Remove</button></div>`).join('') + '</div>' : ''}</div>

    <div class="set"><b>🌍 Connector link — Claude.ai, ChatGPT &amp; any AI on the internet</b>
      <small>A private, secure web link so cloud AIs (Claude.ai, ChatGPT, Gemini agents…) can use this browser as their eyes and hands. Approval cards still protect you.</small>
      <div id="tunBox"></div></div>

    <div class="set"><b>💻 Local link — AIs on this computer (Ollama tools, LM Studio, scripts)</b>
      <small>Permanent while this browser is open. Any MCP app on this computer can use it directly; OpenAPI tools can use the second link.</small>
      <div class="codebox">http://127.0.0.1:${c.port}/t/••••••/mcp</div>
      <button class="btn sm" data-copy-raw="${esc(`http://127.0.0.1:${c.port}/t/${c.token}/mcp`)}">Copy MCP link</button> <button class="btn sm" data-copy-raw="${esc(`http://127.0.0.1:${c.port}/t/${c.token}/openapi.json`)}">Copy OpenAPI link</button>
      <small style="margin-top:6px">Running a local model? Choose <b>Ollama</b> in Orbit settings and it drives the browser for free.</small></div>

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
let tunEditing = false;
function paintTunnel(t, token) {
  tunState = t || tunState;
  const box = $('#tunBox'); if (!box) return;
  const tk = token || box.dataset.token || ''; box.dataset.token = tk;
  const t2 = tunState;
  const ngrok = t2.provider === 'ngrok';
  const tabs = `<div class="seg" style="display:flex;gap:6px;margin:8px 0">
      <button class="btn sm ${ngrok ? 'sun' : ''}" data-prov="ngrok">🔒 Permanent link (ngrok · free)</button>
      <button class="btn sm ${!ngrok ? 'sun' : ''}" data-prov="cloudflare">⚡ Quick link (changes each time)</button></div>`;
  const wire = () => {
    box.querySelectorAll('[data-prov]').forEach(b => b.onclick = async () => { tunEditing = b.dataset.prov === 'ngrok' && !t2.hasNgrokKey; paintTunnel(await window.app.tunnel('setup', { provider: b.dataset.prov })); });
    const o = $('#tunOpenNg'); if (o) o.onclick = () => newTab('https://dashboard.ngrok.com/get-started/your-authtoken');
    const d = $('#tunOpenDom'); if (d) d.onclick = () => newTab('https://dashboard.ngrok.com/domains');
    const ps = $('#tunPaste'); if (ps) ps.onclick = async () => { const t = (await window.app.readClipboard() || '').trim(); if (!t) return toast('Nothing copied yet — copy the token on the ngrok page first'); $('#tunKey').value = t; toast('Pasted'); };
    const gb = $('#tunGrab'); if (gb) gb.onclick = async () => { const r = await window.app.ngrokTokenFromPage(); if (r.token) { $('#tunKey').value = r.token; toast('Got your token from the ngrok page — now press Save'); } else toast(r.error); };
    const ey = $('#tunEye'); if (ey) ey.onclick = () => { const k = $('#tunKey'); k.type = k.type === 'password' ? 'text' : 'password'; };
    const sv = $('#tunSave'); if (sv) sv.onclick = async () => {
      const key = $('#tunKey').value.trim(), dom = $('#tunDom').value.trim();
      if (!key && !t2.hasNgrokKey) return toast('Paste your ngrok authtoken first');
      const opts = { provider: 'ngrok', domain: dom }; if (key) opts.ngrokKey = key;
      tunEditing = false;
      await window.app.tunnel('setup', opts);
      paintTunnel(await window.app.tunnel('start'));
    };
    const ed = $('#tunEdit'); if (ed) ed.onclick = () => { tunEditing = true; paintTunnel(); };
    const st = $('#tunStart'); if (st) st.onclick = async () => paintTunnel(await window.app.tunnel('start'));
    const sp = $('#tunStop'); if (sp) sp.onclick = async () => paintTunnel(await window.app.tunnel('stop'));
  };
  if (ngrok && (tunEditing || !t2.hasNgrokKey) && t2.status !== 'on') {
    box.innerHTML = tabs + `<small>One-time setup, about 1 minute. The link then <b>never changes</b> — paste it into your AI once and it keeps working every time this browser is open.</small>
      <ol style="margin:8px 0 8px 18px;padding:0;font-size:12.5px;line-height:1.6">
        <li>Make a free ngrok account and copy your <b>authtoken</b> — <a href="#" id="tunOpenNg">open ngrok</a></li>
        <li>Paste it here (or let MiniNet take it from the ngrok page):<input class="inp" id="tunKey" type="password" placeholder="${t2.hasNgrokKey ? 'saved ✓ — paste again to change' : 'ngrok authtoken'}">
          <div style="display:flex;gap:6px;flex-wrap:wrap"><button class="btn sm" id="tunPaste">📋 Paste</button><button class="btn sm" id="tunGrab">✨ Use the token from my ngrok page</button><button class="btn sm" id="tunEye">👁 Show</button></div></li>
        <li>Your free permanent address (optional — leave blank to use the one ngrok gives your account): <a href="#" id="tunOpenDom">see my domain</a><input class="inp" id="tunDom" value="${esc(t2.domain || '')}" placeholder="something.ngrok-free.app"></li>
      </ol>
      ${t2.error ? `<small class="bad">${esc(t2.error)}</small>` : ''}
      <button class="btn sun wide" id="tunSave">Save and turn on the permanent link</button>`;
    return wire();
  }
  if (t2.status === 'on' && t2.url) {
    const mcp = `${t2.url}/t/${tk}/mcp`, api = `${t2.url}/t/${tk}/openapi.json`;
    box.innerHTML = tabs + `<div class="codebox">${esc(t2.url)}/t/••••••/mcp</div>
      <button class="btn sun sm" id="tunCopy">Copy connector link</button> <button class="btn sm" id="tunCopyApi">Copy ChatGPT Actions link</button> <button class="btn sm" id="tunStop">Turn off</button>${ngrok ? ' <button class="btn sm" id="tunEdit">Settings</button>' : ''}
      <small style="margin-top:8px"><b>Claude.ai:</b> Customize → Connectors → + Add custom connector → name "MiniNet Browser", paste the connector link, choose <b>No sign in</b>.<br>
      <b>ChatGPT:</b> Settings → Connectors (developer mode) → paste the connector link. For a custom GPT: Configure → Actions → Import from URL → paste the Actions link.<br>
      ${ngrok ? '✅ This link is <b>permanent</b> — it stays the same every time the browser opens.' : '⚠️ This quick link changes each time — switch to the permanent link to paste it only once.'} Keep it private: it is the key to your browser.</small>`;
    $('#tunCopy').onclick = () => { window.app.copy(mcp); toast('Connector link copied — keep it private'); };
    $('#tunCopyApi').onclick = () => { window.app.copy(api); toast('ChatGPT Actions link copied'); };
    return wire();
  }
  if (t2.status === 'downloading') box.innerHTML = `<small>Downloading the secure link tool (one time)… ${t2.progress || 0}%</small><div class="bar"><b style="width:${t2.progress || 0}%"></b></div>`;
  else if (t2.status === 'starting') box.innerHTML = '<small>Opening a secure link…</small>' + (t2.error ? `<small class="bad">${esc(t2.error)}</small>` : '');
  else {
    box.innerHTML = tabs + `${t2.error ? `<small class="bad">${esc(t2.error)}</small>` : ''}<button class="btn sun wide" id="tunStart">${ngrok ? 'Turn on permanent link' : 'Create quick link'}</button>${ngrok ? ' <button class="btn sm" id="tunEdit" style="margin-top:6px">ngrok settings</button>' : ''}`;
    wire();
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

/* ================= Missions ================= */
PANELS.missions = { title: 'Missions', wide: true, render: renderMissions };
const STATUS_LABEL = { running: 'Running', verified: '✓ Verified', unverified: 'Unverified', failed: 'Failed', stopped: 'Stopped', interrupted: 'Interrupted' };
async function renderMissions(body) {
  body.className = '';
  const list = await window.app.missions('list');
  body.innerHTML = `<small style="color:var(--dim);display:block;margin-bottom:8px">When an AI runs a mission, every action is recorded with evidence, and the browser itself checks whether the goal was really achieved.</small>
    ${list.length ? list.map(m => `<div class="mcard" data-id="${esc(m.id)}"><span class="mstat ${esc(m.status)}">${STATUS_LABEL[m.status] || esc(m.status)}</span>
      <b>${esc(m.goal)}</b><small>${esc(m.client)} · ${new Date(m.started).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })} · ${m.actions} actions · ${m.criteria.filter(c => c.status === 'passed').length}/${m.criteria.length} checks passed</small></div>`).join('')
      : '<p style="color:var(--dim)">No missions yet. Ask any connected AI to “start a mission” — or try Orbit: “Start a mission to …”.</p>'}
    <button class="btn wide" id="msFolder" style="margin-top:8px">Open missions folder</button>`;
  body.querySelectorAll('.mcard').forEach(el => el.onclick = () => renderMission(body, el.dataset.id));
  $('#msFolder').onclick = () => window.app.missions('folder');
}
async function renderMission(body, id) {
  const m = await window.app.missions('get', id); if (!m) return renderMissions(body);
  const img = f => f ? `<img src="${esc(m.dir + '/' + f)}" alt="" data-full="${esc(m.dir + '/' + f)}">` : '';
  const ago = t => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  body.innerHTML = `<span class="lnkback btn sm" id="msBack">← All missions</span>
    <div style="margin:10px 0"><span class="mstat ${esc(m.status)}">${STATUS_LABEL[m.status] || esc(m.status)}</span></div>
    <b style="font-size:15px">${esc(m.goal)}</b>
    <small style="display:block;color:var(--dim);margin:4px 0 10px">${esc(m.client)} · budget ${m.limits.max_steps} actions${m.limits.allowed_sites.length ? ' · sites: ' + esc(m.limits.allowed_sites.join(', ')) : ''}</small>
    ${m.summary ? `<div class="codebox" style="font-family:inherit">${esc(m.summary)}</div>` : ''}
    <div class="day">Success criteria (checked by the browser)</div>
    ${m.criteria.map(c => `<div class="crit"><span class="ico">${c.status === 'passed' ? '<span class="ok">✓</span>' : c.status === 'failed' ? '<span class="bad">✗</span>' : '○'}</span><div><div>${esc(c.text)}</div>
      ${c.evidence ? `<small>${c.evidence.snippet ? '“…' + esc(c.evidence.snippet.slice(0, 160)) + '…”' : esc(c.evidence.reason)} — ${esc(c.evidence.check)} on ${esc(c.evidence.url)}</small>${img(c.evidence.shot)}` : '<small>Not checked yet</small>'}</div></div>`).join('')}
    <div class="day">Timeline (${m.steps.length} steps)</div>
    <div class="tl">${m.steps.map(s => `<div class="st ${s.ok === false ? 'bad' : s.tool === 'mission_note' ? 'note' : ''}"><div><b style="font-weight:600">${esc(s.summary)}</b> <span style="color:var(--dim);font-size:11px">${ago(s.t)}</span></div>
      ${s.after ? `<small>${esc(s.after.title || '')} — ${esc(s.after.url || '')}</small>` : ''}${s.error ? `<small class="bad">${esc(s.error)}</small>` : ''}${s.warning ? `<small style="color:var(--sun2)">⚠ ${esc(s.warning)}</small>` : ''}${img(s.shot)}</div>`).join('')}</div>
    <div class="orow" style="margin-top:12px"><button class="btn sm" id="msCopy">Copy report</button><button class="btn sm" id="msDel">Delete</button></div>`;
  $('#msBack').onclick = () => renderMissions(body);
  body.querySelectorAll('img[data-full]').forEach(i => i.onclick = () => newTab(i.dataset.full));
  $('#msCopy').onclick = () => { const r = { goal: m.goal, status: m.status, summary: m.summary, criteria: m.criteria.map(c => ({ text: c.text, status: c.status, evidence: c.evidence && (c.evidence.snippet || c.evidence.reason), url: c.evidence && c.evidence.url })), steps: m.steps.map(s => `${s.n}. ${s.summary}${s.ok === false ? ' (failed)' : ''}`) }; window.app.copy(JSON.stringify(r, null, 2)); toast('Mission report copied'); };
  $('#msDel').onclick = async () => { if (confirm('Delete this mission record?')) { await window.app.missions('delete', id); renderMissions(body); } };
}
window.app.on('agent-event', ev => { if (ev.type === 'mission' && panelOpen === 'missions') { const open = $('#msBack'); if (!open) showPanel('missions'); } });

/* ================= Page pop-ups (alert / confirm / prompt) answered by the owner ================= */
window.app.on('page-dialog', d => {
  let host = ''; try { host = new URL(d.url).hostname || 'This page'; } catch { host = 'This page'; }
  if (/MiniNet\.html/.test(d.url)) host = 'MiniNet Chat';
  card('dlg' + d.id, `
    <div class="hd"><img src="icon.png"><b>${esc(host)} says</b></div>
    <div class="plan" style="white-space:pre-wrap">${esc(d.message || '')}</div>
    ${d.type === 'prompt' ? `<input value="${esc(d.def || '')}">` : ''}
    <div class="acts"><button class="btn sun" data-a="ok">OK</button>${d.type !== 'alert' ? '<button class="btn" data-a="cancel">Cancel</button>' : ''}</div>`,
    (el, done) => {
      const inp = el.querySelector('input');
      const ok = () => done(d.type === 'confirm' ? true : d.type === 'prompt' ? inp.value : null);
      el.querySelector('[data-a=ok]').onclick = ok;
      const c = el.querySelector('[data-a=cancel]'); if (c) c.onclick = () => done(d.type === 'confirm' ? false : null);
      if (inp) { inp.onkeydown = e => { if (e.key === 'Enter') ok(); }; setTimeout(() => { inp.focus(); inp.select(); }, 30); }
    }).then(v => window.app.pageDialogAnswer(d.id, v));
});


/* ================= Accounts: sign in once, stay signed in ================= */
PANELS.accounts = { title: 'Accounts', render: renderAccounts };
async function renderAccounts(body) {
  body.className = '';
  body.innerHTML = '<small style="padding:14px;display:block">Checking your sign-ins…</small>';
  const a = await window.app.accounts();
  body.innerHTML = `
    <div class="set"><b>Sign in once — stay signed in</b><small>Sign in to a site one time in MiniNet Browser and you stay signed in, even after closing it. Sites with <b>Continue with Google</b> then take one click — for you and for your AIs (they choose your Google account, and never type passwords).</small></div>
    <div class="set"><b>Google accounts</b>
      ${a.google.length ? a.google.map(g => `<div class="pi"><img src="https://www.google.com/s2/favicons?sz=64&domain=google.com"><div class="tx"><div>${esc(g.email)}</div><small>${esc(g.name || '')}</small></div><span class="ok">● signed in</span></div>`).join('') : '<small>No Google account yet.</small>'}
      <button class="btn sun wide" id="acAddG" style="margin-top:8px">${a.google.length ? '+ Add another Google account' : 'Sign in with Google'}</button></div>
    <div class="set"><b>Sites</b>
      ${a.sites.filter(s => s.id !== 'google').map(s => `<div class="pi"><img src="https://www.google.com/s2/favicons?sz=64&domain=${esc(new URL(s.url).hostname)}"><div class="tx"><div>${esc(s.name)}</div><small>${s.signedIn ? '<span class="ok">● signed in</span>' : 'not signed in'}</small></div>
        ${s.signedIn ? `<button class="btn sm" data-open="${esc(s.url)}">Open</button>${s.id !== 'whatsapp' ? ` <button class="btn sm" data-out="${esc(s.id)}" title="Sign out of ${esc(s.name)} in this browser">Sign out</button>` : ''}` : `<button class="btn sun sm" data-open="${esc(s.login)}">Sign in</button>`}</div>`).join('')}
      <button class="btn wide" id="acRe" style="margin-top:8px">Refresh</button></div>`;
  $('#acAddG').onclick = () => newTab(a.google.length ? 'https://accounts.google.com/AddSession' : 'https://accounts.google.com/ServiceLogin');
  $('#acRe').onclick = () => renderAccounts(body);
  body.querySelectorAll('[data-open]').forEach(b => b.onclick = () => newTab(b.dataset.open));
  body.querySelectorAll('[data-out]').forEach(b => b.onclick = async () => { if (!confirm('Sign out of this site in MiniNet Browser?')) return; await window.app.accountSignout(b.dataset.out); toast('Signed out'); renderAccounts(body); });
}
