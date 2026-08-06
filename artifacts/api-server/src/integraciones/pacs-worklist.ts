import { and, eq, gte, inArray, isNull, lte, or, sql } from "drizzle-orm";
import type pino from "pino";
import {
  db,
  turnosTable,
  turnerasTable,
  pacientesTable,
  especialidadesTable,
  pacsWorklistItemsTable,
  studyOrdersTable,
  practicasCatalogoTable,
  type PacsWorklistItem,
} from "@workspace/db";
import { logger } from "../lib/logger";
import { hoyArgentina } from "../lib/tiempo";
import {
  anularOrden,
  notificarRecepcion,
  pacsV1Configurado,
  upsertOrden,
  sexoParaPacs,
  fechaNacimientoParaPacs,
  type PacsOrderUpsert,
  type PacsV1Result,
} from "./pacs-workspace-v1";

// ── Worklist PACS (escenario v3) ────────────────────────────────────────────
// Conectar publica al PACS los estudios a realizar: un ítem de worklist por
// turno cuya especialidad tiene envia_al_pacs. La publicación es una cola con
// reintentos (nunca bloquea la agenda). El PACS redacta y FIRMA los informes;
// Conectar recibe REPORT_SIGNED por webhook (ver routes/pacs_worklist.ts).
//
// Flag maestro: PACS_WORKLIST_ENABLED=true (default apagado).
// Destino (jul 2026): el PACS de producción NO implementa la ruta worklist v3;
// acordamos enviar por el canal de órdenes ya operativo (pacs-workspace-v1):
//   scheduled  → POST /orders (alta idempotente)
//   arrived    → POST /orders/{order_id}/reception
//   cancelled  → DELETE /orders/{order_id}
//   ready_to_report → no se envía (lo determina el PACS al recibir imágenes)

export function pacsWorklistHabilitado(): boolean {
  return (process.env.PACS_WORKLIST_ENABLED ?? "false").toLowerCase() === "true";
}

// Mapa estado del turno → estado del ítem de worklist según el contrato.
export function worklistStatusDeTurno(estado: string): "scheduled" | "arrived" | "ready_to_report" | "cancelled" | null {
  switch (estado) {
    case "pendiente":
    case "reservado":
    case "confirmado":
      return "scheduled";
    case "arribo":
    case "en_sala":
    case "llamado":
    case "en_atencion":
      return "arrived";
    case "visto":
    case "pendiente_informe":
    case "informando":
      return "ready_to_report";
    case "cancelado":
    case "ausente":
      return "cancelled";
    default:
      // informado/publicado/visto_usuario: los maneja el PACS, no cambiamos nada
      return null;
  }
}

// Accession propio de Conectar: C{AA}-{12 dígitos}, opaco e inmutable.
async function generarAccession(): Promise<string> {
  const resultado = await db.execute(sql`SELECT nextval('pacs_accession_seq') AS n`);
  const n = (resultado.rows[0] as { n: string | number }).n;
  const anio = new Date().getFullYear() % 100;
  return `C${String(anio).padStart(2, "0")}-${String(n).padStart(12, "0")}`;
}

interface TurnoWorklist {
  turno: typeof turnosTable.$inferSelect;
  paciente: typeof pacientesTable.$inferSelect;
  especialidad: typeof especialidadesTable.$inferSelect;
  turnera: typeof turnerasTable.$inferSelect;
}

async function cargarTurnoWorklist(turnoId: number): Promise<TurnoWorklist | null> {
  const [row] = await db
    .select({
      turno: turnosTable,
      paciente: pacientesTable,
      especialidad: especialidadesTable,
      turnera: turnerasTable,
    })
    .from(turnosTable)
    .innerJoin(pacientesTable, eq(turnosTable.pacienteId, pacientesTable.id))
    .innerJoin(turnerasTable, eq(turnosTable.turneraId, turnerasTable.id))
    .innerJoin(especialidadesTable, eq(turnerasTable.especialidadId, especialidadesTable.id))
    .where(
      and(
        eq(turnosTable.id, turnoId),
        // La turnera puede fijar el envío a worklist; si no lo define (null), hereda de la especialidad
        sql`coalesce(${turnerasTable.enviaWorklist}, ${especialidadesTable.enviaAlPacs}) = true`,
      ),
    )
    .limit(1);
  return row ?? null;
}

// ── Sincronizar un turno con la worklist ────────────────────────────────────
// Idempotente y fire-and-forget: crea/actualiza el ítem local en estado
// "pendiente" para que el despachador lo publique. Nunca lanza.
export async function sincronizarWorklistTurno(
  turnoId: number,
  log: pino.Logger = logger,
  opts: { forzarReenvio?: boolean } = {},
): Promise<void> {
  if (!pacsWorklistHabilitado()) return;
  try {
    const row = await cargarTurnoWorklist(turnoId);
    const [existente] = await db
      .select()
      .from(pacsWorklistItemsTable)
      .where(eq(pacsWorklistItemsTable.turnoId, turnoId))
      .limit(1);

    if (!row) {
      // El turno no va al PACS (o fue borrado). Si había ítem publicado, se cancela.
      if (existente && existente.worklistStatus !== "cancelled") {
        await db
          .update(pacsWorklistItemsTable)
          .set({ worklistStatus: "cancelled", estadoEnvio: "pendiente", proximoIntentoEn: null, updatedAt: new Date() })
          .where(eq(pacsWorklistItemsTable.id, existente.id));
        void despacharPendientes(log);
      }
      return;
    }

    const status = worklistStatusDeTurno(row.turno.estado);
    if (!status) return;

    if (!existente) {
      if (status === "cancelled") return; // nunca se publicó, nada que cancelar
      const accession = await generarAccession();
      await db
        .insert(pacsWorklistItemsTable)
        .values({
          turnoId,
          orderId: String(turnoId),
          accessionNumber: accession,
          modalidad: row.especialidad.modalidadDicom ?? null,
          // Regla: el estudio va al PACS con el mismo nombre que la agenda
          descripcionEstudio: row.turnera.nombre,
          worklistStatus: status,
          estadoEnvio: "pendiente",
        })
        .onConflictDoNothing({ target: pacsWorklistItemsTable.turnoId });
    } else if (existente.worklistStatus !== status || existente.estadoEnvio === "error" || opts.forzarReenvio) {
      await db
        .update(pacsWorklistItemsTable)
        .set({
          worklistStatus: status,
          modalidad: row.especialidad.modalidadDicom ?? existente.modalidad,
          descripcionEstudio: row.turnera.nombre,
          estadoEnvio: "pendiente",
          proximoIntentoEn: null,
          updatedAt: new Date(),
        })
        .where(eq(pacsWorklistItemsTable.id, existente.id));
    } else {
      return; // sin cambios
    }
    void despacharPendientes(log);
  } catch (err) {
    log.error({ err, turnoId }, "PACS worklist: error al sincronizar el turno");
  }
}

// ── Copia de una orden de estudio al PACS ───────────────────────────────────
// El médico emite la orden (asistente de órdenes) y una copia va a la worklist
// del PACS como estudio agendado. Idempotente por orden; nunca lanza.
export async function enviarOrdenEstudioAlPacs(ordenId: number, log: pino.Logger = logger): Promise<void> {
  if (!pacsWorklistHabilitado()) return;
  try {
    const [existente] = await db
      .select()
      .from(pacsWorklistItemsTable)
      .where(eq(pacsWorklistItemsTable.ordenEstudioId, ordenId))
      .limit(1);
    if (existente) return; // ya encolada/publicada

    const [orden] = await db.select().from(studyOrdersTable).where(eq(studyOrdersTable.id, ordenId)).limit(1);
    if (!orden) return;

    const accession = orden.accessionNumber ?? (await generarAccession());
    // Modalidad DICOM: la de la orden o, si falta, la de la práctica del catálogo
    let modalidad = orden.modality ?? null;
    if (!modalidad && orden.practicaId != null) {
      const [prac] = await db
        .select({ modalidadDicom: practicasCatalogoTable.modalidadDicom })
        .from(practicasCatalogoTable)
        .where(eq(practicasCatalogoTable.id, orden.practicaId))
        .limit(1);
      modalidad = prac?.modalidadDicom ?? null;
    }
    await db
      .insert(pacsWorklistItemsTable)
      .values({
        ordenEstudioId: ordenId,
        orderId: `SO-${ordenId}`,
        accessionNumber: accession,
        modalidad,
        descripcionEstudio: orden.contraste ? `${orden.studyName} (con contraste)` : orden.studyName,
        worklistStatus: "scheduled",
        estadoEnvio: "pendiente",
      })
      .onConflictDoNothing({
        target: pacsWorklistItemsTable.ordenEstudioId,
        // El índice único es parcial (WHERE orden_estudio_id IS NOT NULL);
        // sin este predicado Postgres no encuentra el índice y el insert falla.
        where: sql`orden_estudio_id is not null`,
      });
    void despacharPendientes(log);
  } catch (err) {
    log.error({ err, ordenId }, "PACS worklist: error al encolar la copia de la orden");
  }
}

// ── Publicación al PACS ──────────────────────────────────────────────────────

type ResultadoEnvio = { ok: true } | { ok: false; message: string };

// Adapta el resultado del cliente v1 al formato de la cola. Un 409 (CONFLICTO)
// significa que la orden ya existe en el PACS: para esta cola es éxito.
function deResultadoV1(r: PacsV1Result<unknown>): ResultadoEnvio {
  if (r.ok) return { ok: true };
  if (r.code === "CONFLICTO") return { ok: true };
  return { ok: false, message: r.message };
}

// Un 409 en el ALTA puede significar dos cosas muy distintas:
//   - la orden ya existe en el PACS (misma order_id/accession): éxito idempotente
//   - el accession ya está usado por OTRA orden: el alta fue RECHAZADA y la
//     orden no existe — seguir como si fuera éxito rompe la recepción (404).
// Caso real: agosto 2026, turno de ergometría con accession en conflicto.
function esConflictoDeAccession(r: PacsV1Result<unknown>): r is Extract<PacsV1Result<unknown>, { ok: false }> {
  // Solo el conflicto "accession usado por otra orden" se resuelve regenerando;
  // otros 409 que mencionen accession (p. ej. campo inmutable de una orden
  // existente) NO deben regenerar, por eso el match exige "usado/used/otra".
  return !r.ok && r.code === "CONFLICTO" && /accession/i.test(r.message) && /(usad|used|otra orden|another order)/i.test(r.message);
}

// El accession chocó con una orden ajena en el PACS: se genera uno nuevo para
// el ítem y se devuelve error para que el despachador reintente (el reintento
// sale con el accession nuevo y una clave de idempotencia nueva).
async function regenerarAccessionItem(item: PacsWorklistItem, motivo: string, log: pino.Logger): Promise<ResultadoEnvio> {
  const nuevo = await generarAccession();
  // CAS: solo pisa el accession si nadie lo regeneró ya (dos despachos
  // concurrentes no deben quemar dos números ni pisarse entre sí).
  const actualizadas = await db
    .update(pacsWorklistItemsTable)
    .set({ accessionNumber: nuevo, updatedAt: new Date() })
    .where(and(eq(pacsWorklistItemsTable.id, item.id), eq(pacsWorklistItemsTable.accessionNumber, item.accessionNumber)))
    .returning({ id: pacsWorklistItemsTable.id });
  if (actualizadas.length === 0) {
    return { ok: false, message: "Accession en conflicto; otro despacho ya lo regeneró, se reintenta" };
  }
  log.warn(
    { orderId: item.orderId, accessionViejo: item.accessionNumber, accessionNuevo: nuevo },
    "PACS worklist: accession en conflicto en el PACS; se regeneró para reintentar",
  );
  return { ok: false, message: `Accession en conflicto en el PACS (se regeneró como ${nuevo} para el reintento): ${motivo}` };
}

// Cancelación: si el PACS no conoce la orden (nunca llegó a publicarse o ya
// fue borrada), un 404 también cuenta como éxito.
async function cancelarOrdenEnPacs(orderId: string, accession: string): Promise<ResultadoEnvio> {
  const r = await anularOrden(orderId, `${accession}:cancelled`);
  if (!r.ok && r.status === 404) return { ok: true };
  return deResultadoV1(r);
}

// Formatea un instante en hora argentina con offset explícito -03:00 (mismo
// formato que usa la publicación de turnos: YYYY-MM-DDTHH:mm:00-03:00).
function fechaHoraArgentina(d: Date): string {
  const ar = new Date(d.getTime() - 3 * 60 * 60 * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${ar.getUTCFullYear()}-${p(ar.getUTCMonth() + 1)}-${p(ar.getUTCDate())}T${p(ar.getUTCHours())}:${p(ar.getUTCMinutes())}:00-03:00`;
}

// Publica la copia de una orden de estudio (sin turno) por el canal de órdenes.
async function publicarItemDeOrden(item: PacsWorklistItem, log: pino.Logger): Promise<ResultadoEnvio> {
  if (item.ordenEstudioId == null) return { ok: false, message: "Ítem sin turno ni orden de estudio" };
  const [row] = await db
    .select({ orden: studyOrdersTable, paciente: pacientesTable })
    .from(studyOrdersTable)
    .innerJoin(pacientesTable, eq(studyOrdersTable.patientId, pacientesTable.id))
    .where(eq(studyOrdersTable.id, item.ordenEstudioId))
    .limit(1);
  if (!row) return { ok: false, message: "La orden de estudio del ítem ya no existe" };

  // practice_id: código de la práctica del catálogo si existe, si no el nombre
  let practiceId: string | null = null;
  if (row.orden.practicaId != null) {
    const [prac] = await db
      .select({ codigo: practicasCatalogoTable.codigo })
      .from(practicasCatalogoTable)
      .where(eq(practicasCatalogoTable.id, row.orden.practicaId))
      .limit(1);
    practiceId = prac?.codigo ?? null;
  }
  const orden: PacsOrderUpsert = {
    order_id: item.orderId,
    accession_number: item.accessionNumber,
    conectar_patient_id: String(row.paciente.id),
    external_patient_id: (row.paciente.dni ?? "").replace(/\D/g, ""),
    patient_first_name: row.paciente.nombre ?? null,
    patient_last_name: row.paciente.apellido ?? null,
    patient_birth_date: fechaNacimientoParaPacs(row.paciente.fechaNacimiento),
    patient_sex: sexoParaPacs(row.paciente.sexo),
    patient_phone: row.paciente.telefono ?? row.paciente.telefonoAlternativo ?? null,
    practice_id: practiceId ?? row.orden.studyName,
    practice_description: item.descripcionEstudio ?? row.orden.studyName,
    modality: item.modalidad ?? "OT",
    reason_for_study: row.orden.clinicalJustification ?? row.orden.studyName,
    technician_notes: row.orden.observacionesTecnico ?? null,
    scheduled_at: fechaHoraArgentina(row.orden.createdAt ?? new Date()),
  };
  log.debug({ orderId: item.orderId }, "PACS worklist: publicando copia de orden por canal de órdenes");
  // La clave incluye la modalidad: si cambia el dato, el upsert debe aplicarse
  // (una clave fija haría que el PACS devuelva la respuesta cacheada).
  const alta = await upsertOrden(orden, `${item.accessionNumber}:orden:${orden.modality}`);
  if (esConflictoDeAccession(alta)) return regenerarAccessionItem(item, alta.message, log);
  return deResultadoV1(alta);
}

async function publicarItem(item: PacsWorklistItem, log: pino.Logger): Promise<ResultadoEnvio> {
  if (!pacsV1Configurado()) {
    return { ok: false, message: "Falta el token del canal de órdenes (PACS_INTEGRATION_TOKEN/PACS_API_TOKEN)" };
  }
  if (item.worklistStatus === "cancelled") {
    return cancelarOrdenEnPacs(item.orderId, item.accessionNumber);
  }
  if (item.worklistStatus === "ready_to_report") {
    // Lo determina el PACS cuando recibe las imágenes del equipo: no se envía.
    return { ok: true };
  }
  if (item.turnoId == null) return publicarItemDeOrden(item, log);
  const row = await cargarTurnoWorklist(item.turnoId);
  if (!row) return { ok: false, message: "El turno del ítem ya no existe o dejó de ir al PACS" };

  const orden: PacsOrderUpsert = {
    order_id: item.orderId,
    accession_number: item.accessionNumber,
    conectar_patient_id: String(row.paciente.id),
    external_patient_id: (row.paciente.dni ?? "").replace(/\D/g, ""),
    patient_first_name: row.paciente.nombre ?? null,
    patient_last_name: row.paciente.apellido ?? null,
    patient_birth_date: fechaNacimientoParaPacs(row.paciente.fechaNacimiento),
    patient_sex: sexoParaPacs(row.paciente.sexo),
    // El PACS usa el teléfono para precargar el contacto del paciente
    patient_phone: row.paciente.telefono ?? row.paciente.telefonoAlternativo ?? null,
    practice_id: row.especialidad.codigo ?? row.especialidad.nombre,
    practice_description: item.descripcionEstudio ?? row.especialidad.nombre,
    modality: item.modalidad ?? "OT",
    reason_for_study: `Turno de ${row.especialidad.nombre}`,
    // Con offset explícito de Argentina: sin él, el PACS interpretaba la
    // fecha/hora como UTC y las órdenes aparecían corridas al día anterior.
    scheduled_at: `${row.turno.fecha}T${row.turno.horaInicio}:00-03:00`,
  };
  // Región anatómica del turno → body_part dentro de procedure (API v1.0,
  // pedido del equipo PACS jul 2026). Solo se manda si está cargada.
  const region = (row.turno.regionAnatomica ?? "").trim();
  if (region) orden.procedure = { body_part: region };
  log.debug({ orderId: item.orderId, status: item.worklistStatus }, "PACS worklist: publicando ítem por canal de órdenes");

  // Alta idempotente de la orden (AGENDADO en el PACS). Un 409 = ya existe.
  // La clave incluye la modalidad y la región: si cambia el dato, el upsert
  // debe aplicarse (una clave fija haría que el PACS devuelva la respuesta cacheada).
  const altaCrudo = await upsertOrden(orden, `${item.accessionNumber}:orden:${orden.modality}:${region || "-"}`);
  if (esConflictoDeAccession(altaCrudo)) return regenerarAccessionItem(item, altaCrudo.message, log);
  const alta = deResultadoV1(altaCrudo);
  if (!alta.ok) return alta;

  if (item.worklistStatus === "arrived") {
    // El paciente fue recepcionado: pasa a RECEPCIONADO en la cola del PACS.
    const r = await notificarRecepcion(item.orderId, fechaHoraArgentina(new Date()), `${item.accessionNumber}:reception`);
    return deResultadoV1(r);
  }
  // scheduled: alcanza con el alta. ready_to_report: no se envía (lo
  // determina el PACS cuando recibe las imágenes del equipo).
  return { ok: true };
}

let despachando = false;

// Despacha los ítems pendientes (o con error cuyo backoff ya venció).
export async function despacharPendientes(log: pino.Logger = logger): Promise<number> {
  if (!pacsWorklistHabilitado() || despachando) return 0;
  despachando = true;
  let publicados = 0;
  try {
    const ahora = new Date();
    const pendientes = await db
      .select()
      .from(pacsWorklistItemsTable)
      .where(
        and(
          inArray(pacsWorklistItemsTable.estadoEnvio, ["pendiente", "error"]),
          or(isNull(pacsWorklistItemsTable.proximoIntentoEn), lte(pacsWorklistItemsTable.proximoIntentoEn, ahora)),
        ),
      )
      .limit(25);

    for (const item of pendientes) {
      // Claim atómico (CAS): se corre proximo_intento_en al futuro solo si el
      // ítem sigue en el estado/intento leídos. Si otra instancia ya lo tomó,
      // rowCount es 0 y se saltea — evita doble publicación en multi-nodo.
      const reclamados = await db
        .update(pacsWorklistItemsTable)
        .set({ proximoIntentoEn: new Date(Date.now() + 120_000), updatedAt: new Date() })
        .where(
          and(
            eq(pacsWorklistItemsTable.id, item.id),
            eq(pacsWorklistItemsTable.estadoEnvio, item.estadoEnvio),
            eq(pacsWorklistItemsTable.intentos, item.intentos),
          ),
        )
        .returning({ id: pacsWorklistItemsTable.id });
      if (reclamados.length === 0) continue;

      const resultado = await publicarItem(item, log);
      if (resultado.ok) {
        await db
          .update(pacsWorklistItemsTable)
          .set({
            estadoEnvio: item.worklistStatus === "cancelled" ? "cancelado" : "publicado",
            publicadoEn: new Date(),
            ultimoError: null,
            proximoIntentoEn: null,
            updatedAt: new Date(),
          })
          .where(eq(pacsWorklistItemsTable.id, item.id));
        publicados++;
        log.info(
          { orderId: item.orderId, accession: item.accessionNumber, status: item.worklistStatus },
          "PACS worklist: ítem publicado en el PACS",
        );
      } else {
        const intentos = item.intentos + 1;
        const backoffSeg = Math.min(2 ** Math.min(intentos, 6), 64) * 30; // 60s..32min
        await db
          .update(pacsWorklistItemsTable)
          .set({
            estadoEnvio: "error",
            intentos,
            ultimoError: resultado.message,
            proximoIntentoEn: new Date(Date.now() + backoffSeg * 1000),
            updatedAt: new Date(),
          })
          .where(eq(pacsWorklistItemsTable.id, item.id));
        log.warn(
          { orderId: item.orderId, intentos, msg: resultado.message },
          "PACS worklist: fallo al publicar, se reintenta",
        );
      }
    }
  } catch (err) {
    log.error({ err }, "PACS worklist: error en el despachador");
  } finally {
    despachando = false;
  }
  return publicados;
}

// ── Reconciliador ───────────────────────────────────────────────────────────
// Red de seguridad: detecta turnos (de hoy en adelante) de especialidades que
// van al PACS cuyo ítem falta o quedó desfasado (el estado del turno cambia
// en varios lugares del sistema). Encola las diferencias.
export async function reconciliarWorklist(log: pino.Logger = logger): Promise<void> {
  if (!pacsWorklistHabilitado()) return;
  const desde = hoyArgentina();
  const rows = await db
    .select({
      turnoId: turnosTable.id,
      estado: turnosTable.estado,
      itemStatus: pacsWorklistItemsTable.worklistStatus,
      itemId: pacsWorklistItemsTable.id,
    })
    .from(turnosTable)
    .innerJoin(turnerasTable, eq(turnosTable.turneraId, turnerasTable.id))
    .innerJoin(especialidadesTable, eq(turnerasTable.especialidadId, especialidadesTable.id))
    .leftJoin(pacsWorklistItemsTable, eq(pacsWorklistItemsTable.turnoId, turnosTable.id))
    .where(
      and(
        sql`coalesce(${turnerasTable.enviaWorklist}, ${especialidadesTable.enviaAlPacs}) = true`,
        gte(turnosTable.fecha, desde),
      ),
    );

  for (const r of rows) {
    const esperado = worklistStatusDeTurno(r.estado);
    if (!esperado) continue;
    if (!r.itemId && esperado === "cancelled") continue;
    if (r.itemStatus === esperado) continue;
    await sincronizarWorklistTurno(r.turnoId, log);
  }
}

// ── Worker ──────────────────────────────────────────────────────────────────
const INTERVALO_MS = Number(process.env.PACS_WORKLIST_INTERVAL_MS ?? 30_000);
let intervalo: NodeJS.Timeout | null = null;

export function iniciarPacsWorklistWorker(): void {
  if (!pacsWorklistHabilitado()) {
    logger.info("PACS worklist: deshabilitado (PACS_WORKLIST_ENABLED != true)");
    return;
  }
  if (intervalo) return;
  logger.info({ intervaloMs: INTERVALO_MS, canal: "ordenes-v1" }, "PACS worklist: worker iniciado");
  intervalo = setInterval(() => {
    void (async () => {
      try {
        await reconciliarWorklist();
        await despacharPendientes();
      } catch (err) {
        logger.error({ err }, "PACS worklist: error en el ciclo del worker");
      }
    })();
  }, INTERVALO_MS);
  intervalo.unref();
}
