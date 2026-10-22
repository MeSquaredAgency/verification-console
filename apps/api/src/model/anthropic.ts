// Live model calls. Each stage is a separate request with only the inputs that stage may see,
// structured output validated against a Zod schema, and no tools.
import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { BillEntry, CheckOutput, ClassifyOutput, ExtractOutput, ListClaimsOutput, ReplyDraft } from "@vc/shared";
import type { z } from "zod";
import { FALLBACK, MODEL_CONFIG, type StageName } from "./config";
import { PROMPTS } from "./prompts";
import type { ModelResult, StageModel } from "./types";

export class ModelRefusal extends Error {}

function source(text: string) {
  return `<source>\n${text}\n</source>`;
}

export function anthropicModel(apiKey: string): StageModel {
  const client = new Anthropic({ apiKey });

  async function call<S extends z.ZodType>(stage: StageName, prompt: { version: string; system: string }, user: string, schema: S): Promise<ModelResult<z.infer<S>>> {
    const cfg = MODEL_CONFIG[stage];
    const res = await client.beta.messages.parse({
      model: cfg.model,
      max_tokens: cfg.max_tokens,
      system: prompt.system,
      messages: [{ role: "user", content: user }],
      output_config: { effort: cfg.effort, format: betaZodOutputFormat(schema) },
      ...(FALLBACK ? { betas: [FALLBACK.beta], fallbacks: FALLBACK.fallbacks } : {}),
    });
    if (res.stop_reason === "refusal") throw new ModelRefusal(`${stage}: model declined (${res.stop_details?.category ?? "no category"})`);
    if (res.stop_reason === "max_tokens") throw new Error(`${stage}: output truncated at max_tokens`);
    if (!res.parsed_output) throw new Error(`${stage}: output did not match schema`);
    return { output: res.parsed_output as z.infer<S>, model: res.model, promptVersion: prompt.version };
  }

  return {
    mode: "anthropic",
    classify: ({ taskType, sourceText }) =>
      call("classify", PROMPTS.classify, `Task type: ${taskType}\n\n${source(sourceText)}`, ClassifyOutput),
    extract: ({ taskType, sourceText }) =>
      call("extract", PROMPTS.extract, `Task type: ${taskType}\n\n${source(sourceText)}`, ExtractOutput),
    draftBill: ({ facts, playbook, reference, redraftNote }) =>
      call(
        "draft",
        PROMPTS.draft_bill,
        [
          `<facts>\n${JSON.stringify(facts.map(({ kind, label, value }) => ({ kind, label, value })), null, 1)}\n</facts>`,
          `<suppliers>\n${JSON.stringify(reference.suppliers.map(({ name, abn, default_account_code }) => ({ name, abn, default_account_code })))}\n</suppliers>`,
          `<chart_of_accounts>\n${JSON.stringify(reference.account_codes)}\n</chart_of_accounts>`,
          `<rules>\n${playbook.rules.join("\n")}\n</rules>`,
          redraftNote ? `<reviewer_feedback>\n${redraftNote}\n</reviewer_feedback>` : "",
        ].join("\n\n"),
        BillEntry,
      ),
    draftReply: ({ facts, playbook, tenancy, senderName, subject, redraftNote }) =>
      call(
        "draft",
        PROMPTS.draft_reply,
        [
          `<playbook>\n${JSON.stringify(playbook, null, 1)}\n</playbook>`,
          `<tenancy_record>\n${JSON.stringify(tenancy)}\n</tenancy_record>`,
          `<email_subject>${subject ?? ""}</email_subject>`,
          `<sender_name>${senderName ?? ""}</sender_name>`,
          `<facts>\n${JSON.stringify(facts.map(({ kind, label, value }) => ({ kind, label, value })), null, 1)}\n</facts>`,
          redraftNote ? `<reviewer_feedback>\n${redraftNote}\n</reviewer_feedback>` : "",
        ].join("\n\n"),
        ReplyDraft,
      ),
    listClaims: ({ body, ownNames }) =>
      call("list_claims", PROMPTS.list_claims, `Our own names (not claims): ${ownNames.join(", ")}\n\n<draft_body>\n${body}\n</draft_body>`, ListClaimsOutput),
    check: ({ sourceText, claims, draftBody }) =>
      call(
        "check",
        PROMPTS.check,
        [
          source(sourceText),
          `<claims>\n${JSON.stringify(claims.map(({ id, type, label, text }) => ({ claim_id: id, type, label, text })), null, 1)}\n</claims>`,
          `<draft_body>\n${draftBody}\n</draft_body>`,
        ].join("\n\n"),
        CheckOutput,
      ),
  };
}
