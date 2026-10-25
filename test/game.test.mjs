import test from 'node:test';
import assert from 'node:assert/strict';
import { makeRoom, addPlayer, removePlayer, startRound, action, tick, snapshot, disconnectPlayer, DOCKS, CONFIG } from '../game.mjs';

function setup() {
  const room = makeRoom('TEST1');
  const a = addPlayer(room, 'A'), b = addPlayer(room, 'B');
  a.ready = b.ready = true; startRound(room); tick(room, 3.01);
  return { room, a, b };
}
function coreNear(room, p, type = 0) {
  const c = room.cores.find(c => c.type === type);
  c.x = p.x; c.y = p.y; room.cores = [c]; return c;
}
function invariants(room) {
  const holders = new Set();
  for (const c of room.cores) {
    if (!c.holder) continue;
    assert.ok(!holders.has(c.holder)); holders.add(c.holder);
    assert.equal(room.players.find(p => p.id === c.holder)?.carry, c.id);
  }
  for (const p of room.players) if (p.carry) assert.equal(room.cores.find(c => c.id === p.carry)?.holder, p.id);
}

test('requires 2 ready players, room cap is 4', () => {
  const r = makeRoom('AAAAA'); const p = addPlayer(r, 'a'); p.ready = true;
  assert.throws(() => startRound(r), /至少/);
  addPlayer(r, 'b'); assert.throws(() => startRound(r), /准备/);
  addPlayer(r, 'c'); addPlayer(r, 'd'); assert.throws(() => addPlayer(r, 'e'), /已满/);
});
test('contested pickup has exactly one owner', () => {
  const { room, a, b } = setup(); b.x = a.x; b.y = a.y; const c = coreNear(room, a);
  assert.equal(action(room, a, 'interact'), true); assert.equal(action(room, b, 'interact'), false);
  assert.equal(c.holder, a.id); assert.equal(b.carry, null); invariants(room);
});
test('wrong dock throws; matching dock scores once and consumes core', () => {
  const { room, a } = setup(); coreNear(room, a);
  action(room, a, 'interact'); Object.assign(a, DOCKS[1]); room.elapsed += .3;
  action(room, a, 'interact'); assert.equal(room.delivered, 0); assert.equal(a.carry, null);
  const c = room.cores[0]; c.x = a.x; c.y = a.y; room.elapsed += .4;
  action(room, a, 'interact'); a.x = DOCKS[0].x; a.y = DOCKS[0].y; room.elapsed += .3;
  action(room, a, 'interact'); action(room, a, 'interact');
  assert.equal(room.delivered, 1); assert.equal(a.delivered, 1); assert.ok(!room.cores.some(q => q.id === c.id)); invariants(room);
});
test('supply waves pace the round and cannot exceed the delivery goal', () => {
  const { room } = setup(); assert.equal(room.cores.length, 3);
  room.elapsed = 8.99; tick(room, .02); assert.equal(room.cores.length, 6);
  room.cores = []; room.spawned = 15; room.nextSupply = 20; room.elapsed = 20;
  tick(room, .02); assert.equal(room.spawned, 18); assert.equal(room.cores.length, 3);
  room.elapsed = 100; tick(room, .02); assert.equal(room.spawned, 18);
});
test('backlogged supply reports blockage until cores are cleared', () => {
  const { room } = setup();
  room.cores = Array.from({ length: CONFIG.maxLooseCores + 1 }, (_, i) => ({ id: `core-${i}`, type: 0, x: 200, y: 0, holder: null, vx: 0, vy: 0 }));
  room.elapsed = room.nextSupply;
  tick(room, .01);
  assert.equal(snapshot(room).supplyBlocked, true);
  assert.equal(room.spawned, CONFIG.supplyBatchSize);
  room.cores.pop(); tick(room, .01);
  assert.equal(snapshot(room).supplyBlocked, false);
  assert.equal(room.spawned, CONFIG.supplyBatchSize * 2);
});
test('combo expires after its window and a dropped core loses its old relay bonus', () => {
  const { room, a, b } = setup();
  const c = coreNear(room, a);
  action(room, a, 'interact'); room.elapsed += .3; action(room, a, 'interact');
  b.x = c.x; b.y = c.y; room.elapsed += .4; action(room, b, 'interact');
  assert.equal(c.relay, true);
  disconnectPlayer(room, b);
  assert.equal(c.relay, false);
  room.combo = 4; room.lastDelivery = room.elapsed;
  tick(room, CONFIG.comboWindow + .01);
  assert.equal(snapshot(room).combo, 0);
});
test('handoff earns relay bonus and does not duplicate the core', () => {
  const { room, a, b } = setup(); const c = coreNear(room, a);
  action(room, a, 'interact'); room.elapsed += .3; action(room, a, 'interact');
  b.x = c.x; b.y = c.y; room.elapsed += .4; action(room, b, 'interact');
  assert.equal(c.relay, true); b.x = DOCKS[0].x; b.y = DOCKS[0].y;
  room.stability = 50; room.elapsed += .3; action(room, b, 'interact');
  assert.equal(room.relays, 1); assert.equal(room.stability, 61); invariants(room);
});
test('stale movement stops; diagonal is normalized; boundaries clamp', () => {
  const { room, a } = setup(); const before = { x: a.x, y: a.y };
  a.input = { x: 1, y: 1 }; a.inputAt = 1000; tick(room, .1, 1000);
  assert.ok(Math.abs(Math.hypot(a.x - before.x, a.y - before.y) - CONFIG.speed * .1) < .001);
  const x = a.x; tick(room, .1, 1400); assert.equal(a.x, x);
  a.x = 10000; a.y = 0; tick(room, .01, 1400); assert.ok(Math.hypot(a.x, a.y) <= CONFIG.radius - 19);
  a.x = 0; a.y = 0; tick(room, .01, 1400); assert.ok(Math.hypot(a.x, a.y) >= 65.9);
});
test('dash cooldown and hazard drop are server controlled', () => {
  const { room, a } = setup(); coreNear(room, a); action(room, a, 'interact');
  assert.equal(action(room, a, 'dash'), true); assert.equal(action(room, a, 'dash'), false);
  a.invulnerable = 0; a.x = 110; a.y = 0; room.elapsed = 9.99;
  tick(room, .01); assert.equal(a.carry, null); assert.ok(a.stun > 0); invariants(room);
});
test('disconnect releases core, migrates host, expires seat after 90s', () => {
  const { room, a, b } = setup(); coreNear(room, a); action(room, a, 'interact');
  disconnectPlayer(room, a, 1000); assert.equal(a.carry, null); assert.equal(room.hostId, b.id);
  tick(room, .01, 90000); assert.ok(room.players.includes(a));
  tick(room, .01, 91000); assert.ok(!room.players.includes(a)); invariants(room);
});
test('all offline pauses world; countdown with one player cancels', () => {
  const { room, a, b } = setup(); disconnectPlayer(room, a); disconnectPlayer(room, b);
  const elapsed = room.elapsed; tick(room, 1); assert.equal(room.elapsed, elapsed);
  const r = makeRoom('BBBBB'); const x = addPlayer(r, 'x'), y = addPlayer(r, 'y');
  x.ready = y.ready = true; startRound(r); disconnectPlayer(r, y); tick(r, .1);
  assert.equal(r.phase, 'lobby'); assert.equal(r.cores.length, 0);
  assert.ok(Date.now() - r.hostActionAt < 1000);
});
test('removing the last seat resets the old round before a new player joins', () => {
  const { room, a, b } = setup();
  room.delivered = 5; room.combo = 3;
  removePlayer(room, a); removePlayer(room, b);
  assert.equal(room.phase, 'lobby'); assert.equal(room.cores.length, 0);
  assert.equal(room.delivered, 0); assert.equal(room.combo, 0);
  assert.ok(room.emptySince);
  const next = addPlayer(room, 'New');
  assert.equal(next.connected, true); assert.equal(room.phase, 'lobby'); assert.equal(room.emptySince, null);
});
test('win and restart reset round state, timeout and instability lose', () => {
  const { room, a, b } = setup(); coreNear(room, a); action(room, a, 'interact');
  room.delivered = room.goal - 1; a.x = DOCKS[0].x; a.y = DOCKS[0].y; room.elapsed += .3;
  action(room, a, 'interact'); assert.equal(room.result, 'won'); assert.equal(room.phase, 'finished');
  assert.ok(Date.now() - room.hostActionAt < 1000);
  a.hitWave = 0; a.ready = b.ready = true; startRound(room);
  assert.equal(a.hitWave, -1); assert.equal(room.delivered, 0); assert.equal(room.relays, 0); assert.equal(a.carry, null);
  tick(room, 3.1); room.elapsed = CONFIG.duration; tick(room, .01); assert.equal(room.result, 'lost');
  a.ready = b.ready = true; startRound(room); tick(room, 3.1); room.stability = .001; tick(room, .1); assert.equal(room.result, 'lost');
});
test('public snapshots never include credentials or private connection state', () => {
  const { room, a } = setup(); a.socketId = 'private-socket';
  const s = JSON.stringify(snapshot(room));
  assert.ok(!s.includes(a.token)); assert.ok(!s.includes('private-socket')); assert.ok(!s.includes('inputAt'));
});
test('random sequences preserve ownership invariants across pickups, throws, ticks and disconnects', () => {
  const { room, a, b } = setup(); let seed = 123456;
  const rand = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32; };
  for (let i = 0; i < 3000; i++) {
    const p = rand() > .5 ? a : b;
    const c = room.cores[Math.floor(rand() * room.cores.length)];
    if (c && rand() > .7) { p.x = c.x; p.y = c.y; }
    if (rand() > .8) { p.x = DOCKS[0].x; p.y = DOCKS[0].y; }
    action(room, p, rand() > .8 ? 'dash' : 'interact'); tick(room, .03); invariants(room);
  }
});
