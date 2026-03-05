# Nob AI Issue Assistant

<img src="assets/nob-logo.svg" alt="Nob Logo" width="120" />

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

## Fast Setup For Any Repo (2 Files + Config + Secrets)
This repo ships reusable workflows so consumers do not need to copy the TypeScript runtime.

1. Copy these two templates into target repo `.github/workflows/`:
   - `templates/consumer/ai-issue-assistant.yml`
   - `templates/consumer/ai-issue-maintainer-actions.yml`
2. Copy support config into target repo `.github/support-bot/`:
   - `.github/support-bot/config.yml`
   - `.github/support-bot/policy.md`
   - `.github/support-bot/response-style.md`
3. Set maintainer handles in `.github/support-bot/config.yml`.
4. Add Actions secret `ANTHROPIC_API_KEY` in that repo (owner's own key).
5. Optional for GitHub App identity:
   - `NOB_APP_ID`
   - `NOB_APP_PRIVATE_KEY`
6. Open a test issue.

If app secrets exist, Nob mints an app token automatically. If not, it uses default `GITHUB_TOKEN`.

## Recommended Variables
Set in `Settings -> Secrets and variables -> Actions -> Variables`:

- `CLAUDE_MODEL` (optional), default: `claude-sonnet-4-6`
- `AI_SUPPORT_MODE` (optional), default: `shadow`
  - `shadow`: never auto-post; always escalate draft
  - `guarded`: policy-based guarded autopost
  - `full`: full policy mode

## Multi-Repo Rollout (Your Account/Org)
Use helper scripts from this repo:

1. Single repo:
```bash
./scripts/bootstrap-repo.sh owner/repo
```
2. All repos for an owner:
```bash
./scripts/bootstrap-all-repos.sh owner
```
These scripts add consumer workflows plus support-bot config files, then push commits.

## Optional: GitHub App Setup (for logo/avatar identity)
1. Create a GitHub App and install it on target repos.
2. Add app credentials as repo/org secrets:
   - `NOB_APP_ID`
   - `NOB_APP_PRIVATE_KEY`
3. Keep using each repo's own `ANTHROPIC_API_KEY`.

## Required Secrets (Each Repo Uses Its Own)
Set in `Settings -> Secrets and variables -> Actions`:

- `ANTHROPIC_API_KEY` (required): the repo owner's key.
- `NOB_APP_ID` (optional): only when using GitHub App identity.
- `NOB_APP_PRIVATE_KEY` (optional): only when using GitHub App identity.

This project never requires users to share your key. Every installer uses their own secrets.

## Maintainer Commands
- `/ai-draft`: post latest saved draft response.
- `/ai-post`: post latest draft publicly and mark answered.
- `/ai-ignore`: add `no-ai` label and disable automation for that issue.

## Safety Rules
- No reply without grounded citations.
- Uncertain or conflicting cases escalate.
- Bot-originated events are ignored to prevent loops.
- Cooldown is enforced to reduce spam.
