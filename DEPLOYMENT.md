# Deployment Notes

This service is intended to be deployed as a standalone Cloudflare Worker on:

- `https://liqunch-licensing-service.elisonyang2024.workers.dev`

## 1. Create the D1 database

```bash
wrangler d1 create liqunch-licenses
```

Copy the returned database ID into [`wrangler.toml`](./wrangler.toml).

## 2. Apply the schema

```bash
wrangler d1 execute liqunch-licenses --file=./migrations/0001_initial.sql
```

## 3. Set real Paddle values

Update [`wrangler.toml`](./wrangler.toml):

- `PADDLE_SINGLE_PRICE_ID`
- `PADDLE_DOUBLE_PRICE_ID`
- `EMAIL_FROM_ADDRESS`
- `EMAIL_FROM_NAME`
- `EMAIL_REPLY_TO`
- `SUPPORT_EMAIL`

Then set the Worker secrets:

```bash
wrangler secret put PADDLE_WEBHOOK_SECRET
wrangler secret put PADDLE_API_KEY
wrangler secret put SMTP2GO_API_KEY
```

## 4. Install dependencies

```bash
npm install
```

## 5. Deploy

```bash
npm run deploy
```

## 6. Connect Paddle webhook

Point Paddle webhook delivery to:

- `https://liqunch-licensing-service.elisonyang2024.workers.dev/api/paddle/webhooks`

This endpoint now verifies the `Paddle-Signature` header against the raw request body before processing events.

The current implementation supports these event intents:

- successful transaction => create license
- refund / chargeback adjustment => revoke license

After a successful purchase webhook creates a license, the service also sends a bilingual license email through SMTP2GO.
If email delivery fails, the license remains active and the failure is only logged.

## 7. Manual backfill during early rollout

Until Paddle is fully live, you can also seed licenses directly in D1 for local testing.
