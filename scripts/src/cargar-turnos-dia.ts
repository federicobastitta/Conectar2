/**
 * Importa turnos desde un reporte de turnos del día de Alephoo
 * (HTML UTF-16 disfrazado de .xls) hacia la tabla turnos de Conectar.
 *
 * Uso:
 *   pnpm --filter @workspace/scripts run cargar-turnos-dia <ruta.xls>
 *
 * - Paciente por DNI (deben existir; correr antes cargar-pacientes-turnos)
 * - Turnera por profesional + sede + día de semana + hora dentro del rango
 * - Solo estados "Pendiente" (los "A reprogramar" / "No asistió" se omiten y reportan)
 * - Sobreturnos de Alephoo se insertan con sobreturno=true
 * - Idempotente: no duplica (misma turnera+fecha+hora+paciente) y respeta el
 *   índice único de slot activo
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { pool } from "@workspace/db";

function limpiar(s: string): string {
  return s
    .replace(/<[^>]+>/g, "")
    .replace(/&oacute;/g, "ó")
    .replace(/&aacute;/g, "á")
    .replace(/&eacute;/g, "é")
    .replace(/&iacute;/g, "í")
    .replace(/&uacute;/g, "ú")
    .replace(/&ntilde;/g, "ñ")
    .replace(/&Ntilde;/g, "Ñ")
    .replace(/&amp;/g, "&")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizar(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[,.]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/** Clave de matching por nombre: tokens ordenados alfabéticamente */
function claveTokens(s: string): string {
  return normalizar(s).split(" ").filter(Boolean).sort().join(" ");
}

function horaAMin(h: string): number {
  const [hh, mm] = h.split(":").map(Number);
  return hh * 60 + (mm || 0);
}

function minAHora(m: number): string {
  return `${String(Math.floor(m / 60) % 24).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

async function main() {
  const archivoArg = process.argv.slice(2).find((a) => a !== "--");
  if (!archivoArg) {
    console.error("Uso: pnpm --filter @workspace/scripts run cargar-turnos-dia <ruta.xls>");
    process.exit(1);
  }
  const archivo = path.resolve(archivoArg);
  console.log(`Leyendo: ${archivo}`);
  const html = readFileSync(archivo).toString("latin1").replace(/\x00/g, "");
  const rows = [...html.matchAll(/<tr>([\s\S]*?)<\/tr>/gi)].map((m) =>
    [...m[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((c) => limpiar(c[1])),
  );
  const H = rows[0];
  const idx = (n: string) => H.findIndex((h) => h === n);
  const data = rows.slice(1).filter((r) => r.length === H.length);
  const iDni = idx("DNI");
  const iFecha = idx("Fecha Turno");
  const iHora = idx("Hora Turno");
  const iTipo = idx("Tipo Turno");
  const iEstado = idx("Estado Turno");
  const iEsp = idx("Especialidad");
  const iMed = idx("Medico");
  const iInst = idx("Institución");
  const iMotivo = idx("Motivo de turno");
  const iOs = idx("Obra Social");
  const iAfil = idx("Nro. de afiliado");
  if ([iDni, iFecha, iHora, iMed, iInst].some((i) => i < 0)) {
    throw new Error(`Columnas esperadas no encontradas: ${JSON.stringify(H)}`);
  }

  // ── Cargar catálogos ──────────────────────────────────────────────────────
  const profs = await pool.query(`SELECT id, coalesce(apellido,'') apellido, nombre FROM profesionales`);
  const profPorClave = new Map<string, number[]>();
  for (const p of profs.rows) {
    const k = claveTokens(`${p.apellido} ${p.nombre}`);
    profPorClave.set(k, [...(profPorClave.get(k) ?? []), p.id]);
  }

  const sedes = await pool.query(`SELECT id, nombre FROM sedes`);
  const sedePorNorm = new Map<string, number>(sedes.rows.map((s) => [normalizar(s.nombre), s.id]));

  const esps = await pool.query(`SELECT id, nombre FROM especialidades`);
  const espPorNorm = new Map<string, number>(esps.rows.map((e) => [normalizar(e.nombre), e.id]));

  const turneras = await pool.query(
    `SELECT id, profesional_id, sede_id, especialidad_id, dias_atencion, hora_inicio, hora_fin, duracion_minutos,
            (import_key IS NOT NULL) AS de_import
     FROM turneras WHERE activa = true`,
  );

  const pacientes = await pool.query(`SELECT id, dni FROM pacientes WHERE dni IS NOT NULL`);
  const pacPorDni = new Map<string, number>(pacientes.rows.map((p) => [p.dni, p.id]));

  // ── Procesar filas ────────────────────────────────────────────────────────
  const problemas: Record<string, number> = {};
  const detalleProblemas: string[] = [];
  let insertados = 0, yaExistian = 0, omitidosEstado = 0;

  const anotar = (tipo: string, det?: string) => {
    problemas[tipo] = (problemas[tipo] ?? 0) + 1;
    if (det && detalleProblemas.length < 30) detalleProblemas.push(`${tipo}: ${det}`);
  };

  for (const r of data) {
    const estado = r[iEstado];
    if (estado !== "Pendiente") { omitidosEstado++; continue; }

    const fecha = r[iFecha];
    if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha)) { anotar("fecha inválida", fecha); continue; }
    const dow = new Date(`${fecha}T00:00:00.000Z`).getUTCDay(); // 0=Dom

    const dni = (r[iDni] ?? "").replace(/\D/g, "");
    const pacienteId = pacPorDni.get(dni);
    if (!pacienteId) { anotar("paciente no encontrado", dni); continue; }

    const horaRaw = (r[iHora] ?? "").match(/^(\d{1,2}):(\d{2})/);
    if (!horaRaw) { anotar("hora inválida", r[iHora]); continue; }
    const hora = `${horaRaw[1].padStart(2, "0")}:${horaRaw[2]}`;
    const horaMin = horaAMin(hora);

    const profIds = profPorClave.get(claveTokens(r[iMed] ?? "")) ?? [];
    if (profIds.length === 0) { anotar("médico no encontrado", r[iMed]); continue; }

    const sedeId = sedePorNorm.get(normalizar(r[iInst] ?? ""));
    if (!sedeId) { anotar("sede no encontrada", r[iInst]); continue; }

    const espId = espPorNorm.get(normalizar(r[iEsp] ?? "")) ?? null;

    if (espId == null) { anotar("especialidad no encontrada", r[iEsp]); continue; }

    // Candidatas: turneras del profesional en esa sede y especialidad,
    // con el día de semana y la hora dentro del rango
    let candidatas = turneras.rows.filter((t) =>
      profIds.includes(t.profesional_id) &&
      t.sede_id === sedeId &&
      t.especialidad_id === espId &&
      String(t.dias_atencion).split(",").map(Number).includes(dow) &&
      horaMin >= horaAMin(t.hora_inicio) && horaMin < horaAMin(t.hora_fin),
    );
    // Si hay duplicadas de distintos orígenes, priorizar las del import
    // oficial de agendas (import_key) sobre las viejas del autopilot
    if (candidatas.some((t) => t.de_import)) {
      candidatas = candidatas.filter((t) => t.de_import);
    }
    if (candidatas.length === 0) { anotar("sin turnera compatible", `${r[iMed]} / ${r[iEsp]} / ${r[iInst]} ${hora}`); continue; }
    if (candidatas.length > 1) { anotar("turnera ambigua", `${r[iMed]} / ${r[iEsp]} / ${r[iInst]} ${hora}`); continue; }
    const turnera = candidatas[0];

    const horaFin = minAHora(horaMin + (turnera.duracion_minutos || 30));
    const esSobreturno = r[iTipo] === "Sobreturno";

    // Idempotencia: mismo paciente+turnera+fecha+hora ya cargado
    const dupe = await pool.query(
      `SELECT 1 FROM turnos WHERE turnera_id=$1 AND fecha=$2 AND hora_inicio=$3 AND paciente_id=$4 LIMIT 1`,
      [turnera.id, fecha, hora, pacienteId],
    );
    if ((dupe.rowCount ?? 0) > 0) { yaExistian++; continue; }

    try {
      await pool.query(
        `INSERT INTO turnos (turnera_id, paciente_id, profesional_id, fecha, hora_inicio, hora_fin,
                             estado, sobreturno, motivo_consulta, cobertura, nro_afiliado, creado_por)
         VALUES ($1,$2,$3,$4,$5,$6,'pendiente',$7,$8,$9,$10,'import-alephoo')`,
        [turnera.id, pacienteId, turnera.profesional_id, fecha, hora, horaFin,
         esSobreturno, r[iMotivo] || null, r[iOs] || null, r[iAfil] || null],
      );
      insertados++;
    } catch (e: unknown) {
      const err = e as { code?: string };
      if (err.code === "23505") {
        // Slot ya ocupado por otro paciente → entra como sobreturno
        await pool.query(
          `INSERT INTO turnos (turnera_id, paciente_id, profesional_id, fecha, hora_inicio, hora_fin,
                               estado, sobreturno, motivo_consulta, cobertura, nro_afiliado, creado_por)
           VALUES ($1,$2,$3,$4,$5,$6,'pendiente',true,$7,$8,$9,'import-alephoo')`,
          [turnera.id, pacienteId, turnera.profesional_id, fecha, hora, horaFin,
           r[iMotivo] || null, r[iOs] || null, r[iAfil] || null],
        );
        insertados++;
        anotar("slot ocupado → sobreturno", `${r[iMed]} ${hora} DNI ${dni}`);
      } else {
        throw e;
      }
    }
  }

  console.log(`
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Turnos en archivo        : ${data.length}
Omitidos por estado      : ${omitidosEstado} (A reprogramar / No asistió)
Insertados               : ${insertados}
Ya existían              : ${yaExistian}
No importados            : ${Object.entries(problemas).filter(([k]) => k !== "slot ocupado → sobreturno").reduce((a, [, v]) => a + v, 0)}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  for (const [k, v] of Object.entries(problemas)) console.log(`  · ${k}: ${v}`);
  if (detalleProblemas.length) {
    console.log("\nEjemplos:");
    for (const d of detalleProblemas) console.log(`  - ${d}`);
  }
  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
