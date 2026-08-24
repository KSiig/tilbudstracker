import { createDb } from "./db.js";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const db = await createDb("sqlite");

const stores = await db.all<{ id: string; name: string; isTracked: number }>(
  "SELECT id, name, isTracked FROM stores ORDER BY name COLLATE NOCASE"
);

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

await db.close();
