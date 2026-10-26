#!/bin/sh
# Manual fnOS Docker entry; keep start-shell.sh/systemd unchanged for Debian.
set -eu
launch_repo=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd -P)
repo=${COCKPIT_HOST_ROOT:-"$launch_repo"}
compose="$repo/deploy/compose.fnos.yaml"
action=${1:-status}
fail() { echo "$*" >&2; exit 1; }
owned_container() {
  test -n "${COCKPIT_CONTAINER_ROOT:-}" || { echo "Set explicit COCKPIT_CONTAINER_ROOT for identity validation" >&2; return 1; }
  owned_id=
  owned_state=
  candidate=$(docker ps --all --no-trunc --filter 'name=^/cockpit$' --format '{{.ID}}') || return 1
  test -n "$candidate" || return 0
  test "$(printf '%s\n' "$candidate" | wc -l)" -eq 1 || { echo 'Ambiguous cockpit IDs' >&2; return 1; }
  printf '%s\n' "$candidate" | grep -Eq '^[a-f0-9]{64}$' || { echo 'Ambiguous cockpit ID' >&2; return 1; }
  metadata=$(docker inspect --format '{{.Id}}|{{.Name}}|{{index .Config.Labels "com.docker.compose.project"}}|{{index .Config.Labels "com.docker.compose.service"}}|{{index .Config.Labels "com.docker.compose.project.working_dir"}}|{{index .Config.Labels "com.docker.compose.project.config_files"}}|{{.Config.WorkingDir}}|{{.State.Status}}' "$candidate") || return 1
  IFS='|' read -r inspected name project service project_dir files workdir state <<EOF
$metadata
EOF
  test "$inspected" = "$candidate" &&
  test "$name" = /cockpit &&
  test "$project" = leon-cockpit-7001 &&
  test "$service" = cockpit &&
  test "$project_dir" = "$repo/deploy" &&
  test "$files" = "$compose" &&
  test "$workdir" = "$COCKPIT_CONTAINER_ROOT" ||
    { echo 'Cockpit identity/ownership mismatch; refusing action' >&2; return 1; }
  case "$state" in created|exited|running|paused|restarting|dead) ;; *) echo 'Unknown container state' >&2; return 1;; esac
  owned_id=$inspected
  owned_state=$state
}
# Emergency control does not read runtime.env, paths.fnos.env or the data disk.
case "$action" in
  stop|status)
    owned_container || exit 1
    test -n "$owned_id" || { echo 'cockpit absent'; exit 0; }
    if test "$action" = stop; then
      docker stop --time 20 "$owned_id"
    else
      docker inspect --format '{{.Id}} {{.State.Status}} exit={{.State.ExitCode}}' "$owned_id"
    fi
    exit 0
    ;;
  prepare|start|check) ;;
  *) echo 'Usage: sh deploy/fnos.sh prepare|check|start|stop|status' >&2; exit 2 ;;
esac
test "$repo" = "$launch_repo" || fail 'Startup must use the canonical launcher'
env_file=${COCKPIT_ENV_FILE:-"$repo/deploy/paths.fnos.env"}
test -f "$env_file" || fail 'Prepare private paths.fnos.env from its example first'
set -a
. "$env_file"
set +a
test -n "${COCKPIT_DISK_ROOT:-}" && test -n "${COCKPIT_STAGE:-}" && test -n "${COCKPIT_WORKSPACE_ROOT:-}" && test -n "${COCKPIT_CONTAINER_ROOT:-}" && test -n "${COCKPIT_BIND_ADDR:-}" || fail 'Explicit disk/stage mapping required'
mountpoint -q "$COCKPIT_DISK_ROOT" || fail 'Original data disk is not mounted'
test "$(realpath -- "$COCKPIT_DISK_ROOT")" = "$COCKPIT_DISK_ROOT" || fail 'Linked disk root rejected'
test "$(realpath -- "$COCKPIT_WORKSPACE_ROOT")" = "$COCKPIT_WORKSPACE_ROOT" || fail "Linked workspace rejected"
case "$COCKPIT_WORKSPACE_ROOT/" in "$COCKPIT_DISK_ROOT/"*) ;; *) fail "Workspace outside original disk";; esac
test "$repo" = "$COCKPIT_WORKSPACE_ROOT/openclaw-cockpit-shell" || fail 'Unexpected project root'
stage=$(realpath -m -- "$COCKPIT_STAGE")
expected="$COCKPIT_WORKSPACE_ROOT/.dev-environments/20261019/migration-additions/cockpit-7001"
test "$stage" = "$expected" && test ! -L "$COCKPIT_STAGE" || fail 'Unexpected or linked staging path'
test -f "$repo/node_modules/express/package.json" && test -f "$repo/package-lock.json" || fail 'Existing locked pure-JS dependencies missing'
owned_container || exit 1
docker image inspect sha256:bbc51c187ec813fd7c6a49afd22c15efdfe969b8c3a9a9cd49193c8a03908984 >/dev/null
if test "$action" = prepare; then
  mkdir -p "$stage"
  chmod 700 "$stage"
  snapshot=$(mktemp -d "$stage/app.XXXXXXXX")
  # Avoid a tar pipeline masking a failed Git/packing command.
  (cd "$repo" && git ls-files -z -- server.js registry shell-ui modules sub-modules package.json package-lock.json config.example.json deploy/local-config-manifest.json) > "$snapshot/source-list"
  test -s "$snapshot/source-list" || fail 'Empty source manifest'
  tar -C "$repo" --null -T "$snapshot/source-list" -cf "$snapshot/source.tar"
  tar -xf "$snapshot/source.tar" -C "$snapshot"
  rm -- "$snapshot/source-list" "$snapshot/source.tar"
  mkdir -p "$snapshot/deploy" "$snapshot/node_modules"
  cp "$repo/deploy/fnos-runtime.js" "$snapshot/deploy/fnos-runtime.js"
  cp "$repo/shell-ui/runtime-notice.js" "$snapshot/shell-ui/runtime-notice.js"
  cp "$snapshot/config.example.json" "$snapshot/config.json"
  for example in "$snapshot"/sub-modules/*/config.example.json; do
    test -f "$example" || continue
    cp "$example" "$(dirname "$example")/config.json"
  done
  # Single-quoted Compose values preserve spaces and suppress dollar interpolation.
  printf "COCKPIT_SOURCE='%s'\nCOCKPIT_DEPENDENCIES='%s'\n" "$snapshot" "$repo/node_modules" > "$stage/runtime.env"
  chmod 600 "$stage/runtime.env"
  sha256sum "$repo/package-lock.json" > "$stage/dependency-lock.sha256"
fi
test -f "$stage/runtime.env" && test -f "$stage/dependency-lock.sha256" || fail 'Reviewed prepare receipt missing'
sha256sum --check --status "$stage/dependency-lock.sha256"
docker compose --env-file "$stage/runtime.env" -f "$compose" -p leon-cockpit-7001 config --quiet
if test "$action" = start; then
  available=$(awk '/^MemAvailable:/ {print $2}' /proc/meminfo)
  test "$available" -ge 2097152 || fail 'Insufficient memory: preserve 1.5GiB after 512MiB cap'
  owned_container || exit 1
  docker compose --env-file "$stage/runtime.env" -f "$compose" -p leon-cockpit-7001 up -d --no-build --pull never
fi
