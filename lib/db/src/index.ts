import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";
import { RDS_CA } from "./rds-ca";

export { RDS_CA };

const { Pool } = pg;

// Base de datos principal de la app.
// - Por defecto: DATABASE_URL (Postgres de Replit).
// - Migración a AWS: si APP_DB_NAME está seteada (p. ej. "conectar_app_dev" o
//   "conectar_app_prod"), la app usa esa base dentro del servidor RDS de
//   CLINICA_DB_URL (misma instancia, distinta base). AWS RDS exige TLS; la
//   cadena se valida contra los certificados raíz oficiales de RDS embebidos.
function resolverConexion(): { connectionString: string; ssl: false | { ca: string } } {
  const appDbName = process.env.APP_DB_NAME;
  if (appDbName) {
    if (!process.env.CLINICA_DB_URL) {
      throw new Error("APP_DB_NAME está seteada pero falta CLINICA_DB_URL (servidor AWS RDS)");
    }
    if (!/^[a-z_][a-z0-9_]*$/.test(appDbName)) {
      throw new Error(`APP_DB_NAME inválida: ${appDbName}`);
    }
    const url = new URL(process.env.CLINICA_DB_URL);
    url.pathname = `/${appDbName}`;
    url.searchParams.delete("sslmode"); // el modo TLS se pasa por opciones de pg
    // Si CLINICA_DB_PASSWORD está seteada, pisa la contraseña embebida en la URL.
    // Permite rotar la clave del RDS actualizando UN solo secreto.
    const passOverride = process.env.CLINICA_DB_PASSWORD?.trim();
    if (passOverride) {
      url.password = encodeURIComponent(passOverride);
    }
    return { connectionString: url.toString(), ssl: { ca: RDS_CA } };
  }
  if (!process.env.DATABASE_URL) {
    throw new Error(
      "DATABASE_URL must be set. Did you forget to provision a database?",
    );
  }
  return { connectionString: process.env.DATABASE_URL, ssl: false };
}

const conexion = resolverConexion();

export const pool = new Pool({
  connectionString: conexion.connectionString,
  ssl: conexion.ssl,
});
export const db = drizzle(pool, { schema });

export * from "./schema";
export * from "./turnera-reuso";
