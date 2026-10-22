import { FLAG_DEFAULTS, type FlagName, type Flags } from "@vc/shared";
import { parseJson } from "./db";

export function resolveFlags(flagsJson: string | null | undefined): Flags {
  const overrides = parseJson<Partial<Flags>>(flagsJson, {});
  const out = { ...FLAG_DEFAULTS } as Flags;
  for (const k of Object.keys(FLAG_DEFAULTS) as FlagName[]) if (typeof overrides[k] === "boolean") out[k] = overrides[k]!;
  return out;
}

/** Flags that wait on approvals outside the console. Turning them on is refused in Phase 0. */
export const PHASE_GATED: Partial<Record<FlagName, string>> = {
  gmail_intake: "Phase 1 gate: privacy review done and APN agrees",
  release_send_live: "Phase 2 gate: shadow results reviewed with Patrick, and his sign-off",
  accounting_integration: "Phase 3 gate: APN's software chosen",
  client_verification_report: "Privacy policy approved and client consent",
};
