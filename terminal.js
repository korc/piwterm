/*
 * xterm.js based terminal client for onefile-websrv.
 *
 * Opens a websocket to the onefile-websrv server (mapped to an `exec:` handler
 * there) and bridges browser <-> terminal <-> websocket:
 *   - user input (xterm.js `onData`) is sent to the server over the websocket
 *   - server output (websocket messages) is written to the xterm.js terminal
 */
(function () {
  'use strict';

  var WS_PATH = window.TERMINAL_WS_PATH || '/terminal/';

  var term = new Terminal({
    cols: Math.max(20, Math.floor((window.innerWidth || 1280) / 8)),
    rows: Math.max(10, Math.floor((window.innerHeight || 800) / 20)),
    fontSize: 14,
    fontFamily: 'Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
    theme: {
      background: '#000000',
      foreground: '#f0f0f0',
      cursor: '#f0f0f0',
      selectionBackground: '#264f78',
    },
    scrollOnUserInput: true,
    scrollback: 10000,
    cursorBlink: true,
  });
  // debug/testing handle for browser automation (playwright)
  window.__piwtermTerm = term;

  var container = document.getElementById('terminal');
  if (!container) {
    container = document.body;
  }
  term.open(container);
  // move keyboard focus to the pi terminal when the page opens
  term.focus();

  var lastSentSize = '';
  var termCols = 80;
  var termRows = 24;

  function sendResizeToBackend(rows, cols) {
    // tell the backend terminal (pty via exec bridge) to resize the pi TUI:
    // xterm window operation: CSI 8 ; height ; width t
    var seq = '\x1b[8;' + rows + ';' + cols + 't';
    if (ws && ws.readyState === WebSocket.OPEN) {
      try {
        // send as binary frame (byte-oriented exec bridge; avoids text-frame
        // UTF-8 validation failures / close 1002 on the browser->server path)
        ws.send(new Uint8Array(new TextEncoder().encode(seq)));
      } catch (e) {
        // ignore send errors; connection state will surface via events
      }
    }
  }

  function sizeTerminal() {
    // size the xterm grid to the maximum available browser screen space
    var cols = Math.max(20, Math.floor((window.innerWidth || 1280) / 8));
    var rows = Math.max(10, Math.floor((window.innerHeight || 800) / 20));
    termCols = cols;
    termRows = rows;
    term.resize(cols, rows);
    var sizeKey = rows + 'x' + cols;
    if (sizeKey !== lastSentSize) {
      lastSentSize = sizeKey;
      sendResizeToBackend(rows, cols);
    }
  }
  sizeTerminal();
  window.addEventListener('resize', sizeTerminal);

  // keep the viewport scrolled to the bottom on every processed write
  term.onWriteParsed(function () {
    term.scrollToBottom();
  });

  var ws = null;

  function getWebSocketUrl() {
    var proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
    return proto + '://' + window.location.host + WS_PATH;
  }

  function sendToServer(data) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      try {
        // send as binary frame: byte-oriented exec bridge; avoids text-frame
        // UTF-8 validation failures (close 1002) on the browser->server path
        ws.send(new Uint8Array(new TextEncoder().encode(String(data))));
      } catch (e) {
        // ignore send errors; connection state will surface via events
      }
    }
  }

  // xterm.js emits the user input data here (e.g. "a", "hello", "\r" for Enter)
  term.onData(function (data) {
    var str = String(data);
    // normalize CRLF sequences to a bare carriage return (Enter) for the
    // backend; do NOT convert "\r" -> "\n", pi expects "\r" for Enter
    var normalized = str.replace(/\r\n/g, '\r');
    sendToServer(normalized);
  });

  function writeToTerminal(data) {
    if (data === null || data === undefined) {
      return;
    }
    if (typeof data === 'string') {
      term.write(data);
    } else if (data instanceof ArrayBuffer) {
      term.write(new TextDecoder('utf-8').decode(data));
    } else if (typeof Blob !== 'undefined' && data instanceof Blob) {
      data.arrayBuffer().then(
        function (ab) { term.write(new TextDecoder('utf-8').decode(ab)); },
        function () { /* ignore blob read errors */ }
      );
    } else {
      term.write(String(data));
    }
  }

  function connect() {
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
      return;
    }
    ws = new WebSocket(getWebSocketUrl());
    ws.binaryType = 'arraybuffer';
    ws.onopen = function () {
      // nothing to send on open; sync the backend terminal size to the
      // current browser window size (maximize terminal to window area)
      sendResizeToBackend(termRows, termCols);
    };
    ws.onmessage = function (ev) {
      writeToTerminal(ev.data);
    };
    ws.onclose = function (ev) {
      term.write('\r\n[terminal closed: code=' + ev.code + ' reason=' + ev.reason + ']\r\n');
    };
    ws.onerror = function () {
      term.write('\r\n[terminal websocket error]\r\n');
    };
  }

  if (document.readyState === 'complete' || document.readyState === 'interactive') {
    connect();
  } else {
    window.addEventListener('load', connect);
  }
})();
