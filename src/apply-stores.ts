import { createDb } from "./db.js";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const mdPath = path.resolve(__dirname, "..", "stores.md");
const content = readFileSync(mdPath, "utf-8");

const checked = new Set<string>();
const unchecked = new Set<string>();

for (const line of content.split("\n")) {
  const match = line.match(/^- \[([ xX])\] .+\(`([^`]+)`\)/);
  if (!match) continue;
  const isChecked = match[1].toLowerCase() === "x";
  const id = match[2];
  if (isChecked) checked.add(id);
  else unchecked.add(id);
}

const db = await createDb("sqlite");

// Snapshot isTracked state before applying updates so we can report what
// actually changed (decision E7).
const beforeRows = await db.all<{ id: string; isTracked: number }>(
  "SELECT id, isTracked FROM stores"
);
const before = new Map(beforeRows.map((r) => [r.id, r.isTracked]));

const statements = [
  ...Array.from(checked).map((id) => ({
    sql: "UPDATE stores SET isTracked = 1 WHERE id = ?",
    params: [id],
  })),
  ...Array.from(unchecked).map((id) => ({
    sql: "UPDATE stores SET isTracked = 0 WHERE id = ?",
    params: [id],
  })),
];

await db.batch(statements);

const afterRows = await db.all<{ id: string; isTracked: number }>(
  "SELECT id, isTracked FROM stores"
);

let newlyTracked = 0;
let newlyUntracked = 0;
for (const row of afterRows) {
  const prev = before.get(row.id);
  if (prev === undefined) continue; // store not yet known; not a "change"
  if (prev === row.isTracked) continue;
  if (row.isTracked === 1) newlyTracked++;
  else newlyUntracked++;
}

const totalTracked = (
  await db.get<{ c: number }>(
    "SELECT COUNT(*) as c FROM stores WHERE isTracked = 1"
  )
)!.c;

console.log(
  `requested: ${checked.size + unchecked.size}, newly_tracked: ${newlyTracked}, newly_untracked: ${newlyUntracked}, total_tracked: ${totalTracked}`
);

await db.close();
