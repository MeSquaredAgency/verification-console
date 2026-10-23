# Deploying to Cloudflare

One Worker, `verification-console`, in the **Me²** account serves both the web app (static assets) and the API (`/api/*`). It deploys from GitHub with Workers Builds on every push to `main`.

## Status (23 Oct 2026)

| Piece | State |
|---|---|
| D1 `vc-db` (Oceania) | Created and migrated (`0001` schema, `0002` demo seed with elliot.crabb@ as admin) |
| Queues `vc-pipeline`, `vc-pipeline-dlq` | Created, Worker is producer and consumer |
| R2 `vc-sources` | Created |
| Worker `verification-console` | **Deployed** in Me² (static web app + API, daily retention cron) |
| `FILE_URL_SECRET` | Set |
| Deploy token | Account-owned API token "verification-console deploy (Workers Builds)" in Me² (Workers Scripts, D1, Queues, R2, Account Settings Read, Tail; Workers Routes, Zone Read and DNS on mesquaredagency.com only), registered as the Workers Builds token |
| Auto-deploy on push | **Waiting:** the GitHub organisation isn't linked to the Me² account yet (one dashboard step, below) |
| Google Workspace sign-in | **Waiting:** needs a Google OAuth client |
| Access app and `console.mesquaredagency.com` | After Google sign-in. Until then there is no public address: workers.dev, preview URLs and custom domains are all off |

To redeploy by hand from a checkout: `CLOUDFLARE_API_TOKEN=... pnpm build:web && pnpm deploy:cf`.

## Steps

1. **Link GitHub to Me² for auto-deploys.** In the Me² account, go to Workers & Pages → `verification-console` → Settings → Builds → **Connect**. Choose GitHub → **MeSquaredAgency** → `verification-console`, branch `main`. Then set:
   - Build command: `pnpm build:web`
   - Deploy command: `pnpm deploy:cf`
   - API token: "verification-console build token"
2. **Google Workspace sign-in.** A Google Workspace admin creates an OAuth client in Google Cloud. Its redirect URI is `https://mesquaredagency.cloudflareaccess.com/cdn-cgi/access/callback`. Add it in Zero Trust → Settings → Authentication → Login methods → Google Workspace.
3. **Access application and go live.** Create a self-hosted Access application for `console.mesquaredagency.com`: Google Workspace login only, allow emails ending in `@mesquaredagency.com`. Put its AUD tag in `ACCESS_AUD` in `apps/api/wrangler.jsonc`, then add the custom domain route:
   ```jsonc
   "routes": [{ "pattern": "console.mesquaredagency.com", "custom_domain": true }]
   ```
   Pushing that to `main` deploys it and creates the DNS record.
4. **Users.** The first admin (elliot.crabb@mesquaredagency.com) is seeded. Add operators, seniors and the auditor in Settings → Users.

## Model mode

There is no `ANTHROPIC_API_KEY` on the Worker, so the pipeline runs on the offline stand-in. Add the key as a secret only after the privacy and Anthropic data-terms items in the handoff note are cleared, and after a live fixture run.
