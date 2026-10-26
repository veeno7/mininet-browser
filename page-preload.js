// Runs in every page frame (isolated from the page). Replaces the blocking alert/confirm/prompt
// pop-ups with MiniNet Browser's own: the owner answers them in the browser, or an AI working in the tab does.
const { contextBridge, ipcRenderer } = require('electron');
function ask(type, message, def) {
  try { return ipcRenderer.sendSync('mn-dialog', { type, message: String(message == null ? '' : message).slice(0, 2000), def: def == null ? '' : String(def), url: location.href }); }
  catch { return type === 'confirm' ? false : type === 'prompt' ? null : undefined; }
}
const patch = (a) => {
  const fix = (n, f) => { try { Object.defineProperty(window, n, { value: f, writable: true, configurable: true }); } catch {} };
  fix('alert', function alert(m) { a('alert', m); });
  fix('confirm', function confirm(m) { return !!a('confirm', m); });
  // FedCM ("Sign in with Google" without a pop-up) isn't available in this browser; hiding it makes sites use the normal pop-up sign-in
  try { delete window.IdentityCredential; } catch {}
  try { delete window.IdentityProvider; } catch {}
  fix('prompt', function prompt(m, d) { const r = a('prompt', m, d); return r == null ? null : String(r); });
};
try {
  if (contextBridge.executeInMainWorld) contextBridge.executeInMainWorld({ func: patch, args: [ask] });
  else { contextBridge.exposeInMainWorld('__mnDialog', ask); require('electron').webFrame.executeJavaScript('(' + patch.toString() + ')(window.__mnDialog)'); }
} catch {}
