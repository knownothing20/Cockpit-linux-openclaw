#!/bin/bash
set -e
fail() { echo "ERROR: $1"; exit 1; }

N=$(git diff --cached --diff-filter=AM -U0 -- '*.css' '*.js' | grep -E '^\+' | grep -v '^+++' | grep -c '!important' || true)
[ "$N" -gt 0 ] && fail "forbidden new !important: $N (docs/STYLE_CLEANUP.md)"

NEW_CSS=$(git diff --cached --name-only --diff-filter=A | grep -E '\.(css)$' || true)
[ -n "$NEW_CSS" ] && fail "forbidden new CSS files:\n$NEW_CSS"

N=$(git diff --cached --diff-filter=AM -U0 -- '*.js' | grep -E '^\+' | grep -v '^+++' | grep -cE "setProperty\([^)]*['\"]important['\"]" || true)
[ "$N" -gt 0 ] && fail "forbidden new setProperty(..., important): $N"

if [ -f scripts/cockpit-css-audit.js ]; then
  node scripts/cockpit-css-audit.js > /tmp/openclaw-css-audit.log 2>&1 || { cat /tmp/openclaw-css-audit.log; fail "style audit failed"; }
fi

# 任务 3.3：registry 单测 + HTTP 冒烟（shell 未运行时 smoke 自动跳过）
if [ -f scripts/audit-registry.js ]; then
  node scripts/audit-registry.js || fail "registry tests failed"
fi
if [ -f scripts/audit-smoke.js ]; then
  node scripts/audit-smoke.js || fail "smoke tests failed"
fi

echo "pre-commit style guard passed"
