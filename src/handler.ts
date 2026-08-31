import type { HttpFunction } from "@google-cloud/functions-framework";
import { createDb, D1ClientError, D1TimeoutError } from "./db.js";
import { scrape as scrapeFn, TjekRateLimitError } from "./scrape.js";

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
  const hasBody = !!req.body && !(Buffer.isBuffer(req.body) && req.body.length === 0);
  if (hasBody) {
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

    res.status(200).json({
      ok: true,
      newCatalogs: result.newCatalogs,
      newOffers: result.newOffers,
      tracked: result.tracked,
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
    res.status(500).json({
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
  } finally {
    await db.close();
  }
};
