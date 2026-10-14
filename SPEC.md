# htmlshot: Design Specification

*Draft 0.1 · October 13, 2026*

## 1. Purpose and scope

`htmlshot` is a Linux command-line tool that renders a local HTML file in a headless Electron instance, waits a configurable number of seconds, saves a PNG screenshot to a configurable directory (default `/tmp`), and prints the screenshot's absolute path to stdout.

**Goals:** one command, one file in, one path out; script-friendly (clean stdout, meaningful exit codes); safe to run in parallel; works on servers with no desktop session.

**Non-goals (v1):** remote URLs, full-page or element screenshots, multiple documents per run, formats other than PNG, a long-running server mode.

## 2. Assumptions

- The delay starts when the page finishes loading (`did-finish-load`), not when the process starts, so Electron startup time never eats into the settle time.
- The screenshot captures the visible viewport (default 1280×800), not the full scrollable page.
- Input is a readable local file; `http(s)://` arguments are rejected.
- Target is x86_64 or arm64 Linux, with a currently supported Node.js LTS for the launcher.

## 3. Command-line interface

```
htmlshot [options] <file>
```

| Option | Default | Description |
|---|---|---|
| `<file>` | required | Path to a local HTML document (relative or absolute). |
| `-d, --delay <seconds>` | `3` | Seconds to wait after load before capturing. Decimals allowed; range 0 to 600. |
| `-o, --output-dir <dir>` | `/tmp` | Directory for the screenshot. Created recursively if missing. |
| `-W, --width <px>` | `1280` | Viewport width, 1 to 7680. |
| `-H, --height <px>` | `800` | Viewport height, 1 to 4320. |
| `--no-sandbox` | off | Disables the Chromium sandbox. Needed when running as root (e.g. most containers). Never applied implicitly. |
| `-h, --help`, `-V, --version` | | Usage and version. |

Examples:

```
$ htmlshot report.html
/tmp/report-20261013T142501Z-a3f9c1.png

$ htmlshot --delay 5 --output-dir ~/shots --width 1920 --height 1080 page.html
/home/user/shots/page-20261013T142533Z-07be42.png
```

### Output contract

- **stdout:** exactly one line on success, the absolute path of the PNG followed by a newline. Nothing else is ever written to stdout; Chromium's own logging is captured and discarded.
- **stderr:** warnings and errors, formatted as `htmlshot: error: <message>`.
- **Filename:** `<name>-<UTC timestamp>-<6 hex>.png`, where `<name>` is the input's base name without extension, sanitized to `[A-Za-z0-9._-]` and truncated to 64 characters. Existing files are never overwritten.

### Exit codes

| Code | Meaning |
|---|---|
| 0 | Success |
| 1 | Unexpected internal error |
| 2 | Invalid usage or option value |
| 3 | Input file missing, unreadable, or not a regular file |
| 4 | Output directory not creatable or writable, or write failed |
| 5 | Render failure: load error, renderer crash, or timeout |
| 6 | Environment failure: Electron or a display backend could not start |

## 4. Architecture

Two processes, split so that policy lives outside Electron.

**Launcher** (`bin/htmlshot.js`, runs under system Node): parses and validates arguments, resolves the input path with `realpath`, creates a private run directory (`mkdtemp`), chooses a display backend, spawns Electron with an argv array (never a shell), supervises it with a watchdog, then names and publishes the final PNG and prints its path. It always removes the run directory on exit and on SIGINT/SIGTERM, killing the Electron process group first.

**Renderer** (`src/renderer.js`, the Electron main process): renders and captures only. It receives all inputs by argv, never touches the output directory, writes the raw PNG and a small `result.json` into the run directory, then quits. This split keeps stdout clean, lets the launcher enforce hard timeouts, and puts display setup where it has to be: before Electron starts.

### Execution flow

1. The launcher validates arguments and the input file (exit 2 or 3 on failure) and checks the output directory is writable (exit 4).
2. It selects a display backend (below) and spawns Electron with `--user-data-dir=<run dir>/profile`, so concurrent runs never share or lock a profile.
3. The renderer disables hardware acceleration, creates a hidden `BrowserWindow` (`show: false`, `useContentSize`, white background, offscreen rendering enabled) at the requested size, and loads the `file://` URL.
4. On `did-finish-load` it starts the delay timer. A main-frame `did-fail-load` or a `render-process-gone` ends the run with a render error (exit 5).
5. When the timer fires it calls `webContents.capturePage()` and writes the PNG to the run directory.
6. The launcher copies the PNG into the output directory under a collision-safe name (write to a temporary name in the same directory, publish with a no-overwrite link or rename, retry with a new suffix on collision), prints the path, cleans up, and exits 0.

### Display backend

Electron on Linux needs a display connection even when no window is visible. The launcher tries, in order:

1. `DISPLAY` or `WAYLAND_DISPLAY` is set: use it. The window is hidden and never shown.
2. Otherwise, if `xvfb-run` is on `PATH`: run Electron under a private virtual screen (`xvfb-run -a`).
3. Otherwise exit 6 with a message naming the missing dependency.

### Timeouts

Fixed in v1: startup 15 s, load 30 s, capture 10 s. The launcher's overall watchdog is the sum of these plus the delay. On expiry it sends SIGKILL to the Electron process group and exits 5 (or 6 if Electron never reached its ready state).

## 5. Security

Rendering HTML executes its scripts, so the renderer is locked down by default:

- `nodeIntegration: false`, `contextIsolation: true`, `sandbox: true`, `webSecurity` on, and no preload script.
- Navigation away from the initial file URL is blocked (`will-navigate`), `window.open` is denied, and all permission requests are denied.
- Network access is not blocked in v1, since pages commonly load CDN assets. Treat unknown HTML as untrusted code and run it in a container.
- The Chromium sandbox is disabled only by an explicit `--no-sandbox`, which prints a warning to stderr.
- Output files are created with mode 0644 (subject to umask) and never overwrite existing files. Arguments are never interpolated into a shell.

## 6. Packaging and requirements

- Distributed as an npm package with a `bin` entry; `electron` is an exact-version pinned dependency.
- Requires Electron's standard Linux runtime libraries (GTK 3, NSS, GBM, ALSA). Xvfb is needed only on machines without a display.
- Output depends on installed system fonts, so use a fixed container image when screenshots must be reproducible.

## 7. Acceptance tests

1. A default run on a static page prints one absolute path; the file exists and is a valid 1280×800 PNG.
2. A page that edits its DOM at 2 s shows the change at the default delay but not with `--delay 1`.
3. With `--delay N`, capture happens at least N seconds after load.
4. `-o` pointing at a missing directory creates it; pointing at an unwritable one exits 4.
5. A missing input exits 3, a bad option value exits 2, and no display plus no Xvfb exits 6.
6. Ten concurrent runs on the same page produce ten distinct files and no profile-lock errors.
7. SIGINT mid-run leaves no Electron processes or run directories behind.
8. On every successful run, stdout contains exactly one line.

## 8. Risks and open questions

- **No native headless mode in Electron on Linux.** Xvfb is the dependable path. Evaluate Chromium's `--ozone-platform=headless` on the pinned Electron version to drop that dependency.
- **Hidden-window capture can return blank frames.** Verify `capturePage` on the pinned version (including its stay-hidden and stay-awake options) and fall back to the offscreen `paint` event if needed.
- **Blocking dialogs.** `alert`, `confirm`, and `prompt` must not stall the capture; the renderer should neutralize them, with the watchdog as backstop.
- **Per-call startup cost** (roughly 1 to 2 s) makes the tool a poor fit for high-throughput batch use; a server mode is a possible v2.
- **Candidate v2 options:** `--full-page`, `--scale`, `--format`, `--json`, `--timeout`, `--wait-for-selector`.
