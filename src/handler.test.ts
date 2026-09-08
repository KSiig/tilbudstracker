import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";

// Mocks must be registered before importing the handler.
vi.mock("./scrape.js", () => ({
  scrape: vi.fn(),
  TjekRateLimitError: class TjekRateLimitError extends Error {
    constructor(message: string) {
      super(message);
      this.name = "TjekRateLimitError";
    }
  },
}));

vi.mock("./db.js", () => {
  class D1ClientError extends Error {
    constructor(
      message: string,
      public retryable: boolean,
      public status?: number
    ) {
      super(message);
      this.name = "D1ClientError";
    }
  }
  class D1TimeoutError extends Error {
    constructor(message: string) {
      super(message);
      this.name = "D1TimeoutError";
    }
  }
  return {
    createDb: vi.fn(),
    D1ClientError,
    D1TimeoutError,
  };
});

vi.mock("./normalize/bundle.cli.js", () => ({
  normalizeBundles: vi.fn(),
}));

vi.mock("./normalize/regex.cli.js", () => ({
  normalizeRegex: vi.fn(),
}));

vi.mock("./normalize/llm.js", () => ({
  normalizeLlm: vi.fn(),
}));

import { handler } from "./handler.js";
import { scrape, TjekRateLimitError } from "./scrape.js";
import { createDb, D1ClientError, D1TimeoutError } from "./db.js";
import { normalizeBundles } from "./normalize/bundle.cli.js";
import { normalizeRegex } from "./normalize/regex.cli.js";
import { normalizeLlm } from "./normalize/llm.js";

class FakeRes {
  headers: Record<string, string> = {};
  statusCode = 200;
  body: any = undefined;
  set(name: string, value: string) {
    this.headers[name.toLowerCase()] = value;
    return this;
  }
  status(code: number) {
    this.statusCode = code;
    return this;
  }
  json(payload: any) {
    this.body = payload;
    return this;
  }
  send() {
    return this;
  }
}

function makeReq(opts: {
  method?: string;
  url?: string;
  body?: any;
  headers?: Record<string, string>;
  weekly?: boolean;
} = {}) {
  // Default to weekly mode so existing happy-path tests still exercise the
  // normalize passes. Pass `weekly: false` to simulate the daily cron
  // (header omitted → passes skipped). Explicit caller headers always win
  // so tests can also exercise non-default header values like "false".
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  if (opts.weekly !== false && !("x-weekly-normalize" in headers)) {
    headers["x-weekly-normalize"] = "true";
  }
  return {
    method: opts.method ?? "POST",
    url: opts.url ?? "/",
    body: opts.body ?? "",
    headers,
  } as any;
}

const closeMock = vi.fn().mockResolvedValue(undefined);

const PASS1_RESULT = { bundlesDetected: 2, newOffersCreated: 6 };
const PASS2_RESULT = { groupsProcessed: 3, offersNormalized: 12 };
const PASS3_RESULT = {
  promptsSent: 5,
  clustersCreated: 4,
  offersNormalized: 9,
  capReached: false,
  remainder: 0,
};

beforeEach(() => {
  vi.resetAllMocks();
  closeMock.mockClear();
  (createDb as any).mockResolvedValue({ close: closeMock });
  (scrape as any).mockResolvedValue({
    newCatalogs: 1,
    newOffers: 2,
    tracked: 1,
  });
  (normalizeBundles as any).mockResolvedValue(PASS1_RESULT);
  (normalizeRegex as any).mockResolvedValue(PASS2_RESULT);
  (normalizeLlm as any).mockResolvedValue(PASS3_RESULT);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("handler — happy path", () => {
  it("POST + scrape resolves with counts → 200 JSON including normalize block", async () => {
    const req = makeReq();
    const res = new FakeRes();
    await handler(req, res as any);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      ok: true,
      newCatalogs: 1,
      newOffers: 2,
      tracked: 1,
      normalize: {
        pass1: PASS1_RESULT,
        pass2: PASS2_RESULT,
        pass3: PASS3_RESULT,
        weeklyRequested: true,
      },
    });
    expect(closeMock).toHaveBeenCalledTimes(1);
    expect(createDb).toHaveBeenCalledWith("d1");
    expect(normalizeBundles).toHaveBeenCalledTimes(1);
    expect(normalizeRegex).toHaveBeenCalledTimes(1);
    expect(normalizeLlm).toHaveBeenCalledTimes(1);
  });

  it("runs normalize passes in order: pass1 (bundles) → pass2 (regex) → pass3 (llm)", async () => {
    const callOrder: string[] = [];
    (normalizeBundles as any).mockImplementation(async () => {
      callOrder.push("pass1");
      return PASS1_RESULT;
    });
    (normalizeRegex as any).mockImplementation(async () => {
      callOrder.push("pass2");
      return PASS2_RESULT;
    });
    (normalizeLlm as any).mockImplementation(async () => {
      callOrder.push("pass3");
      return PASS3_RESULT;
    });

    await handler(makeReq(), new FakeRes() as any);
    expect(callOrder).toEqual(["pass1", "pass2", "pass3"]);
  });
});

describe("handler — request validation", () => {
  it("GET → 405 and Allow: POST", async () => {
    const req = makeReq({ method: "GET" });
    const res = new FakeRes();
    await handler(req, res as any);
    expect(res.statusCode).toBe(405);
    expect(res.headers["allow"]).toBe("POST");
    expect(scrape).not.toHaveBeenCalled();
  });

  it("POST + body 'junk' → 400", async () => {
    const req = makeReq({ body: "junk" });
    const res = new FakeRes();
    await handler(req, res as any);
    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({
      ok: false,
      error: "body and query must be empty",
    });
    expect(scrape).not.toHaveBeenCalled();
  });

  it("POST + body {} (Cloud Scheduler / Cloud Functions Gen 2 shape) → 200", async () => {
    (scrape as any).mockResolvedValue({
      newCatalogs: 0,
      newOffers: 0,
      tracked: 0,
    });
    const req = makeReq({ body: {} });
    const res = new FakeRes();
    await handler(req, res as any);
    expect(res.statusCode).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.normalize).toEqual({
      pass1: PASS1_RESULT,
      pass2: PASS2_RESULT,
      pass3: PASS3_RESULT,
      weeklyRequested: true,
    });
    expect(scrape).toHaveBeenCalledTimes(1);
  });

  it("POST + body null (raw HTTP/2 frame with no body) → 200", async () => {
    (scrape as any).mockResolvedValue({
      newCatalogs: 0,
      newOffers: 0,
      tracked: 0,
    });
    const req = makeReq({ body: null });
    const res = new FakeRes();
    await handler(req, res as any);
    expect(res.statusCode).toBe(200);
    expect(scrape).toHaveBeenCalledTimes(1);
  });

  it("POST + query string → 400", async () => {
    const req = makeReq({ url: "/?x=1" });
    const res = new FakeRes();
    await handler(req, res as any);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBe("body and query must be empty");
    expect(scrape).not.toHaveBeenCalled();
  });
});

describe("handler — error classification", () => {
  it("TjekRateLimitError → 503 + Retry-After: 60 + rate_limited", async () => {
    (scrape as any).mockRejectedValue(new TjekRateLimitError("429"));
    const res = new FakeRes();
    await handler(makeReq(), res as any);
    expect(res.statusCode).toBe(503);
    expect(res.headers["retry-after"]).toBe("60");
    expect(res.body).toEqual({ ok: false, error: "rate_limited" });
    expect(closeMock).toHaveBeenCalledTimes(1);
  });

  it("D1TimeoutError → 503 + Retry-After: 30 + d1_timeout", async () => {
    (scrape as any).mockRejectedValue(new D1TimeoutError("timeout"));
    const res = new FakeRes();
    await handler(makeReq(), res as any);
    expect(res.statusCode).toBe(503);
    expect(res.headers["retry-after"]).toBe("30");
    expect(res.body).toEqual({ ok: false, error: "d1_timeout" });
    expect(closeMock).toHaveBeenCalledTimes(1);
  });

  it("D1ClientError(retryable) once then success → 200, scrape called twice", async () => {
    (scrape as any)
      .mockRejectedValueOnce(
        new D1ClientError("net", true)
      )
      .mockResolvedValueOnce({ newCatalogs: 0, newOffers: 0, tracked: 0 });
    const res = new FakeRes();
    await handler(makeReq(), res as any);
    expect(res.statusCode).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(scrape).toHaveBeenCalledTimes(2);
    expect(closeMock).toHaveBeenCalledTimes(1);
  });

  it("D1ClientError(retryable) twice → 503 + Retry-After, cause in body, close once", async () => {
    // The retryable D1ClientError is classified as a transient failure by
    // `isTransientError` in handler.ts, so the outer catch returns a
    // retryable 503 with Retry-After: 60 — a more accurate signal than 500
    // for the Cloud Scheduler. The body still carries the underlying cause.
    const second = new D1ClientError("net2", true);
    (scrape as any)
      .mockRejectedValueOnce(new D1ClientError("net1", true))
      .mockRejectedValueOnce(second);
    const res = new FakeRes();
    await handler(makeReq(), res as any);
    expect(res.statusCode).toBe(503);
    expect(res.headers["retry-after"]).toBe("60");
    expect(res.body.error).toBe("normalize_transient");
    expect(String(res.body.cause)).toContain("net2");
    expect(scrape).toHaveBeenCalledTimes(2);
    expect(closeMock).toHaveBeenCalledTimes(1);
  });

  it("D1ClientError(non-retryable) → 500 without retry", async () => {
    (scrape as any).mockRejectedValue(
      new D1ClientError("bad", false)
    );
    const res = new FakeRes();
    await handler(makeReq(), res as any);
    expect(res.statusCode).toBe(500);
    expect(String(res.body.error)).toContain("bad");
    expect(scrape).toHaveBeenCalledTimes(1);
  });

  it("plain Error → 500 with message in body", async () => {
    (scrape as any).mockRejectedValue(new Error("boom"));
    const res = new FakeRes();
    await handler(makeReq(), res as any);
    expect(res.statusCode).toBe(500);
    expect(res.body.error).toBe("boom");
    expect(closeMock).toHaveBeenCalledTimes(1);
  });
});

describe("handler — normalize passes (SII-71)", () => {
  it("response includes normalize: { pass1, pass2, pass3 } on success", async () => {
    const res = new FakeRes();
    await handler(makeReq(), res as any);
    expect(res.statusCode).toBe(200);
    expect(res.body.normalize).toEqual({
      pass1: PASS1_RESULT,
      pass2: PASS2_RESULT,
      pass3: PASS3_RESULT,
      weeklyRequested: true,
    });
  });

  it("normalize pass1 fails permanently → pass1 is null, chain aborts, pass2/pass3 NOT called, response is 200", async () => {
    // Pass chain (Pass 1 → Pass 2 → Pass 3): a permanent failure on Pass 1
    // returns null and the chain aborts — Pass 2's `WHERE is_split = 0`
    // filter includes un-split bundle rows that would otherwise fold as
    // singletons, so Pass 2 must be skipped. Same reasoning for Pass 3.
    (normalizeBundles as any).mockRejectedValue(new Error("bundles boom"));
    const res = new FakeRes();
    await handler(makeReq(), res as any);
    expect(res.statusCode).toBe(200);
    expect(res.body.normalize.pass1).toBeNull();
    expect(res.body.normalize.pass2).toBeNull();
    expect(res.body.normalize.pass3).toBeNull();
    expect(normalizeBundles).toHaveBeenCalledTimes(1);
    expect(normalizeRegex).not.toHaveBeenCalled();
    expect(normalizeLlm).not.toHaveBeenCalled();
  });

  it("normalize pass2 fails permanently → pass2 is null, chain aborts, pass3 NOT called, response is 200", async () => {
    (normalizeRegex as any).mockRejectedValue(new Error("regex boom"));
    const res = new FakeRes();
    await handler(makeReq(), res as any);
    expect(res.statusCode).toBe(200);
    expect(res.body.normalize.pass1).toEqual(PASS1_RESULT);
    expect(res.body.normalize.pass2).toBeNull();
    expect(res.body.normalize.pass3).toBeNull();
    expect(normalizeBundles).toHaveBeenCalledTimes(1);
    expect(normalizeRegex).toHaveBeenCalledTimes(1);
    expect(normalizeLlm).not.toHaveBeenCalled();
  });

  it("normalize pass3 throws → pass3 is null, pass1/pass2 still run, response is 200", async () => {
    (normalizeLlm as any).mockRejectedValue(new Error("llm boom"));
    const res = new FakeRes();
    await handler(makeReq(), res as any);
    expect(res.statusCode).toBe(200);
    expect(res.body.normalize.pass1).toEqual(PASS1_RESULT);
    expect(res.body.normalize.pass2).toEqual(PASS2_RESULT);
    expect(res.body.normalize.pass3).toBeNull();
    expect(normalizeBundles).toHaveBeenCalledTimes(1);
    expect(normalizeRegex).toHaveBeenCalledTimes(1);
  });

  it("all normalize passes throw → all three are null, response is 200, scrape counts still present", async () => {
    (normalizeBundles as any).mockRejectedValue(new Error("p1"));
    (normalizeRegex as any).mockRejectedValue(new Error("p2"));
    (normalizeLlm as any).mockRejectedValue(new Error("p3"));
    const res = new FakeRes();
    await handler(makeReq(), res as any);
    expect(res.statusCode).toBe(200);
    expect(res.body.normalize).toEqual({
      pass1: null,
      pass2: null,
      pass3: null,
      weeklyRequested: true,
    });
    expect(res.body.newCatalogs).toBe(1);
    expect(res.body.newOffers).toBe(2);
    expect(res.body.tracked).toBe(1);
  });

  it("pass1 throws transient (D1ClientError retryable) → 503 + Retry-After, chain aborts, pass2/pass3 NOT called", async () => {
    // Finding #1+#2: transient normalize failures surface 503 so Cloud
    // Scheduler retries. The chain also aborts — pass2/pass3 must not run
    // when pass1 failed because their inputs depend on pass1 having
    // succeeded.
    (normalizeBundles as any).mockRejectedValue(new D1ClientError("d1 lock", true));
    const res = new FakeRes();
    await handler(makeReq(), res as any);
    expect(res.statusCode).toBe(503);
    expect(res.headers["retry-after"]).toBe("60");
    expect(res.body.error).toBe("normalize_transient");
    expect(String(res.body.cause)).toContain("d1 lock");
    expect(normalizeBundles).toHaveBeenCalledTimes(1);
    expect(normalizeRegex).not.toHaveBeenCalled();
    expect(normalizeLlm).not.toHaveBeenCalled();
    expect(closeMock).toHaveBeenCalledTimes(1);
  });

  it("pass2 throws transient (D1TimeoutError) → 503 + Retry-After: 30, chain aborts, pass3 NOT called", async () => {
    // D1TimeoutError is mapped to the dedicated `d1_timeout` 503 status
    // (decision B3 / SII-15), so this surfaces with Retry-After: 30.
    (normalizeRegex as any).mockRejectedValue(new D1TimeoutError("d1 timeout"));
    const res = new FakeRes();
    await handler(makeReq(), res as any);
    expect(res.statusCode).toBe(503);
    expect(res.headers["retry-after"]).toBe("30");
    expect(res.body.error).toBe("d1_timeout");
    expect(normalizeBundles).toHaveBeenCalledTimes(1);
    expect(normalizeRegex).toHaveBeenCalledTimes(1);
    expect(normalizeLlm).not.toHaveBeenCalled();
    expect(closeMock).toHaveBeenCalledTimes(1);
  });

  it("pass3 throws transient (TypeError / fetch failure) → 503 + Retry-After: 60, pass1/pass2 already ran", async () => {
    // TypeError is treated as transient (network errors surface that way).
    (normalizeLlm as any).mockRejectedValue(new TypeError("fetch failed"));
    const res = new FakeRes();
    await handler(makeReq(), res as any);
    expect(res.statusCode).toBe(503);
    expect(res.headers["retry-after"]).toBe("60");
    expect(res.body.error).toBe("normalize_transient");
    expect(String(res.body.cause)).toContain("fetch failed");
    expect(normalizeBundles).toHaveBeenCalledTimes(1);
    expect(normalizeRegex).toHaveBeenCalledTimes(1);
    expect(normalizeLlm).toHaveBeenCalledTimes(1);
    expect(closeMock).toHaveBeenCalledTimes(1);
  });

  it("pass3 throws transient (AbortError from clusterHeadings timeout) → 503 + Retry-After: 60", async () => {
    // AbortError is treated as transient (an AbortController timeout fired
    // inside clusterHeadings; the LLM call was aborted, not a logic bug).
    (normalizeLlm as any).mockRejectedValue(
      Object.assign(new Error("aborted"), { name: "AbortError" }),
    );
    const res = new FakeRes();
    await handler(makeReq(), res as any);
    expect(res.statusCode).toBe(503);
    expect(res.headers["retry-after"]).toBe("60");
    expect(res.body.error).toBe("normalize_transient");
    expect(closeMock).toHaveBeenCalledTimes(1);
  });

  it("scrape failure still skips all normalize passes (error path unchanged)", async () => {
    (scrape as any).mockRejectedValue(new Error("scrape boom"));
    const res = new FakeRes();
    await handler(makeReq(), res as any);
    expect(res.statusCode).toBe(500);
    expect(res.body.error).toBe("scrape boom");
    expect(normalizeBundles).not.toHaveBeenCalled();
    expect(normalizeRegex).not.toHaveBeenCalled();
    expect(normalizeLlm).not.toHaveBeenCalled();
  });

  it("daily cron (no X-Weekly-Normalize header) skips all 3 normalize passes and does not call the CLIs", async () => {
    // Finding #2: the daily scrape cron must NOT burn Token Plan quota by
    // triggering the expensive normalize passes. Only the weekly cron sets
    // X-Weekly-Normalize: true.
    (scrape as any).mockResolvedValue({
      newCatalogs: 1,
      newOffers: 2,
      tracked: 1,
    });
    const res = new FakeRes();
    await handler(makeReq({ weekly: false }), res as any);
    expect(res.statusCode).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.normalize).toEqual({
      pass1: null,
      pass2: null,
      pass3: null,
      weeklyRequested: false,
    });
    expect(normalizeBundles).not.toHaveBeenCalled();
    expect(normalizeRegex).not.toHaveBeenCalled();
    expect(normalizeLlm).not.toHaveBeenCalled();
  });

  it("X-Weekly-Normalize: false is also treated as daily (not weekly)", async () => {
    // The header must be the literal string "true" to enable the weekly
    // path. Anything else (false, missing, "1", "yes") is treated as the
    // daily path so a misconfigured cron doesn't silently burn quota.
    const res = new FakeRes();
    await handler(
      makeReq({ headers: { "x-weekly-normalize": "false" } }),
      res as any
    );
    expect(res.body.normalize.weeklyRequested).toBe(false);
    expect(normalizeBundles).not.toHaveBeenCalled();
    expect(normalizeRegex).not.toHaveBeenCalled();
    expect(normalizeLlm).not.toHaveBeenCalled();
  });
});

describe("handler — trace logging", () => {
  it("logs handler_invoked with trace header", async () => {
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    (scrape as any).mockResolvedValue({ newCatalogs: 0, newOffers: 0, tracked: 0 });
    await handler(
      makeReq({ headers: { "x-cloud-trace-context": "trace/abc/123" } }),
      new FakeRes() as any
    );
    expect(infoSpy).toHaveBeenCalledWith({
      msg: "handler_invoked",
      trace: "trace/abc/123",
    });
  });

  it("logs handler_invoked with trace null when header missing", async () => {
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    (scrape as any).mockResolvedValue({ newCatalogs: 0, newOffers: 0, tracked: 0 });
    await handler(makeReq(), new FakeRes() as any);
    expect(infoSpy).toHaveBeenCalledWith({
      msg: "handler_invoked",
      trace: null,
    });
  });
});
