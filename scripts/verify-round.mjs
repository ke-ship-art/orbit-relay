// End-to-end gameplay verification. Only public Socket.IO messages are used;
// no server internals, fixture coordinates, score edits or accelerated clock.
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { io } from 'socket.io-client';
import { DOCKS } from '../public/shared.js';

const url = process.env.GAME_URL || `http://127.0.0.1:${process.env.PORT || 3000}`;
const count = Number(process.argv[2] || 4);
const request = (s, event, data = {}) => new Promise((resolve, reject) => s.timeout(3000).emit(event, data, (err, r) => err || !r?.ok ? reject(err || new Error(r?.error)) : resolve(r)));
const bots = []; let timer, roomCode, disconnected = false, restored = false;
function connected(socket) {
  if (socket.connected) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => done(new Error('Connection timed out')), 6000);
    const onConnect = () => done(); const onError = error => done(error);
    function done(error) { clearTimeout(timeout); socket.off('connect', onConnect); socket.off('connect_error', onError); error ? reject(error) : resolve(); }
    socket.once('connect', onConnect); socket.once('connect_error', onError);
  });
}
const started = Date.now();
try {
  for (let i = 0; i < count; i++) {
    const socket = io(url, { transports: ['websocket'], forceNew: true, reconnection: false });
    const bot = { socket, seq: 0, actionSeq: 0, target: null, lastAction: 0, state: null, index: i };
    bots.push(bot); socket.on('state', state => { bot.state = state; }); await connected(socket);
    bot.seat = await request(socket, 'join', i === 0 ? { create: true, name: '验收-A' } : { code: roomCode, name: `验收-${i + 1}` });
    roomCode = bot.seat.code; await request(socket, 'ready', { ready: true });
  }
  await request(bots[0].socket, 'start'); console.log(`Started ${count}-client real-network round ${roomCode}`);
  timer = setInterval(() => {
    const claims = new Set();
    for (const bot of bots) {
      const s = bot.state, p = s?.players.find(p => p.id === bot.seat.id);
      if (!p?.connected || !bot.socket.connected || s.phase !== 'playing') continue;
      const cargo = s.cores.find(c => c.id === p.carry);
      let goal;
      if (cargo) { goal = DOCKS[cargo.type]; bot.target = null; }
      else {
        let c = s.cores.find(c => c.id === bot.target && !c.holder && !claims.has(c.id));
        if (!c) c = s.cores.filter(c => !c.holder && !claims.has(c.id)).sort((a, b) => Math.hypot(a.x - p.x, a.y - p.y) - Math.hypot(b.x - p.x, b.y - p.y))[0];
        if (!c) continue; bot.target = c.id; claims.add(c.id); goal = c;
      }
      let dx = goal.x - p.x, dy = goal.y - p.y, distance = Math.hypot(dx, dy);
      if (distance < (cargo ? 58 : 39) && Date.now() - bot.lastAction > 280 && p.stun <= 0) {
        bot.socket.emit('action', { kind: 'interact', seq: ++bot.actionSeq }); bot.lastAction = Date.now(); dx = dy = 0;
      } else {
        const factor = Math.max(0, Math.min(1, -(p.x * dx + p.y * dy) / Math.max(1, distance * distance)));
        const closest = Math.hypot(p.x + factor * dx, p.y + factor * dy);
        if (closest < 95) {
          const a = Math.atan2(p.y, p.x), b = Math.atan2(goal.y, goal.x);
          const diff = Math.atan2(Math.sin(b - a), Math.cos(b - a));
          const waypoint = a + Math.sign(diff) * .5;
          dx = Math.cos(waypoint) * 145 - p.x; dy = Math.sin(waypoint) * 145 - p.y;
        }
        if (p.dash <= 0 && distance > 120 && closest > 110) bot.socket.emit('action', { kind: 'dash', seq: ++bot.actionSeq });
      }
      const len = Math.hypot(dx, dy); bot.socket.volatile.emit('input', { x: dx / Math.max(1, len), y: dy / Math.max(1, len), seq: ++bot.seq });
    }
  }, 40);
  while (Date.now() - started < 165_000) {
    await delay(250); const s = bots[0].state;
    if (s?.delivered >= 3 && !disconnected) {
      disconnected = true; const b = bots.at(-1); b.socket.disconnect(); console.log('Disconnecting last client mid-round.');
      await delay(600); b.socket.connect(); await connected(b.socket);
      const oldId = b.seat.id; b.seat = await request(b.socket, 'join', { code: roomCode, token: b.seat.token });
      assert.equal(b.seat.id, oldId); b.seq = b.actionSeq = 0; restored = true; console.log('Recovered original identity and live room snapshot.');
    }
    if (s?.phase === 'finished') {
      assert.equal(s.result, 'won', `Round failed at ${s.delivered}/18; stability ${s.stability}`);
      assert.equal(s.delivered, 18); assert.ok(restored);
      await delay(150);
      for (const bot of bots) assert.equal(bot.state.delivered, 18);
      console.log(JSON.stringify({ players: count, result: s.result, deliveries: s.delivered, gameSeconds: Number(s.elapsed.toFixed(2)), reconnected: restored, snapshotBytes: Buffer.byteLength(JSON.stringify(s)) }));
      clearInterval(timer);
      for (const b of bots) await request(b.socket, 'ready', { ready: true });
      const host = bots.find(b => b.seat.id === s.hostId); await request(host.socket, 'start');
      await delay(150); assert.equal(bots[0].state.phase, 'countdown'); assert.equal(bots[0].state.delivered, 0);
      console.log('Rematch entered countdown with a clean score. PASS');
      break;
    }
  }
  assert.equal(bots[0].state?.phase, 'countdown', 'Full round did not complete in deadline');
} finally {
  clearInterval(timer);
  for (const b of bots) { if (b.socket.connected) await request(b.socket, 'leave').catch(() => {}); b.socket.disconnect(); }
}
