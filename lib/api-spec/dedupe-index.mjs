// Orval "workspace" mode appends export lines with different quote styles on
// each run, duplicating them and breaking the build. Normalize after codegen.
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const files = [
  path.join(root, "lib", "api-client-react", "src", "index.ts"),
  path.join(root, "lib", "api-zod", "src", "index.ts"),
];

for (const file of files) {
  const lines = readFileSync(file, "utf8").split("\n");
  const seen = new Set();
  const out = [];
  for (const line of lines) {
    const normalized = line.trim().replace(/'/g, '"');
    if (normalized.startsWith("export") && seen.has(normalized)) continue;
    if (normalized.startsWith("export")) seen.add(normalized);
    out.push(line.replace(/'/g, '"'));
  }
  // colapsar líneas vacías repetidas al final
  const text = out.join("\n").replace(/\n{3,}/g, "\n\n").replace(/\n+$/, "\n");
  writeFileSync(file, text);
}
