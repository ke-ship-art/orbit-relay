import { randomBytes, randomUUID } from 'node:crypto';

import { COLORS, DOCKS, CONFIG } from './public/shared.js';
export { COLORS, DOCKS, CONFIG };
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
export function makeRoom(code) {
  const now = Date.now();
  return { code, players: [], hostId: null, phase: 'lobby', cores: [], events: [], eventId: 0,
    elapsed: 0, remaining: CONFIG.duration, stability: 100, delivered: 0, goal: CONFIG.target,
    combo: 0, relays: 0, spawned: 0, nextSupply: CONFIG.supplyInterval, lastDelivery: -100, pulse: 0, wave: 0, revision: 0, emptySince: null, createdAt: now, hostActionAt: now };
}
export function addEvent(room, type, text, extra = {}) {
  room.events.push({ id: ++room.eventId, type, text, ...extra });
  room.events = room.events.slice(-10);
}
export function addPlayer(room, name, now = Date.now()) {
  const slot = Array.from({ length: CONFIG.maxPlayers }, (_, n) => n).find(n => !room.players.some(p => p.slot === n));
  if (slot === undefined) throw new Error(`房间已满，最多 ${CONFIG.maxPlayers} 名领航员。`);
  const a = slot * Math.PI / 2 - Math.PI / 4;
  const p = { id: randomUUID(), token: randomBytes(24).toString('hex'), name: String(name || '领航员').replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, 16) || '领航员',
    slot, color: COLORS[slot], x: Math.cos(a) * 145, y: Math.sin(a) * 145, angle: a,
    connected: true, ready: false, disconnectedAt: null, socketId: null, carry: null,
    delivered: 0, dash: 0, boost: 0, stun: 0, invulnerable: 0, actionAt: -1000,
    input: { x: 0, y: 0 }, inputAt: now, seq: -1, actionSeq: -1, hitWave: -1, emote: null, emoteUntil: 0 };
  room.players.push(p);
  room.emptySince = null;
  room.hostActionAt = now;
  if (!room.hostId) room.hostId = p.id;
  addEvent(room, 'join', `${p.name} 已接入星环`);
  return p;
}
export function dropCore(room, p, thrown = false) {
  const c = room.cores.find(c => c.id === p.carry);
  if (c) {
    c.holder = null; c.x = p.x; c.y = p.y; c.thrownBy = thrown ? p.id : null; c.relay = false;
    c.vx = thrown ? Math.cos(p.angle) * 370 : 0;
    c.vy = thrown ? Math.sin(p.angle) * 370 : 0;
    c.lockUntil = room.elapsed + (thrown ? .35 : .6);
  }
  p.carry = null;
}
export function disconnectPlayer(room, p, now = Date.now()) {
  p.connected = false; p.ready = false; p.disconnectedAt = now; p.input = { x: 0, y: 0 };
  dropCore(room, p);
  room.hostActionAt = now;
  if (room.hostId === p.id) room.hostId = room.players.find(q => q.connected)?.id ?? p.id;
  addEvent(room, 'disconnect', `${p.name} 信号中断 · 保留席位 ${CONFIG.reservationMs / 1000} 秒`);
}
export function removePlayer(room, p, now = Date.now()) {
  dropCore(room, p);
  room.players = room.players.filter(q => q.id !== p.id);
  room.hostActionAt = now;
  if (room.hostId === p.id) room.hostId = room.players.find(q => q.connected)?.id ?? room.players[0]?.id ?? null;
  if (!room.players.length) {
    Object.assign(room, { phase: 'lobby', cores: [], countdown: 0, result: null, elapsed: 0,
      remaining: CONFIG.duration, stability: 100, delivered: 0, combo: 0, relays: 0,
      spawned: 0, nextSupply: CONFIG.supplyInterval, lastDelivery: -100, pulse: 0, wave: 0, events: [],
      emptySince: now });
  }
}
export function spawnCore(room, type = Math.floor(Math.random() * 3)) {
  const a = Math.random() * Math.PI * 2, r = 115 + Math.random() * 100;
  room.cores.push({ id: randomUUID(), type, x: Math.cos(a) * r, y: Math.sin(a) * r, vx: 0, vy: 0, holder: null, lockUntil: 0 });
  room.spawned++;
}
export function startRound(room) {
  const connected = room.players.filter(p => p.connected);
  if (connected.length < CONFIG.minPlayers) throw new Error(`至少需要 ${CONFIG.minPlayers} 名在线领航员。`);
  if (connected.some(p => !p.ready)) throw new Error('请等待所有在线领航员准备。');
  if (room.phase === 'playing' || room.phase === 'countdown') throw new Error('任务已经开始。');
  Object.assign(room, { phase: 'countdown', countdown: 3, elapsed: 0, remaining: CONFIG.duration,
    stability: 100, delivered: 0, combo: 0, relays: 0, spawned: 0, nextSupply: CONFIG.supplyInterval, lastDelivery: -100, pulse: 0, wave: 0, cores: [], result: null });
  for (const p of room.players) {
    const a = p.slot * Math.PI / 2 - Math.PI / 4;
    Object.assign(p, { x: Math.cos(a) * 145, y: Math.sin(a) * 145, carry: null, delivered: 0,
      dash: 0, boost: 0, stun: 0, invulnerable: 0, hitWave: -1, actionAt: -1000, input: { x: 0, y: 0 }, emote: null, emoteUntil: 0 });
  }
  for (let i = 0; i < CONFIG.supplyBatchSize; i++) spawnCore(room, i % DOCKS.length);
  addEvent(room, 'start', '航道已打开 · 星环接力即将开始');
}
export function action(room, p, kind) {
  if (room.phase !== 'playing' || !p.connected || p.stun > 0) return false;
  if (kind === 'dash') {
    if (p.dash > 0) return false;
    p.dash = CONFIG.dashCooldown; p.boost = .22; p.invulnerable = .5;
    return true;
  }
  if (kind !== 'interact' || room.elapsed - p.actionAt < .22) return false;
  p.actionAt = room.elapsed;
  if (p.carry) {
    const c = room.cores.find(c => c.id === p.carry);
    if (!c) { p.carry = null; return false; }
    if (distance(p, DOCKS[c.type]) < CONFIG.deliveryRadius) {
      room.cores = room.cores.filter(q => q.id !== c.id);
      p.carry = null; p.delivered++; room.delivered++;
      room.combo = room.elapsed - room.lastDelivery <= CONFIG.comboWindow ? Math.min(room.combo + 1, CONFIG.maxCombo) : 1;
      room.lastDelivery = room.elapsed;
      if (c.relay) room.relays++;
      room.stability = Math.min(100, room.stability + 6 + room.combo + (c.relay ? CONFIG.relayBonus : 0));
      addEvent(room, 'delivery', `${p.name} 完成${c.relay ? '接力' : ''}投递${room.combo > 1 ? ` · ${room.combo} 连击` : ''}`, { x: p.x, y: p.y, color: DOCKS[c.type].color, relay: !!c.relay });
      if (room.delivered >= room.goal) finishRound(room, true);
      return true;
    }
    dropCore(room, p, true);
    addEvent(room, 'throw', `${p.name} 抛出了能量核`, { x: p.x, y: p.y, color: p.color });
    return true;
  }
  const c = room.cores.filter(c => !c.holder && room.elapsed >= c.lockUntil && distance(p, c) < CONFIG.pickupRadius)
    .sort((a, b) => distance(p, a) - distance(p, b))[0];
  if (!c) return false;
  // Single server event loop is the arbitration point: ownership changes atomically.
  if (c.thrownBy && c.thrownBy !== p.id) c.relay = true;
  c.holder = p.id; c.vx = 0; c.vy = 0; p.carry = c.id;
  return true;
}
export function finishRound(room, won) {
  room.phase = 'finished'; room.result = won ? 'won' : 'lost';
  room.hostActionAt = Date.now();
  for (const p of room.players) { p.input = { x: 0, y: 0 }; p.ready = false; }
  addEvent(room, 'finish', won ? '接力完成！星环重新点亮。' : '本次航行结束，下一次一起走得更远。');
}
export function tick(room, dt, now = Date.now()) {
  room.revision++;
  for (const p of [...room.players]) {
    if (!p.connected && now - p.disconnectedAt >= CONFIG.reservationMs) {
      removePlayer(room, p, now);
      if (room.players.length) addEvent(room, 'disconnect', `${p.name} 的重连席位已过期`);
    }
  }
  if (!room.players.some(p => p.connected)) { room.emptySince ??= now; return; }
  room.emptySince = null;
  if (room.phase === 'countdown') {
    if (room.players.filter(p => p.connected).length < CONFIG.minPlayers) {
      Object.assign(room, { phase: 'lobby', countdown: 0, cores: [], spawned: 0,
        nextSupply: CONFIG.supplyInterval, hostActionAt: now });
      addEvent(room, 'disconnect', '人数不足，发射取消'); return;
    }
    room.countdown -= dt;
    if (room.countdown <= 0) room.phase = 'playing';
    return;
  }
  if (room.phase !== 'playing') return;
  room.elapsed += dt; room.remaining = Math.max(0, CONFIG.duration - room.elapsed);
  if (room.elapsed - room.lastDelivery > CONFIG.comboWindow) room.combo = 0;
  if (room.elapsed >= room.nextSupply && room.spawned < room.goal && room.cores.length <= CONFIG.maxLooseCores) {
    for (let i = 0; i < CONFIG.supplyBatchSize && room.spawned < room.goal; i++) spawnCore(room, i % DOCKS.length);
    room.nextSupply = room.elapsed + CONFIG.supplyInterval;
    addEvent(room, 'supply', `第 ${Math.ceil(room.spawned / CONFIG.supplyBatchSize)} 批微光已抵达内环`);
  }
  room.stability = Math.max(0, room.stability - dt * .78);
  const phase = room.elapsed % CONFIG.pulsePeriod;
  room.pulse = phase >= CONFIG.pulseStartAt ? (phase - CONFIG.pulseStartAt) / (CONFIG.pulsePeriod - CONFIG.pulseStartAt) * 440 : 0;
  room.wave = Math.floor(room.elapsed / CONFIG.pulsePeriod);
  for (const p of room.players) {
    p.dash = Math.max(0, p.dash - dt); p.boost = Math.max(0, p.boost - dt);
    p.stun = Math.max(0, p.stun - dt); p.invulnerable = Math.max(0, p.invulnerable - dt);
    if (!p.connected) continue;
    if (p.stun <= 0 && now - p.inputAt < 300) {
      const len = Math.hypot(p.input.x, p.input.y);
      const speed = CONFIG.speed * (p.boost > 0 ? 3.2 : p.carry ? .86 : 1);
      if (len > .01) {
        p.angle = Math.atan2(p.input.y, p.input.x);
        p.x += p.input.x / Math.max(1, len) * speed * dt;
        p.y += p.input.y / Math.max(1, len) * speed * dt;
      }
    }
    let r = Math.hypot(p.x, p.y);
    if (r > CONFIG.radius - 19) { p.x *= (CONFIG.radius - 19) / r; p.y *= (CONFIG.radius - 19) / r; }
    // Reactor is a physical obstacle; prevents shortcutting through the center.
    r = Math.hypot(p.x, p.y);
    if (r < 66) { const a = r < .1 ? p.angle : Math.atan2(p.y, p.x); p.x = Math.cos(a) * 66; p.y = Math.sin(a) * 66; }
    if (room.pulse > 50 && Math.abs(Math.hypot(p.x, p.y) - room.pulse) < 16 && p.invulnerable <= 0 && p.hitWave !== room.wave) {
      p.hitWave = room.wave; p.stun = .7; p.invulnerable = 1; room.stability = Math.max(0, room.stability - 3);
      dropCore(room, p);
      addEvent(room, 'hit', `${p.name} 被干扰波击中`, { x: p.x, y: p.y, color: '#ff7e78' });
    }
    const held = room.cores.find(c => c.id === p.carry);
    if (held) { held.x = p.x; held.y = p.y - 25; }
    if (now > p.emoteUntil) p.emote = null;
  }
  for (const c of room.cores) {
    if (c.holder) continue;
    c.x += c.vx * dt; c.y += c.vy * dt;
    c.vx *= Math.exp(-3 * dt); c.vy *= Math.exp(-3 * dt);
    const r = Math.hypot(c.x, c.y);
    if (r > 355) { c.x *= 355 / r; c.y *= 355 / r; c.vx = 0; c.vy = 0; }
    if (r < 83) { const a = Math.atan2(c.y, c.x); c.x = Math.cos(a) * 83; c.y = Math.sin(a) * 83; }
  }
  if (room.remaining <= 0 || room.stability <= 0) finishRound(room, false);
}
export function snapshot(room, now = Date.now()) {
  return { code: room.code, hostId: room.hostId, phase: room.phase, revision: room.revision,
    hostIdleIn: Math.max(0, (room.hostActionAt + CONFIG.hostIdleMs - now) / 1000),
    serverTime: now, countdown: room.countdown, remaining: room.remaining, stability: room.stability,
    delivered: room.delivered, goal: room.goal, combo: room.combo, relays: room.relays, elapsed: room.elapsed,
    supplyIn: room.spawned < room.goal ? Math.max(0, room.nextSupply - room.elapsed) : null,
    supplyBlocked: room.spawned < room.goal && room.elapsed >= room.nextSupply && room.cores.length > CONFIG.maxLooseCores,
    supplyBatch: Math.ceil(room.spawned / CONFIG.supplyBatchSize),
    pulse: room.pulse, wave: room.wave, result: room.result, cores: room.cores, events: room.events,
    players: room.players.map(p => ({ id: p.id, name: p.name, slot: p.slot, color: p.color,
      x: p.x, y: p.y, angle: p.angle, connected: p.connected, ready: p.ready, carry: p.carry,
      delivered: p.delivered, dash: p.dash, boost: p.boost, stun: p.stun, invulnerable: p.invulnerable,
      emote: p.emote, reservedFor: p.connected ? 0 : Math.max(0, CONFIG.reservationMs - (now - p.disconnectedAt)) })) };
}
