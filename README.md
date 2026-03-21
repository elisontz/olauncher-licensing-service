# Liqunch Licensing Service

Minimal Cloudflare Workers + D1 service for `email + license` activation.

Production endpoint:

- [https://liqunch-licensing-service.elisonyang2024.workers.dev](https://liqunch-licensing-service.elisonyang2024.workers.dev)

Health check:

- [https://liqunch-licensing-service.elisonyang2024.workers.dev/health](https://liqunch-licensing-service.elisonyang2024.workers.dev/health)

## Scope

This repository contains the standalone licensing backend only. It is responsible for:

- license activation
- license validation
- license deactivation
- Paddle webhook handling
- seat tracking in D1

Related repositories:

- App: [`Liqunch`](https://github.com/elisontz/Liqunch)
- Website: [`liqunch-web`](https://github.com/elisontz/liqunch-web)

## Endpoints

- `GET /health`
- `POST /api/licenses/activate`
- `POST /api/licenses/validate`
- `POST /api/licenses/deactivate`
- `POST /api/paddle/webhooks`

## Local setup

1. Install dependencies:
   ```bash
   npm install
   ```
2. Create a D1 database:
   ```bash
   npx wrangler d1 create liqunch-licenses
   ```
3. Replace `database_id` in [`wrangler.toml`](./wrangler.toml).
4. Apply the initial schema locally if needed:
   ```bash
   npx wrangler d1 execute liqunch-licenses --file=./migrations/0001_initial.sql
   ```
5. Apply the schema to the remote database:
   ```bash
   npx wrangler d1 execute liqunch-licenses --remote --file=./migrations/0001_initial.sql
   ```
6. Run the local dev server:
   ```bash
   npm run dev
   ```

## Verification

```bash
npm test
npm run typecheck
```

## Required configuration

Set these values in [`wrangler.toml`](./wrangler.toml) or through Wrangler secrets where noted:

- `LICENSE_KEY_PREFIX`
- `PADDLE_SINGLE_PRICE_ID`
- `PADDLE_DOUBLE_PRICE_ID`
- `EMAIL_FROM_ADDRESS`
- `EMAIL_FROM_NAME`
- `EMAIL_REPLY_TO`
- `SUPPORT_EMAIL`
- `PADDLE_WEBHOOK_SECRET` via Wrangler secret
- `PADDLE_API_KEY` via Wrangler secret
- `SMTP2GO_API_KEY` via Wrangler secret

## Paddle webhook configuration

Current webhook destination:

- `https://liqunch-licensing-service.elisonyang2024.workers.dev/api/paddle/webhooks`

The current event set is:

- `transaction.paid`
- `transaction.completed`
- `adjustment.created`
- `adjustment.updated`

## Notes

- The webhook handler verifies the `Paddle-Signature` header against the raw request body before mutating license state.
- The service uses Cloudflare D1 for license and activation records.
- Custom domain binding for `license.tayueke.cn` was not used because the DNS zone is still hosted outside Cloudflare.
- Newly created licenses are emailed through SMTP2GO after successful purchase webhook processing.
- Email delivery failure does not roll back license creation. Check Worker logs if a buyer does not receive the message.
