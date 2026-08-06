/**
 * Importación del export "Turnos detallados" de Alephoo (.xls que en realidad
 * es una tabla HTML) — versión servidor, misma lógica que el script
 * scripts/src/importar-turnos-detallados.ts:
 *  - Crea/matchea sedes, especialidades y profesionales (sin duplicar)
 *  - Crea/acomoda turneras por (profesional, sede, especialidad), infiriendo
 *    días de atención, rango horario, duración (gap modal) y consultorio
 *  - Upsertea pacientes por DNI (reactiva fichas inactivas, completa faltantes)
 *  - Inserta los turnos con dedup; los choques de slot se marcan sobreturno
 *
 * Escrituras DIRECTAS a la base (sin pasar por POST /turnos): la importación
 * no debe disparar validaciones de reserva ni automatizaciones (Klinicos,
 * Pixel, avisos). Corre en background; el progreso se registra en
 * importaciones_admin (runId) y se consulta con GET /importaciones-admin/:runId.
 */
import { randomUUID } from "node:crypto";
import { eq, sql, inArray, gte } from "drizzle-orm";
import {
  db,
  sedesTable,
  especialidadesTable,
  profesionalesTable,
  turnerasTable,
  turnosTable,
  pacientesTable,
  importacionesAdminTable,
} from "@workspace/db";
import { logger } from "./logger";

// ── Helpers de texto ────────────────────────────────────────────────────────

const ENTIDADES: Record<string, string> = {
  "&aacute;": "á", "&eacute;": "é", "&iacute;": "í", "&oacute;": "ó", "&uacute;": "ú",
  "&Aacute;": "Á", "&Eacute;": "É", "&Iacute;": "Í", "&Oacute;": "Ó", "&Uacute;": "Ú",
  "&ntilde;": "ñ", "&Ntilde;": "Ñ", "&uuml;": "ü", "&Uuml;": "Ü",
  "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'", "&nbsp;": " ",
};

function decodeHtml(s: string): string {
  return s
    .replace(/\u0000/g, "")
    .replace(/&[a-zA-Z#0-9]+;/g, (m) => ENTIDADES[m] ?? m)
    .replace(/\s+/g, " ")
    .trim();
}

function normalizar(s: unknown): string {
  return String(s ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function titleCase(s: string): string {
  return s
    .toLowerCase()
    .split(/\s+/)
    .map((w) => (w.length > 2 || !/^(de|la|el|y|del)$/.test(w) ? w.charAt(0).toUpperCase() + w.slice(1) : w))
    .join(" ");
}

/** "APELLIDO Nombre" (convención HIS) → { apellido, nombre } */
function splitNombre(completo: string): { nombre: string; apellido: string | undefined } {
  const limpio = completo.trim();
  if (limpio.includes(",")) {
    const [ap, ...resto] = limpio.split(",");
    return { apellido: titleCase(ap.trim()), nombre: titleCase(resto.join(" ").trim()) };
  }
  const partes = limpio.split(/\s+/);
  if (partes.length > 1) {
    return { apellido: titleCase(partes[0]), nombre: titleCase(partes.slice(1).join(" ")) };
  }
  return { nombre: titleCase(limpio), apellido: undefined };
}

function normalizarFechaNac(v: string): string | undefined {
  const m = v.trim().match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/);
  if (!m) return undefined;
  const f = `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  const hoy = new Date().toISOString().slice(0, 10);
  if (Number(m[3]) < 1900 || f > hoy) return undefined;
  return f;
}

/** Día de semana 0-6 desde YYYY-MM-DD, siempre en UTC (server corre en UTC) */
function diaSemana(fecha: string): number {
  return new Date(`${fecha}T00:00:00.000Z`).getUTCDay();
}

function horaAMin(h: string): number {
  const [hh, mm] = h.split(":").map(Number);
  return hh * 60 + mm;
}

function minAHora(m: number): string {
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

const ESTADO_MAP: Record<string, string> = {
  "pendiente": "pendiente",
  "a reprogramar": "pendiente",
  "arribo": "arribo",
  "no asistio": "ausente",
  "no asistió": "ausente",
};

// ── Parseo del HTML ─────────────────────────────────────────────────────────

interface FilaTurno {
  turnoExterno: string;
  pacienteNombre: string;
  dni: string;
  sexo: string;
  fechaNac: string;
  obraSocial: string;
  plan: string;
  nroAfiliado: string;
  fecha: string;
  hora: string; // HH:MM
  especialidad: string;
  medico: string;
  consultorio: string;
  motivo: string;
  estado: string;
  institucion: string;
  aReprogramar: boolean;
}

/** El buffer viene en UTF-16/latin1 con bytes NUL: decodificar latin1 + strip \x00 */
export function parsearTurnosDetallados(buffer: Buffer): FilaTurno[] {
  const html = buffer.toString("latin1").replace(/\u0000/g, "");
  const trs = html.match(/<tr[\s\S]*?<\/tr>/gi) ?? [];
  if (trs.length < 2) throw new Error("No se encontró la tabla en el archivo");

  const parseCells = (tr: string): string[] =>
    [...tr.matchAll(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/gi)].map((m) =>
      decodeHtml(m[1].replace(/<[^>]+>/g, " "))
    );

  const headers = parseCells(trs[0]!);
  const idx = (nombre: string, desde = 0): number => {
    const norm = normalizar(nombre);
    for (let i = desde; i < headers.length; i++) {
      if (normalizar(headers[i]) === norm) return i;
    }
    return -1;
  };

  const iTurno = idx("Turno");
  const iPaciente = idx("Paciente");
  const iDni = idx("DNI"); // primer DNI = paciente (el segundo es del médico)
  const iSexo = idx("Sexo");
  const iFnac = idx("F.Nac");
  const iOs = idx("Obra Social");
  const iPlan = idx("Plan");
  const iAfiliado = idx("Nro. de afiliado");
  const iFecha = idx("Fecha Turno");
  const iHora = idx("Hora Turno");
  const iEsp = idx("Especialidad");
  const iMedico = idx("Medico");
  const iConsultorio = headers.findIndex((h) => normalizar(h).includes("consultorio"));
  const iMotivo = idx("Motivo de turno");
  const iEstado = idx("Estado Turno");
  const iInst = idx("Institución");

  const requeridos: [string, number][] = [
    ["Turno", iTurno], ["Paciente", iPaciente], ["DNI", iDni], ["Sexo", iSexo],
    ["F.Nac", iFnac], ["Obra Social", iOs], ["Plan", iPlan], ["Nro. de afiliado", iAfiliado],
    ["Fecha Turno", iFecha], ["Hora Turno", iHora], ["Especialidad", iEsp],
    ["Medico", iMedico], ["Motivo de turno", iMotivo], ["Estado Turno", iEstado], ["Institución", iInst],
  ];
  const faltantes = requeridos.filter(([, i]) => i < 0).map(([n]) => n);
  if (faltantes.length > 0) {
    throw new Error(`Columnas faltantes en el archivo: ${faltantes.join(", ")}. Headers encontrados: ${headers.join(" | ")}`);
  }

  const filas: FilaTurno[] = [];
  for (let r = 1; r < trs.length; r++) {
    const c = parseCells(trs[r]);
    if (c.length < headers.length - 2) continue;
    const fecha = (c[iFecha] ?? "").slice(0, 10);
    const horaRaw = c[iHora] ?? "";
    const hm = horaRaw.match(/^(\d{1,2}):(\d{2})/);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha) || !hm) continue;
    const estadoRaw = normalizar(c[iEstado] ?? "");
    const estado = ESTADO_MAP[estadoRaw];
    if (!estado) continue; // estados desconocidos: se omiten
    filas.push({
      turnoExterno: c[iTurno] ?? "",
      pacienteNombre: c[iPaciente] ?? "",
      dni: (c[iDni] ?? "").replace(/\D/g, ""),
      sexo: (c[iSexo] ?? "").trim().toUpperCase(),
      fechaNac: c[iFnac] ?? "",
      obraSocial: c[iOs] ?? "",
      plan: c[iPlan] ?? "",
      nroAfiliado: c[iAfiliado] ?? "",
      fecha,
      hora: `${hm[1].padStart(2, "0")}:${hm[2]}`,
      especialidad: c[iEsp] ?? "",
      medico: c[iMedico] ?? "",
      consultorio: c[iConsultorio] ?? "",
      motivo: c[iMotivo] ?? "",
      estado,
      institucion: c[iInst] ?? "",
      aReprogramar: estadoRaw === "a reprogramar",
    });
  }
  return filas;
}

// ── Ejecución ───────────────────────────────────────────────────────────────

export interface ContadoresImportacion {
  sedesCreadas: number;
  especialidadesCreadas: number;
  profesionalesCreados: number;
  turnerasCreadas: number;
  turnerasActualizadas: number;
  pacientesCreados: number;
  pacientesActualizados: number;
  pacientesReactivados: number;
  turnosCreados: number;
  turnosSobreturno: number;
  turnosOmitidos: number;
  turnosErrores: number;
  filasSinDni: number;
}

/** ¿Hay otra importación de turnos en curso? (guard cross-instancia) */
export async function hayImportacionTurnosEnCurso(): Promise<boolean> {
  const [row] = await db.execute<{ c: string }>(sql`
    SELECT count(*) c FROM importaciones_admin
    WHERE run_id LIKE 'turnos-alephoo-%' AND estado = 'procesando'
      AND created_at > now() - interval '2 hours'
  `).then((r) => r.rows);
  return Number(row?.c ?? 0) > 0;
}

/**
 * Ejecuta la importación completa. Registra el run en importaciones_admin al
 * arrancar (estado "procesando") y lo actualiza al terminar ("completado" o
 * "error"). Devuelve el runId inmediato para polling; el trabajo pesado corre
 * en la promesa devuelta en `terminado` (el caller decide si la espera).
 */
export function iniciarImportacionTurnosDetallados(
  buffer: Buffer,
  nombreArchivo: string,
  ejecutadoPor: string,
): { runId: string; terminado: Promise<void> } {
  const runId = `turnos-alephoo-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}-${randomUUID().slice(0, 8)}`;

  const terminado = (async () => {
    // El run se registra ANTES de parsear: todo runId devuelto al cliente
    // tiene que ser consultable, incluso si el archivo viene roto.
    await db.insert(importacionesAdminTable).values({
      runId,
      fuente: "excel",
      archivo: nombreArchivo,
      estado: "procesando",
      totalFilas: 0,
      ejecutadoPor,
    });

    const contadores: ContadoresImportacion = {
      sedesCreadas: 0,
      especialidadesCreadas: 0,
      profesionalesCreados: 0,
      turnerasCreadas: 0,
      turnerasActualizadas: 0,
      pacientesCreados: 0,
      pacientesActualizados: 0,
      pacientesReactivados: 0,
      turnosCreados: 0,
      turnosSobreturno: 0,
      turnosOmitidos: 0,
      turnosErrores: 0,
      filasSinDni: 0,
    };

    try {
      const filas = parsearTurnosDetallados(buffer);
      logger.info({ runId, filas: filas.length }, "importacion-turnos-detallados: parseado");
      await db.update(importacionesAdminTable)
        .set({ totalFilas: filas.length })
        .where(eq(importacionesAdminTable.runId, runId));
      await ejecutar(filas, contadores);
      await db.update(importacionesAdminTable).set({
        estado: "completado",
        sedesCreadas: contadores.sedesCreadas,
        especialidadesCreadas: contadores.especialidadesCreadas,
        profesionalesCreados: contadores.profesionalesCreados,
        agendasCreadas: contadores.turnerasCreadas,
        agendasActualizadas: contadores.turnerasActualizadas,
        filasOmitidas: contadores.turnosOmitidos + contadores.filasSinDni,
        detalle: contadores,
      }).where(eq(importacionesAdminTable.runId, runId));
      logger.info({ runId, contadores }, "importacion-turnos-detallados: completada");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await db.update(importacionesAdminTable).set({
        estado: "error",
        detalle: { ...contadores, error: msg },
      }).where(eq(importacionesAdminTable.runId, runId)).catch(() => {});
      logger.error({ err, runId }, "importacion-turnos-detallados: error");
      throw err;
    }
  })();

  return { runId, terminado };
}

async function ejecutar(filas: FilaTurno[], contadores: ContadoresImportacion): Promise<void> {
  // ── Resolver sedes / especialidades / profesionales ──────────────────────
  const cacheSede = new Map<string, number>();
  const cacheEsp = new Map<string, number>();
  const cacheProf = new Map<string, number>();

  async function resolverSede(nombre: string): Promise<number> {
    const norm = normalizar(nombre);
    if (cacheSede.has(norm)) return cacheSede.get(norm)!;
    const [ex] = await db.select({ id: sedesTable.id }).from(sedesTable)
      .where(sql`f_unaccent(lower(regexp_replace(trim(${sedesTable.nombre}), '\\s+', ' ', 'g'))) = f_unaccent(${norm})`)
      .limit(1);
    if (ex) { cacheSede.set(norm, ex.id); return ex.id; }
    const [nueva] = await db.insert(sedesTable).values({ nombre: titleCase(nombre.replace(/\s*-\s*/g, " - ").trim()) }).returning({ id: sedesTable.id });
    cacheSede.set(norm, nueva.id);
    contadores.sedesCreadas++;
    return nueva.id;
  }

  async function resolverEspecialidad(nombre: string): Promise<number> {
    const norm = normalizar(nombre);
    if (cacheEsp.has(norm)) return cacheEsp.get(norm)!;
    const [ex] = await db.select({ id: especialidadesTable.id }).from(especialidadesTable)
      .where(sql`f_unaccent(lower(regexp_replace(trim(${especialidadesTable.nombre}), '\\s+', ' ', 'g'))) = f_unaccent(${norm})`)
      .limit(1);
    if (ex) { cacheEsp.set(norm, ex.id); return ex.id; }
    const [nueva] = await db.insert(especialidadesTable).values({ nombre: titleCase(nombre.trim()) }).returning({ id: especialidadesTable.id });
    cacheEsp.set(norm, nueva.id);
    contadores.especialidadesCreadas++;
    return nueva.id;
  }

  async function resolverProfesional(nombre: string, especialidadId: number): Promise<number> {
    const norm = normalizar(nombre);
    if (cacheProf.has(norm)) return cacheProf.get(norm)!;
    const [ex] = await db.select({ id: profesionalesTable.id }).from(profesionalesTable)
      .where(eq(profesionalesTable.nombreNormalizado, norm)).limit(1);
    if (ex) { cacheProf.set(norm, ex.id); return ex.id; }
    // Matchear también por nombre+apellido sin acentos (fichas viejas sin nombreNormalizado)
    const [porNombre] = await db.execute<{ id: number }>(sql`
      SELECT id FROM profesionales
      WHERE f_unaccent(lower(trim(trim(nombre) || ' ' || coalesce(trim(apellido), '')))) = f_unaccent(${norm})
         OR f_unaccent(lower(trim(coalesce(trim(apellido), '') || ' ' || trim(nombre)))) = f_unaccent(${norm})
      LIMIT 1
    `).then((r) => r.rows);
    if (porNombre) { cacheProf.set(norm, porNombre.id); return porNombre.id; }
    // El export trae "Nombre Apellido" (ej "Julio Figueroa"): última palabra = apellido
    const partes = nombre.trim().split(/\s+/);
    const apellido = partes.length > 1 ? titleCase(partes[partes.length - 1]) : undefined;
    const nombrePila = titleCase(partes.length > 1 ? partes.slice(0, -1).join(" ") : nombre.trim());
    const [nuevo] = await db.insert(profesionalesTable)
      .values({ nombre: nombrePila, apellido, nombreNormalizado: norm, especialidadId })
      .returning({ id: profesionalesTable.id });
    cacheProf.set(norm, nuevo.id);
    contadores.profesionalesCreados++;
    return nuevo.id;
  }

  // ── Agrupar por turnera (sede | especialidad | médico) ───────────────────
  interface Grupo {
    sede: string;
    especialidad: string;
    medico: string;
    filas: FilaTurno[];
  }
  const grupos = new Map<string, Grupo>();
  for (const f of filas) {
    const k = `${normalizar(f.institucion)}|${normalizar(f.especialidad)}|${normalizar(f.medico)}`;
    if (!grupos.has(k)) grupos.set(k, { sede: f.institucion, especialidad: f.especialidad, medico: f.medico, filas: [] });
    grupos.get(k)!.filas.push(f);
  }

  // ── Crear/acomodar turneras e inferir parámetros ──────────────────────────
  const turneraPorGrupo = new Map<string, { id: number; duracion: number }>();
  // Turneras hermanas del mismo trío: participan del dedup aunque no sean la elegida
  const turnerasDedupIds = new Set<number>();
  const grupoPorTurneraId = new Map<number, string>();

  for (const [k, g] of grupos) {
    const sedeId = await resolverSede(g.sede);
    const especialidadId = await resolverEspecialidad(g.especialidad);
    const profesionalId = await resolverProfesional(g.medico, especialidadId);

    // Inferencia: días, rango horario y duración (gap modal entre turnos del mismo día)
    const dias = new Set<number>();
    const porFecha = new Map<string, Set<number>>();
    let minH = Infinity;
    let maxH = -Infinity;
    for (const f of g.filas) {
      dias.add(diaSemana(f.fecha));
      const m = horaAMin(f.hora);
      minH = Math.min(minH, m);
      maxH = Math.max(maxH, m);
      if (!porFecha.has(f.fecha)) porFecha.set(f.fecha, new Set());
      porFecha.get(f.fecha)!.add(m);
    }
    const gaps = new Map<number, number>();
    for (const set of porFecha.values()) {
      const orden = [...set].sort((a, b) => a - b);
      for (let i = 1; i < orden.length; i++) {
        const gap = orden[i] - orden[i - 1];
        if (gap >= 5 && gap <= 120) gaps.set(gap, (gaps.get(gap) ?? 0) + 1);
      }
    }
    // Duración: gap modal ajustado al valor clínico permitido más cercano.
    // Se exige un mínimo de evidencia (3 gaps) para considerarla confiable.
    const DURACIONES_VALIDAS = [10, 15, 20, 30, 40, 60];
    let duracion = 30;
    let duracionInferida = false;
    if (gaps.size > 0) {
      const [gapModal, veces] = [...gaps.entries()].sort((a, b) => b[1] - a[1])[0];
      duracion = DURACIONES_VALIDAS.reduce((mejor, d) =>
        Math.abs(d - gapModal) < Math.abs(mejor - gapModal) ? d : mejor
      );
      duracionInferida = veces >= 3;
    }
    const diasStr = [...dias].sort((a, b) => a - b).join(",");
    const horaInicio = minAHora(minH);
    const horaFin = minAHora(Math.min(maxH + duracion, 23 * 60 + 59));

    // Consultorio modal
    const consCount = new Map<string, number>();
    for (const f of g.filas) {
      const c = f.consultorio.trim();
      if (c) consCount.set(c, (consCount.get(c) ?? 0) + 1);
    }
    const consultorio = consCount.size > 0
      ? [...consCount.entries()].sort((a, b) => b[1] - a[1])[0][0]
      : null;

    // Matchear turnera existente por trío profesional+sede+especialidad.
    // Orden determinístico por id: en re-ejecuciones siempre se elige la misma.
    const existentes = await db.select().from(turnerasTable).where(sql`
      ${turnerasTable.profesionalId} = ${profesionalId}
      AND ${turnerasTable.sedeId} = ${sedeId}
      AND ${turnerasTable.especialidadId} = ${especialidadId}
    `).orderBy(turnerasTable.id);

    const nombreAgenda = `${titleCase(g.medico.trim())} — ${titleCase(g.especialidad.trim())}`;

    // Fallback anti-duplicados por nombre+sede: cubre turneras de guardia (sin
    // profesional fijo, el trío no matchea) y agendas creadas a mano. Las
    // reimportaciones no deben recrear turneras duplicadas.
    if (existentes.length === 0) {
      const mismaSede = await db
        .select()
        .from(turnerasTable)
        .where(eq(turnerasTable.sedeId, sedeId))
        .orderBy(turnerasTable.id);
      const nombreNorm = normalizar(nombreAgenda);
      existentes.push(...mismaSede.filter((x) => normalizar(x.nombre) === nombreNorm));
    }

    // Todas las candidatas del trío participan del dedup de turnos, elija la
    // que elija esta corrida (evita duplicar si otra corrida usó otra turnera).
    for (const x of existentes) {
      turnerasDedupIds.add(x.id);
      grupoPorTurneraId.set(x.id, k);
    }

    if (existentes.length > 0) {
      // Acomodar la primera activa (o la primera): unir días, ensanchar horario
      const t = existentes.find((x) => x.activa) ?? existentes[0];
      const diasUnion = new Set(t.diasAtencion.split(",").map(Number).filter((n) => !isNaN(n)));
      for (const d of dias) diasUnion.add(d);
      const cambios: Partial<typeof turnerasTable.$inferInsert> = {
        diasAtencion: [...diasUnion].sort((a, b) => a - b).join(","),
        activa: true,
      };
      if (horaAMin(t.horaInicio) > minH) cambios.horaInicio = horaInicio;
      if (horaAMin(t.horaFin) < horaAMin(horaFin)) cambios.horaFin = horaFin;
      if (t.duracionPendiente && duracionInferida) {
        cambios.duracionMinutos = duracion;
        cambios.duracionPendiente = false;
      }
      if (!t.consultorio && consultorio) cambios.consultorio = consultorio;
      await db.update(turnerasTable).set(cambios).where(eq(turnerasTable.id, t.id));
      turneraPorGrupo.set(k, { id: t.id, duracion: t.duracionPendiente && duracionInferida ? duracion : t.duracionMinutos });
      contadores.turnerasActualizadas++;
    } else {
      const importKey = `${profesionalId}::${sedeId}::${especialidadId}::${horaInicio}::${horaFin}::${normalizar(consultorio ?? "")}`;
      const [nueva] = await db.insert(turnerasTable).values({
        nombre: nombreAgenda,
        profesionalId,
        especialidadId,
        sedeId,
        diasAtencion: diasStr || "1,2,3,4,5",
        horaInicio,
        horaFin,
        duracionMinutos: duracion,
        duracionPendiente: !duracionInferida,
        consultorio,
        importKey,
        activa: true,
        visibilidad: "recepcion",
      }).returning({ id: turnerasTable.id });
      turneraPorGrupo.set(k, { id: nueva.id, duracion });
      turnerasDedupIds.add(nueva.id);
      grupoPorTurneraId.set(nueva.id, k);
      contadores.turnerasCreadas++;
    }
  }

  // ── Upsert de pacientes por DNI ───────────────────────────────────────────
  const dnis = [...new Set(filas.map((f) => f.dni).filter((d) => d.length >= 6))];
  const pacientePorDni = new Map<string, number>();
  for (let i = 0; i < dnis.length; i += 5000) {
    const lote = dnis.slice(i, i + 5000);
    const existentes = await db.select({
      id: pacientesTable.id, dni: pacientesTable.dni, activo: pacientesTable.activo,
      sexo: pacientesTable.sexo, fechaNacimiento: pacientesTable.fechaNacimiento,
      cobertura: pacientesTable.cobertura, nroAfiliado: pacientesTable.nroAfiliado,
    }).from(pacientesTable).where(inArray(pacientesTable.dni, lote));
    for (const p of existentes) {
      pacientePorDni.set(p.dni!, p.id);
      // Reactivar fichas inactivas y completar faltantes con la primera fila del DNI
      const fila = filas.find((f) => f.dni === p.dni);
      const cambios: Record<string, unknown> = {};
      if (!p.activo) { cambios.activo = true; contadores.pacientesReactivados++; }
      if (!p.sexo && fila?.sexo && ["M", "F"].includes(fila.sexo)) cambios.sexo = fila.sexo;
      if (!p.fechaNacimiento && fila) {
        const fn = normalizarFechaNac(fila.fechaNac);
        if (fn) cambios.fechaNacimiento = fn;
      }
      if (!p.cobertura && fila?.obraSocial) cambios.cobertura = fila.obraSocial;
      if (!p.nroAfiliado && fila?.nroAfiliado) cambios.nroAfiliado = fila.nroAfiliado;
      if (Object.keys(cambios).length > 0) {
        await db.update(pacientesTable).set(cambios).where(eq(pacientesTable.id, p.id));
        contadores.pacientesActualizados++;
      }
    }
  }

  // Crear los que faltan
  const filaPorDni = new Map<string, FilaTurno>();
  for (const f of filas) if (f.dni.length >= 6 && !filaPorDni.has(f.dni)) filaPorDni.set(f.dni, f);
  for (const [dni, f] of filaPorDni) {
    if (pacientePorDni.has(dni)) continue;
    const { nombre, apellido } = splitNombre(f.pacienteNombre);
    try {
      const [p] = await db.insert(pacientesTable).values({
        nombre,
        apellido: apellido ?? nombre,
        dni,
        sexo: ["M", "F"].includes(f.sexo) ? f.sexo : undefined,
        fechaNacimiento: normalizarFechaNac(f.fechaNac),
        cobertura: f.obraSocial || undefined,
        planCobertura: f.plan || undefined,
        nroAfiliado: f.nroAfiliado || undefined,
      }).returning({ id: pacientesTable.id });
      pacientePorDni.set(dni, p.id);
      contadores.pacientesCreados++;
    } catch {
      // 23505: carrera con otra ficha del mismo DNI → recuperar la existente
      const [ex] = await db.select({ id: pacientesTable.id }).from(pacientesTable)
        .where(eq(pacientesTable.dni, dni)).limit(1);
      if (ex) pacientePorDni.set(dni, ex.id);
      else logger.warn({ dni }, "importacion-turnos-detallados: paciente no se pudo crear ni recuperar");
    }
  }

  // ── Dedup de turnos existentes ────────────────────────────────────────────
  const fechaMin = filas.reduce((a, f) => (f.fecha < a ? f.fecha : a), "9999-12-31");
  // El dedup se hace a nivel GRUPO (trío sede+especialidad+médico): un mismo
  // turno ya existente en cualquier turnera hermana del trío cuenta como
  // duplicado, aunque esta corrida haya elegido otra turnera del trío.
  const turnerasIds = [...turnerasDedupIds];
  const existentesKeys = new Set<string>();
  const slotActivoKeys = new Set<string>();
  if (turnerasIds.length > 0) {
    const existentes = await db.select({
      turneraId: turnosTable.turneraId, pacienteId: turnosTable.pacienteId,
      fecha: turnosTable.fecha, horaInicio: turnosTable.horaInicio,
      estado: turnosTable.estado, sobreturno: turnosTable.sobreturno,
    }).from(turnosTable).where(sql`
      ${turnosTable.turneraId} IN (${sql.join(turnerasIds.map((id) => sql`${id}`), sql`, `)})
      AND ${gte(turnosTable.fecha, fechaMin)}
    `);
    for (const t of existentes) {
      const grupo = grupoPorTurneraId.get(t.turneraId) ?? String(t.turneraId);
      existentesKeys.add(`${grupo}|${t.fecha}|${t.horaInicio}|${t.pacienteId}`);
      if (!["cancelado", "ausente"].includes(t.estado) && !t.sobreturno) {
        slotActivoKeys.add(`${t.turneraId}|${t.fecha}|${t.horaInicio}`);
      }
    }
  }

  // ── Insertar turnos ───────────────────────────────────────────────────────
  const aInsertar: typeof turnosTable.$inferInsert[] = [];
  for (const f of filas) {
    if (f.dni.length < 6 || !pacientePorDni.has(f.dni)) { contadores.filasSinDni++; continue; }
    const k = `${normalizar(f.institucion)}|${normalizar(f.especialidad)}|${normalizar(f.medico)}`;
    const turnera = turneraPorGrupo.get(k);
    if (!turnera) continue;
    const pacienteId = pacientePorDni.get(f.dni)!;

    const dedupKey = `${k}|${f.fecha}|${f.hora}|${pacienteId}`;
    if (existentesKeys.has(dedupKey)) { contadores.turnosOmitidos++; continue; }
    existentesKeys.add(dedupKey);

    const slotKey = `${turnera.id}|${f.fecha}|${f.hora}`;
    const esActivo = !["cancelado", "ausente"].includes(f.estado);
    let sobreturno = false;
    if (esActivo) {
      if (slotActivoKeys.has(slotKey)) {
        sobreturno = true;
        contadores.turnosSobreturno++;
      } else {
        slotActivoKeys.add(slotKey);
      }
    }

    const profesionalGrupo = grupos.get(k)!;
    const obs: string[] = [];
    if (f.aReprogramar) obs.push("A reprogramar (Alephoo)");
    if (f.turnoExterno) obs.push(`Alephoo #${f.turnoExterno}`);

    aInsertar.push({
      turneraId: turnera.id,
      pacienteId,
      profesionalId: cacheProf.get(normalizar(profesionalGrupo.medico)),
      fecha: f.fecha,
      horaInicio: f.hora,
      horaFin: minAHora(Math.min(horaAMin(f.hora) + turnera.duracion, 23 * 60 + 59)),
      estado: f.estado,
      sobreturno,
      motivoConsulta: f.motivo || undefined,
      cobertura: f.obraSocial || undefined,
      nroAfiliado: f.nroAfiliado || undefined,
      creadoPor: "importacion-alephoo",
      observaciones: obs.length > 0 ? obs.join(" | ") : undefined,
    });
  }

  const esConflictoUnico = (err: unknown): boolean =>
    typeof err === "object" && err !== null && (err as { code?: string }).code === "23505";

  for (let i = 0; i < aInsertar.length; i += 500) {
    const lote = aInsertar.slice(i, i + 500);
    try {
      await db.insert(turnosTable).values(lote);
      contadores.turnosCreados += lote.length;
    } catch {
      // Falló el lote: reintentar fila por fila para aislar la causa
      for (const t of lote) {
        try {
          await db.insert(turnosTable).values(t);
          contadores.turnosCreados++;
        } catch (err) {
          if (!esConflictoUnico(err)) {
            // Error inesperado (no es choque de slot): se cuenta aparte para
            // que la pérdida no quede disfrazada de "omitidos"
            contadores.turnosErrores++;
            logger.error({ err, turno: { turneraId: t.turneraId, fecha: t.fecha, horaInicio: t.horaInicio } },
              "importacion-turnos-detallados: error inesperado insertando turno");
            continue;
          }
          try {
            // Choque de slot único: reintentar como sobreturno explícito
            await db.insert(turnosTable).values({ ...t, sobreturno: true });
            contadores.turnosCreados++;
            contadores.turnosSobreturno++;
          } catch (err2) {
            if (esConflictoUnico(err2)) {
              contadores.turnosOmitidos++;
            } else {
              contadores.turnosErrores++;
              logger.error({ err: err2 }, "importacion-turnos-detallados: error inesperado en reintento sobreturno");
            }
          }
        }
      }
    }
  }

  if (contadores.turnosErrores > 0) {
    logger.warn({ turnosErrores: contadores.turnosErrores },
      "importacion-turnos-detallados: terminó con errores de inserción; revisar el log");
  }
}
