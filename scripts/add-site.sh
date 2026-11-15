#!/usr/bin/env bash
# Puts an app of the Mac mini behind https://<host>: a certificate from the local CA (LAN names only), an nginx block
# on 443 and a Bonjour name. Safe to run again.
# Usage: scripts/add-site.sh <host> <port> <service name> <LaunchAgent label>
#   e.g. scripts/add-site.sh opsbuf.local 7480 "opsbuf web" pl.opsbuf.web.name
set -euo pipefail
[[ $# -eq 4 ]] || { echo "Usage: scripts/add-site.sh <host> <port> <service name> <LaunchAgent label>" >&2; exit 2; }
host=$1 port=$2 service=$3 label=$4
mini=macmini@macmini
here=$(cd "$(dirname "$0")" && pwd)
tls_base="$HOME/.config/opsbuf-sites/$host"

run_on_mini() {
  ssh -o BatchMode=yes "$mini" "$1"
}

make_certificate_if_missing() {
  [[ -s "$tls_base/tls/cert.pem" ]] && return
  mkdir -p "$tls_base" && chmod 700 "$tls_base"
  ln -sfn "$HOME/.config/opsbuf-issues/ca" "$tls_base/ca"
  PTX_TLS_DIR="$tls_base" PTX_TLS_NAMES="$host localhost" PTX_TLS_ADDRESSES="127.0.0.1 192.168.88.3" \
    bash "$HOME/private-repos/opsbuf-issues/scripts/make-certificate.sh"
}

copy_certificate() {
  echo "== $host: certificate for nginx"
  run_on_mini "mkdir -p ~/Apps/nginx/tls/$host"
  scp -q -o BatchMode=yes "$tls_base/tls/cert.pem" "$tls_base/tls/key.pem" "$mini:Apps/nginx/tls/$host/"
  run_on_mini "chmod 600 ~/Apps/nginx/tls/$host/key.pem"
}

add_nginx_block_if_missing() {
  echo "== $host: nginx on 443 -> 127.0.0.1:$port"
  sed -e "s/__HOST__/$host/g" -e "s/__PORT__/$port/g" "$here/nginx-block.conf" | run_on_mini "
    if grep -q 'server_name $host;' ~/Apps/nginx/nginx.conf; then cat > /dev/null; else
      cp ~/Apps/nginx/nginx.conf ~/Apps/nginx/nginx.conf.before-$host
      perl -0pi -e 's/\}\s*\z//' ~/Apps/nginx/nginx.conf
      cat >> ~/Apps/nginx/nginx.conf
      echo '}' >> ~/Apps/nginx/nginx.conf
    fi"
  run_on_mini "bash ~/Repos/certs/invalidate-nginx.sh"
}

announce_name() {
  echo "== $host: Bonjour name ($label)"
  run_on_mini "mkdir -p ~/Apps/opsbuf-sites"
  scp -q -o BatchMode=yes "$here/announce-name.sh" "$mini:Apps/opsbuf-sites/announce-name.sh"
  run_on_mini "cat > ~/Library/LaunchAgents/$label.plist <<PLIST
<?xml version=\"1.0\" encoding=\"UTF-8\"?>
<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">
<plist version=\"1.0\">
<dict>
    <key>Label</key><string>$label</string>
    <key>ProgramArguments</key>
    <array><string>/bin/bash</string><string>/Users/macmini/Apps/opsbuf-sites/announce-name.sh</string></array>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PTX_ISSUES_HOST</key><string>$host</string>
        <key>PTX_ISSUES_PORT</key><string>443</string>
        <key>ANNOUNCE_SERVICE</key><string>$service</string>
    </dict>
    <key>RunAtLoad</key><true/>
    <key>KeepAlive</key><true/>
    <key>StandardOutPath</key><string>/Users/macmini/Apps/logs/$label.log</string>
    <key>StandardErrorPath</key><string>/Users/macmini/Apps/logs/$label.log</string>
</dict>
</plist>
PLIST
    plutil -lint -s ~/Library/LaunchAgents/$label.plist
    d=gui/\$(id -u); launchctl bootout \$d/$label 2> /dev/null && sleep 1 || true
    launchctl bootstrap \$d ~/Library/LaunchAgents/$label.plist"
}

make_certificate_if_missing
copy_certificate
add_nginx_block_if_missing
announce_name
echo "== $host is set up: https://$host"
