import type {
  BillEntry,
  CheckOutput,
  ClassifyOutput,
  ExtractOutput,
  ListClaimsOutput,
  LocatedFact,
  Playbook,
  ReferenceData,
  ReplyDraft,
  TaskType,
  Tenancy,
} from "@vc/shared";

export type ModelResult<T> = { output: T; model: string; promptVersion: string };

export type DraftReplyInput = {
  facts: LocatedFact[];
  playbook: Playbook;
  tenancy: Tenancy | null;
  senderName: string | null;
  subject: string | null;
  redraftNote: string | null;
};

export type DraftBillInput = {
  facts: LocatedFact[];
  playbook: Playbook;
  reference: ReferenceData;
  redraftNote: string | null;
};

export type CheckInput = {
  taskType: TaskType;
  sourceText: string;
  draftBody: string;
  claims: { id: string; type: string; label: string; text: string }[];
  questions: LocatedFact[]; // offline model uses these; the live model reads the source itself
};

/** One implementation per mode. Each call gets only the inputs its stage is allowed to see. */
export interface StageModel {
  mode: "anthropic" | "offline";
  classify(i: { taskType: TaskType; sourceText: string }): Promise<ModelResult<ClassifyOutput>>;
  extract(i: { taskType: TaskType; sourceText: string }): Promise<ModelResult<ExtractOutput>>;
  draftBill(i: DraftBillInput): Promise<ModelResult<BillEntry>>;
  draftReply(i: DraftReplyInput): Promise<ModelResult<ReplyDraft>>;
  listClaims(i: { body: string; ownNames: string[] }): Promise<ModelResult<ListClaimsOutput>>;
  check(i: CheckInput): Promise<ModelResult<CheckOutput>>;
}
