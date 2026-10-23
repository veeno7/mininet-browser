// MiniNet Browser — MCP stdio bridge.
// Lets apps that launch MCP servers as a command (Claude Desktop, Cursor, Windsurf, etc.)
// talk to the running MiniNet Browser. Run with the browser's own exe + ELECTRON_RUN_AS_NODE=1, or plain node.
const fs = require('fs');
const http = require('http');
const readline = require('readline');

const CONFIG = process.env.MININET_AGENT_CONFIG || __CONFIG_PATH__;
let sessionId = null;

function cfg() { return JSON.parse(fs.readFileSync(CONFIG, 'utf8')); }
function out(obj) { process.stdout.write(JSON.stringify(obj) + '\n'); }

function post(body) {
  return new Promise((resolve, reject) => {
    let c; try { c = cfg(); } catch { return reject(new Error('MiniNet Browser settings not found. Open MiniNet Browser once first.')); }
    const data = Buffer.from(JSON.stringify(body));
    const req = http.request({ host: '127.0.0.1', port: c.port || 7811, path: '/mcp', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': data.length, Authorization: 'Bearer ' + c.token, ...(sessionId ? { 'Mcp-Session-Id': sessionId } : {}) } }, res => {
      let d = ''; res.on('data', x => d += x);
      res.on('end', () => {
        if (res.headers['mcp-session-id']) sessionId = res.headers['mcp-session-id'];
        if (res.statusCode === 202 || !d) return resolve(null);
        try { resolve(JSON.parse(d)); } catch { reject(new Error(d || 'Bad response (' + res.statusCode + ')')); }
      });
    });
    req.on('error', () => reject(new Error('MiniNet Browser is not running (or AI control is off). Open MiniNet Browser and try again.')));
    req.write(data); req.end();
  });
}

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', async line => {
  if (!line.trim()) return;
  let msg; try { msg = JSON.parse(line); } catch { return; }
  if (msg.method === 'initialize' && msg.params && msg.params.clientInfo) msg.params.clientInfo.name = (msg.params.clientInfo.name || 'client') + ' (mininet-bridge)';
  try {
    const r = await post(msg);
    if (r) out(r);
  } catch (e) {
    if (msg.id === undefined) return;
    if (msg.method === 'tools/call') out({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: 'Error: ' + e.message }], isError: true } });
    else if (msg.method === 'initialize') out({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: msg.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'mininet-browser', version: '1' }, instructions: e.message } });
    else if (msg.method === 'tools/list') out({ jsonrpc: '2.0', id: msg.id, result: { tools: [] } });
    else out({ jsonrpc: '2.0', id: msg.id, error: { code: -32000, message: e.message } });
  }
});
