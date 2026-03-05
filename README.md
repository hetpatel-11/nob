# Nob AI Issue Assistant

![Nob Logo](assets/nob-logo.png)

Automates GitHub issue support with Claude, repository-grounded citations, confidence gating, and maintainer escalation.

## What It Does
- Runs on new/edited issues and issue comments.
- Uses repository files (code + docs) via local tools: `glob_files`, `grep_files`, `read_file`.
- Auto-replies only when confidence/rules pass.
- Escalates uncertain cases with a maintainer draft.
- Supports maintainer commands: `/ai-draft`, `/ai-post`, `/ai-ignore`.

## Identity Modes
- Default (no app): comments are authored by `github-actions[bot]`.
- Optional GitHub App mode: comments are authored by your installed app bot identity (logo/avatar supported).

## Required Secrets (each repo provides its own)
Set in `Settings -> Secrets and variables -> Actions`:

- `ANTHROPIC_API_KEY` (required): the repo owner's key.
  - This project never requires users to share your personal API key.
  - Every installer sets their own key in their own repository/org secrets.

Optional for GitHub App identity:
- `NOB_APP_ID`
- `NOB_APP_PRIVATE_KEY`

If app secrets exist, workflows mint an app token automatically. If not, workflows use default `GITHUB_TOKEN`.

## Recommended Variables
Set in `Settings -> Secrets and variables -> Actions -> Variables`:

- `CLAUDE_MODEL` (optional), default: `claude-3-5-sonnet-latest`
- `AI_SUPPORT_MODE` (optional), default: `shadow`
  - `shadow`: never auto-post; always escalate draft
  - `guarded`: policy-based guarded autopost
  - `full`: full policy mode

## Quick Start (Template-Friendly)
1. Push this project to your repository (or use as template).
2. Add `ANTHROPIC_API_KEY` in Actions secrets.
3. Edit `.github/support-bot/config.yml`:
   - set `maintainers` to your GitHub handles
   - keep `skip_labels` as needed
4. Enable GitHub Actions in your repo.
5. Open a test issue.
6. Start in `shadow` mode for 3-5 days, then move to `guarded`/`full`.

## Optional: GitHub App Setup (for logo/avatar identity)
1. Create a GitHub App and install it on target repos.
2. Add app credentials as repo/org secrets:
   - `NOB_APP_ID`
   - `NOB_APP_PRIVATE_KEY`
3. Keep using each repo's own `ANTHROPIC_API_KEY`.

## Maintainer Commands
- `/ai-draft`: post latest saved draft response.
- `/ai-post`: post latest draft publicly and mark answered.
- `/ai-ignore`: add `no-ai` label and disable automation for that issue.

## Safety Rules
- No reply without grounded citations.
- Uncertain or conflicting cases escalate.
- Bot-originated events are ignored to prevent loops.
- Cooldown is enforced to reduce spam.
