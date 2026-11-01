// UI test: starts MiniNet in a throw-away profile, drives the new panels, checks results, saves screenshots.
const path = require('path'); process.chdir('/home/claude/mininet-browser');
const { app, BrowserWindow } = require('electron'); app.disableHardwareAcceleration(); app.setPath('userData', '/tmp/claude-0/mn-profile');
require('./main.js'); const agent = require('./agent');
const fs = require('fs'); const sleep = ms => new Promise(r => setTimeout(r, ms)); const D = '/tmp/claude-0/shots/';
let pass = 0, fail = 0; const ok = (n, c) => { console.log((c ? 'PASS ' : 'FAIL ') + n); c ? pass++ : fail++; };
app.whenReady().then(async () => {
  await sleep(5000); const w = BrowserWindow.getAllWindows()[0]; const js = c => w.webContents.executeJavaScript(c); w.webContents.on('console-message', (e, lvl, msg) => { if (lvl >= 2) console.log('CONSOLE', msg.slice(0, 200)); });
  w.setSize(1360, 860); await sleep(500); const snap = async n => fs.writeFileSync(D + n + '.png', (await w.capturePage()).toPNG());
  agent.setConfig({ mode: 'auto' });
  try {
    // sidebar buttons exist
    ok('Codex and Business buttons in sidebar', await js(`!!document.querySelector('[data-panel=codex]') && !!document.querySelector('[data-panel=business]')`));
    // Codex panel round trip with the stand-in CLI
    await js(`showPanel('codex')`); await sleep(600);
    ok('Codex panel shows', await js(`!!document.querySelector('#cxIn')`));
    await js(`document.querySelector('#cxIn').value='hello codex'; document.querySelector('#cxSend').click(); 1`); await sleep(2500);
    const t1 = await js(`document.querySelector('#cxLog').innerText`);
    ok('Codex reply and tool line shown', /You asked: hello codex/.test(t1) && /list_accounts/.test(t1));
    await js(`document.querySelector('#cxIn').value='second'; document.querySelector('#cxSend').click(); 1`); await sleep(2500);
    ok('tool step of 2nd turn marked done', (await js(`[...document.querySelectorAll('#cxLog .cx.act')].pop().innerText`)).includes('✓'));
    ok('second message resumes the same conversation', /\(resumed\) You asked: second/.test(await js(`document.querySelector('#cxLog').innerText`)));
    await snap('codex-panel');
    await js(`hidePanel(); showPanel('codex')`); await sleep(500);
    ok('chat kept after reopening panel', /You asked: second/.test(await js(`document.querySelector('#cxLog').innerText`)));
    await js(`document.querySelector('#cxNew').click(); 1`); await sleep(500);
    ok('New chat clears it', !/You asked/.test(await js(`document.querySelector('#cxLog').innerText`)));
    ok('toolbar mic (speak into page) present', await js(`!!document.querySelector('#bMic') && typeof dictateIntoPage === 'function'`));
    // stand-alone Codex window (the desktop icon opens this)
    await js(`window.app.codex('open-window')`); await sleep(2500);
    const cw = BrowserWindow.getAllWindows().find(x => /codex\.html/.test(x.webContents.getURL()));
    ok('Codex app window opens', !!cw);
    if (cw) {
      const cjs = c => cw.webContents.executeJavaScript(c);
      ok('Codex window has model picker, mic and limit fallback', await cjs(`!!document.querySelector('#model') && !!document.querySelector('#mic') && !!document.querySelector('#fb') && document.querySelector('#model').value === 'gpt-6-luna'`));
      await cjs(`document.querySelector('#new').click(); 1`); await sleep(400);
      await cjs(`document.querySelector('#in').value='from the app'; document.querySelector('#send').click(); 1`); await sleep(2500);
      ok('Codex window chat round trip', /You asked: from the app/.test(await cjs(`document.querySelector('#log').innerText`)));
      await cjs(`document.querySelector('#in').value='LIMIT please'; document.querySelector('#send').click(); 1`); await sleep(4000);
      const lt = await cjs(`document.querySelector('#log').innerText`);
      ok('limit is recognised and handed to Orbit', /usage limit/.test(lt) && /Handing this job to MiniNet/.test(lt));
      ok('fallback gives a clear result or reason', /\(Orbit\)|Could not hand the job|Helpers use the AI brains/.test(lt));
      await snap('codex-app-main'); fs.writeFileSync(D + 'codex-app.png', (await cw.capturePage()).toPNG());
      cw.close(); await sleep(300);
    }
    // Business panel save + read back through the AI tool
    await js(`hidePanel(); showPanel('business')`); await sleep(1000);
    await js(`document.querySelector('#bzName').value='Seyi Studio'; document.querySelector('#bzOffer').value='Video edit 20,000'; document.querySelector('#bzGm').value='all'; document.querySelector('#bzSave').click(); 1`); await sleep(1200);
    const info = JSON.parse((await agent.call('business_info', {}, 'Tester')).content[0].text);
    ok('Business panel save reaches the AI tools', info.businessName === 'Seyi Studio' && info.offer === 'Video edit 20,000');
    await snap('business-panel');
    // Accounts panel
    await js(`hidePanel(); showPanel('accounts')`); await sleep(2500);
    ok('Accounts panel has add-Google button', await js(`!!document.querySelector('#acAddG')`));
    ok('Accounts panel has Other Gmails (app password) form', await js(`!!document.querySelector('#acMAdd') && !!document.querySelector('#acMPass') && document.querySelector('#acMPass').type==='password'`));
    await js(`document.querySelector('#acMEmail').value='x@gmail.com'; document.querySelector('#acMPass').value='short'; document.querySelector('#acMAdd').click(); 1`); await sleep(800);
    ok('wrong app password gives a clear message', /16 letters/.test(await js(`document.querySelector('#acMMsg').innerText`)));
    await snap('accounts-panel');
    // AI control: add a per-AI link, it appears, level change, remove
    await js(`hidePanel(); showPanel('agents')`); await sleep(1200);
    await js(`document.querySelector('#agLName').value='ChatGPT'; document.querySelector('#agLLevel').value='business'; document.querySelector('#agLAdd').click(); 1`); await sleep(1200);
    const cfg = agent.getConfig(); ok('per-AI link added from the panel', (cfg.links || []).some(l => l.name === 'ChatGPT' && l.level === 'business'));
    ok('link listed in panel', /ChatGPT/.test(await js(`document.querySelector('#agLinks').innerText`)));
    await snap('ai-control-links');
    // browser tools on the built-in mini sites
    await agent.call('navigate', { url: 'home.mini' }, 'Tester');
    const snapT = (await agent.call('snapshot', {}, 'Tester')).content[0].text; ok('snapshot works', /ELEMENTS/.test(snapT));
    const rt = (await agent.call('read_text', { find: 'MiniNet' }, 'Tester')).content[0].text; ok('read_text find works', /MiniNet/i.test(rt));
    const tabs = JSON.parse((await agent.call('list_tabs', {}, 'Tester')).content[0].text); ok('list_tabs works', tabs.length >= 1);
    const ev = JSON.parse((await agent.call('wait_for_events', { since_id: 0, timeout_seconds: 0 }, 'Tester')).content[0].text); ok('wait_for_events works', Array.isArray(ev.events));
    const tl = agent.toolList(); ok('tool list has business + codes + skills (' + tl.length + ' tools)', ['verify_payment', 'get_email_code', 'save_skill', 'find_client'].every(n => tl.some(t => t.name === n)));
    ok('get_email_code takes a gmail choice', !!tl.find(t => t.name === 'get_email_code').inputSchema.properties.gmail);
    ok('read_email tool exists', !!tl.find(t => t.name === 'read_email'));
    ok('verify_payment takes a gmail choice', !!tl.find(t => t.name === 'verify_payment').inputSchema.properties.gmail);
  } catch (e) { console.log('ERROR', e.stack); fail++; }
  console.log(`\nUI: ${pass} passed, ${fail} failed`); agent.setConfig({ mode: 'ask' }); app.exit(fail ? 1 : 0);
});
