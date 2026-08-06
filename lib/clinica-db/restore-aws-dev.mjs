// Copia reanudable de la base de desarrollo (Replit) a AWS RDS conectar_app_dev.
// Corre como workflow (sin límite de 5 min). Idempotente: saltea tablas ya copiadas.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import pg from "pg";

const target = new URL(process.env.CLINICA_DB_URL);
target.pathname = "/conectar_app_dev";
target.searchParams.set("sslmode", "require");
const targetUrl = target.toString();
const DUMP = "/tmp/conectar_dev.dump";

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

async function counts(client, tables) {
  const parts = tables.map((t) => `SELECT '${t}' AS t, count(*)::bigint AS n FROM "${t}"`);
  const res = await client.query(parts.join(" UNION ALL "));
  return Object.fromEntries(res.rows.map((r) => [r.t, String(r.n)]));
}

const listOut = spawnSync("pg_restore", ["-l", DUMP], { maxBuffer: 20 * 1024 * 1024 });
const dataLines = listOut.stdout.toString().split("\n").filter((l) => l.includes("TABLE DATA"));
const tableOf = (l) => l.trim().split(/\s+/).slice(-2)[0];
const tables = dataLines.map(tableOf);
log("tablas en dump:", tables.length);

// para pg (node) usamos la URL SIN sslmode (el parámetro fuerza verify-full);
// el ssl relajado se pasa por opciones.
const targetNode = new URL(process.env.CLINICA_DB_URL);
targetNode.pathname = "/conectar_app_dev";
const src = new pg.Client({ connectionString: process.env.DATABASE_URL });
const dst = new pg.Client({ connectionString: targetNode.toString(), ssl: { rejectUnauthorized: false } });
await src.connect();
await dst.connect();

const srcN = await counts(src, tables);
const dstN = await counts(dst, tables);

const pendientes = tables.filter((t) => srcN[t] !== dstN[t]);
log("pendientes:", pendientes.length, pendientes.slice(0, 8).join(","));

// truncar cargas parciales
for (const t of pendientes) {
  if (dstN[t] !== "0") {
    log("truncando carga parcial:", t);
    await dst.query(`TRUNCATE "${t}" CASCADE`);
  }
}
await src.end();
await dst.end();

if (pendientes.length) {
  const entries = dataLines.filter((l) => pendientes.includes(tableOf(l)));
  fs.writeFileSync("/tmp/pendientes.list", entries.join("\n") + "\n");
  log("lanzando pg_restore de", pendientes.length, "tablas…");
  const r = spawnSync(
    "pg_restore",
    ["--no-owner", "--no-acl", "--section=data", "-L", "/tmp/pendientes.list", "-d", targetUrl, DUMP],
    { stdio: "inherit" },
  );
  if (r.status !== 0) { log("pg_restore terminó con error", r.status); process.exit(1); }
}

// post-data: índices, constraints, y secuencias (setval viene en la sección data,
// pero índices/FK están en post-data)
log("aplicando post-data (índices y constraints)…");
const r2 = spawnSync(
  "pg_restore",
  ["--no-owner", "--no-acl", "--section=post-data", "-d", targetUrl, DUMP],
  { stdio: "inherit" },
);
log("post-data exit:", r2.status, "(errores de 'already exists' son normales si se re-corre)");
log("LISTO");
