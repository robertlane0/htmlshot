# htmlshot Implementation Plan

*Derived from `SPEC.md` Draft 0.1 · October 13, 2026. Target: Linux x86_64 / arm64, system Node LTS launcher + pinned Electron renderer.*

## 0. Goal and reading guide

Build `htmlshot` exactly as specified: one command, one local HTML file in, one absolute PNG path on stdout, script-friendly exit codes, parallel-safe, works with no desktop session via Xvfb fallback.

This plan is ordered for implementation. Phases 1–6 produce a working vertical slice; Phases 7–9 harden it to pass all 8 acceptance tests in SPEC §7.

Non-goals for v1 (do not implement): remote URLs, full-page/element capture, multi-document runs, non-PNG formats, server mode, `--full-page/--scale/--format/--json/--timeout/--wait-for-selector`.

---

## 1. Repository layout to create

```
htmlshot/
  PLAN.md                # this file
  SPEC.md                # existing spec (read-only input)
  LICENSE                # existing (MIT, Robert Lane 2026)
  package.json           # name, version, bin, exact electron dep, engines, scripts
  package-lock.json      # committed
  bin/
    htmlshot.js          # LAUNCHER — runs under system Node, shebang, executable
  src/
    renderer.js          # RENDERER — Electron main process, renders + captures only
    constants.js         # (optional) shared timeouts, limits, exit codes — required by both
  test/
    fixtures/
      static.html        # <h1>hello</h1>, no JS
      delayed.html       # JS edits DOM at ~2 s (setTimeout 2000)
      alert.html         # calls alert()/confirm()/prompt() on load
      navigate.html      # attempts window.location change + window.open
    unit.test.js         # arg validation, sanitize, filename, file-url tests (node:test)
    integration.test.js  # end-to-end runs, exit codes, concurrency, signals
  README.md              # install, runtime deps (GTK/NSS/GBM/ALSA, Xvfb), examples
  .gitignore             # node_modules/, test/shots/, /tmp not needed
```

Design constraint from SPEC §4: **policy lives in launcher, rendering lives in renderer.** Renderer never touches the output directory; it only writes to the private run directory passed via argv. Launcher never renders; it validates, spawns, supervises, publishes.

Run-directory layout (private per run, created by launcher with `fs.mkdtemp`, always removed):

```
<runDir>/
  profile/          # passed as --user-data-dir, isolates concurrent runs
  capture.png       # raw capturePage output written by renderer
  result.json       # { status, ... } written by renderer before quit
  ready             # empty marker touched by renderer on app.whenReady (for exit 5 vs 6)
```

Final output layout (in user `--output-dir`):

```
<outputDir>/<sanitized>-<timestamp>-<6hex>.png
```

---

## 2. Project setup (Phase 1)

1. `npm init -y`; set in `package.json`:
   - `name: htmlshot`, `version: 0.1.0`, `license: MIT`, `type: commonjs` (simpler for Electron main + launcher interop).
   - `bin: { "htmlshot": "bin/htmlshot.js" }`.
   - `main: src/renderer.js` (so `electron .` finds it; launcher will spawn Electron with the app root).
   - `engines: { "node": ">=20" }` (currently supported LTS at time of writing; verify with `node --version`).
   - `dependencies: { "electron": "<exact pinned>" }` — choose the current stable at implementation time and pin exact (e.g. `npm install --save-exact electron@X.Y.Z`). Do not use `^`/`~`.
   - `scripts`: `test: node --test test/*.test.js`, `test:acceptance` alias, `postinstall: electron --version` smoke check.
2. `chmod +x bin/htmlshot.js`, shebang `#!/usr/bin/env node`.
3. `.gitignore`: `node_modules/`, `test/shots*/`, `*.log`.
4. Verify Electron launches on the dev machine: `npx electron --version` with `DISPLAY` set, and under `xvfb-run -a` with `DISPLAY`/`WAYLAND_DISPLAY` unset. Record the pinned version and the result of the headless-spike in Phase 4.
5. Document system runtime deps in `README.md`: Electron Linux libs (GTK 3, NSS, GBM, ALSA — list the distro packages, e.g. Debian `libgtk-3-0 libnss3 libgbm1 libasound2`), plus `xvfb` package only needed when no display. Note fonts affect rendering; recommend a fixed container image for reproducible screenshots.

Acceptance for this phase: `npm install` succeeds on clean checkout; `npx electron --version` exits 0; `bin/htmlshot.js --help` prints usage (after Phase 3).

---

## 3. Shared contracts — implement first as `src/constants.js`

Single source of truth imported (or duplicated as literals with a comment) by both processes:

```js
module.exports = {
  EXIT: { SUCCESS: 0, INTERNAL: 1, USAGE: 2, INPUT: 3, OUTPUT: 4, RENDER: 5, ENV: 6 },
  LIMITS: {
    DELAY_MIN: 0, DELAY_MAX: 600,
    WIDTH_MIN: 1, WIDTH_MAX: 7680,
    HEIGHT_MIN: 1, HEIGHT_MAX: 4320,
    NAME_MAX: 64,
  },
  TIMEOUTS_MS: { STARTUP: 15_000, LOAD: 30_000, CAPTURE: 10_000 },
  DEFAULTS: { DELAY: 3, WIDTH: 1280, HEIGHT: 800, OUTPUT_DIR: '/tmp' },
};
```

Also define:

- `result.json` schema:
  - Success: `{ "status": "ok", "file": "capture.png" }`.
  - Failure: `{ "status": "error", "kind": "load" | "renderer-crash" | "capture" | "timeout" | "internal", "message": "<human>" }`.
- Renderer argv protocol (launcher → renderer, all explicit, no env dependence except display):
  - `--input <absolute-realpath>`, `--file-url <file:// URL>`, `--delay <seconds>`, `--width <px>`, `--height <px>`, `--run-dir <abs>`, `--capture <abs capture.png path>`, `--result <abs result.json path>`, `--ready-marker <abs ready path>`, `[--no-sandbox]` passthrough indicator (renderer doesn't need it; Chromium flag is set by launcher via Electron CLI switches — see §5).
- Filename format: `<sanitized>-<UTC timestamp>-<6 hex lowercase>.png` where timestamp is `YYYYMMDDTHHMMSSZ` derived from `new Date().toISOString()` with `[-:]` stripped and millis dropped.

---

## 4. Launcher `bin/htmlshot.js` — detailed design (Phase 2, core of the project)

Runs under system Node. Must never write anything but the final path to stdout. All diagnostics go to stderr as `htmlshot: error: <msg>` (failures) or `htmlshot: warning: <msg>` (`--no-sandbox` notice). Use only `console.error` / `fs.writeSync(2, ...)` for diagnostics and a single `console.log`/`fs.writeSync(1, ...)` for the success path.

### 4.1 Argument parsing (hand-rolled, no CLI framework)

Rationale: avoid an extra dependency and keep exit-code control exact. ~80–120 lines.

Supported forms:

- Positional `<file>`: exactly one required. More than one → exit 2 (`htmlshot: error: expected exactly one input file`).
- `-d, --delay <seconds>`: float, decimals allowed, `0 ≤ d ≤ 600`, finite. Reject `NaN`, `Infinity`, negative, `>600`, non-numeric. Note: allow `"0"`, `"0.5"`, `"3.25"`.
- `-o, --output-dir <dir>`: any non-empty string; `~` expansion is done by the shell, do not expand manually (document that `~/shots` works because the shell expands it before Node sees it).
- `-W, --width <px>`, `-H, --height <px>`: base-10 integers only (`/^[0-9]+$/` after trim, then range check 1–7680 / 1–4320). Reject floats (`1280.5`), hex (`0x500`), negatives.
- `--no-sandbox`: boolean flag, no value. If present, print `htmlshot: warning: --no-sandbox disables the Chromium sandbox` to stderr (still exit 0 on success). Never applied implicitly even when running as root — if Electron fails as root without the flag, surface its stderr hint but exit 6 and tell the user to re-run with `--no-sandbox`.
- `-h, --help`: print usage to stdout? Spec says usage and version; convention: help to stdout exit 0. Keep stdout-clean rule for success runs only — help/version are the exception and must be documented. Simplest compliant choice: help/version go to stdout, exit 0.
- `-V, --version`: print `package.json` version to stdout, exit 0.
- Unknown option (`--foo`, `-Z`), missing value (`--delay` with nothing after), `--delay=5` form: decide and document. Recommended: support both `--opt value` and `--opt=value`; reject combined short flags (`-d5` — either support explicitly or reject with exit 2; document the choice). Any parse error → exit 2.

Order of checks (matters for exit-code precedence):

1. `--help` / `--version` short-circuit (before any validation).
2. Usage errors (bad option, bad value, missing/extra positional, `http(s)://` input) → exit 2. The `http(s)://` check happens here (string prefix match, case-insensitive) so a URL argument is a usage error, not "file missing".
3. Input file checks → exit 3.
4. Output-dir checks → exit 4.
5. Display-backend check → exit 6 (after input/output are known good, so `missing input + no display` reports 3, matching acceptance test 5's intent).

### 4.2 Input-file validation (exit 3)

1. Reject if arg matches `/^https?:\/\//i` → exit 2 (`http(s):// URLs are not supported; pass a local file`).
2. `path.resolve(file)` then `fs.realpath()` (resolves symlinks; failure → exit 3 `input file does not exist`).
3. `fs.stat()`: must satisfy `stat.isFile()` — directories, FIFOs, sockets, devices, `/dev/null` → exit 3 (`not a regular file`). Missing (`ENOENT`), `ENOTDIR`, `EACCES` → exit 3 with specific message.
4. Readability: `fs.access(realpath, fs.constants.R_OK)` → on failure exit 3 (`not readable`). Race between check and renderer load is handled later as a render error (exit 5), not re-checked.
5. Build `file://` URL for the renderer: use `url.pathToFileURL(realpath).href`. Do not hand-concatenate `file://` + path (breaks spaces, `#`, `?`, non-ASCII).

Sanitization for output basename (also unit-tested):

```js
function sanitizeBase(realpath) {
  const raw = path.basename(realpath).replace(/\.[^.]*$/, '') || 'shot'; // strip last extension
  const cleaned = raw.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 64) || 'shot';
  // edge: input like `.html` → raw '' → fallback 'shot'; all-underscores is fine
  return cleaned;
}
```

Truncate to 64 chars *after* sanitizing (spec order). If result is empty (e.g. basename `.html`), fall back to `"shot"`.

### 4.3 Output-directory validation (exit 4)

1. `fs.mkdir(outputDir, { recursive: true })` — failure (`EACCES`, `EROFS`, `ENOTDIR`, file exists at path) → exit 4.
2. Re-`stat`: must be a directory → else exit 4.
3. `fs.access(dir, W_OK)` → else exit 4. Note: running as root bypasses permission bits; the later copy failure still maps to exit 4, so keep the copy-error mapping too.
4. Resolve to absolute path (`path.resolve`) for later publish + print steps. Do not require the directory to be empty.

### 4.4 Display-backend selection (exit 6)

Implement `selectBackend()`:

```js
if (process.env.DISPLAY || process.env.WAYLAND_DISPLAY) return { kind: 'direct' };
if (await hasXvfbRun()) return { kind: 'xvfb' };
// else exit 6
console.error('htmlshot: error: no display (DISPLAY/WAYLAND_DISPLAY unset) and xvfb-run not found on PATH');
process.exit(6);
```

- `hasXvfbRun()`: try `spawnSync('xvfb-run', ['--help'], { stdio: 'ignore' })` or search `PATH` via `which`-equivalent (iterate `process.env.PATH` + `fs.access(X_OK)`). `spawnSync` with `shell: false` is sufficient; treat `ENOENT` as absent, any other spawn error as absent (then exit 6).
- `xvfb` spawn form: `['xvfb-run', '-a', electronBinary, ...electronArgs]` — `-a` picks a free server number, giving parallel safety. Do not add `-s` screen options in v1; defaults are fine since the window is hidden and capture is viewport-sized.
- Never set `DISPLAY` manually; never try `ELECTRON_HEADLESS`/`--headless` in v1 (listed as an open question to evaluate, not to ship).

### 4.5 Run directory + Electron spawn

1. `runDir = await fs.mkdtemp(path.join(os.tmpdir(), 'htmlshot-'))`. Failure → exit 1 (internal) or exit 4? Run dir is in tmp, not the output dir — map to exit 1 with message. Record `runDir` for cleanup.
2. `profileDir = path.join(runDir, 'profile')`; `capturePath = path.join(runDir, 'capture.png')`; `resultPath = path.join(runDir, 'result.json')`; `readyPath = path.join(runDir, 'ready')`.
3. Resolve Electron binary: `const electron = require('electron')` (returns binary path string). If require fails → exit 6 (`Electron could not start`). App root = package root (directory containing `package.json`); renderer entry = `src/renderer.js`.
4. Build argv array (never a shell string, always `shell: false`):
   - Direct: `[appRoot, '--input=...', '--file-url=...', ...]` spawned as `spawn(electron, args, opts)`.
   - Xvfb: `spawn('xvfb-run', ['-a', electron, appRoot, ...rendererArgs], opts)`.
   - Always forward `--user-data-dir=<profileDir>` — Electron reads this as a Chromium switch; pass it as part of `rendererArgs` (or via `app.setPath('userData', ...)` in renderer reading `--run-dir`; prefer the CLI switch so no profile is ever created outside `runDir`). Also pass `--no-sandbox` through to Chromium only when the user gave it: Electron respects `app.commandLine.appendSwitch('no-sandbox')` in renderer, so the launcher just forwards a `--no-sandbox` renderer flag and the renderer calls `appendSwitch`. Alternative: launcher adds `--no-sandbox` to the Electron CLI args. Pick one and document; renderer-side `appendSwitch` is more explicit and testable.
5. Spawn opts: `{ stdio: ['ignore', 'ignore', 'ignore'], shell: false, detached: true, windowsHide: true }` — stdout/stderr fully discarded per "Chromium's own logging is captured and discarded". `detached: true` creates a new process group so the watchdog can `kill(-pgid, 'SIGKILL')` and guarantee no orphaned `electron`/`chrome` children. On platforms where negative-pid kill is unavailable, fall back to `child.kill('SIGKILL')` plus `pkill -P` best-effort; Linux is the only v1 target so group-kill must work.
6. Record `child.pid` (group leader). Unref? No — the launcher must wait for it. Use `child.on('exit')` / `await once(child, 'exit')` with a watchdog race (see §6).

### 4.6 Supervision, watchdog, result collection

Timeouts (SPEC §Timeouts, fixed in v1): `STARTUP 15 s`, `LOAD 30 s`, `CAPTURE 10 s`. Overall watchdog:

```
WATCHDOG_MS = STARTUP + LOAD + CAPTURE + delay*1000 + GRACE_MS(2000)
```

GRACE covers spawn + copy/publish jitter; document it as an implementation buffer, not part of the spec contract. The observable guarantee for acceptance test 3 is `captureTime - loadTime ≥ delay`.

Launcher wait loop (pseudocode):

```js
const deadline = Date.now() + WATCHDOG_MS;
const exitP = once(child, 'exit'); // [code, signal]
const poll = pollForResult(resultPath, deadline); // 50 ms interval: file exists + valid JSON + status set
const winner = await Promise.race([exitP.then(...), poll, watchdogTimer(deadline)]);
```

Cases:

- `result.json` appears with `{status:'ok'}` + `capture.png` exists and non-empty → proceed to publish (§4.7). Electron should exit shortly after; wait up to 5 s for natural exit, then SIGKILL the group if still alive (still success — publish first).
- `result.json` `{status:'error', kind, message}` → kill group if still alive, cleanup, map kind → exit 5 (all renderer-reported failures are render failures per spec: load error, crash, capture error). Include `message` on stderr.
- Electron exits non-zero / by signal with no `result.json` → if `ready` marker absent → exit 6 (`Electron or display backend could not start`); else exit 5 (renderer crash before reporting — e.g. SIGSEGV). Include exit code/signal in the stderr message.
- Watchdog fires first → `kill(-child.pid, 'SIGKILL')` (guard `ESRCH`), wait for exit, cleanup, then exit 6 if `ready` marker absent else exit 5. Message must say which timeout (`timed out waiting for ...`).
- Renderer success but `capture.png` missing/empty → exit 5.

Polling `result.json` must tolerate partial writes: renderer writes to `result.json.tmp` + atomic `rename` (same dir), so the launcher never reads a half-written file. Launcher `JSON.parse` failures on a present file → keep polling until deadline (don't crash with exit 1 on a transient read).

### 4.7 Publish (collision-safe, never overwrite, mode 0644)

Inputs: `capturePath` (in runDir), `outputDir` (absolute), `sanitized` base.

```js
for (let attempt = 0; attempt < 10; attempt++) {
  const stamp = utcStamp(new Date()); // YYYYMMDDTHHMMSSZ
  const rand = crypto.randomBytes(3).toString('hex'); // 6 hex
  const name = `${sanitized}-${stamp}-${rand}.png`;
  const dest = path.join(outputDir, name);
  try {
    await fs.copyFile(capturePath, dest, fs.constants.COPYFILE_EXCL); // fails EEXIST, never overwrites
    await fs.chmod(dest, 0o644); // subject to umask for group/other stripping; explicit chmod ensures no exec bits
    console.log(dest); // single line to stdout — the ONLY stdout write
    process.exitCode = 0; return;
  } catch (e) { if (e.code !== 'EEXIST') throw mapped exit-4 error; /* else retry with fresh rand */ }
}
throw exit-4 'could not allocate a unique output name';
```

Notes:

- `COPYFILE_EXCL` gives the no-overwrite guarantee without a temp file; the spec's "write to temp + link/rename" is one valid implementation — `copyFile+EXCL` from runDir is equivalent and simpler. If implementing temp+link instead, create temp with `fs.open(tmp, 'wx', 0o644)`, `copyFile` into it, `fs.link(tmp, dest)`, `unlink(tmp)`. Either is acceptable; document the chosen one. Key properties: no overwrite, no partial file visible at the final name, retry on collision (10 concurrent runs on the same page must yield 10 distinct files — randomness makes collision ~2^-24 per attempt).
- `chmod 0644` after copy: copy preserves source mode minus umask considerations; explicit chmod normalizes it. Wrap chmod failure as exit 4.
- Any copy/chmod failure other than `EEXIST` → exit 4 (`output directory not writable or write failed`).
- Print the absolute path (`path.resolve`) + newline, exactly once.

### 4.8 Cleanup + signals (acceptance test 7)

- `cleanup()` = if `child` alive: `try kill(-pid, SIGKILL)`; then `await fs.rm(runDir, { recursive: true, force: true })`. Must run on: success, every failure exit, `SIGINT`, `SIGTERM`, `uncaughtException`, `unhandledRejection`.
- Signal handling: `process.on('SIGINT'/'SIGTERM', async () => { await cleanup(); process.kill(process.pid, sig) or process.exit(128+num) })`. Simplest correct pattern: on signal, kill the Electron group, remove runDir, then re-raise with `process.exit(130)` for SIGINT / `143` for SIGTERM (or re-send the signal to self after restoring default handler). Document that the launcher itself must die with a signal-ish status so `Ctrl-C mid-run` doesn't report success, and that no `electron` processes or `htmlshot-*` dirs remain (verify with `pgrep -af electron` and `ls $TMPDIR/htmlshot-*` in tests).
- Guard double-cleanup with a `cleanedUp` flag; make `cleanup` idempotent. Use `process.exitCode` + `process.on('exit')` for sync fallback? `rm` is async — rely on explicit `await cleanup()` before every `process.exit()` call path, plus best-effort sync `fs.rmSync` in the `'exit'` handler as a backstop.

---

## 5. Renderer `src/renderer.js` — detailed design (Phase 3)

Electron main process. Receives everything via argv, writes `capture.png` + `result.json` into `runDir`, then quits. Never writes to stdout (Electron stdout is discarded by the launcher anyway); use `process.stderr` only for debugging (also discarded). The authoritative signal is `result.json`.

### 5.1 Startup sequence

```js
const { app, BrowserWindow } = require('electron');
const args = parseRendererArgs(process.argv); // supports --key=value and --key value
app.disableHardwareAcceleration();           // before ready, per spec
if (args.noSandbox) app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('user-data-dir', path.join(args.runDir, 'profile')); // belt-and-braces with launcher flag
parse + validate numeric args again (defense in depth; invalid → write result.json error + app.exit(5)? renderer has no exit-code contract — it reports via result.json and quits; launcher maps to exit 5)
app.whenReady().then(main).catch(fatal);
await fs.writeFile(readyMarker, ''); // touch immediately after whenReady — launcher uses absence to distinguish exit 6
```

Single-instance: no `requestSingleInstanceLock` needed — each run has a private `--user-data-dir`, so concurrent runs never contend for a profile lock (acceptance test 6). Do not set a shared `userData` path.

### 5.2 Window creation (hidden, viewport-sized)

```js
const win = new BrowserWindow({
  show: false,
  width: args.width, height: args.height,
  useContentSize: true,          // size = page viewport, not window chrome
  backgroundColor: '#FFFFFF',
  offscreen: true,               // per spec; verify in spike — see risks
  webPreferences: {
    nodeIntegration: false,
    contextIsolation: true,
    sandbox: true,
    webSecurity: true,
    preload: undefined,          // no preload
    offscreen: true,             // match window-level flag on versions that need it
  },
});
win.setMenu(null);
```

Spike first (Phase 4 spike, before finalizing): on the pinned Electron, verify `capturePage()` on a `show:false` window returns a non-blank `width×height` image under Xvfb. Known risk (SPEC §8): hidden-window capture can return blank frames. Spike matrix: `{ show:false, offscreen:true }` vs `{ show:false, offscreen:false }` under `xvfb-run -a`, checking PNG dimensions with a PNG parser and non-blankness by sampling pixels. If blank: (a) try `win.showInactive()` + immediate `win.hide()`? No — spec says hidden and never shown; (b) fall back to offscreen `paint` event compositing as the spec anticipates; (c) document the working combination. Do not ship until the spike passes.

### 5.3 Security lockdown (SPEC §5)

```js
win.webContents.session.setPermissionRequestHandler((wc, perm, cb) => cb(false)); // deny all
win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
win.webContents.on('will-navigate', (e, url) => { if (url !== initialFileUrl) e.preventDefault(); });
win.webContents.on('will-redirect', (e, url) => { if (!url.startsWith('file://')) e.preventDefault(); }); // defense in depth
// Neutralize blocking dialogs so they can't stall capture:
win.webContents.executeJavaScript? No — instead:
win.webContents.on('before-input-event', ...)? Not needed.
```

Dialogs: register `dialog.showMessageBox` override? In the renderer main process, `alert/confirm/prompt` from the page surface as synchronous JS dialogs that can block. Standard mitigation: inject `alert = () => {}; confirm = () => true; prompt = () => null` via `webContents.executeJavaScript` on `did-start-loading`? Cleaner: `win.webContents.on('did-finish-load')` is too late for on-load dialogs. Best approach: use `webContents.executeJavaScript` immediately after `loadURL` resolves? Actually the reliable hook is `win.webContents.on('dom-ready', ...)` or a preload — but spec forbids a preload. Alternative: handle at the Electron level — dialogs in the main process do not auto-show for `show:false` windows in recent Electron; verify in spike with `alert.html`. Minimum: watchdog is the backstop (capture timeout → launcher kills). Recommended: attempt early `executeJavaScript('window.alert=()=>{};...')` after `loadURL` is issued (best-effort, wrapped in try/catch), and rely on the launcher watchdog as the guaranteed backstop. Document the outcome of the `alert.html` spike.

Network: not blocked in v1 (CDN assets allowed). Document "treat unknown HTML as untrusted; run in a container".

### 5.4 Load → delay → capture flow

```js
const LOAD_TIMEOUT = 30_000, CAPTURE_TIMEOUT = 10_000;
let settled = false;
const fail = async (kind, message) => { if (!settled) { settled = true; await writeResult({status:'error',kind,message}); app.exit(1); } };

win.webContents.once('did-finish-load', () => {
  clearTimeout(loadTimer);
  const delayMs = Math.round(args.delay * 1000); // delay is float seconds; setTimeout accepts ms
  setTimeout(capture, delayMs);                   // delay starts at did-finish-load per spec §2
});
win.webContents.on('did-fail-load', (e, code, desc, url, isMainFrame) => { if (isMainFrame) fail('load', `failed to load: ${desc} (${code})`); });
win.webContents.on('render-process-gone', (e, details) => fail('renderer-crash', `renderer crashed: ${details.reason}`));
win.on('unresponsive', () => fail('renderer-crash', 'renderer unresponsive'));

loadTimer = setTimeout(() => fail('timeout', 'timed out waiting for page load'), LOAD_TIMEOUT);
await win.loadURL(args.fileUrl);
```

Capture:

```js
async function capture() {
  try {
    const img = await withTimeout(win.webContents.capturePage(), CAPTURE_TIMEOUT, 'timed out capturing page');
    if (img.isEmpty()) return fail('capture', 'capture produced an empty image');
    const png = img.toPNG();
    if (!png.length) return fail('capture', 'capture produced no data');
    await fs.writeFile(capturePath, png);
    await writeResultAtomic({ status: 'ok', file: 'capture.png' }); // write tmp + rename
    app.exit(0);
  } catch (e) { fail('capture', e.message); }
}
```

Notes:

- `did-finish-load` may fire for subframes — use `.once` on the top-level event (Electron's `did-finish-load` on `webContents` fires once when the main frame finishes; guard with a `started` flag regardless).
- Delay conversion: `delay * 1000` ms; cap at 600 000 ms; `0` means capture on next tick after load.
- Viewport guarantee: `useContentSize: true` + `capturePage()` with no rect captures the visible viewport at `width×height`. Assert `img.getSize()` equals requested size in the spike; log mismatch as capture error? Recommended: warn-only (DPR/scale can affect bitmap size on some platforms); acceptance test 1 requires exactly 1280×800 — verify what `capturePage` returns under Xvfb at DPR 1 and fail loudly in the spike if it differs.
- Always `app.exit()` (or `app.quit()`) after writing `result.json` — the launcher also enforces its own timeout, but the renderer must not linger.

`writeResultAtomic`: `writeFile(resultPath + '.tmp', JSON)` then `rename(tmp, resultPath)`.

---

## 6. Timeouts (launcher + renderer agreement)

| Timeout | Value | Enforced by | Failure → |
|---|---|---|---|
| Startup (spawn → `ready` marker) | 15 s | Launcher watchdog slice | Exit 6 (Electron/display never ready) |
| Load (`loadURL` → `did-finish-load`/`did-fail-load`) | 30 s | Renderer `loadTimer` + launcher watchdog | Exit 5 |
| Capture (`capturePage()` call → PNG bytes) | 10 s | Renderer `withTimeout` + launcher watchdog | Exit 5 |
| Overall watchdog | 15+30+10+delay+2 s grace | Launcher kills Electron group (SIGKILL) | Exit 6 if `ready` absent else 5 |

Launcher implementation: a single `setTimeout(deadline)` that group-kills; no need for three separate timers in the launcher since the renderer reports the specific stage in `result.json` when it fails gracefully. The launcher's message on watchdog expiry should include which artifacts exist (`ready` present? `result.json` present?) to aid debugging.

---

## 7. Validation and error-message catalog

All stderr lines: `htmlshot: error: <message>` (lowercase after colon, no stack traces on expected paths; stack only for exit 1 internal errors, still prefixed).

| Condition | Exit | Message (exact wording to implement) |
|---|---|---|
| Unknown option / missing value / extra positional / bad `-d/-W/-H` / `http(s)://` input | 2 | `invalid argument: <detail>` (e.g. `invalid argument: --delay must be a number between 0 and 600`) |
| Input missing / `stat` failure / not a regular file / unreadable | 3 | `input file ...: <no such file \| not a regular file \| not readable>` |
| `mkdir -p` fails / not a dir / not writable / publish write fails / unique-name exhaustion | 4 | `cannot write to output directory ...: <reason>` |
| `did-fail-load`, `render-process-gone`, capture empty/timeout, watchdog with `ready` present, renderer non-zero exit with `ready` present | 5 | `render failed: <detail>` |
| No display + no `xvfb-run`, Electron binary missing / spawn `ENOENT`, watchdog with `ready` absent, renderer early exit with `ready` absent | 6 | `cannot start Electron/display: <detail>` (+ hint `re-run with --no-sandbox if running as root` when spawn stderr suggests sandbox) |
| Unexpected exception in launcher | 1 | `internal error: <message>` |

`--no-sandbox` warning (stderr, not fatal): `htmlshot: warning: --no-sandbox disables the Chromium sandbox`.

---

## 8. Testing plan (maps to SPEC §7 acceptance tests)

Use `node:test` + `node:assert` (no test framework dependency). Tests must run on a machine with Electron + Xvfb installed; skip gracefully with `t.skip()` if neither `DISPLAY` nor `xvfb-run` exists (except the exit-6 test, which requires the *absence* — run it with a scrubbed env).

### Unit tests (`test/unit.test.js`, no Electron needed)

- `sanitizeBase`: spaces/slashes/`#` → `_`; extension stripped (`report.html` → `report`); truncation at 64; empty → `shot`; preserves `[A-Za-z0-9._-]`.
- Arg parser table: valid (`--delay 0.5`, `-d 0`, `-W 1920`), invalid (`--delay -1`, `--delay 601`, `--delay abc`, `--width 0`, `--width 7681`, `--width 1.5`, `--height 4321`, unknown `--foo`, two positionals, zero positionals unless `--help/--version`).
- `http(s)://` rejected as usage error (exit 2), not input error.
- UTC stamp format `/^\d{8}T\d{6}Z$/`; 6-hex suffix `/^[0-9a-f]{6}$/`.
- `file://` URL conversion round-trips paths with spaces and `#`.
- Exit-code constants match SPEC table.

### Integration/acceptance tests (`test/integration.test.js`, spawns `bin/htmlshot.js` via `execFile`, never shell)

For each run assert stdout/stderr/exit/file invariants. Helper `runHtmlshot(args, opts)` captures `stdout` (must be exactly one line on success), `stderr`, `exitCode`, and cleans its output dir.

1. **Default static run** (AT1): `static.html` → exit 0, stdout one absolute line, file exists, PNG magic bytes `89 50 4E 47`, dimensions 1280×800 (parse PNG IHDR at bytes 16–24, no image library needed), stdout has no other lines.
2. **DOM-settle timing** (AT2): `delayed.html` (writes marker text at 2000 ms) with default delay → screenshot differs from `--delay 1` run. Pixel-compare: simplest robust assertion without OCR — render marker as a large solid-color block (e.g. white page → black 400×400 div at 2 s) and check for presence/absence of dark pixels by decoding PNG? Without a PNG decoder, compare file hashes: `hash(default) !== hash(delay1)` is weak but sufficient combined with AT3. Better: use a tiny inline PNG reader (parse IHDR + IDAT via `zlib.inflateSync`, unfilter scanlines — ~60 lines, no dep) to count dark pixels. Decide at implementation: hash-compare minimum, pixel-count preferred.
3. **Delay lower bound** (AT3): instrument by patching `delayed.html`? Timing assertion: `t0 = now()` at spawn, parse `did-finish-load`? Launcher doesn't log load time. Practical assertion: total wall time `≥ delay` (since startup/load only add time, `elapsed ≥ delay` implies `capture-load ≥ delay` is *not* strictly proven but holds because `elapsed = startup+load+delay+capture ≥ delay`). Stronger: temporarily add stderr debug timing? No — keep stdout clean. Recommended: assert `elapsed ≥ N` for `--delay 3` on `static.html` with tolerance `-0.25 s` for timer slop, plus a code review check that the timer starts in `did-finish-load`, not at spawn. Document this reasoning in the test comment.
4. **Output dir** (AT4): missing nested dir (`shots/a/b`) is created, exit 0; unwritable dir (chmod 500, skipped when running as root since root bypasses perms — detect `process.getuid()===0` and instead use a *file* at the output path to force exit 4) → exit 4, stderr matches `/cannot write/`.
5. **Input/usage/env errors** (AT5): missing file → 3; `--delay 9999` → 2; `http://example.com/x.html` → 2; no display + no Xvfb → 6 (run with `env -u DISPLAY -u WAYLAND_DISPLAY` and `PATH` stripped of `xvfb-run` via a temp empty-PATH shim).
6. **Concurrency** (AT6): 10 parallel runs of `static.html` to the same output dir → all exit 0, 10 distinct stdout paths, 10 files exist, no `profile-lock`/`already in use` text on stderr.
7. **SIGINT cleanup** (AT7): spawn a `--delay 20` run, send SIGINT after 2 s, assert launcher exits non-zero promptly, `pgrep -f` shows no remaining `electron ... renderer` processes for that runDir, and `runDir` no longer exists (launcher must log its runDir at debug? Instead: list `os.tmpdir()/htmlshot-*` before/after and assert no new leftovers).
8. **Stdout purity** (AT8): on every success run across the suite, assert `/^[^\n]+\n$/` (exactly one `\n`, absolute path, ends `.png`) and that all Chromium noise went to stderr-or-nowhere (assert stdout has no `Electron|libva|GPU|dbus` strings).

Also: `--width 400 --height 300` produces a 400×300 PNG; `--no-sandbox` prints the warning to stderr but still exits 0; `--help`/`--version` exit 0.

---

## 9. Phased task list with done-criteria

- [x] **P1 — Scaffolding.** `package.json` (+exact electron pin), `bin/`+`src/`+`test/` skeleton, `--help`/`--version` only. Done: `node bin/htmlshot.js --help` exits 0.
- [x] **P2 — Launcher validation.** Arg parser, exit 2/3/4 paths, `sanitizeBase`, stamp/rand naming, unit tests green. Done: all error-path tests pass without Electron.
- [x] **P3 — Renderer skeleton.** `src/renderer.js` loads `file://` URL in hidden window, writes dummy `result.json`+`ready`; launcher spawns direct + xvfb paths, group-kill + cleanup + signals work. Done: `--delay 0 static.html` under Xvfb produces a `capture.png` in runDir (even if blank).
- [x] **P4 — Capture spike (risk burner).** Verify non-blank viewport-sized `capturePage` hidden under Xvfb on pinned Electron; test `alert.html`; decide offscreen/`paint`-fallback; lock window flags. Done: AT1 passes (valid 1280×800 PNG, non-blank on a two-color fixture).
- [x] **P5 — Publish + watchdog.** Atomic `result.json`, `COPYFILE_EXCL` publish loop, `chmod 0644`, full timeout matrix, exit 5/6 mapping, stdout-purity. Done: AT3/AT4-error/AT5/AT8 pass.
- [x] **P6 — Timing + concurrency + signals.** Delay-from-load, 10× parallel, SIGINT cleanup. Done: AT2/AT6/AT7 pass; full suite green both with `DISPLAY` set and under `xvfb-run -a` with display unset.
- [x] **P7 — Packaging + docs.** `npm pack` smoke test, global `npm i -g` install, `README.md` (prereqs, examples, exit-code table, container note), version bump. Done: fresh container `npm install && npx htmlshot page.html` works.

## Implementation notes

- Pinned `electron@44.7.2` exact. Spike: `show:false` + `offscreen:true` captures non-blank viewport PNG under X11 and `xvfb-run -a`.
- `alert/confirm/prompt` neutralized via `file`-protocol interception (no preload, per spec); launcher watchdog is the backstop.
- Launcher strips `WAYLAND_DISPLAY` when `DISPLAY` exists (or under xvfb) to avoid flaky Wayland+Vulkan captures; renderer retries `capturePage` once on Viz errors.
- SIGINT/SIGTERM cleanup is synchronous so it wins the race against the supervision loop.

---

## 10. Risks and mitigations (from SPEC §8)

1. **No native headless on Linux / Xvfb dependency.** Mitigation: ship the `DISPLAY → xvfb-run -a → exit 6` chain as specified; spike `--ozone-platform=headless` only as a follow-up experiment, not in the v1 path.
2. **Blank hidden-window capture.** Mitigation: P4 spike is a release gate; keep the offscreen-`paint` fallback in reserve; fail loudly (`render failed: capture produced an empty image`, exit 5) rather than shipping blank PNGs silently.
3. **Blocking dialogs.** Mitigation: deny-first handlers + best-effort `alert/confirm/prompt` neutralization + launcher watchdog backstop; `alert.html` fixture proves non-stall.
4. **Per-run startup cost 1–2 s.** Accepted for v1; note server mode as v2 in README, do not build it.
5. **Font-dependent rendering.** Mitigation: document fixed-container-image guidance; never bundle fonts in v1.

---

## 11. Explicitly deferred (v2 candidates)

`--full-page`, `--scale`, `--format`, `--json`, `--timeout`, `--wait-for-selector`. The renderer argv parser and launcher validation should be written so new numeric/enum flags slot in without reworking the spawn protocol.

---

## 12. Definition of done

`npm test` green; all 8 SPEC acceptance tests demonstrated (with-display and display-less+Xvfb); `stdout` is exactly one line on success; concurrent + SIGINT tests leave no `electron` processes or `htmlshot-*` tmpdirs; `npm pack` + install in a clean container works with only documented system deps.
