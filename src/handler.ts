import type { HttpFunction } from "@google-cloud/functions-framework";
import { createDb, D1ClientError, D1TimeoutError, type DbClient } from "./db.js";
import { scrape as scrapeFn, TjekRateLimitError } from "./scrape.js";
import { normalizeBundles } from "./normalize/bundle.cli.js";
import { normalizeRegex } from "./normalize/regex.cli.js";
import { normalizeLlm } from "./normalize/llm.js";

// Cloud Function runtime budget: `--timeout=300s` and scheduler
// `--attempt-deadline=320s`. The LLM pass enforces a per-invocation cap
// (NORMALIZE_LLM_CAP, default 60 — see .env.example for the math) so the
// cumulative runtime stays inside the 300s hard cap on the weekly scheduler.
//
// Weekly-vs-daily invocation marker: the expensive normalize passes
// (Pass 1 → Pass 2 → Pass 3) only fire when the request carries
// `X-Weekly-Normalize: true`. The OIDC identity token still authenticates
// the request; this header is the explicit signal that the weekly
// `tilbudstracker-weekly-normalize` cron (Sunday 06:30 Europe/Copenhagen)
// is calling. The daily `tilbudstracker-daily` cron (06:00) does NOT set
// the header, so it scrapes only and never burns Token Plan quota. See
// the Cloud Scheduler section in README.md for the `--headers` wiring.

/**
 * Classify an error as transient (retryable by the Cloud Scheduler via a
 * non-2xx HTTP status) or permanent (logic bug — keep the 200 response so
 * the rest of the work, e.g. the daily scrape result, still ships).
 *
 * Transient:
 *   - `D1TimeoutError` from a slow D1 REST call (decision B3 / SII-15).
 *   - `D1ClientError` with `retryable=true` (5xx/408/429 from the D1 REST
 *     endpoint, or a network error caught by the D1 client).
 *   - `TypeError` from a stalled or failed fetch (e.g. a MiniMax network
 *     error that bubbles up before normalizeLlm's per-call try/catch).
 *   - `Error` with `name === "AbortError"` — the AbortController timeout
 *     fired (see `clusterHeadings` in llm.ts).
 *
 * Permanent: anything else (parse errors, schema mismatches, logic bugs).
 * Permanent failures are swallowed so a single bad bundle does not abort
 * the response; transient failures re-throw so the outer catch can return
 * a retryable 5xx status.
 */
function isTransientError(err: unknown): boolean {
  if (err instanceof D1TimeoutError) return true;
  if (err instanceof D1ClientError && err.retryable) return true;
  if (err instanceof TypeError) return true;
  if (err instanceof Error && err.name === "AbortError") return true;
  return false;
}

/**
 * Run a normalize pass. Returns `null` on a *permanent* failure so the
 * handler response stays 200 and downstream chain logic can skip subsequent
 * passes (see handler.ts ordering). On a *transient* failure the error is
 * re-thrown so the outer catch can return a retryable 503/500 to Cloud
 * Scheduler. Failures are logged to Cloud Logging via `console.error`.
 */
async function safeNormalize(
  db: DbClient,
  label: string,
  fn: (db: DbClient) => Promise<unknown>
): Promise<unknown | null> {
  try {
    return await fn(db);
  } catch (err) {
    if (isTransientError(err)) {
      console.error(`[normalize] ${label} failed transiently (re-throwing for retry):`, err);
      throw err;
    }
    console.error(`[normalize] ${label} failed permanently (continuing):`, err);
    return null;
  }
}

export const handler: HttpFunction = async (req, res) => {
  // Trace logging: Google's standard trace header. Scheduler sends this on every
  // invocation; do not synthesize a UUID.
  console.info({
    msg: "handler_invoked",
    trace: req.headers["x-cloud-trace-context"] ?? null,
  });

  // Method gate: only POST is accepted.
  if (req.method !== "POST") {
    res.set("Allow", "POST");
    res.status(405).json({ ok: false, error: "method_not_allowed" });
    return;
  }

  // Body/query gate: the handler has no use for either; reject anything other
  // than an empty POST to keep the request envelope small and to avoid body-
  // bombing surprises.
  //
  // Cloud Functions Gen 2 + the underlying Express adapter populates
  // `req.body = {}` for POSTs with `Content-Length: 0` (the shape Cloud
  // Scheduler sends). Functions Framework locally leaves `req.body` as
  // undefined or an empty string. Accept any of {undefined, null, "", empty
  // Buffer, {}} as "empty" so the cron and curl-no-data both pass.
  const isEmptyBody =
    req.body === undefined ||
    req.body === null ||
    (typeof req.body === "string" && req.body.length === 0) ||
    (Buffer.isBuffer(req.body) && req.body.length === 0) ||
    (typeof req.body === "object" &&
      !Array.isArray(req.body) &&
      Object.keys(req.body).length === 0);
  if (!isEmptyBody) {
    res.status(400).json({ ok: false, error: "body and query must be empty" });
    return;
  }
  // The underlying http parser populates req.url with query string. We treat any
  // non-empty query as bad input.
  const url = req.url ?? "/";
  const queryIndex = url.indexOf("?");
  if (queryIndex !== -1 && queryIndex < url.length - 1) {
    res.status(400).json({ ok: false, error: "body and query must be empty" });
    return;
  }

  const db = await createDb("d1");
  try {
    let result: Awaited<ReturnType<typeof scrapeFn>>;
    try {
      result = await scrapeFn(db);
    } catch (err) {
      // In-handler retry: once on retryable D1ClientError (decision B1).
      if (err instanceof D1ClientError && err.retryable) {
        try {
          result = await scrapeFn(db);
        } catch (retryErr) {
          throw retryErr;
        }
      } else {
        throw err;
      }
    }

    // M3 — Heading Normalization (SII-71): run all three passes in order
    // (Pass 1 → Pass 2 → Pass 3), but ONLY when the weekly marker header is
    // set. The daily cron omits the header, so it gets scrape-only and never
    // burns Token Plan quota. The weekly cron sets the header and triggers
    // the full normalization suite. Per Decision P1+P2, the handler runs
    // all three passes when invoked weekly.
    //
    // Pass chain (Pass 1 → Pass 2 → Pass 3) is enforced because each
    // downstream pass depends on the upstream pass having succeeded:
    //   - Pass 2 (regex) filters `is_split = 0`, which includes the
    //     bundle-spawned per-product rows created by Pass 1. If Pass 1
    //     failed, Pass 2 would normalize un-split bundles as singletons.
    //   - Pass 3 (LLM) depends on Pass 2 having claimed the easy groups so
    //     the LLM is not called on offers already normalized.
    // A transient failure re-throws through `safeNormalize` and the outer
    // catch surfaces a retryable 5xx; a permanent failure returns `null`
    // and the chain aborts (downstream passes are skipped) without a 5xx.
    const normalizeRequested =
      req.headers["x-weekly-normalize"] === "true";
    let pass1: unknown | null = null;
    let pass2: unknown | null = null;
    let pass3: unknown | null = null;
    if (normalizeRequested) {
      pass1 = await safeNormalize(db, "pass1 (bundles)", (db) => normalizeBundles(db));
      if (pass1 !== null) {
        pass2 = await safeNormalize(db, "pass2 (regex)", (db) => normalizeRegex(db));
        if (pass2 !== null) {
          pass3 = await safeNormalize(db, "pass3 (llm)", (db) => normalizeLlm(db));
        }
      }
    }

    res.status(200).json({
      ok: true,
      newCatalogs: result.newCatalogs,
      newOffers: result.newOffers,
      tracked: result.tracked,
      normalize: { pass1, pass2, pass3, weeklyRequested: normalizeRequested },
    });
  } catch (err) {
    if (err instanceof TjekRateLimitError) {
      res.set("Retry-After", "60");
      res.status(503).json({ ok: false, error: "rate_limited" });
      return;
    }
    if (err instanceof D1TimeoutError) {
      res.set("Retry-After", "30");
      res.status(503).json({ ok: false, error: "d1_timeout" });
      return;
    }
    if (isTransientError(err)) {
      // Normalize passes threw a transient error (network / MiniMax abort /
      // retryable D1). Surface a retryable 5xx so Cloud Scheduler retries
      // the weekly job — without this, the scheduler would see a 200 with
      // passN=null and consider the run successful.
      res.set("Retry-After", "60");
      res.status(503).json({
        ok: false,
        error: "normalize_transient",
        cause: err instanceof Error ? err.message : String(err),
      });
      return;
    }
    res.status(500).json({
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
  } finally {
    await db.close();
  }
};
