const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('app', {
  on: (ch, fn) => ipcRenderer.on(ch, (e, ...a) => fn(...a)),
  win: (cmd) => ipcRenderer.send('win', cmd),
  settings: (s) => ipcRenderer.send('settings', s),
  openPath: (p) => ipcRenderer.send('open-path', p),
  showItem: (p) => ipcRenderer.send('show-item', p),
  openExternal: (u) => ipcRenderer.send('open-external', u),
  clearData: (what) => ipcRenderer.invoke('clear-data', what),
  version: () => ipcRenderer.invoke('version'),
  copy: (t) => ipcRenderer.send('copy', t),
  // AI control
  agentRespond: (msg) => ipcRenderer.send('agent-res', msg),
  agentTools: () => ipcRenderer.invoke('agent-tools'),
  agentCall: (name, args, client, owner) => ipcRenderer.invoke('agent-call', { name, args, client, owner }),
  accounts: () => ipcRenderer.invoke('accounts'),
  ngrokTokenFromPage: () => ipcRenderer.invoke('ngrok-token-from-page'),
  readClipboard: () => ipcRenderer.invoke('clipboard-read'),
  accountSignout: (id) => ipcRenderer.invoke('account-signout', id),
  agentRelease: (key) => ipcRenderer.invoke('agent-release', key),
  pageDialogAnswer: (id, value) => ipcRenderer.send('page-dialog-answer', { id, value }),
  agentConfig: (c) => ipcRenderer.invoke('agent-config', c),
  agentLog: () => ipcRenderer.invoke('agent-log'),
  agentPause: (p) => ipcRenderer.send('agent-pause', p),
  agentInstructions: () => ipcRenderer.invoke('agent-instructions'),
  mcpConfigs: () => ipcRenderer.invoke('mcp-configs'),
  connectClaudeDesktop: () => ipcRenderer.invoke('connect-claude-desktop'),
  tunnel: (op, opts) => ipcRenderer.invoke('tunnel', op, opts),
  missions: (op, id) => ipcRenderer.invoke('missions', { op, id }),
  // extensions
  ext: (op, o = {}) => ipcRenderer.invoke('ext', { op, ...o }),
  // Orbit
  secretSet: (key, value) => ipcRenderer.invoke('secret-set', { key, value }),
  secretHas: (key) => ipcRenderer.invoke('secret-has', key),
  llm: (req) => ipcRenderer.invoke('llm', req),
  transcribe: (req) => ipcRenderer.invoke('transcribe', req)
});
