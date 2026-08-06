import { and, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import type pino from "pino";
import { db, turnosTable, turnerasTable, pacientesTable } from "@workspace/db";
import {
  dicomPacsConfigurado,
  getEstudiosDicomByDni,
  importarDesdePhir,
  type DicomPacsEstudio,
} from "./diagnostipacs-api";
import { enviarWhatsAppInforme } from "../routes/integraciones_phirit";

// ── Circuito de informes vía DiagnostiPACS ─────────────────────────────────
// Las turneras marcadas con lleva_informe pasan sus turnos por este circuito:
//   1. Al terminar la atención el turno queda en pendiente_informe y se le
//      pide al PACS que traiga los estudios del paciente (import Phir-it por
//      DNI). Se marca pacs_enviado_en.
//   2. El robot (pacs-poller) o el webhook detectan cuándo el PACS informó y
//      el turno pasa a "informado". Según destino_informe de la turnera:
//        hce      → queda en "informado" (visible en la HCE)
//        portal   → pasa a "publicado" (visible en el portal del paciente)
//        whatsapp → "publicado" + notificación WhatsApp al paciente

const ESTADOS_ESPERANDO_INFORME = ["pendiente_informe", "informando"];

// Un estudio del PACS cuenta como informado si su estado lo dice o si ya
// tiene una impresión/informe cargado (lo que ocurra primero).
const STATUS_INFORMADO = new Set(["informado", "reported", "finalizado", "final", "completed", "completado"]);

export function esEstudioInformado(e: DicomPacsEstudio): boolean {
  const status = (e.status ?? "").trim().toLowerCase();
  if (STATUS_INFORMADO.has(status)) return true;
  return Boolean(e.impression && e.impression.trim().length > 0);
}

// Enmascara el DNI en logs (deja los últimos 3 dígitos).
function maskDni(dni: string): string {
  return dni.length <= 3 ? "***" : `***${dni.slice(-3)}`;
}

// ── Paso 1: enviar el turno al PACS al terminar la atención ────────────────
// Fire-and-forget: nunca lanza; loguea el resultado. Solo actúa si la turnera
// lleva informe, el paciente tiene DNI y el PACS está configurado.
export async function enviarTurnoAlPacs(turnoId: number, log: pino.Logger): Promise<void> {
  try {
    const [row] = await db
      .select({
        turno: turnosTable,
        llevaInforme: turnerasTable.llevaInforme,
        dni: pacientesTable.dni,
      })
      .from(turnosTable)
      .innerJoin(turnerasTable, eq(turnosTable.turneraId, turnerasTable.id))
      .innerJoin(pacientesTable, eq(turnosTable.pacienteId, pacientesTable.id))
      .where(eq(turnosTable.id, turnoId))
      .limit(1);

    if (!row || !row.llevaInforme) return;
    if (!dicomPacsConfigurado()) {
      log.warn({ turnoId }, "PACS: turnera lleva informe pero falta PACS_API_TOKEN, no se envía");
      return;
    }
    if (!row.dni) {
      log.warn({ turnoId }, "PACS: el paciente no tiene DNI, no se puede enviar el estudio");
      return;
    }
    // Claim atómico: solo un disparo concurrente puede tomar el envío.
    const [claim] = await db
      .update(turnosTable)
      .set({ pacsEnviadoEn: new Date() })
      .where(and(eq(turnosTable.id, turnoId), isNull(turnosTable.pacsEnviadoEn)))
      .returning({ id: turnosTable.id });
    if (!claim) return; // ya enviado (o en curso por otro disparo)

    const resultado = await importarDesdePhir(row.dni);
    if (!resultado.ok) {
      // Se libera el claim para que el próximo disparo/poller pueda reintentar.
      await db
        .update(turnosTable)
        .set({ pacsEnviadoEn: null })
        .where(eq(turnosTable.id, turnoId));
      log.warn({ turnoId, code: resultado.code, msg: resultado.message }, "PACS: envío al PACS falló");
      return;
    }
    log.info(
      { turnoId, dni: maskDni(row.dni), ...resultado.data },
      "PACS: turno enviado al PACS para ser informado",
    );
  } catch (err) {
    log.error({ err, turnoId }, "PACS: error inesperado al enviar el turno al PACS");
  }
}

// ── Paso 2: procesar turnos que esperan informe ────────────────────────────
// Busca los turnos en pendiente_informe/informando ya enviados al PACS y, si
// el PACS tiene un estudio informado para ese DNI, cierra el circuito según
// el destino configurado en la turnera. Devuelve cuántos turnos procesó.
export async function procesarTurnosEsperandoInforme(
  log: pino.Logger,
  soloDni?: string,
  soloEstudioId?: string,
): Promise<number> {
  if (!dicomPacsConfigurado()) return 0;

  const pendientes = await db
    .select({
      turno: turnosTable,
      destinoInforme: turnerasTable.destinoInforme,
      paciente: pacientesTable,
    })
    .from(turnosTable)
    .innerJoin(turnerasTable, eq(turnosTable.turneraId, turnerasTable.id))
    .innerJoin(pacientesTable, eq(turnosTable.pacienteId, pacientesTable.id))
    .where(
      and(
        inArray(turnosTable.estado, ESTADOS_ESPERANDO_INFORME),
        eq(turnerasTable.llevaInforme, true),
        isNotNull(turnosTable.pacsEnviadoEn),
      ),
    );

  const soloDigitos = (d: string) => d.replace(/\D/g, "");
  const filtrados = soloDni
    ? pendientes.filter((p) => p.paciente.dni && soloDigitos(p.paciente.dni) === soloDigitos(soloDni))
    : pendientes;
  if (filtrados.length === 0) return 0;

  // Una consulta al PACS por DNI (cache por ciclo).
  const estudiosPorDni = new Map<string, DicomPacsEstudio[]>();
  let procesados = 0;

  // Estudios ya asignados a algún turno (evita cerrar dos turnos con el
  // mismo informe cuando el paciente tiene varios turnos pendientes).
  const yaAsignados = new Set<string>(
    (
      await db
        .select({ pacsEstudioId: turnosTable.pacsEstudioId })
        .from(turnosTable)
        .where(isNotNull(turnosTable.pacsEstudioId))
    )
      .map((r) => r.pacsEstudioId)
      .filter((v): v is string => Boolean(v)),
  );

  // Los turnos más antiguos reclaman primero su estudio.
  filtrados.sort((a, b) => (a.turno.pacsEnviadoEn?.getTime() ?? 0) - (b.turno.pacsEnviadoEn?.getTime() ?? 0));

  for (const { turno, destinoInforme, paciente } of filtrados) {
    if (!paciente.dni) continue;
    const dniKey = soloDigitos(paciente.dni);
    let estudios = estudiosPorDni.get(dniKey);
    if (!estudios) {
      const r = await getEstudiosDicomByDni(paciente.dni);
      if (!r.ok) {
        log.warn({ code: r.code, msg: r.message }, "PACS: consulta de estudios falló en el ciclo");
        continue;
      }
      estudios = r.data;
      estudiosPorDni.set(dniKey, estudios);
    }

    // Candidatos: informados, no asignados a otro turno y (si el webhook
    // indicó un estudio puntual) solo ese estudio.
    const informados = estudios.filter(
      (e) =>
        esEstudioInformado(e) &&
        !yaAsignados.has(e.id) &&
        (!soloEstudioId || e.id === soloEstudioId),
    );
    if (informados.length === 0) continue;

    // Estudio informado más reciente creado a partir del envío al PACS; si
    // ninguno tiene fecha comparable, cae al informado más reciente.
    const enviadoEn = turno.pacsEnviadoEn ? turno.pacsEnviadoEn.getTime() : 0;
    const conFecha = informados
      .map((e) => ({ e, ts: e.createdAt ? Date.parse(e.createdAt) : NaN }))
      .sort((a, b) => (b.ts || 0) - (a.ts || 0));
    const candidato =
      conFecha.find((x) => Number.isFinite(x.ts) && x.ts >= enviadoEn - 24 * 60 * 60 * 1000)?.e ??
      conFecha[0]?.e;
    if (!candidato) continue;

    const estadoFinal = destinoInforme === "hce" ? "informado" : "publicado";

    // Transición atómica: solo si el turno sigue esperando informe.
    const [actualizado] = await db
      .update(turnosTable)
      .set({
        estado: estadoFinal,
        pacsEstudioId: candidato.id,
        pacsInformadoEn: new Date(),
      })
      .where(
        and(eq(turnosTable.id, turno.id), inArray(turnosTable.estado, ESTADOS_ESPERANDO_INFORME)),
      )
      .returning();
    if (!actualizado) continue;
    yaAsignados.add(candidato.id);
    procesados++;

    log.info(
      {
        turnoId: turno.id,
        pacsEstudioId: candidato.id,
        destino: destinoInforme,
        estadoFinal,
      },
      "PACS: estudio informado, turno actualizado",
    );

    if (destinoInforme === "whatsapp") {
      try {
        const notif = await enviarWhatsAppInforme(
          { id: paciente.id, nombre: paciente.nombre, telefono: paciente.telefono },
          "informe_disponible_pacs",
        );
        log.info(
          { turnoId: turno.id, notificacionId: notif.notificacionId, estadoEntrega: notif.estadoEntrega },
          "PACS: notificación WhatsApp de informe disponible",
        );
      } catch (err) {
        log.error({ err, turnoId: turno.id }, "PACS: no se pudo registrar la notificación WhatsApp");
      }
    }
  }

  return procesados;
}
