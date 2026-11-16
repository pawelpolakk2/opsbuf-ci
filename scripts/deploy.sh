#!/usr/bin/env bash
# Deploys the CI to the Mac mini: code, the repos you push to, the https name and the LaunchAgent. Safe to run again.
# After the first deploy the CI releases itself: a green build of main runs scripts/release.sh.
set -euo pipefail

mini=macmini@macmini
app='~/Apps/opsbuf-ci'
repo=$(cd "$(dirname "$0")/.." && pwd)

run_on_mini() {
  ssh -o BatchMode=yes "$mini" "$1"
}

sync_code() {
  echo "== sync the code"
  rsync -az --delete -e "ssh -o BatchMode=yes" --exclude /data --exclude /repos --exclude /repo.git --exclude .git --exclude node_modules --exclude .DS_Store \
    "$repo/" "$mini:Apps/opsbuf-ci/"
}

# one bare repo per project in config.json, repos/<id>.git; the push hook starts the run
create_push_repos() {
  local ids
  ids=$(node -e 'for (const it of require(process.argv[1]).projects) console.log(it.id)' "$repo/config.json")
  for id in $ids; do
    echo "== push to $mini:Apps/opsbuf-ci/repos/$id.git"
    run_on_mini "mkdir -p $app/repos; cd $app/repos; [ -d $id.git ] || git init -q --bare -b main $id.git; install -m 755 $app/scripts/post-receive $id.git/hooks/post-receive"
  done
}

# a restart ends the running build, so it waits until the CI has nothing to do (at most 30 min)
wait_until_idle() {
  for _ in $(seq 1 180); do
    run_on_mini "curl -fsS http://127.0.0.1:7460/api/health 2> /dev/null" | grep -qv '"isBusy":true' && return 0
    echo "== the CI is building; waiting before the restart"
    sleep 10
  done
}

restart_ci() {
  wait_until_idle
  echo "== (re)start the LaunchAgent pl.opsbuf.ci"
  run_on_mini "set -e; d=gui/\$(id -u)
    cp $app/scripts/pl.opsbuf.ci.plist ~/Library/LaunchAgents/
    launchctl bootout \$d/pl.opsbuf.ci 2> /dev/null && sleep 1 || true
    launchctl bootstrap \$d ~/Library/LaunchAgents/pl.opsbuf.ci.plist
    sleep 1; curl -fsS http://127.0.0.1:7460/api/health"
}

sync_code
create_push_repos
bash "$repo/scripts/add-site.sh" ci.local 7460 "CI" pl.opsbuf.ci.name
restart_ci
echo
echo "== done: https://ci.local · in a project: git remote set-url --add --push origin $mini:Apps/opsbuf-ci/repos/<project>.git"
