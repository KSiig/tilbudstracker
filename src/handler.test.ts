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

import { handler } from "./handler.js";
import { scrape, TjekRateLimitError } from "./scrape.js";
import { createDb, D1ClientError, D1TimeoutError } from "./db.js";

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
} = {}) {
  return {
    method: opts.method ?? "POST",
    url: opts.url ?? "/",
    body: opts.body ?? "",
    headers: opts.headers ?? {},
  } as any;
}

const closeMock = vi.fn().mockResolvedValue(undefined);

beforeEach(() => {
  vi.resetAllMocks();
  closeMock.mockClear();
  (createDb as any).mockResolvedValue({ close: closeMock });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("handler — happy path", () => {
  it("POST + scrape resolves with counts → 200 JSON", async () => {
    (scrape as any).mockResolvedValue({
      newCatalogs: 1,
      newOffers: 2,
      tracked: 1,
    });
    const req = makeReq();
    const res = new FakeRes();
    await handler(req, res as any);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      ok: true,
      newCatalogs: 1,
      newOffers: 2,
      tracked: 1,
    });
    expect(closeMock).toHaveBeenCalledTimes(1);
    expect(createDb).toHaveBeenCalledWith("d1");
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

  it("D1ClientError(retryable) twice → 500, second error in body, close once", async () => {
    const second = new D1ClientError("net2", true);
    (scrape as any)
      .mockRejectedValueOnce(new D1ClientError("net1", true))
      .mockRejectedValueOnce(second);
    const res = new FakeRes();
    await handler(makeReq(), res as any);
    expect(res.statusCode).toBe(500);
    expect(String(res.body.error)).toContain("net2");
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
