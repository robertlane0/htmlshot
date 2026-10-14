'use strict';
// Renderer (Electron main): loads file:// URL hidden, waits delay, captures viewport.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

const LOAD_TIMEOUT = 30_000;
const CAPTURE_TIMEOUT = 10_000;

function parseRendererArgs(argv) {
  const out = {};
  const wantValue = new Set(['--input', '--file-url', '--delay', '--width', '--height', '--run-dir', '--capture', '--result', '--ready-marker', '--user-data-dir']);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const eq = a.indexOf('=');
    if (eq !== -1) {
      const k = a.slice(0, eq), v = a.slice(eq + 1);
      if (k === '--no-sandbox') { out.noSandbox = true; continue; }
      out[k.slice(2)] = v;
    } else {
      if (a === '--no-sandbox') { out.noSandbox = true; continue; }
      const k = a.slice(2);
      if (wantValue.has(a)) {
        out[k] = argv[i + 1];
        i++;
      } else {
        out[k] = argv[i + 1];
        i++;
      }
    }
  }
  // Normalize kebab to camel used below.
  return {
    input: out.input,
    fileUrl: out['file-url'],
    delay: out.delay,
    width: out.width,
    height: out.height,
    runDir: out['run-dir'],
    capture: out.capture,
    result: out.result,
    readyMarker: out['ready-marker'],
    userDataDir: out['user-data-dir'],
    noSandbox: !!out.noSandbox,
  };
}

async function writeResultAtomic(resultPath, obj) {
  const tmp = resultPath + '.tmp';
  await fsp.writeFile(tmp, JSON.stringify(obj));
  await fsp.rename(tmp, resultPath);
}

function withTimeout(promise, ms, message) {
  let t;
  const timeout = new Promise((_, rej) => { t = setTimeout(() => rej(new Error(message)), ms); });
  return Promise.race([promise.then((v) => { clearTimeout(t); return v; }, (e) => { clearTimeout(t); throw e; }), timeout]);
}

async function main() {
  const { app, BrowserWindow } = require('electron');
  const args = parseRendererArgs(process.argv);

  app.disableHardwareAcceleration();
  if (args.noSandbox) app.commandLine.appendSwitch('no-sandbox');
  if (args.userDataDir) {
    try { app.setPath('userData', args.userDataDir); } catch {}
    app.commandLine.appendSwitch('user-data-dir', args.userDataDir);
  } else if (args.runDir) {
    const p = path.join(args.runDir, 'profile');
    try { app.setPath('userData', p); } catch {}
  }

  const delay = Number(String(args.delay));
  const width = Number(String(args.width));
  const height = Number(String(args.height));
  const failAndQuit = async (kind, message) => {
    try {
      if (args.result) await writeResultAtomic(args.result, { status: 'error', kind, message });
    } catch {}
    try { app.exit(1); } catch { process.exit(1); }
  };

  if (!args.fileUrl || !args.capture || !args.result || !args.readyMarker) {
    await app.whenReady().catch(() => {});
    await failAndQuit('internal', 'missing required renderer arguments');
    return;
  }
  if (!Number.isFinite(delay) || delay < 0 || delay > 600 || !Number.isInteger(width) || !Number.isInteger(height)) {
    await app.whenReady().catch(() => {});
    await failAndQuit('internal', 'invalid numeric renderer arguments');
    return;
  }

  await app.whenReady();
  try { await fsp.writeFile(args.readyMarker, ''); } catch {}

  let settled = false;
  const fail = async (kind, message) => {
    if (settled) return;
    settled = true;
    await writeResultAtomic(args.result, { status: 'error', kind, message }).catch(() => {});
    try { app.exit(1); } catch { process.exit(1); }
  };

  const win = new BrowserWindow({
    show: false,
    width,
    height,
    useContentSize: true,
    backgroundColor: '#FFFFFF',
    offscreen: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      offscreen: true,
    },
  });
  try { win.setMenu(null); } catch {}
  const initialUrl = args.fileUrl;

  // Neutralize blocking dialogs before page scripts run by injecting
  // a neutralizer into the main HTML via file-protocol interception.
  // No preload script is used. Watchdog remains the backstop.
  try {
    const { fileURLToPath } = require('url');
    const NEUTRAL = '<script>window.alert=()=>{};window.confirm=()=>true;window.prompt=()=>null;</script>';
    let targetPath = null;
    try { targetPath = fileURLToPath(initialUrl); } catch {}
    win.webContents.session.protocol.interceptBufferProtocol('file', (req, cb) => {
      let fp = null;
      try { fp = fileURLToPath(req.url); } catch { cb({ error: -2 }); return; }
      if (!targetPath || fp !== targetPath) { cb({ path: fp }); return; }
      fs.readFile(fp, (err, data) => {
        if (err) { cb({ error: -2 }); return; }
        const html = data.toString('utf8');
        if (!/<(head|html)[\s>]/i.test(html)) { cb({ path: fp }); return; }
        let injected = html.replace(/<head[^>]*>/i, (m) => m + NEUTRAL);
        if (injected === html) injected = html.replace(/<html[^>]*>/i, (m) => m + NEUTRAL);
        if (injected === html) injected = NEUTRAL + html;
        cb({ mimeType: 'text/html', data: Buffer.from(injected) });
      });
    });
  } catch {}

  try {
    win.webContents.session.setPermissionRequestHandler((wc, perm, cb) => cb(false));
  } catch {}
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e, url) => {
    if (url !== initialUrl) e.preventDefault();
  });
  win.webContents.on('will-redirect', (e, url) => {
    if (!url.startsWith('file://')) e.preventDefault();
  });
  win.webContents.on('render-process-gone', (e, details) => {
    fail('renderer-crash', `renderer crashed: ${details && details.reason ? details.reason : 'unknown'}`);
  });
  win.on('unresponsive', () => fail('renderer-crash', 'renderer unresponsive'));
  win.webContents.on('did-fail-load', (e, code, desc, url, isMainFrame) => {
    if (isMainFrame) fail('load', `failed to load: ${desc} (${code})`);
  });
  // Best-effort dialog neutralization; watchdog is the backstop.
  win.webContents.on('dom-ready', () => {
    win.webContents.executeJavaScript('window.alert=()=>{};window.confirm=()=>true;window.prompt=()=>null;', true).catch(() => {});
  });

  let started = false;
  win.webContents.once('did-finish-load', () => {
    if (started) return;
    started = true;
    clearTimeout(loadTimer);
    const delayMs = Math.round(delay * 1000);
    setTimeout(capture, delayMs);
  });

  const loadTimer = setTimeout(() => fail('timeout', 'timed out waiting for page load'), LOAD_TIMEOUT);

  async function capture() {
    if (settled) return;
    try {
      let img = null;
      try {
        img = await withTimeout(win.webContents.capturePage(), CAPTURE_TIMEOUT, 'timed out capturing page');
      } catch (e) {
        // Retry once on transient compositor errors.
        if (!/viz/i.test(e.message)) throw e;
        await new Promise((r) => setTimeout(r, 500));
        if (settled) return;
        img = await withTimeout(win.webContents.capturePage(), CAPTURE_TIMEOUT, 'timed out capturing page');
      }
      if (!img || img.isEmpty()) return fail('capture', 'capture produced an empty image');
      const png = img.toPNG();
      if (!png || !png.length) return fail('capture', 'capture produced no data');
      await fsp.writeFile(args.capture, png);
      if (settled) return;
      settled = true;
      await writeResultAtomic(args.result, { status: 'ok', file: 'capture.png' });
      try { app.exit(0); } catch { process.exit(0); }
    } catch (e) {
      return fail('capture', e.message);
    }
  }

  try {
    await win.loadURL(initialUrl);
    // Extra best-effort dialog override for early on-load dialogs.
    win.webContents.executeJavaScript('window.alert=()=>{};window.confirm=()=>true;window.prompt=()=>null;', true).catch(() => {});
  } catch (e) {
    await fail('load', `failed to load: ${e.message}`);
  }
}

main().catch(async (e) => {
  try {
    const args = parseRendererArgs(process.argv);
    if (args.result) await writeResultAtomic(args.result, { status: 'error', kind: 'internal', message: String((e && e.message) || e) });
  } catch {}
  try {
    require('electron').app.exit(1);
  } catch {
    process.exit(1);
  }
});
