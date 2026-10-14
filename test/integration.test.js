'use strict';
// Integration tests: spawn bin/htmlshot.js, never shell.
const test = require('node:test');
const assert = require('node:assert/strict');
const { execFile } = require('child_process');
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');

const BIN = path.resolve(__dirname, '../bin/htmlshot.js');
const FIX = path.resolve(__dirname, 'fixtures');

function hasDisplay() {
  return !!(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
}
function hasXvfb() {
  try {
    const { spawnSync } = require('child_process');
    const r = spawnSync('xvfb-run', ['--help'], { stdio: 'ignore' });
    return !r.error;
  } catch { return false; }
}
const canRender = hasDisplay() || hasXvfb();

function runHtmlshot(args, opts = {}) {
  return new Promise((resolve) => {
    execFile(process.execPath, [BIN, ...args], { ...opts, timeout: 120_000 }, (error, stdout, stderr) => {
      resolve({
        code: error && typeof error.code === 'number' ? error.code : (error ? (error.code || 1) : 0),
        signal: error && error.signal ? error.signal : null,
        stdout: String(stdout || ''),
        stderr: String(stderr || ''),
        error,
      });
    });
  });
}

function pngSize(buf) {
  assert.ok(buf.length > 24, 'png too short');
  assert.equal(buf[0], 0x89); assert.equal(buf[1], 0x50); assert.equal(buf[2], 0x4e); assert.equal(buf[3], 0x47);
  const w = buf.readUInt32BE(16), h = buf.readUInt32BE(20);
  return { width: w, height: h };
}

// Minimal PNG decoder: IHDR + IDAT inflate + unfilter, returns dark pixel count.
function countDarkPixels(buf) {
  let pos = 8, w = 0, h = 0, bitDepth = 0, colorType = 0;
  const idat = [];
  while (pos + 8 <= buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); bitDepth = data[8]; colorType = data[9]; }
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    pos += 12 + len;
  }
  if (!w || !h) throw new Error('no IHDR');
  if (bitDepth !== 8) throw new Error('unexpected bit depth ' + bitDepth);
  const raw = zlib.inflateSync(Buffer.concat(idat));
  let ch;
  if (colorType === 2) ch = 3; else if (colorType === 6) ch = 4; else if (colorType === 0) ch = 1; else throw new Error('unsupported color type ' + colorType);
  const stride = w * ch;
  let dark = 0, p = 0;
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < h; y++) {
    const filter = raw[p++];
    const cur = raw.subarray(p, p + stride); p += stride;
    const recon = Buffer.alloc(stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= ch ? recon[x - ch] : 0;
      const b = prev[x];
      const c = x >= ch ? prev[x - ch] : 0;
      let v = cur[x];
      if (filter === 1) v = (v + a) & 255;
      else if (filter === 2) v = (v + b) & 255;
      else if (filter === 3) v = (v + ((a + b) >> 1)) & 255;
      else if (filter === 4) {
        const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c);
        const pr = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
        v = (v + pr) & 255;
      }
      recon[x] = v;
    }
    for (let x = 0; x < w; x++) {
      let r, g, b;
      if (ch === 1) r = g = b = recon[x];
      else { r = recon[x * ch]; g = recon[x * ch + 1]; b = recon[x * ch + 2]; }
      if (r < 64 && g < 64 && b < 64) dark++;
    }
    prev = recon;
  }
  return { width: w, height: h, dark };
}

async function mkOutDir() {
  return await fsp.mkdtemp(path.join(os.tmpdir(), 'shots-'));
}

test('AT1 default static run prints one absolute path, valid 1280x800 PNG', { skip: !canRender }, async () => {
  const out = await mkOutDir();
  const r = await runHtmlshot([path.join(FIX, 'static.html'), '-o', out, '--delay', '0']);
  assert.equal(r.code, 0, `stderr: ${r.stderr}`);
  assert.match(r.stdout, /^[^\n]+\n$/);
  assert.equal(r.stdout.trim().split('\n').length, 1);
  const p = r.stdout.trim();
  assert.ok(path.isAbsolute(p));
  assert.ok(p.endsWith('.png'));
  const buf = await fsp.readFile(p);
  assert.deepEqual(pngSize(buf), { width: 1280, height: 800 });
  await fsp.rm(out, { recursive: true, force: true });
});

test('AT2 DOM settle: default delay shows change, delay 1 does not', { skip: !canRender }, async () => {
  const out = await mkOutDir();
  const r1 = await runHtmlshot([path.join(FIX, 'delayed.html'), '-o', out, '--delay', '1']);
  assert.equal(r1.code, 0, r1.stderr);
  const r3 = await runHtmlshot([path.join(FIX, 'delayed.html'), '-o', out, '--delay', '3']);
  assert.equal(r3.code, 0, r3.stderr);
  const b1 = await fsp.readFile(r1.stdout.trim());
  const b3 = await fsp.readFile(r3.stdout.trim());
  // Hash compare minimum; pixel count preferred.
  const h1 = crypto.createHash('sha256').update(b1).digest('hex');
  const h3 = crypto.createHash('sha256').update(b3).digest('hex');
  assert.notEqual(h1, h3, 'screenshots should differ across settle boundary');
  let d1 = 0, d3 = 0;
  try { d1 = countDarkPixels(b1).dark; d3 = countDarkPixels(b3).dark; } catch (e) { /* decoder fallback: hash already asserted */ }
  if (d1 !== undefined && d3 !== undefined) {
    assert.ok(d3 > d1, `expected more dark pixels after settle (1s:${d1} 3s:${d3})`);
    assert.ok(d3 > 10000, 'settled screenshot should contain the black block');
  }
  await fsp.rm(out, { recursive: true, force: true });
});

test('AT3 delay lower bound: elapsed >= delay', { skip: !canRender }, async () => {
  const out = await mkOutDir();
  const t0 = Date.now();
  const r = await runHtmlshot([path.join(FIX, 'static.html'), '-o', out, '--delay', '3']);
  const elapsed = (Date.now() - t0) / 1000;
  assert.equal(r.code, 0, r.stderr);
  // Timer starts at did-finish-load, so total >= delay minus slop.
  assert.ok(elapsed >= 2.75, `elapsed ${elapsed}s should be >= ~3s`);
  await fsp.rm(out, { recursive: true, force: true });
});

test('AT4 output dir: missing nested dir created; file path exits 4', { skip: !canRender }, async () => {
  const base = await mkOutDir();
  const nested = path.join(base, 'a', 'b');
  const r = await runHtmlshot([path.join(FIX, 'static.html'), '-o', nested, '--delay', '0']);
  assert.equal(r.code, 0, r.stderr);
  assert.ok(fs.existsSync(r.stdout.trim()));
  // Output path is a file -> exit 4.
  const filePath = path.join(base, 'afile');
  await fsp.writeFile(filePath, 'x');
  const r2 = await runHtmlshot([path.join(FIX, 'static.html'), '-o', filePath, '--delay', '0']);
  assert.equal(r2.code, 4, `expected 4 got ${r2.code} stderr ${r2.stderr}`);
  assert.match(r2.stderr, /cannot write/);
  await fsp.rm(base, { recursive: true, force: true });
});

test('AT5 input/usage errors', async () => {
  const out = await mkOutDir();
  const missing = await runHtmlshot([path.join(FIX, 'nope.html'), '-o', out]);
  assert.equal(missing.code, 3);
  const badopt = await runHtmlshot(['--delay', '9999', path.join(FIX, 'static.html')]);
  assert.equal(badopt.code, 2);
  const url = await runHtmlshot(['http://example.com/x.html']);
  assert.equal(url.code, 2);
  await fsp.rm(out, { recursive: true, force: true });
});

test('AT5 env error: no display + no xvfb -> exit 6', async () => {
  const env = { ...process.env };
  delete env.DISPLAY; delete env.WAYLAND_DISPLAY;
  env.PATH = await fsp.mkdtemp(path.join(os.tmpdir(), 'empty-path-'));
  const r = await runHtmlshot([path.join(FIX, 'static.html')], { env });
  assert.equal(r.code, 6, `expected 6 got ${r.code} stderr ${r.stderr}`);
});

test('AT6 concurrency: 10 parallel runs distinct files', { skip: !canRender }, async () => {
  const out = await mkOutDir();
  const runs = Array.from({ length: 10 }, () => runHtmlshot([path.join(FIX, 'static.html'), '-o', out, '--delay', '0']));
  const results = await Promise.all(runs);
  for (const r of results) assert.equal(r.code, 0, r.stderr);
  const paths = results.map((r) => r.stdout.trim());
  assert.equal(new Set(paths).size, 10);
  for (const p of paths) assert.ok(fs.existsSync(p));
  for (const r of results) assert.ok(!/profile-lock|already in use/i.test(r.stderr));
  await fsp.rm(out, { recursive: true, force: true });
});

test('AT7 SIGINT cleanup leaves no run dirs', { skip: !canRender }, async () => {
  const { spawn } = require('child_process');
  const out = await mkOutDir();
  const before = new Set(fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('htmlshot-')));
  const child = spawn(process.execPath, [BIN, path.join(FIX, 'static.html'), '-o', out, '--delay', '20'], { stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((r) => setTimeout(r, 4000));
  child.kill('SIGINT');
  const code = await new Promise((r) => { child.on('exit', (c, s) => r({ c, s })); setTimeout(() => r({ c: 'timeout' }), 15000); });
  assert.notEqual(code.c, 0, 'SIGINT run should not exit 0');
  await new Promise((r) => setTimeout(r, 1000));
  const after = fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('htmlshot-')).filter((n) => !before.has(n));
  assert.equal(after.length, 0, `leftover run dirs: ${after}`);
  await fsp.rm(out, { recursive: true, force: true });
});

test('AT8 stdout purity + size flags + help/version', { skip: !canRender }, async () => {
  const out = await mkOutDir();
  const r = await runHtmlshot([path.join(FIX, 'static.html'), '-o', out, '--delay', '0', '--width', '400', '--height', '300']);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /^[^\n]+\n$/);
  assert.ok(!/Electron|libva|GPU|dbus/i.test(r.stdout));
  const buf = await fsp.readFile(r.stdout.trim());
  assert.deepEqual(pngSize(buf), { width: 400, height: 300 });
  const help = await runHtmlshot(['--help']);
  assert.equal(help.code, 0);
  const ver = await runHtmlshot(['--version']);
  assert.equal(ver.code, 0);
  await fsp.rm(out, { recursive: true, force: true });
});

test('alert fixture does not stall', { skip: !canRender }, async () => {
  const out = await mkOutDir();
  const r = await runHtmlshot([path.join(FIX, 'alert.html'), '-o', out, '--delay', '0']);
  assert.equal(r.code, 0, `alert run failed: ${r.stderr}`);
  assert.ok(fs.existsSync(r.stdout.trim()));
  await fsp.rm(out, { recursive: true, force: true });
});
