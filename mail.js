// MiniNet Browser — read any Gmail with a Google app password (IMAP, read-only use).
// Google blocks password sign-in inside MiniNet's pages, but app passwords are Google's own way to let an app
// read a mailbox. The owner creates one per Gmail (myaccount.google.com/apppasswords) and pastes it in Accounts.
// Passwords are stored encrypted with the browser's other secrets; this module only ever reads mail.
const fs = require('fs');
const path = require('path');
const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');

let listFile = '', getPass = () => null, setPass = () => {};
function accounts() { try { return JSON.parse(fs.readFileSync(listFile, 'utf8')); } catch { return []; } }
function saveAccounts(a) { fs.writeFileSync(listFile, JSON.stringify(a, null, 1)); }
const clean = e => String(e || '').trim().toLowerCase();

function client(email, pass) {
  return new ImapFlow({ host: 'imap.gmail.com', port: 993, secure: true, auth: { user: email, pass }, logger: false, socketTimeout: 60000, greetingTimeout: 20000 });
}
async function withInbox(email, fn) {
  const pass = getPass(clean(email));
  if (!pass) throw new Error(`No app password saved for ${email}. Add it in MiniNet → Accounts.`);
  const c = client(clean(email), pass);
  await c.connect();
  try { const lock = await c.getMailboxLock('INBOX'); try { return await fn(c); } finally { lock.release(); } }
  finally { await c.logout().catch(() => {}); }
}
function htmlToText(h) { return String(h || '').replace(/<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>/gi, ' ').replace(/<br\s*\/?>|<\/(p|div|tr|li|h\d)>/gi, '\n').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n'); }
async function toMessage(email, c, uid, withBody) {
  const m = await c.fetchOne(String(uid), withBody ? { source: true, internalDate: true } : { envelope: true, internalDate: true }, { uid: true });
  if (!m) return null;
  if (!withBody) { const f = (m.envelope.from || [])[0] || {}; return { account: email, uid, messageId: `imap:${email}:${uid}`, from: clean(f.address), name: f.name || '', subject: m.envelope.subject || '', time: +new Date(m.internalDate) }; }
  const p = await simpleParser(m.source);
  const f = (p.from && p.from.value && p.from.value[0]) || {};
  return { account: email, uid, messageId: `imap:${email}:${uid}`, from: clean(f.address), name: f.name || '', subject: p.subject || '', time: +new Date(m.internalDate), date: new Date(m.internalDate).toString().slice(0, 24), body: (p.text || htmlToText(p.html)).slice(0, 8000) };
}

// Gmail search syntax (from:, subject:, newer_than:…) through IMAP's X-GM-RAW
async function search(email, query, { limit = 8, body = true } = {}) {
  return withInbox(email, async c => {
    const uids = (await c.search({ gmraw: query || 'in:inbox' }, { uid: true })) || [];
    const out = [];
    for (const uid of uids.slice(-limit).reverse()) { const m = await toMessage(clean(email), c, uid, body); if (m) out.push(m); }
    return out;
  });
}
async function searchAll(query, opts = {}, only) {
  const list = accounts().filter(a => !only || only.includes(a.email));
  const res = [];
  for (const a of list) { try { res.push(...await search(a.email, query, opts)); } catch (e) { res.push({ account: a.email, error: e.message }); } }
  return res;
}
// newest UID in the inbox, and messages that arrived after a given UID (for the watcher)
async function newSince(email, lastUid) {
  return withInbox(email, async c => {
    const next = c.mailbox.uidNext || 1;
    if (!lastUid) return { last: next - 1, messages: [] };
    if (next - 1 <= lastUid) return { last: lastUid, messages: [] };
    const uids = (await c.search({ uid: `${lastUid + 1}:*` }, { uid: true })) || [];
    const out = [];
    for (const uid of uids.filter(u => u > lastUid).slice(-20)) { const m = await toMessage(clean(email), c, uid, false); if (m) out.push(m); }
    return { last: Math.max(lastUid, ...uids, 0), messages: out };
  });
}
async function test(email, pass) {
  const c = client(clean(email), String(pass).replace(/\s+/g, ''));
  await c.connect();
  const st = await c.status('INBOX', { messages: true, unseen: true }).catch(() => ({}));
  await c.logout().catch(() => {});
  return st;
}
async function add(email, pass) {
  email = clean(email); pass = String(pass || '').replace(/\s+/g, '');
  if (!/^[^@\s]+@(gmail|googlemail)\.com$/.test(email) && !/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/.test(email)) throw new Error('That does not look like an email address.');
  if (pass.length < 16) throw new Error('A Google app password has 16 letters (shown as 4 groups of 4). Create one at myaccount.google.com/apppasswords.');
  let st;
  try { st = await test(email, pass); }
  catch (e) { throw new Error(/auth|credentials|invalid/i.test(e.responseText || e.message || '') ? 'Google did not accept that app password for ' + email + '. Make sure 2-Step Verification is on and you copied the 16-letter app password (not your normal password).' : 'Could not reach Gmail: ' + (e.responseText || e.message)); }
  setPass(email, pass);
  const list = accounts().filter(a => a.email !== email); list.push({ email, added: Date.now() }); saveAccounts(list);
  return { email, inbox: st.messages, unread: st.unseen };
}
function remove(email) { email = clean(email); setPass(email, null); saveAccounts(accounts().filter(a => a.email !== email)); return true; }

function init(opts) { listFile = path.join(opts.userData, 'mail-accounts.json'); getPass = opts.getPass; setPass = opts.setPass; }
module.exports = { init, accounts, add, remove, search, searchAll, newSince, test };
