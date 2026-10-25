import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import { randomInt } from 'node:crypto';
import { Server } from 'socket.io';
import { CONFIG, makeRoom, addPlayer, addEvent, disconnectPlayer, removePlayer, startRound, action, tick, snapshot } from './game.mjs';

const PUBLIC = fileURLToPath(new URL('./public/', import.meta.url));
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };
export function createGameServer({ port = 3000, host = '0.0.0.0' } = {}) {
  const rooms = new Map();
  const httpServer = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname === '/api/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: true, rooms: rooms.size, tickRate: CONFIG.tickRate }));
      }
      if (url.pathname === '/api/network') {
        const actualPort = httpServer.address()?.port ?? port;
        const urls = Object.values(os.networkInterfaces()).flat().filter(n => n.family === 'IPv4' && !n.internal)
          .map(n => `http://${n.address}:${actualPort}`);
        res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ urls }));
      }
      // Only serve known static assets, never source files or arbitrary filesystem paths.
      const pathname = url.pathname === '/' ? '/index.html' : url.pathname;
      if (!['/index.html', '/app.js', '/renderer.js', '/shared.js', '/style.css', '/icon.svg'].includes(pathname)) {
        res.writeHead(404); return res.end('Not found');
      }
      const data = await readFile(path.join(PUBLIC, pathname.slice(1)));
      res.writeHead(200, { 'Content-Type': mime[path.extname(pathname)], 'Cache-Control': 'no-cache',
        'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin',
        'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' ws: wss:; frame-ancestors 'none'" });
      res.end(data);
    } catch { res.writeHead(500); res.end('Server error'); }
  });
  const io = new Server(httpServer, { maxHttpBufferSize: 8192, pingInterval: 5000, pingTimeout: 7000,
    // LAN app: same-origin clients only. Authentication tokens are never broadcast.
    allowRequest(req, callback) {
      const origin = req.headers.origin;
      let allowed = !origin;
      try { allowed ||= new URL(origin).host === req.headers.host; } catch {}
      callback(null, allowed);
    } });
  const publish = room => { room.revision++; io.to(room.code).emit('state', snapshot(room)); };
  io.on('connection', socket => {
    socket.data.binding = null;
    let budget = 100, budgetAt = Date.now();
    socket.use((packet, next) => {
      const now = Date.now(); budget = Math.min(100, budget + (now - budgetAt) * .07); budgetAt = now;
      if (--budget < 0) return; // Drop abusive packets without mutating the game.
      next();
    });
    const bound = () => {
      const binding = socket.data.binding;
      if (!binding) throw new Error('请先创建或加入房间。');
      const room = rooms.get(binding.code), p = room?.players.find(p => p.id === binding.id);
      if (!p || p.socketId !== socket.id) throw new Error('当前席位已失效，请重新加入。');
      return { room, p };
    };
    const handle = (event, fn) => socket.on(event, (data, ack) => {
      try { const result = fn(data ?? {}); if (typeof ack === 'function') ack({ ok: true, ...result }); }
      catch (error) { if (typeof ack === 'function') ack({ ok: false, error: error.message }); }
    });
    handle('join', data => {
      if (socket.data.binding) throw new Error('已在房间中，请先离开当前房间。');
      if (!data || typeof data !== 'object') throw new Error('无效的加入请求。');
      let room;
      if (data.create === true) {
        if (rooms.size >= 100) throw new Error('服务器房间已满，请稍后再试。');
        const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
        let code;
        do { code = Array.from({ length: 5 }, () => alphabet[randomInt(alphabet.length)]).join(''); } while (rooms.has(code));
        room = makeRoom(code); rooms.set(code, room);
      } else {
        const code = String(data.code || '').toUpperCase().trim();
        room = rooms.get(code);
        if (!room) throw new Error('房间不存在或已过期；服务器重启后也需要重新创建房间。');
      }
      let p = typeof data.token === 'string' ? room.players.find(p => p.token === data.token) : null;
      if (data.token && !p) throw new Error('重连席位已过期，请重新加入。');
      if (p) {
        if (p.connected && p.socketId !== socket.id) throw new Error('这个席位仍在另一连接中，请稍后重试。');
        p.connected = true; p.disconnectedAt = null; p.input = { x: 0, y: 0 }; p.inputAt = Date.now(); p.seq = -1; p.actionSeq = -1;
        room.hostActionAt = Date.now();
        addEvent(room, 'join', `${p.name} 已恢复连接`);
      } else p = addPlayer(room, data.name);
      if (room.phase === 'playing') p.invulnerable = Math.max(p.invulnerable, CONFIG.joinShield);
      if (!room.players.some(q => q.id === room.hostId && q.connected)) room.hostId = p.id;
      p.socketId = socket.id; socket.data.binding = { code: room.code, id: p.id };
      socket.join(room.code); publish(room);
      return { id: p.id, token: p.token, code: room.code, state: snapshot(room) };
    });
    handle('ready', data => {
      const { room, p } = bound();
      if (!['lobby', 'finished'].includes(room.phase)) throw new Error('任务进行中。');
      if (typeof data.ready !== 'boolean') throw new Error('准备状态无效。');
      if (p.ready === data.ready && room.hostId !== p.id) return;
      p.ready = data.ready;
      room.hostActionAt = Date.now();
      publish(room);
    });
    handle('start', () => {
      const { room, p } = bound();
      if (room.hostId !== p.id) throw new Error('只有房主可以启动任务。');
      room.hostActionAt = Date.now(); startRound(room); publish(room);
    });
    handle('claim:host', () => {
      const { room, p } = bound();
      if (!['lobby', 'finished'].includes(room.phase) || room.hostId === p.id || !p.ready) throw new Error('现在无法接管房主。');
      const connected = room.players.filter(q => q.connected);
      if (connected.filter(q => q.ready).length < CONFIG.minPlayers || connected.some(q => q.id !== room.hostId && !q.ready)) {
        throw new Error(`至少 ${CONFIG.minPlayers} 名玩家准备，且其他队员也需准备。`);
      }
      if (Date.now() - room.hostActionAt < CONFIG.hostIdleMs) throw new Error('房主仍在响应，请稍后再试。');
      room.hostId = p.id; room.hostActionAt = Date.now();
      addEvent(room, 'join', `${p.name} 已接管房主权限`); publish(room);
    });
    handle('kick', data => {
      const { room, p } = bound();
      if (room.hostId !== p.id) throw new Error('只有房主可以移除席位。');
      if (!['lobby', 'finished'].includes(room.phase)) throw new Error('任务进行中不能移除席位。');
      const target = room.players.find(q => q.id === data.id);
      if (!target || target.id === p.id) throw new Error('无法移除这个席位。');
      const targetSocket = io.sockets.sockets.get(target.socketId);
      removePlayer(room, target);
      if (targetSocket) {
        targetSocket.data.binding = null;
        targetSocket.leave(room.code);
        targetSocket.emit('kicked');
      }
      addEvent(room, 'disconnect', `${target.name} 的席位已由房主移除`);
      publish(room);
    });
    handle('input', data => {
      const { room, p } = bound();
      if (room.phase !== 'playing') return;
      if (!Number.isSafeInteger(data.seq) || data.seq <= p.seq || !Number.isFinite(data.x) || !Number.isFinite(data.y)) return;
      p.seq = data.seq;
      p.input = { x: Math.max(-1, Math.min(1, data.x)), y: Math.max(-1, Math.min(1, data.y)) }; p.inputAt = Date.now();
    });
    handle('action', data => {
      const { room, p } = bound();
      if (!Number.isSafeInteger(data.seq) || data.seq <= p.actionSeq) return { applied: false };
      p.actionSeq = data.seq;
      const applied = action(room, p, data.kind); if (applied) publish(room);
      return { applied };
    });
    handle('emote', data => {
      const { room, p } = bound();
      if (!['这里！', '漂亮！', '收到'].includes(data.text) || Date.now() < p.emoteUntil - 1500) return;
      if (room.hostId === p.id && ['lobby', 'finished'].includes(room.phase)) room.hostActionAt = Date.now();
      p.emote = data.text; p.emoteUntil = Date.now() + 2500; publish(room);
    });
    handle('ping:check', () => ({ time: Date.now() }));
    handle('leave', () => {
      const { room, p } = bound(); removePlayer(room, p); socket.leave(room.code); socket.data.binding = null;
      if (room.players.length) addEvent(room, 'disconnect', `${p.name} 离开了星环`);
      publish(room);
    });
    socket.on('disconnect', () => {
      const binding = socket.data.binding;
      if (!binding) return;
      const room = rooms.get(binding.code), p = room?.players.find(p => p.id === binding.id);
      if (p?.socketId === socket.id) { disconnectPlayer(room, p); publish(room); }
    });
  });
  let last = performance.now(), ticks = 0, accumulator = 0;
  const timer = setInterval(() => {
    const now = performance.now();
    accumulator = Math.min(accumulator + (now - last) / 1000, .1); last = now;
    while (accumulator >= 1 / CONFIG.tickRate) {
      accumulator -= 1 / CONFIG.tickRate; ticks++;
      for (const [code, room] of rooms) {
        tick(room, 1 / CONFIG.tickRate);
        if (room.emptySince && Date.now() - room.emptySince > 300_000) { rooms.delete(code); continue; }
        if (ticks % 2 === 0 && room.players.some(p => p.connected)) publish(room);
      }
    }
  }, 1000 / CONFIG.tickRate);
  return { rooms, io, httpServer,
    listen: () => new Promise((resolve, reject) => { httpServer.once('error', reject); httpServer.listen(port, host, () => resolve(httpServer.address())); }),
    close: () => new Promise(resolve => { clearInterval(timer); io.close(() => resolve()); }) };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 3000);
  const server = createGameServer({ port });
  server.httpServer.on('error', error => { console.error(error.message); process.exit(1); });
  const address = await server.listen();
  const actualPort = address.port;
  console.log(`\n  ORBIT RELAY · 星环接力\n  Local: http://localhost:${actualPort}`);
  for (const n of Object.values(os.networkInterfaces()).flat()) {
    if (n.family === 'IPv4' && !n.internal) console.log(`  LAN:   http://${n.address}:${actualPort}`);
  }
  console.log('  Server-authoritative · 30 Hz simulation · 2–4 players\n');
  if (process.argv.includes('--open')) {
    const { spawn } = await import('node:child_process');
    const browser = spawn('powershell.exe', ['-NoProfile', '-Command', `Start-Process 'http://localhost:${actualPort}'`],
      { stdio: 'ignore', windowsHide: true });
    browser.on('error', error => console.error(`Could not open browser: ${error.message}`));
    browser.on('exit', code => { if (code) console.error(`Could not open browser (exit ${code}). Use the Local URL above.`); });
  }
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => { await server.close(); process.exit(0); });
}
