import { mkdir, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import assert from 'node:assert/strict';
import { ensureChrome, connectNative, NativeCdpConnection, browserURL } from './cdp.mjs';

const base = `http://localhost:${process.env.PORT || 3000}`;
await ensureChrome(`${base}/?qa=desktop`);
await mkdir(new URL('../artifacts/', import.meta.url), { recursive: true });
const openTargets = await (await fetch(`${browserURL}/json/list`, { signal: AbortSignal.timeout(3000) })).json();
if (openTargets.some(t => t.url === 'chrome://profile-picker/') && !openTargets.some(t => t.type === 'page')) {
  throw new Error('ChromeDebug 停在配置文件选择页；请选中已有测试配置文件，再运行浏览器验收。');
}
const version = await (await fetch(`${browserURL}/json/version`, { signal: AbortSignal.timeout(3000) })).json();
const browserSocket = new WebSocket(version.webSocketDebuggerUrl);
const browser = new NativeCdpConnection(browserSocket);
await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('Chrome 调试连接超时')), 5000);
  browserSocket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
  browserSocket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('Chrome 调试连接失败')); }, { once: true });
});
const { browserContextId } = await browser.send('Target.createBrowserContext');
const connections = [], errors = [];
async function page(query) {
  const targetUrl = `${base}/?qa=${query}`;
  const { targetId } = await browser.send('Target.createTarget', { url: targetUrl, browserContextId });
  const c = await connectNative({ browserURL, targetUrl, targetId });
  connections.push(c); c.latest = null; c.targetId = targetId;
  c.socket.addEventListener('message', e => {
    const m = JSON.parse(e.data);
    if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
    if (m.method === 'Network.webSocketFrameReceived') {
      const data = m.params.response.payloadData;
      if (data.startsWith('42[')) { try { const [event, state] = JSON.parse(data.slice(2)); if (event === 'state') c.latest = state; } catch {} }
    }
  });
  await c.send('Runtime.enable'); await c.send('Network.enable'); await c.send('Page.enable');
  await c.send('Page.navigate', { url: targetUrl });
  await waitFor(c, () => document.getElementById('create-button') !== null, 'Game page did not load');
  await focusPage(c, query);
  await delay(500); return c;
}
async function waitFor(c, fn, message, timeout = 8000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await c.evaluate(fn)) return; await delay(100); }
  throw new Error(message);
}
async function focusPage(c, label) {
  const { windowId, bounds } = await browser.send('Browser.getWindowForTarget', { targetId: c.targetId });
  if (bounds.windowState === 'minimized') await browser.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } });
  await c.send('Page.bringToFront');
  await c.send('Emulation.setFocusEmulationEnabled', { enabled: true });
  await waitFor(c, () => document.visibilityState === 'visible', `${label} 测试页不可见；请恢复 Chrome 测试窗口。`, 3000);
}
async function click(c, id) {
  const r = await c.evaluate(id => { const e = document.getElementById(id) || document.querySelector(id); e.scrollIntoView({ block: 'center' }); const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; }, id);
  await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...r, button: 'left', clickCount: 1 });
  await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...r, button: 'left', clickCount: 1 });
}
async function leave(c) {
  await focusPage(c, '离开房间');
  await click(c, 'leave-button');
  await waitFor(c, () => document.getElementById('confirm-dialog').open, '离开确认未出现');
  await click(c, 'confirm-accept');
  await waitFor(c, () => !document.getElementById('entry-panel').hidden, '未返回登舰界面');
}
async function fill(c, id, value) {
  await c.evaluate(id => { const e = document.getElementById(id); e.focus(); e.select(); }, id);
  await c.send('Input.insertText', { text: value });
}
async function screenshot(c, filename, full = false) {
  await c.evaluate(() => scrollTo(0, 0)); await delay(200);
  const metrics = full ? await c.send('Page.getLayoutMetrics') : null;
  const { data } = await c.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: full,
    ...(full ? { clip: { x: 0, y: 0, width: metrics.cssContentSize.width, height: metrics.cssContentSize.height, scale: 1 } } : {}) });
  await writeFile(new URL(`../artifacts/${filename}`, import.meta.url), Buffer.from(data, 'base64'));
}
try {
  const a = await page('desktop');
  if (process.env.QA_VERIFY_MINIMIZED === '1') {
    const { windowId } = await browser.send('Browser.getWindowForTarget', { targetId: a.targetId });
    await browser.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'minimized' } });
    await focusPage(a, '最小化窗口恢复');
  }
  await a.send('Emulation.setDeviceMetricsOverride', { width: 1512, height: 1100, deviceScaleFactor: 1, mobile: false });
  await waitFor(a, () => !document.getElementById('create-button').disabled, 'Server never became available');
  await screenshot(a, 'desktop-home.png', true);
  await click(a, 'help-button'); assert.equal(await a.evaluate(() => document.getElementById('help-dialog').open), true); await click(a, 'got-it');
  await fill(a, 'player-name', '星际邮差'); await click(a, 'create-button');
  await waitFor(a, () => !document.getElementById('room-panel').hidden, 'Create failed');
  const code = await a.evaluate(() => document.getElementById('room-code').textContent);
  const b = await page('mobile');
  await b.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await b.send('Emulation.setTouchEmulationEnabled', { enabled: true });
  await waitFor(b, () => !document.getElementById('create-button').disabled, 'Mobile server never ready');
  await screenshot(b, 'mobile-home.png', true);
  assert.equal(await b.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'Mobile horizontal overflow');
  await b.send('Emulation.setDeviceMetricsOverride', { width: 844, height: 390, deviceScaleFactor: 1, mobile: true, screenOrientation: { type: 'landscapePrimary', angle: 90 } });
  const landscapeHome = await b.evaluate(() => ({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth,
    leftPadding: parseFloat(getComputedStyle(document.querySelector('.app-shell')).paddingLeft),
    create: (() => { const r = document.getElementById('create-button').getBoundingClientRect(); return { left: r.left, right: r.right }; })() }));
  assert.ok(landscapeHome.scrollWidth <= landscapeHome.width && landscapeHome.leftPadding >= 25 && landscapeHome.create.left >= 0 && landscapeHome.create.right <= landscapeHome.width, 'Landscape boarding overflow or missing safe area');
  await screenshot(b, 'mobile-landscape-home.png');
  await b.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true, screenOrientation: { type: 'portraitPrimary', angle: 0 } });
  await fill(b, 'player-name', '月球便利店'); await fill(b, 'room-input', code);
  await b.evaluate(() => document.getElementById('join-form').requestSubmit());
  await waitFor(b, () => !document.getElementById('room-panel').hidden, 'Mobile join failed');
  await waitFor(a, () => !!document.querySelector('[data-kick]'), 'Host did not receive kick control');
  await click(a, '[data-kick]');
  await waitFor(a, () => document.getElementById('confirm-dialog').open, 'Kick confirmation missing');
  await click(a, 'confirm-accept');
  await waitFor(b, () => document.getElementById('entry-panel').hidden === false, 'Kicked player did not return to boarding');
  await screenshot(b, 'mobile-kicked.png');
  await click(b, 'create-button');
  await waitFor(b, () => !document.getElementById('room-panel').hidden, 'Kicked player could not create a new room');
  const freshCode = await b.evaluate(() => document.getElementById('room-code').textContent);
  assert.notEqual(freshCode, code);
  await screenshot(b, 'mobile-new-room.png');
  await click(b, 'leave-button');
  await waitFor(b, () => document.getElementById('confirm-dialog').open, 'Leave confirmation missing');
  await click(b, 'confirm-accept');
  await waitFor(b, () => !document.getElementById('create-button').disabled, 'Could not return to boarding after leaving new room');
  await delay(400);
  await fill(b, 'room-input', code);
  await b.evaluate(() => document.getElementById('join-form').requestSubmit());
  await waitFor(b, () => !document.getElementById('room-panel').hidden, 'Could not rejoin original room');
  await click(a, 'ready-button'); await click(b, 'ready-button');
  await waitFor(a, () => !document.getElementById('start-button').disabled, 'Start never enabled');
  assert.match(await a.evaluate(() => document.getElementById('ready-hint').textContent), /队友可接管/, '已准备房主缺少接管倒计时');
  await click(a, 'start-button'); await delay(3600);
  assert.equal(a.latest?.phase, 'playing'); assert.equal(b.latest?.players.length, 2);
  const id = await a.evaluate(() => JSON.parse(sessionStorage.getItem('orbit-seat')).id);
  const before = a.latest.players.find(p => p.id === id);
  await focusPage(a, '键盘移动'); await a.evaluate(() => document.activeElement.blur());
  await a.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'd', code: 'KeyD', windowsVirtualKeyCode: 68 });
  await delay(550); await a.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'd', code: 'KeyD', windowsVirtualKeyCode: 68 }); await delay(150);
  const after = b.latest.players.find(p => p.id === id);
  const keyboardVisibility = await a.evaluate(() => ({ visibility: document.visibilityState, focused: document.hasFocus() }));
  assert.ok(after.x - before.x > 40, `键盘移动未同步：位移 ${after.x - before.x}，页面 ${keyboardVisibility.visibility}，焦点 ${keyboardVisibility.focused}`);
  await screenshot(a, 'desktop-playing.png', true);
  await b.send('Page.bringToFront'); await b.evaluate(() => document.getElementById('arena-panel')?.scrollIntoView());
  await screenshot(b, 'mobile-playing.png', true);
  await a.send('Page.reload'); await delay(1700);
  await waitFor(a, () => !document.getElementById('room-panel').hidden && document.getElementById('reconnect-overlay').hidden, 'Refresh did not recover', 20000);
  assert.equal(await a.evaluate(() => JSON.parse(sessionStorage.getItem('orbit-seat')).id), id);
  assert.equal(a.latest.players.length, 2);
  // Touch movement, with the second browser observing authoritative positions.
  await focusPage(b, '触屏移动');
  const mobileId = await b.evaluate(() => JSON.parse(sessionStorage.getItem('orbit-seat')).id);
  const beforeTouch = b.latest.players.find(p => p.id === mobileId);
  const jr = await b.evaluate(() => { const e = document.getElementById('joystick'); e.scrollIntoView({ block: 'center' }); const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
  await b.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: jr.x, y: jr.y }] });
  await b.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: jr.x + 29, y: jr.y }] });
  await delay(550); await b.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }); await delay(160);
  const afterTouch = a.latest.players.find(p => p.id === mobileId);
  assert.ok(afterTouch.x - beforeTouch.x > 35, 'Touch movement not synchronized');
  await click(b, 'emote-menu-button');
  await waitFor(b, () => !document.getElementById('emote-menu').hidden, 'Mobile emote menu did not open');
  assert.equal(await b.evaluate(() => document.getElementById('emote-menu-button').getBoundingClientRect().height >= 44), true);
  await click(b, '#emote-menu [data-emote="这里！"]');
  for (let i = 0; i < 20 && a.latest?.players.find(p => p.id === mobileId)?.emote !== '这里！'; i++) await delay(100);
  assert.equal(a.latest.players.find(p => p.id === mobileId).emote, '这里！');
  await b.send('Emulation.setDeviceMetricsOverride', { width: 844, height: 390, deviceScaleFactor: 1, mobile: true, screenOrientation: { type: 'landscapePrimary', angle: 90 } });
  await waitFor(b, () => document.body.classList.contains('flight-focus'), 'Landscape focus mode did not activate');
  const landscape = await b.evaluate(() => {
    const rect = id => { const r = document.getElementById(id).getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom }; };
    return { width: innerWidth, height: innerHeight, stage: rect('arena-stage'), joystick: rect('joystick'), interact: rect('touch-interact'), emote: rect('emote-menu-button'), scrollWidth: document.documentElement.scrollWidth };
  });
  assert.ok(landscape.stage.y < landscape.height && landscape.stage.height >= 200, 'Landscape battlefield too small or below viewport');
  for (const key of ['joystick', 'interact', 'emote']) assert.ok(landscape[key].y >= 0 && landscape[key].bottom <= landscape.height && landscape[key].x >= 0 && landscape[key].right <= landscape.width, `${key} is outside landscape viewport`);
  assert.ok(landscape.scrollWidth <= landscape.width, 'Landscape horizontal overflow');
  await screenshot(b, 'mobile-landscape-playing.png');
  await b.send('Emulation.setDeviceMetricsOverride', { width: 1024, height: 768, deviceScaleFactor: 1, mobile: true, screenOrientation: { type: 'landscapePrimary', angle: 90 } });
  const tablet = await b.evaluate(() => {
    const rect = id => { const r = document.getElementById(id).getBoundingClientRect(); return { x: r.x, y: r.y, right: r.right, bottom: r.bottom, height: r.height }; };
    return { width: innerWidth, height: innerHeight, stage: rect('arena-stage'), joystick: rect('joystick'), interact: rect('touch-interact'), scrollWidth: document.documentElement.scrollWidth };
  });
  assert.ok(tablet.stage.height >= 500 && tablet.stage.bottom <= tablet.height, 'Tablet landscape battlefield is not visible');
  for (const key of ['joystick', 'interact']) assert.ok(tablet[key].x >= 0 && tablet[key].right <= tablet.width && tablet[key].y >= 0 && tablet[key].bottom <= tablet.height, `${key} is outside tablet landscape viewport`);
  assert.ok(tablet.scrollWidth <= tablet.width, 'Tablet landscape horizontal overflow');
  await screenshot(b, 'tablet-landscape-playing.png');
  await b.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true, screenOrientation: { type: 'portraitPrimary', angle: 0 } });
  await a.send('Emulation.setDeviceMetricsOverride', { width: 1366, height: 768, deviceScaleFactor: 1, mobile: false });
  await a.send('Page.bringToFront');
  const desktopFeedback = await a.evaluate(() => ({ tickerVisible: (() => { const r = document.getElementById('event-ticker').getBoundingClientRect(); return r.height > 0 && r.top < innerHeight; })(),
    comboFontSize: parseFloat(getComputedStyle(document.getElementById('combo-label')).fontSize) }));
  assert.ok(desktopFeedback.tickerVisible && desktopFeedback.comboFontSize >= 10, 'Desktop collaboration feedback is not visible');
  await screenshot(a, 'desktop-laptop-playing.png');
  await screenshot(a, 'desktop-final.png');
  await leave(a); await leave(b);

  // Exercise the full idle-host UI path with three real clients and the real timeout.
  await focusPage(a, '房主接管'); await click(a, 'create-button');
  await waitFor(a, () => !document.getElementById('room-panel').hidden, '接管测试房间创建失败');
  const idleRoom = await a.evaluate(() => document.getElementById('room-code').textContent);
  const originalHostId = await a.evaluate(() => JSON.parse(sessionStorage.getItem('orbit-seat')).id);
  await focusPage(b, '房主接管'); await fill(b, 'room-input', idleRoom);
  await b.evaluate(() => document.getElementById('join-form').requestSubmit());
  await waitFor(b, () => !document.getElementById('room-panel').hidden, '接管测试第二人加入失败');
  const c = await page('third');
  await fill(c, 'player-name', '轨道修理员'); await fill(c, 'room-input', idleRoom);
  await c.evaluate(() => document.getElementById('join-form').requestSubmit());
  await waitFor(c, () => !document.getElementById('room-panel').hidden, '接管测试第三人加入失败');
  await click(b, 'ready-button'); await click(c, 'ready-button');
  await waitFor(b, () => !document.getElementById('claim-button').hidden, '接管按钮未出现');
  await delay(28_000);
  await waitFor(b, () => !document.getElementById('claim-button').disabled, '房主空闲后接管按钮仍不可用', 10_000);
  await focusPage(b, '接管房主'); await click(b, 'claim-button');
  await waitFor(b, () => !document.getElementById('start-button').hidden, '接管后没有房主按钮');
  await waitFor(b, () => document.getElementById('toast').textContent.includes('已接管'), '接管提示未出现');
  const claimed = await b.evaluate(() => ({ startDisabled: document.getElementById('start-button').disabled,
    hint: document.getElementById('ready-hint').textContent, toast: document.getElementById('toast').textContent }));
  assert.equal(claimed.startDisabled, true);
  assert.match(claimed.hint, /未准备.*移除/);
  assert.match(claimed.toast, /未准备.*移除/);
  await click(b, `[data-kick="${originalHostId}"]`);
  await click(b, 'confirm-accept');
  await waitFor(b, () => !document.getElementById('start-button').disabled, '移除未准备席位后仍无法开局');
  await click(b, 'start-button');
  await waitFor(b, () => !document.getElementById('countdown-overlay').hidden, '接管后未进入倒计时');
  await leave(b); await leave(c);
  assert.equal(errors.length, 0, errors.join('\n'));
  console.log(JSON.stringify({ room: code, minimizedRestored: process.env.QA_VERIFY_MINIMIZED === '1', kickedCanCreateNewRoom: true, desktopKeyboardDelta: after.x - before.x, touchDelta: afterTouch.x - beforeTouch.x, refreshRecoveredIdentity: true, mobileEmote: true, landscape, landscapeHome, tablet, desktopFeedback, hostTakeoverUI: claimed, runtimeErrors: errors, mobileOverflow: false }));
  // Leave the real app open in a clean state for the user; never close Chrome tabs.
  await a.send('Page.bringToFront');
} finally {
  for (const c of connections) await c.disconnect();
  await browser.disconnect();
}
