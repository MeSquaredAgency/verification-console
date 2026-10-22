export type PipelineStage = "classify" | "extract" | "draft" | "claims" | "check" | "queue";
export type PipelineMessage = { taskId: string; stage: PipelineStage };

export type Env = {
  DB: D1Database;
  FILES: R2Bucket;
  PIPELINE: Queue<PipelineMessage>;
  /** Worker secret. When unset the pipeline runs on the deterministic offline model. */
  ANTHROPIC_API_KEY?: string;
  /** "anthropic" or "offline"; defaults to anthropic when a key is set. */
  MODEL_MODE?: string;
  /** "1" lets local dev sign in with an X-Dev-User header. Never set in production. */
  DEV_AUTH?: string;
  /** Cloudflare Access team domain, e.g. mesquared.cloudflareaccess.com */
  ACCESS_TEAM_DOMAIN?: string;
  /** Cloudflare Access application AUD tag. */
  ACCESS_AUD?: string;
  ALLOWED_EMAIL_DOMAIN?: string;
  /** Secret used to sign short-lived file URLs. */
  FILE_URL_SECRET?: string;
  /** Fixed clock for tests and fixture runs (ISO timestamp). */
  CLOCK_NOW?: string;
  /** Test hook for seeded errors: "always" or "never"; unset uses the client's rate. */
  SEED_MODE?: string;
};

export type Actor = {
  email: string;
  name: string;
  role: "operator" | "senior" | "admin" | "auditor";
  licensed_apn: boolean;
};

export type AppEnv = { Bindings: Env; Variables: { actor: Actor } };
