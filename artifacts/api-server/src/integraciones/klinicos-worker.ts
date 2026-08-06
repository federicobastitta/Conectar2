import { asc, eq, inArray, sql } from "drizzle-orm";
import {
  db,
  klinicosTrabajos,
  klinicosPracticas,
  klinicosPrescriptores,
  klinicosReglasPractica,
  klinicosReglasCie10,
  type KlinicosTrabajo,
  turnosTable,
} from "@workspace/db";
import { openai } from "@workspace/integrations-openai-ai-server";
import { logger } from "../lib/logger";
import {
  ejecutarIngresoKlinicos,
  credencialesKlinicos,
  type CredencialKlinicos,
  klinicosHabilitado,
  klinicosDryRun,
  CookieJar,
  loginKlinicos,
  seleccionarContextoKlinicos,
} from "./klinicos-robot";
import {
  esPracticaExcluida,
  armarPlanPracticaSimulado,
  enmascararToken,
  autorizarPrestacionReal,
  anularPrestacionReal,
  extraerAtencionId,
  leerGrillaPrestaciones,
  leerFilasPrestacionesAjax,
} from "./klinicos-prestaciones";
import { resolverOrdenParaTrabajo } from "./klinicos-ordenes";

// ── Worker de la cola Klinicos ─────────────────────────────────────────────
// Cada ciclo toma trabajos pendientes, los enriquece con IA (Consulta por +
// CIE10 sugerido, revisables desde la bandeja) y ejecuta el robot. La carga
// es INMEDIATA (cada 60 s): el token de autorización que genera el paciente
// vence a las pocas horas, así que no se puede diferir a un lote nocturno.
// Si el robot está deshabilitado (sin credenciales), los trabajos quedan
// pendientes.

const INTERVALO_MS = 60_000;
const MAX_INTENTOS = 3;
let corriendo = false;

export function flagsCreacionTrasSimulacion(
  resultado: { ingresoCreado: boolean; prestacionCreada?: boolean },
  trabajo: { klinicosIngresoCreado: boolean; klinicosPrestacionCreada: boolean },
): { klinicosIngresoCreado: boolean; klinicosPrestacionCreada: boolean } {
  return {
    klinicosIngresoCreado: resultado.ingresoCreado || trabajo.klinicosIngresoCreado,
    klinicosPrestacionCreada: (resultado.prestacionCreada ?? false) || trabajo.klinicosPrestacionCreada,
  };
}
export function klinicosModo(): "simulacion" | "asistido" {
  return process.env.KLINICOS_MODO === "simulacion" ? "simulacion" : "asistido";
}
function normalizar(s: string): string {
  return s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toUpperCase().trim();
}

// Contención por PALABRAS COMPLETAS (fail-closed): la frase buscada debe
// aparecer como secuencia de tokens con límites de palabra, no como substring
// crudo ("ECO" no machea dentro de "ECOGRAFICO").
export function contienePalabrasCompletas(texto: string, frase: string): boolean {
  const fraseTokens = frase.split(/[^A-Z0-9]+/).filter(Boolean);
  if (!fraseTokens.length) return false;
  const textoTokens = texto.split(/[^A-Z0-9]+/).filter(Boolean);
  for (let i = 0; i <= textoTokens.length - fraseTokens.length; i++) {
    if (fraseTokens.every((t, j) => textoTokens[i + j] === t)) return true;
  }
  return false;
}

// Equivalencias fijas motivo → CIE-10: si el texto del turno contiene el
// patrón de alguna regla activa, se usa ese diagnóstico y NO se llama a la
// IA. Mayor prioridad gana; a igual prioridad, el patrón más largo (más
// específico) gana.
export async function resolverCie10PorRegla(trabajo: Pick<KlinicosTrabajo, "especialidad" | "motivo">): Promise<{
  consultaPor: string;
  cie10Codigo: string;
  cie10Descripcion: string;
} | null> {
  const texto = normalizar(`${trabajo.especialidad} ${trabajo.motivo ?? ""}`);
  const reglas = await db.select().from(klinicosReglasCie10).where(eq(klinicosReglasCie10.activo, true));
  const match = reglas
    .filter((r) => r.patron.trim() && texto.includes(normalizar(r.patron)))
    .sort((a, b) => b.prioridad - a.prioridad || b.patron.length - a.patron.length)[0];
  if (!match) return null;
  return {
    consultaPor: match.consultaPor || `Consulta de ${trabajo.especialidad.toLowerCase()}`,
    cie10Codigo: match.cie10Codigo,
    cie10Descripcion: match.cie10Descripcion,
  };
}

// FAIL-CLOSED (regla 18 del manual): el CIE-10 que sugiere la IA solo se
// acepta si figura en el catálogo aprobado (klinicos_reglas_cie10 activas).
// Fuera del catálogo → queda null (pendiente, revisable desde la bandeja) y
// nunca se envía un código inventado a Klinicos.
export async function validarCie10ContraCatalogo(codigo: string | null): Promise<boolean> {
  if (!codigo) return false;
  const norm = normalizar(codigo);
  const reglas = await db
    .select({ cie10Codigo: klinicosReglasCie10.cie10Codigo })
    .from(klinicosReglasCie10)
    .where(eq(klinicosReglasCie10.activo, true));
  return reglas.some((r) => normalizar(r.cie10Codigo) === norm);
}

async function enriquecerConIA(trabajo: KlinicosTrabajo): Promise<{
  consultaPor: string;
  cie10Codigo: string | null;
  cie10Descripcion: string | null;
}> {
  const contexto = `Especialidad: ${trabajo.especialidad}. Motivo de consulta: ${trabajo.motivo ?? "(no informado)"}.`;
  try {
    const response = await openai.chat.completions.create({
      model: "gpt-5.4-mini",
      max_completion_tokens: 200,
      messages: [
        {
          role: "system",
          content:
            'Sos un asistente administrativo de una clínica argentina. A partir de la especialidad y el motivo de consulta, devolvé SOLO un JSON con: "consultaPor" (texto breve y formal para el campo "Consulta por" de un ingreso ambulatorio, ej "Consulta cardiológica de control"), "cie10Codigo" (código CIE-10 más probable, ej "Z00.0") y "cie10Descripcion" (descripción en español). Es un dato administrativo orientativo, no un diagnóstico clínico. Si el motivo no alcanza, usá un código de consulta general (Z00-Z13).',
        },
        { role: "user", content: contexto },
      ],
    });
    const raw = response.choices[0]?.message?.content ?? "{}";
    const parsed = JSON.parse(raw.replace(/^```json?\s*|\s*```$/g, "")) as {
      consultaPor?: string;
      cie10Codigo?: string;
      cie10Descripcion?: string;
    };
    const codigoAprobado = await validarCie10ContraCatalogo(parsed.cie10Codigo ?? null);
    if (parsed.cie10Codigo && !codigoAprobado) {
      logger.info(
        { trabajoId: trabajo.id, cie10Sugerido: parsed.cie10Codigo },
        "klinicos-worker: CIE-10 sugerido por IA fuera del catálogo aprobado, queda pendiente de revisión",
      );
    }
    return {
      consultaPor: parsed.consultaPor || `Consulta de ${trabajo.especialidad.toLowerCase()}`,
      cie10Codigo: codigoAprobado ? parsed.cie10Codigo! : null,
      cie10Descripcion: codigoAprobado ? (parsed.cie10Descripcion ?? null) : null,
    };
  } catch (err) {
    logger.warn({ err, trabajoId: trabajo.id }, "klinicos-worker: fallo IA, uso texto por defecto");
    return {
      consultaPor: `Consulta de ${trabajo.especialidad.toLowerCase()}`,
      cie10Codigo: null,
      cie10Descripcion: null,
    };
  }
}

// ── Informe para el circuito de prácticas (obra social) ────────────────────
// SIN IA: el informe se consulta directo al PACS (la impresión que cargó el
// médico en el estudio) y ese texto acompaña la práctica en Klinicos. Sale
// firmado con la firma escaneada del médico al momento de emitir el PDF.
// Si el PACS todavía no tiene el estudio informado, se devuelve null y se
// reintenta más adelante (regenerar desde la bandeja).
export async function generarInformeFacturacion(trabajoId: number): Promise<string | null> {
  const [trabajo] = await db.select().from(klinicosTrabajos).where(eq(klinicosTrabajos.id, trabajoId)).limit(1);
  if (!trabajo) return null;

  let impresionPacs: string | null = null;
  try {
    const { dicomPacsConfigurado, getEstudiosDicomByDni } = await import("./diagnostipacs-api");
    if (dicomPacsConfigurado() && trabajo.dni) {
      const r = await getEstudiosDicomByDni(trabajo.dni);
      if (r.ok) {
        const conImpresion = r.data.filter((e) => e.impression && e.impression.trim().length > 0);
        impresionPacs = conImpresion[0]?.impression ?? null;
      } else {
        logger.warn({ trabajoId, code: r.code }, "klinicos-worker: PACS no disponible para el informe");
      }
    }
  } catch (err) {
    logger.warn({ err, trabajoId }, "klinicos-worker: no se pudo consultar el PACS para el informe");
  }

  if (!impresionPacs) {
    logger.info({ trabajoId }, "klinicos-worker: el PACS todavía no tiene informe para este estudio");
    return null;
  }

  const texto = [
    `Estudio: ${trabajo.especialidad}`,
    trabajo.practicaCodigos?.length ? `Práctica(s): ${trabajo.practicaCodigos.join(", ")}` : null,
    "",
    impresionPacs.trim(),
  ].filter((l): l is string => l !== null).join("\n");

  await db
    .update(klinicosTrabajos)
    .set({ informeIaTexto: texto, informeIaGeneradoEn: new Date() })
    .where(eq(klinicosTrabajos.id, trabajoId));
  return texto;
}

export async function resolverPractica(
  trabajo: Pick<KlinicosTrabajo, "sectorServicio" | "especialidad" | "motivo">,
): Promise<{
  codigos: string[] | null;
  efector: string | null;
  practicaId: number | null;
  practicaNombre: string | null;
}> {
  const nada = { codigos: null, efector: null, practicaId: null, practicaNombre: null };
  if (trabajo.sectorServicio !== "IMAGENES S/C") return nada;
  const especialidadNorm = normalizar(trabajo.especialidad);
  const texto = normalizar(`${trabajo.especialidad} ${trabajo.motivo ?? ""}`);

  // 1) Reglas fijas especialidad → práctica (mayor prioridad gana; a igual
  //    prioridad gana la que tiene patrón de motivo, por ser más específica)
  const reglas = await db
    .select({
      patronMotivo: klinicosReglasPractica.patronMotivo,
      especialidad: klinicosReglasPractica.especialidad,
      prioridad: klinicosReglasPractica.prioridad,
      practicaId: klinicosPracticas.id,
      nombre: klinicosPracticas.nombre,
      codigos: klinicosPracticas.codigos,
      efectorNombre: klinicosPracticas.efectorNombre,
      practicaActiva: klinicosPracticas.activo,
    })
    .from(klinicosReglasPractica)
    .innerJoin(klinicosPracticas, eq(klinicosReglasPractica.practicaId, klinicosPracticas.id))
    .where(eq(klinicosReglasPractica.activo, true));
  const regla = reglas
    .filter(
      (r) =>
        r.practicaActiva &&
        especialidadNorm.includes(normalizar(r.especialidad)) &&
        (!r.patronMotivo || texto.includes(normalizar(r.patronMotivo))),
    )
    .sort((a, b) => b.prioridad - a.prioridad || (b.patronMotivo ? 1 : 0) - (a.patronMotivo ? 1 : 0))[0];
  if (regla) {
    return { codigos: regla.codigos, efector: regla.efectorNombre, practicaId: regla.practicaId, practicaNombre: regla.nombre };
  }

  // 2) Fallback por nombre contenido en el texto del turno, FAIL-CLOSED
  //    (regla 7 del manual): solo se acepta si EXACTAMENTE una práctica del
  //    catálogo machea. 0 o >1 candidatas → sin práctica (revisión humana
  //    desde la bandeja).
  const practicas = await db.select().from(klinicosPracticas).where(eq(klinicosPracticas.activo, true));
  const candidatas = practicas.filter((p) => contienePalabrasCompletas(texto, normalizar(p.nombre)));
  if (candidatas.length !== 1) {
    if (candidatas.length > 1) {
      logger.info(
        { candidatas: candidatas.map((c) => c.nombre) },
        "klinicos-worker: práctica ambigua por nombre, se deriva a revisión manual",
      );
    }
    return nada;
  }
  const match = candidatas[0];
  return { codigos: match.codigos, efector: match.efectorNombre, practicaId: match.id, practicaNombre: match.nombre };
}

// Rotación round-robin de prescriptores: se elige el activo con uso más
// antiguo (nulls primero) y se marca su último uso en la misma operación para
// que dos trabajos concurrentes no repitan prescriptor. Para pacientes
// varones se excluyen ginecólogos.
export async function elegirPrescriptor(sexo: string | null): Promise<string | null> {
  const esVaron = sexo != null && normalizar(sexo).startsWith("M");
  const [row] = await db
    .update(klinicosPrescriptores)
    .set({ ultimoUsoEn: sql`now()` })
    .where(
      sql`${klinicosPrescriptores.id} = (
        SELECT id FROM ${klinicosPrescriptores}
        WHERE activo = true ${esVaron ? sql`AND es_ginecologo = false` : sql``}
        ORDER BY ultimo_uso_en ASC NULLS FIRST, id ASC
        LIMIT 1
        FOR UPDATE SKIP LOCKED
      )`,
    )
    .returning({ nombre: klinicosPrescriptores.nombre });
  return row?.nombre ?? null;
}

// ── Prácticas de cardiología (lección 03/08/2026) ───────────────────────────
// Electro 170101, presurometría/MAPA 881701, ergometría 881706, Holter 881710.
// Reglas del usuario: el ingreso/efector es SIEMPRE CÁCERES FRANCO (sin rotar
// la dupla FRANGI/CACERES) y el diagnóstico general rota entre los CIE-10
// aprobados (presurometría SIEMPRE R03.0). Sin IA.
const CODIGOS_PRACTICAS_CARDIO = new Set(["170101", "881701", "881706", "881710"]);
const CODIGO_PRESUROMETRIA = "881701";
export const EFECTOR_PRACTICAS_CARDIO = "CACERES FRANCO";
const CIE10_PRACTICAS_CARDIO: Array<{ codigo: string; descripcion: string }> = [
  { codigo: "R00.2", descripcion: "Palpitaciones" },
  { codigo: "R01.1", descripcion: "Soplo cardíaco, no especificado" },
  { codigo: "R03.0", descripcion: "Lectura de presión sanguínea elevada, sin diagnóstico de hipertensión" },
  { codigo: "R06.0", descripcion: "Disnea" },
  { codigo: "R07.2", descripcion: "Dolor precordial" },
  { codigo: "R07.4", descripcion: "Dolor en el pecho, no especificado" },
];

export function esPracticaCardio(codigos: string[] | null | undefined): boolean {
  return Boolean(codigos?.length && codigos.every((c) => CODIGOS_PRACTICAS_CARDIO.has(c.trim())));
}

export function diagnosticoPracticaCardio(
  codigos: string[],
  semilla: number,
): { codigo: string; descripcion: string } {
  if (codigos.some((c) => c.trim() === CODIGO_PRESUROMETRIA)) {
    return { codigo: "R03.0", descripcion: "Lectura de presión sanguínea elevada, sin diagnóstico de hipertensión" };
  }
  return CIE10_PRACTICAS_CARDIO[Math.abs(semilla) % CIE10_PRACTICAS_CARDIO.length]!;
}

// Efector según la planilla: cada práctica tiene su(s) efector(es) en
// klinicos_practicas.efector_nombre. Cuando son varios (separados por "-",
// ej. "FRANGI PATRICIO-CACERES FRANCO" para cardio, "MUÑOZ CARLOS -VARELA ANA"
// para ecografías) se elige UNO por rotación (el menos usado recientemente).
export async function elegirEfector(efectorCombinado: string): Promise<string> {
  const candidatos = efectorCombinado.split("-").map((s) => s.trim()).filter(Boolean);
  if (candidatos.length <= 1) return efectorCombinado.trim();
  const usos = await db
    .select({ efector: klinicosTrabajos.efectorNombre, ultimo: sql<number>`max(${klinicosTrabajos.id})` })
    .from(klinicosTrabajos)
    .where(inArray(klinicosTrabajos.efectorNombre, candidatos))
    .groupBy(klinicosTrabajos.efectorNombre);
  const ultimoUso = new Map(usos.map((u) => [u.efector, Number(u.ultimo)]));
  return [...candidatos].sort((a, b) => (ultimoUso.get(a) ?? 0) - (ultimoUso.get(b) ?? 0))[0];
}

// Para trabajos que ya traen códigos (prácticas tildadas en la agenda) pero
// sin efector: buscar el efector de la planilla por código exacto.
// Nombre de la práctica en la planilla (para "Consulta por"): el ingreso de
// una práctica debe decir la práctica ("HOLTER"), no un texto de consulta.
async function resolverNombrePracticaPorCodigos(codigos: string[]): Promise<string | null> {
  const filas = await db
    .select({ nombre: klinicosPracticas.nombre, codigos: klinicosPracticas.codigos })
    .from(klinicosPracticas);
  const buscados = new Set(codigos.map((c) => c.trim()));
  const nombres = filas
    .filter((f) => f.codigos?.some((c) => buscados.has(c.trim())))
    .map((f) => f.nombre)
    .filter(Boolean);
  return nombres.length ? [...new Set(nombres)].join(" + ") : null;
}

async function resolverEfectorPorCodigos(codigos: string[]): Promise<string | null> {
  const filas = await db
    .select({ efectorNombre: klinicosPracticas.efectorNombre, codigos: klinicosPracticas.codigos })
    .from(klinicosPracticas)
    .where(sql`${klinicosPracticas.efectorNombre} IS NOT NULL`);
  const buscados = new Set(codigos.map((c) => c.trim()));
  for (const f of filas) {
    if (f.codigos?.some((c) => buscados.has(c.trim()))) return f.efectorNombre;
  }
  return null;
}

// Un trabajo con turno solo debe cargarse si el turno sigue vigente: si fue
// cancelado/anulado/borrado mientras el trabajo esperaba en la cola, se
// cancela el trabajo en lugar de cargar un ingreso fantasma en Klinicos.
async function turnoDelTrabajoCancelado(turnoId: number | null): Promise<boolean> {
  if (turnoId == null) return false;
  const [t] = await db
    .select({ estado: turnosTable.estado })
    .from(turnosTable)
    .where(eq(turnosTable.id, turnoId))
    .limit(1);
  return !t || ["cancelado", "anulado", "a_reprogramar"].includes(t.estado);
}

export async function procesarTrabajo(
  trabajoId: number,
  credencial?: CredencialKlinicos,
): Promise<void> {
  const [trabajo] = await db
    .select()
    .from(klinicosTrabajos)
    .where(eq(klinicosTrabajos.id, trabajoId))
    .limit(1);
  if (!trabajo || !["pendiente", "error"].includes(trabajo.estado)) return;

  // Claim atómico: si otro proceso lo tomó o lo cancelaron en el medio, no seguimos.
  const [claimed] = await db
    .update(klinicosTrabajos)
    .set({ estado: "en_proceso", intentos: trabajo.intentos + 1 })
    .where(sql`${klinicosTrabajos.id} = ${trabajo.id} AND ${klinicosTrabajos.estado} IN ('pendiente', 'error')`)
    .returning({ id: klinicosTrabajos.id });
  if (!claimed) return;

  try {
    // Si el turno se canceló entre la reserva y esta corrida (los trabajos de
    // prácticas se encolan al reservar), no hay nada que cargar.
    if (await turnoDelTrabajoCancelado(trabajo.turnoId)) {
      await db
        .update(klinicosTrabajos)
        .set({ estado: "cancelado", ultimoError: "El turno fue cancelado antes de la carga" })
        .where(sql`${klinicosTrabajos.id} = ${trabajo.id} AND ${klinicosTrabajos.estado} = 'en_proceso'`);
      return;
    }
    // Enriquecer una sola vez (si ya fue revisado en la bandeja, respetar).
    // Prioridad: dato revisado > regla fija de equivalencia > IA de respaldo.
    let { consultaPor, cie10Codigo, cie10Descripcion } = trabajo.consultaPor
      ? { consultaPor: trabajo.consultaPor, cie10Codigo: trabajo.cie10Codigo, cie10Descripcion: trabajo.cie10Descripcion }
      : ((await resolverCie10PorRegla(trabajo)) ?? (await enriquecerConIA(trabajo)));

    let practicaCodigos = trabajo.practicaCodigos;
    let efectorNombre = trabajo.efectorNombre;
    let practicaNombre: string | null = null;
    if (!practicaCodigos) {
      const p = await resolverPractica(trabajo);
      practicaCodigos = p.codigos;
      efectorNombre = efectorNombre ?? p.efector;
      practicaNombre = p.practicaNombre;
    }
    // Prácticas tildadas en la agenda: buscar el efector de la planilla por código
    if (!efectorNombre && practicaCodigos?.length) {
      efectorNombre = await resolverEfectorPorCodigos(practicaCodigos);
    }
    // Regla del usuario (01/08/2026): si la planilla trae una dupla de
    // efectores (ecografías → MUÑOZ/VARELA), el robot usa uno solo, rotando.
    // EXCEPCIÓN (lección 03/08/2026): en las prácticas de cardiología el
    // efector/profesional del ingreso es SIEMPRE CÁCERES FRANCO — sin rotar.
    // Si fue fijado a mano en la bandeja con un solo nombre, se respeta.
    const cardio = esPracticaCardio(practicaCodigos);
    if (cardio) {
      const candidatos = (efectorNombre ?? "").split("-").map((s) => s.trim()).filter(Boolean);
      efectorNombre = candidatos.find((c) => normalizar(c).includes("CACERES")) ?? EFECTOR_PRACTICAS_CARDIO;
    } else if (efectorNombre?.includes("-")) {
      efectorNombre = await elegirEfector(efectorNombre);
    }

    // Diagnóstico general de las prácticas cardio: CIE-10 aprobado rotado por
    // trabajo (presurometría SIEMPRE R03.0). Pisa lo derivado por regla/IA,
    // salvo que ya haya sido revisado a mano en la bandeja.
    if (cardio && practicaCodigos?.length && !trabajo.cie10Codigo) {
      const diag = diagnosticoPracticaCardio(practicaCodigos, trabajo.id);
      cie10Codigo = diag.codigo;
      cie10Descripcion = diag.descripcion;
    }

    // "Consulta por" de una práctica = nombre de la práctica ("HOLTER"), no
    // un texto de consulta común. Solo si no fue revisado en la bandeja.
    if (!trabajo.consultaPor && practicaCodigos?.length) {
      const nombrePractica = practicaNombre ?? (await resolverNombrePracticaPorCodigos(practicaCodigos));
      if (nombrePractica) consultaPor = nombrePractica;
    }

    // Agendas de prácticas (ecografías, etc.): el profesional del ingreso es
    // el efector rotado, no el profesional de la agenda de Conectar (el
    // ecografista real no existe en el sector de Klinicos y el ingreso
    // fallaba con "Profesional ... no encontrado"). Se persiste para que la
    // bandeja y la ejecución real usen el mismo nombre. Las consultas de
    // consultorio (sin códigos, fuera de IMAGENES S/C) no se tocan.
    let profesionalIngreso = trabajo.profesionalKlinicos;
    const esTrabajoPracticas =
      trabajo.sectorServicio === "IMAGENES S/C" || Boolean(practicaCodigos?.length);
    if (esTrabajoPracticas && efectorNombre) {
      profesionalIngreso = efectorNombre;
    }

    // Exclusión obligatoria (decisión 22/07/2026): eco Doppler y resonancias
    // se cargan a mano SIEMPRE. Fail-closed: el trabajo se cancela con un
    // mensaje claro antes de tocar Klinicos.
    const motivoExclusion = esPracticaExcluida([trabajo.especialidad, trabajo.motivo, practicaNombre]);
    if (motivoExclusion) {
      await db
        .update(klinicosTrabajos)
        .set({
          estado: "cancelado",
          ultimoError: `Práctica excluida de la automatización (${motivoExclusion}): carga MANUAL en Klinicos por decisión del 22/07/2026`,
        })
        .where(sql`${klinicosTrabajos.id} = ${trabajo.id} AND ${klinicosTrabajos.estado} = 'en_proceso'`);
      logger.info({ trabajoId: trabajo.id, motivoExclusion }, "klinicos-worker: trabajo excluido (carga manual)");
      return;
    }

    // Prescriptor rotativo: aplica a cualquier trabajo con códigos de práctica
    // (imágenes o prácticas tildadas en la agenda, ej. ergometría). Si ya fue
    // fijado desde la bandeja, se respeta.
    let prescriptorNombre = trabajo.prescriptorNombre;
    if (!prescriptorNombre && (trabajo.sectorServicio === "IMAGENES S/C" || practicaCodigos?.length)) {
      prescriptorNombre = await elegirPrescriptor(trabajo.sexo);
    }

    // Matrícula y especialidad del prescriptor (el portal las exige para
    // prescriptor "externo al establecimiento")
    let prescriptorMatricula: string | null = null;
    let prescriptorEspecialidad: string | null = null;
    if (prescriptorNombre) {
      const [pr] = await db
        .select({ matricula: klinicosPrescriptores.matricula, especialidad: klinicosPrescriptores.especialidad })
        .from(klinicosPrescriptores)
        .where(eq(klinicosPrescriptores.nombre, prescriptorNombre))
        .limit(1);
      prescriptorMatricula = pr?.matricula ?? null;
      prescriptorEspecialidad = pr?.especialidad ?? null;
    }

    // Orden médica de respaldo (pedido 01/08/2026): si Conectar ya tiene una
    // orden cargada para el turno/paciente se usa esa; si no, se crea una
    // automáticamente con el prescriptor rotado. Sin orden resoluble NO se
    // frena la carga: queda el faltante anotado para resolverlo a mano.
    let ordenPracticaId = trabajo.ordenPracticaId;
    let ordenNota: string | null = null;
    if (practicaCodigos?.length && !ordenPracticaId) {
      const orden = await resolverOrdenParaTrabajo({ ...trabajo, practicaCodigos, prescriptorNombre, consultaPor, cie10Codigo });
      ordenPracticaId = orden.ordenId;
      ordenNota = orden.ordenId
        ? `orden ${orden.numeroOrden}${orden.creada ? " (creada automáticamente)" : " (ya cargada en Conectar)"}`
        : `sin orden: ${orden.faltante}`;
    }

    await db
      .update(klinicosTrabajos)
      .set({ consultaPor, cie10Codigo, cie10Descripcion, practicaCodigos, efectorNombre, prescriptorNombre, ordenPracticaId, profesionalKlinicos: profesionalIngreso })
      .where(sql`${klinicosTrabajos.id} = ${trabajo.id} AND ${klinicosTrabajos.estado} = 'en_proceso'`);

    // El worker SIEMPRE simula (sin opciones.modoReal): la ejecución real solo
    // corre vía ejecutarTrabajoAprobado tras la confirmación del operador.
    const resultado = await ejecutarIngresoKlinicos(
      {
      dni: trabajo.dni,
      sexo: trabajo.sexo,
      celular: trabajo.celular,
      sectorServicio: trabajo.sectorServicio,
      especialidad: trabajo.especialidad,
      profesionalKlinicos: profesionalIngreso,
      consultaPor,
      practicaCodigos,
      efectorNombre,
      prescriptorNombre,
      prescriptorMatricula,
      prescriptorEspecialidad,
      tokenAutorizacion: trabajo.tokenAutorizacion,
      ordenNota,
      cie10Codigo,
      cie10Descripcion,
      rotacionSemilla: trabajo.id,
      },
      // Guardas anti-duplicado: el intento de POST se persiste ANTES de
      // enviarlo; la confirmación se persiste apenas el portal la acepta.
      // Un reintento con intento previo sin confirmación NO re-postea.
      {
        ingresoYaCreado: trabajo.klinicosIngresoCreado,
        postYaIntentado: trabajo.postIntentadoEn != null && !trabajo.klinicosIngresoCreado,
        marcarPostIntentado: async () => {
          await db
            .update(klinicosTrabajos)
            .set({ postIntentadoEn: new Date() })
            .where(eq(klinicosTrabajos.id, trabajo.id));
        },
        marcarIngresoCreado: async (atencionUrl) => {
          await db
            .update(klinicosTrabajos)
            .set({ klinicosIngresoCreado: true, klinicosAtencionUrl: atencionUrl })
            .where(eq(klinicosTrabajos.id, trabajo.id));
        },
      },
      // Cuenta del pool asignada por el tick (trabajos paralelos no comparten
      // usuario del portal); sin asignar, el login rota solo.
      { credencial },
    );

    // Modo simulación (etapa 3): persistir lo que se HABRÍA enviado, sin
    // confirmar nada en Klinicos. Token siempre enmascarado.
    const simulacionPayload =
      resultado.dryRun && resultado.ok
        ? {
            modo: "simulacion",
            generadoEn: new Date().toISOString(),
            ingreso: resultado.simulacionIngreso ?? null,
            prestacion:
              practicaCodigos?.length
                ? armarPlanPracticaSimulado({
                    practicaCodigos,
                    prescriptorNombre,
                    prescriptorMatricula,
                    prescriptorEspecialidad,
                    efectorNombre,
                    cie10Codigo,
                    cie10Descripcion,
                    tokenAutorizacion: trabajo.tokenAutorizacion,
                  })
                : !/IMAGENES/i.test(trabajo.sectorServicio)
                ? {
                    accion: "verificar_consulta_en_grilla",
                    url: "/ordenPrestacion/porIdAtencionesEstados",
                    nota: "La fila de la CONSULTA (C-…) la crea el PROPIO ingreso ambulatorio (regla 2-ago-2026); el robot solo lee la grilla para confirmar que nació con su casillero de token. NO usa /ordenPrestacion/create.",
                    diagnostico: { codigo: cie10Codigo, descripcion: cie10Descripcion },
                    tokenEnmascarado: enmascararToken(trabajo.tokenAutorizacion),
                  }
                : null,
            adjunto: practicaCodigos?.length
              ? {
                  accion: "adjuntar_documentacion",
                  nota: 'Tras confirmar la prestación se sube el PDF de la orden médica: Acciones → Adjuntar documentación → Documentos múltiples → tipo "Orden de práctica/s" (máx 1.5 MB), descripción "orden medica". La fecha de la orden es 1–7 días ANTES de la carga.',
                  orden: ordenNota,
                }
              : null,
            autorizacion: {
              accion: "autorizar_prestacion",
              regla:
                "exactamente UNA prestación CONFIRMADA sin autorización; cargar token + tilde; releer y exigir N° de bono (0 o >1 candidatas → revisión manual)",
              tokenEnmascarado: enmascararToken(trabajo.tokenAutorizacion),
            },
          }
        : null;

    // Re-chequeo: si el turno se canceló DURANTE la simulación, el trabajo se
    // cancela en vez de quedar esperando aprobación de una carga fantasma.
    const canceladoDurante = resultado.ok && (await turnoDelTrabajoCancelado(trabajo.turnoId));
    await db
      .update(klinicosTrabajos)
      .set({
        // Modo asistido (etapa 4): la simulación exitosa NO cierra el trabajo;
        // queda esperando la aprobación del operador en la bandeja.
        estado: canceladoDurante
          ? "cancelado"
          : resultado.ok
          ? klinicosModo() === "asistido"
            ? "esperando_aprobacion"
            : "completado"
          : trabajo.intentos + 1 >= MAX_INTENTOS
            ? "error"
            : "pendiente",
        pasosCompletados: resultado.pasos.map((p) => `${p.paso}: ${p.detalle}`),
        ...flagsCreacionTrasSimulacion(
          { ingresoCreado: resultado.ingresoCreado, prestacionCreada: resultado.prestacionCreada },
          trabajo,
        ),
        ultimoError: resultado.error ?? null,
        ...(simulacionPayload ? { simulacionPayload, simulacionEn: new Date() } : {}),
      })
      // Solo cerramos el trabajo si sigue "en_proceso": una cancelación
      // concurrente desde la bandeja no debe ser pisada por el worker.
      .where(sql`${klinicosTrabajos.id} = ${trabajo.id} AND ${klinicosTrabajos.estado} = 'en_proceso'`);

    logger.info(
      { trabajoId: trabajo.id, ok: resultado.ok, dryRun: resultado.dryRun },
      "klinicos-worker: trabajo procesado",
    );

    // Informe de facturación automático para prestaciones de imágenes.
    // Best-effort: no afecta el estado del trabajo si la IA falla.
    if (resultado.ok && trabajo.sectorServicio === "IMAGENES S/C" && !trabajo.informeIaTexto) {
      await generarInformeFacturacion(trabajo.id);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await db
      .update(klinicosTrabajos)
      .set({
        estado: trabajo.intentos + 1 >= MAX_INTENTOS ? "error" : "pendiente",
        ultimoError: msg,
      })
      .where(sql`${klinicosTrabajos.id} = ${trabajo.id} AND ${klinicosTrabajos.estado} = 'en_proceso'`);
    logger.error({ err, trabajoId: trabajo.id }, "klinicos-worker: error procesando trabajo");
  }
}

export async function ejecutarTrabajoAprobado(trabajoId: number): Promise<void> {
  const [trabajo] = await db
    .select()
    .from(klinicosTrabajos)
    .where(eq(klinicosTrabajos.id, trabajoId))
    .limit(1);
  if (!trabajo || trabajo.estado !== "en_proceso" || !trabajo.aprobadoEn) return;

  try {
    // El turno pudo cancelarse entre la aprobación del operador y esta
    // ejecución real: jamás cargar un ingreso de un turno cancelado.
    if (await turnoDelTrabajoCancelado(trabajo.turnoId)) {
      await db
        .update(klinicosTrabajos)
        .set({ estado: "cancelado", ultimoError: "El turno fue cancelado antes de la carga real" })
        .where(sql`${klinicosTrabajos.id} = ${trabajo.id} AND ${klinicosTrabajos.estado} = 'en_proceso'`);
      return;
    }
    // Defensa en profundidad: la exclusión se re-verifica también acá.
    const motivoExclusion = esPracticaExcluida([trabajo.especialidad, trabajo.motivo]);
    if (motivoExclusion) {
      await db
        .update(klinicosTrabajos)
        .set({ estado: "cancelado", ultimoError: `Práctica excluida de la automatización (${motivoExclusion}): carga MANUAL` })
        .where(sql`${klinicosTrabajos.id} = ${trabajo.id} AND ${klinicosTrabajos.estado} = 'en_proceso'`);
      return;
    }

    // Los datos ya fueron enriquecidos y revisados en la simulación aprobada.
    let prescriptorMatricula: string | null = null;
    let prescriptorEspecialidad: string | null = null;
    if (trabajo.prescriptorNombre) {
      const [pr] = await db
        .select({ matricula: klinicosPrescriptores.matricula, especialidad: klinicosPrescriptores.especialidad })
        .from(klinicosPrescriptores)
        .where(eq(klinicosPrescriptores.nombre, trabajo.prescriptorNombre))
        .limit(1);
      prescriptorMatricula = pr?.matricula ?? null;
      prescriptorEspecialidad = pr?.especialidad ?? null;
    }

    const resultado = await ejecutarIngresoKlinicos(
      {
        dni: trabajo.dni,
        sexo: trabajo.sexo,
        celular: trabajo.celular,
        sectorServicio: trabajo.sectorServicio,
        especialidad: trabajo.especialidad,
        profesionalKlinicos: trabajo.profesionalKlinicos,
        consultaPor: trabajo.consultaPor ?? trabajo.motivo ?? trabajo.especialidad,
        practicaCodigos: trabajo.practicaCodigos,
        efectorNombre: trabajo.efectorNombre,
        prescriptorNombre: trabajo.prescriptorNombre,
        prescriptorMatricula,
        prescriptorEspecialidad,
        tokenAutorizacion: trabajo.tokenAutorizacion,
        cie10Codigo: trabajo.cie10Codigo,
        cie10Descripcion: trabajo.cie10Descripcion,
        rotacionSemilla: trabajo.id,
      },
      {
        ingresoYaCreado: trabajo.klinicosIngresoCreado,
        postYaIntentado: trabajo.postIntentadoEn != null && !trabajo.klinicosIngresoCreado,
        atencionUrlPrevia: trabajo.klinicosAtencionUrl,
        marcarPostIntentado: async () => {
          await db
            .update(klinicosTrabajos)
            .set({ postIntentadoEn: new Date() })
            .where(eq(klinicosTrabajos.id, trabajo.id));
        },
        marcarIngresoCreado: async (atencionUrl) => {
          await db
            .update(klinicosTrabajos)
            .set({ klinicosIngresoCreado: true, klinicosAtencionUrl: atencionUrl })
            .where(eq(klinicosTrabajos.id, trabajo.id));
        },
        marcarPostRechazado: async () => {
          await db
            .update(klinicosTrabajos)
            .set({ postIntentadoEn: null })
            .where(eq(klinicosTrabajos.id, trabajo.id));
        },
      },
      {
        modoReal: true,
        prestacion: {
          prestacionYaCreada: trabajo.klinicosPrestacionCreada,
          postYaIntentado: trabajo.prestacionPostIntentadoEn != null && !trabajo.klinicosPrestacionCreada,
          marcarPostIntentado: async () => {
            await db
              .update(klinicosTrabajos)
              .set({ prestacionPostIntentadoEn: new Date() })
              .where(eq(klinicosTrabajos.id, trabajo.id));
          },
          marcarPrestacionCreada: async (numero) => {
            await db
              .update(klinicosTrabajos)
              .set({ klinicosPrestacionCreada: true, klinicosPrestacionNumero: numero })
              .where(eq(klinicosTrabajos.id, trabajo.id));
          },
          limpiarPostIntentado: async () => {
            await db
              .update(klinicosTrabajos)
              .set({ prestacionPostIntentadoEn: null })
              .where(eq(klinicosTrabajos.id, trabajo.id));
          },
        },
        // Adjunto de la orden médica (lección 03/08/2026): el PDF de la orden
        // de Conectar se sube a la atención tras confirmar la prestación.
        adjunto: trabajo.ordenPracticaId
          ? {
              obtenerPdf: async () => {
                const { generarPdfOrdenBuffer } = await import("./klinicos-adjuntos");
                return generarPdfOrdenBuffer(trabajo.ordenPracticaId!);
              },
              guardas: {
                yaAdjuntada: trabajo.ordenAdjuntada,
                postYaIntentado: trabajo.ordenAdjuntoIntentadoEn != null && !trabajo.ordenAdjuntada,
                marcarIntentado: async () => {
                  await db
                    .update(klinicosTrabajos)
                    .set({ ordenAdjuntoIntentadoEn: new Date() })
                    .where(eq(klinicosTrabajos.id, trabajo.id));
                },
                marcarAdjuntada: async (detalle) => {
                  await db
                    .update(klinicosTrabajos)
                    .set({ ordenAdjuntada: true, ordenAdjuntoDetalle: detalle })
                    .where(eq(klinicosTrabajos.id, trabajo.id));
                },
                limpiarIntento: async () => {
                  await db
                    .update(klinicosTrabajos)
                    .set({ ordenAdjuntoIntentadoEn: null })
                    .where(eq(klinicosTrabajos.id, trabajo.id));
                },
                // Aviso a la bandeja: el motivo del fallo queda en el trabajo
                // (no solo en logs) para que recepción sepa que debe subir la
                // orden a mano en Klinicos.
                marcarFallo: async (detalle) => {
                  await db
                    .update(klinicosTrabajos)
                    .set({ ordenAdjuntoDetalle: detalle })
                    .where(eq(klinicosTrabajos.id, trabajo.id));
                },
              },
            }
          : undefined,
        autorizacion: {
          postYaIntentado: trabajo.autorizacionPostIntentadoEn != null,
          prestacionNumeroPrevio: trabajo.klinicosPrestacionNumero,
          // CAS: misma guarda atómica que autorizarConsultaConToken — si una
          // validación sincrónica ya está autorizando, el worker NO reenvía.
          marcarPostIntentado: async () => {
            const ganado = await db
              .update(klinicosTrabajos)
              .set({ autorizacionPostIntentadoEn: new Date() })
              .where(
                sql`${klinicosTrabajos.id} = ${trabajo.id} AND ${klinicosTrabajos.autorizacionPostIntentadoEn} IS NULL`,
              )
              .returning({ id: klinicosTrabajos.id });
            if (ganado.length === 0)
              throw new Error("CARRERA_AUTORIZACION: otra validación ya está autorizando este trabajo — no se reenvía el token");
          },
          marcarResultado: async (res, nroBono) => {
            await db
              .update(klinicosTrabajos)
              .set({
                autorizacionResultado: res,
                klinicosNroBono: nroBono,
                // Rechazo EXPLÍCITO del financiador: el resultado se conoce y
                // el token quedó descartado — se libera la guarda para que un
                // token NUEVO pueda enviarse. "incierto" NUNCA la libera.
                ...(res === "rechazado" ? { autorizacionPostIntentadoEn: null } : {}),
              })
              .where(eq(klinicosTrabajos.id, trabajo.id));
          },
        },
      },
    );

    if (resultado.dryRun) {
      // KLINICOS_DRY_RUN volvió a activarse entre la aprobación y la ejecución:
      // no se tocó Klinicos; el trabajo vuelve a esperar aprobación.
      await db
        .update(klinicosTrabajos)
        .set({ estado: "esperando_aprobacion", ultimoError: "KLINICOS_DRY_RUN está activo: la ejecución real quedó bloqueada por el entorno" })
        .where(sql`${klinicosTrabajos.id} = ${trabajo.id} AND ${klinicosTrabajos.estado} = 'en_proceso'`);
      return;
    }

    await db
      .update(klinicosTrabajos)
      .set({
        // La ejecución real NUNCA se reencola sola: fallo → error (manual)
        estado: resultado.ok ? "completado" : "error",
        pasosCompletados: resultado.pasos.map((p) => `${p.paso}: ${p.detalle}`),
        klinicosIngresoCreado: resultado.ingresoCreado || trabajo.klinicosIngresoCreado,
        klinicosPrestacionCreada: resultado.prestacionCreada || trabajo.klinicosPrestacionCreada,
        ultimoError: resultado.error ?? null,
      })
      .where(sql`${klinicosTrabajos.id} = ${trabajo.id} AND ${klinicosTrabajos.estado} = 'en_proceso'`);

    logger.info(
      { trabajoId: trabajo.id, ok: resultado.ok, prestacionNumero: resultado.prestacionNumero, autorizacion: resultado.autorizacionResultado },
      "klinicos-worker: ejecución real aprobada procesada",
    );

    if (resultado.ok && trabajo.sectorServicio === "IMAGENES S/C" && !trabajo.informeIaTexto) {
      await generarInformeFacturacion(trabajo.id);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await db
      .update(klinicosTrabajos)
      .set({ estado: "error", ultimoError: `Ejecución real: ${msg}` })
      .where(sql`${klinicosTrabajos.id} = ${trabajo.id} AND ${klinicosTrabajos.estado} = 'en_proceso'`);
    logger.error({ err, trabajoId: trabajo.id }, "klinicos-worker: error en ejecución real aprobada");
  }
}
// ── Anulación automática de prestaciones ────────────────────────────────────
// Un trabajo pasa a "anulacion_pendiente" cuando el paciente cancela un turno
// cuya prestación YA fue cargada en Klinicos (estado 'completado' con
// klinicosAtencionUrl + klinicosPrestacionNumero). Fail-closed: cualquier
// duda deja el trabajo en "error" con la indicación de anular a mano; NUNCA
// se reintenta en loop.
const MOTIVO_ANULACION = "Turno cancelado por el paciente antes de la consulta (Conectar)";

async function procesarAnulacionTrabajo(trabajoId: number, cred: CredencialKlinicos): Promise<void> {
  const [trabajo] = await db.select().from(klinicosTrabajos).where(eq(klinicosTrabajos.id, trabajoId)).limit(1);
  if (!trabajo || trabajo.estado !== "anulacion_pendiente") return;

  // Guard atómico: un solo worker toma la anulación.
  const tomado = await db
    .update(klinicosTrabajos)
    .set({ estado: "en_proceso" })
    .where(sql`${klinicosTrabajos.id} = ${trabajo.id} AND ${klinicosTrabajos.estado} = 'anulacion_pendiente'`)
    .returning({ id: klinicosTrabajos.id });
  if (tomado.length === 0) return;

  const fallar = async (detalle: string) => {
    await db
      .update(klinicosTrabajos)
      .set({ estado: "error", ultimoError: `Anulación automática: ${detalle} — anular a mano en Klinicos (§2.4.1)` })
      .where(sql`${klinicosTrabajos.id} = ${trabajo.id} AND ${klinicosTrabajos.estado} = 'en_proceso'`);
  };

  try {
    if (klinicosDryRun()) {
      // Sin loop: queda visible en la bandeja como error accionable.
      await fallar("KLINICOS_DRY_RUN activo, no se tocó el portal");
      return;
    }
    const atencionGuid = trabajo.klinicosAtencionUrl ? extraerAtencionId(trabajo.klinicosAtencionUrl) : null;
    if (!atencionGuid || !trabajo.klinicosPrestacionNumero) {
      await fallar("faltan datos de la atención o el número de prestación");
      return;
    }

    const jar = new CookieJar();
    await loginKlinicos(jar, cred);
    await seleccionarContextoKlinicos(jar);
    const res = await anularPrestacionReal(jar, atencionGuid, trabajo.klinicosPrestacionNumero, MOTIVO_ANULACION);
    if (!res.ok) {
      await fallar(res.detalle);
      return;
    }
    await db
      .update(klinicosTrabajos)
      .set({
        estado: "anulado",
        pasosCompletados: [
          ...(trabajo.pasosCompletados ?? []),
          `anulacion: ${res.yaAnulada ? "ya estaba anulada" : "prestación anulada en Klinicos"} (${res.detalle})`,
        ],
        ultimoError: null,
      })
      .where(sql`${klinicosTrabajos.id} = ${trabajo.id} AND ${klinicosTrabajos.estado} = 'en_proceso'`);
    logger.info({ trabajoId: trabajo.id, yaAnulada: res.yaAnulada }, "klinicos-worker: prestación anulada");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await fallar(msg);
    logger.error({ err, trabajoId: trabajo.id }, "klinicos-worker: error anulando prestación");
  }
}

async function tick(): Promise<void> {
  if (corriendo) return;
  if (!klinicosHabilitado()) return; // sin credenciales, la cola espera
  corriendo = true;
  try {
    const pendientes = await db
      .select({ id: klinicosTrabajos.id })
      .from(klinicosTrabajos)
      .where(sql`${klinicosTrabajos.estado} = 'pendiente' AND ${klinicosTrabajos.intentos} < ${MAX_INTENTOS}`)
      .orderBy(asc(klinicosTrabajos.creadoEn))
      .limit(5);
    // Más sesiones = más velocidad (ago 2026): con varias cuentas de Klinicos
    // configuradas (KLINICOS_USUARIO_2/_3) se procesan trabajos en paralelo,
    // uno por cuenta; los logins rotan de cuenta para no pisarse la sesión.
    const creds = credencialesKlinicos();
    const paralelo = Math.max(1, creds.length);
    for (let i = 0; i < pendientes.length; i += paralelo) {
      // Cuenta fija por posición en la tanda: dos trabajos simultáneos nunca
      // comparten usuario del portal. allSettled: un trabajo que falla no
      // corta las tandas siguientes.
      const resultados = await Promise.allSettled(
        pendientes.slice(i, i + paralelo).map((p, k) => procesarTrabajo(p.id, creds[k % paralelo])),
      );
      for (const r of resultados) {
        if (r.status === "rejected") logger.error({ err: r.reason }, "klinicos-worker: trabajo falló en tanda paralela");
      }
    }

    // Anulaciones pendientes (cancelaciones de turnos ya cargados): se
    // procesan de a una por ciclo, después de las cargas.
    const anulaciones = await db
      .select({ id: klinicosTrabajos.id })
      .from(klinicosTrabajos)
      .where(sql`${klinicosTrabajos.estado} = 'anulacion_pendiente'`)
      .orderBy(asc(klinicosTrabajos.creadoEn))
      .limit(3);
    for (const a of anulaciones) {
      await procesarAnulacionTrabajo(a.id, creds[0]).catch((err) =>
        logger.error({ err, trabajoId: a.id }, "klinicos-worker: anulación falló"),
      );
    }
  } catch (err) {
    logger.error({ err }, "klinicos-worker: error en tick");
  } finally {
    corriendo = false;
  }
}

export async function releerBonoConsulta(turnoId: number): Promise<string | null> {
  if (!klinicosHabilitado()) return null;
  try {
    const [trabajo] = await db
      .select()
      .from(klinicosTrabajos)
      .where(sql`${klinicosTrabajos.turnoId} = ${turnoId} AND ${klinicosTrabajos.klinicosIngresoCreado} = true AND ${klinicosTrabajos.klinicosAtencionUrl} IS NOT NULL`)
      .orderBy(sql`${klinicosTrabajos.id} DESC`)
      .limit(1);
    if (!trabajo?.klinicosAtencionUrl) return null;
    if (trabajo.klinicosNroBono) return trabajo.klinicosNroBono;
    const atencionId = extraerAtencionId(trabajo.klinicosAtencionUrl);
    if (!atencionId) return null;

    const jar = new CookieJar();
    const login = await loginKlinicos(jar);
    if (!login.ok) return null;
    const ctx = await seleccionarContextoKlinicos(jar);
    if (!ctx.ok) return null;
    const grilla = await leerFilasPrestacionesAjax(jar, atencionId);
    if (!grilla.ok || grilla.filas.length === 0) return null;

    // Objetivo conocido primero; sin objetivo, solo una ÚNICA fila de
    // consulta con bono es inequívoca (nunca se adivina entre varias).
    const objetivo = trabajo.klinicosPrestacionNumero
      ? grilla.filas.find((f) => f.numero === trabajo.klinicosPrestacionNumero)
      : null;
    let bono = objetivo?.nroBono ?? null;
    if (!bono && !trabajo.klinicosPrestacionNumero) {
      const conBono = grilla.filas.filter((f) => f.tipo === "C" && f.nroBono);
      if (conBono.length === 1) bono = conBono[0]!.nroBono;
    }
    if (bono) {
      await db
        .update(klinicosTrabajos)
        .set({ klinicosNroBono: bono, autorizacionResultado: "aceptado" })
        .where(eq(klinicosTrabajos.id, trabajo.id));
    }
    return bono;
  } catch (err) {
    logger.warn({ err, turnoId }, "klinicos-worker: relectura de bono falló");
    return null;
  }
}
export async function autorizarConsultaConToken(
  turnoId: number,
  token: string,
): Promise<{ nroBono: string | null; resultado: "aceptado" | "rechazado" | "incierto" | null; detalle: string }> {
  if (!klinicosHabilitado()) return { nroBono: null, resultado: null, detalle: "Klinicos no configurado" };
  try {
    let [trabajo] = await db
      .select()
      .from(klinicosTrabajos)
      .where(sql`${klinicosTrabajos.turnoId} = ${turnoId} AND ${klinicosTrabajos.klinicosIngresoCreado} = true`)
      .orderBy(sql`${klinicosTrabajos.id} DESC`)
      .limit(1);
    if (!trabajo?.klinicosAtencionUrl) {
      // Fallback: recepción puede haber creado un turno nuevo (ej. guardia)
      // distinto del turno donde el robot dejó el ingreso. Se busca la última
      // atención creada para el MISMO paciente en las últimas 24 h sin bono
      // (no por fecha exacta: una guardia puede cruzar la medianoche).
      const [turno] = await db
        .select({ pacienteId: turnosTable.pacienteId })
        .from(turnosTable)
        .where(eq(turnosTable.id, turnoId))
        .limit(1);
      if (turno) {
        const candidatos = await db
          .select({ trabajo: klinicosTrabajos })
          .from(klinicosTrabajos)
          .innerJoin(turnosTable, eq(klinicosTrabajos.turnoId, turnosTable.id))
          .where(
            sql`${klinicosTrabajos.pacienteId} = ${turno.pacienteId}
              AND ${klinicosTrabajos.klinicosIngresoCreado} = true
              AND ${klinicosTrabajos.klinicosAtencionUrl} IS NOT NULL
              AND ${klinicosTrabajos.klinicosNroBono} IS NULL
              AND ${klinicosTrabajos.actualizadoEn} > now() - interval '24 hours'
              AND ${turnosTable.estado} NOT IN ('cancelado', 'anulado')`,
          )
          .orderBy(sql`${klinicosTrabajos.id} DESC`)
          .limit(2);
        if (candidatos.length > 1) {
          // Más de una atención del mismo paciente sin bono: no se adivina a
          // cuál corresponde el token (mandarlo a la equivocada lo quema).
          // Pedido Federico 02/08/2026: en vez de frenar, se devuelve el
          // sentinel de "sin atención" para que el circuito automático cree
          // SU PROPIA atención para este turno y autorice esa, ignorando las
          // viejas sin bono.
          logger.info(
            { turnoId, candidatos: candidatos.map((c) => c.trabajo.id) },
            "klinicos-worker: varias atenciones sin bono del paciente — se crea una atención propia para este turno",
          );
        } else {
          trabajo = candidatos[0]?.trabajo;
        }
      }
    }
    if (!trabajo?.klinicosAtencionUrl)
      return { nroBono: null, resultado: null, detalle: "Sin atención creada por el robot para este turno" };
    if (trabajo.klinicosNroBono)
      return { nroBono: trabajo.klinicosNroBono, resultado: "aceptado", detalle: "Prestación ya autorizada" };
    const atencionId = extraerAtencionId(trabajo.klinicosAtencionUrl);
    if (!atencionId) return { nroBono: null, resultado: null, detalle: "URL de atención sin id reconocible" };

    const jar = new CookieJar();
    const login = await loginKlinicos(jar);
    if (!login.ok) return { nroBono: null, resultado: null, detalle: `Login Klinicos falló: ${login.detalle}` };
    const ctx = await seleccionarContextoKlinicos(jar);
    if (!ctx.ok) return { nroBono: null, resultado: null, detalle: `Contexto Klinicos falló: ${ctx.detalle}` };

    // Atención "muerta" (2-ago-2026): si TODAS las filas de la atención están
    // ANULADAS (el usuario las anuló a mano), no sirve para autorizar nada.
    // Se devuelve el sentinel de "sin atención" para que el circuito
    // automático cree un ingreso nuevo desde cero.
    const filasAten = await leerFilasPrestacionesAjax(jar, atencionId);
    if (filasAten.ok && filasAten.filas.length > 0 && filasAten.filas.every((f) => /ANULAD/i.test(f.estado))) {
      logger.info(
        { trabajoId: trabajo.id, filas: filasAten.filas.map((f) => `${f.numero} ${f.estado}`) },
        "klinicos-worker: atención con todas las filas anuladas — se ignora y se deja crear un ingreso nuevo",
      );
      return { nroBono: null, resultado: null, detalle: "Sin atención creada por el robot para este turno" };
    }

    // Auto-reparación (task ago 2026): en CONSULTORIOS el ingreso NO crea la
    // prestación de consulta solo. Si este trabajo es una consulta y la
    // prestación no quedó cargada, el robot la crea acá ANTES de autorizar
    // (si no, la autorización muere con "grilla vacía — revisión manual").
    let prestacionNumero = trabajo.klinicosPrestacionNumero;
    // Regla Federico 02/08/2026: el token IOMA cobra SOLO la consulta (420101).
    // Por eso alcanza con que la atención sea de CONSULTORIOS: aunque el
    // trabajo tenga códigos de práctica (ej. Holter en consultorio), lo que se
    // autoriza con el token es la consulta; las prácticas van por su circuito.
    const esConsulta = !/IMAGENES/i.test(trabajo.sectorServicio);
    // También se relee la grilla cuando la prestación figura creada pero sin
    // número persistido: sin objetivo, la relectura no puede reconocer una
    // prestación ya autorizada (FACTURABLE con bono) y caería a revisión manual.
    if (esConsulta && (!trabajo.klinicosPrestacionCreada || !prestacionNumero)) {
      // Anti-duplicado: si la grilla YA tiene una prestación (cargada a mano o
      // por un intento previo), NO se crea otra — solo se marca el trabajo.
      const grilla = await leerGrillaPrestaciones(jar, atencionId);
      if (grilla.ok && grilla.total > 0) {
        const numero = grilla.numeros.find((n) => n.startsWith("C-")) ?? grilla.numeros[0] ?? null;
        prestacionNumero = numero ?? prestacionNumero;
        await db
          .update(klinicosTrabajos)
          .set({ klinicosPrestacionCreada: true, ...(numero ? { klinicosPrestacionNumero: numero } : {}) })
          .where(eq(klinicosTrabajos.id, trabajo.id));
      } else {
        // Regla 2-ago-2026: la fila de la consulta la crea el PROPIO ingreso
        // ambulatorio; el circuito "Nueva Prestación" (/ordenPrestacion/create)
        // está PROHIBIDO por el usuario. Grilla vacía = la fila no nació
        // (causa típica: atención previa con el mismo médico) → fail-closed.
        const msg =
          "La atención está en Klinicos pero SIN la fila de la consulta (el ingreso no la generó — causa típica: el paciente ya tenía una atención con ese mismo médico). Revisar y resolver a mano en Klinicos, no se crea nada automáticamente";
        await db
          .update(klinicosTrabajos)
          .set({ ultimoError: msg, estado: sql`CASE WHEN ${klinicosTrabajos.estado} = 'completado' THEN 'error' ELSE ${klinicosTrabajos.estado} END` })
          .where(eq(klinicosTrabajos.id, trabajo.id));
        return { nroBono: null, resultado: null, detalle: msg };
      }
    }

    const aut = await autorizarPrestacionReal(
      jar,
      atencionId,
      token,
      {
        postYaIntentado: trabajo.autorizacionPostIntentadoEn != null,
        prestacionNumeroPrevio: prestacionNumero,
        // Guarda ATÓMICA (compare-and-set): si dos validaciones concurrentes
        // llegan acá, solo una gana el derecho a POSTear; la perdedora aborta
        // ANTES de consumir el token (el throw corta autorizarPrestacionReal).
        marcarPostIntentado: async () => {
          const ganado = await db
            .update(klinicosTrabajos)
            .set({ autorizacionPostIntentadoEn: new Date() })
            .where(
              sql`${klinicosTrabajos.id} = ${trabajo.id} AND ${klinicosTrabajos.autorizacionPostIntentadoEn} IS NULL`,
            )
            .returning({ id: klinicosTrabajos.id });
          if (ganado.length === 0)
            throw new Error("CARRERA_AUTORIZACION: otra validación ya está autorizando este trabajo — no se reenvía el token");
        },
        marcarResultado: async (res, nroBono) => {
          await db
            .update(klinicosTrabajos)
            .set({
              autorizacionResultado: res,
              klinicosNroBono: nroBono,
              // Rechazo EXPLÍCITO: resultado conocido, token descartado — se
              // libera la guarda para que un token NUEVO pueda enviarse.
              // "incierto" NUNCA la libera (riesgo de doble consumo).
              ...(res === "rechazado" ? { autorizacionPostIntentadoEn: null } : {}),
            })
            .where(eq(klinicosTrabajos.id, trabajo.id));
        },
      },
      prestacionNumero,
    );
    return { nroBono: aut.nroBono, resultado: aut.resultado, detalle: aut.detalle };
  } catch (err) {
    logger.error({ err, turnoId }, "klinicos-worker: error autorizando tras validación de token");
    return { nroBono: null, resultado: null, detalle: err instanceof Error ? err.message : String(err) };
  }
}

export function iniciarKlinicosWorker(): void {
  if (!klinicosHabilitado()) {
    logger.info("klinicos-worker: deshabilitado (faltan KLINICOS_USUARIO / KLINICOS_PASSWORD)");
    return;
  }
  logger.info({ dryRun: klinicosDryRun() }, "klinicos-worker: iniciado");
  const timer = setInterval(tick, INTERVALO_MS);
  timer.unref();
  void tick();
}
