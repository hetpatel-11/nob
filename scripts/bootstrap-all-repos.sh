#!/usr/bin/env bash
set -euo pipefail

if ! command -v gh >/dev/null 2>&1; then
  echo "gh CLI is required: https://cli.github.com/"
  exit 1
fi

if [[ $# -lt 1 ]]; then
  echo "Usage: $0 <owner>"
  exit 1
fi

OWNER="$1"
SELF_REPO="$(gh repo view --json nameWithOwner -q .nameWithOwner)"

echo "Bootstrapping repositories for $OWNER..."

while IFS= read -r repo; do
  [[ -z "$repo" ]] && continue
  if [[ "$repo" == "$SELF_REPO" ]]; then
    echo "Skipping $repo (source repo)"
    continue
  fi

  echo "Processing $repo"
  "$(dirname "$0")/bootstrap-repo.sh" "$repo" || echo "Failed: $repo"
done < <(gh repo list "$OWNER" --limit 500 --json nameWithOwner -q '.[].nameWithOwner')

echo "Completed bootstrap scan for $OWNER."
echo "Set secrets per repo or use org secrets:"
echo "- ANTHROPIC_API_KEY (required)"
echo "- NOB_APP_ID (optional for app identity)"
echo "- NOB_APP_PRIVATE_KEY (optional for app identity)"
