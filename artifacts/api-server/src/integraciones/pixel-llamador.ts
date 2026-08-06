// ── Aviso de llamado a Pixel (DiagnosticPACS) ────────────────────────────────
// Cuando alguien llama a un paciente en Conectar (turno pasa a "llamado"),
// avisamos a Pixel en su endpoint de llamador para que puedan verlo/anunciarlo
// de su lado. URL exacta pedida por Pixel (ago 2026):
//   POST {base}/api/v1/integration/llamador
// Incluye sala_id/sala_nombre (pedido de Pixel: campo opcional; si no va,
// usan la sala de siempre). Fire-and-forget: nunca frena ni rompe el llamado.
import { db, turnosTable, turnerasTable, pacientesTable, profesionalesTable, sedesTable, salasLlamadoTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import type { Logger } from "pino";
import { pixelEnvioActivo } from "./pixel-guard";

const BASE_URL = () =>
  (process.env.PACS_INTEGRATION_BASE_URL ??
    process.env.DIAGNOSTIPACS_BASE_URL ??
    "https://medical-vision-ai.replit.app").replace(/\/$/, "");

function serviceToken(): string | null {
  return (
    process.env.CONECTAR_INTEGRATION_TOKEN?.trim() ||
    process.env.PACS_INTEGRATION_TOKEN?.trim() ||
    process.env.PACS_API_TOKEN?.trim() ||
    null
  );
}

export async function avisarLlamadoPixel(turnoId: number, log: Logger): Promise<void> {
  const token = serviceToken();
  if (!token) return;
  // Guard completo (POST): aviso de llamado nunca sale fuera de producción.
  if (!pixelEnvioActivo()) {
    log.info({ turnoId }, "Pixel: envío omitido en entorno no-producción (llamador)");
    return;
  }

  try {
    const [fila] = await db
      .select({
        turno: turnosTable,
        turnera: turnerasTable,
        paciente: pacientesTable,
      })
      .from(turnosTable)
      .leftJoin(turnerasTable, eq(turnosTable.turneraId, turnerasTable.id))
      .leftJoin(pacientesTable, eq(turnosTable.pacienteId, pacientesTable.id))
      .where(eq(turnosTable.id, turnoId))
      .limit(1);
    if (!fila) return;

    // Quién llamó: el médico que apretó "llamar" manda; si llamó staff, cae
    // al titular de la agenda. De ahí salen consultorio y sala (misma
    // precedencia que la TV de sala).
    const profesionalId = fila.turno.llamadoPorProfesionalId ?? fila.turnera?.profesionalId ?? null;
    let profesional: { nombre: string | null; salaLlamadoId: number | null } | null = null;
    if (profesionalId != null) {
      const [p] = await db
        .select({
          nombre: profesionalesTable.nombre,
          apellido: profesionalesTable.apellido,
          salaLlamadoId: profesionalesTable.salaLlamadoId,
        })
        .from(profesionalesTable)
        .where(eq(profesionalesTable.id, profesionalId))
        .limit(1);
      if (p) {
        profesional = {
          nombre: [p.apellido, p.nombre].filter(Boolean).join(", ") || null,
          salaLlamadoId: p.salaLlamadoId ?? null,
        };
      }
    }

    let sala: { id: number; nombre: string } | null = null;
    if (profesional?.salaLlamadoId != null) {
      const [s] = await db
        .select({ id: salasLlamadoTable.id, nombre: salasLlamadoTable.nombre })
        .from(salasLlamadoTable)
        .where(eq(salasLlamadoTable.id, profesional.salaLlamadoId))
        .limit(1);
      if (s) sala = s;
    }

    let sedeNombre: string | null = null;
    if (fila.turnera?.sedeId != null) {
      const [s] = await db
        .select({ nombre: sedesTable.nombre })
        .from(sedesTable)
        .where(eq(sedesTable.id, fila.turnera.sedeId))
        .limit(1);
      sedeNombre = s?.nombre ?? null;
    }

    // Los campos opcionales se OMITEN cuando no hay dato (Pixel: "si no va
    // sala_id, usan la de siempre") — no se mandan en null.
    const pacienteNombre = [fila.paciente?.apellido, fila.paciente?.nombre].filter(Boolean).join(", ");
    const payload: Record<string, unknown> = {
      evento: "LLAMADO",
      turno_id: fila.turno.id,
      llamado_en: new Date().toISOString(),
      ...(pacienteNombre ? { paciente_nombre: pacienteNombre } : {}),
      ...(profesional?.nombre ? { profesional_nombre: profesional.nombre } : {}),
      ...(fila.turnera?.consultorio ? { consultorio: fila.turnera.consultorio } : {}),
      ...(sala ? { sala_id: sala.id, sala_nombre: sala.nombre } : {}),
      ...(sedeNombre ? { sede: sedeNombre } : {}),
      ...(fila.turnera?.nombre ? { agenda: fila.turnera.nombre } : {}),
    };

    const res = await fetch(`${BASE_URL()}/api/v1/integration/llamador`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10_000),
    });
    if (res.ok) {
      log.info({ turnoId, salaId: payload.sala_id }, "pixel-llamador: aviso de llamado enviado");
    } else {
      log.warn({ turnoId, status: res.status }, "pixel-llamador: Pixel rechazó el aviso de llamado");
    }
  } catch (err) {
    log.warn({ turnoId, err: String(err) }, "pixel-llamador: no se pudo avisar el llamado");
  }
}
