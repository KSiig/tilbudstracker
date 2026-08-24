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

const totalTracked = (
  await db.get<{ c: number }>(
    "SELECT COUNT(*) as c FROM stores WHERE isTracked = 1"
  )
)!.c;

console.log(
  `Applied: ${checked.size} newly tracked, ${unchecked.size} newly untracked. Total tracked: ${totalTracked}`
);

await db.close();
