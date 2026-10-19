#!/bin/sh
# Keep the persistent instance owned by its single systemd user service.
set -eu
exec systemctl --user start openclaw-cockpit-shell.service
