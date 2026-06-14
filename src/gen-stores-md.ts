import { getDb } from "./db.js";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const db = getDb();

const stores = db
  .prepare(
    "SELECT id, name, isTracked FROM stores ORDER BY name COLLATE NOCASE"
  )
  .all() as { id: string; name: string; isTracked: number }[];

let md = `# Store Tracking

Check the stores you want to track, then run \`pnpm apply-stores\`.

`;

for (const s of stores) {
  const check = s.isTracked ? "x" : " ";
  md += `- [${check}] ${s.name} (\`${s.id}\`)\n`;
}

const outPath = path.resolve(__dirname, "..", "stores.md");
writeFileSync(outPath, md);
console.log(`Wrote ${stores.length} stores to ${outPath}`);
