import { DOCKS, CONFIG } from './shared.js';

const TAU = Math.PI * 2;
const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
function polygon(ctx, x, y, r, sides, angle = -Math.PI / 2) {
  ctx.beginPath(); for (let i = 0; i < sides; i++) {
    const a = angle + TAU * i / sides; const px = x + Math.cos(a) * r, py = y + Math.sin(a) * r;
    i ? ctx.lineTo(px, py) : ctx.moveTo(px, py);
  } ctx.closePath();
}
function circle(ctx, x, y, r, fill, stroke, width = 1) {
  ctx.beginPath(); ctx.arc(x, y, Math.max(.1, r), 0, TAU);
  if (fill) { ctx.fillStyle = fill; ctx.fill(); }
  if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = width; ctx.stroke(); }
}
function roundedRect(ctx, x, y, w, h, radius) {
  if (ctx.roundRect) { ctx.roundRect(x, y, w, h, radius); return; }
  const r = Math.min(radius, w / 2, h / 2);
  ctx.moveTo(x + r, y); ctx.lineTo(x + w - r, y); ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r); ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h); ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r); ctx.quadraticCurveTo(x, y, x + r, y); ctx.closePath();
}
function text(ctx, str, x, y, color = '#90a984', size = 10, align = 'center') {
  ctx.fillStyle = color; ctx.font = `${size}px "Segoe UI", "Microsoft YaHei", sans-serif`; ctx.textAlign = align; ctx.textBaseline = 'middle'; ctx.fillText(str, x, y);
}

export class WorldRenderer {
  constructor(canvas) {
    this.canvas = canvas; this.ctx = canvas.getContext('2d'); this.state = null; this.selfId = null;
    this.positions = new Map(); this.particles = []; this.eventId = 0; this.last = performance.now();
    this.lastPhase = null;
    new ResizeObserver(() => this.resize()).observe(canvas);
    this.resize(); requestAnimationFrame(t => this.frame(t));
  }
  resize() {
    const rect = this.canvas.getBoundingClientRect(); this.width = Math.max(1, rect.width); this.height = Math.max(1, rect.height); this.size = Math.min(this.width, this.height);
    this.dpr = Math.min(devicePixelRatio || 1, 2);
    this.canvas.width = Math.round(this.width * this.dpr); this.canvas.height = Math.round(this.height * this.dpr);
  }
  readableSize(worldSize, minimumPixels, localScale = 1) {
    return Math.max(worldSize, minimumPixels * 900 / (this.size * localScale));
  }
  setState(state, selfId, snap = false) {
    if (state?.code !== this.state?.code || snap || state?.phase === 'countdown' && this.lastPhase !== 'countdown') {
      this.positions.clear(); this.eventId = state?.events.at(-1)?.id || 0; this.particles = [];
    }
    this.state = state; this.selfId = selfId; this.lastPhase = state?.phase;
    for (const event of state?.events || []) {
      if (event.id <= this.eventId) continue;
      if (event.x !== undefined && !reduced) {
        const count = event.type === 'delivery' ? 32 : 14;
        for (let i = 0; i < count; i++) {
          const a = Math.random() * TAU, speed = 30 + Math.random() * 130;
          this.particles.push({ x: event.x, y: event.y, vx: Math.cos(a) * speed, vy: Math.sin(a) * speed, life: 1, color: event.color });
        }
      }
      this.eventId = event.id;
    }
  }
  frame(now) {
    const dt = Math.min((now - this.last) / 1000, .05); this.last = now;
    const ctx = this.ctx, scale = this.size / 900;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0); ctx.clearRect(0, 0, this.width, this.height);
    ctx.translate(this.width / 2, this.height / 2); ctx.scale(scale, scale);
    const t = reduced ? 0 : now / 1000;
    this.background(ctx, t); this.station(ctx, t);
    const liveIds = new Set((this.state?.players || []).map(p => p.id));
    for (const id of this.positions.keys()) if (!liveIds.has(id)) this.positions.delete(id);
    for (const p of this.state?.players || []) {
      let pos = this.positions.get(p.id);
      if (!pos || Math.hypot(pos.x - p.x, pos.y - p.y) > 130) { pos = { x: p.x, y: p.y }; this.positions.set(p.id, pos); }
      const alpha = 1 - Math.exp(-dt * 24); pos.x += (p.x - pos.x) * alpha; pos.y += (p.y - pos.y) * alpha;
    }
    const self = this.state?.players.find(p => p.id === this.selfId);
    const cargo = this.state?.cores.find(c => c.id === self?.carry);
    if (cargo && self) {
      const p = this.positions.get(self.id), dock = DOCKS[cargo.type];
      ctx.save(); ctx.setLineDash([5, 10]); ctx.lineDashOffset = -t * 20; ctx.strokeStyle = `${dock.color}55`; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(dock.x, dock.y); ctx.stroke(); ctx.restore();
      if (this.state?.phase === 'playing' && Math.hypot(self.x - dock.x, self.y - dock.y) >= CONFIG.deliveryRadius) {
        this.throwGuide(ctx, self, p);
      }
    }
    for (const [i, dock] of DOCKS.entries()) this.dock(ctx, dock, i, t, cargo?.type === i);
    for (const c of this.state?.cores || []) {
      const holder = this.positions.get(c.holder); this.core(ctx, { ...c, x: holder?.x ?? c.x, y: holder ? holder.y - 34 : c.y }, t);
    }
    for (const p of [...(this.state?.players || [])].sort((a, b) => a.y - b.y)) this.player(ctx, p, this.positions.get(p.id), t);
    this.reactor(ctx, t);
    if (this.state?.phase === 'playing') {
      const phase = this.state.elapsed % CONFIG.pulsePeriod;
      if (phase > CONFIG.pulseWarningAt && phase < CONFIG.pulseStartAt) {
        circle(ctx, 0, 0, 73 + Math.sin(t * 10) * 4, null, '#ff957988', 3);
        text(ctx, '干扰波即将来袭', 0, 91, '#efab86', this.readableSize(12, 11));
      }
      if (this.state.pulse > 0) {
        ctx.save(); ctx.globalAlpha = .65; ctx.shadowColor = '#ff805f'; ctx.shadowBlur = 14;
        circle(ctx, 0, 0, this.state.pulse, null, '#ffb696', 3);
        ctx.shadowBlur = 0; circle(ctx, 0, 0, Math.max(0, this.state.pulse - 9), null, '#ff8d6125', 16); ctx.restore();
      }
    }
    if (self && this.state?.phase === 'playing' && !self.carry && !matchMedia('(pointer: coarse)').matches && innerWidth > 700) {
      const nearest = this.state.cores.filter(c => !c.holder && Math.hypot(c.x - self.x, c.y - self.y) < CONFIG.pickupRadius)
        .sort((a, b) => Math.hypot(a.x - self.x, a.y - self.y) - Math.hypot(b.x - self.x, b.y - self.y))[0];
      if (nearest) {
        const fontSize = this.readableSize(12, 10), side = fontSize + 10;
        ctx.fillStyle = '#d7edc2'; ctx.beginPath(); roundedRect(ctx, nearest.x - side / 2, nearest.y - 44, side, side, 5); ctx.fill();
        text(ctx, 'E', nearest.x, nearest.y - 44 + side / 2, '#203018', fontSize);
      }
    }
    for (const p of this.particles) {
      p.x += p.vx * dt; p.y += p.vy * dt; p.life -= dt * 1.2;
      ctx.globalAlpha = Math.max(0, p.life); circle(ctx, p.x, p.y, 2.5 * p.life, p.color);
    }
    this.particles = this.particles.filter(p => p.life > 0); ctx.globalAlpha = 1;
    requestAnimationFrame(t2 => this.frame(t2));
  }
  throwGuide(ctx, self, position) {
    const dx = Math.cos(self.angle), dy = Math.sin(self.angle);
    let x = position.x + dx * 116, y = position.y + dy * 116;
    const radius = Math.hypot(x, y);
    if (radius > 355) { x *= 355 / radius; y *= 355 / radius; }
    else if (radius < 83) { const angle = Math.atan2(y, x); x = Math.cos(angle) * 83; y = Math.sin(angle) * 83; }
    ctx.save(); ctx.strokeStyle = '#eaf6d0aa'; ctx.fillStyle = '#eaf6d0cc'; ctx.lineWidth = 2;
    ctx.setLineDash([5, 5]); ctx.beginPath(); ctx.moveTo(position.x + dx * 28, position.y + dy * 28); ctx.lineTo(x, y); ctx.stroke();
    ctx.setLineDash([]); ctx.beginPath(); ctx.arc(x, y, 8, 0, TAU); ctx.stroke();
    const teammate = this.state.players.find(p => p.id !== self.id && p.connected && Math.hypot(p.x - x, p.y - y) < CONFIG.pickupRadius);
    if (teammate) {
      ctx.strokeStyle = '#b9ef83cc'; ctx.lineWidth = 3; ctx.beginPath(); ctx.arc(teammate.x, teammate.y, 34, 0, TAU); ctx.stroke();
    }
    ctx.restore();
  }
  background(ctx, t) {
    for (let i = 0; i < 90; i++) {
      const x = Math.sin(i * 17.13) * 440, y = Math.cos(i * 29.7) * 440;
      const opacity = .12 + (Math.sin(t * .5 + i) + 1) * .09;
      ctx.fillStyle = `rgba(183,212,167,${opacity})`; ctx.fillRect(x, y, i % 11 === 0 ? 2 : 1, i % 11 === 0 ? 2 : 1);
    }
    ctx.strokeStyle = '#6e8d5e0a'; ctx.lineWidth = 1;
    for (let i = -440; i <= 440; i += 40) {
      ctx.beginPath(); ctx.moveTo(i, -440); ctx.lineTo(i, 440); ctx.moveTo(-440, i); ctx.lineTo(440, i); ctx.stroke();
    }
  }
  station(ctx, t) {
    const r = CONFIG.radius;
    circle(ctx, 0, 22, r + 3, '#09120f'); circle(ctx, 0, 13, r + 1, '#25382a', '#354c32', 2);
    const grad = ctx.createRadialGradient(0, -100, 40, 0, 0, r); grad.addColorStop(0, '#23382a'); grad.addColorStop(.62, '#1a2c21'); grad.addColorStop(1, '#1c2e22');
    circle(ctx, 0, 0, r, grad, '#4c6342', 2);
    ctx.save(); ctx.beginPath(); ctx.arc(0, 0, r - 3, 0, TAU); ctx.clip();
    ctx.strokeStyle = '#77966112'; ctx.lineWidth = 1;
    for (let n = -400; n < 400; n += 38) {
      ctx.beginPath(); ctx.moveTo(n, -400); ctx.lineTo(n, 400); ctx.moveTo(-400, n); ctx.lineTo(400, n); ctx.stroke();
    }
    for (let i = 0; i < 12; i++) {
      const a = i * TAU / 12;
      ctx.strokeStyle = '#90b47118'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(Math.cos(a) * 80, Math.sin(a) * 80); ctx.lineTo(Math.cos(a) * (r - 25), Math.sin(a) * (r - 25)); ctx.stroke();
    }
    circle(ctx, 0, 0, 250, null, '#83a26616'); circle(ctx, 0, 0, 130, null, '#86a36c16');
    ctx.setLineDash([2, 9]); circle(ctx, 0, 0, 220, null, '#77986445'); ctx.setLineDash([]);
    ctx.restore();
    circle(ctx, 0, 0, r - 17, null, '#52734444', 12); circle(ctx, 0, 0, r - 17, null, '#9dc67744', 1);
    for (let i = 0; i < 72; i++) {
      const a = i * TAU / 72, active = i % 6 < 4;
      ctx.strokeStyle = active ? '#a5d57866' : '#3c5436'; ctx.lineWidth = i % 6 === 0 ? 3 : 2;
      ctx.beginPath(); ctx.moveTo(Math.cos(a) * (r - 9), Math.sin(a) * (r - 9));
      ctx.lineTo(Math.cos(a) * (r - (i % 6 === 0 ? 26 : 18)), Math.sin(a) * (r - (i % 6 === 0 ? 26 : 18))); ctx.stroke();
    }
    for (let i = 0; i < 3; i++) {
      ctx.strokeStyle = `${DOCKS[i].color}aa`; ctx.lineWidth = 4; ctx.beginPath();
      const a = [-Math.PI / 2, Math.PI / 6, 5 * Math.PI / 6][i]; ctx.arc(0, 0, r + 1, a - .13, a + .13); ctx.stroke();
    }
    text(ctx, 'N', 0, -r - 20, '#72985c', 12); text(ctx, 'S', 0, r + 23, '#4e7044', 10);
    text(ctx, 'W', -r - 22, 0, '#4e7044', 10); text(ctx, 'E', r + 22, 0, '#4e7044', 10);
    // Inset solar collectors make the platform feel like an inhabited object.
    for (let i = 0; i < 3; i++) {
      ctx.save(); ctx.rotate(i * TAU / 3 + Math.PI / 2);
      ctx.fillStyle = '#13271b'; ctx.strokeStyle = '#49623c'; ctx.lineWidth = 1;
      ctx.beginPath(); roundedRect(ctx, -32, -340, 64, 35, 5); ctx.fill(); ctx.stroke();
      for (let j = 0; j < 5; j++) { ctx.fillStyle = j === (Math.floor(t) % 5) ? '#a1bf6d77' : '#3b5430'; ctx.fillRect(-24 + j * 10, -332, 5, 18); }
      ctx.restore();
    }
  }
  dock(ctx, d, i, t, selected) {
    ctx.save(); ctx.translate(d.x, d.y);
    if (selected) { ctx.globalAlpha = .25 + Math.sin(t * 4) * .1; circle(ctx, 0, 0, 63, d.color); ctx.globalAlpha = 1; }
    circle(ctx, 0, 9, 47, '#07130e'); circle(ctx, 0, 3, 47, '#304632', `${d.color}55`, 2);
    const g = ctx.createRadialGradient(0, 0, 5, 0, 0, 44); g.addColorStop(0, `${d.color}25`); g.addColorStop(1, '#1b2d22');
    circle(ctx, 0, 0, 44, g, `${d.color}88`, 1.5); circle(ctx, 0, 0, 34, null, `${d.color}33`);
    ctx.save(); ctx.setLineDash([3, 6]); ctx.lineDashOffset = -t * 6; circle(ctx, 0, 0, 49, null, `${d.color}55`); ctx.restore();
    this.symbol(ctx, 0, -1, i, 15, d.color, false);
    text(ctx, `0${i + 1} / ${d.name}`, 0, 65, `${d.color}bb`, this.readableSize(11, 10));
    ctx.restore();
  }
  symbol(ctx, x, y, type, size, color, fill = true) {
    ctx.fillStyle = color; ctx.strokeStyle = color; ctx.lineWidth = 2.5;
    if (type === 2) { circle(ctx, x, y, size * .8, fill ? color : null, color, 2.5); return; }
    polygon(ctx, x, y, size, type === 0 ? 3 : 4); if (fill) ctx.fill(); else ctx.stroke();
  }
  core(ctx, c, t) {
    const color = DOCKS[c.type].color, bob = reduced ? 0 : Math.sin(t * 2.5 + c.x * .03) * 3;
    ctx.save(); ctx.translate(c.x, c.y);
    ctx.scale(1, .4); circle(ctx, 0, 18, 14, '#07140d66'); ctx.restore();
    ctx.save(); ctx.translate(c.x, c.y - 8 + bob);
    if (this.size < 500) ctx.scale(1.2, 1.2);
    ctx.shadowColor = color; ctx.shadowBlur = 18; circle(ctx, 0, 0, 13, `${color}15`, `${color}44`);
    this.symbol(ctx, 0, 0, c.type, 8, color); ctx.shadowBlur = 0;
    if (c.relay) { ctx.strokeStyle = '#e4f4cd'; ctx.lineWidth = 1; ctx.setLineDash([2, 3]); circle(ctx, 0, 0, 17, null, '#e4f4cd88'); }
    ctx.restore();
  }
  player(ctx, p, pos, t) {
    const mine = p.id === this.selfId;
    ctx.save(); ctx.translate(pos.x, pos.y); ctx.globalAlpha = p.connected ? 1 : .33;
    if (this.size < 500) ctx.scale(1.35, 1.35);
    ctx.save(); ctx.scale(1, .45); circle(ctx, 0, 27, 21, '#06110dcc'); ctx.restore();
    if (mine) { circle(ctx, 0, 0, 25, null, `${p.color}66`, 1.5); ctx.strokeStyle = p.color; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(0, 0, 26, -Math.PI / 2, -Math.PI / 2 + (1 - p.dash / CONFIG.dashCooldown) * TAU); ctx.stroke(); }
    if (p.invulnerable > 0 && !p.stun) circle(ctx, 0, 0, 31, `${p.color}12`, `${p.color}88`, 2);
    if (p.stun > 0) {
      for (let i = 0; i < 3; i++) { const a = t * 5 + i * TAU / 3; text(ctx, '✦', Math.cos(a) * 27, Math.sin(a) * 12 - 25, '#ffd59a', 11); }
    }
    ctx.save(); ctx.rotate(p.angle + Math.PI / 2);
    if (p.boost > 0) {
      const g = ctx.createLinearGradient(0, 14, 0, 80); g.addColorStop(0, `${p.color}cc`); g.addColorStop(1, `${p.color}00`);
      ctx.fillStyle = g; ctx.beginPath(); ctx.moveTo(-10, 10); ctx.lineTo(0, 75); ctx.lineTo(10, 10); ctx.fill();
    }
    ctx.fillStyle = '#3a4e39'; ctx.beginPath(); roundedRect(ctx, -17, -2, 34, 21, 7); ctx.fill();
    ctx.fillStyle = p.color; ctx.beginPath(); roundedRect(ctx, -13, -16, 26, 33, 10); ctx.fill();
    circle(ctx, 0, -6, 12, '#e4edd7'); ctx.fillStyle = '#17312a'; ctx.beginPath(); roundedRect(ctx, -9, -13, 18, 11, 5); ctx.fill();
    ctx.fillStyle = '#81d2bb'; ctx.beginPath(); roundedRect(ctx, -6, -11, 10, 3, 2); ctx.fill();
    ctx.fillStyle = '#23422a'; ctx.fillRect(-8, 13, 6, 7); ctx.fillRect(2, 13, 6, 7);
    ctx.restore();
    const localScale = this.size < 500 ? 1.35 : 1;
    text(ctx, p.name + (mine ? ' · 你' : ''), 0, 40, mine ? '#e0efce' : '#b1c8a3', this.readableSize(11, 10, localScale));
    if (mine) { text(ctx, '▼', 0, -38, p.color, 10); }
    if (p.emote) {
      const fontSize = this.readableSize(12, 12, localScale);
      ctx.font = `${fontSize}px sans-serif`; const w = ctx.measureText(p.emote).width + 22, height = fontSize + 14;
      ctx.fillStyle = '#dbeaca'; ctx.beginPath(); roundedRect(ctx, -w / 2, -72, w, height, 8); ctx.fill();
      text(ctx, p.emote, 0, -72 + height / 2, '#263b1e', fontSize);
    }
    if (!p.connected) text(ctx, '信号中断', 0, -33, '#ffbe88', 11);
    ctx.restore();
  }
  reactor(ctx, t) {
    circle(ctx, 0, 14, 65, '#08170f'); circle(ctx, 0, 7, 64, '#344e32', '#69874e', 1);
    circle(ctx, 0, 0, 64, '#243c29', '#5a7846', 2); circle(ctx, 0, 0, 55, '#192f22', '#91b86255', 2);
    ctx.save(); ctx.rotate(t * .16); ctx.setLineDash([12, 8]); circle(ctx, 0, 0, 59, null, '#c1e49388', 2); ctx.restore();
    const g = ctx.createRadialGradient(0, -6, 1, 0, 0, 46); g.addColorStop(0, '#bdf68b66'); g.addColorStop(1, '#bdf68b00'); circle(ctx, 0, -2, 48, g);
    ctx.save(); ctx.translate(0, -9 + Math.sin(t * 1.8) * 2); ctx.shadowColor = '#c2ff86'; ctx.shadowBlur = 20;
    polygon(ctx, 0, 0, 31, 6); ctx.fillStyle = '#a3d76d'; ctx.fill(); ctx.shadowBlur = 0;
    ctx.fillStyle = '#d5f8a3'; ctx.beginPath(); ctx.moveTo(0, -31); ctx.lineTo(27, -15); ctx.lineTo(0, 1); ctx.lineTo(-27, -15); ctx.closePath(); ctx.fill();
    ctx.fillStyle = '#6d9e4a'; ctx.beginPath(); ctx.moveTo(0, 1); ctx.lineTo(27, -15); ctx.lineTo(27, 16); ctx.lineTo(0, 31); ctx.closePath(); ctx.fill();
    ctx.fillStyle = '#b4e182'; ctx.beginPath(); ctx.moveTo(-27, -15); ctx.lineTo(0, 1); ctx.lineTo(0, 31); ctx.lineTo(-27, 16); ctx.closePath(); ctx.fill();
    ctx.restore(); text(ctx, 'REACTOR', 0, 43, '#adca8b', 8);
  }
}
