import { getDb } from "./db.js";
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

const db = getDb();

const trackStmt = db.prepare("UPDATE stores SET isTracked = 1 WHERE id = ?");
const untrackStmt = db.prepare("UPDATE stores SET isTracked = 0 WHERE id = ?");

const trackChanges = db.transaction(() => {
  let tracked = 0;
  let untracked = 0;

  for (const id of checked) {
    const r = trackStmt.run(id);
    if (r.changes > 0) tracked++;
  }
  for (const id of unchecked) {
    const r = untrackStmt.run(id);
    if (r.changes > 0) untracked++;
  }

  return { tracked, untracked };
});

const { tracked, untracked } = trackChanges();

const totalTracked = (
  db
    .prepare("SELECT COUNT(*) as c FROM stores WHERE isTracked = 1")
    .get() as { c: number }
).c;

console.log(
  `Applied: ${tracked} newly tracked, ${untracked} newly untracked. Total tracked: ${totalTracked}`
);
