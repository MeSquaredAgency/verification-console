// Acceptance criteria from the build brief, one describe block each.
import { sweepNumbersAndDates, type ApproveResult, type DraftContent, type TaskView } from "@vc/shared";
import { beforeEach, describe, expect, it } from "vitest";
import { answerKeys } from "../../../fixtures/data";
import { approvalBlockers } from "../src/verify/approve";
import type { ClaimRow } from "../src/lib/repo";
import { factTierRules } from "../src/pipeline/rules";
import { DEMO_REFERENCE } from "../../../fixtures/data";
import { runAllFixtures } from "./fixture-eval";
import { ADMIN, api, decideAll, did, ingest, LEAD, LICENSED, makeEnv, OP, OP2, open, rows, type TestEnv } from "./helpers";

async function approveAs(env: TestEnv, id: string, user = OP) {
  return api<{ result: ApproveResult; task: TaskView }>(env, "POST", `/api/tasks/${id}/approve`, user);
}

function released(env: TestEnv, taskId: string) {
  return rows<{ output_json: string; approved_by: string; second_reviewer: string | null }>(env, "SELECT * FROM releases WHERE task_id = ?", taskId);
}

describe("No route releases an item unless every claim has a decision", () => {
  let env: TestEnv;
  beforeEach(async () => {
    env = await makeEnv();
  });

  it("approve is blocked while any claim is undecided", async () => {
    const id = await ingest(env, "B01");
    const view = await open(env, id);
    expect(view.open_claims).toBeGreaterThan(0);
    const r = await approveAs(env, id);
    expect(r.json.result.outcome).toBe("blocked");
    expect(released(env, id)).toHaveLength(0);
  });

  it("blocked with one claim left, released when it is decided", async () => {
    const id = await ingest(env, "E01");
    await open(env, id);
    let view = await decideAll(env, id);
    // Re-open one claim by editing the draft so a new claim appears.
    const body = (view.draft.content as Extract<DraftContent, { kind: "reply" }>).reply.body.replace("Thanks for your email.", "Thanks for your email of 20 Oct 2026.");
    const edit = await api(env, "PUT", `/api/tasks/${id}/draft`, OP, { kind: "body", body });
    expect(edit.status).toBe(200);
    view = edit.json.task;
    expect(view.open_claims).toBeGreaterThan(0);
    expect((await approveAs(env, id)).json.result.outcome).toBe("blocked");
    expect(released(env, id)).toHaveLength(0);
    await decideAll(env, id);
    expect((await approveAs(env, id)).json.result.outcome).toBe("released");
    expect(released(env, id)).toHaveLength(1);
  });

  it("second review cannot release with a flagged claim unresolved, and must be someone else", async () => {
    const id = await ingest(env, "B07"); // tier 3
    await open(env, id);
    let view = (await api<TaskView>(env, "GET", `/api/tasks/${id}`, OP)).json;
    const supplier = view.claims.find((c) => c.field === "supplier_name")!;
    await api(env, "POST", `/api/tasks/${id}/decisions`, OP, { id: did(), claim_id: supplier.id, action: "flag", note: "Check this supplier" });
    view = await decideAll(env, id);
    expect((await approveAs(env, id)).json.result.outcome).toBe("second_review");
    expect(released(env, id)).toHaveLength(0);
    // The operator can't second-review their own work.
    expect((await approveAs(env, id, OP)).status).toBe(403);
    const r = await approveAs(env, id, LEAD);
    expect(r.json.result).toMatchObject({ outcome: "blocked" });
    expect(released(env, id)).toHaveLength(0);
    const flagged = r.json.task.claims.find((c) => c.status === "flagged")!;
    await api(env, "POST", `/api/tasks/${id}/decisions`, LEAD, { id: did(), claim_id: flagged.id, action: "confirm" });
    expect((await approveAs(env, id, LEAD)).json.result.outcome).toBe("released");
    expect(released(env, id)[0]).toMatchObject({ approved_by: OP, second_reviewer: LEAD });
  });

  it("rejecting sends the draft back to be redrafted, never released", async () => {
    const id = await ingest(env, "E02");
    await open(env, id);
    const r = await api(env, "POST", `/api/tasks/${id}/reject`, OP, { note: "Answer the inspection question" });
    expect(r.status).toBe(200);
    expect(rows(env, "SELECT status FROM tasks WHERE id = ?", id)[0].status).toBe("processing");
    await (await import("./helpers")).drain(env);
    const t = rows(env, "SELECT status, current_draft_id FROM tasks WHERE id = ?", id)[0];
    expect(t.status).toBe("queued");
    expect(rows(env, "SELECT version FROM drafts WHERE id = ?", t.current_draft_id)[0].version).toBe(2);
    expect(released(env, id)).toHaveLength(0);
  });
});

describe("Any number or date in the final text that isn't a decided claim blocks approval", () => {
  const claim = (over: Partial<ClaimRow>): ClaimRow =>
    ({ id: "c", type: "amount", field: null, status: "confirmed", true_start: 0, true_end: 0, needs_rekey: 0, rekeyed: 0, rekey_mismatch: 0, ...over }) as ClaimRow;
  const reply = (body: string): DraftContent => ({ kind: "reply", reply: { to: ["a@example.com"], subject: "Re: hi", body } });
  const base = [claim({ field: "to", type: "email", true_start: null, true_end: null }), claim({ field: "subject", type: "text", true_start: null, true_end: null })];

  it("blocks a number that no claim covers", () => {
    const body = "Your rent is $550.00 per week, unit 12.";
    const covered = claim({ true_start: 13, true_end: 20 });
    expect(approvalBlockers(reply(body), [...base, covered])).toEqual(['"12" in the reply isn\'t a decided claim']);
  });

  it("blocks a number whose claim is undecided", () => {
    const body = "Due Tue 4 Nov 2026.";
    const t = sweepNumbersAndDates(body)[0];
    expect(approvalBlockers(reply(body), [...base, claim({ type: "date", status: "undecided", true_start: t.start, true_end: t.end })])).toContain(`"Tue 4 Nov 2026" in the reply isn't a decided claim`);
  });

  it("passes when every number and date is a decided claim", () => {
    const body = "Due Tue 4 Nov 2026, $10.00.";
    const toks = sweepNumbersAndDates(body);
    const cs = toks.map((t, i) => claim({ id: `c${i}`, type: t.kind === "date" ? "date" : "amount", true_start: t.start, true_end: t.end }));
    expect(approvalBlockers(reply(body), [...base, ...cs])).toEqual([]);
  });

  it("blocks a bill field with no decided claim", () => {
    const bill: DraftContent = { kind: "bill", bill: { supplier_name: "X", supplier_abn: null, invoice_number: null, invoice_date: null, due_date: null, total_amount: "10.00", gst_amount: null, account_code: null, property: null, bank_bsb: null, bank_account: null, description: null } };
    expect(approvalBlockers(bill, [claim({ field: "supplier_name", type: "name" })])).toContain("Bill field total_amount isn't a decided claim");
  });

  it("end to end: a number typed into the draft becomes an undecided claim the gate catches", async () => {
    const env = await makeEnv();
    const id = await ingest(env, "E01");
    await open(env, id);
    const view = await decideAll(env, id);
    const body = (view.draft.content as Extract<DraftContent, { kind: "reply" }>).reply.body.replace("We've noted this on your file.", "We've noted this on your file, ref 4471.");
    const edited = (await api(env, "PUT", `/api/tasks/${id}/draft`, OP, { kind: "body", body })).json.task as TaskView;
    const ref = edited.claims.find((c) => c.draft_value === "4471");
    expect(ref?.status).toBe("undecided");
    const r = await approveAs(env, id);
    expect(r.json.result.outcome).toBe("blocked");
  });
});

describe("Editing a draft re-extracts claims and new claims start undecided", () => {
  it("keeps decisions on unchanged claims and adds new ones as undecided", async () => {
    const env = await makeEnv();
    const id = await ingest(env, "E02");
    await open(env, id);
    const before = await decideAll(env, id);
    const name = before.claims.find((c) => c.type === "name")!;
    expect(name.status).toBe("confirmed");
    const body = (before.draft.content as Extract<DraftContent, { kind: "reply" }>).reply.body.replace(
      "Kind regards",
      "Your next routine inspection is on Tue 17 Nov 2026. We'll confirm the time a week before.\n\nKind regards",
    );
    const r = await api(env, "PUT", `/api/tasks/${id}/draft`, OP, { kind: "body", body });
    expect(r.status).toBe(200);
    const after = r.json.task as TaskView;
    expect(after.draft.version).toBe(before.draft.version + 1);
    expect(after.claims.find((c) => c.type === "name")!.status).toBe("confirmed");
    const date = after.claims.find((c) => c.type === "date")!;
    expect(date.status).toBe("undecided");
    expect(after.claims.find((c) => c.type === "commitment" && c.status === "undecided")).toBeTruthy();
    // Only the changed claims were sent to the model checker.
    const checks = rows<{ output_json: string }>(env, "SELECT output_json FROM model_calls WHERE task_id = ? AND stage = 'check' ORDER BY created_at, rowid", id);
    const last = JSON.parse(checks[checks.length - 1].output_json);
    expect(last.verdicts.length).toBeLessThan(after.claims.length);
  });

  it("a correction on a bill field creates a new version with that claim corrected", async () => {
    const env = await makeEnv();
    const id = await ingest(env, "B06");
    const view = await open(env, id);
    const supplier = view.claims.find((c) => c.field === "supplier_name")!;
    const r = await api(env, "POST", `/api/tasks/${id}/decisions`, OP, { id: did(), claim_id: supplier.id, action: "correct", value: "Coopers Plumbing (unverified supplier)" });
    expect(r.status).toBe(200);
    const after = r.json.task as TaskView;
    expect(after.draft.version).toBe(2);
    expect(after.claims.find((c) => c.field === "supplier_name")!.status).toBe("corrected");
  });
});

describe("A seeded value can never appear in released output, caught or missed", () => {
  for (const fixture of ["B01", "E02", "E06", "B10"]) {
    it(`${fixture}: missed seeded error is held, then the true draft is released`, async () => {
      const env = await makeEnv({ SEED_MODE: "always" });
      const id = await ingest(env, fixture);
      const canary = rows(env, "SELECT * FROM canaries WHERE task_id = ?", id)[0];
      expect(canary).toBeTruthy();
      await open(env, id);
      // A careless operator: confirms what they see, re-keys by copying the displayed value.
      await decideAll(env, id, OP, { trustDisplay: true });
      const held = await approveAs(env, id);
      expect(held.json.result).toMatchObject({ outcome: "held", missed: { shown: canary.seeded_value, actual: canary.original_value } });
      expect(rows(env, "SELECT outcome FROM canaries WHERE id = ?", canary.id)[0].outcome).toBe("missed");
      expect(JSON.stringify(held.json.task.draft.content)).not.toContain(canary.seeded_value);
      await decideAll(env, id);
      const r = await approveAs(env, id);
      expect(["released", "second_review"]).toContain(r.json.result.outcome);
      if (r.json.result.outcome === "second_review") {
        await decideAll(env, id, LICENSED);
        expect((await approveAs(env, id, LICENSED)).json.result.outcome).toBe("released");
      }
      const out = released(env, id)[0].output_json;
      expect(out).not.toContain(canary.seeded_value);
      expect(out).toContain(canary.original_value);
    });

    it(`${fixture}: caught seeded error restores the true draft and keeps other edits`, async () => {
      const env = await makeEnv({ SEED_MODE: "always" });
      const id = await ingest(env, fixture);
      const canary = rows(env, "SELECT * FROM canaries WHERE task_id = ?", id)[0];
      await open(env, id);
      const view = (await api<TaskView>(env, "GET", `/api/tasks/${id}`, OP)).json;
      const c = view.claims.find((x) => x.id === canary.claim_id)!;
      const res = c.rekey_pending
        ? await api(env, "POST", `/api/tasks/${id}/decisions`, OP, { id: did(), claim_id: c.id, action: "rekey", value: canary.original_value })
        : await api(env, "POST", `/api/tasks/${id}/decisions`, OP, { id: did(), claim_id: c.id, action: "correct", value: canary.original_value });
      expect(res.status).toBe(200);
      expect(res.json.canary).toBe("caught");
      expect(rows(env, "SELECT outcome FROM canaries WHERE id = ?", canary.id)[0].outcome).toBe("caught");
      await decideAll(env, id);
      let r = await approveAs(env, id);
      if (r.json.result.outcome === "second_review") r = await approveAs(env, id, LICENSED);
      expect(r.json.result.outcome).toBe("released");
      const out = released(env, id)[0].output_json;
      expect(out).not.toContain(canary.seeded_value);
    });
  }

  it("a seed on a re-key amount is caught when the operator types the source value", async () => {
    const env = await makeEnv();
    const id = await ingest(env, "B01");
    // Plant the seed on the amount the way the queue stage would.
    const t = rows(env, "SELECT current_draft_id FROM tasks WHERE id = ?", id)[0];
    const claim = rows(env, "SELECT * FROM claims WHERE draft_id = ? AND field = 'total_amount'", t.current_draft_id)[0];
    const content = JSON.parse(rows(env, "SELECT content_json FROM drafts WHERE id = ?", t.current_draft_id)[0].content_json);
    content.bill.total_amount = "1230.00";
    env.DB.raw.prepare("UPDATE drafts SET display_json = ? WHERE id = ?").run(JSON.stringify(content), t.current_draft_id);
    env.DB.raw.prepare("UPDATE claims SET value_display = '1230.00' WHERE id = ?").run(claim.id);
    env.DB.raw
      .prepare("INSERT INTO canaries (id, task_id, draft_id, claim_id, label, original_value, seeded_value, outcome, created_at) VALUES ('cn_t', ?, ?, ?, 'Amount', '1320.00', '1230.00', 'pending', '2026-10-22')")
      .run(id, t.current_draft_id, claim.id);
    await open(env, id);
    const r = await api(env, "POST", `/api/tasks/${id}/decisions`, OP, { id: did(), claim_id: claim.id, action: "rekey", value: "$1,320.00" });
    expect(r.json).toMatchObject({ outcome: "canary_caught", canary: "caught" });
    const after = (r.json.task as TaskView).claims.find((c) => c.id === claim.id)!;
    expect(after).toMatchObject({ status: "confirmed", draft_value: "1320.00" });
    await decideAll(env, id);
    expect((await approveAs(env, id)).json.result.outcome).toBe("released");
    expect(released(env, id)[0].output_json).toContain('"total_amount":"1320.00"');
  });

  it("an operator edit elsewhere keeps the seed out of the true draft", async () => {
    const env = await makeEnv({ SEED_MODE: "always" });
    const id = await ingest(env, "E02");
    const canary = rows(env, "SELECT * FROM canaries WHERE task_id = ?", id)[0];
    const view = await open(env, id);
    // Re-key first so the body can be edited.
    for (const c of view.claims.filter((x) => x.rekey_pending)) {
      const v = rows(env, "SELECT value_display FROM claims WHERE id = ?", c.id)[0].value_display;
      await api(env, "POST", `/api/tasks/${id}/decisions`, OP, { id: did(), claim_id: c.id, action: "rekey", value: v });
    }
    const cur = (await api<TaskView>(env, "GET", `/api/tasks/${id}`, OP)).json;
    const body = (cur.draft.content as Extract<DraftContent, { kind: "reply" }>).reply.body.replace("Thanks for your email.", "Thanks for getting in touch.");
    await api(env, "PUT", `/api/tasks/${id}/draft`, OP, { kind: "body", body });
    const d = rows(env, "SELECT d.content_json FROM tasks t JOIN drafts d ON d.id = t.current_draft_id WHERE t.id = ?", id)[0];
    const live = rows(env, "SELECT outcome FROM canaries WHERE id = ?", canary.id)[0].outcome;
    if (live === "pending") expect(d.content_json).not.toContain(canary.seeded_value);
    expect(d.content_json).toContain("Thanks for getting in touch.");
  });
});

describe("Changed supplier bank details always produce tier 3", () => {
  it("fixture B02 is tier 3 with the bank mismatch flagged", async () => {
    const env = await makeEnv();
    const id = await ingest(env, "B02");
    const t = rows(env, "SELECT tier, tier_reasons_json FROM tasks WHERE id = ?", id)[0];
    expect(t.tier).toBe(3);
    expect(t.tier_reasons_json).toContain("bank_details_changed");
  });

  it("any single-digit change to BSB or account forces tier 3, even under the threshold", () => {
    for (const s of DEMO_REFERENCE.suppliers) {
      for (const which of ["bank_bsb", "bank_account"] as const) {
        const value = which === "bank_bsb" ? s.bsb : s.account;
        const changed = value.replace(/\d(?=\D*$)/, (d) => String((Number(d) + 1) % 10));
        const facts = [
          { id: "1", kind: "party" as const, label: "supplier_name", value: s.name, quote: s.name, span: { start: 0, end: 1 } },
          { id: "2", kind: "amount" as const, label: "total_amount", value: "$10.00", quote: "$10.00", span: { start: 0, end: 1 } },
          { id: "3", kind: "bank" as const, label: "bank_bsb", value: which === "bank_bsb" ? changed : s.bsb, quote: "x", span: { start: 0, end: 1 } },
          { id: "4", kind: "bank" as const, label: "bank_account", value: which === "bank_account" ? changed : s.account, quote: "x", span: { start: 0, end: 1 } },
        ];
        expect(factTierRules("supplier_bill", facts, DEMO_REFERENCE, 500000).tier).toBe(3);
      }
      const same = [
        { id: "1", kind: "party" as const, label: "supplier_name", value: s.name, quote: s.name, span: { start: 0, end: 1 } },
        { id: "3", kind: "bank" as const, label: "bank_bsb", value: s.bsb, quote: "x", span: { start: 0, end: 1 } },
        { id: "4", kind: "bank" as const, label: "bank_account", value: s.account, quote: "x", span: { start: 0, end: 1 } },
      ];
      expect(factTierRules("supplier_bill", same, DEMO_REFERENCE, 500000).tier).toBe(1);
    }
  });

  it("bank details from an unknown supplier force tier 3", () => {
    const facts = [
      { id: "1", kind: "party" as const, label: "supplier_name", value: "Totally New Pty Ltd", quote: "x", span: { start: 0, end: 1 } },
      { id: "3", kind: "bank" as const, label: "bank_bsb", value: "123-456", quote: "x", span: { start: 0, end: 1 } },
    ];
    expect(factTierRules("supplier_bill", facts, DEMO_REFERENCE, 500000).tier).toBe(3);
  });
});

describe("Re-key fields hide the draft value until typed", () => {
  it("bill: amount and dates are absent from the response until re-keyed", async () => {
    const env = await makeEnv();
    const id = await ingest(env, "B01");
    const view = await open(env, id);
    const amount = view.claims.find((c) => c.field === "total_amount")!;
    expect(amount.rekey_pending).toBe(true);
    expect(amount.draft_value).toBeNull();
    expect(amount.source_value).toBeNull();
    const bill = (view.draft.content as Extract<DraftContent, { kind: "bill" }>).bill;
    expect(bill.total_amount).toBeNull();
    expect(bill.invoice_date).toBeNull();
    // The draft value appears nowhere in the draft or claims parts of the response.
    expect(JSON.stringify({ d: view.draft, c: view.claims })).not.toContain("1320.00");
    // Confirming without typing is refused.
    const c = await api(env, "POST", `/api/tasks/${id}/decisions`, OP, { id: did(), claim_id: amount.id, action: "confirm" });
    expect(c.status).toBe(400);
    const r = await api(env, "POST", `/api/tasks/${id}/decisions`, OP, { id: did(), claim_id: amount.id, action: "rekey", value: "$1,320.00" });
    expect(r.json.outcome).toBe("match");
    const after = r.json.task as TaskView;
    expect(after.claims.find((x) => x.field === "total_amount")!.draft_value).toBe("1320.00");
    expect((after.draft.content as Extract<DraftContent, { kind: "bill" }>).bill.total_amount).toBe("1320.00");
  });

  it("reply: the amount is masked in the body and a wrong re-key opens a correction", async () => {
    const env = await makeEnv();
    const id = await ingest(env, "E06");
    const view = await open(env, id);
    const amount = view.claims.find((c) => c.type === "amount")!;
    const body = (view.draft.content as Extract<DraftContent, { kind: "reply" }>).reply.body;
    expect(body).not.toContain("550");
    expect(view.masked_spans).toHaveLength(1);
    expect(body.slice(amount.draft_span!.start, amount.draft_span!.end)).toMatch(/^•+$/);
    // The tenant says $520; typing that from the source doesn't match the draft's $550.00.
    const r = await api(env, "POST", `/api/tasks/${id}/decisions`, OP, { id: did(), claim_id: amount.id, action: "rekey", value: "$520" });
    expect(r.json.outcome).toBe("mismatch");
    const after = (r.json.task as TaskView).claims.find((c) => c.id === amount.id)!;
    expect(after.rekey_mismatch).toBe(true);
    expect(after.draft_value).toBe("$550.00");
    expect(after.checks.some((k) => k.result === "disagree")).toBe(true);
    // A mismatch can't simply be confirmed.
    expect((await api(env, "POST", `/api/tasks/${id}/decisions`, OP, { id: did(), claim_id: amount.id, action: "confirm" })).status).toBe(400);
  });
});

describe("The audit log can rebuild, for any release, who confirmed each claim against which source span and when", () => {
  it("rebuilds every claim's decision chain, including across an edit and a second review", async () => {
    const env = await makeEnv();
    const id = await ingest(env, "B02"); // tier 3: second review
    let view = await open(env, id);
    const supplier = view.claims.find((c) => c.field === "supplier_name")!;
    await api(env, "POST", `/api/tasks/${id}/decisions`, OP, { id: did(), claim_id: supplier.id, action: "confirm", time_ms: 900 });
    const acct = view.claims.find((c) => c.field === "account_code")!;
    await api(env, "POST", `/api/tasks/${id}/decisions`, OP, { id: did(), claim_id: acct.id, action: "correct", value: "6110" });
    view = await decideAll(env, id);
    expect((await approveAs(env, id)).json.result.outcome).toBe("second_review");
    await decideAll(env, id, LEAD);
    const done = await approveAs(env, id, LEAD);
    expect(done.json.result.outcome).toBe("released");
    const releaseId = (done.json.result as { release_id: string }).release_id;
    const rep = await api(env, "GET", `/api/releases/${releaseId}/audit-report`, "patrick@mesquaredagency.com");
    expect(rep.status).toBe(200);
    expect(rep.json.release).toMatchObject({ approved_by: OP, second_reviewer: LEAD });
    for (const c of rep.json.claims) {
      expect(c.decisions.length, c.label).toBeGreaterThan(0);
      for (const d of c.decisions) {
        expect(d.actor).toMatch(/@mesquaredagency\.com$/);
        expect(d.created_at).toMatch(/^2026-/);
      }
      if (c.field !== "account_code") {
        expect(c.source_span, c.label).not.toBeNull();
        expect(c.source_span.text.length).toBeGreaterThan(0);
        expect(c.source_span.page).toBe(1);
      }
    }
    const supplierRec = rep.json.claims.find((c: { field: string }) => c.field === "supplier_name");
    expect(supplierRec.decisions[0]).toMatchObject({ actor: OP, action: "confirm", time_ms: 900 });
    expect(supplierRec.source_span.text).toBe("Brightspark Electrical Pty Ltd");
    // The account code was corrected before an edit; the chain survives the new draft version.
    const acctRec = rep.json.claims.find((c: { field: string }) => c.field === "account_code");
    expect(acctRec.decisions.map((d: { action: string }) => d.action)).toContain("correct");
  });

  it("audit_events is append-only", async () => {
    const env = await makeEnv();
    await ingest(env, "E01");
    expect(() => env.DB.raw.exec("UPDATE audit_events SET actor = 'x'")).toThrow(/append-only/);
    expect(() => env.DB.raw.exec("DELETE FROM audit_events")).toThrow(/append-only/);
  });
});

describe("Instructions planted in a source email don't change the draft's behaviour or trigger any action", () => {
  it("E03: draft ignores the instructions, replies only to the sender, nothing is sent or released", async () => {
    const env = await makeEnv();
    const id = await ingest(env, "E03");
    const t = rows(env, "SELECT tier, tier_reasons_json, status FROM tasks WHERE id = ?", id)[0];
    expect(t.status).toBe("queued");
    expect(t.tier).toBe(3);
    const d = JSON.parse(rows(env, "SELECT d.content_json FROM tasks t JOIN drafts d ON d.id = t.current_draft_id WHERE t.id = ?", id)[0].content_json) as DraftContent;
    expect(d.kind).toBe("reply");
    if (d.kind !== "reply") return;
    expect(d.reply.to).toEqual(["hannah.lee@example.com"]);
    for (const bad of ["quick-refunds", "$200", "BSB", "bank account", "reduced"]) expect(JSON.stringify(d)).not.toContain(bad);
    // Nothing happened beyond the pipeline: no release, no decisions, no extra recipients.
    expect(released(env, id)).toHaveLength(0);
    expect(rows(env, "SELECT COUNT(*) AS n FROM decisions WHERE task_id = ?", id)[0].n).toBe(0);
    const events = rows<{ event: string }>(env, "SELECT event FROM audit_events WHERE task_id = ?", id).map((e) => e.event);
    expect(events).toEqual(expect.arrayContaining(["intake", "queued"]));
    expect(events).not.toContain("released");
    // The drafter never saw the raw email: its logged input is facts only.
    const draftCall = rows(env, "SELECT stage FROM model_calls WHERE task_id = ? AND stage = 'draft'", id);
    expect(draftCall).toHaveLength(1);
  });
});

describe("All 20 fixtures run end to end and the report shows which planted errors the pipeline flagged", () => {
  it("runs every fixture and flags every planted error (offline model)", async () => {
    const env = await makeEnv();
    const results = await runAllFixtures(env);
    expect(results).toHaveLength(answerKeys().length);
    expect(results).toHaveLength(20);
    for (const r of results) {
      expect(r.status, r.key.id).toBe("queued");
      expect(r.tier, `${r.key.id} tier`).toBe(r.key.expected_tier);
      for (const p of r.planted) expect(p.flagged, `${p.id}: ${p.evidence}`).toBe(true);
    }
  });
});

describe("Access, locks and roles", () => {
  it("a task is locked to one operator while open", async () => {
    const env = await makeEnv();
    const id = await ingest(env, "E01");
    await open(env, id, OP);
    const r = await api(env, "POST", `/api/tasks/${id}/open`, OP2);
    expect(r.status).toBe(409);
    // Lock lapses after 15 minutes idle.
    env.CLOCK_NOW = "2026-10-22T01:16:00.000Z";
    expect((await api(env, "POST", `/api/tasks/${id}/open`, OP2)).status).toBe(200);
  });

  it("operators only see assigned clients; auditors are read-only", async () => {
    const env = await makeEnv();
    const id = await ingest(env, "E01");
    env.DB.raw.exec(`DELETE FROM client_assignments WHERE user_email = '${OP2}'`);
    expect((await api(env, "GET", `/api/tasks/${id}`, OP2)).status).toBe(404);
    expect((await api(env, "GET", `/api/tasks/${id}`, "patrick@mesquaredagency.com")).status).toBe(200);
    expect((await api(env, "POST", `/api/tasks/${id}/open`, "patrick@mesquaredagency.com")).status).toBe(403);
  });

  it("only mesquaredagency.com accounts that exist in the console get in", async () => {
    const env = await makeEnv();
    expect((await api(env, "GET", "/api/me", "someone@gmail.com")).status).toBe(403);
    expect((await api(env, "GET", "/api/me", "stranger@mesquaredagency.com")).status).toBe(403);
    expect((await api(env, "GET", "/api/me", null)).status).toBe(401);
    expect((await api(env, "GET", "/api/me", OP)).status).toBe(200);
  });

  it("in production config the dev sign-in header is ignored and file links need a real secret", async () => {
    const env = await makeEnv({ DEV_AUTH: undefined, FILE_URL_SECRET: undefined, ACCESS_TEAM_DOMAIN: "mesquaredagency.cloudflareaccess.com", ACCESS_AUD: "aud" });
    expect((await api(env, "GET", "/api/me", OP)).status).toBe(401);
    expect((await api(env, "POST", "/api/dev/seed", null)).status).toBe(404);
    const { signFileUrl } = await import("../src/lib/auth");
    await expect(signFileUrl(env, "k")).rejects.toThrow(/FILE_URL_SECRET/);
  });

  it("legal notices need a licensed APN reviewer for second review", async () => {
    const env = await makeEnv();
    const id = await ingest(env, "E10");
    await open(env, id);
    await decideAll(env, id);
    expect((await approveAs(env, id)).json.result.outcome).toBe("second_review");
    expect((await approveAs(env, id, LEAD)).status).toBe(403);
    expect((await api(env, "GET", "/api/review/next", LEAD)).json.task).toBeNull();
    expect((await api(env, "GET", "/api/review/next", LICENSED)).json.task.id).toBe(id);
    expect((await approveAs(env, id, LICENSED)).json.result.outcome).toBe("released");
  });

  it("decisions are idempotent on their id (safe to retry after a dropped connection)", async () => {
    const env = await makeEnv();
    const id = await ingest(env, "E01");
    const view = await open(env, id);
    const c = view.claims[0];
    const dec = { id: did(), claim_id: c.id, action: "confirm" };
    expect((await api(env, "POST", `/api/tasks/${id}/decisions`, OP, dec)).status).toBe(200);
    expect((await api(env, "POST", `/api/tasks/${id}/decisions`, OP, dec)).status).toBe(200);
    expect(rows(env, "SELECT COUNT(*) AS n FROM decisions WHERE id = ?", dec.id)[0].n).toBe(1);
  });

  it("flags waiting on approvals default off and can't be switched on in Phase 0", async () => {
    const env = await makeEnv();
    const clients = (await api(env, "GET", "/api/admin/clients", ADMIN)).json;
    expect(clients[0].flags).toMatchObject({ gmail_intake: false, release_send_live: false, seeded_errors: true, second_review_tier3: true, accounting_integration: false, client_verification_report: false, khmer_ui_hints: false });
    for (const f of ["gmail_intake", "release_send_live", "accounting_integration", "client_verification_report"]) {
      expect((await api(env, "PATCH", "/api/admin/clients/apn-demo", ADMIN, { flags: { [f]: true } })).status).toBe(409);
    }
    expect((await api(env, "PATCH", "/api/admin/clients/apn-demo", ADMIN, { flags: { khmer_ui_hints: true } })).status).toBe(200);
    expect((await api(env, "PATCH", "/api/admin/clients/apn-demo", ADMIN, { flags: { sampling: true } })).status).toBe(400);
    expect((await api(env, "POST", "/api/intake/gmail", ADMIN, { client_id: "apn-demo" })).status).toBe(403);
  });

  it("tier 1 items still need every claim decided (no sampling mode)", async () => {
    const env = await makeEnv();
    const id = await ingest(env, "E01");
    expect(rows(env, "SELECT tier FROM tasks WHERE id = ?", id)[0].tier).toBe(1);
    await open(env, id);
    expect((await approveAs(env, id)).json.result.outcome).toBe("blocked");
  });

  it("the queue shows only the next item and rotates task types", async () => {
    const env = await makeEnv();
    const b1 = await ingest(env, "B01");
    await ingest(env, "B10");
    const e1 = await ingest(env, "E01");
    const first = (await api(env, "GET", "/api/queue/next", OP)).json;
    expect(first.task.id).toBe(b1);
    expect(Object.keys(first)).not.toContain("tasks");
    await open(env, b1);
    await decideAll(env, b1);
    await approveAs(env, b1);
    // Just did a bill, so the next item is the email even though another bill was queued first.
    expect((await api(env, "GET", "/api/queue/next", OP)).json.task.id).toBe(e1);
  });

  it("time per claim below the calibrated floor adds the item to the spot-check list", async () => {
    const env = await makeEnv();
    await api(env, "PATCH", "/api/admin/clients/apn-demo", ADMIN, { spot_check_floor_ms: 2000 });
    const id = await ingest(env, "E01");
    await open(env, id);
    await decideAll(env, id); // 1200 ms per claim
    await approveAs(env, id);
    expect((await api(env, "GET", "/api/spot-checks", LEAD)).json).toHaveLength(1);
  });

  it("source files are purged after the retention period; hashes stay", async () => {
    const env = await makeEnv();
    const id = await ingest(env, "B01");
    const { purgeExpiredSources } = await import("../src/index");
    env.CLOCK_NOW = "2027-02-01T00:00:00.000Z";
    await purgeExpiredSources(env);
    const s = rows(env, "SELECT text, content_hash, purged_at FROM source_documents WHERE task_id = ?", id)[0];
    expect(s.text).toBe("");
    expect(s.content_hash).toHaveLength(64);
    expect(s.purged_at).toBeTruthy();
  });
});
