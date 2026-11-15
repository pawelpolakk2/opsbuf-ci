#!/usr/bin/env bash
# Deploys opsbuf CI to the Mac mini: code, the repo you push to, the https name and the LaunchAgents. Safe to run again.
set -euo pipefail

mini=macmini@macmini
app='~/Apps/opsbuf-ci'
repo=$(cd "$(dirname "$0")/.." && pwd)
tls_base="$HOME/.config/opsbuf-ci/tls-base"

run_on_mini() {
  ssh -o BatchMode=yes "$mini" "$1"
}

sync_code() {
  echo "== sync the code"
  rsync -az --delete -e "ssh -o BatchMode=yes" --exclude /data --exclude /repo.git --exclude .git --exclude node_modules --exclude .DS_Store \
    "$repo/" "$mini:Apps/opsbuf-ci/"
}

# one bare repo per project in config.json, repos/<id>.git; the push hook starts the run
create_push_repos() {
  local ids
  ids=$(node -e 'for (const it of require(process.argv[1]).projects) console.log(it.id)' "$repo/config.json")
  # before projects there was one repo.git and one workspace, both of opsbuf-app
  run_on_mini "cd $app; mkdir -p repos data/workspaces; [ -d repo.git ] && mv repo.git repos/opsbuf-app.git || true; [ -d data/workspace ] && mv data/workspace data/workspaces/opsbuf-app || true"
  for id in $ids; do
    echo "== push to $mini:Apps/opsbuf-ci/repos/$id.git"
    run_on_mini "cd $app/repos; [ -d $id.git ] || git init -q --bare -b main $id.git; install -m 755 $app/scripts/post-receive $id.git/hooks/post-receive"
  done
}

# the certificate comes from the local CA in ~/.config/opsbuf-issues/ca (LAN names only); made once
install_certificate() {
  if [[ ! -s "$tls_base/tls/cert.pem" ]]; then
    mkdir -p "$tls_base" && chmod 700 "$tls_base"
    ln -sfn "$HOME/.config/opsbuf-issues/ca" "$tls_base/ca"
    PTX_TLS_DIR="$tls_base" PTX_TLS_NAMES="opsbuf-ci.local localhost" PTX_TLS_ADDRESSES="127.0.0.1 192.168.88.3" \
      bash "$HOME/private-repos/opsbuf-issues/scripts/make-certificate.sh"
  fi
  echo "== copy the certificate for nginx"
  run_on_mini "mkdir -p ~/Apps/nginx/tls/opsbuf-ci.local"
  scp -q -o BatchMode=yes "$tls_base/tls/cert.pem" "$tls_base/tls/key.pem" "$mini:Apps/nginx/tls/opsbuf-ci.local/"
  run_on_mini "chmod 600 ~/Apps/nginx/tls/opsbuf-ci.local/key.pem"
}

add_nginx_block() {
  echo "== nginx: opsbuf-ci.local on 443"
  run_on_mini "grep -q 'server_name opsbuf-ci.local;' ~/Apps/nginx/nginx.conf || { cp ~/Apps/nginx/nginx.conf ~/Apps/nginx/nginx.conf.before-ci; perl -0pi -e 's/\}\s*\z//' ~/Apps/nginx/nginx.conf; cat $app/scripts/nginx-block.conf >> ~/Apps/nginx/nginx.conf; echo '}' >> ~/Apps/nginx/nginx.conf; }"
  run_on_mini "bash ~/Repos/certs/invalidate-nginx.sh"
}

restart_launch_agents() {
  echo "== (re)start the LaunchAgents"
  run_on_mini "set -e; d=gui/\$(id -u); for label in pl.opsbuf.ci pl.opsbuf.ci.name; do
    cp $app/scripts/\$label.plist ~/Library/LaunchAgents/
    launchctl bootout \$d/\$label 2> /dev/null && sleep 1 || true
    launchctl bootstrap \$d ~/Library/LaunchAgents/\$label.plist
  done; sleep 1; curl -fsS http://127.0.0.1:7460/api/health"
}

sync_code
create_push_repos
install_certificate
add_nginx_block
restart_launch_agents
echo
echo "== done: https://opsbuf-ci.local · in a project: git remote add ci $mini:Apps/opsbuf-ci/repos/<project>.git && git push ci main"
