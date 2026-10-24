#!/usr/bin/env node
// Local bridge: runs stdio MCP servers and exposes each one over HTTP at
//   POST http://127.0.0.1:3939/mcp/<name>
// so the browser extension can reach them. No dependencies, Node 18+.
//
// Usage: node bridge.js [path/to/servers.json]
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const PORT = Number(process.env.PORT || 3939);
const configPath = process.argv[2] || path.join(__dirname, 'servers.json');
const servers = JSON.parse(fs.readFileSync(configPath, 'utf8')).mcpServers || {};
const procs = new Map();

function start(name) {
  if (procs.has(name)) return procs.get(name);
  const cfg = servers[name];
  const child = spawn(cfg.command, cfg.args || [], {
    cwd: cfg.cwd,
    env: { ...process.env, ...(cfg.env || {}) },
    stdio: ['pipe', 'pipe', 'inherit'],
    shell: process.platform === 'win32', // lets "npx" resolve to npx.cmd on Windows
  });
  const p = { child, pending: new Map(), seq: 0, buf: '', initResult: null, ready: false };

  const cleanup = (why) => {
    if (procs.get(name) !== p) return;
    procs.delete(name);
    for (const resolve of p.pending.values()) resolve({ jsonrpc: '2.0', error: { code: -32000, message: why } });
    p.pending.clear();
  };

  child.stdout.on('data', (chunk) => {
    p.buf += chunk;
    let nl;
    while ((nl = p.buf.indexOf('\n')) >= 0) {
      const line = p.buf.slice(0, nl).trim();
      p.buf = p.buf.slice(nl + 1);
      if (!line) continue;
      try {
        const m = JSON.parse(line);
        if (m.id !== undefined && !m.method && p.pending.has(m.id)) {
          p.pending.get(m.id)(m);
          p.pending.delete(m.id);
        }
      } catch {}
    }
  });
  child.stdin.on('error', () => {});
  child.on('error', (e) => cleanup(`could not start "${cfg.command}": ${e.message}`));
  child.on('exit', (code) => cleanup(`server "${name}" exited (code ${code})`));
  procs.set(name, p);
  return p;
}

async function forward(name, msg) {
  const p = start(name);

  // The extension may re-initialize after Chrome restarts its service worker.
  // Most servers dislike a second initialize, so answer from the first one.
  if (msg.method === 'initialize' && p.initResult) return { jsonrpc: '2.0', id: msg.id, result: p.initResult };
  if (msg.method === 'notifications/initialized' && p.ready) return null;

  if (msg.id === undefined) {
    p.child.stdin.write(JSON.stringify(msg) + '\n');
    if (msg.method === 'notifications/initialized') p.ready = true;
    return null;
  }

  const reply = await new Promise((resolve) => {
    const bridgeId = ++p.seq; // own ids, so clients can never collide
    p.pending.set(bridgeId, (m) => resolve({ ...m, id: msg.id }));
    p.child.stdin.write(JSON.stringify({ ...msg, id: bridgeId }) + '\n');
  });
  if (msg.method === 'initialize' && reply.result) p.initResult = reply.result;
  return reply;
}

const server = http.createServer(async (req, res) => {
  // Only the extension (or a non-browser client such as curl) may call this.
  // Web pages send an Origin header, and DNS-rebinding attacks send a foreign Host.
  const origin = req.headers.origin;
  const host = (req.headers.host || '').split(':')[0];
  if ((origin && !origin.startsWith('chrome-extension://')) || !['127.0.0.1', 'localhost'].includes(host)) {
    res.writeHead(403).end('forbidden');
    return;
  }

  if (req.method === 'GET' && req.url === '/servers') {
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(Object.keys(servers)));
    return;
  }

  const match = req.url.match(/^\/mcp\/([\w-]+)$/);
  if (req.method !== 'POST' || !match || !servers[match[1]]) {
    res.writeHead(404).end('not found');
    return;
  }

  let body = '';
  for await (const chunk of req) body += chunk;
  let msg;
  try {
    msg = JSON.parse(body);
  } catch {
    res.writeHead(400).end('invalid JSON');
    return;
  }

  try {
    const reply = await forward(match[1], msg);
    if (!reply) return void res.writeHead(202).end();
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(reply));
  } catch (e) {
    res.writeHead(500, { 'Content-Type': 'application/json' }).end(
      JSON.stringify({ jsonrpc: '2.0', id: msg.id ?? null, error: { code: -32000, message: String(e.message || e) } })
    );
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`MCP bridge on http://127.0.0.1:${PORT}  (servers: ${Object.keys(servers).join(', ') || 'none'})`);
});

process.on('SIGINT', () => {
  for (const p of procs.values()) p.child.kill();
  process.exit(0);
});
