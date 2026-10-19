#!/bin/sh
set -eu
root=$(git rev-parse --show-toplevel)
current=$(git config --get core.hooksPath || true)
if [ -n "$current" ] && [ "$current" != '.githooks' ]; then
  echo 'An existing hooksPath is configured; review it before installing.' >&2
  exit 1
fi
chmod +x "$root/.githooks/pre-push"
git config --local core.hooksPath .githooks
echo 'Privacy pre-push hook installed for this clone.'
