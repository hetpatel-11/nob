#!/usr/bin/env bash
set -euo pipefail

if ! command -v gh >/dev/null 2>&1; then
  echo "gh CLI is required: https://cli.github.com/"
  exit 1
fi

if [[ $# -lt 1 ]]; then
  echo "Usage: $0 <owner/repo>"
  exit 1
fi

REPO="$1"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

echo "Cloning $REPO..."
gh repo clone "$REPO" "$TMP_DIR/repo" -- --depth=1 >/dev/null

mkdir -p "$TMP_DIR/repo/.github/workflows"
mkdir -p "$TMP_DIR/repo/.github/support-bot"
cp templates/consumer/ai-issue-assistant.yml "$TMP_DIR/repo/.github/workflows/ai-issue-assistant.yml"
cp templates/consumer/ai-issue-maintainer-actions.yml "$TMP_DIR/repo/.github/workflows/ai-issue-maintainer-actions.yml"
cp .github/support-bot/config.yml "$TMP_DIR/repo/.github/support-bot/config.yml"
cp .github/support-bot/policy.md "$TMP_DIR/repo/.github/support-bot/policy.md"
cp .github/support-bot/response-style.md "$TMP_DIR/repo/.github/support-bot/response-style.md"

cd "$TMP_DIR/repo"

if git diff --quiet; then
  echo "No changes required for $REPO."
  exit 0
fi

git add .github/workflows/ai-issue-assistant.yml \
  .github/workflows/ai-issue-maintainer-actions.yml \
  .github/support-bot/config.yml \
  .github/support-bot/policy.md \
  .github/support-bot/response-style.md
git commit -m "Add Nob issue assistant workflows and config" >/dev/null
git push >/dev/null

echo "Done. Added workflows to $REPO"
echo "Next:"
echo "- add repo secrets ANTHROPIC_API_KEY (+ optional NOB_APP_ID/NOB_APP_PRIVATE_KEY)"
echo "- set maintainers in .github/support-bot/config.yml"
