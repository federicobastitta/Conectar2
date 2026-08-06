// ── Aviso de recepción al PACS ───────────────────────────────────────────────
// Cuando la recepción admite al paciente (turno pasa a "arribo"), avisamos a
// DiagnosticPACS por cada orden vigente del paciente para que pase a
// "recepcionado" en su lista de trabajo. Fire-and-forget: nunca debe frenar
// ni romper la recepción.
import { db, ordenesPracticasTable, studyOrdersTable } from "@workspace/db";
import { and, eq, inArray, isNull, or, sql } from "drizzle-orm";
import type { Logger } from "pino";
import { hoyArgentina, horaArgentina } from "../lib/tiempo";
import { notificarRecepcion, pacsV1Configurado } from "./pacs-workspace-v1";

// Estados en los que la orden todavía está "agendada" para el PACS.
const ESTADOS_ORDEN_PENDIENTE = ["creada", "pendiente_validacion", "validada"] as const;
const ESTADOS_STUDY_ORDER_PENDIENTE = ["solicitado", "pendiente_programacion", "programado"] as const;

function ahoraArgentinaIso(): string {
  return `${hoyArgentina()}T${horaArgentina()}:00-03:00`;
}

export async function avisarRecepcionPacs(pacienteId: number, log: Logger): Promise<void> {
  if (!pacsV1Configurado()) return;
  const hoy = hoyArgentina();
  const receivedAt = ahoraArgentinaIso();

  try {
    const [ordenes, studyOrders] = await Promise.all([
      db
        .select({ id: ordenesPracticasTable.id, orderId: ordenesPracticasTable.ordenUuid })
        .from(ordenesPracticasTable)
        .where(
          and(
            eq(ordenesPracticasTable.patientId, pacienteId),
            eq(ordenesPracticasTable.pacsOrdenEnviada, true),
            inArray(ordenesPracticasTable.estado, [...ESTADOS_ORDEN_PENDIENTE]),
            or(
              isNull(ordenesPracticasTable.fechaRealizacionEstimada),
              eq(ordenesPracticasTable.fechaRealizacionEstimada, hoy),
            ),
          ),
        ),
      db
        .select({ id: studyOrdersTable.id })
        .from(studyOrdersTable)
        .where(
          and(
            eq(studyOrdersTable.patientId, pacienteId),
            sql`${studyOrdersTable.accessionNumber} IS NOT NULL`,
            inArray(studyOrdersTable.status, [...ESTADOS_STUDY_ORDER_PENDIENTE]),
          ),
        ),
    ]);

    const orderIds = [...ordenes.map((o) => o.orderId), ...studyOrders.map((o) => String(o.id))];
    if (orderIds.length === 0) return;

    for (const orderId of orderIds) {
      const resultado = await notificarRecepcion(orderId, receivedAt, `recepcion-${orderId}-${hoy}`);
      if (resultado.ok) {
        log.info(
          { pacienteId, orderId, alreadyReceived: resultado.data?.already_received ?? false },
          "pacs-recepcion: aviso de recepción enviado",
        );
      } else if (resultado.status === 404) {
        log.warn({ pacienteId, orderId }, "pacs-recepcion: la orden no existe en el PACS");
      } else if (resultado.status === 409) {
        log.warn({ pacienteId, orderId }, "pacs-recepcion: la orden ya no está agendada en el PACS");
      } else {
        log.error(
          { pacienteId, orderId, code: resultado.code, message: resultado.message },
          "pacs-recepcion: fallo el aviso de recepción",
        );
      }
    }
  } catch (err) {
    log.error({ pacienteId, err: String(err) }, "pacs-recepcion: error inesperado avisando recepción");
  }
}
