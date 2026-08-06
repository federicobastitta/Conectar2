import { Router, type IRouter, type Request, type Response } from "express";
import crypto from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { db, turnosTable, turnerasTable, sedesTable, profesionalesTable, especialidadesTable } from "@workspace/db";
import { hoyArgentina, horaArgentina } from "../lib/tiempo";

// ── Consulta de sala de espera para el PACS (Pixel) ─────────────────────────
// Endpoint de integración de solo lectura: Pixel consulta cuánta gente hay en
// sala de espera por agenda para publicarlo en sus salas de admisión.
// Auth: Bearer token compartido (PACS_WORKLIST_TOKEN o PACS_API_TOKEN), igual
// que el resto de la integración con el PACS. Sin datos de pacientes: solo
// conteos y datos de la agenda.

const router: IRouter = Router();

const ESTADOS_EN_ESPERA = ["arribo", "en_sala"] as const;
const ESTADOS_COLA = ["arribo", "en_sala", "llamado", "en_atencion"] as const;

function tokenEsperado(): string | null {
  return (process.env.PACS_WORKLIST_TOKEN ?? process.env.PACS_API_TOKEN)?.trim() || null;
}

function autorizado(req: Request): boolean {
  const esperado = tokenEsperado();
  if (!esperado) return false;
  const header = String(req.headers.authorization ?? "");
  const recibido = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!recibido) return false;
  const a = Buffer.from(recibido, "utf8");
  const b = Buffer.from(esperado, "utf8");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

router.get("/pacs/sala-espera", async (req: Request, res: Response) => {
  if (!tokenEsperado()) {
    return res.status(503).json({ error: "Integración PACS no configurada (falta token)" });
  }
  if (!autorizado(req)) {
    return res.status(401).json({ error: "Token inválido" });
  }

  const fecha = hoyArgentina();

  const filas = await db
    .select({
      turneraId: turnosTable.turneraId,
      estado: turnosTable.estado,
      turneraNombre: turnerasTable.nombre,
      sedeNombre: sedesTable.nombre,
      profesionalNombre: profesionalesTable.nombre,
      profesionalApellido: profesionalesTable.apellido,
      especialidadNombre: especialidadesTable.nombre,
    })
    .from(turnosTable)
    .innerJoin(turnerasTable, eq(turnosTable.turneraId, turnerasTable.id))
    .leftJoin(sedesTable, eq(turnerasTable.sedeId, sedesTable.id))
    .leftJoin(profesionalesTable, eq(turnerasTable.profesionalId, profesionalesTable.id))
    .leftJoin(especialidadesTable, eq(turnerasTable.especialidadId, especialidadesTable.id))
    .where(and(eq(turnosTable.fecha, fecha), inArray(turnosTable.estado, [...ESTADOS_COLA])));

  type Agrupado = {
    turneraId: number;
    agenda: string;
    sede: string | null;
    profesional: string | null;
    especialidad: string | null;
    enSalaDeEspera: number;
    llamados: number;
    enAtencion: number;
  };

  const porTurnera = new Map<number, Agrupado>();
  for (const f of filas) {
    let g = porTurnera.get(f.turneraId);
    if (!g) {
      const profesional = [f.profesionalApellido, f.profesionalNombre].filter(Boolean).join(", ") || null;
      g = {
        turneraId: f.turneraId,
        agenda: f.turneraNombre,
        sede: f.sedeNombre ?? null,
        profesional,
        especialidad: f.especialidadNombre ?? null,
        enSalaDeEspera: 0,
        llamados: 0,
        enAtencion: 0,
      };
      porTurnera.set(f.turneraId, g);
    }
    if ((ESTADOS_EN_ESPERA as readonly string[]).includes(f.estado)) g.enSalaDeEspera += 1;
    else if (f.estado === "llamado") g.llamados += 1;
    else if (f.estado === "en_atencion") g.enAtencion += 1;
  }

  const agendas = [...porTurnera.values()].sort((a, b) => b.enSalaDeEspera - a.enSalaDeEspera);

  return res.json({
    fecha,
    horaLocal: horaArgentina(),
    totalEnSalaDeEspera: agendas.reduce((acc, a) => acc + a.enSalaDeEspera, 0),
    agendas,
  });
});

export default router;
