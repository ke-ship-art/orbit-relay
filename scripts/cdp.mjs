// Small, dependency-free subset of the local chrome-cdp helper used by browser-qa.
// It keeps this repository's optional Chrome test runnable after a standalone clone.
import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

export const browserURL = 'http://127.0.0.1:9222';

async function probe() {
  try {
    const response = await fetch(`${browserURL}/json/version`, { signal: AbortSignal.timeout(1500) });
    const version = await response.json();
    return response.ok && /^wss?:\/\//.test(version.webSocketDebuggerUrl || '') ? version : null;
  } catch { return null; }
}

async function findChrome() {
  const candidates = [process.env.CHROME_PATH,
    process.env.PROGRAMFILES && path.join(process.env.PROGRAMFILES, 'Google/Chrome/Application/chrome.exe'),
    process.env['PROGRAMFILES(X86)'] && path.join(process.env['PROGRAMFILES(X86)'], 'Google/Chrome/Application/chrome.exe'),
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Google/Chrome/Application/chrome.exe'),
    ...(process.env.PATH || '').split(path.delimiter).filter(Boolean).map(dir => path.join(dir, 'chrome.exe'))].filter(Boolean);
  for (const candidate of candidates) { try { await access(candidate); return candidate; } catch {} }
  throw new Error('找不到 Chrome；请用 CHROME_PATH 环境变量指定 chrome.exe。');
}

export async function ensureChrome(url) {
  if (await probe()) { console.log('9222 已就绪，复用现有 Chrome。'); return; }
  console.log('9222 未就绪，启动 Chrome。');
  const chrome = await findChrome();
  const profile = process.env.CHROME_USER_DATA_DIR || path.join(os.homedir(), 'ChromeDebug');
  const child = spawn(chrome, ['--remote-debugging-port=9222', `--user-data-dir=${profile}`, '--new-window', url],
    { detached: true, stdio: 'ignore', windowsHide: false });
  await new Promise((resolve, reject) => { child.once('error', reject); child.once('spawn', resolve); });
  child.unref();
  for (let i = 0; i < 100; i++) { if (await probe()) return; await delay(300); }
  throw new Error('Chrome 启动后 9222 未就绪；请检查测试配置文件是否被其他窗口占用。');
}

export class NativeCdpConnection {
  constructor(socket, timeoutMs = 15_000) {
    this.socket = socket; this.timeoutMs = timeoutMs; this.nextId = 1; this.pending = new Map();
    socket.addEventListener('message', event => {
      let message;
      try { message = JSON.parse(event.data); } catch { return; }
      const command = this.pending.get(message.id);
      if (!command) return;
      this.pending.delete(message.id); clearTimeout(command.timer);
      if (message.error) command.reject(new Error(`${command.method}: ${message.error.message}`));
      else command.resolve(message.result);
    });
    socket.addEventListener('close', () => this.rejectPending(new Error('CDP 连接已断开。')));
    socket.addEventListener('error', () => this.rejectPending(new Error('CDP WebSocket 出错。')));
  }
  rejectPending(error) {
    for (const command of this.pending.values()) { clearTimeout(command.timer); command.reject(error); }
    this.pending.clear();
  }
  send(method, params = {}) {
    if (this.socket.readyState !== WebSocket.OPEN) return Promise.reject(new Error('CDP 未连接。'));
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`${method} 命令超时。`)); }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer, method });
      try { this.socket.send(JSON.stringify({ id, method, params })); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }
  async evaluate(fn, ...args) {
    const expression = `(${fn.toString()})(${args.map(arg => JSON.stringify(arg)).join(',')})`;
    const result = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result.value;
  }
  async disconnect() {
    this.rejectPending(new Error('任务结束，断开 CDP。'));
    if (this.socket.readyState === WebSocket.CLOSED) return;
    await new Promise(resolve => {
      const done = () => { clearTimeout(timer); this.socket.removeEventListener('close', done); resolve(); };
      const timer = setTimeout(done, 2000);
      this.socket.addEventListener('close', done, { once: true }); this.socket.close();
    });
  }
}

export async function connectNative({ targetId, targetUrl }) {
  const targets = await (await fetch(`${browserURL}/json/list`, { signal: AbortSignal.timeout(3000) })).json();
  const target = targets.find(t => t.type === 'page' && t.id === targetId && t.url === targetUrl);
  if (!target?.webSocketDebuggerUrl) throw new Error(`找不到测试标签页：${targetUrl}`);
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  const connection = new NativeCdpConnection(socket);
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('CDP 连接超时。')), 15_000);
      socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
      socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('CDP 连接失败。')); }, { once: true });
      socket.addEventListener('close', () => { clearTimeout(timer); reject(new Error('CDP 连接提前关闭。')); }, { once: true });
    });
    return connection;
  } catch (error) { await connection.disconnect(); throw error; }
}
