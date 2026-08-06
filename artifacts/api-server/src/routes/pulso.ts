import { Router, type IRouter } from "express";
import { eq, and, gte, lt, desc, sql } from "drizzle-orm";
import { db, pacientesTable, pulsoEstudiosTable, pacientesExternosTable } from "@workspace/db";
import { getUserFromRequest } from "./auth";
import {
  fetchInformeDetalle,
  fetchInformePdf,
  pulsoConfigurado,
  PulsoError,
} from "../integraciones/pulso-client";
import { getEstadoSync } from "../integraciones/pulso-sync";

const router: IRouter = Router();

// ── Estudios / Informes de Pulso ────────────────────────────────────────────
// La LISTA de estudios se lee desde nuestra tabla local (poblada por el sync),
// así la ficha del paciente carga rápido. El CONTENIDO del informe y el PDF
// firmado se consultan EN VIVO a Pulso on-demand (no se almacenan).
// Acceso: staff (admin/medico/recepcionista) a cualquier paciente; el paciente
// solo a su propia ficha.

function esStaff(rol: string): boolean {
  return ["admin", "medico", "recepcionista"].includes(rol);
}

// GET /api/pulso/pacientes/:id/estudios — lista desde DB local
router.get("/pulso/pacientes/:id/estudios", async (req, res) => {
  const user = await getUserFromRequest(req);
  if (!user) return res.status(401).json({ error: "No autenticado" });

  const pacienteId = Number(req.params.id);
  if (!Number.isInteger(pacienteId) || pacienteId <= 0) {
    return res.status(400).json({ error: "ID de paciente inválido" });
  }

  if (!esStaff(user.rol)) {
    if (user.rol !== "paciente") return res.status(403).json({ error: "Rol sin permisos" });
    const propio = user.pacienteId ? parseInt(user.pacienteId) : null;
    if (propio !== pacienteId) return res.status(403).json({ error: "No autorizado" });
  }

  const [paciente] = await db
    .select({ id: pacientesTable.id })
    .from(pacientesTable)
    .where(eq(pacientesTable.id, pacienteId))
    .limit(1);
  if (!paciente) return res.status(404).json({ error: "Paciente no encontrado" });

  const filas = await db
    .select({
      id: pulsoEstudiosTable.id,
      pulsoId: pulsoEstudiosTable.pulsoId,
      idLegible: pulsoEstudiosTable.idLegible,
      modalidad: pulsoEstudiosTable.modalidad,
      tipoEstudio: pulsoEstudiosTable.tipoEstudio,
      sedeNombre: pulsoEstudiosTable.sedeNombre,
      estado: pulsoEstudiosTable.estado,
      fechaEstudio: pulsoEstudiosTable.fechaEstudio,
      medicoAsignado: pulsoEstudiosTable.medicoAsignado,
      medicoDerivante: pulsoEstudiosTable.medicoDerivante,
      tieneInforme: pulsoEstudiosTable.tieneInforme,
      informePulsoId: pulsoEstudiosTable.informePulsoId,
      informeFirmado: pulsoEstudiosTable.informeFirmado,
      observaciones: pulsoEstudiosTable.observaciones,
      fechaSincronizado: pulsoEstudiosTable.syncedAt,
    })
    .from(pulsoEstudiosTable)
    .where(eq(pulsoEstudiosTable.patientId, pacienteId))
    .orderBy(desc(pulsoEstudiosTable.fechaEstudio), desc(pulsoEstudiosTable.createdAtPulso));

  return res.json({ estudios: filas });
});

// GET /api/pulso/informes/:informeId — detalle EN VIVO (motivo/hallazgos/conclusión)
router.get("/pulso/informes/:informeId", async (req, res) => {
  const user = await getUserFromRequest(req);
  if (!user) return res.status(401).json({ error: "No autenticado" });

  const informeId = String(req.params.informeId);
  if (!informeId) return res.status(400).json({ error: "ID de informe inválido" });

  // Solo staff puede abrir el contenido del informe (los pacientes ven la lista
  // pero el contenido clínico completo se restringe a staff en esta versión).
  if (!esStaff(user.rol)) return res.status(403).json({ error: "Rol sin permisos" });

  if (!pulsoConfigurado()) {
    return res.status(503).json({ error: "Integración Pulso no configurada (faltan credenciales)" });
  }

  try {
    const d = await fetchInformeDetalle(informeId, req.log);
    const firmadoPor = d.firmado_por
      ? `${d.firmado_por.first_name ?? ""} ${d.firmado_por.last_name ?? ""}`.trim() || null
      : null;
    const medicoAsignado = d.estudio?.medico_asignado
      ? `${d.estudio.medico_asignado.first_name ?? ""} ${d.estudio.medico_asignado.last_name ?? ""}`.trim() ||
        null
      : null;
    const informe = {
      id: d.id,
      motivo: d.motivo ?? null,
      hallazgos: d.hallazgos ?? null,
      conclusion: d.conclusion ?? null,
      observaciones: d.observaciones ?? null,
      enlacePacs: d.enlace_pacs ?? null,
      firmado: Boolean(d.firmado),
      firmadoPor,
      firmadoAt: d.firmado_at ?? null,
      idLegible: d.estudio?.id_legible ?? null,
      tipoEstudio: d.estudio?.tipo_estudio?.nombre ?? null,
      sedeNombre: d.estudio?.sede?.nombre ?? null,
      fechaEstudio: d.estudio?.fecha_estudio ?? null,
      medicoAsignado,
    };
    return res.json({ informe });
  } catch (err) {
    if (err instanceof PulsoError && err.status === 404) {
      return res.status(404).json({ error: "Informe no encontrado en Pulso" });
    }
    req.log.warn({ err, informeId }, "Pulso: consulta de informe falló");
    return res.status(502).json({ error: "No se pudo consultar el informe en Pulso" });
  }
});

// GET /api/pulso/informes/:informeId/pdf — proxy autenticado del PDF firmado
router.get("/pulso/informes/:informeId/pdf", async (req, res) => {
  const user = await getUserFromRequest(req);
  if (!user) return res.status(401).json({ error: "No autenticado" });

  const informeId = String(req.params.informeId);
  if (!informeId) return res.status(400).json({ error: "ID de informe inválido" });

  if (!esStaff(user.rol)) return res.status(403).json({ error: "Rol sin permisos" });

  if (!pulsoConfigurado()) {
    return res.status(503).json({ error: "Integración Pulso no configurada (faltan credenciales)" });
  }

  try {
    const { buffer } = await fetchInformePdf(informeId, req.log);
    // Endurecemos el proxy: verificamos la firma %PDF- y forzamos el
    // content-type, en vez de confiar en el header upstream (evita que un
    // contenido activo no-PDF se ejecute bajo el origen de la app).
    const esPdf = buffer.subarray(0, 5).toString("latin1") === "%PDF-";
    if (!esPdf) {
      req.log.warn({ informeId }, "Pulso: respuesta de PDF no tiene firma %PDF-");
      return res.status(502).json({ error: "El informe recibido no es un PDF válido" });
    }
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Content-Disposition", `inline; filename="informe-${informeId}.pdf"`);
    return res.send(buffer);
  } catch (err) {
    if (err instanceof PulsoError && err.status === 404) {
      return res.status(404).json({ error: "PDF de informe no encontrado en Pulso" });
    }
    req.log.warn({ err, informeId }, "Pulso: descarga de PDF de informe falló");
    return res.status(502).json({ error: "No se pudo descargar el PDF del informe" });
  }
});

// GET /api/pulso/sincronizados-hoy — pacientes traídos desde Pulso hoy
// Sirve para verificar de un vistazo que el sync está entrando pacientes nuevos.
router.get("/pulso/sincronizados-hoy", async (req, res) => {
  const user = await getUserFromRequest(req);
  if (!user) return res.status(401).json({ error: "No autenticado" });
  if (!esStaff(user.rol)) return res.status(403).json({ error: "Rol sin permisos" });

  const fechaParam = typeof req.query["fecha"] === "string" ? req.query["fecha"] : undefined;
  let today = new Date().toISOString().split("T")[0];
  if (fechaParam !== undefined) {
    const inicioParam = new Date(`${fechaParam}T00:00:00.000Z`);
    // Regex + validación semántica: rechazar fechas como 2026-99-99 (que pasan
    // el patrón pero producen Invalid Date) en vez de fallar con un 500.
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(fechaParam) ||
      Number.isNaN(inicioParam.getTime()) ||
      inicioParam.toISOString().split("T")[0] !== fechaParam
    ) {
      return res.status(400).json({ error: "Fecha inválida (formato esperado YYYY-MM-DD)" });
    }
    today = fechaParam;
  }
  const inicio = new Date(`${today}T00:00:00.000Z`);
  const fin = new Date(inicio);
  fin.setUTCDate(fin.getUTCDate() + 1);

  const esPulso = eq(pacientesExternosTable.origen, "pulso");

  const [{ nuevosHoy }] = await db
    .select({ nuevosHoy: sql<number>`count(*)::int` })
    .from(pacientesExternosTable)
    .where(and(esPulso, gte(pacientesExternosTable.createdAt, inicio), lt(pacientesExternosTable.createdAt, fin)));

  const [{ actualizadosHoy }] = await db
    .select({ actualizadosHoy: sql<number>`count(*)::int` })
    .from(pacientesExternosTable)
    .where(and(esPulso, gte(pacientesExternosTable.lastSyncedAt, inicio), lt(pacientesExternosTable.lastSyncedAt, fin)));

  const [{ totalPulso }] = await db
    .select({ totalPulso: sql<number>`count(*)::int` })
    .from(pacientesExternosTable)
    .where(esPulso);

  // Lista de los pacientes tocados por el sync hoy (más recientes primero).
  const filas = await db
    .select({
      pacienteId: pacientesTable.id,
      nombre: pacientesTable.nombre,
      apellido: pacientesTable.apellido,
      dni: pacientesTable.dni,
      numeroHc: pacientesTable.numeroHc,
      lastSyncedAt: pacientesExternosTable.lastSyncedAt,
      createdAt: pacientesExternosTable.createdAt,
    })
    .from(pacientesExternosTable)
    .innerJoin(pacientesTable, eq(pacientesTable.id, pacientesExternosTable.patientId))
    .where(and(esPulso, gte(pacientesExternosTable.lastSyncedAt, inicio), lt(pacientesExternosTable.lastSyncedAt, fin)))
    .orderBy(desc(pacientesExternosTable.lastSyncedAt))
    .limit(100);

  const pacientes = filas.map((f) => ({
    pacienteId: f.pacienteId,
    nombre: f.nombre,
    apellido: f.apellido,
    dni: f.dni ?? null,
    numeroHc: f.numeroHc ?? null,
    lastSyncedAt: f.lastSyncedAt.toISOString(),
    createdAt: f.createdAt.toISOString(),
    esNuevoHoy: f.createdAt >= inicio && f.createdAt < fin,
  }));

  const estado = getEstadoSync();

  return res.json({
    fecha: today,
    configurado: pulsoConfigurado(),
    sincronizando: estado.sincronizando,
    nuevosHoy: nuevosHoy ?? 0,
    actualizadosHoy: actualizadosHoy ?? 0,
    totalPulso: totalPulso ?? 0,
    ultimaSincronizacion: estado.terminadoEn,
    ultimoModo: estado.ultimoModo,
    pacientes,
  });
});

export default router;
