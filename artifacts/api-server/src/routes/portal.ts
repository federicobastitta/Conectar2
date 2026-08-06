import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import {
  db,
  turnosTable,
  turnerasTable,
  pacientesTable,
  profesionalesTable,
  especialidadesTable,
  sedesTable,
} from "@workspace/db";
import { GetPortalTurnosQueryParams } from "@workspace/api-zod";

const router: IRouter = Router();

// Endpoint publico del portal del paciente: devuelve SOLO los turnos del DNI
// consultado, con un subconjunto minimo de campos (sin datos de terceros ni
// datos sensibles como cobertura, observaciones o motivo de consulta).
router.get("/portal/turnos", async (req, res): Promise<void> => {
  const parsed = GetPortalTurnosQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: "DNI invalido" });
    return;
  }
  const dni = parsed.data.dni.trim();
  if (!/^\d{7,10}$/.test(dni)) {
    res.status(400).json({ error: "DNI invalido" });
    return;
  }

  const [paciente] = await db
    .select({ id: pacientesTable.id })
    .from(pacientesTable)
    .where(eq(pacientesTable.dni, dni))
    .limit(1);

  if (!paciente) {
    // Misma respuesta que "sin turnos" para no revelar si el DNI existe
    res.json({ turnos: [] });
    return;
  }

  const rows = await db
    .select({
      id: turnosTable.id,
      turneraId: turnosTable.turneraId,
      fecha: turnosTable.fecha,
      horaInicio: turnosTable.horaInicio,
      estado: turnosTable.estado,
      modalidad: turnosTable.modalidad,
      profesionalNombre: profesionalesTable.nombre,
      profesionalApellido: profesionalesTable.apellido,
      especialidadNombre: especialidadesTable.nombre,
      sedeNombre: sedesTable.nombre,
      // OJO: NUNCA devolver qrCodigo acá — este endpoint es público por DNI
      // y el QR funciona como credencial de identificación en recepción.
    })
    .from(turnosTable)
    .leftJoin(turnerasTable, eq(turnosTable.turneraId, turnerasTable.id))
    .leftJoin(profesionalesTable, eq(turnosTable.profesionalId, profesionalesTable.id))
    .leftJoin(especialidadesTable, eq(turnerasTable.especialidadId, especialidadesTable.id))
    .leftJoin(sedesTable, eq(turnerasTable.sedeId, sedesTable.id))
    .where(eq(turnosTable.pacienteId, paciente.id))
    .orderBy(turnosTable.fecha, turnosTable.horaInicio);

  res.json({ turnos: rows });
});

export default router;
