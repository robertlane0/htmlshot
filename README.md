# htmlshot

Render a local HTML file in headless Electron and save a PNG screenshot.

```
htmlshot [options] <file>
```

## Install

Requires Node >= 20 and Electron's Linux runtime libs. On Debian/Ubuntu:

```
sudo apt install libgtk-3-0 libnss3 libgbm1 libasound2 xvfb
```

`xvfb` is only needed when no display is available (`DISPLAY`/`WAYLAND_DISPLAY` unset).

```
npm install -g htmlshot
```

## Examples

```
$ htmlshot report.html
/tmp/report-20261013T142501Z-a3f9c1.png

$ htmlshot --delay 5 --output-dir ~/shots --width 1920 --height 1080 page.html
/home/user/shots/page-20261013T142533Z-07be42.png
```

`~/shots` works because the shell expands `~` before Node sees it.

## Options

| Option | Default | Description |
|---|---|---|
| `<file>` | required | Path to a local HTML document |
| `-d, --delay <seconds>` | `3` | Seconds to wait after load (0-600) |
| `-o, --output-dir <dir>` | `/tmp` | Screenshot directory, created recursively |
| `-W, --width <px>` | `1280` | Viewport width 1-7680 |
| `-H, --height <px>` | `800` | Viewport height 1-4320 |
| `--no-sandbox` | off | Disable Chromium sandbox (needed as root) |
| `-h, --help`, `-V, --version` | | Usage and version |

stdout is exactly one line on success: the absolute PNG path. Diagnostics go to stderr as `htmlshot: error: <message>`.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | Success |
| 1 | Internal error |
| 2 | Invalid usage or option value |
| 3 | Input file missing, unreadable, or not a regular file |
| 4 | Output directory not writable or write failed |
| 5 | Render failure |
| 6 | Electron or display backend could not start |

## Notes

- Delay starts at `did-finish-load`. Capture is the visible viewport, not full page.
- Treat unknown HTML as untrusted; run in a container. Network is not blocked so CDN assets load.
- Screenshots depend on installed system fonts; use a fixed container image for reproducible output.
- Per-run Electron startup costs 1-2 s; a server mode is a possible v2.
