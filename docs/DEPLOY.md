# Deploying to Cloudflare

One Worker, `verification-console`, in the **Me²** account serves both the web app (static assets) and the API (`/api/*`). It deploys from GitHub with Workers Builds on every push to `main`.

## Status

| Piece | State |
|---|---|
| D1 `vc-db` (Oceania) | Created. `e92f59d5-96d8-4ada-bb5b-90b6483a1f8c`. Schema and demo seed apply on deploy (migrations `0001`, `0002`). |
| Queues `vc-pipeline`, `vc-pipeline-dlq` | Created |
| R2 `vc-sources` | **Waiting:** R2 must first be enabled in the dashboard |
| Workers Builds (GitHub → Worker) | **Waiting:** must be connected in the dashboard |
| `FILE_URL_SECRET` secret | Set by Claude after the first deploy |
| Google Workspace sign-in in Zero Trust | **Waiting:** needs a Google OAuth client |
| Access application for `console.mesquaredagency.com` | After Google sign-in exists |
| Public address `console.mesquaredagency.com` | Off until Access protects it (`workers_dev` and preview URLs are also off) |

Until the Access application exists, the Worker has no public address. Even if one were added, the API rejects every request without a valid Access token.

## Steps

1. **Enable R2.** In the Me² account dashboard, open R2 and enable it. Then create a bucket named `vc-sources` with location hint Oceania (OC).
2. **Connect Workers Builds.** Go to Workers & Pages → Create → Import a repository → GitHub → `MeSquaredAgency/verification-console`. If prompted, install the Cloudflare GitHub app on the MeSquaredAgency organisation.
   - Project name: `verification-console` (must match `apps/api/wrangler.jsonc`)
   - Root directory: `/`
   - Build command: `pnpm install --frozen-lockfile && pnpm build:web`
   - Deploy command: `pnpm deploy:cf` (applies D1 migrations, then `wrangler deploy`)
   - Non-production branch builds: off

   If the deploy step fails on the migrations with a permissions error, give the build token D1 Edit (Settings → Builds → API token).
3. **Secret.** After the first green build, set `FILE_URL_SECRET` to a random 32+ character value: Worker → Settings → Variables and Secrets. Claude can also do this through the Cloudflare connector.
4. **Google Workspace sign-in.** A Google Workspace admin creates an OAuth client in Google Cloud. Its redirect URI is `https://mesquaredagency.cloudflareaccess.com/cdn-cgi/access/callback`. Add it in Zero Trust → Settings → Authentication → Login methods → Google Workspace.
5. **Access application and go live.** Create a self-hosted Access application for `console.mesquaredagency.com`: Google Workspace login only, allow emails ending in `@mesquaredagency.com`. Put its AUD tag in `ACCESS_AUD` in `apps/api/wrangler.jsonc`, then add the custom domain route:
   ```jsonc
   "routes": [{ "pattern": "console.mesquaredagency.com", "custom_domain": true }]
   ```
   Pushing that to `main` deploys it and creates the DNS record.
6. **Users.** The first admin (elliot.crabb@mesquaredagency.com) is seeded. Add operators, seniors and the auditor in Settings → Users.

## Model mode

There is no `ANTHROPIC_API_KEY` on the Worker, so the pipeline runs on the offline stand-in. Add the key as a secret only after the privacy and Anthropic data-terms items in the handoff note are cleared, and after a live fixture run.
