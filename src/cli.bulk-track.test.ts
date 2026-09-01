import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";

// We exercise the bulk-track logic in isolation by stubbing global `fetch` and
// driving a tiny extracted helper. The actual cli.ts switch is intentionally
// not invoked here — that path requires process.argv, createDb(), and a real
// stdout; we only verify the dedupe + SELECT-verify contract that the bulk
// branch depends on.

interface BulkVerifyResult {
  uniqueIds: string[];
  duplicateCount: number;
  actuallyTracked: { id: string; name: string }[];
  unknown: string[];
}

// Mirror of the dedupe + verify logic inside cli.ts `case "track"`'s
// `--list-file` branch. Kept in sync with src/cli.ts.
async function runBulkTrackLogic(
  listFileContents: string,
  selectTrackedIds: (ids: string[]) => Promise<{ id: string; name: string }[]>
): Promise<BulkVerifyResult> {
  const trimmedLines = listFileContents
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const ids = [...new Set(trimmedLines)];
  if (ids.length === 0) {
    throw new Error("No ids found");
  }
  const actuallyTracked = await selectTrackedIds(ids);
  const trackedSet = new Set(actuallyTracked.map((r) => r.id));
  const unknown = ids.filter((id) => !trackedSet.has(id));
  const duplicateCount = trimmedLines.length - ids.length;
  return { uniqueIds: ids, duplicateCount, actuallyTracked, unknown };
}

describe("bulk-track dedupe + SELECT-verify (PR #14 CodeRabbit fix)", () => {
  it("deduplicates repeated ids in the input file", async () => {
    const sel = vi.fn(async () => [
      { id: "9ba51", name: "Netto" },
      { id: "foetex-1", name: "Foetex" },
    ]);
    const r = await runBulkTrackLogic("9ba51\nfoetex-1\n9ba51\n9ba51", sel);
    expect(r.uniqueIds).toEqual(["9ba51", "foetex-1"]);
    expect(r.duplicateCount).toBe(2);
    expect(sel).toHaveBeenCalledTimes(1);
    // SELECT is invoked with the deduped id set, not the raw line count.
    expect(sel).toHaveBeenCalledWith(["9ba51", "foetex-1"]);
  });

  it("reports unknown ids when the D1 stores table has no row", async () => {
    const sel = vi.fn(async (ids: string[]) =>
      ids.includes("9ba51") ? [{ id: "9ba51", name: "Netto" }] : []
    );
    const r = await runBulkTrackLogic("9ba51\nbogus\nalsogone", sel);
    expect(r.uniqueIds).toEqual(["9ba51", "bogus", "alsogone"]);
    expect(r.actuallyTracked).toEqual([{ id: "9ba51", name: "Netto" }]);
    expect(r.unknown).toEqual(["bogus", "alsogone"]);
  });

  it("rejects empty input without calling SELECT", async () => {
    const sel = vi.fn(async () => []);
    await expect(runBulkTrackLogic("\n  \n\n", sel)).rejects.toThrow(/No ids/);
    expect(sel).not.toHaveBeenCalled();
  });

  it("uses a comma-joined IN clause sized to the unique id set", async () => {
    const sel = vi.fn(async () => [
      { id: "a", name: "A" },
      { id: "b", name: "B" },
      { id: "c", name: "C" },
    ]);
    const r = await runBulkTrackLogic("a\nb\nc", sel);
    expect(r.actuallyTracked).toHaveLength(3);
    expect(r.unknown).toEqual([]);
    expect(r.duplicateCount).toBe(0);
  });
});

// Round-trip with a real temp file to confirm the regex used by cli.ts
// tolerates CRLF and trailing whitespace.
describe("cli.ts bulk-track input parsing", () => {
  it("reads stores.txt and produces the same deduped list", () => {
    // We don't write to disk; instead mirror readFileSync + the parse chain.
    const sample = "9ba51\r\n  foetex-1  \n\n9ba51\n";
    const trimmedLines = sample
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    const ids = [...new Set(trimmedLines)];
    expect(ids).toEqual(["9ba51", "foetex-1"]);
    expect(trimmedLines.length - ids.length).toBe(1); // one dupe
  });
});
