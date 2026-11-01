// Installs the MiniNet skills + AGENTS.md for Codex and lets Codex use every MiniNet tool without a Codex prompt
// (MiniNet's own Allow card still applies). Backs up config.toml first.
const fs = require('fs'), path = require('path'), http = require('http');
const home = process.env.USERPROFILE, codex = path.join(home, '.codex'), here = __dirname;
const copyDir = (a, b) => { fs.mkdirSync(b, { recursive: true }); for (const f of fs.readdirSync(a)) { const s = path.join(a, f), d = path.join(b, f); fs.statSync(s).isDirectory() ? copyDir(s, d) : fs.copyFileSync(s, d); } };
for (const sk of fs.readdirSync(path.join(here, 'skills'))) { copyDir(path.join(here, 'skills', sk), path.join(codex, 'skills', sk)); console.log('skill installed:', sk); }
const ws = path.join(home, 'MiniNetCodex'); fs.mkdirSync(ws, { recursive: true }); fs.copyFileSync(path.join(here, 'AGENTS.md'), path.join(ws, 'AGENTS.md')); console.log('AGENTS.md ->', ws);
const agent = JSON.parse(fs.readFileSync(path.join(process.env.APPDATA, 'MiniNet Browser', 'agent.json'), 'utf8'));
http.get({ host: '127.0.0.1', port: agent.port, path: '/api/tools', headers: { Authorization: 'Bearer ' + agent.token } }, res => {
  let b = ''; res.on('data', d => b += d); res.on('end', () => {
    const tools = JSON.parse(b).map(t => t.name);
    const cfgf = path.join(codex, 'config.toml'); let cfg = fs.readFileSync(cfgf, 'utf8');
    fs.copyFileSync(cfgf, cfgf + '.bak-mininet-' + Date.now());
    const start = cfg.indexOf('# --- MiniNet Browser MCP ---'), end = cfg.indexOf('# --- end MiniNet ---');
    const bridge = path.join(process.env.APPDATA, 'MiniNet Browser', 'mcp-bridge.js').replace(/\\/g, '\\\\');
    const conf = path.join(process.env.APPDATA, 'MiniNet Browser', 'agent.json').replace(/\\/g, '\\\\');
    const block = ['# --- MiniNet Browser MCP ---', '[mcp_servers.mininet]', 'command = "node"', `args = ["${bridge}"]`, 'tool_timeout_sec = 300', 'startup_timeout_sec = 30', `env = { MININET_AGENT_CONFIG = "${conf}" }`, '',
      ...tools.flatMap(t => [`[mcp_servers.mininet.tools.${t}]`, 'approval_mode = "approve"', '']), '# --- end MiniNet ---'].join('\n');
    cfg = start >= 0 && end > start ? cfg.slice(0, start) + block + cfg.slice(end + '# --- end MiniNet ---'.length) : cfg.trimEnd() + '\n\n' + block + '\n';
    fs.writeFileSync(cfgf, cfg); console.log('config.toml: mininet server with', tools.length, 'tools pre-approved');
  });
}).on('error', e => console.log('MiniNet not reachable:', e.message));
