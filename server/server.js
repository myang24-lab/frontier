// Local bridge: serves the app + real terminal (node-pty over WebSocket) + real sub-agent endpoint.
// Run: npm start   (from server/)  → open http://localhost:3001
const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const { spawn } = require('child_process');
const pty = require('node-pty');

const PORT = 3001;
// Scoped shell: only these commands ever execute.
const ALLOW = /^ollama\s+(pull|list|ps|show|rm)\b[\w\s.:\-]*$/;

const ROOT = path.join(__dirname, '..');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.map': 'application/json' };
// Static files served from the project root; /vendor/* comes from node_modules.
const VENDOR = {
  '/vendor/react.js': 'react/umd/react.production.min.js',
  '/vendor/react-dom.js': 'react-dom/umd/react-dom.production.min.js',
  '/vendor/babel.js': '@babel/standalone/babel.min.js',
  '/vendor/xterm.js': '@xterm/xterm/lib/xterm.js',
  '/vendor/xterm.css': '@xterm/xterm/css/xterm.css',
};
function serveFile(res, file) {
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' });
    res.end(data);
  });
}

// Frontier tier: forward /frontier/* to the relay, which holds the Claude API
// key and the token ledger. This bridge never sees the key — it only passes
// bytes through, streaming included, so SSE arrives incrementally rather than
// in one lump at the end.
//
// Everything else in this file is unchanged: if the relay is down or the
// student is offline, the Ollama chat, the pty terminal and the sub-agent all
// keep working exactly as before.
const RELAY_URL = process.env.RELAY_URL || 'http://localhost:8787';

function proxyToRelay(req, res) {
  const target = new URL(req.url.replace(/^\/frontier/, ''), RELAY_URL);
  const upstream = http.request(
    {
      hostname: target.hostname,
      port: target.port,
      path: target.pathname + target.search,
      method: req.method,
      headers: { ...req.headers, host: target.host },
    },
    (upRes) => {
      res.writeHead(upRes.statusCode, upRes.headers);
      upRes.pipe(res); // streams SSE through as it arrives
    }
  );

  upstream.on('error', (err) => {
    // The relay being unreachable is an ordinary situation, not a crash: the
    // student is offline, or it simply isn't running. Say so in the shape the
    // frontend already handles.
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({
        error: {
          code: 'relay_unreachable',
          message: `Can't reach the frontier relay at ${RELAY_URL}. Your local model is unaffected. (${err.code || err.message})`,
        },
      }));
    } else {
      res.end();
    }
  });

  // A student closing the tab should stop generation upstream, not just here.
  req.on('close', () => upstream.destroy());
  req.pipe(upstream);
}

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'content-type');
  if (req.method === 'OPTIONS') return res.end();
  if (req.url.startsWith('/frontier/')) return proxyToRelay(req, res);
  if (req.url === '/agent' && req.method === 'POST') {
    let body = '';
    req.on('data', c => (body += c));
    req.on('end', () => {
      let prompt = '', iterations = 3;
      try { ({ prompt, iterations = 3 } = JSON.parse(body)); } catch (e) {}
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      const py = spawn('python3', ['agent.py', String(Math.max(1, Math.min(5, iterations)))], { cwd: __dirname });
      py.stdin.write(prompt); py.stdin.end();
      py.stdout.on('data', d => res.write(d));
      py.stderr.on('data', d => res.write(d));
      py.on('close', () => res.end());
    });
    return;
  }
  if (req.method === 'GET') {
    const url = req.url.split('?')[0];
    if (VENDOR[url]) return serveFile(res, path.join(__dirname, 'node_modules', VENDOR[url]));
    const rel = url === '/' ? 'Local AI OS.dc.html' : decodeURIComponent(url.slice(1));
    const file = path.resolve(ROOT, rel);
    if (file.startsWith(ROOT + path.sep) || file === path.join(ROOT, 'Local AI OS.dc.html')) return serveFile(res, file);
  }
  res.writeHead(404); res.end('not found');
});

// Line-disciplined scoped terminal: we own the prompt, only allowlisted
// commands are spawned in a real pty. Not a raw shell.
const wss = new WebSocketServer({ server, path: '/pty' });
wss.on('connection', (ws) => {
  let buf = '', proc = null;
  const send = s => ws.readyState === 1 && ws.send(s);
  send('\x1b[90mscoped shell — only `ollama …` commands run here\x1b[0m\r\n$ ');
  ws.on('message', (m) => {
    const data = m.toString();
    if (proc) { proc.write(data); return; } // forward (e.g. Ctrl-C) to running command
    for (const ch of data) {
      if (ch === '\r') {
        send('\r\n');
        const cmd = buf.trim(); buf = '';
        if (!cmd) { send('$ '); continue; }
        if (!ALLOW.test(cmd)) { send('\x1b[31mblocked:\x1b[0m only ollama commands are allowed\r\n$ '); continue; }
        const [bin, ...args] = cmd.split(/\s+/);
        proc = pty.spawn(bin, args, { name: 'xterm-color', cols: 100, rows: 28, env: process.env });
        proc.onData(d => send(d));
        proc.onExit(({ exitCode }) => { proc = null; send(`\r\n\x1b[90m[exit ${exitCode}]\x1b[0m\r\n$ `); });
      } else if (ch === '\x7f') { if (buf) { buf = buf.slice(0, -1); send('\b \b'); } }
      else if (ch === '\x03') { buf = ''; send('^C\r\n$ '); }
      else { buf += ch; send(ch); }
    }
  });
  ws.on('close', () => { if (proc) proc.kill(); });
});

server.listen(PORT, () => console.log(`bridge running → ws://localhost:${PORT}/pty · POST http://localhost:${PORT}/agent`));
