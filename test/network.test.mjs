import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { io } from 'socket.io-client';
import { createGameServer } from '../server.mjs';
import { DOCKS, CONFIG, snapshot } from '../game.mjs';

const request = (s, event, data = {}) => new Promise((resolve, reject) => s.timeout(2500).emit(event, data, (err, response) => err ? reject(err) : resolve(response)));
async function setup(t) {
  const server = createGameServer({ port: 0, host: '127.0.0.1' });
  const address = await server.listen(), url = `http://127.0.0.1:${address.port}`, sockets = [];
  t.after(async () => { sockets.forEach(s => s.disconnect()); await server.close(); });
  async function connect() {
    const s = io(url, { transports: ['websocket'], forceNew: true, reconnection: false }); sockets.push(s);
    await once(s, 'connect'); return s;
  }
  return { server, url, connect };
}

test('four independent network clients share room; fifth is rejected; other rooms isolated', { timeout: 10000 }, async t => {
  const { server, connect } = await setup(t);
  const clients = await Promise.all([connect(), connect(), connect(), connect(), connect()]);
  const a = await request(clients[0], 'join', { create: true, name: 'A' }); assert.equal(a.ok, true);
  for (let i = 1; i < 4; i++) assert.equal((await request(clients[i], 'join', { code: a.code, name: `P${i}` })).ok, true);
  assert.equal((await request(clients[4], 'join', { code: a.code })).ok, false);
  const b = await request(clients[4], 'join', { create: true, name: 'Elsewhere' });
  const seen = []; clients[4].on('state', state => seen.push(state.code));
  await delay(160); assert.ok(seen.length); assert.ok(seen.every(code => code === b.code));
  assert.equal(server.rooms.get(a.code).players.length, 4);
  assert.equal((await request(clients[1], 'start')).ok, false);
  for (let i = 0; i < 4; i++) await request(clients[i], 'ready', { ready: true });
  assert.equal((await request(clients[0], 'start')).ok, true);
  assert.equal(server.rooms.get(a.code).phase, 'countdown');
});

test('simultaneous real-network pickup, replay rejection, exactly-once delivery', { timeout: 10000 }, async t => {
  const { server, connect } = await setup(t); const a = await connect(), b = await connect();
  const ja = await request(a, 'join', { create: true, name: 'A' }); await request(b, 'join', { code: ja.code, name: 'B' });
  await request(a, 'ready', { ready: true }); await request(b, 'ready', { ready: true }); await request(a, 'start');
  const room = server.rooms.get(ja.code);
  // Explicit fixture positioning isolates protocol arbitration from random spawn/movement.
  room.phase = 'playing'; room.elapsed = 1;
  const [pa, pb] = room.players; pb.x = pa.x; pb.y = pa.y;
  room.cores = [room.cores[0]]; room.cores[0].x = pa.x; room.cores[0].y = pa.y;
  const results = await Promise.all([request(a, 'action', { kind: 'interact', seq: 1 }), request(b, 'action', { kind: 'interact', seq: 1 })]);
  assert.equal(results.filter(r => r.applied).length, 1);
  const winner = pa.carry ? a : b, p = pa.carry ? pa : pb;
  const type = room.cores[0].type; p.x = DOCKS[type].x; p.y = DOCKS[type].y;
  room.elapsed += .3;
  assert.equal((await request(winner, 'action', { kind: 'interact', seq: 2 })).applied, true);
  room.elapsed += .3;
  assert.equal((await request(winner, 'action', { kind: 'interact', seq: 2 })).applied, false);
  assert.equal(room.delivered, 1);
  await request(winner, 'input', { x: 1000, y: 1000, seq: 10 }); assert.deepEqual(p.input, { x: 1, y: 1 });
  await request(winner, 'input', { x: -1, y: -1, seq: 9 }); assert.deepEqual(p.input, { x: 1, y: 1 });
  await request(winner, 'input', { x: 'bad', y: null, seq: 11 }); assert.deepEqual(p.input, { x: 1, y: 1 });
});

test('disconnect restores identity and full state with token, releases cargo, migrates host', { timeout: 10000 }, async t => {
  const { server, connect } = await setup(t); const a = await connect(), b = await connect();
  const ja = await request(a, 'join', { create: true, name: 'A' }); const jb = await request(b, 'join', { code: ja.code, name: 'B' });
  const room = server.rooms.get(ja.code); const pa = room.players[0]; pa.delivered = 5; pa.x = 210;
  room.phase = 'playing';
  const thief = await connect(); assert.equal((await request(thief, 'join', { code: ja.code, token: ja.token })).ok, false);
  a.disconnect(); await delay(80);
  assert.equal(room.hostId, jb.id); assert.equal(pa.connected, false);
  const reconnect = await connect(); const recovered = await request(reconnect, 'join', { code: ja.code, token: ja.token });
  assert.equal(recovered.ok, true); assert.equal(recovered.id, ja.id); assert.equal(recovered.state.players.find(p => p.id === ja.id).delivered, 5);
  assert.equal(pa.x, 210); assert.equal(room.players.length, 2);
  assert.ok(pa.invulnerable > 0 && pa.invulnerable <= CONFIG.joinShield);
  assert.ok(!JSON.stringify(recovered.state).includes(ja.token));
  reconnect.disconnect(); await delay(60); pa.disconnectedAt = Date.now() - 91_000; await delay(80);
  assert.equal((await request(thief, 'join', { code: ja.code, token: ja.token })).ok, false);
  assert.match(room.events.at(-1).text, /重连席位已过期/);
});
test('host removal revokes the old seat, permits a new room on the same socket, and resets the empty room', { timeout: 10000 }, async t => {
  const { server, connect } = await setup(t);
  const host = await connect(), guest = await connect(), outsider = await connect();
  const joined = await request(host, 'join', { create: true, name: 'Host' });
  const peer = await request(guest, 'join', { code: joined.code, name: 'Guest' });
  await request(outsider, 'join', { create: true, name: 'Other' });
  assert.equal((await request(outsider, 'kick', { id: peer.id })).ok, false);
  assert.equal((await request(host, 'kick', { id: joined.id })).ok, false);
  const kicked = once(guest, 'kicked');
  assert.equal((await request(host, 'kick', { id: peer.id })).ok, true);
  await kicked;
  assert.equal((await request(guest, 'ready', { ready: true })).ok, false);
  assert.equal(server.rooms.get(joined.code).players.length, 1);
  assert.equal((await request(guest, 'join', { code: joined.code, token: peer.token })).ok, false);
  const fresh = await request(guest, 'join', { create: true, name: 'Fresh start' });
  assert.equal(fresh.ok, true);
  assert.notEqual(fresh.code, joined.code);
  assert.equal(server.rooms.get(fresh.code).players[0].id, fresh.id);
  assert.equal((await request(host, 'leave')).ok, true);
  const room = server.rooms.get(joined.code);
  assert.equal(room.phase, 'lobby'); assert.equal(room.players.length, 0);
  assert.equal(room.events.length, 0);
});

test('ready teammates can claim an idle host without bypassing the two-ready-player rule', { timeout: 10000 }, async t => {
  const { server, connect } = await setup(t);
  const host = await connect(), a = await connect(), b = await connect();
  const jh = await request(host, 'join', { create: true, name: 'Host' });
  const ja = await request(a, 'join', { code: jh.code, name: 'A' });
  await request(b, 'join', { code: jh.code, name: 'B' });
  const room = server.rooms.get(jh.code);
  await request(a, 'ready', { ready: true });
  room.hostActionAt = Date.now() - CONFIG.hostIdleMs - 1;
  assert.equal((await request(a, 'claim:host')).ok, false);
  await request(b, 'ready', { ready: true });
  room.hostActionAt = Date.now();
  assert.equal((await request(a, 'claim:host')).ok, false);
  room.hostActionAt = Date.now() - CONFIG.hostIdleMs - 1;
  assert.equal((await request(a, 'claim:host')).ok, true);
  assert.equal(room.hostId, ja.id);
  assert.equal((await request(b, 'claim:host')).ok, false);
  assert.equal((await request(host, 'start')).ok, false);
  assert.equal((await request(a, 'start')).ok, false);
  assert.equal((await request(a, 'kick', { id: jh.id })).ok, true);
  assert.equal((await request(a, 'start')).ok, true);
});

test('membership, ready and emote changes restart the idle-host takeover window', { timeout: 10000 }, async t => {
  const { server, connect } = await setup(t);
  const host = await connect(), a = await connect(), b = await connect(), c = await connect();
  const jh = await request(host, 'join', { create: true, name: 'Host' });
  await request(host, 'ready', { ready: true });
  const room = server.rooms.get(jh.code);
  await request(a, 'join', { code: jh.code, name: 'A' });
  room.hostActionAt = Date.now() - CONFIG.hostIdleMs - 5000;
  assert.equal((await request(a, 'claim:host')).ok, false); // A is not ready yet

  await request(a, 'ready', { ready: true });
  assert.ok(snapshot(room).hostIdleIn > CONFIG.hostIdleMs / 1000 - 2, 'member ready did not restart host window');
  room.hostActionAt = Date.now() - CONFIG.hostIdleMs - 5000;
  const unchangedAt = room.hostActionAt;
  assert.equal((await request(a, 'ready', { ready: true })).ok, true);
  assert.equal(room.hostActionAt, unchangedAt, 'repeated member ready must not restart host window');
  assert.equal((await request(a, 'ready', { ready: 'true' })).ok, false);
  await request(host, 'ready', { ready: true });
  assert.ok(snapshot(room).hostIdleIn > CONFIG.hostIdleMs / 1000 - 2, 'host response must restart host window');

  room.hostActionAt = Date.now() - CONFIG.hostIdleMs - 5000;
  await request(b, 'join', { code: jh.code, name: 'B' });
  assert.ok(snapshot(room).hostIdleIn > CONFIG.hostIdleMs / 1000 - 2, 'member join did not restart host window');

  room.hostActionAt = Date.now() - CONFIG.hostIdleMs - 5000;
  await request(b, 'ready', { ready: true });
  assert.ok(snapshot(room).hostIdleIn > CONFIG.hostIdleMs / 1000 - 2, 'member ready did not restart host window');

  room.hostActionAt = Date.now() - CONFIG.hostIdleMs - 5000;
  await request(c, 'join', { code: jh.code, name: 'C' });
  await request(c, 'leave');
  assert.ok(snapshot(room).hostIdleIn > CONFIG.hostIdleMs / 1000 - 2, 'member leave did not restart host window');

  const d = await connect();
  await request(d, 'join', { code: jh.code, name: 'D' });
  room.hostActionAt = Date.now() - CONFIG.hostIdleMs - 5000;
  d.disconnect(); await delay(80);
  assert.ok(snapshot(room).hostIdleIn > CONFIG.hostIdleMs / 1000 - 2, 'member disconnect did not restart host window');

  room.hostActionAt = Date.now() - CONFIG.hostIdleMs - 5000;
  await request(a, 'emote', { text: '这里！' });
  assert.ok(Date.now() - room.hostActionAt > CONFIG.hostIdleMs - 1000, 'member emote must not restart host window');

  room.hostActionAt = Date.now() - CONFIG.hostIdleMs - 1;
  assert.equal((await request(a, 'claim:host')).ok, true);
  assert.equal((await request(a, 'start')).ok, true);
});

test('HTTP health works, source paths denied, foreign origins rejected', { timeout: 10000 }, async t => {
  const { url } = await setup(t);
  assert.equal((await (await fetch(`${url}/api/health`)).json()).ok, true);
  assert.equal((await fetch(`${url}/server.mjs`)).status, 404);
  const s = io(url, { transports: ['websocket'], forceNew: true, reconnection: false, extraHeaders: { Origin: 'https://unrelated.example' } });
  t.after(() => s.disconnect()); const [err] = await once(s, 'connect_error'); assert.ok(err);
});
