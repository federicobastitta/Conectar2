import {
  db,
  sedesTable,
  especialidadesTable,
  profesionalesTable,
  turnerasTable,
} from "@workspace/db";
import { sql } from "drizzle-orm";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Strip parenthetical office notes like "(Calle 147)" from names.
function cleanName(s: string | null): string | null {
  if (s == null) return s;
  const c = s.replace(/\([^)]*\)/g, "").replace(/\s+/g, " ").trim();
  return c.length ? c : null;
}

type Dataset = {
  generatedAt: string;
  tenant: string;
  sedes: { institucionId: number; nombre: string }[];
  especialidades: { idAutopilot: number; nombre: string }[];
  profesionales: {
    key: string;
    personalId: number | null;
    nombre: string;
    apellido: string | null;
    especialidadIdAutopilot: number | null;
  }[];
  turneras: {
    agendaId: number;
    profKey: string;
    espId: number | null;
    institucionId: number;
    dias: string;
    horaInicio: string;
    horaFin: string;
    dur: number;
  }[];
};

const COLORS = [
  "#3B82F6", "#10B981", "#F59E0B", "#EF4444", "#8B5CF6", "#06B6D4",
  "#EC4899", "#14B8A6", "#F97316", "#6366F1", "#84CC16", "#A855F7",
  "#0EA5E9", "#22C55E", "#EAB308", "#F43F5E", "#7C3AED", "#2DD4BF",
];

async function main() {
  const raw = fs.readFileSync(path.join(__dirname, "autopilot-data.json"), "utf8");
  const data: Dataset = JSON.parse(raw);

  console.log(
    `Dataset: ${data.sedes.length} sedes, ${data.especialidades.length} especialidades, ${data.profesionales.length} profesionales, ${data.turneras.length} turneras`,
  );

  await db.transaction(async (tx) => {
    // 1. Wipe demo data (user approved). No DB-level FKs exist between these tables.
    console.log("Borrando datos demo...");
    await tx.execute(
      sql`TRUNCATE TABLE turnos, turneras, profesionales, especialidades, sedes RESTART IDENTITY CASCADE`,
    );

    // 2. Sedes — map by natural key (institucionId) using returned nombre.
    const sedeRows = await tx
      .insert(sedesTable)
      .values(data.sedes.map((s) => ({ nombre: s.nombre, activa: true })))
      .returning({ id: sedesTable.id, nombre: sedesTable.nombre });
    if (sedeRows.length !== data.sedes.length) {
      throw new Error(`Sedes: se esperaban ${data.sedes.length}, se insertaron ${sedeRows.length}`);
    }
    const sedeIdByNombre = new Map(sedeRows.map((r) => [r.nombre, r.id]));
    const sedeMap = new Map<number, number>();
    for (const s of data.sedes) {
      const id = sedeIdByNombre.get(s.nombre);
      if (id == null) throw new Error(`Sede sin mapear: ${s.nombre}`);
      sedeMap.set(s.institucionId, id);
    }
    console.log(`Sedes insertadas: ${sedeRows.length}`);

    // 3. Especialidades — insert with a temporary descripcion carrying the
    //    Autopilot id so we can map deterministically, then clear it.
    const espRows = await tx
      .insert(especialidadesTable)
      .values(
        data.especialidades.map((e, i) => ({
          nombre: e.nombre,
          descripcion: `__ap:${e.idAutopilot}`,
          color: COLORS[i % COLORS.length],
        })),
      )
      .returning({ id: especialidadesTable.id, descripcion: especialidadesTable.descripcion });
    if (espRows.length !== data.especialidades.length) {
      throw new Error(`Especialidades: se esperaban ${data.especialidades.length}, se insertaron ${espRows.length}`);
    }
    const espMap = new Map<number, number>();
    for (const r of espRows) {
      const apId = Number(String(r.descripcion).replace("__ap:", ""));
      espMap.set(apId, r.id);
    }
    if (espMap.size !== data.especialidades.length) {
      throw new Error("Especialidades: mapeo por idAutopilot incompleto");
    }
    await tx.update(especialidadesTable).set({ descripcion: null });

    // 4. Profesionales — map by natural key (data.profesionales[i].key) via
    //    a temporary matricula marker, then clear it.
    const profRows = await tx
      .insert(profesionalesTable)
      .values(
        data.profesionales.map((p) => ({
          nombre: cleanName(p.nombre) || "Sin nombre",
          apellido: cleanName(p.apellido),
          matricula: `__ap:${p.key}`,
          especialidadId:
            p.especialidadIdAutopilot != null
              ? espMap.get(p.especialidadIdAutopilot) ?? null
              : null,
          activo: true,
        })),
      )
      .returning({ id: profesionalesTable.id, matricula: profesionalesTable.matricula });
    if (profRows.length !== data.profesionales.length) {
      throw new Error(`Profesionales: se esperaban ${data.profesionales.length}, se insertaron ${profRows.length}`);
    }
    const profMap = new Map<string, number>();
    for (const r of profRows) {
      const key = String(r.matricula).replace("__ap:", "");
      profMap.set(key, r.id);
    }
    await tx.update(profesionalesTable).set({ matricula: null });

    // 5. Turneras (one per agenda). Fail-fast on any unmapped reference.
    const espNombreByAutopilot = new Map(
      data.especialidades.map((e) => [e.idAutopilot, e.nombre]),
    );
    const profByKey = new Map(data.profesionales.map((p) => [p.key, p]));

    const turneraValues = data.turneras.map((t) => {
      const sedeId = sedeMap.get(t.institucionId);
      const especialidadId = t.espId != null ? espMap.get(t.espId) : undefined;
      const profesionalId = profMap.get(t.profKey);
      if (sedeId == null) throw new Error(`Turnera ag${t.agendaId}: sede ${t.institucionId} sin mapear`);
      if (especialidadId == null) throw new Error(`Turnera ag${t.agendaId}: especialidad ${t.espId} sin mapear`);
      if (profesionalId == null) throw new Error(`Turnera ag${t.agendaId}: profesional ${t.profKey} sin mapear`);

      const espNombre = t.espId != null ? espNombreByAutopilot.get(t.espId) ?? "" : "";
      const prof = profByKey.get(t.profKey);
      const pn = prof ? cleanName(prof.nombre) ?? "" : "";
      const pa = prof ? cleanName(prof.apellido) ?? "" : "";
      const fullName = [pn, pa].filter(Boolean).join(" ").trim();
      const esVideollamada = espNombre.toLowerCase().includes("videollamada");
      const nombre = [espNombre, fullName].filter(Boolean).join(" — ") || `Agenda ${t.agendaId}`;
      return {
        nombre,
        profesionalId,
        especialidadId,
        sedeId,
        duracionMinutos: t.dur || 30,
        diasAtencion: t.dias || "1,2,3,4,5",
        horaInicio: t.horaInicio || "08:00",
        horaFin: t.horaFin || "18:00",
        modalidad: esVideollamada ? "videoconsulta" : "presencial",
        visibilidad: "online",
        activa: true,
      };
    });

    // Fusionar turneras del mismo profesional/especialidad/sede con igual
    // horario, duración y modalidad: una sola turnera con los días unidos.
    const merged = new Map<string, (typeof turneraValues)[number]>();
    for (const t of turneraValues) {
      const key = [t.profesionalId, t.especialidadId, t.sedeId, t.horaInicio, t.horaFin, t.duracionMinutos, t.modalidad].join("|");
      const prev = merged.get(key);
      if (!prev) {
        merged.set(key, { ...t });
      } else {
        const dias = new Set([
          ...prev.diasAtencion.split(","),
          ...t.diasAtencion.split(","),
        ]);
        prev.diasAtencion = [...dias].sort().join(",");
      }
    }
    const turnerasFinales = [...merged.values()];

    await tx.insert(turnerasTable).values(turnerasFinales);
    console.log(`Especialidades insertadas: ${espRows.length}`);
    console.log(`Profesionales insertados: ${profRows.length}`);
    console.log(`Turneras insertadas: ${turnerasFinales.length} (fusionadas de ${turneraValues.length})`);
  });

  console.log("Importación completa.");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
