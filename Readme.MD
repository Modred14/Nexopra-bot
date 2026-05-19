# Nexopra Bot 🤖

An AI-powered WhatsApp assistant that delivers personalized tech opportunities daily.

## Setup

```bash
npm install
npm start
```

Scan the QR code that appears in your terminal with WhatsApp.

## How It Works

1. User sends "hi" → onboarding collects name, field, delivery time
2. Bot stores user in `users.json`
3. Every minute, the scheduler checks if any user's delivery time matches `HH:MM` now
4. At match → Claude AI fetches fresh opportunities → formats → sends via WhatsApp

## User Commands

| Command  | Description                      |
|----------|----------------------------------|
| `hi`     | Start / greet the bot            |
| `now`    | Get today's opportunities now    |
| `pause`  | Pause daily updates              |
| `resume` | Resume daily updates             |
| `status` | View your profile                |
| `update` | Change name/field/delivery time  |
| `help`   | Show all commands                |

## Environment

The bot calls the Anthropic API at `api.anthropic.com`. Make sure your server has outbound HTTPS access and a valid Anthropic API key injected via your deployment environment (the API key is handled by the hosting layer — no `.env` needed if you use Anthropic's platform).

## Files

- `index.js` — Main bot logic
- `users.json` — Persisted user profiles (auto-created)
- `auth_info/` — WhatsApp session (auto-created on first scan)# Nexopra-bot
