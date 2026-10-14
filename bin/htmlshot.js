#!/usr/bin/env node
'use strict';
// Launcher: validates args, picks display backend, spawns Electron, publishes PNG.
const crypto = require('crypto');
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { pathToFileURL } = require('url');
const { EXIT, LIMITS, TIMEOUTS_MS, DEFAULTS } = require('../src/constants');

function usage() {
  return [
    'Usage: htmlshot [options] <file>',
    '',
    'Render a local HTML file and save a PNG screenshot.',
    '',
    'Options:',
    '  -d, --delay <seconds>     Seconds to wait after load (0-600, default 3)',
    '  -o, --output-dir <dir>    Screenshot directory (default /tmp)',
    '  -W, --width <px>          Viewport width 1-7680 (default 1280)',
    '  -H, --height <px>         Viewport height 1-4320 (default 800)',
    '  --no-sandbox              Disable Chromium sandbox (needed as root)',
    '  -h, --help                Show this help',
    '  -V, --version             Show version',
  ].join('\n');
}

function version() {
  try {
    return require('../package.json').version;
  } catch {
    return '0.0.0';
  }
}

function fail(msg, code) {
  fs.writeSync(2, `htmlshot: error: ${msg}\n`);
  process.exit(code);
}

// Parse argv (without node/script). Supports --opt value and --opt=value.
// Rejects combined short flags like -d5.
function parseArgs(argv) {
  const out = {
    file: null, positionals: [],
    delay: String(DEFAULTS.DELAY), outputDir: DEFAULTS.OUTPUT_DIR,
    width: String(DEFAULTS.WIDTH), height: String(DEFAULTS.HEIGHT),
    delaySet: false, outputDirSet: false, widthSet: false, heightSet: false,
    noSandbox: false, help: false, version: false,
  };
  const takesValue = new Set(['--delay', '--output-dir', '--width', '--height', '-d', '-o', '-W', '-H']);
  let i = 0;
  const assign = (key, val) => {
    if (key === '--delay' || key === '-d') { out.delay = val; out.delaySet = true; }
    else if (key === '--output-dir' || key === '-o') { out.outputDir = val; out.outputDirSet = true; }
    else if (key === '--width' || key === '-W') { out.width = val; out.widthSet = true; }
    else if (key === '--height' || key === '-H') { out.height = val; out.heightSet = true; }
  };
  while (i < argv.length) {
    const a = argv[i];
    if (a === '--') { out.positionals.push(...argv.slice(i + 1)); break; }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      let key = a, val = null;
      if (eq !== -1) { key = a.slice(0, eq); val = a.slice(eq + 1); }
      if (key === '--no-sandbox') {
        if (val !== null) throw new Error('invalid argument: --no-sandbox takes no value');
        out.noSandbox = true; i++; continue;
      }
      if (key === '--help') { out.help = true; i++; continue; }
      if (key === '--version') { out.version = true; i++; continue; }
      if (takesValue.has(key)) {
        if (val === null) {
          if (i + 1 >= argv.length) throw new Error(`invalid argument: ${key} requires a value`);
          val = argv[++i];
        }
        if (val === undefined || val === '') throw new Error(`invalid argument: ${key} requires a value`);
        assign(key, val); i++; continue;
      }
      throw new Error(`invalid argument: unknown option ${key}`);
    } else if (a.startsWith('-') && a.length > 1) {
      if (a === '-h') { out.help = true; i++; continue; }
      if (a === '-V') { out.version = true; i++; continue; }
      // Short opts with = : -d=5
      const eq = a.indexOf('=');
      if (eq !== -1) {
        const key = a.slice(0, eq), val = a.slice(eq + 1);
        if (!takesValue.has(key)) throw new Error(`invalid argument: unknown option ${key}`);
        if (val === '') throw new Error(`invalid argument: ${key} requires a value`);
        assign(key, val); i++; continue;
      }
      if (takesValue.has(a)) {
        if (i + 1 >= argv.length) throw new Error(`invalid argument: ${a} requires a value`);
        assign(a, argv[++i]); i++; continue;
      }
      // Reject combined forms like -d5.
      throw new Error(`invalid argument: unknown option ${a}`);
    } else {
      out.positionals.push(a); i++;
    }
  }
  return out;
}

function validateParsed(p) {
  if (p.help || p.version) return;
  if (p.positionals.length === 0) throw new Error('invalid argument: expected exactly one input file');
  if (p.positionals.length > 1) throw new Error('invalid argument: expected exactly one input file');
  const file = p.positionals[0];
  if (/^https?:\/\//i.test(file)) throw new Error('invalid argument: http(s):// URLs are not supported; pass a local file');
  // Delay: float 0..600.
  const ds = String(p.delay).trim();
  if (ds === '') throw new Error('invalid argument: --delay must be a number between 0 and 600');
  const d = Number(ds);
  if (!Number.isFinite(d) || Number.isNaN(d) || d < LIMITS.DELAY_MIN || d > LIMITS.DELAY_MAX)
    throw new Error('invalid argument: --delay must be a number between 0 and 600');
  // Width/height: base-10 integers only.
  for (const [label, val, lo, hi] of [
    ['--width', p.width, LIMITS.WIDTH_MIN, LIMITS.WIDTH_MAX],
    ['--height', p.height, LIMITS.HEIGHT_MIN, LIMITS.HEIGHT_MAX],
  ]) {
    const s = String(val).trim();
    if (!/^[0-9]+$/.test(s)) throw new Error(`invalid argument: ${label} must be an integer between ${lo} and ${hi}`);
    const n = Number(s);
    if (!Number.isSafeInteger(n) || n < lo || n > hi)
      throw new Error(`invalid argument: ${label} must be an integer between ${lo} and ${hi}`);
  }
  if (typeof p.outputDir !== 'string' || p.outputDir === '')
    throw new Error('invalid argument: --output-dir requires a value');
}

function sanitizeBase(realpath) {
  const base = path.basename(realpath);
  const noExt = base.replace(/\.[^.]*$/, '');
  const raw = noExt === '' ? 'shot' : noExt;
  const cleaned = raw.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, LIMITS.NAME_MAX);
  return cleaned === '' ? 'shot' : cleaned;
}

function utcStamp(d) {
  const p = (n, l = 2) => String(n).padStart(l, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

function hasXvfbRun() {
  try {
    const r = spawnSync('xvfb-run', ['--help'], { stdio: 'ignore' });
    if (r.error) return false;
    return true;
  } catch {
    return false;
  }
}

async function main() {
  let parsed;
  try {
    parsed = parseArgs(process.argv.slice(2));
  } catch (e) {
    fail(e.message, EXIT.USAGE);
  }
  if (parsed.help) { process.stdout.write(usage() + '\n'); process.exit(0); }
  if (parsed.version) { process.stdout.write(version() + '\n'); process.exit(0); }
  try {
    validateParsed(parsed);
  } catch (e) {
    fail(e.message, EXIT.USAGE);
  }

  const delaySec = Number(String(parsed.delay).trim());
  const width = Number(String(parsed.width).trim());
  const height = Number(String(parsed.height).trim());
  const noSandbox = parsed.noSandbox;
  if (noSandbox) fs.writeSync(2, 'htmlshot: warning: --no-sandbox disables the Chromium sandbox\n');

  // Input file -> exit 3.
  const inputArg = parsed.positionals[0];
  let realpath;
  try {
    realpath = await fsp.realpath(path.resolve(inputArg));
  } catch {
    fail(`input file ${inputArg}: no such file`, EXIT.INPUT);
  }
  try {
    const st = await fsp.stat(realpath);
    if (!st.isFile()) fail(`input file ${inputArg}: not a regular file`, EXIT.INPUT);
  } catch (e) {
    if (e.code === 'ENOENT') fail(`input file ${inputArg}: no such file`, EXIT.INPUT);
    fail(`input file ${inputArg}: not readable`, EXIT.INPUT);
  }
  try {
    await fsp.access(realpath, fs.constants.R_OK);
  } catch {
    fail(`input file ${inputArg}: not readable`, EXIT.INPUT);
  }
  const fileUrl = pathToFileURL(realpath).href;
  const sanitized = sanitizeBase(realpath);

  // Output dir -> exit 4.
  const outputDirRaw = parsed.outputDir;
  let outputDir;
  try {
    await fsp.mkdir(outputDirRaw, { recursive: true });
    const st = await fsp.stat(outputDirRaw);
    if (!st.isDirectory()) fail(`cannot write to output directory ${outputDirRaw}: not a directory`, EXIT.OUTPUT);
    await fsp.access(outputDirRaw, fs.constants.W_OK);
    outputDir = path.resolve(outputDirRaw);
  } catch (e) {
    if (e.code === 'EACCES' || e.code === 'EROFS' || e.code === 'ENOTDIR' || e.code === 'EEXIST')
      fail(`cannot write to output directory ${outputDirRaw}: ${e.code}`, EXIT.OUTPUT);
    if (e instanceof Error && e.message.startsWith('cannot write')) throw e;
    fail(`cannot write to output directory ${outputDirRaw}: ${e.code || e.message}`, EXIT.OUTPUT);
  }

  // Display backend -> exit 6.
  let backend;
  if (process.env.DISPLAY || process.env.WAYLAND_DISPLAY) backend = 'direct';
  else if (hasXvfbRun()) backend = 'xvfb';
  else fail('cannot start Electron/display: no display (DISPLAY/WAYLAND_DISPLAY unset) and xvfb-run not found on PATH', EXIT.ENV);

  // Run dir.
  let runDir;
  try {
    runDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'htmlshot-'));
  } catch (e) {
    fail(`internal error: cannot create run directory: ${e.message}`, EXIT.INTERNAL);
  }
  const capturePath = path.join(runDir, 'capture.png');
  const resultPath = path.join(runDir, 'result.json');
  const readyPath = path.join(runDir, 'ready');

  let electronBin;
  try {
    electronBin = require('electron');
    if (typeof electronBin !== 'string' || electronBin === '') throw new Error('empty');
  } catch (e) {
    await cleanupOnly(runDir, null);
    fail('cannot start Electron/display: Electron binary not found', EXIT.ENV);
  }
  const appRoot = path.resolve(__dirname, '..');

  const rendererArgs = [
    appRoot,
    `--input=${realpath}`,
    `--file-url=${fileUrl}`,
    `--delay=${delaySec}`,
    `--width=${width}`,
    `--height=${height}`,
    `--run-dir=${runDir}`,
    `--capture=${capturePath}`,
    `--result=${resultPath}`,
    `--ready-marker=${readyPath}`,
    `--user-data-dir=${path.join(runDir, 'profile')}`,
  ];
  if (noSandbox) rendererArgs.push('--no-sandbox');

  let child = null;
  let cleaned = false;
  const cleanup = async () => {
    if (cleaned) return;
    cleaned = true;
    if (child && child.pid) {
      try { process.kill(-child.pid, 'SIGKILL'); } catch (e) { /* ESRCH ok */ try { child.kill('SIGKILL'); } catch {} }
    }
    try { await fsp.rm(runDir, { recursive: true, force: true }); } catch {}
  };
  const cleanupOnly = async (dir, ch) => {
    if (ch && ch.pid) { try { process.kill(-ch.pid, 'SIGKILL'); } catch {} }
    try { await fsp.rm(dir, { recursive: true, force: true }); } catch {}
  };
  process.on('exit', () => {
    if (!cleaned) {
      cleaned = true;
      if (child && child.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }
      try { fs.rmSync(runDir, { recursive: true, force: true }); } catch {}
    }
  });
  const onSignal = (code) => {
    // Synchronous: must win the race against the supervision loop below,
    // whose child-exit handler would otherwise exit 5 with runDir intact.
    cleaned = true;
    if (child && child.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }
    try { fs.rmSync(runDir, { recursive: true, force: true }); } catch {}
    process.exit(code);
  };
  process.on('SIGINT', () => onSignal(130));
  process.on('SIGTERM', () => onSignal(143));
  process.on('uncaughtException', async (e) => { await cleanup(); fail(`internal error: ${e.message}`, EXIT.INTERNAL); });
  process.on('unhandledRejection', async (e) => { await cleanup(); fail(`internal error: ${e && e.message ? e.message : e}`, EXIT.INTERNAL); });

  const childEnv = { ...process.env };
  // Prefer X11 when a DISPLAY exists: Wayland+Vulkan is flaky for capture.
  // Wayland-only hosts (no DISPLAY) keep WAYLAND_DISPLAY as-is.
  if (process.env.DISPLAY || backend === 'xvfb') delete childEnv.WAYLAND_DISPLAY;
  const spawnOpts = { stdio: ['ignore', 'ignore', 'ignore'], shell: false, detached: true, windowsHide: true, env: childEnv };
  try {
    if (backend === 'xvfb') {
      child = spawn('xvfb-run', ['-a', electronBin, ...rendererArgs], spawnOpts);
    } else {
      child = spawn(electronBin, rendererArgs, spawnOpts);
    }
  } catch (e) {
    await cleanup();
    fail(`cannot start Electron/display: spawn failed: ${e.message}`, EXIT.ENV);
  }
  child.on('error', () => { /* handled via exit path */ });

  const watchdogMs = TIMEOUTS_MS.STARTUP + TIMEOUTS_MS.LOAD + TIMEOUTS_MS.CAPTURE + Math.round(delaySec * 1000) + TIMEOUTS_MS.GRACE;

  const resultReady = async (deadline) => {
    while (Date.now() < deadline) {
      try {
        const data = await fsp.readFile(resultPath, 'utf8');
        try {
          const j = JSON.parse(data);
          if (j && typeof j.status === 'string') return j;
        } catch { /* partial write, keep polling */ }
      } catch (e) {
        if (e.code !== 'ENOENT') { /* keep polling */ }
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    return null;
  };
  const childExit = new Promise((resolve) => {
    child.on('exit', (code, signal) => resolve({ code, signal }));
  });
  const watchdog = new Promise((resolve) => setTimeout(() => resolve({ timeout: true }), watchdogMs));
  const poll = resultReady(Date.now() + watchdogMs).then((j) => ({ result: j }));

  const winner = await Promise.race([
    childExit.then((e) => ({ exited: e })),
    poll.then((p) => ({ polled: p })),
    watchdog,
  ]);

  const readyExists = async () => {
    try { await fsp.access(readyPath); return true; } catch { return false; }
  };
  const killGroup = () => {
    if (child && child.pid) {
      try { process.kill(-child.pid, 'SIGKILL'); } catch {}
    }
  };

  // Success path: result.json ok.
  let resultJson = null;
  if (winner.polled && winner.polled.result) {
    resultJson = winner.polled.result;
  } else if (winner.exited) {
    // Child exited before result appeared; re-check once for late result.
    try {
      const data = await fsp.readFile(resultPath, 'utf8');
      resultJson = JSON.parse(data);
    } catch { resultJson = null; }
    if (!resultJson) {
      const ready = await readyExists();
      await cleanup();
      const { code, signal } = winner.exited;
      if (!ready) fail(`cannot start Electron/display: Electron exited early (code=${code} signal=${signal})`, EXIT.ENV);
      fail(`render failed: renderer exited early (code=${code} signal=${signal})`, EXIT.RENDER);
    }
  } else if (winner.timeout) {
    const ready = await readyExists();
    killGroup();
    try { await new Promise((r) => { child.on('exit', r); setTimeout(r, 3000); }); } catch {}
    await cleanup();
    if (!ready) fail('cannot start Electron/display: timed out waiting for Electron to start', EXIT.ENV);
    fail('render failed: timed out waiting for render', EXIT.RENDER);
  }

  // If we got here via poll but child-exit race won first with no result, resultJson set above.
  // If winner was poll with null (deadline), treat as watchdog.
  if (!resultJson) {
    const ready = await readyExists();
    killGroup();
    await cleanup();
    if (!ready) fail('cannot start Electron/display: timed out waiting for Electron to start', EXIT.ENV);
    fail('render failed: timed out waiting for render', EXIT.RENDER);
  }

  if (resultJson.status === 'error') {
    killGroup();
    await cleanup();
    fail(`render failed: ${resultJson.message || resultJson.kind || 'unknown'}`, EXIT.RENDER);
  }
  if (resultJson.status !== 'ok') {
    killGroup();
    await cleanup();
    fail(`render failed: ${resultJson.message || 'unknown'}`, EXIT.RENDER);
  }
  // Verify capture exists and non-empty.
  let stat;
  try {
    stat = await fsp.stat(capturePath);
    if (!stat.isFile() || stat.size === 0) throw new Error('empty');
  } catch {
    killGroup();
    await cleanup();
    fail('render failed: capture produced no data', EXIT.RENDER);
  }

  // Publish collision-safe.
  let dest = null;
  for (let attempt = 0; attempt < 10; attempt++) {
    const stamp = utcStamp(new Date());
    const rand = crypto.randomBytes(3).toString('hex');
    const name = `${sanitized}-${stamp}-${rand}.png`;
    const candidate = path.join(outputDir, name);
    try {
      await fsp.copyFile(capturePath, candidate, fs.constants.COPYFILE_EXCL);
      await fsp.chmod(candidate, 0o644);
      dest = candidate;
      break;
    } catch (e) {
      if (e.code === 'EEXIST') continue;
      killGroup();
      await cleanup();
      fail(`cannot write to output directory ${outputDir}: ${e.code || e.message}`, EXIT.OUTPUT);
    }
  }
  if (!dest) {
    killGroup();
    await cleanup();
    fail(`cannot write to output directory ${outputDir}: could not allocate a unique output name`, EXIT.OUTPUT);
  }

  // Wait up to 5s for natural exit, then kill group (still success).
  const exited = await Promise.race([
    new Promise((r) => {
      if (child.exitCode !== null || child.signalCode !== null) r(true);
      else { child.on('exit', () => r(true)); setTimeout(() => r(false), TIMEOUTS_MS.EXIT_GRACE); }
    }),
  ]);
  if (!exited) killGroup();
  // Remove run dir, keep dest.
  cleaned = false; // allow cleanup to run (kills group again harmlessly + removes runDir)
  await cleanup();
  process.stdout.write(dest + '\n');
  process.exit(0);
}

async function cleanupOnly(dir, child) {
  if (child && child.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }
  try { await fsp.rm(dir, { recursive: true, force: true }); } catch {}
}

if (require.main === module) {
  main().catch(async (e) => {
    try { fs.writeSync(2, `htmlshot: error: internal error: ${e && e.message ? e.message : e}\n`); } catch {}
    process.exit(EXIT.INTERNAL);
  });
}

module.exports = { parseArgs, validateParsed, sanitizeBase, utcStamp, usage };
