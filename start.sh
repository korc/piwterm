#!/bin/bash
# Start the piwterm web terminal server (onefile-websrv).

set -eux

exec env TERM=xterm-256color onefile-websrv -map /=file:"$(dirname "$0")" -map "/terminal/=websocket:{type=binary}exec:$(dirname "$0")/pi_session.py" "$@"
