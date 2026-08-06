import pg from "pg";
async function q(name, cs) {
  try {
    const c = new pg.Client({ connectionString: cs, ssl: cs.includes("amazonaws") ? { rejectUnauthorized: false } : undefined });
    await c.connect();
    const { rows } = await c.query("SELECT id, nombre, matricula, length(firma_imagen) AS len FROM profesionales WHERE nombre ILIKE '%armijo%'");
    console.log(name, JSON.stringify(rows));
    await c.end();
  } catch (e) { console.log(name, "ERR:", e.message); }
}
const devUrl = process.env.CLINICA_DEV_DB_URL;
if (devUrl) await q("CLINICA_DEV_DB_URL", devUrl);
const u = new URL(process.env.CLINICA_DB_URL);
u.pathname = "/conectar_app_dev"; await q("clinica/conectar_app_dev", u.toString());
if (process.env.DATABASE_URL) await q("DATABASE_URL(replit)", process.env.DATABASE_URL);
