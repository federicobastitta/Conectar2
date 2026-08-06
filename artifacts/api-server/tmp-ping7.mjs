import pg from "pg";
const u = new URL(process.env.CLINICA_DB_URL);
const nueva = process.env.CLINICA_DB_PASSWORD.trim();
for (let i = 1; i <= 8; i++) {
  try {
    const c = new pg.Client({ host: u.hostname, port: 5432, user: "postgres", password: nueva, database: "postgres", connectionTimeoutMillis: 8000, ssl: { rejectUnauthorized: false } });
    await c.connect();
    console.log("Intento", i, "OK:", (await c.query("select now()")).rows[0].now);
    await c.end();
    process.exit(0);
  } catch (e) { console.log("Intento", i, "FALLA:", e.message); }
  await new Promise(r => setTimeout(r, 30000));
}
process.exit(1);
