/**
 * Importador idempotente de disponibilidad semanal desde Excel.
 *
 * Uso:
 *   pnpm --filter @workspace/scripts run importar-agendas -- <ruta-al-archivo.xlsx>
 *
 * Características:
 *  - Deduplicación por nombre normalizado (sedes, especialidades, profesionales)
 *  - Agrupa días que comparten hora_inicio + hora_fin + consultorio en UNA agenda
 *  - Detecta solapamientos reales del mismo profesional y los manda a la bandeja de conflictos
 *  - Elimina duplicados exactos del Excel antes de procesar
 *  - Excluye filas con profesional/especialidad de prueba
 *  - Marca duracionPendiente=true cuando usa el default de 30 min
 *  - Idempotente: se puede correr múltiples veces sin duplicar entidades
 */

import * as XLSX from "xlsx";
import { readFileSync } from "fs";
import { db } from "@workspace/db";
import {
  sedesTable,
  especialidadesTable,
  profesionalesTable,
  turnerasTable,
  importacionesAdminTable,
  importacionConflictosTable,
  elegirTurneraReutilizable,
} from "@workspace/db";
import { eq, sql } from "drizzle-orm";
import { randomUUID } from "crypto";
import path from "path";

// ── Normalización ──────────────────────────────────────────────────────────

function normalizar(s: unknown): string {
  if (s == null) return "";
  return String(s)
    .trim()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .toLowerCase();
}

function titleCase(s: string): string {
  return s
    .split(" ")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(" ");
}

/** Parsea hora en distintos formatos → "HH:MM" */
function parsearHora(raw: unknown): string | null {
  if (raw == null) return null;
  const s = String(raw).trim();
  // Número de Excel (fracción de día)
  if (/^\d+(\.\d+)?$/.test(s)) {
    const frac = parseFloat(s);
    const totalMin = Math.round(frac * 24 * 60);
    const h = Math.floor(totalMin / 60) % 24;
    const m = totalMin % 60;
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
  }
  // Formato HH:MM o H:MM
  const match = s.match(/^(\d{1,2}):(\d{2})/);
  if (match) return `${String(Number(match[1])).padStart(2, "0")}:${match[2]}`;
  return null;
}

/** Convierte nombre de día en español → número ISO (1=Lunes … 7=Domingo, 0=Dom también) */
const DIA_MAP: Record<string, number> = {
  lunes: 1, lun: 1, lu: 1,
  martes: 2, mar: 2, ma: 2,
  miercoles: 3, mie: 3, mi: 3,
  jueves: 4, jue: 4, ju: 4,
  viernes: 5, vie: 5, vi: 5,
  sabado: 6, sab: 6, sa: 6,
  domingo: 0, dom: 0, do: 0,
};

function parsearDia(raw: unknown): number | null {
  if (raw == null) return null;
  const norm = normalizar(String(raw));
  return DIA_MAP[norm] ?? null;
}

// ── Exclusiones ────────────────────────────────────────────────────────────

const EXCLUSION_RE = /prueba|test|no\s*usar|no\s*utilizar|borrar|eliminar|xxxx|dummy|zzzz/i;

function esExcluido(profesional: string, especialidad: string): boolean {
  return EXCLUSION_RE.test(profesional) || EXCLUSION_RE.test(especialidad);
}

// ── Solapamiento de horarios ───────────────────────────────────────────────

function horaAMinutos(h: string): number {
  const [hh, mm] = h.split(":").map(Number);
  return hh * 60 + mm;
}

function solapan(hi1: string, hf1: string, hi2: string, hf2: string): boolean {
  const a = horaAMinutos(hi1);
  const b = horaAMinutos(hf1);
  const c = horaAMinutos(hi2);
  const d = horaAMinutos(hf2);
  return a < d && c < b; // solapamiento estricto
}

// ── Tipos internos ─────────────────────────────────────────────────────────

interface FilaExcel {
  filaN: number;
  sede: string;
  profesional: string;
  especialidad: string;
  dia: number;
  horaInicio: string;
  horaFin: string;
  consultorio: string;
  duracionMin: number | null;
}

/** Duración del turno en minutos, solo si es un valor clínicamente razonable (5–240). */
function parsearDuracion(raw: unknown): number | null {
  if (raw == null) return null;
  const n = Number(String(raw).trim());
  if (!Number.isInteger(n) || n < 5 || n > 240) return null;
  return n;
}

interface BloqueProfesional {
  filas: FilaExcel[];
  agendaKey: string;
  sedeNorm: string;
  especialidadNorm: string;
  profesionalNorm: string;
  horaInicio: string;
  horaFin: string;
  consultorio: string;
  dias: Set<number>;
  duracionMin: number | null;
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main() {
  const archivoArg = process.argv.slice(2).find((a) => a !== "--");
  if (!archivoArg) {
    console.error("Uso: pnpm --filter @workspace/scripts run importar-agendas -- <ruta.xlsx>");
    process.exit(1);
  }

  const archivo = path.resolve(archivoArg);
  console.log(`\n📂  Leyendo: ${archivo}`);

  const workbook = XLSX.read(readFileSync(archivo), { cellDates: false });
  const sheetName = workbook.SheetNames.find((n) => n.toLowerCase().includes("agenda")) ?? workbook.SheetNames[0];
  const sheet = workbook.Sheets[sheetName];
  const rawRows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: null });

  console.log(`📊  Hoja "${sheetName}": ${rawRows.length} filas brutas`);

  // Detectar nombres de columna (flexible)
  const primerRow = rawRows[0] ?? {};
  const cols = Object.keys(primerRow);
  const findCol = (patterns: string[]) =>
    cols.find((c) => patterns.some((p) => normalizar(c).includes(p))) ?? null;

  const COL_SEDE = findCol(["institucion", "sede", "sucursal"]);
  const COL_PROF = findCol(["profesional", "medico", "doctor"]);
  const COL_ESP  = findCol(["especialidad", "especialit"]);
  const COL_DIA  = findCol(["dia", "día"]);
  const COL_HI   = findCol(["hora inicio", "inicio", "desde"]);
  const COL_HF   = findCol(["hora fin", "fin", "hasta"]);
  const COL_CONS = findCol(["consultorio", "consul"]);
  const COL_DUR  = findCol(["duracion del turno", "duración del turno", "duracion"]);

  if (!COL_SEDE || !COL_PROF || !COL_ESP || !COL_DIA || !COL_HI || !COL_HF) {
    console.error("❌  No se encontraron las columnas esperadas. Columnas disponibles:", cols);
    process.exit(1);
  }

  console.log(`🗺️   Columnas mapeadas: SEDE="${COL_SEDE}" PROF="${COL_PROF}" ESP="${COL_ESP}" DIA="${COL_DIA}" HI="${COL_HI}" HF="${COL_HF}" CONS="${COL_CONS}" DUR="${COL_DUR}"`);

  // ── Parsear filas ────────────────────────────────────────────────────────
  const filasParsed: FilaExcel[] = [];
  const filasOmitidas: { filaN: number; motivo: string; fila: Record<string, unknown> }[] = [];

  for (let i = 0; i < rawRows.length; i++) {
    const r = rawRows[i];
    const filaN = i + 2; // 1-indexed + encabezado

    const sedeBruta = String(r[COL_SEDE!] ?? "").trim();
    const profBruto = String(r[COL_PROF!] ?? "").trim();
    const espBruta  = String(r[COL_ESP!]  ?? "").trim();
    const diaBruto  = r[COL_DIA!];
    const hiBruta   = r[COL_HI!];
    const hfBruta   = r[COL_HF!];
    const consBruto = COL_CONS ? String(r[COL_CONS] ?? "").trim() : "";

    if (!sedeBruta || !profBruto || !espBruta) {
      filasOmitidas.push({ filaN, motivo: "campos vacíos (sede/profesional/especialidad)", fila: r });
      continue;
    }

    if (esExcluido(profBruto, espBruta)) {
      filasOmitidas.push({ filaN, motivo: "profesional o especialidad marcada como prueba/no usar", fila: r });
      continue;
    }

    const dia = parsearDia(diaBruto);
    if (dia === null) {
      filasOmitidas.push({ filaN, motivo: `día no reconocido: "${diaBruto}"`, fila: r });
      continue;
    }

    const horaInicio = parsearHora(hiBruta);
    const horaFin    = parsearHora(hfBruta);
    if (!horaInicio || !horaFin) {
      filasOmitidas.push({ filaN, motivo: `hora no parseable: inicio="${hiBruta}" fin="${hfBruta}"`, fila: r });
      continue;
    }

    filasParsed.push({
      filaN,
      sede: sedeBruta,
      profesional: profBruto,
      especialidad: espBruta,
      dia,
      horaInicio,
      horaFin,
      consultorio: consBruto,
      duracionMin: COL_DUR ? parsearDuracion(r[COL_DUR]) : null,
    });
  }

  // ── Deduplicar filas exactas ─────────────────────────────────────────────
  const seen = new Set<string>();
  const filasUnicas: FilaExcel[] = [];
  let duplicadosExactos = 0;

  for (const f of filasParsed) {
    const key = `${normalizar(f.sede)}|${normalizar(f.profesional)}|${normalizar(f.especialidad)}|${f.dia}|${f.horaInicio}|${f.horaFin}|${normalizar(f.consultorio)}`;
    if (seen.has(key)) {
      duplicadosExactos++;
      continue;
    }
    seen.add(key);
    filasUnicas.push(f);
  }

  console.log(`\n🔍  Análisis:`);
  console.log(`    Filas totales brutas : ${rawRows.length}`);
  console.log(`    Filas omitidas       : ${filasOmitidas.length}`);
  console.log(`    Duplicados exactos   : ${duplicadosExactos}`);
  console.log(`    Filas a procesar     : ${filasUnicas.length}`);

  // ── Agrupar en bloques de agenda ─────────────────────────────────────────
  // Clave de agrupación: profesional_norm + sede_norm + especialidad_norm + hi + hf + consultorio
  const bloqueMap = new Map<string, BloqueProfesional>();

  for (const f of filasUnicas) {
    const profNorm  = normalizar(f.profesional);
    const sedeNorm  = normalizar(f.sede);
    const espNorm   = normalizar(f.especialidad);
    const agendaKey = `${profNorm}|${sedeNorm}|${espNorm}|${f.horaInicio}|${f.horaFin}|${normalizar(f.consultorio)}`;

    if (!bloqueMap.has(agendaKey)) {
      bloqueMap.set(agendaKey, {
        filas: [],
        agendaKey,
        sedeNorm,
        especialidadNorm: espNorm,
        profesionalNorm: profNorm,
        horaInicio: f.horaInicio,
        horaFin: f.horaFin,
        consultorio: f.consultorio,
        dias: new Set(),
        duracionMin: null,
      });
    }
    const bloque = bloqueMap.get(agendaKey)!;
    bloque.filas.push(f);
    bloque.dias.add(f.dia);
    if (f.duracionMin != null && bloque.duracionMin == null) bloque.duracionMin = f.duracionMin;
  }

  // ── Detectar solapamientos por profesional ───────────────────────────────
  // Agrupa bloques por profesional_norm y verifica si algún par de bloques
  // tienen días en común y horarios que se solapan.
  const conflictos: {
    profesional: string;
    motivo: string;
    filas: FilaExcel[];
  }[] = [];

  const bloquesPorProfesional = new Map<string, BloqueProfesional[]>();
  for (const bloque of bloqueMap.values()) {
    const arr = bloquesPorProfesional.get(bloque.profesionalNorm) ?? [];
    arr.push(bloque);
    bloquesPorProfesional.set(bloque.profesionalNorm, arr);
  }

  for (const [profNorm, bloques] of bloquesPorProfesional) {
    for (let i = 0; i < bloques.length; i++) {
      for (let j = i + 1; j < bloques.length; j++) {
        const a = bloques[i];
        const b = bloques[j];
        // Días en común
        const diasComunes = [...a.dias].filter((d) => b.dias.has(d));
        if (diasComunes.length > 0 && solapan(a.horaInicio, a.horaFin, b.horaInicio, b.horaFin)) {
          conflictos.push({
            profesional: profNorm,
            motivo: `Solapamiento de horario: días ${diasComunes.join(",")} de ${a.horaInicio}-${a.horaFin} (${a.sedeNorm}/${a.especialidadNorm}) se superpone con ${b.horaInicio}-${b.horaFin} (${b.sedeNorm}/${b.especialidadNorm})`,
            filas: [...a.filas, ...b.filas],
          });
          // Marcar ambos bloques para exclusión del insert
          a.agendaKey = `__CONFLICTO__${a.agendaKey}`;
          b.agendaKey = `__CONFLICTO__${b.agendaKey}`;
        }
      }
    }
  }

  console.log(`\n⚠️   Solapamientos detectados: ${conflictos.length}`);

  // ── Bloque que se van a insertar (sin conflictos) ────────────────────────
  const bloquesLimpios = [...bloqueMap.values()].filter(
    (b) => !b.agendaKey.startsWith("__CONFLICTO__")
  );

  console.log(`✅  Bloques de agenda a crear/actualizar: ${bloquesLimpios.length}`);

  // ── Carga a la DB ────────────────────────────────────────────────────────
  const runId = `admin-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}-${randomUUID().slice(0, 8)}`;

  const contadores = {
    sedesCreadas: 0, sedesReutilizadas: 0,
    especialidadesCreadas: 0, especialidadesReutilizadas: 0,
    profesionalesCreados: 0, profesionalesReutilizados: 0,
    agendasCreadas: 0, agendasActualizadas: 0, agendasReutilizadas: 0,
  };
  // Registro de reutilizaciones (para el log de importación)
  const agendasReutilizadasLog: { turneraId: number; motivo: string }[] = [];

  // Cache de entidades ya resueltas en esta ejecución
  const cacheSedeId = new Map<string, number>();
  const cacheEspId  = new Map<string, number>();
  const cacheProfId = new Map<string, number>();

  // ── Lookup-or-create Sede ──────────────────────────────────────────────
  async function resolverSede(nombreBruto: string): Promise<number> {
    const norm = normalizar(nombreBruto);
    if (cacheSedeId.has(norm)) return cacheSedeId.get(norm)!;

    // Buscar por nombre normalizado via función de postgres
    const [existing] = await db
      .select({ id: sedesTable.id })
      .from(sedesTable)
      .where(sql`lower(regexp_replace(trim(${sedesTable.nombre}), '\\s+', ' ', 'g')) = ${norm}`)
      .limit(1);

    if (existing) {
      cacheSedeId.set(norm, existing.id);
      contadores.sedesReutilizadas++;
      return existing.id;
    }

    // Nombre "presentable": title case
    const nombreFinal = titleCase(nombreBruto.trim());
    const [nueva] = await db.insert(sedesTable).values({ nombre: nombreFinal }).returning({ id: sedesTable.id });
    cacheSedeId.set(norm, nueva.id);
    contadores.sedesCreadas++;
    return nueva.id;
  }

  // ── Lookup-or-create Especialidad ────────────────────────────────────────
  async function resolverEspecialidad(nombreBruto: string): Promise<number> {
    const norm = normalizar(nombreBruto);
    if (cacheEspId.has(norm)) return cacheEspId.get(norm)!;

    const [existing] = await db
      .select({ id: especialidadesTable.id })
      .from(especialidadesTable)
      .where(sql`lower(regexp_replace(trim(${especialidadesTable.nombre}), '\\s+', ' ', 'g')) = ${norm}`)
      .limit(1);

    if (existing) {
      cacheEspId.set(norm, existing.id);
      contadores.especialidadesReutilizadas++;
      return existing.id;
    }

    const nombreFinal = titleCase(nombreBruto.trim());
    const [nueva] = await db.insert(especialidadesTable).values({ nombre: nombreFinal }).returning({ id: especialidadesTable.id });
    cacheEspId.set(norm, nueva.id);
    contadores.especialidadesCreadas++;
    return nueva.id;
  }

  // ── Lookup-or-create Profesional ─────────────────────────────────────────
  async function resolverProfesional(nombreBruto: string): Promise<number> {
    const norm = normalizar(nombreBruto);
    if (cacheProfId.has(norm)) return cacheProfId.get(norm)!;

    const [existing] = await db
      .select({ id: profesionalesTable.id })
      .from(profesionalesTable)
      .where(eq(profesionalesTable.nombreNormalizado, norm))
      .limit(1);

    if (existing) {
      cacheProfId.set(norm, existing.id);
      contadores.profesionalesReutilizados++;
      return existing.id;
    }

    // Separar nombre y apellido: el Excel suele traer "APELLIDO Nombre" o "Apellido, Nombre"
    let nombre = nombreBruto.trim();
    let apellido: string | undefined;

    if (nombre.includes(",")) {
      const partes = nombre.split(",").map((p) => p.trim());
      apellido = titleCase(partes[0]);
      nombre = titleCase(partes.slice(1).join(" "));
    } else {
      // Primera palabra = apellido, resto = nombre (convención HIS)
      const partes = nombre.split(/\s+/);
      if (partes.length > 1) {
        apellido = titleCase(partes[0]);
        nombre = titleCase(partes.slice(1).join(" "));
      } else {
        nombre = titleCase(nombre);
      }
    }

    const [nuevo] = await db
      .insert(profesionalesTable)
      .values({ nombre, apellido, nombreNormalizado: norm })
      .returning({ id: profesionalesTable.id });

    cacheProfId.set(norm, nuevo.id);
    contadores.profesionalesCreados++;
    return nuevo.id;
  }

  // ── Insertar/actualizar agendas ──────────────────────────────────────────
  for (const bloque of bloquesLimpios) {
    const sedeId         = await resolverSede(bloque.sedeNorm);
    const especialidadId = await resolverEspecialidad(bloque.especialidadNorm);
    const profesionalId  = await resolverProfesional(bloque.profesionalNorm);

    // Días ordenados como string "1,3,5"
    const diasStr = [...bloque.dias].sort((a, b) => a - b).join(",");

    // import_key estable (sin días — los días se actualizan si se re-importa)
    const importKey = `${profesionalId}::${sedeId}::${especialidadId}::${bloque.horaInicio}::${bloque.horaFin}::${normalizar(bloque.consultorio)}`;

    // Nombre descriptivo de la agenda
    const nombreAgenda = [
      bloque.profesionalNorm.split(" ").slice(0, 2).map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(" "),
      "—",
      titleCase(bloque.especialidadNorm),
    ].join(" ");

    // Verificar si ya existe
    const [existente] = await db
      .select({
        id: turnerasTable.id,
        diasAtencion: turnerasTable.diasAtencion,
        duracionPendiente: turnerasTable.duracionPendiente,
      })
      .from(turnerasTable)
      .where(eq(turnerasTable.importKey, importKey))
      .limit(1);

    if (existente) {
      // Actualizar días (unión con los existentes)
      const diasExistentes = new Set(existente.diasAtencion.split(",").map(Number).filter(n => !isNaN(n)));
      for (const d of bloque.dias) diasExistentes.add(d);
      const diasActualizados = [...diasExistentes].sort((a, b) => a - b).join(",");

      const cambios: Partial<typeof turnerasTable.$inferInsert> = {};
      if (diasActualizados !== existente.diasAtencion) cambios.diasAtencion = diasActualizados;
      // Si la duración estaba pendiente y este reporte trae una real, la confirmamos
      if (existente.duracionPendiente && bloque.duracionMin != null) {
        cambios.duracionMinutos = bloque.duracionMin;
        cambios.duracionPendiente = false;
      }

      if (Object.keys(cambios).length > 0) {
        await db.update(turnerasTable).set(cambios).where(eq(turnerasTable.id, existente.id));
        contadores.agendasActualizadas++;
      }
      // else: sin cambios, se cuenta como reutilizada implícitamente
    } else {
      // Anti-duplicados por cobertura de horario: buscar una turnera ACTIVA del
      // mismo profesional+sede+especialidad cuyo horario cubra o coincida con
      // este bloque y reutilizarla (uniendo días / ensanchando horario) en vez
      // de insertar otra. Cubre reimportaciones donde el importKey cambió
      // (p. ej. hora_fin ensanchada por la unificación de agendas).
      const trio = await db
        .select({
          id: turnerasTable.id,
          activa: turnerasTable.activa,
          diasAtencion: turnerasTable.diasAtencion,
          horaInicio: turnerasTable.horaInicio,
          horaFin: turnerasTable.horaFin,
          importKey: turnerasTable.importKey,
          duracionPendiente: turnerasTable.duracionPendiente,
        })
        .from(turnerasTable)
        .where(sql`
          ${turnerasTable.profesionalId} = ${profesionalId}
          AND ${turnerasTable.sedeId} = ${sedeId}
          AND ${turnerasTable.especialidadId} = ${especialidadId}
        `)
        .orderBy(turnerasTable.id);
      const reuso = elegirTurneraReutilizable(trio, {
        dias: [...bloque.dias],
        horaInicio: bloque.horaInicio,
        horaFin: bloque.horaFin,
      });
      if (reuso) {
        const elegida = trio.find((t) => t.id === reuso.turneraId)!;
        const cambios: Partial<typeof turnerasTable.$inferInsert> = { ...reuso.cambios };
        if (!elegida.importKey) cambios.importKey = importKey;
        if (elegida.duracionPendiente && bloque.duracionMin != null) {
          cambios.duracionMinutos = bloque.duracionMin;
          cambios.duracionPendiente = false;
        }
        await db.update(turnerasTable).set(cambios).where(eq(turnerasTable.id, reuso.turneraId));
        contadores.agendasReutilizadas++;
        const motivo = `horario ${reuso.horarioCubierto ? "cubierto por" : "superpuesto con"} turnera existente (prof ${profesionalId}, sede ${sedeId}, esp ${especialidadId}, bloque ${bloque.horaInicio}-${bloque.horaFin})`;
        agendasReutilizadasLog.push({ turneraId: reuso.turneraId, motivo });
        console.log(`♻️  Agenda reutilizada #${reuso.turneraId}: ${motivo}`);
        continue;
      }
      // Fallback anti-duplicados: reutilizar una turnera existente con el mismo
      // nombre+sede (cubre guardias y agendas creadas a mano sin importKey).
      // Las reimportaciones no deben recrear turneras duplicadas.
      const mismaSede = await db
        .select({
          id: turnerasTable.id,
          nombre: turnerasTable.nombre,
          diasAtencion: turnerasTable.diasAtencion,
          importKey: turnerasTable.importKey,
          activa: turnerasTable.activa,
        })
        .from(turnerasTable)
        .where(eq(turnerasTable.sedeId, sedeId))
        .orderBy(turnerasTable.id);
      const nombreNorm = normalizar(nombreAgenda);
      const candidatas = mismaSede.filter((t) => normalizar(t.nombre) === nombreNorm);
      const porNombre = candidatas.find((t) => t.activa) ?? candidatas[0];
      if (porNombre) {
        const diasExistentes = new Set(porNombre.diasAtencion.split(",").map(Number).filter((n) => !isNaN(n)));
        for (const d of bloque.dias) diasExistentes.add(d);
        const cambios: Partial<typeof turnerasTable.$inferInsert> = {
          diasAtencion: [...diasExistentes].sort((a, b) => a - b).join(","),
          activa: true,
        };
        if (!porNombre.importKey) cambios.importKey = importKey;
        await db.update(turnerasTable).set(cambios).where(eq(turnerasTable.id, porNombre.id));
        contadores.agendasReutilizadas++;
        agendasReutilizadasLog.push({
          turneraId: porNombre.id,
          motivo: `mismo nombre+sede ("${nombreAgenda}", sede ${sedeId})`,
        });
        console.log(`♻️  Agenda reutilizada #${porNombre.id}: mismo nombre+sede ("${nombreAgenda}")`);
        continue;
      }
      await db.insert(turnerasTable).values({
        nombre: nombreAgenda,
        profesionalId,
        especialidadId,
        sedeId,
        diasAtencion: diasStr,
        horaInicio: bloque.horaInicio,
        horaFin: bloque.horaFin,
        consultorio: bloque.consultorio || null,
        duracionMinutos: bloque.duracionMin ?? 30,
        // Sin duración informada (o fuera de rango 5–240) → default 30 pendiente
        duracionPendiente: bloque.duracionMin == null,
        importKey,
        activa: true,
        visibilidad: "recepcion",
      });
      contadores.agendasCreadas++;
    }
  }

  // ── Registrar ejecución ──────────────────────────────────────────────────
  await db.insert(importacionesAdminTable).values({
    runId,
    fuente: "excel",
    archivo: path.basename(archivo),
    estado: conflictos.length > 0 ? "parcial" : "completado",
    totalFilas: rawRows.length,
    sedesCreadas: contadores.sedesCreadas,
    sedesReutilizadas: contadores.sedesReutilizadas,
    especialidadesCreadas: contadores.especialidadesCreadas,
    especialidadesReutilizadas: contadores.especialidadesReutilizadas,
    profesionalesCreados: contadores.profesionalesCreados,
    profesionalesReutilizados: contadores.profesionalesReutilizados,
    agendasCreadas: contadores.agendasCreadas,
    agendasActualizadas: contadores.agendasActualizadas,
    filasOmitidas: filasOmitidas.length + duplicadosExactos,
    conflictos: conflictos.length,
    detalle: {
      duplicadosExactos,
      filasOmitidas: filasOmitidas.slice(0, 50),
      agendasReutilizadas: contadores.agendasReutilizadas,
      agendasReutilizadasDetalle: agendasReutilizadasLog.slice(0, 100),
    },
  });

  // ── Registrar conflictos ─────────────────────────────────────────────────
  for (const c of conflictos) {
    await db.insert(importacionConflictosTable).values({
      runId,
      tipo: "superposicion",
      motivo: c.motivo,
      profesionalNombre: c.profesional,
      filaOriginal: c.filas[0] as unknown as Record<string, unknown>,
      filasRelacionadas: c.filas.slice(1) as unknown as Record<string, unknown>[],
    });
  }

  // ── Resumen final ────────────────────────────────────────────────────────
  console.log(`
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
✅  Importación completada  [${runId}]
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Filas totales brutas       : ${rawRows.length}
Duplicados exactos omitidos: ${duplicadosExactos}
Filas omitidas (inválidas) : ${filasOmitidas.length}
─────────────────────────────────────────────
Sedes         creadas      : ${contadores.sedesCreadas}
              reutilizadas : ${contadores.sedesReutilizadas}
Especialidades creadas     : ${contadores.especialidadesCreadas}
              reutilizadas : ${contadores.especialidadesReutilizadas}
Profesionales creados      : ${contadores.profesionalesCreados}
              reutilizados : ${contadores.profesionalesReutilizados}
Agendas        creadas     : ${contadores.agendasCreadas}
               actualizadas: ${contadores.agendasActualizadas}
               reutilizadas: ${contadores.agendasReutilizadas}
─────────────────────────────────────────────
⚠️  Conflictos (bandeja)   : ${conflictos.length}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
`);

  if (conflictos.length > 0) {
    console.log("⚠️  Conflictos detectados (no insertados):");
    for (const c of conflictos) {
      console.log(`   · ${c.profesional}: ${c.motivo}`);
    }
    console.log("\n   Revisá la bandeja en /configuracion/importacion-admin\n");
  }

  process.exit(0);
}

main().catch((err) => {
  console.error("❌  Error:", err);
  process.exit(1);
});
