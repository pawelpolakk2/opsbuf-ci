#!/usr/bin/env bash
# Merges a green ticket branch into main of the CI repo: a fast-forward when it can, else a merge commit; never a
# force push. The push fires post-receive, so main runs its checks and releases as usual. Then the same main goes to the
# project's GitHub mirror. Run by the CI in the run's checkout, with CI_SHA and CI_BRANCH set.
# Usage: merge-into-main.sh <main branch> [mirror url]
# Exit codes: 2 a conflict, 3 main kept moving, 4 merged but the mirror refused it.
set -euo pipefail
[[ $# -ge 1 && $# -le 2 ]] || { echo "Usage: merge-into-main.sh <main branch> [mirror url]" >&2; exit 64; }

main=$1
mirror=${2:-}
attempts=3
: "${CI_SHA:?CI_SHA is not set}"
: "${CI_BRANCH:?CI_BRANCH is not set}"

fetch_main() {
  git fetch -q origin "+refs/heads/$main:refs/remotes/origin/$main"
}

# prints the commit main should point at, or nothing when the branch is in main already
build_target() {
  if git merge-base --is-ancestor "$CI_SHA" "origin/$main"; then
    return 0
  fi
  if git merge-base --is-ancestor "origin/$main" "$CI_SHA"; then
    echo "$CI_SHA"
    return 0
  fi
  git checkout -q -f --detach "origin/$main"
  if ! git -c user.name='opsbuf CI' -c user.email='ci@opsbuf.local' merge -q --no-ff --no-edit \
    -m "Merge $CI_BRANCH into $main" "$CI_SHA" > /dev/null 2>&1; then
    echo "CONFLICT: $CI_BRANCH does not merge into $main. Files in conflict:" >&2
    git diff --name-only --diff-filter=U | sed 's/^/  /' >&2
    git merge --abort
    return 2
  fi
  git rev-parse HEAD
}

push_main() {
  git push -q origin "$1:refs/heads/$main"
}

push_mirror() {
  [[ -n "$mirror" ]] || return 0
  git push -q "$mirror" "$1:refs/heads/$main" || {
    echo "Merged into $main, but the mirror $mirror refused it; it stays behind until the next push." >&2
    return 4
  }
}

for attempt in $(seq 1 "$attempts"); do
  fetch_main
  target=$(build_target) || exit $?
  if [[ -z "$target" ]]; then
    echo "$CI_BRANCH is in $main already"
    exit 0
  fi
  if push_main "$target"; then
    push_mirror "$target"
    echo "merged $CI_BRANCH into $main at $(git rev-parse --short "$target")"
    exit 0
  fi
  echo "$main moved while merging (attempt $attempt of $attempts); trying again"
done
echo "$main kept moving; push $CI_BRANCH again to retry" >&2
exit 3
