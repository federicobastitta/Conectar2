/**
 * Test: Inmutabilidad de evoluciones firmadas
 * Verifica el trigger protect_evolucion_firmada y el esquema de firma.
 * Requiere DATABASE_URL para correr contra la DB de test.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";
import { runMigrations } from "../src/migrations/runner.js";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, "../src/migrations/sql");
const CONNECTION_STRING = process.env.CLINICA_DB_TEST_URL ?? process.env.DATABASE_URL;
const TEST_SCHEMA = `clinica_test_evo_${Date.now()}`;

let pool: pg.Pool;
let adminPool: pg.Pool;

function sha256(text: string) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

beforeAll(async () => {
  if (!CONNECTION_STRING) return;
  const { Pool } = pg;
  adminPool = new Pool({ connectionString: CONNECTION_STRING, max: 1 });
  await adminPool.query(`CREATE SCHEMA IF NOT EXISTS "${TEST_SCHEMA}"`);
  pool = new Pool({
    connectionString: CONNECTION_STRING,
    max: 2,
    options: `-c search_path="${TEST_SCHEMA}",public`,
  });
  await runMigrations(pool, { migrationsDir: MIGRATIONS_DIR, log: () => {} });
});

afterAll(async () => {
  if (!pool) return;
  await pool.end();
  if (adminPool) {
    await adminPool.query(`DROP SCHEMA IF EXISTS "${TEST_SCHEMA}" CASCADE`);
    await adminPool.end();
  }
});

describe("Evoluciones — inmutabilidad post-firma", () => {
  let pacienteId: string;
  let episodioId: string;
  let evolucionId: string;
  const medicoId = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";

  it("crea un paciente y episodio de test", async () => {
    if (!pool) return;

    const { rows: rp } = await pool.query<{ id: string }>(
      `INSERT INTO pacientes (apellido, nombre, sexo, origen, created_by)
       VALUES ('FICTICIO EVO', 'TEST EVO', 'desconocido', 'migracion_inicial', NULL)
       RETURNING id::text`,
    );
    pacienteId = rp[0]!.id;

    const { rows: re } = await pool.query<{ id: string }>(
      `INSERT INTO episodios (paciente_id, motivo_consulta, estado, origen, created_by)
       VALUES ($1::uuid, 'Test de evolución', 'programado', 'interfaz_clinica', NULL)
       RETURNING id::text`,
      [pacienteId],
    );
    episodioId = re[0]!.id;

    expect(pacienteId).toBeDefined();
    expect(episodioId).toBeDefined();
  });

  it("crea una evolución en borrador y la puede editar", async () => {
    if (!pool || !pacienteId) return;

    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO evoluciones (episodio_id, paciente_id, subjetivo, objetivo, estado, created_by)
       VALUES ($1::uuid, $2::uuid, 'Subjetivo inicial', 'Objetivo inicial', 'borrador', $3::uuid)
       RETURNING id::text`,
      [episodioId, pacienteId, medicoId],
    );
    evolucionId = rows[0]!.id;
    expect(evolucionId).toBeDefined();

    // Editar en borrador — debe funcionar
    await pool.query(
      `UPDATE evoluciones SET subjetivo = 'Subjetivo editado' WHERE id = $1::uuid`,
      [evolucionId],
    );
    const { rows: updated } = await pool.query<{ subjetivo: string }>(
      `SELECT subjetivo FROM evoluciones WHERE id = $1::uuid`,
      [evolucionId],
    );
    expect(updated[0]!.subjetivo).toBe("Subjetivo editado");
  });

  it("firma la evolución correctamente", async () => {
    if (!pool || !evolucionId) return;

    const contenido = "Subjetivo editadoObjetivo inicial";
    const hash = sha256(contenido);

    await pool.query(
      `UPDATE evoluciones SET
         estado = 'firmada',
         firmada_por = $2::uuid,
         firmada_por_nombre = 'Dr. Ficticio Test',
         firmada_en = now(),
         firma_hash = $3
       WHERE id = $1::uuid`,
      [evolucionId, medicoId, hash],
    );

    const { rows } = await pool.query<{ estado: string }>(
      `SELECT estado FROM evoluciones WHERE id = $1::uuid`,
      [evolucionId],
    );
    expect(rows[0]!.estado).toBe("firmada");
  });

  it("rechaza modificar el texto de una evolución firmada (trigger inmutabilidad)", async () => {
    if (!pool || !evolucionId) return;

    await expect(
      pool.query(
        `UPDATE evoluciones SET subjetivo = 'Intento de modificación ilegal' WHERE id = $1::uuid`,
        [evolucionId],
      ),
    ).rejects.toThrow(/evolucion_inmutable/);
  });

  it("permite cambiar campos no-contenido (ej: es_version_activa) en una evolución firmada", async () => {
    if (!pool || !evolucionId) return;

    // es_version_activa no está en la lista de campos protegidos → debe permitirse
    await expect(
      pool.query(
        `UPDATE evoluciones SET es_version_activa = FALSE WHERE id = $1::uuid`,
        [evolucionId],
      ),
    ).resolves.not.toThrow();
  });

  it("crea una nueva versión corrigiendo la evolución firmada", async () => {
    if (!pool || !evolucionId || !pacienteId) return;

    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO evoluciones (
         episodio_id, paciente_id, subjetivo, objetivo, estado,
         version, version_anterior_id, es_version_activa,
         corrige_a, motivo_correccion, created_by
       ) VALUES (
         $1::uuid, $2::uuid, 'Subjetivo corregido', 'Objetivo inicial', 'borrador',
         2, $3::uuid, true,
         $3::uuid, 'Corrección de error tipográfico', $4::uuid
       ) RETURNING id::text`,
      [episodioId, pacienteId, evolucionId, medicoId],
    );

    expect(rows[0]!.id).toBeDefined();
  });
});
