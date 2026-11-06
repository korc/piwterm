# piwterm — pi web terminal

A web-based terminal frontend for the **pi** coding agent. It serves an interactive
pi terminal (TUI) through the browser: the browser renders output with
[xterm.js](https://xtermjs.org/) and forwards keystrokes over a WebSocket → exec-bridge →
pty pipeline to a backend that runs **pi**.

## What it does

- Opens a browser tab hosting a full xterm.js terminal.
- Forwards all keystrokes to a backend process running **pi** on a virtual pty.
- Renders pi's terminal output back into the xterm grid (with scrollback).
- Keeps the backend terminal sized to the available browser window.

## Architecture

```
Browser (xterm.js) --WebSocket (binary frames)--> onefile-websrv --exec--> pi_session.py --pty--> pi (TUI)
```

### Components

| File | Role |
| --- | --- |
| `index.html` | Page shell; loads xterm assets and `terminal.js` |
| `xterm.js`, `xterm.css` | xterm.js library (terminal renderer) |
| `terminal.js` | Browser client: WebSocket connect, input send, output write, resize, focus |
| `start.sh` | Launches `onefile-websrv` with static + exec/websocket maps |
| `pi_session.py` | Python supervisor: owns the pty, forwards input/output, handles resizes, respawns pi |

### Data flow

1. Browser opens a WebSocket to `/terminal/`, mapped by `onefile-websrv` to the
   exec handler → `pi_session.py`.
2. User input via xterm.js `onData` is normalized (CRLF → CR; Enter is sent as `\r`)
   and sent over the WebSocket as a **binary frame** (`Uint8Array`).
3. The supervisor reads from its stdin fd and the pty master, forwards bytes between
   them, and writes pty output to its stdout (which is delivered to the browser).
4. Resizes: the frontend sends the xterm.js window-resize sequence
   `ESC[8;{rows};{cols}t` as a binary frame on connect and on window resize; the
   supervisor also handles `SIGWINCH` by applying the new winsize via `TIOCSWINSZ`.

### WebSocket protocol

- Browser → server input and resize sequences are sent as **binary frames**
  (`ws.binaryType = 'arraybuffer'`, sent via `Uint8Array`/`TextEncoder`). This avoids
  the gorilla/websocket text-frame UTF-8 validation that caused close code **1002**
  ("Invalid UTF-8 in text frame") and subsequent session termination.
- Server → browser output frames are text frames; the client handles `string`,
  `ArrayBuffer`, and `Blob` payloads.

### Input details

- `terminal.js` `onData` normalizes CRLF → CR and deliberately does **not** convert
  `\r` → `\n`; pi expects `\r` for Enter.

### Resize handling

- Frontend sizes the xterm grid from `window.innerWidth`/`innerHeight` and pushes the
  new size to the backend via the xterm window-op sequence `CSI 8;{rows};{cols}t`
  (sent on load, on window resize, and on connect).
- Backend applies the resize to the pty (`TIOCSWINSZ`) and propagates it to pi
  (`SIGWINCH` handling in the supervisor).

### Session lifecycle

- Each new WebSocket connection spawns a fresh pi session via the supervisor.
- On disconnect, the supervisor tears the session down cleanly (no stray processes).
- If pi exits normally, the supervisor respawns it; clean exits break the loop so the
  exec child can exit and pipes are cleaned up.

## Prerequisites

- `onefile-websrv` — get from https://github.com/korc/onefile-websrv
- `pi` - get from https://github.com/earendil-works/pi
- Linux with `python3` (with pty support), and a TTY-capable environment

## Quick start

```sh
./start.sh
```

The server starts and serves the static frontend plus the WebSocket exec bridge.
Open the served URL in a browser — the terminal connects, spawns pi, and is ready.

## Configuration

- `PIWTERM_ROWS` / `PIWTERM_COLS` — environment variables read by the supervisor
  (`pi_session.py`) for the initial pty size (defaults: `24` / `80`).
