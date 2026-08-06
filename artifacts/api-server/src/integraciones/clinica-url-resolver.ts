/**
 * Resolución centralizada de la URL de clinica-db según el entorno.
 *
 * Regla de aislamiento dev/prod:
 *   - producción/staging : CLINICA_DB_URL (base real AWS — obligatoria)
 *   - desarrollo/test    : CLINICA_DEV_DB_URL (base aislada de dev en AWS)
 *                          o DATABASE_URL (Replit local) como último recurso.
 *                          NUNCA usa CLINICA_DB_URL en dev — apunta a datos reales.
 *
 * La función se exporta para que pueda ser probada con variables de entorno
 * controladas (pasar `env` como segundo argumento en tests).
 */

export interface ClinicaUrlResult {
  /** URL de conexión resuelta */
  url: string;
  /** true si la URL apunta a un servidor RDS de AWS (TLS requerido) */
  esAws: boolean;
  /** Identificador de destino para logging */
  destino: "aws-clinica-prod" | "aws-clinica-dev" | "dev-local-fallback";
}

export type EnvVars = Record<string, string | undefined>;

/**
 * Resuelve la URL efectiva para los módulos de clinica-db.
 *
 * @param modulo  Nombre del módulo que llama (para mensajes de error).
 * @param env     Variables de entorno (por defecto process.env, inyectable en tests).
 */
/** Nombre de la base aislada de desarrollo en el mismo servidor RDS. */
const DEV_DB_NAME = "clinica_dev";

/**
 * Guardarraíl: si CLINICA_DEV_DB_URL apunta al mismo servidor y la misma base
 * que CLINICA_DB_URL (p. ej. se copió la URL de prod sin cambiar el nombre de
 * la base), se reescribe el nombre de la base a `clinica_dev` para no operar
 * sobre datos reales desde desarrollo.
 */
function forzarBaseAislada(devUrl: string, prodUrl: string | undefined): string {
  if (!prodUrl) return devUrl;
  try {
    const dev = new URL(devUrl);
    const prod = new URL(prodUrl);
    const mismaBase =
      dev.hostname === prod.hostname &&
      dev.port === prod.port &&
      dev.pathname === prod.pathname;
    if (!mismaBase) return devUrl;
    dev.pathname = `/${DEV_DB_NAME}`;
    return dev.toString();
  } catch {
    return devUrl;
  }
}

/**
 * Si CLINICA_DB_PASSWORD está configurada, pisa la contraseña embebida en la
 * URL de AWS. Permite rotar la clave del RDS actualizando UN solo secreto,
 * sin reescribir CLINICA_DB_URL / CLINICA_DEV_DB_URL.
 * Nunca se aplica a URLs locales (DATABASE_URL).
 */
function aplicarPasswordOverride(url: string, env: EnvVars): string {
  const pass = env.CLINICA_DB_PASSWORD?.trim();
  if (!pass) return url;
  try {
    const u = new URL(url);
    u.password = encodeURIComponent(pass);
    return u.toString();
  } catch {
    return url;
  }
}

export function resolverClinicaUrl(
  modulo: string,
  env: EnvVars = process.env,
): ClinicaUrlResult {
  const esProd = env.NODE_ENV === "production" || env.NODE_ENV === "staging";

  if (esProd) {
    const url = env.CLINICA_DB_URL;
    if (!url) {
      throw new Error(
        `${modulo}: CLINICA_DB_URL es obligatoria en producción/staging — datos de pacientes/usuarios van a AWS`,
      );
    }
    return { url: aplicarPasswordOverride(url, env), esAws: true, destino: "aws-clinica-prod" };
  }

  // ── Entorno de desarrollo / test ──────────────────────────────────────────
  // NUNCA usar CLINICA_DB_URL aquí — apunta a la base real de producción.
  // Solo se permiten: CLINICA_DEV_DB_URL (base aislada) o DATABASE_URL (local).

  const devUrl = env.CLINICA_DEV_DB_URL;
  if (devUrl) {
    return {
      url: aplicarPasswordOverride(forzarBaseAislada(devUrl, env.CLINICA_DB_URL), env),
      esAws: true,
      destino: "aws-clinica-dev",
    };
  }

  const localUrl = env.DATABASE_URL;
  if (localUrl) {
    return { url: localUrl, esAws: false, destino: "dev-local-fallback" };
  }

  throw new Error(
    `${modulo}: en desarrollo/test se requiere CLINICA_DEV_DB_URL (base aislada AWS) ` +
      `o DATABASE_URL (base local). ` +
      `CLINICA_DB_URL NO se usa en dev porque apunta a datos reales de producción.`,
  );
}
