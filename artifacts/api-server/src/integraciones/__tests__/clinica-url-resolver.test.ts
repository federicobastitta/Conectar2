import { describe, it, expect } from "vitest";
import { resolverClinicaUrl } from "../clinica-url-resolver.js";

const PROD_URL = "postgres://user:pass@rds.amazonaws.com/postgres";
const DEV_URL = "postgres://user:pass@rds.amazonaws.com/clinica_dev";
const LOCAL_URL = "postgres://localhost/conectar_test";

describe("resolverClinicaUrl", () => {
  // ── Producción ──────────────────────────────────────────────────────────

  it("en production usa CLINICA_DB_URL", () => {
    const result = resolverClinicaUrl("test", {
      NODE_ENV: "production",
      CLINICA_DB_URL: PROD_URL,
    });
    expect(result.url).toBe(PROD_URL);
    expect(result.esAws).toBe(true);
    expect(result.destino).toBe("aws-clinica-prod");
  });

  it("en staging usa CLINICA_DB_URL", () => {
    const result = resolverClinicaUrl("test", {
      NODE_ENV: "staging",
      CLINICA_DB_URL: PROD_URL,
    });
    expect(result.url).toBe(PROD_URL);
    expect(result.esAws).toBe(true);
    expect(result.destino).toBe("aws-clinica-prod");
  });

  it("en production lanza error si falta CLINICA_DB_URL", () => {
    expect(() =>
      resolverClinicaUrl("test", { NODE_ENV: "production" }),
    ).toThrow("CLINICA_DB_URL es obligatoria en producción/staging");
  });

  it("en staging lanza error si falta CLINICA_DB_URL", () => {
    expect(() =>
      resolverClinicaUrl("test", { NODE_ENV: "staging" }),
    ).toThrow("CLINICA_DB_URL es obligatoria en producción/staging");
  });

  // ── Desarrollo — CLINICA_DEV_DB_URL ────────────────────────────────────

  it("en development usa CLINICA_DEV_DB_URL si está configurada", () => {
    const result = resolverClinicaUrl("test", {
      NODE_ENV: "development",
      CLINICA_DEV_DB_URL: DEV_URL,
      CLINICA_DB_URL: PROD_URL, // debe ser ignorada
    });
    expect(result.url).toBe(DEV_URL);
    expect(result.esAws).toBe(true);
    expect(result.destino).toBe("aws-clinica-dev");
  });

  it("en test usa CLINICA_DEV_DB_URL si está configurada", () => {
    const result = resolverClinicaUrl("test", {
      NODE_ENV: "test",
      CLINICA_DEV_DB_URL: DEV_URL,
    });
    expect(result.url).toBe(DEV_URL);
    expect(result.esAws).toBe(true);
    expect(result.destino).toBe("aws-clinica-dev");
  });

  it("en development reescribe la base si CLINICA_DEV_DB_URL apunta a la misma base que prod", () => {
    const result = resolverClinicaUrl("test", {
      NODE_ENV: "development",
      CLINICA_DEV_DB_URL: PROD_URL, // copia accidental de la URL de prod
      CLINICA_DB_URL: PROD_URL,
    });
    expect(new URL(result.url).pathname).toBe("/clinica_dev");
    expect(new URL(result.url).hostname).toBe("rds.amazonaws.com");
    expect(result.destino).toBe("aws-clinica-dev");
  });

  it("no reescribe si la dev URL ya apunta a otra base", () => {
    const result = resolverClinicaUrl("test", {
      NODE_ENV: "development",
      CLINICA_DEV_DB_URL: DEV_URL,
      CLINICA_DB_URL: PROD_URL,
    });
    expect(result.url).toBe(DEV_URL);
  });

  // ── Desarrollo — fallback local ─────────────────────────────────────────

  it("en development cae a DATABASE_URL si no hay CLINICA_DEV_DB_URL", () => {
    const result = resolverClinicaUrl("test", {
      NODE_ENV: "development",
      DATABASE_URL: LOCAL_URL,
      CLINICA_DB_URL: PROD_URL, // debe ser ignorada
    });
    expect(result.url).toBe(LOCAL_URL);
    expect(result.esAws).toBe(false);
    expect(result.destino).toBe("dev-local-fallback");
  });

  it("en test cae a DATABASE_URL si no hay CLINICA_DEV_DB_URL", () => {
    const result = resolverClinicaUrl("test", {
      NODE_ENV: "test",
      DATABASE_URL: LOCAL_URL,
    });
    expect(result.url).toBe(LOCAL_URL);
    expect(result.esAws).toBe(false);
    expect(result.destino).toBe("dev-local-fallback");
  });

  // ── Aislamiento crítico: CLINICA_DB_URL NUNCA se usa en dev ─────────────

  it("en development IGNORA CLINICA_DB_URL aunque no haya dev URL", () => {
    // Con CLINICA_DB_URL pero sin CLINICA_DEV_DB_URL ni DATABASE_URL debe lanzar error
    // (no silenciosamente conectarse a la base real de prod)
    expect(() =>
      resolverClinicaUrl("test", {
        NODE_ENV: "development",
        CLINICA_DB_URL: PROD_URL,
      }),
    ).toThrow("CLINICA_DEV_DB_URL");
  });

  it("en test IGNORA CLINICA_DB_URL aunque no haya dev URL", () => {
    expect(() =>
      resolverClinicaUrl("test", {
        NODE_ENV: "test",
        CLINICA_DB_URL: PROD_URL,
      }),
    ).toThrow("CLINICA_DEV_DB_URL");
  });

  // ── Sin NODE_ENV (trata como dev) ─────────────────────────────────────

  it("sin NODE_ENV trata como dev y usa CLINICA_DEV_DB_URL", () => {
    const result = resolverClinicaUrl("test", {
      CLINICA_DEV_DB_URL: DEV_URL,
    });
    expect(result.url).toBe(DEV_URL);
    expect(result.destino).toBe("aws-clinica-dev");
  });

  it("sin NODE_ENV lanza error si solo hay CLINICA_DB_URL", () => {
    expect(() =>
      resolverClinicaUrl("test", {
        CLINICA_DB_URL: PROD_URL,
      }),
    ).toThrow("CLINICA_DEV_DB_URL");
  });

  // ── Mensajes de error ───────────────────────────────────────────────────

  it("el mensaje de error incluye el nombre del módulo", () => {
    expect(() =>
      resolverClinicaUrl("preferencias-db", { NODE_ENV: "production" }),
    ).toThrow("preferencias-db:");
  });

  it("el mensaje de error de dev explica por qué no se usa CLINICA_DB_URL", () => {
    expect(() =>
      resolverClinicaUrl("test", { NODE_ENV: "development", CLINICA_DB_URL: PROD_URL }),
    ).toThrow("datos reales de producción");
  });
});
