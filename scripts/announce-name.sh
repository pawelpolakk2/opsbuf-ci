#!/usr/bin/env bash
# Announces ci.local over Bonjour with this Mac's current address, and the tracker as an _https._tcp
# service. `dns-sd -R` would announce only the service; `-P` also publishes the host name. When the address changes
# (DHCP, another network), it announces again. Run by the LaunchAgent pl.opsbuf.ci.name.
set -uo pipefail

name=${PTX_ISSUES_HOST:-ci.local}
service=${ANNOUNCE_SERVICE:-CI}
port=${PTX_ISSUES_PORT:-443}
check_every=30
announced=''
pid=''

find_address() {
  local interface
  interface=$(route -n get default 2> /dev/null | awk '/interface:/ { print $2 }')
  [[ -n "$interface" ]] && ipconfig getifaddr "$interface"
}

stop_announcing() {
  if [[ -n "$pid" ]]; then
    kill "$pid" 2> /dev/null
    wait "$pid" 2> /dev/null
  fi
  pid=''
}

start_announcing() {
  echo "$(date '+%F %T') announcing $name -> $1:$port"
  dns-sd -P "$service" _https._tcp local "$port" "$name" "$1" path=/ &
  pid=$!
}

trap 'stop_announcing; exit 0' TERM INT

while true; do
  address=$(find_address || true)
  is_running=false
  [[ -n "$pid" ]] && kill -0 "$pid" 2> /dev/null && is_running=true
  if [[ "$address" != "$announced" || "$is_running" == false ]]; then
    stop_announcing
    [[ -n "$address" ]] && start_announcing "$address"
    announced=$address
  fi
  sleep "$check_every" &
  wait $!
done
