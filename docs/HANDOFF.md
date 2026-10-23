# Phase 0 handoff note

**State:** Phase 0 runs locally under Wrangler with fixture data only. Nothing is sent anywhere. Cloudflare deployment is part done; see `docs/DEPLOY.md`. Test status: 41 API, 8 shared, 2 web unit and 3 Playwright tests pass. The fixture report flags **22 of 22** planted errors, with all 20 tiers as expected. That report ran on the **offline stand-in model**, so it shows that the coded checks, tiering and plumbing work, not how well the models do. **Live models have not been run.** This session had no API key. Run `MODEL_MODE=anthropic pnpm fixtures:report` before anything else.

## Decisions made where the brief was silent (simpler option chosen)

1. **Quotes, not citations.** Document citations can't be combined with structured outputs (the API returns a 400). Every stage instead returns Zod-validated JSON with verbatim quotes, and code locates each quote. Facts whose quote isn't found are discarded. PDFs go to the model as their extracted text layer, so spans line up with what Panel 1 highlights. **Scanned PDFs (no text layer) are rejected in Phase 0.**
2. **No temperature.** The Messages API rejects `temperature` as of 21 Oct 2026. Determinism comes from structured output, per-stage `effort` and the coded checks. All stages default to `claude-opus-5-5` in one config file. Server-side refusal fallback is on; a refusal fails the stage, which retries and then marks the task `error`.
3. **The drafter never sees the raw source**, only extracted facts and the playbook. Code, not a model, sets the reply's recipients (the sender) and subject. That is the main defence against injected instructions. Instructions aimed at the AI also force tier 3.
4. **Extra tier rules:** an unknown sender makes a reply tier 2, and an unknown supplier quoting bank details is tier 3. The threshold compares the GST-inclusive total.
5. **Re-key hides the draft value and the extracted source value.** Check names stay visible; their details are redacted until the value is typed. A typed mismatch can't be confirmed, only corrected or flagged. Unsupported and Omitted claims need a note to confirm.
6. **Seeded errors go on Matched claims**, where attention slips. A seed's checks show results for the true value, as if the error had got past the checks. It counts as caught on a mismatched re-key, a correction or a flag; the operator is told "good catch". If missed, the item is held at approval, the operator is shown what slipped, and the claim reopens.
7. **Any flagged claim sends the item to second review**, whatever its tier. The senior must confirm or correct each flag (seniors don't flag; they correct or reject). The second reviewer must be a different person. RTA notices need a `licensed_apn` reviewer. Admins can act as seniors.
8. **Correct** on an Omitted question adds an answer paragraph before the sign-off. Correct with empty text on an Unsupported statement deletes it. Corrections create a new draft version and need a connection. Confirm, flag and re-key queue offline. Approve waits until every decision is saved.
9. **A client-record strip** under Panel 1 shows the tenancy or supplier record, because some reply values (rent, bond) come from the register, not the email.
10. **PDF.js is pinned to 4.10.38.** Version 5 needs a newer Chrome than the test browser; 4.10 includes the 2024 font-injection fix. Default zoom is 150% so 10pt text is readable at 1366 px.
11. **Pacing:** the break prompt appears on the queue page between items, not mid-item. A streak resets after 10 idle minutes. The spot-check floor is unset until calibrated.
12. **Feature flags:** flags that wait on approvals can't be switched on through the API. Gmail intake and live send are stubs that return 501. There is no sampling flag.
13. **Extras beyond Phase 0 scope**, because the auditor role needs them: a basic metrics page, incident logging and the per-release audit-trail view. Playbook, user and incident root-cause editing are API-only for now.

## Open questions

- **For Patrick (from the brief):** APN's tier 3 threshold (placeholder $5,000), the senior reviewers and who signs off legal notices, source retention (placeholder 90 days), whether operators stop sending from Gmail in Phase 2, which accounting or property-management software, and the pilot start date.
- **Live model behaviour is unproven.** That covers extraction quality, the independent check, prompt-injection resistance and the claim-listing recall that the coded sweep backs up. It needs a live fixture run, then the regression set growing from real items.
- **Scanned bills:** do APN's suppliers send image-only PDFs? If so, Phase 1 needs an OCR or vision path that still yields locatable spans.
- **Announcing caught seeds:** is telling operators "that was a seeded error" right for coaching, or should catches be silent?
- **Khmer UI hints** (behind `khmer_ui_hints`) are draft translations that need checking by a native speaker.
- **Cloudflare setup:** no D1, R2, Queue or Access app exists yet (README has the steps). Whether device posture checks are available depends on the plan.
- **Team-lead tools:** the spot-check list and second-review queue are basic. The team lead may want a backlog view, which operators deliberately don't get.
- **Privacy and legal items from the brief** (APP 8, trust accounting, RTA notices, the contractor agreement, Anthropic data terms) are all still open. They gate any live data.
