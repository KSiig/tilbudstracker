/**
 * Ambient module declarations for normalize modules shipped by sibling PRs.
 *
 * The actual `src/normalize/regex.cli.ts` (SII-69, PR #22) and
 * `src/normalize/llm.ts` (SII-73, PR #21) live on higher layers of the M3
 * stack. This PR (`feat/sii-71-handler-integration`, branched off
 * `feat/sii-68-schema-migration`) only owns Pass 1 (bundles). The handler
 * imports the three normalize entry points statically so the import paths
 * match the runtime resolution once the stack lands.
 *
 * At stack-link time the orchestration ordering is:
 *
 *   SII-68 (PR #19) → SII-71+SII-72 (this PR) → SII-69 (PR #22) → SII-73 (PR #21) → SII-70 (PR #20)
 *
 * When PR #22 merges above this one, its `regex.cli.ts` lands at the same
 * path; the same for PR #21's `llm.ts`. The `.d.ts` declarations here are
 * consumed by `tsc --noEmit` in this PR only; they do not affect runtime
 * (they have no `runtime` shape and vitest mocks the modules).
 *
 * This file should be deleted by the time SII-71 is the top of the merged
 * main branch — by then both regex.cli.ts and llm.ts have landed from
 * sibling PRs and the ambient declarations are redundant.
 */

declare module "*/normalize/regex.cli.js" {
  import type { DbClient } from "./db.js";
  export interface NormalizeRegexResult {
    groupsProcessed: number;
    offersNormalized: number;
  }
  export function normalizeRegex(
    db: DbClient
  ): Promise<NormalizeRegexResult>;
}

declare module "*/normalize/llm.js" {
  import type { DbClient } from "./db.js";
  export interface NormalizeLlmResult {
    promptsSent: number;
    clustersCreated: number;
    offersNormalized: number;
    capReached: boolean;
    remainder: number;
  }
  export function normalizeLlm(
    db: DbClient
  ): Promise<NormalizeLlmResult>;
}
