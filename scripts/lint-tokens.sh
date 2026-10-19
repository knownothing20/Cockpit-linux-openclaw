#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

REPORT="${TMPDIR:-/tmp}/cockpit-token-lint-report.md"
node scripts/cockpit-css-audit.js "$REPORT" >/dev/null

FAIL=0
awk -F '|' '
  /^\| [a-zA-Z0-9-]+ / {
    module=$2; gsub(/^ +| +$/, "", module);
    hex=$5+0; font=$6+0; theme=$7+0;
    if (hex != 0 || font != 0 || theme != 0) {
      printf("TOKEN-LINT FAIL %s hex=%d fontPx=%d localTheme=%d\n", module, hex, font, theme);
      bad=1;
    }
  }
  END { exit bad ? 1 : 0 }
' "$REPORT" || FAIL=1

CSS_COUNT="$(find shell-ui -maxdepth 1 -type f -name '*.css' | wc -l | tr -d ' ')"
CSS_LINES="$(wc -l shell-ui/*.css | tail -1 | awk '{print $1}')"
if [ "$CSS_COUNT" -gt 6 ]; then
  echo "TOKEN-LINT FAIL shell-ui css count is $CSS_COUNT, expected <= 6"
  FAIL=1
fi
if [ "$CSS_LINES" -gt 2500 ]; then
  echo "TOKEN-LINT FAIL shell-ui css lines is $CSS_LINES, expected <= 2500"
  FAIL=1
fi

ARCHIVED_PATTERN='cockpit-module-|module-enhancements\.css|unified-animations\.css|cockpit-motion\.css|cockpit-reference-|cockpit-frame-|light-theme-override\.css'
if find shell-ui sub-modules -type f \( -name '*.html' -o -name '*.js' -o -name '*.css' \) \
  -not -path '*/.git/*' -print0 \
  | xargs -0 grep -En "$ARCHIVED_PATTERN" >/tmp/cockpit-token-lint-archived-hits.txt 2>/dev/null; then
  echo "TOKEN-LINT FAIL live files still reference archived CSS:"
  head -20 /tmp/cockpit-token-lint-archived-hits.txt
  FAIL=1
fi

if [ "$FAIL" -ne 0 ]; then
  echo "TOKEN-LINT FAILED"
  exit 1
fi

echo "TOKEN-LINT OK: audit rows clean, shell-ui CSS count=$CSS_COUNT, lines=$CSS_LINES"
