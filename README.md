# nob - AI-Powered Terminal Assistant

Make your terminal AI-powered. Describe what you want in plain English, and nob will execute the commands for you.

## Features

### AI Mode (Default)

Describe what you want in natural language, and nob will generate and execute the commands for you.

![AI Prompt Example](./images/ai_prompt.png)

### Manual Mode with Autosuggestion

Switch to manual mode for traditional terminal usage with autosuggestion.

```bash
nob off
```

![Autosuggestion Example](./images/autosuggestion.png)

## Install

```bash
npm install -g nob-cli
```

## Quick Start

```bash
nob
```

That's it! Works out of the box with zero configuration. Works in any terminal (bash, zsh, fish, etc.).

## Commands

**Inside nob:**
- `nob on` - Enable AI mode
- `nob off` - Switch to manual mode with autosuggestion
- `exit` - Exit nob

**Before starting nob:**
- `nob login` - Login with GitHub or Google (required)
- `nob logout` - Logout from nob
- `nob set-api-key` - Use your own API key (unlimited usage)
- `nob show-config` - View your configuration
- `nob remove-api-key` - Remove your API key
- `nob help` - Show help

## Rate Limits

By default, nob uses a free shared backend with:
- 100 requests per day
- 100,000 tokens per day

If you hit the limit, use your own API key:

```bash
nob set-api-key
```

This will prompt you for your Cloudflare Workers AI credentials and save them securely.

## Privacy

We take your privacy seriously. Here's exactly what data we collect and what we don't:

### What We Collect

| Data | Purpose | Retention |
|------|---------|-----------|
| **Email** | User identification | Permanent |
| **OAuth Provider ID** | Unique user identifier from GitHub/Google | Permanent |
| **Login Timestamps** | Track when you first signed up and last logged in | Permanent |
| **Daily Request Count** | Rate limiting (100 requests/day on free tier) | 24 hours |
| **Daily Token Count** | Rate limiting (100k tokens/day on free tier) | 24 hours |

### What We Do NOT Collect

- ❌ **Your prompts or questions** - We do not store what you ask the AI
- ❌ **AI responses** - We do not store what the AI generates
- ❌ **Commands executed** - We do not track what commands run on your machine
- ❌ **File contents** - We never access or store your files
- ❌ **Directory structure** - We don't track your filesystem
- ❌ **IP addresses** - Not stored permanently
- ❌ **Usage analytics** - No tracking of features used

### Data Storage

- User identity data is stored in Cloudflare KV (edge storage)
- Your login token is stored locally in `~/.nob/config.json` with `0600` permissions (owner read/write only)
- Rate limit counters expire automatically after 24 hours

### BYOK (Bring Your Own Key)

When you use your own Cloudflare API key (`nob set-api-key`), your requests go directly to Cloudflare Workers AI. We don't see or log any of your data in this mode.

## License

MIT

---

Created by Het Patel
