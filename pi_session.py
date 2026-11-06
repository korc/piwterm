#!/usr/bin/env python3
"""Python supervisor for the pi web-terminal session on a virtual pty.

Spawns pi inside a virtual pty (pty.openpty), forwards browser<->pty traffic through the
exec-bridge fds, handles resize signals (SIGWINCH) by applying the new window size to the
pty and propagating it to pi, and respawns pi when it exits.
"""

import fcntl
import os
import pty
import re
import signal
import select
import struct
import sys
import termios
import time

ROWS = int(os.environ.get("PIWTERM_ROWS", "24"))
COLS = int(os.environ.get("PIWTERM_COLS", "80"))

master_fd = None
child_pid = None


def debug(msg: str) -> None:
    sys.stderr.write(f"[pi_session] {msg}\n")
    sys.stderr.flush()


def set_winsize(fd: int, rows: int, cols: int) -> None:
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))


def get_winsize(fd: int):
    data = b"\x00" * 8
    fcntl.ioctl(fd, termios.TIOCGWINSZ, data)
    rows, cols = struct.unpack("HH", data[:4])
    return rows, cols


def apply_resize(fd: int, rows: int, cols: int) -> None:
    set_winsize(fd, rows, cols)
    debug(f"resize applied: rows={rows} cols={cols}")


def on_winch(signum, frame):
    rows, cols = get_winsize(master_fd)
    apply_resize(master_fd, rows, cols)
    debug(f"resize signal received; applied winsize rows={rows} cols={cols}")


def run_session() -> int:
    """Run one pi session on the pty. Returns 0 for clean exit, 1 to respawn."""
    global master_fd, child_pid

    master_fd, slave_fd = pty.openpty()
    child_pid = os.fork()
    if child_pid == 0:
        # child: become pi with the pty slave as controlling terminal
        os.setsid()
        os.dup2(slave_fd, 0)
        os.dup2(slave_fd, 1)
        os.dup2(slave_fd, 2)
        if slave_fd > 2:
            os.close(slave_fd)
        if master_fd > 2:
            os.close(master_fd)
        os.execvp("pi", ["pi"])
        os._exit(127)
    os.close(slave_fd)

    rows, cols = get_winsize(master_fd)
    apply_resize(master_fd, rows, cols)
    debug(f"pi spawned pid={child_pid} on pty master={master_fd} initial size={rows}x{cols}")

    signal.signal(signal.SIGWINCH, on_winch)

    clean = False
    while True:
        rlist, _, _ = select.select([0, master_fd], [], [], 0.2)
        if 0 in rlist:
            try:
                data = os.read(0, 4096)
            except OSError:
                clean = True
                break
            if not data:
                clean = True
                break
            # detect xterm window-resize sequence: ESC[8;rows;colst
            text = data.decode(errors="replace")
            m = re.search(r"\x1b\[8;(\d+);(\d+)t", text)
            if m:
                rows = int(m.group(1))
                cols = int(m.group(2))
                apply_resize(master_fd, rows, cols)
                debug(f"resize applied from browser: rows={rows} cols={cols}")
            os.write(master_fd, data)
        if master_fd in rlist:
            try:
                data = os.read(master_fd, 4096)
            except OSError:
                clean = True
                break
            if not data:
                clean = True
                break
            os.write(1, data)

        try:
            wpid, status = os.waitpid(child_pid, os.WNOHANG)
            if wpid == child_pid:
                if os.WIFSIGNALED(status):
                    debug(f"pi exited via signal status={status}")
                    clean = True
                else:
                    debug(f"pi exited normally status={status}")
                break
        except ChildProcessError:
            clean = True
            break

    if clean:
        # clean exit: disconnect-driven EOF or signaled child death -> stop
        return 0
    # child died normally -> respawn
    return 1


def main() -> int:
    while True:
        rc = run_session()
        if rc == 0:
            # clean exit -> break out so exec child can exit cleanly
            break
        time.sleep(1)


if __name__ == "__main__":
    main()
    sys.exit(0)
