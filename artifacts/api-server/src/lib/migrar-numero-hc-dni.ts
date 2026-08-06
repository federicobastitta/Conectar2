/**
 * Migración idempotente: el número de historia clínica pasa a ser el DNI del
 * paciente (regla institucional, jul 2026). Corre al arrancar, así también se
 * aplica sola en la base AWS de la app publicada en el próximo publish.
 *
 * Estrategia en dos pasos dentro de una transacción para no chocar con el
 * índice único de numero_hc a mitad de camino (p. ej. si un paciente tuviera
 * como HC viejo el DNI de otro):
 *   1. Se liberan los numero_hc que van a cambiar (quedan NULL un instante).
 *   2. Se asigna numero_hc = dni a todo paciente con DNI.
 * Los pacientes sin DNI conservan su HC legacy (HC000123) o quedan como están.
 */
import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { logger } from "./logger";

export async function migrarNumeroHcIgualDni(): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(sql`
      UPDATE pacientes
      SET numero_hc = NULL
      WHERE dni IS NOT NULL AND btrim(dni) <> ''
        AND numero_hc IS DISTINCT FROM btrim(dni)
    `);
    const res = await tx.execute(sql`
      UPDATE pacientes
      SET numero_hc = btrim(dni)
      WHERE dni IS NOT NULL AND btrim(dni) <> ''
        AND numero_hc IS NULL
    `);
    const filas = (res as unknown as { rowCount?: number }).rowCount ?? 0;
    if (filas > 0) logger.info({ filas }, "numero_hc igualado al DNI del paciente");
  });
}
