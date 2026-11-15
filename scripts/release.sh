#!/usr/bin/env bash
# The CI releases itself: the checkout of a green main build becomes ~/Apps/opsbuf-ci, and the server restarts on the
# new code once the run ends (data/restart-requested). Run by the CI, from its checkout.
set -euo pipefail
app=$HOME/Apps/opsbuf-ci
rsync -a --delete --exclude /data --exclude /repos --exclude /repo.git --exclude .git --exclude node_modules ./ "$app/"
for id in $(node -e 'for (const it of require(process.argv[1]).projects) console.log(it.id)' "$app/config.json"); do
  [ -d "$app/repos/$id.git" ] || git init -q --bare -b main "$app/repos/$id.git"
  install -m 755 "$app/scripts/post-receive" "$app/repos/$id.git/hooks/post-receive"
done
touch "$CI_DATA/restart-requested"
echo "released $(git rev-parse --short HEAD); the CI restarts when this run ends"
