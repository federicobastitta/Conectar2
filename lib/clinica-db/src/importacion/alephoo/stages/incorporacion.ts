/**
 * Stage incorporación — Inserta las filas aprobadas en las tablas clínicas.
 * Cada incorporación es transaccional: si falla una fila, se revierte solo esa.
 * Preserva: upload_id, fila_numero y archivo_s3_key como origen del dato.
 */

import type pg from "pg";
import type { FilaNormalizada, ResultadoIncorporacion } from "../types.js";

export async function incorporarFila(
  fila: FilaNormalizada,
  pool: pg.Pool,
  opts: {
    incorporadoPor: string; // ID de usuario
    uploadId: string;
    log?: (msg: string) => void;
  },
): Promise<ResultadoIncorporacion> {
  const { log = console.log } = opts;
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    // Configurar contexto de auditoría para esta transacción
    await client.query(
      `SET LOCAL app.actor_id = '${opts.incorporadoPor}';
       SET LOCAL app.actor_origen = 'importacion_alephoo';`,
    );

    // Buscar si el paciente ya existe por DNI
    let pacienteId: string | undefined;
    let accion: ResultadoIncorporacion["accion"] = "creado";

    if (fila.nroDocNorm) {
      const { rows } = await client.query<{ id: string }>(
        `SELECT id::text FROM pacientes
         WHERE regexp_replace(nro_doc, '[^0-9]', '', 'g') = $1
           AND deleted_at IS NULL
         LIMIT 1`,
        [fila.nroDocNorm],
      );
      if (rows[0]) {
        pacienteId = rows[0].id;
        accion = "vinculado";
      }
    }

    // Crear el paciente si no existe
    if (!pacienteId) {
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO pacientes (
          apellido, nombre, tipo_doc, nro_doc,
          fecha_nacimiento, sexo, email_principal, telefono_principal,
          origen, origen_id_externo, created_by
        ) VALUES (
          $1, $2, 'dni', $3,
          $4::date, $5::sexo_biologico, $6, $7,
          'importacion_alephoo', $8, $9::uuid
        )
        RETURNING id::text`,
        [
          fila.apellido ?? "DESCONOCIDO",
          fila.nombre ?? "DESCONOCIDO",
          fila.nroDocNorm ?? null,
          fila.fechaNacimientoIso ?? null,
          fila.sexoNorm ?? "desconocido",
          fila.emailNorm ?? null,
          fila.telefonoNorm ?? null,
          // origen_id_externo: identificador de fila para trazabilidad
          `alephoo:${fila.uploadId}:fila${fila.filaNumero}`,
          opts.incorporadoPor,
        ],
      );
      pacienteId = rows[0]?.id;
      accion = "creado";
    }

    if (!pacienteId) {
      throw new Error("No se pudo crear ni vincular el paciente");
    }

    // Registrar el identificador externo Alephoo
    await client.query(
      `INSERT INTO identificadores_externos (
        paciente_id, sistema, identificador, activo, origen, created_by
      ) VALUES ($1::uuid, 'alephoo', $2, true, 'importacion_alephoo', $3::uuid)
      ON CONFLICT (paciente_id, sistema, identificador) WHERE deleted_at IS NULL AND activo = TRUE
      DO NOTHING`,
      [pacienteId, `${fila.uploadId}:fila${fila.filaNumero}`, opts.incorporadoPor],
    );

    // Cobertura (si viene con datos de obra social)
    if (fila.obraSocial) {
      await client.query(
        `INSERT INTO coberturas (
          paciente_id, modalidad, financiador, nro_afiliado,
          activa, origen, created_by
        ) VALUES ($1::uuid, 'obra_social', $2, $3, true, 'importacion_alephoo', $4::uuid)`,
        [pacienteId, fila.obraSocial, fila.nroAfiliado ?? null, opts.incorporadoPor],
      );
    }

    await client.query("COMMIT");
    log(
      `[alephoo:incorporacion] Fila ${fila.filaNumero} → pacienteId ${pacienteId} (${accion})`,
    );

    return { filaNumero: fila.filaNumero, pacienteId, accion };
  } catch (err) {
    await client.query("ROLLBACK");
    const mensaje = err instanceof Error ? err.message : String(err);
    log(`[alephoo:incorporacion] Error en fila ${fila.filaNumero}: ${mensaje}`);
    return {
      filaNumero: fila.filaNumero,
      accion: "omitido",
      motivo: mensaje,
    };
  } finally {
    client.release();
  }
}

export async function incorporarFilasAprobadas(
  filas: FilaNormalizada[],
  pool: pg.Pool,
  opts: {
    incorporadoPor: string;
    uploadId: string;
    log?: (msg: string) => void;
  },
): Promise<ResultadoIncorporacion[]> {
  const resultados: ResultadoIncorporacion[] = [];
  const aprobadas = filas.filter((f) => f.estado === "aprobada" || f.estado === "normalizada");

  for (const fila of aprobadas) {
    const resultado = await incorporarFila(fila, pool, opts);
    resultados.push(resultado);
  }

  return resultados;
}
