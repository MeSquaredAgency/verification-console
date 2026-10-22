# Command Centre Verification Console: Phase 0

A working prototype of the Verification Console from the build brief. An item comes in (an uploaded PDF supplier bill or a pasted tenant email) and runs through the AI pipeline: classify, extract, draft, list claims, independent check, coded checks. It then waits for an operator, who must decide every claim on the three-panel screen before the console releases it.

Phase 0 sends nothing anywhere. A release writes the final output to the database and shows it. All data is fictional fixture data.

See [`docs/HANDOFF.md`](docs/HANDOFF.md) for the decisions made and open questions. See [`reports/fixtures-report.md`](reports/fixtures-report.md) for which planted errors the pipeline flagged.

## Run it locally

Requires Node 22+ and pnpm 10.

```bash
pnpm install
cp apps/api/.dev.vars.example apps/api/.dev.vars   # DEV_AUTH=1, offline model
pnpm --filter @vc/api db:migrate:local             # create the local D1 database
pnpm dev                                           # API on :8787 (wrangler), web on :5173 (vite)
```

Open http://localhost:5173 and press **Load demo data** (first run only). Then pick a user:

| User | Role |
|---|---|
| Sophea, Dara | Operators assigned to the demo client |
| Team lead | Senior reviewer |
| Licensed APN reviewer | Senior reviewer, licensed (can second-review legal notices) |
| Elliot | Admin |
| Patrick | Auditor (read-only) |

Add work from the queue page (**Add work**): upload a PDF from `fixtures/bills/` or paste an email from `fixtures/emails/`. The local queue takes a few seconds per item.

### Live models

With no API key the pipeline runs on a deterministic **offline stand-in** (`apps/api/src/model/offline.ts`), so everything works offline and in tests. To use Claude, add to `apps/api/.dev.vars`:

```
ANTHROPIC_API_KEY=sk-ant-...
MODEL_MODE=anthropic
```

Models, effort and token limits are set per stage in `apps/api/src/model/config.ts`. Prompts are versioned in `apps/api/src/model/prompts.ts`, and every model call is logged in `model_calls` with its model, prompt version and output.

## Tests

```bash
pnpm test              # unit and API tests: shared, api (D1 on node:sqlite), web
pnpm test:e2e          # Playwright, Chrome at 1366×768, against real wrangler dev + vite
pnpm fixtures:report   # runs all 20 fixtures, writes reports/fixtures-report.md
MODEL_MODE=anthropic ANTHROPIC_API_KEY=... pnpm fixtures:report   # same, on live models
```

How the acceptance criteria are covered:

| Criterion | Where |
|---|---|
| No route releases an item unless every claim has a decision | `apps/api/test/acceptance.test.ts` |
| Any number or date in the final text that isn't a decided claim blocks approval | same |
| Editing a draft re-extracts claims; new claims start undecided | same |
| A seeded value can never appear in released output, caught or missed | same (bill and reply; caught by re-key, correction and missed) |
| Changed supplier bank details always produce tier 3 | same (every supplier, every digit position) |
| Re-key fields hide the draft value until typed | same |
| The audit log can rebuild who confirmed each claim against which source span and when | same (`/api/releases/:id/audit-report`) |
| Instructions planted in a source email don't change the draft or trigger any action | same (fixture E03) |
| Full keyboard flow works on Chrome at 1366×768 | `apps/web/e2e/keyboard.spec.ts` |
| Pulling the network mid-task loses no decisions | `apps/web/e2e/offline.spec.ts` |
| All 20 fixtures run end to end; the report shows which planted errors were flagged | `acceptance.test.ts` + `pnpm fixtures:report` |

## Layout

```
apps/api        Cloudflare Worker (Hono): API, queue consumer, cron purge
  migrations/   D1 schema (audit_events is append-only via triggers)
  src/pipeline/ stages, tier rules, coded checks, claims
  src/model/    per-stage model config, versioned prompts, Claude API client, offline stand-in
  src/verify/   view (re-key masking), decisions, edits, seeded errors, approval and release, locks
apps/web        Vite + React + Tailwind: queue, three-panel verification screen, review, audit, metrics, settings
packages/shared Zod schemas and types shared by API, model output and UI; dates, money, ABN, sweep
fixtures/       10 PDF bills, 10 emails, answer keys, playbook and reference data (all fictional)
scripts/        fixture generator
```

## Deploying to Cloudflare (not done yet)

Nothing has been created in a Cloudflare account. To deploy:

1. `wrangler d1 create vc-db --location oc`, then put the id in `apps/api/wrangler.jsonc`. Run `wrangler d1 migrations apply vc-db --remote`.
2. `wrangler r2 bucket create vc-sources`, `wrangler queues create vc-pipeline`, `wrangler queues create vc-pipeline-dlq`.
3. Secrets: `wrangler secret put ANTHROPIC_API_KEY`, `wrangler secret put FILE_URL_SECRET`. Set vars `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD`. **Never set `DEV_AUTH` in production.**
4. Serve the web build (`pnpm --filter @vc/web build`, Pages) and the Worker on one hostname, with the Worker routed at `/api/*`. Put the hostname behind a Cloudflare Access application restricted to mesquaredagency.com Google accounts. Add device posture checks if the plan supports them.
5. Insert users and client assignments with `POST /api/admin/users` as an admin. Seed the first admin row directly in D1.
