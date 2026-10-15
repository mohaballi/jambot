# jambot

A chat bot built with Chat SDK.

## Getting Started

1. Copy the example environment file and fill in your credentials:

```bash
cp .env.example .env.local
```

2. Start the dev server:

```bash
npm run dev
```

3. Expose your local server to the internet and configure platform webhook URLs.

   For Slack, set **both** request URLs in the app config to the same public endpoint:

   - **Event Subscriptions** → Request URL: `https://<public-host>/api/webhooks/slack`
   - **Interactivity & Shortcuts** → Request URL: `https://<public-host>/api/webhooks/slack`

   Without the interactivity URL, Slack shows a "not configured to handle interactive responses" warning on messages containing buttons.

## Namespace authentication

Locally the Namespace SDK reads your `nsc login` token. Serverless hosts have no
token file, so set `NAMESPACE_TOKEN` to your local session token (the
`session_token` value in `~/Library/Application Support/ns/token.json` on macOS)
or to a revokable tenant token created with `nsc token create`. At startup the
bot writes it to a token file and points the SDK at it via `NSC_TOKEN_FILE`.

## Endpoints

- Slack: `/api/webhooks/slack`

## Project Structure

```
src/
  lib/bot.tsx                             Bot configuration and handlers
  app/api/webhooks/[platform]/route.ts    Webhook endpoint for platform adapters
  app/api/chat/route.ts                   Web adapter endpoint when selected
.env.example                              Required environment variables
```

## Scripts

| Command | Description |
| --- | --- |
| `npm run dev` | Start the development server |
| `npm run build` | Create a production build |
| `npm run start` | Start the production server |
| `npm run typecheck` | Type-check the project |

## Learn More

- [Chat SDK Documentation](https://chat-sdk.dev/docs)
- [Adapter Setup Guides](https://chat-sdk.dev/adapters)
- [GitHub Repository](https://github.com/vercel/chat)
