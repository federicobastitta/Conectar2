import pg from "pg";
const u = new URL(process.env.CLINICA_DB_URL);
const nueva = process.env.CLINICA_DB_PASSWORD.trim();
const vieja = decodeURIComponent(u.password);
async function probar(tag, password, ssl) {
  try {
    const c = new pg.Client({ host: u.hostname, port: 5432, user: "postgres", password, database: "postgres", connectionTimeoutMillis: 8000, ssl });
    await c.connect();
    console.log(tag, "OK");
    await c.end();
    return true;
  } catch (e) { console.log(tag, "FALLA:", e.message); return false; }
}
console.log("largo clave nueva:", nueva.length, "| vieja:", vieja.length, "| iguales:", nueva === vieja);
for (let i = 0; i < 4; i++) {
  const ok = await probar(`[${i}] nueva+ssl`, nueva, { rejectUnauthorized: false });
  await probar(`[${i}] nueva sin ssl`, nueva, false);
  await probar(`[${i}] vieja+ssl`, vieja, { rejectUnauthorized: false });
  if (ok) break;
  await new Promise(r => setTimeout(r, 60000));
}
