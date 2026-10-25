import { WorldRenderer } from './renderer.js';
import { CONFIG, DOCKS, CREW_SYMBOLS } from './shared.js';

const $ = id => document.getElementById(id);
const escapeHTML = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const storage = {
  read(key, session = false) { try { return (session ? sessionStorage : localStorage).getItem(key); } catch { return null; } },
  write(key, value, session = false) { try { (session ? sessionStorage : localStorage).setItem(key, value); } catch {} },
  remove(key) { try { sessionStorage.removeItem(key); } catch {} },
};
let credentials = null;
try { credentials = JSON.parse(storage.read('orbit-seat', true)); } catch {}
if (!credentials?.token || !credentials?.code) credentials = null;
let state = null, selfId = credentials?.id, joined = false, busy = false, recovering = false, resumeGeneration = 0;
let seq = 0, actionSeq = 0, eventId = 0, rtt = null, lastStateAt = 0, toastTimer, roomRenderKey = '', crewRenderKey = '';
let lanURLs = [], inviteBase = location.origin;
const socket = io({ autoConnect: false, reconnectionDelay: 700, reconnectionDelayMax: 3000, timeout: 6000 });
const renderer = new WorldRenderer($('world'));
for (const el of document.querySelectorAll('[data-config]')) el.textContent = CONFIG[el.dataset.config] / Number(el.dataset.divide || 1);
const keys = new Set(); const stick = { x: 0, y: 0, pointer: null };

function toast(message, error = false) {
  clearTimeout(toastTimer); $('toast').textContent = message; $('toast').classList.toggle('error', error);
  $('toast').hidden = false; toastTimer = setTimeout(() => { $('toast').hidden = true; }, error ? 6500 : 3300);
}
let pendingConfirm = null;
function confirmChange(title, copy, action) {
  const dialog = $('confirm-dialog');
  if (dialog.open) return Promise.resolve(false);
  resetInput();
  $('confirm-title').textContent = title; $('confirm-copy').textContent = copy; $('confirm-accept').textContent = action;
  dialog.showModal();
  return new Promise(resolve => { pendingConfirm = resolve; });
}
$('confirm-cancel').addEventListener('click', () => $('confirm-dialog').close());
$('confirm-accept').addEventListener('click', () => { pendingConfirm?.(true); pendingConfirm = null; $('confirm-dialog').close(); });
$('confirm-dialog').addEventListener('close', () => { pendingConfirm?.(false); pendingConfirm = null; });
function request(event, data = {}) {
  if (!socket.connected) return Promise.reject(new Error('连接尚未恢复，请稍候。'));
  return new Promise((resolve, reject) => socket.timeout(5000).emit(event, data, (err, response) => {
    if (err) return reject(new Error(event === 'action' ? '操作回应超时，请先看画面确认结果。' : '服务器没有及时回应，请检查连接后重试。'));
    if (!response?.ok) return reject(new Error(response?.error || '操作没有完成。'));
    resolve(response);
  }));
}
function resetInput() {
  keys.clear(); stick.x = stick.y = 0; stick.pointer = null; $('joystick-thumb').style.transform = '';
  if (joined && socket.connected) socket.volatile.emit('input', { x: 0, y: 0, seq: ++seq });
}
function canPlay() { return joined && socket.connected && !recovering && state?.phase === 'playing' && performance.now() - lastStateAt < 2500; }
function showConnection() {
  const online = socket.connected && !recovering;
  $('connection-status').textContent = online ? `${joined ? '已同步' : '服务器在线'}${rtt === null ? '' : ` · ${rtt} ms`}` : '信号中断 · 重连中';
  $('connection-status').classList.toggle('offline', !online);
  $('create-button').disabled = busy || !online;
  $('join-form').querySelector('button').disabled = busy || !online;
}
function acceptState(next, snap = false) {
  if (state?.code === next.code && next.revision < state.revision) return;
  if (state?.code !== next.code) { eventId = next.events.at(-1)?.id || 0; crewRenderKey = ''; }
  if (snap) eventId = next.events.at(-1)?.id || 0;
  state = next; lastStateAt = performance.now();
  renderer.setState(state, selfId, snap);
  for (const e of state.events) {
    if (e.id <= eventId) continue;
    if (e.type === 'delivery') playTone(e.relay ? 880 : 660, .13);
    if (e.type === 'hit') playTone(130, .12, 'triangle');
    if (e.type === 'finish') playTone(state.result === 'won' ? 1046 : 220, .3);
    eventId = e.id;
  }
  renderUI();
}
function storeSeat(result) {
  credentials = { token: result.token, code: result.code, id: result.id };
  storage.write('orbit-seat', JSON.stringify(credentials), true); selfId = result.id; joined = true; recovering = false;
  seq = actionSeq = 0; $('reconnect-overlay').hidden = true;
  acceptState(result.state, true); showConnection();
}
async function joinRoom(create) {
  if (busy || joined) return;
  busy = true; showConnection();
  const name = $('player-name').value.trim() || `领航员${Math.floor(10 + Math.random() * 90)}`;
  storage.write('orbit-name', name); $('player-name').value = name;
  try {
    const result = await request('join', { create, code: $('room-input').value.toUpperCase().trim(), name });
    storeSeat(result); history.replaceState(null, '', `/?room=${result.code}`);
    toast(create ? '房间已建立，邀请伙伴一起出发。' : '已接入星环，欢迎登舰。');
  } catch (e) { toast(e.message, true); }
  finally { busy = false; showConnection(); }
}
async function resume() {
  if (!credentials || !socket.connected) return;
  const generation = ++resumeGeneration; recovering = true; $('reconnect-overlay').hidden = false;
  $('reconnect-copy').textContent = '正在恢复原来的席位与房间状态…'; showConnection();
  for (let attempt = 0; attempt < 12; attempt++) {
    if (generation !== resumeGeneration || !socket.connected || !credentials) return;
    try {
      const result = await request('join', { code: credentials.code, token: credentials.token });
      if (generation !== resumeGeneration) return;
      storeSeat(result); toast('信号恢复，欢迎回到你的小队。'); return;
    } catch (e) {
      if (generation !== resumeGeneration) return;
      if (e.message.includes('另一连接') && attempt < 11) { await new Promise(resolve => setTimeout(resolve, 1200)); continue; }
      $('reconnect-copy').textContent = e.message;
      toast(e.message, true); showConnection(); return;
    }
  }
}
function clearRoom() {
  if ($('confirm-dialog').open) $('confirm-dialog').close();
  ++resumeGeneration; credentials = null; state = null; selfId = null; joined = false; recovering = false; eventId = 0;
  storage.remove('orbit-seat'); renderer.setState(null, null, true); resetInput(); crewRenderKey = ''; roomRenderKey = '';
  $('reconnect-overlay').hidden = true; history.replaceState(null, '', '/'); renderUI(); showConnection();
}
async function leaveRoom() {
  if (busy) return;
  busy = true;
  try { if (joined && socket.connected) await request('leave'); }
  catch { /* A disconnected seat is released by its reservation timeout. */ }
  finally { socket.disconnect(); clearRoom(); busy = false; socket.connect(); }
}
async function confirmLeave() {
  const online = joined && socket.connected;
  const copy = online
    ? '离开会释放你的席位和携带的能量核；重新加入将是一个新席位。'
    : `返回会放弃自动恢复；旧席位仍在服务器保留，最多 ${CONFIG.reservationMs / 1000} 秒后过期。`;
  if (await confirmChange(online ? '离开这个房间？' : '返回登舰界面？', copy, online ? '确认离开' : '确认返回')) await leaveRoom();
}

function renderCrew() {
  const players = state?.players || [];
  const key = `${state?.phase || 'home'}:` + JSON.stringify(players.map(p => [p.id, p.name, p.color, p.ready, p.connected, p.delivered, p.carry, Math.ceil(p.reservedFor / 1000), p.id === state?.hostId, p.id === selfId]));
  if (key === crewRenderKey) return; crewRenderKey = key;
  $('crew-count').textContent = `${players.filter(p => p.connected).length} / ${CONFIG.maxPlayers}`;
  const slots = [];
  for (let slot = 0; slot < CONFIG.maxPlayers; slot++) {
    const p = players.find(p => p.slot === slot);
    if (!p) { slots.push('<div class="crew-slot empty"><div class="crew-avatar">＋</div><div class="crew-info"><strong>等待一位伙伴</strong><small>OPEN SEAT</small></div></div>'); continue; }
    const note = !p.connected ? `重连保留 ${Math.ceil(p.reservedFor / 1000)} 秒` : state.phase === 'playing' ? `已送达 ${p.delivered} 个${p.carry ? ' · 携核中' : ''}` : p.ready ? '准备就绪' : '正在准备';
    const canKick = selfId === state.hostId && p.id !== selfId && ['lobby', 'finished'].includes(state.phase);
    slots.push(`<div class="crew-slot"><div class="crew-avatar" style="color:${p.color}">${CREW_SYMBOLS[p.slot]}</div><div class="crew-info"><strong>${escapeHTML(p.name)}${p.id === selfId ? ' <span class="lime">· 你</span>' : ''}</strong><small>${note}</small></div><span class="crew-indicator" style="color:${p.color}" title="${p.id === state.hostId ? '房主' : ''}">${!p.connected ? '⌁' : p.id === state.hostId ? '♔' : p.ready ? '✓' : '●'}</span>${canKick ? `<button class="kick-seat" data-kick="${p.id}" aria-label="移除 ${escapeHTML(p.name)} 的席位" title="移除席位">移除</button>` : ''}</div>`);
  }
  $('crew-list').innerHTML = slots.join('');
}
function renderUI() {
  const inRoom = !!state && !!selfId;
  const me = state?.players.find(p => p.id === selfId);
  const playing = state?.phase === 'playing', countdown = state?.phase === 'countdown', finished = state?.phase === 'finished';
  const touchMode = matchMedia('(pointer: coarse)').matches || innerWidth <= 700;
  document.body.classList.toggle('flight-focus', inRoom && (playing || countdown));
  $('entry-panel').hidden = inRoom; $('room-panel').hidden = !inRoom;
  $('lobby-actions').hidden = playing || countdown; $('personal-status').hidden = !playing;
  $('room-panel').classList.toggle('active-room', playing || countdown);
  $('room-code').textContent = state?.code || '';
  $('countdown-overlay').hidden = !countdown; $('countdown-number').textContent = Math.max(1, Math.ceil(state?.countdown || 0));
  $('result-overlay').hidden = !finished;
  $('countdown-overlay').setAttribute('aria-live', countdown ? 'assertive' : 'off');
  $('result-overlay').setAttribute('aria-live', finished ? 'polite' : 'off');
  const phaseKey = `${state?.phase || 'home'}:${state?.code || ''}`;
  if (roomRenderKey !== phaseKey) {
    roomRenderKey = phaseKey;
    if (playing) { $('headline').innerHTML = '让默契，<span>点亮这一程。</span>'; $('subtitle').textContent = '每一份微光，都值得被送达。留意干扰波，接应你的伙伴。'; if (touchMode && !matchMedia('(max-height: 820px) and (orientation: landscape) and (pointer: coarse)').matches) document.querySelector('.arena-panel').scrollIntoView({ block: 'start', behavior: 'smooth' }); }
    else { $('headline').innerHTML = '把微光，<span>送回星环。</span>'; $('subtitle').textContent = inRoom ? '小队正在集结。准备好了，就一起出发。' : '宇宙很大。好在，这一次不是独自出发。'; if (finished && touchMode) document.querySelector('.arena-panel').scrollIntoView({ block: 'start', behavior: 'smooth' }); }
    updateNetwork();
  }
  $('delivered-value').textContent = String(state?.delivered || 0).padStart(2, '0');
  $('hud-goal').textContent = state?.goal ?? CONFIG.target;
  const stability = Math.ceil(state?.stability ?? 100);
  $('stability-value').innerHTML = `${stability}<span>%</span>`;
  $('stability-bar').style.width = `${stability}%`; $('stability-bar').style.background = stability < 25 ? '#ff9877' : '#b9ef83';
  const remaining = Math.ceil(state?.remaining ?? CONFIG.duration);
  $('timer-value').textContent = `${String(Math.floor(remaining / 60)).padStart(2, '0')}:${String(remaining % 60).padStart(2, '0')}`;
  $('timer-value').style.color = remaining < 30 ? '#ffb878' : '';
  const connected = state?.players.filter(p => p.connected) || [];
  const readyCount = connected.filter(p => p.ready).length;
  const unreadyCount = connected.length - readyCount;
  const allReady = connected.length >= CONFIG.minPlayers && unreadyCount === 0;
  const canClaim = !!me?.ready && state?.hostId !== selfId && readyCount >= CONFIG.minPlayers && connected.every(p => p.id === state.hostId || p.ready);
  const canRemoveAndStart = state?.hostId === selfId && !!me?.ready && readyCount >= CONFIG.minPlayers && unreadyCount > 0;
  $('ready-button').textContent = me?.ready ? '✓ 已准备 · 点击取消' : '我准备好了';
  $('ready-button').disabled = !joined || recovering;
  $('start-button').hidden = state?.hostId !== selfId;
  $('start-button').disabled = !allReady || !joined || recovering;
  $('claim-button').hidden = !canClaim;
  $('claim-button').disabled = !joined || recovering || state.hostIdleIn > 0;
  $('claim-button').textContent = state?.hostIdleIn > 0 ? `房主未响应？${Math.ceil(state.hostIdleIn)} 秒后可接管` : '房主未响应 · 接管开局 ↗';
  $('ready-hint').textContent = connected.length < CONFIG.minPlayers ? `还差一位伙伴 · 至少 ${CONFIG.minPlayers} 人才能出发`
    : canRemoveAndStart ? `还有 ${unreadyCount} 名队员未准备；可等候，或移除其席位后启动`
      : canClaim && state.hostIdleIn <= 0 ? unreadyCount ? '接管后可等候未准备的房主，或移除其席位' : '接管后即可启动任务'
        : canClaim ? '等待房主启动，超时后可由队友接管'
          : me?.ready && state?.hostId !== selfId && state?.hostIdleIn <= 0 && readyCount < CONFIG.minPlayers ? '房主未响应 · 请再邀请一位准备好的伙伴'
            : state?.hostId === selfId && !me?.ready && readyCount >= CONFIG.minPlayers ? state.hostIdleIn > 0 ? `队友已准备；${Math.ceil(state.hostIdleIn)} 秒后可接管，请准备或回应` : '队友现在可接管；请准备或回应'
              : allReady ? state.hostId === selfId ? state.hostIdleIn > 0 ? `全员准备完毕，点击启动；${Math.ceil(state.hostIdleIn)} 秒后队友可接管` : '全员准备完毕，请启动任务；队友现在可接管' : '全员准备完毕，等待房主启动'
                : `等待 ${unreadyCount} 名领航员准备`;
  const cargo = state?.cores.find(c => c.id === me?.carry), dock = cargo ? DOCKS[cargo.type] : null;
  const interactPrompt = touchMode ? '点右侧按钮' : '按 E';
  const atDock = !!(dock && me && Math.hypot(me.x - dock.x, me.y - dock.y) < CONFIG.deliveryRadius);
  const wrongDock = !!(cargo && me && DOCKS.some((d, i) => i !== cargo.type && Math.hypot(me.x - d.x, me.y - d.y) < CONFIG.deliveryRadius));
  const actionLabel = cargo ? atDock ? '投递' : '抛出' : '拾取';
  $('cargo-label').textContent = dock ? `${dock.symbol} ${dock.name}能量核${cargo.relay ? ' · 接力加成' : ''}` : '双手空空，去寻找微光';
  $('cargo-label').style.color = dock?.color || '';
  $('cargo-hint').textContent = atDock ? `已到达对应泊位 · ${interactPrompt}完成投递` : wrongDock ? `泊位不匹配 · ${interactPrompt}会抛出能量核` : cargo ? `送往 ${dock.name}泊位，或${interactPrompt}抛给伙伴` : `靠近能量核，${interactPrompt}拾取`;
  $('touch-action-label').textContent = actionLabel;
  $('touch-interact').disabled = !canPlay(); $('touch-dash').disabled = !canPlay() || (me?.dash || 0) > 0;
  $('touch-dash-label').textContent = me?.dash > 0 ? `${me.dash.toFixed(1)}s` : '冲刺';
  const wavePhase = (state?.elapsed || 0) % CONFIG.pulsePeriod;
  const warning = playing && wavePhase >= CONFIG.pulseWarningAt;
  $('arena-banner').classList.toggle('warning', warning);
  $('arena-banner').hidden = finished || countdown;
  const totalBatches = Math.ceil((state?.goal ?? CONFIG.target) / CONFIG.supplyBatchSize);
  $('banner-text').textContent = warning ? wavePhase < CONFIG.pulseStartAt ? '干扰波蓄能中 · 准备冲刺' : '干扰波来袭 · 冲刺穿过波环'
    : playing ? state.supplyBlocked ? '内环积压 · 清场后下一批微光抵达'
      : state.supplyIn !== null ? `微光 ${state.supplyBatch}/${totalBatches} 批 · 下一批 ${Math.ceil(state.supplyIn)} 秒后抵达`
        : '全部微光已抵达 · 把它们送回泊位'
      : inRoom ? connected.length < CONFIG.minPlayers ? '房间已建立 · 邀请伙伴加入' : '小队集结中 · 全员准备后出发'
        : '航道已就绪 · 等待领航员接入';
  $('context-hint').innerHTML = `<span>✧</span> ${playing ? me?.stun > 0 ? '受到干扰，稍等片刻恢复…' : cargo ? atDock ? `${interactPrompt}投递 · 就差最后一步！` : wrongDock ? `泊位不匹配 · ${interactPrompt}会抛出` : `沿虚线前往${dock.name}泊位 · ${touchMode ? '按钮' : 'E'}抛出` : touchMode ? '左侧摇杆移动 · 靠近微光后点「拾取」' : 'WASD 移动 · 靠近微光后按 E 拾取' : '微光在等你，伙伴也是。'}`;
  $('combo-label').textContent = `CHAIN ×${state?.combo || 0} · RELAY ${state?.relays || 0}`;
  $('crew-note').hidden = inRoom;
  renderCrew();
  const log = (state?.events || []).slice(-4).reverse();
  $('event-ticker').textContent = log[0]?.text || '等待小队信号…';
  $('activity-log').innerHTML = log.length ? log.map(e => `<p class="${e.type === 'delivery' ? 'delivery' : ''}">${escapeHTML(e.text)}</p>`).join('') : '<p>等待第一位领航员…</p>';
  if (finished) {
    const won = state.result === 'won';
    $('result-mark').textContent = won ? '✳' : '☾';
    $('result-title').textContent = won ? '星环，重新闪耀。' : '微光未尽，再试一次。';
    $('result-description').textContent = won ? '你们把散落的微光，连成了一片星空。' : state.stability <= 0 ? '反应堆的能量耗尽了。多接力、多投递，让下一局更从容。' : '时间到了。下一次，试着分工接应、连续投递。';
    $('result-stats').innerHTML = `<div><strong>${state.delivered}/${state.goal}</strong><span>能量送达</span></div><div><strong>${state.relays}</strong><span>默契接力</span></div><div><strong>${Math.ceil(state.elapsed)}s</strong><span>航行时间</span></div>`;
    $('again-button').textContent = allReady && state.hostId === selfId ? '全员就绪 · 再次出发 ↗' : canRemoveAndStart ? '查看未准备队员 ↓' : canClaim && state.hostIdleIn <= 0 ? '房主未响应 · 接管开局 ↗' : me?.ready ? '✓ 已准备，等待伙伴' : '再来一次 · 准备 ↗';
    $('result-action-hint').textContent = canRemoveAndStart ? `还有 ${unreadyCount} 名队员未准备；可等待，或查看队员并移除席位。`
      : allReady && state.hostId === selfId ? state.hostIdleIn > 0 ? `点击开始下一局；${Math.ceil(state.hostIdleIn)} 秒后队友可接管。` : '请开始下一局；队友现在可接管。'
        : canClaim && state.hostIdleIn <= 0 ? '房主未响应，可接管后继续下一局。'
          : me?.ready ? '已准备，等待房主和队友。' : '先准备，再由房主启动下一局。';
    $('again-button').disabled = !joined || recovering || (!!me?.ready && !(allReady && state.hostId === selfId) && !canRemoveAndStart && !(canClaim && state.hostIdleIn <= 0));
  }
}

function updateNetwork() {
  const holder = $('network-urls'); holder.replaceChildren();
  if (!lanURLs.length) { holder.textContent = '未发现局域网地址；可在启动终端查看 LAN 地址。'; return; }
  for (const url of lanURLs) {
    const a = document.createElement('a'); a.textContent = url; a.href = `${url}${state ? `/?room=${state.code}` : ''}`; a.target = '_blank'; a.rel = 'noopener'; holder.append(a);
  }
  if (lanURLs.length > 1) {
    const select = document.createElement('select'); select.setAttribute('aria-label', '邀请链接使用的局域网地址');
    for (const url of lanURLs) { const option = document.createElement('option'); option.value = url; option.textContent = `邀请使用 ${url}`; select.append(option); }
    select.value = inviteBase; select.addEventListener('change', () => { inviteBase = select.value; }); holder.append(select);
  }
}
async function copyInvite() {
  if (!state) return;
  const url = `${inviteBase}/?room=${state.code}`;
  try {
    if (navigator.clipboard && window.isSecureContext) await navigator.clipboard.writeText(url);
    else {
      const el = document.createElement('textarea'); el.value = url; el.style.position = 'fixed'; el.style.opacity = '0'; document.body.append(el); el.select();
      const ok = document.execCommand('copy'); el.remove(); if (!ok) throw new Error('copy failed');
    }
    toast(`邀请链接已复制 · 房间 ${state.code}`);
  } catch { toast(`请复制此地址给伙伴：${url}`, true); }
}

async function toggleReady(force = null) {
  const me = state?.players.find(p => p.id === selfId); if (!me) return;
  try { await request('ready', { ready: force ?? !me.ready }); } catch (e) { toast(e.message, true); }
}
async function start() { try { await request('start'); resetInput(); } catch (e) { toast(e.message, true); } }
async function claimHost() {
  try {
    await request('claim:host');
    const unready = state?.players.filter(p => p.connected && !p.ready).length || 0;
    toast(unready ? `已接管房主。还有 ${unready} 名队员未准备；可等候或移除席位后启动。` : '已接管房主。全员已准备，可以启动任务。');
  } catch (e) { toast(e.message, true); }
}
function perform(kind) {
  if (!canPlay() || $('help-dialog').open || $('confirm-dialog').open) return;
  unlockAudio();
  request('action', { kind, seq: ++actionSeq }).then(result => {
    if (result.applied && kind === 'dash') playTone(260, .08, 'sine');
  }).catch(e => toast(e.message, true));
}
function emote(value) { if (joined && socket.connected && !recovering) request('emote', { text: value }).catch(e => toast(e.message, true)); }

socket.on('connect', () => { rtt = null; showConnection(); if (credentials) resume(); });
socket.on('connect_error', () => {
  showConnection(); if (!credentials) $('connection-status').textContent = '无法连接服务器 · 正在重试';
});
socket.on('disconnect', () => {
  resetInput(); joined = false; ++resumeGeneration;
  if (credentials) { recovering = true; $('reconnect-overlay').hidden = false; $('reconnect-copy').textContent = `席位保留 ${CONFIG.reservationMs / 1000} 秒，连接恢复后继续航行。`; }
  showConnection(); renderUI();
});
socket.on('state', next => { if (joined && !recovering && next.code === credentials?.code) acceptState(next); });
socket.on('kicked', () => { clearRoom(); toast('房主已移除你的席位，可以加入其他房间。', true); });

$('player-name').value = storage.read('orbit-name') || '';
const code = new URLSearchParams(location.search).get('room'); if (code && /^[A-HJ-NP-Z2-9]{5}$/i.test(code)) $('room-input').value = code.toUpperCase();
$('room-input').addEventListener('input', e => { e.target.value = e.target.value.toUpperCase().replace(/[^A-HJ-NP-Z2-9]/g, ''); });
$('create-button').addEventListener('click', () => { unlockAudio(); joinRoom(true); });
$('join-form').addEventListener('submit', e => { e.preventDefault(); unlockAudio(); joinRoom(false); });
$('ready-button').addEventListener('click', () => toggleReady()); $('start-button').addEventListener('click', start);
$('claim-button').addEventListener('click', claimHost);
$('invite-button').addEventListener('click', copyInvite);
$('leave-button').addEventListener('click', confirmLeave);
$('forget-button').addEventListener('click', confirmLeave);
$('crew-list').addEventListener('click', async e => {
  const button = e.target.closest('[data-kick]'); if (!button) return;
  const target = state?.players.find(p => p.id === button.dataset.kick);
  if (!target || !await confirmChange(`移除 ${target.name}？`, '对方会离开当前房间，需要再次输入房间码才能加入。', '移除席位')) return;
  request('kick', { id: button.dataset.kick }).catch(error => toast(error.message, true));
});
$('retry-button').addEventListener('click', () => { socket.disconnect(); socket.connect(); });
$('again-button').addEventListener('click', () => {
  const ready = state.players.filter(p => p.connected);
  if (state.hostId === selfId && ready.length >= CONFIG.minPlayers && ready.every(p => p.ready)) start();
  else if (state.hostId === selfId && ready.find(p => p.id === selfId)?.ready && ready.filter(p => p.ready).length >= CONFIG.minPlayers && ready.some(p => !p.ready)) $('crew-list').scrollIntoView({ block: 'center', behavior: 'smooth' });
  else if (state.hostId !== selfId && state.hostIdleIn <= 0 && ready.filter(p => p.ready).length >= CONFIG.minPlayers && ready.every(p => p.id === state.hostId || p.ready)) claimHost();
  else toggleReady(true);
});
$('help-button').addEventListener('click', () => { resetInput(); $('help-dialog').showModal(); });
for (const id of ['close-help', 'got-it']) $(id).addEventListener('click', () => $('help-dialog').close());
$('help-dialog').addEventListener('click', e => { if (e.target === $('help-dialog')) { const r = e.target.getBoundingClientRect(); if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) e.target.close(); } });
const emoteMenu = $('emote-menu');
function setEmoteMenu(open) { emoteMenu.hidden = !open; $('emote-menu-button').setAttribute('aria-expanded', String(open)); }
$('emote-menu-button').addEventListener('click', () => setEmoteMenu(emoteMenu.hidden));
document.addEventListener('pointerdown', e => { if (!e.target.closest('.touch-emotes')) setEmoteMenu(false); });
document.querySelectorAll('[data-emote]').forEach(button => button.addEventListener('click', () => { emote(button.dataset.emote); setEmoteMenu(false); }));

const movementKeys = ['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'];
addEventListener('keydown', e => {
  if (/INPUT|TEXTAREA|SELECT/.test(e.target.tagName) || $('help-dialog').open || $('confirm-dialog').open) return;
  if (![...movementKeys, 'KeyE', 'Space', 'ShiftLeft', 'ShiftRight', 'Digit1', 'Digit2', 'Digit3'].includes(e.code)) return;
  if (joined) e.preventDefault();
  if (e.repeat) return; keys.add(e.code);
  if (e.code === 'KeyE') perform('interact');
  if (['Space', 'ShiftLeft', 'ShiftRight'].includes(e.code)) perform('dash');
  if (e.code.startsWith('Digit')) emote(['这里！', '漂亮！', '收到'][Number(e.code.slice(-1)) - 1]);
});
addEventListener('keyup', e => keys.delete(e.code)); addEventListener('blur', resetInput);
document.addEventListener('visibilitychange', () => { if (document.hidden) resetInput(); });
setInterval(() => {
  if (!canPlay() || document.hidden || $('help-dialog').open || $('confirm-dialog').open) return;
  let x = stick.x + Number(keys.has('KeyD') || keys.has('ArrowRight')) - Number(keys.has('KeyA') || keys.has('ArrowLeft'));
  let y = stick.y + Number(keys.has('KeyS') || keys.has('ArrowDown')) - Number(keys.has('KeyW') || keys.has('ArrowUp'));
  const len = Math.hypot(x, y); if (len > 1) { x /= len; y /= len; }
  socket.volatile.emit('input', { x, y, seq: ++seq });
}, 40);
setInterval(() => {
  if (!socket.connected) return;
  const started = performance.now(); request('ping:check').then(() => { rtt = Math.round(performance.now() - started); showConnection(); }).catch(() => {});
  if (joined && performance.now() - lastStateAt > 3500) { socket.disconnect(); socket.connect(); }
}, 2000);

const joystick = $('joystick');
function moveStick(e) {
  if (e.pointerId !== stick.pointer) return;
  const r = joystick.getBoundingClientRect(); let x = e.clientX - r.left - r.width / 2, y = e.clientY - r.top - r.height / 2;
  const len = Math.hypot(x, y), radius = 31; if (len > radius) { x *= radius / len; y *= radius / len; }
  stick.x = Math.abs(x) < 3 ? 0 : x / radius; stick.y = Math.abs(y) < 3 ? 0 : y / radius;
  $('joystick-thumb').style.transform = `translate(${x}px, ${y}px)`;
}
joystick.addEventListener('pointerdown', e => { if (stick.pointer !== null) return; e.preventDefault(); stick.pointer = e.pointerId; joystick.setPointerCapture(e.pointerId); moveStick(e); unlockAudio(); });
joystick.addEventListener('pointermove', moveStick);
for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) joystick.addEventListener(type, e => { if (e.pointerId === stick.pointer) resetInput(); });
for (const [id, kind] of [['touch-interact', 'interact'], ['touch-dash', 'dash']]) $(id).addEventListener('pointerdown', e => { e.preventDefault(); perform(kind); });

let audioContext = null, sound = storage.read('orbit-sound') === 'on';
function unlockAudio() {
  if (!sound) return;
  try { audioContext ||= new AudioContext(); if (audioContext.state === 'suspended') audioContext.resume(); } catch { sound = false; }
}
function playTone(frequency, duration, type = 'sine') {
  if (!sound || !audioContext || audioContext.state !== 'running') return;
  const oscillator = audioContext.createOscillator(), gain = audioContext.createGain(), time = audioContext.currentTime;
  oscillator.type = type; oscillator.frequency.setValueAtTime(frequency, time); oscillator.frequency.exponentialRampToValueAtTime(frequency * 1.25, time + duration);
  gain.gain.setValueAtTime(.0001, time); gain.gain.exponentialRampToValueAtTime(.07, time + .01); gain.gain.exponentialRampToValueAtTime(.0001, time + duration);
  oscillator.connect(gain).connect(audioContext.destination); oscillator.start(); oscillator.stop(time + duration);
}
function renderSound() { $('sound-button').setAttribute('aria-label', sound ? '关闭音效' : '开启音效'); $('sound-button').title = sound ? '关闭音效' : '开启音效'; $('sound-button').querySelector('span').hidden = sound; }
$('sound-button').addEventListener('click', () => { sound = !sound; storage.write('orbit-sound', sound ? 'on' : 'off'); renderSound(); unlockAudio(); playTone(660, .12); });

fetch('/api/network').then(r => r.json()).then(data => {
  lanURLs = data.urls.filter(url => /^http:\/\/\d+\.\d+\.\d+\.\d+:\d+$/.test(url));
  if (['localhost', '127.0.0.1', '[::1]'].includes(location.hostname)) inviteBase = lanURLs.find(url => url.startsWith('http://192.168.')) || lanURLs.find(url => url.startsWith('http://10.')) || lanURLs[0] || location.origin;
  updateNetwork();
}).catch(() => { $('network-urls').textContent = '暂时无法读取，请查看服务器终端的 LAN 地址。'; });
renderSound(); renderUI(); showConnection(); socket.connect();
