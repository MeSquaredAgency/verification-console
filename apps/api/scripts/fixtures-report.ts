// pnpm fixtures:report — runs all 20 fixtures end to end and writes reports/fixtures-report.md.
// Offline by default; set MODEL_MODE=anthropic and ANTHROPIC_API_KEY to run the live models.
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { makeEnv } from "../test/helpers";
import { reportMarkdown, runAllFixtures } from "../test/fixture-eval";

const mode = process.env.MODEL_MODE === "anthropic" ? "anthropic" : "offline";
const env = await makeEnv({ MODEL_MODE: mode, ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY });
const results = await runAllFixtures(env);
const out = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../reports/fixtures-report.md");
mkdirSync(path.dirname(out), { recursive: true });
writeFileSync(out, reportMarkdown(results, mode, env.CLOCK_NOW ?? new Date().toISOString()));
const planted = results.flatMap((r) => r.planted);
console.log(`${planted.filter((p) => p.flagged).length}/${planted.length} planted errors flagged. Report: ${out}`);
