import { Router } from "express";
import multer from "multer";
import { parse as csvParse } from "csv-parse/sync";
import * as XLSX from "xlsx";
import { eq, desc, and, sql, isNull } from "drizzle-orm";
import {
  db,
  jobImportacionesTable,
  importacionAuditoriaTable,
  pacientesTable,
  profesionalesTable,
  especialidadesTable,
  sedesTable,
  evolucionesTable,
  diagnosticosTable,
  recetasTable,
  adjuntosTable,
} from "@workspace/db";
import { logger } from "../lib/logger";
import { requireRol } from "./auth";

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 250 * 1024 * 1024 } });

// Endpoints de importación: solo staff (crean pacientes, evoluciones y diagnósticos,
// y aceptan uploads grandes → riesgo de DoS si quedan públicos).
router.use("/importacion", requireRol("admin", "recepcionista"));

// Lotes de procesamiento para importaciones grandes (background, resumible)
const CHUNK_SIZE = 250;
// Guard anti-reentrada por proceso: un job no se procesa dos veces en paralelo
const jobsEnEjecucion = new Set<number>();

type AnyRecord = Record<string, unknown>;

// ── Definición de campos por entidad ──────────────────────────────────────

export const CAMPOS_POR_ENTIDAD: Record<string, {
  label: string;
  campos: { key: string; label: string; requerido?: boolean; descripcion?: string }[];
  claveDedup: string;
}> = {
  pacientes: {
    label: "Pacientes",
    claveDedup: "dni",
    campos: [
      { key: "nombre", label: "Nombre", requerido: true },
      { key: "apellido", label: "Apellido", requerido: true },
      { key: "dni", label: "DNI", descripcion: "Clave de deduplicación" },
      { key: "email", label: "Email" },
      { key: "telefono", label: "Teléfono" },
      { key: "fechaNacimiento", label: "Fecha de nacimiento", descripcion: "YYYY-MM-DD" },
      { key: "sexo", label: "Sexo", descripcion: "M / F / X" },
      { key: "cobertura", label: "Cobertura / Obra social" },
      { key: "nroAfiliado", label: "Nro. afiliado" },
      { key: "direccion", label: "Dirección" },
      { key: "observaciones", label: "Observaciones" },
    ],
  },
  profesionales: {
    label: "Profesionales",
    claveDedup: "matricula",
    campos: [
      { key: "nombre", label: "Nombre", requerido: true },
      { key: "apellido", label: "Apellido" },
      { key: "matricula", label: "Matrícula", descripcion: "Clave de deduplicación" },
      { key: "email", label: "Email" },
      { key: "telefono", label: "Teléfono" },
      { key: "especialidad", label: "Especialidad (nombre)" },
    ],
  },
  evoluciones: {
    label: "Historia Clínica (evoluciones)",
    claveDedup: "pacienteDni",
    campos: [
      { key: "pacienteDni", label: "DNI del paciente", requerido: true },
      { key: "fecha", label: "Fecha", requerido: true, descripcion: "YYYY-MM-DD" },
      { key: "texto", label: "Texto / Nota clínica", requerido: true },
      { key: "motivoConsulta", label: "Motivo de consulta" },
      { key: "exploracion", label: "Exploración física" },
      { key: "plan", label: "Plan / Indicaciones" },
      { key: "profesionalMatricula", label: "Matrícula del profesional" },
    ],
  },
  diagnosticos: {
    label: "Diagnósticos",
    claveDedup: "pacienteDni",
    campos: [
      { key: "pacienteDni", label: "DNI del paciente", requerido: true },
      { key: "descripcion", label: "Descripción", requerido: true },
      { key: "cie10", label: "Código CIE-10" },
      { key: "tipo", label: "Tipo", descripcion: "presuntivo / definitivo" },
      { key: "profesionalMatricula", label: "Matrícula del profesional" },
    ],
  },
  medicacion: {
    label: "Medicación / Recetas",
    claveDedup: "pacienteDni",
    campos: [
      { key: "pacienteDni", label: "DNI del paciente", requerido: true },
      { key: "medicamentos", label: "Medicamentos", requerido: true },
      { key: "indicaciones", label: "Indicaciones / Posología" },
      { key: "diagnostico", label: "Diagnóstico asociado" },
      { key: "vigencia", label: "Vigencia" },
      { key: "profesionalMatricula", label: "Matrícula del profesional" },
    ],
  },
  adjuntos: {
    label: "Estudios / Adjuntos",
    claveDedup: "pacienteDni",
    campos: [
      { key: "pacienteDni", label: "DNI del paciente", requerido: true },
      { key: "nombre", label: "Nombre del estudio", requerido: true },
      { key: "tipo", label: "Tipo", descripcion: "laboratorio / imagen / informe / otro" },
      { key: "descripcion", label: "Descripción" },
      { key: "url", label: "URL del archivo" },
      { key: "fuente", label: "Fuente / Sistema de origen" },
    ],
  },
  turnos_hc: {
    label: "Export completo HIS (turnos + HC)",
    claveDedup: "dni",
    campos: [
      { key: "apellido", label: "Apellido del paciente", requerido: true },
      { key: "nombre", label: "Nombre del paciente", requerido: true },
      { key: "dni", label: "DNI", requerido: true, descripcion: "Clave de deduplicación del paciente" },
      { key: "fechaNacimiento", label: "Fecha de nacimiento", descripcion: "acepta DD-MM-YYYY o YYYY-MM-DD" },
      { key: "telefono", label: "Teléfono" },
      { key: "direccion", label: "Dirección" },
      { key: "ciudad", label: "Ciudad / Localidad" },
      { key: "obraSocial", label: "Obra social / Cobertura" },
      { key: "nroAfiliado", label: "Nro. de afiliado" },
      { key: "planCobertura", label: "Plan de cobertura" },
      { key: "nroCita", label: "Nro. de cita / turno (externo)" },
      { key: "fechaTurno", label: "Fecha del turno" },
      { key: "horaTurno", label: "Hora del turno" },
      { key: "estadoTurno", label: "Estado del turno" },
      { key: "profesional", label: "Profesional (nombre)" },
      { key: "especialidad", label: "Especialidad" },
      { key: "institucion", label: "Institución / Sede" },
      { key: "consulta", label: "Tipo de consulta", descripcion: "1° vez / control" },
      { key: "motivo", label: "Nota clínica / Motivo", descripcion: "Texto libre de la evolución" },
      { key: "diagnostico", label: "Diagnóstico principal" },
      { key: "cie10", label: "Código CIE-10" },
      { key: "observacion", label: "Observación" },
      { key: "pesoKg", label: "Peso (Kg)", descripcion: "Signo vital" },
      { key: "tallaCm", label: "Talla (Cm)", descripcion: "Signo vital" },
      { key: "taMin", label: "T.A. Mínima", descripcion: "Signo vital" },
      { key: "taMax", label: "T.A. Máxima", descripcion: "Signo vital" },
    ],
  },
};

// ── Perfiles canónicos de importación ─────────────────────────────────────
// Un perfil canónico es un mapeo hardcodeado para un formato de export
// específico de un HIS conocido. Cuando las columnas del archivo coinciden
// con la firma del perfil, el mapeo se aplica automáticamente sin que el
// usuario tenga que ajustar nada.

type PerfilImportacion = {
  id: string;
  label: string;
  sistema: string;
  descripcion: string;
  firma: string[]; // columnas que identifican unívocamente este formato
  entidad: string; // entidad que aplica por defecto
  mapeo: Record<string, string>; // columna original → campo destino
};

export const PERFILES_CANONICOS: PerfilImportacion[] = [
  {
    id: "his_turnos_diagnosticos_v1",
    label: "Turnos con diagnósticos",
    sistema: "HIS legacy (HTML-XLS)",
    descripcion: "Export de turnos realizados con nota clínica, diagnóstico CIE-10 y signos vitales. Genera pacientes, evoluciones y diagnósticos.",
    firma: ["Apellido/s", "DNI", "Fecha Turno", "Motivo", "CIE10"],
    entidad: "turnos_hc",
    mapeo: {
      "Apellido/s":      "apellido",
      "Nombre/s":        "nombre",
      "DNI":             "dni",
      "F.Nacimiento":    "fechaNacimiento",
      "Telefono":        "telefono",
      "Direccion":       "direccion",
      "Ciudad":          "ciudad",
      "Obra Social":     "obraSocial",
      "Nro. de afiliado": "nroAfiliado",
      "Plan":            "planCobertura",
      "# Cita":          "nroCita",
      "Fecha Turno":     "fechaTurno",
      "Hora Turno":      "horaTurno",
      "Estado":          "estadoTurno",
      "Personal":        "profesional",
      "Especialidad":    "especialidad",
      "Institucion":     "institucion",
      "Consulta":        "consulta",
      "Motivo":          "motivo",
      "Diagnostico":     "diagnostico",
      "CIE10":           "cie10",
      "Observacion":     "observacion",
      "Peso (Kg)":       "pesoKg",
      "Talla (Cm)":      "tallaCm",
      "T.A Mín":         "taMin",
      "T.A Máx":         "taMax",
    },
  },
];

/**
 * Intenta detectar si las columnas del archivo coinciden con un perfil canónico.
 * Devuelve el perfil si al menos el 80% de la firma está presente.
 */
function detectarPerfil(columnas: string[]): PerfilImportacion | null {
  const colSet = new Set(columnas);
  for (const perfil of PERFILES_CANONICOS) {
    const matches = perfil.firma.filter((f) => colSet.has(f)).length;
    if (matches / perfil.firma.length >= 0.8) return perfil;
  }
  return null;
}

// ── Utilidades de parseo ──────────────────────────────────────────────────

/**
 * Mapeo automático de columnas a campos destino.
 * Usa solo coincidencias EXACTAS entre la columna normalizada y los alias conocidos.
 * No usa substring-includes para evitar falsos positivos (ej: "ci" dentro de "nacimiento").
 * Un mismo campo puede recibir múltiples columnas (ej: varios "Diagnostico" duplicados
 * van al mismo campo — se prefiere el primero; los demás quedan sin mapear).
 */
function autoMapColumns(
  columnas: string[],
  camposTarget: { key: string; label: string }[]
): Record<string, string> {
  const ALIASES: Record<string, string[]> = {
    nombre:          ["nombre", "nombres", "name", "firstname", "primernombre"],
    apellido:        ["apellido", "apellidos", "lastname", "surname"],
    dni:             ["dni", "documento", "nrodocumento", "ndocumento", "numerodocumento"],
    email:           ["email", "correo", "mail"],
    telefono:        ["telefono", "telefono1", "celular", "phone", "tel", "movil"],
    fechaNacimiento: ["fechanacimiento", "fnacimiento", "fecnac", "birthdate", "dob", "nacimiento"],
    sexo:            ["sexo", "genero", "gender", "sex"],
    cobertura:       ["cobertura", "obrasocial"],
    nroAfiliado:     ["nroafiliado", "afiliado", "numafiliado", "nrocarnet", "nrodeafiliado", "numerodeafiliado"],
    matricula:       ["matricula", "nromatricula"],
    texto:           ["texto", "nota", "notas", "text"],
    motivoConsulta:  ["motivoconsulta"],
    pacienteDni:     ["pacientedni", "dnipaciente"],
    descripcion:     ["descripcion", "description", "detalle"],
    cie10:           ["cie10", "icd10", "codigocie"],
    medicamentos:    ["medicamentos", "medicamento"],
    obraSocial:      ["obrasocial", "oss", "prepaga"],
    planCobertura:   ["plancobertura", "plan"],
    nroCita:         ["nrocita", "cita", "idturno", "numerocita"],
    fechaTurno:      ["fechaturno", "fechacita", "fechaatencion"],
    horaTurno:       ["horaturno", "hora", "horacita", "horaturno"],
    estadoTurno:     ["estadoturno", "estado"],
    profesional:     ["personal", "profesional", "medico", "doctor", "prestador"],
    especialidad:    ["especialidad", "servicio", "specialty"],
    institucion:     ["institucion", "sede", "sucursal"],
    consulta:        ["consulta", "tipoconsulta"],
    motivo:          ["motivo", "notaclinica", "anamnesis"],
    diagnostico:     ["diagnostico", "diagnosis", "dx"],
    observacion:     ["observacion", "observaciones"],
    pesoKg:          ["pesokg", "peso"],
    tallaCm:         ["tallacm", "talla"],
    taMin:           ["tamin", "tensionmin", "presionmin"],
    taMax:           ["tamax", "tensionmax", "presionmax"],
  };

  const mapeo: Record<string, string> = {};
  for (const col of columnas) {
    const colNorm = col.toLowerCase().replace(/[^a-z0-9]/g, "");
    for (const campo of camposTarget) {
      const keyAliases = ALIASES[campo.key] ?? [campo.key.toLowerCase().replace(/[^a-z0-9]/g, "")];
      if (keyAliases.includes(colNorm)) {
        mapeo[col] = campo.key;
        break;
      }
    }
  }
  return mapeo;
}

function decodeHtmlText(s: string): string {
  return s
    .replace(/<[^>]+>/g, "")
    .replace(/&Ntilde;/g, "Ñ").replace(/&ntilde;/g, "ñ")
    .replace(/&Aacute;/g, "Á").replace(/&aacute;/g, "á")
    .replace(/&Eacute;/g, "É").replace(/&eacute;/g, "é")
    .replace(/&Iacute;/g, "Í").replace(/&iacute;/g, "í")
    .replace(/&Oacute;/g, "Ó").replace(/&oacute;/g, "ó")
    .replace(/&Uacute;/g, "Ú").replace(/&uacute;/g, "ú")
    .replace(/&Uuml;/g, "Ü").replace(/&uuml;/g, "ü")
    .replace(/&deg;/g, "°").replace(/&ordm;/g, "º").replace(/&ordf;/g, "ª")
    .replace(/&nbsp;/g, " ").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCharCode(Number(code)))
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Parser rápido para archivos .xls que en realidad son tablas HTML
 * (formato de export típico de sistemas legacy — SheetJS es demasiado lento
 * para estos archivos). Detecta la fila de encabezados, salta filas de título
 * y renombra columnas duplicadas.
 */
function parseHtmlTable(html: string): AnyRecord[] {
  const trRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  const tdRe = /<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi;

  const rawRows: string[][] = [];
  let trMatch: RegExpExecArray | null;
  while ((trMatch = trRe.exec(html)) !== null) {
    const cells: string[] = [];
    tdRe.lastIndex = 0;
    let tdMatch: RegExpExecArray | null;
    while ((tdMatch = tdRe.exec(trMatch[1])) !== null) {
      cells.push(decodeHtmlText(tdMatch[1]));
    }
    if (cells.length > 0) rawRows.push(cells);
  }

  if (rawRows.length === 0) return [];

  // Fila de encabezados: la primera entre las primeras 10 con al menos 3 celdas no vacías
  let headerIdx = 0;
  let maxCells = 0;
  for (let i = 0; i < Math.min(10, rawRows.length); i++) {
    const nonEmpty = rawRows[i].filter((c) => c !== "").length;
    if (nonEmpty > maxCells) {
      maxCells = nonEmpty;
      headerIdx = i;
    }
    if (nonEmpty >= 3) { headerIdx = i; break; }
  }

  // Renombrar encabezados duplicados: "Diagnostico", "Diagnostico (2)", ...
  const seen = new Map<string, number>();
  const headers = rawRows[headerIdx].map((h, i) => {
    const base = h || `Columna ${i + 1}`;
    const count = (seen.get(base) ?? 0) + 1;
    seen.set(base, count);
    return count > 1 ? `${base} (${count})` : base;
  });

  const rows: AnyRecord[] = [];
  for (let i = headerIdx + 1; i < rawRows.length; i++) {
    const cells = rawRows[i];
    if (cells.every((c) => c === "")) continue;
    const rec: AnyRecord = {};
    for (let j = 0; j < headers.length; j++) {
      rec[headers[j]] = cells[j] ?? "";
    }
    rows.push(rec);
  }
  return rows;
}

function looksLikeHtml(buffer: Buffer): boolean {
  const head = buffer.subarray(0, 2048).toString("utf-8").toLowerCase();
  return head.includes("<table") || head.includes("<html") || head.includes("<tr");
}

function parseFileToRows(buffer: Buffer, mimetype: string, originalname: string): AnyRecord[] {
  const ext = originalname.split(".").pop()?.toLowerCase() ?? "";

  if (ext === "json" || mimetype === "application/json") {
    const text = buffer.toString("utf-8");
    const parsed = JSON.parse(text) as unknown;
    return Array.isArray(parsed) ? (parsed as AnyRecord[]) : [];
  }

  if (ext === "csv" || mimetype === "text/csv" || mimetype === "text/plain") {
    const rows = csvParse(buffer, {
      columns: true,
      skip_empty_lines: true,
      trim: true,
      bom: true,
    }) as AnyRecord[];
    return rows;
  }

  if (ext === "html" || ext === "htm" || looksLikeHtml(buffer)) {
    // Exportes "falso Excel": .xls que en realidad es una tabla HTML
    return parseHtmlTable(buffer.toString("utf-8"));
  }

  if (ext === "xlsx" || ext === "xls" || mimetype.includes("spreadsheet")) {
    const wb = XLSX.read(buffer, { type: "buffer" });
    const sheetName = wb.SheetNames[0];
    const ws = wb.Sheets[sheetName];
    return XLSX.utils.sheet_to_json<AnyRecord>(ws, { defval: "" });
  }

  throw new Error(`Formato no soportado: ${ext || mimetype}`);
}

/** Normaliza fechas DD-MM-YYYY o DD/MM/YYYY a YYYY-MM-DD */
function normalizarFecha(v: string | undefined): string | undefined {
  if (!v) return undefined;
  const s = v.trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.substring(0, 10);
  const m = s.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/);
  if (m) return `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  return s;
}

/**
 * Normaliza y valida una fecha de nacimiento. Descarta valores no parseables,
 * fechas futuras y años implausibles (< 1900). Los exports legacy traen fechas
 * inválidas/placeholder; preferimos guardar NULL antes que una edad errónea.
 */
function normalizarFechaNacimiento(v: string | undefined): string | undefined {
  const f = normalizarFecha(v);
  if (!f) return undefined;
  const m = f.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return undefined;
  const year = Number(m[1]);
  const hoyIso = new Date().toISOString().substring(0, 10);
  const anioActual = Number(hoyIso.substring(0, 4));
  if (year < 1900 || year > anioActual) return undefined;
  // Fecha futura → placeholder inválido
  if (f > hoyIso) return undefined;
  return f;
}

function applyMapping(row: AnyRecord, mapeo: Record<string, string>): AnyRecord {
  const mapped: AnyRecord = {};
  for (const [srcCol, targetKey] of Object.entries(mapeo)) {
    if (targetKey && targetKey !== "__omitir") {
      mapped[targetKey] = row[srcCol];
    }
  }
  return mapped;
}

function str(v: unknown): string | undefined {
  if (v === null || v === undefined || v === "") return undefined;
  const s = String(v).trim();
  return s === "" ? undefined : s;
}

/** Descarta teléfonos basura ("-", "1 1", "11 1", etc.) */
function limpiarTelefono(v: string | undefined): string | undefined {
  if (!v) return undefined;
  const digits = v.replace(/\D/g, "");
  if (digits.length < 6) return undefined;
  return v.trim();
}

// ── Lógica de deduplicación y validación por entidad ─────────────────────

/**
 * Normaliza un nombre completo para matching robusto:
 * minúsculas, sin acentos, sin puntuación (comas de "Apellido, Nombre"),
 * y con las palabras ordenadas alfabéticamente para que
 * "Pérez Juan" == "Juan Perez" == "PEREZ, JUAN".
 */
export function claveNombreProfesional(nombre: string, apellido?: string | null): string {
  const completo = `${nombre ?? ""} ${apellido ?? ""}`;
  return completo
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-zñ0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .sort()
    .join(" ");
}

// Índice en memoria clave-normalizada → candidatos, para que los imports
// grandes no hagan un full scan de profesionales por cada fila.
// TTL corto + invalidación explícita cuando el propio import crea uno nuevo.
type CandidatoProfesional = { id: number; activo: boolean };
let indiceNombresProfesionales: { at: number; map: Map<string, CandidatoProfesional[]> } | null = null;
const INDICE_NOMBRES_TTL_MS = 30_000;

export function invalidarIndiceNombresProfesionales(): void {
  indiceNombresProfesionales = null;
}

async function obtenerIndiceNombresProfesionales(): Promise<Map<string, CandidatoProfesional[]>> {
  const ahora = Date.now();
  if (indiceNombresProfesionales && ahora - indiceNombresProfesionales.at < INDICE_NOMBRES_TTL_MS) {
    return indiceNombresProfesionales.map;
  }
  const existentes = await db
    .select({
      id: profesionalesTable.id,
      nombre: profesionalesTable.nombre,
      apellido: profesionalesTable.apellido,
      activo: profesionalesTable.activo,
    })
    .from(profesionalesTable);
  const map = new Map<string, CandidatoProfesional[]>();
  for (const p of existentes) {
    const k = claveNombreProfesional(p.nombre ?? "", p.apellido);
    if (!k) continue;
    const lista = map.get(k);
    if (lista) lista.push({ id: p.id, activo: p.activo });
    else map.set(k, [{ id: p.id, activo: p.activo }]);
  }
  indiceNombresProfesionales = { at: ahora, map };
  return map;
}

export async function analizarFila(
  tipoEntidad: string,
  datos: AnyRecord
): Promise<{ accion: "crear" | "actualizar" | "omitir" | "error"; motivoOmision?: string; pacienteId?: number; entidadId?: number; errores?: string[] }> {
  const errores: string[] = [];

  if (tipoEntidad === "pacientes") {
    if (!str(datos.nombre)) errores.push("nombre requerido");
    if (!str(datos.apellido)) errores.push("apellido requerido");
    if (errores.length > 0) return { accion: "error", errores };
    if (str(datos.dni)) {
      const [existing] = await db.select().from(pacientesTable)
        .where(eq(pacientesTable.dni, str(datos.dni)!)).limit(1);
      if (existing) return { accion: "actualizar", pacienteId: existing.id };
    }
    return { accion: "crear" };
  }

  if (tipoEntidad === "profesionales") {
    if (!str(datos.nombre)) errores.push("nombre requerido");
    if (errores.length > 0) return { accion: "error", errores };
    if (str(datos.matricula)) {
      const [existing] = await db.select().from(profesionalesTable)
        .where(eq(profesionalesTable.matricula, str(datos.matricula)!)).limit(1);
      if (existing) return { accion: "actualizar", entidadId: existing.id };
    }
    // Sin matrícula (o matrícula nueva): matchear por nombre normalizado
    // (sin acentos, sin puntuación, orden de palabras indistinto) para no
    // crear profesionales duplicados en re-importaciones.
    const clave = claveNombreProfesional(str(datos.nombre)!, str(datos.apellido) ?? null);
    if (clave) {
      const indice = await obtenerIndiceNombresProfesionales();
      const candidatos = indice.get(clave) ?? [];
      // Preferir el registro activo: los duplicados históricos se limpian
      // desactivándolos, y una reimportación debe actualizar al vigente.
      const porNombre = candidatos.find((p) => p.activo) ?? candidatos[0];
      if (porNombre) return { accion: "actualizar", entidadId: porNombre.id };
    }
    return { accion: "crear" };
  }

  if (tipoEntidad === "turnos_hc") {
    if (!str(datos.apellido)) errores.push("apellido requerido");
    if (!str(datos.nombre)) errores.push("nombre requerido");
    if (!str(datos.dni)) errores.push("dni requerido");
    if (errores.length > 0) return { accion: "error", errores };
    const [existing] = await db.select({ id: pacientesTable.id }).from(pacientesTable)
      .where(eq(pacientesTable.dni, str(datos.dni)!)).limit(1);
    if (existing) return { accion: "actualizar", pacienteId: existing.id };
    return { accion: "crear" };
  }

  if (["evoluciones", "diagnosticos", "medicacion", "adjuntos"].includes(tipoEntidad)) {
    if (!str(datos.pacienteDni)) errores.push("pacienteDni requerido");
    if (tipoEntidad === "evoluciones" && !str(datos.texto)) errores.push("texto requerido");
    if (tipoEntidad === "diagnosticos" && !str(datos.descripcion)) errores.push("descripcion requerida");
    if (tipoEntidad === "medicacion" && !str(datos.medicamentos)) errores.push("medicamentos requerido");
    if (tipoEntidad === "adjuntos" && !str(datos.nombre)) errores.push("nombre requerido");
    if (errores.length > 0) return { accion: "error", errores };

    const [paciente] = await db.select({ id: pacientesTable.id })
      .from(pacientesTable).where(eq(pacientesTable.dni, str(datos.pacienteDni)!)).limit(1);
    if (!paciente) return { accion: "error", errores: [`Paciente con DNI ${str(datos.pacienteDni)} no encontrado`] };
    return { accion: "crear", pacienteId: paciente.id };
  }

  return { accion: "crear" };
}

async function ejecutarFila(
  tipoEntidad: string,
  datos: AnyRecord,
  accionForzada?: "crear" | "actualizar" | "omitir",
  resolucionGlobal?: "actualizar" | "omitir" | null
): Promise<{ accion: string; entidadId?: number; error?: string }> {
  const analisis = await analizarFila(tipoEntidad, datos);

  let accion = accionForzada ?? analisis.accion;

  // Resolución global para pacientes ya existentes: "omitir" saltea los turnos
  // cuyo paciente ya está en el sistema (solo se importan los DNI nuevos).
  if (!accionForzada && resolucionGlobal === "omitir" && analisis.accion === "actualizar") {
    accion = "omitir";
  }

  if (accion === "omitir") return { accion: "omitir" };
  if (accion === "error") return { accion: "error", error: analisis.errores?.join("; ") };

  try {
    if (tipoEntidad === "pacientes") {
      if (accion === "actualizar" && analisis.pacienteId) {
        await db.update(pacientesTable).set({
          nombre: str(datos.nombre) ?? undefined,
          apellido: str(datos.apellido) ?? undefined,
          email: str(datos.email) ?? undefined,
          telefono: str(datos.telefono) ?? undefined,
          cobertura: str(datos.cobertura) ?? undefined,
          nroAfiliado: str(datos.nroAfiliado) ?? undefined,
          fechaNacimiento: str(datos.fechaNacimiento) ?? undefined,
          sexo: str(datos.sexo) ?? undefined,
          direccion: str(datos.direccion) ?? undefined,
          observaciones: str(datos.observaciones) ?? undefined,
        }).where(eq(pacientesTable.id, analisis.pacienteId));
        return { accion: "actualizar", entidadId: analisis.pacienteId };
      }
      const [p] = await db.insert(pacientesTable).values({
        nombre: str(datos.nombre)!,
        apellido: str(datos.apellido)!,
        dni: str(datos.dni) ?? undefined,
        numeroHc: str(datos.dni) ?? undefined, // HC = DNI
        email: str(datos.email) ?? undefined,
        telefono: str(datos.telefono) ?? undefined,
        cobertura: str(datos.cobertura) ?? undefined,
        nroAfiliado: str(datos.nroAfiliado) ?? undefined,
        fechaNacimiento: str(datos.fechaNacimiento) ?? undefined,
        sexo: str(datos.sexo) ?? undefined,
        direccion: str(datos.direccion) ?? undefined,
        observaciones: str(datos.observaciones) ?? undefined,
      }).returning();
      return { accion: "crear", entidadId: p.id };
    }

    if (tipoEntidad === "profesionales") {
      let especialidadId: number | undefined;
      if (str(datos.especialidad)) {
        const [esp] = await db.select().from(especialidadesTable)
          .where(eq(especialidadesTable.nombre, str(datos.especialidad)!)).limit(1);
        especialidadId = esp?.id;
      }
      if (accion === "actualizar" && analisis.entidadId) {
        await db.update(profesionalesTable).set({
          matricula: str(datos.matricula) ?? undefined,
          email: str(datos.email) ?? undefined,
          telefono: str(datos.telefono) ?? undefined,
          especialidadId: especialidadId ?? undefined,
        }).where(eq(profesionalesTable.id, analisis.entidadId));
        return { accion: "actualizar", entidadId: analisis.entidadId };
      }
      const [p] = await db.insert(profesionalesTable).values({
        nombre: str(datos.nombre)!,
        apellido: str(datos.apellido) ?? undefined,
        matricula: str(datos.matricula) ?? undefined,
        email: str(datos.email) ?? undefined,
        telefono: str(datos.telefono) ?? undefined,
        especialidadId: especialidadId ?? undefined,
      }).returning();
      // Un profesional nuevo debe ser visible para las filas siguientes del
      // mismo import (evita duplicados dentro del mismo archivo).
      invalidarIndiceNombresProfesionales();
      return { accion: "crear", entidadId: p.id };
    }

    if (tipoEntidad === "evoluciones") {
      const [ev] = await db.insert(evolucionesTable).values({
        pacienteId: analisis.pacienteId!,
        texto: str(datos.texto)!,
        motivoConsulta: str(datos.motivoConsulta) ?? undefined,
        exploracion: str(datos.exploracion) ?? undefined,
        plan: str(datos.plan) ?? undefined,
      }).returning();
      return { accion: "crear", entidadId: ev.id };
    }

    if (tipoEntidad === "diagnosticos") {
      const [d] = await db.insert(diagnosticosTable).values({
        pacienteId: analisis.pacienteId!,
        descripcion: str(datos.descripcion)!,
        cie10: str(datos.cie10) ?? undefined,
        tipo: str(datos.tipo) ?? "presuntivo",
      }).returning();
      return { accion: "crear", entidadId: d.id };
    }

    if (tipoEntidad === "medicacion") {
      const [r] = await db.insert(recetasTable).values({
        pacienteId: analisis.pacienteId!,
        medicamentos: str(datos.medicamentos)!,
        indicaciones: str(datos.indicaciones) ?? undefined,
        diagnostico: str(datos.diagnostico) ?? undefined,
        vigencia: str(datos.vigencia) ?? undefined,
      }).returning();
      return { accion: "crear", entidadId: r.id };
    }

    if (tipoEntidad === "turnos_hc") {
      // 1) Upsert del paciente por DNI
      let pacienteId = analisis.pacienteId;
      if (!pacienteId) {
        const [p] = await db.insert(pacientesTable).values({
          nombre: str(datos.nombre)!,
          apellido: str(datos.apellido)!,
          dni: str(datos.dni)!,
          numeroHc: str(datos.dni)!, // HC = DNI
          telefono: limpiarTelefono(str(datos.telefono)),
          direccion: str(datos.direccion) ?? undefined,
          cobertura: str(datos.obraSocial) ?? undefined,
          nroAfiliado: str(datos.nroAfiliado) ?? undefined,
          fechaNacimiento: normalizarFechaNacimiento(str(datos.fechaNacimiento)),
        }).returning();
        pacienteId = p.id;
      } else {
        // Completar datos faltantes del paciente existente (sin pisar los ya cargados)
        const [existente] = await db.select().from(pacientesTable)
          .where(eq(pacientesTable.id, pacienteId)).limit(1);
        if (existente) {
          const cambios: Record<string, string> = {};
          const tel = limpiarTelefono(str(datos.telefono));
          if (!existente.telefono && tel) cambios.telefono = tel;
          if (!existente.direccion && str(datos.direccion)) cambios.direccion = str(datos.direccion)!;
          if (!existente.cobertura && str(datos.obraSocial)) cambios.cobertura = str(datos.obraSocial)!;
          if (!existente.nroAfiliado && str(datos.nroAfiliado)) cambios.nroAfiliado = str(datos.nroAfiliado)!;
          if (!existente.fechaNacimiento) {
            const f = normalizarFechaNacimiento(str(datos.fechaNacimiento));
            if (f) cambios.fechaNacimiento = f;
          }
          if (Object.keys(cambios).length > 0) {
            await db.update(pacientesTable).set(cambios).where(eq(pacientesTable.id, pacienteId));
          }
        }
      }

      // 2) Evolución con la nota clínica (si hay texto en "motivo")
      const notaClinica = str(datos.motivo);
      if (notaClinica) {
        const contexto: string[] = [];
        const fechaT = normalizarFecha(str(datos.fechaTurno));
        if (fechaT) contexto.push(`Fecha: ${fechaT}${str(datos.horaTurno) ? ` ${str(datos.horaTurno)}` : ""}`);
        if (str(datos.especialidad)) contexto.push(str(datos.especialidad)!);
        if (str(datos.profesional)) contexto.push(str(datos.profesional)!);
        if (str(datos.institucion)) contexto.push(str(datos.institucion)!);

        // Signos vitales al pie de la evolución
        const sv: string[] = [];
        if (str(datos.pesoKg)) sv.push(`Peso: ${str(datos.pesoKg)} Kg`);
        if (str(datos.tallaCm)) sv.push(`Talla: ${str(datos.tallaCm)} Cm`);
        if (str(datos.taMin) || str(datos.taMax)) sv.push(`TA: ${str(datos.taMin) ?? "?"}/${str(datos.taMax) ?? "?"}`);
        const svText = sv.length > 0 ? `\n[Signos vitales: ${sv.join(" | ")}]` : "";

        const encabezado = contexto.length > 0 ? `[${contexto.join(" — ")}]\n` : "";
        const textoFinal = `${encabezado}${notaClinica}${svText}`;
        // Idempotencia: si esta misma evolución ya se importó (mismo paciente y
        // mismo texto — el texto incluye fecha/hora/profesional, es una huella
        // estable de la fila), NO se duplica al reimportar un export que se
        // solapa con uno anterior.
        const [evolYa] = await db
          .select({ id: evolucionesTable.id })
          .from(evolucionesTable)
          .where(and(eq(evolucionesTable.pacienteId, pacienteId), eq(evolucionesTable.texto, textoFinal)))
          .limit(1);
        if (!evolYa) {
          await db.insert(evolucionesTable).values({
            pacienteId,
            texto: textoFinal,
            motivoConsulta: str(datos.consulta) ?? undefined,
          });
        }
      }

      // 3) Diagnóstico principal (si hay descripción o CIE10)
      const dxDesc = str(datos.diagnostico);
      const dxCie = str(datos.cie10);
      if (dxDesc || dxCie) {
        // Idempotencia: mismo diagnóstico (descripción + CIE10) del mismo
        // paciente no se repite en reimportaciones.
        const [dxYa] = await db
          .select({ id: diagnosticosTable.id })
          .from(diagnosticosTable)
          .where(and(
            eq(diagnosticosTable.pacienteId, pacienteId),
            eq(diagnosticosTable.descripcion, dxDesc ?? dxCie!),
            dxCie ? eq(diagnosticosTable.cie10, dxCie) : isNull(diagnosticosTable.cie10),
          ))
          .limit(1);
        if (!dxYa) {
          await db.insert(diagnosticosTable).values({
            pacienteId,
            descripcion: dxDesc ?? dxCie!,
            cie10: dxCie ?? undefined,
            tipo: "confirmado",
          });
        }
      }

      return { accion: analisis.pacienteId ? "actualizar" : "crear", entidadId: pacienteId };
    }

    if (tipoEntidad === "adjuntos") {
      const [a] = await db.insert(adjuntosTable).values({
        pacienteId: analisis.pacienteId!,
        nombre: str(datos.nombre)!,
        tipo: str(datos.tipo) ?? "otro",
        descripcion: str(datos.descripcion) ?? undefined,
        url: str(datos.url) ?? undefined,
        fuente: str(datos.fuente) ?? undefined,
      }).returning();
      return { accion: "crear", entidadId: a.id };
    }

    return { accion: "error", error: `Entidad desconocida: ${tipoEntidad}` };
  } catch (err) {
    return { accion: "error", error: err instanceof Error ? err.message : "Error interno" };
  }
}

// ── POST /importacion/jobs/upload ─────────────────────────────────────────

router.post(
  "/importacion/jobs/upload",
  upload.single("file"),
  async (req, res): Promise<void> => {
    const { tipoEntidad: tipoEntidadBody, datosJson } = req.body as { tipoEntidad?: string; datosJson?: string };

    let filas: AnyRecord[] = [];
    let formato = "json";
    let nombreArchivo = "";

    try {
      if (req.file) {
        filas = parseFileToRows(req.file.buffer, req.file.mimetype, req.file.originalname);
        const ext = req.file.originalname.split(".").pop()?.toLowerCase() ?? "json";
        formato = ext === "xlsx" || ext === "xls" ? "excel" : ext === "csv" ? "csv" : "json";
        nombreArchivo = req.file.originalname;
      } else if (datosJson) {
        const parsed = JSON.parse(datosJson) as unknown;
        filas = Array.isArray(parsed) ? (parsed as AnyRecord[]) : [];
        formato = "json";
      } else {
        res.status(400).json({ error: "Se requiere un archivo o datosJson" });
        return;
      }
    } catch (err) {
      res.status(400).json({ error: `Error al procesar archivo: ${err instanceof Error ? err.message : "Error desconocido"}` });
      return;
    }

    if (filas.length === 0) {
      res.status(400).json({ error: "El archivo no contiene datos" });
      return;
    }

    const columnas = Object.keys(filas[0] ?? {});

    // Detectar perfil canónico — el perfil puede sugerir la entidad y proveer un
    // mapeo ya verificado para este formato de archivo
    const perfilDetectado = detectarPerfil(columnas);
    const tipoEntidad = tipoEntidadBody || perfilDetectado?.entidad || "pacientes";

    if (!CAMPOS_POR_ENTIDAD[tipoEntidad]) {
      res.status(400).json({ error: "tipoEntidad inválido", validos: Object.keys(CAMPOS_POR_ENTIDAD) });
      return;
    }

    const camposTarget = CAMPOS_POR_ENTIDAD[tipoEntidad].campos;

    // Si hay perfil canónico, usar su mapeo como base y completarlo con el
    // auto-mapeo para las columnas que el perfil no cubre (el perfil pisa al auto).
    const mapeoAuto = autoMapColumns(columnas, camposTarget);
    const mapeoBase: Record<string, string> = perfilDetectado
      ? { ...mapeoAuto, ...perfilDetectado.mapeo }
      : mapeoAuto;

    const nombre = nombreArchivo
      ? `${nombreArchivo} — ${CAMPOS_POR_ENTIDAD[tipoEntidad].label}`
      : `Importación ${tipoEntidad} ${new Date().toLocaleDateString("es-AR")}`;

    const [job] = await db.insert(jobImportacionesTable).values({
      nombre,
      tipoEntidad,
      formato,
      estado: "pendiente",
      totalRegistros: filas.length,
      mapeoColumnas: mapeoBase,
      filasData: filas as unknown as Record<string, unknown>,
    }).returning();

    res.json({
      jobId: job.id,
      nombre: job.nombre,
      tipoEntidad,
      formato,
      totalRegistros: filas.length,
      columnas,
      mapeoAutoDetectado: mapeoBase,
      camposTarget,
      preview: filas.slice(0, 5),
      perfilDetectado: perfilDetectado ? {
        id: perfilDetectado.id,
        label: perfilDetectado.label,
        sistema: perfilDetectado.sistema,
        descripcion: perfilDetectado.descripcion,
      } : null,
    });
  }
);

// ── POST /importacion/jobs/:id/validar ────────────────────────────────────
// Para archivos grandes (>500 filas) devuelve solo un sample de cada tipo
// junto con los stats completos. El frontend no necesita ver 6000 filas —
// solo los errores y una muestra de conflictos para tomar decisiones globales.

router.post("/importacion/jobs/:id/validar", async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  const { mapeoColumnas: mapeoBody } = req.body as { mapeoColumnas?: Record<string, string> };

  const [job] = await db.select().from(jobImportacionesTable)
    .where(eq(jobImportacionesTable.id, id)).limit(1);

  if (!job) { res.status(404).json({ error: "Job no encontrado" }); return; }

  // Si no viene mapeo en el body, se usa el detectado/guardado en el upload.
  const mapeoColumnas = mapeoBody ?? (job.mapeoColumnas as Record<string, string> | null) ?? {};

  const filas = (job.filasData as AnyRecord[]) ?? [];
  await db.update(jobImportacionesTable)
    .set({ mapeoColumnas, estado: "validando" })
    .where(eq(jobImportacionesTable.id, id));

  type RegistroVal = {
    fila: number;
    accion: string;
    datos: AnyRecord;
    datosOriginales: AnyRecord;
    errores?: string[];
    pacienteId?: number;
  };

  // Contadores globales y muestra limitada por categoría
  const SAMPLE_SIZE = 50;
  let nuevos = 0, actualizar = 0, omitir = 0, errores = 0;
  const sampleNuevos: RegistroVal[] = [];
  const sampleActualizar: RegistroVal[] = [];
  const sampleErrores: RegistroVal[] = [];

  for (let i = 0; i < filas.length; i++) {
    const filaOriginal = filas[i];
    const datosMapeados = applyMapping(filaOriginal, mapeoColumnas);
    const analisis = await analizarFila(job.tipoEntidad, datosMapeados);

    const rec: RegistroVal = {
      fila: i + 1,
      accion: analisis.accion,
      datos: datosMapeados,
      datosOriginales: filaOriginal,
      errores: analisis.errores,
      pacienteId: analisis.pacienteId,
    };

    if (analisis.accion === "crear") {
      nuevos++;
      if (sampleNuevos.length < SAMPLE_SIZE) sampleNuevos.push(rec);
    } else if (analisis.accion === "actualizar") {
      actualizar++;
      if (sampleActualizar.length < SAMPLE_SIZE) sampleActualizar.push(rec);
    } else if (analisis.accion === "omitir") {
      omitir++;
    } else {
      errores++;
      if (sampleErrores.length < SAMPLE_SIZE) sampleErrores.push(rec);
    }
  }

  await db.update(jobImportacionesTable)
    .set({ estado: "listo_para_ejecutar" })
    .where(eq(jobImportacionesTable.id, id));

  res.json({
    jobId: id,
    stats: {
      nuevos,
      actualizar,
      omitir,
      errores,
      total: filas.length,
      pacientesNuevos: sampleNuevos.reduce((s, r) => { const k = str(r.datos[CAMPOS_POR_ENTIDAD[job.tipoEntidad]?.claveDedup ?? "dni"]); return k ? s.add(k) : s; }, new Set<string>()).size,
      pacientesActualizar: sampleActualizar.reduce((s, r) => { const k = str(r.datos[CAMPOS_POR_ENTIDAD[job.tipoEntidad]?.claveDedup ?? "dni"]); return k ? s.add(k) : s; }, new Set<string>()).size,
    },
    sample: {
      nuevos: sampleNuevos,
      actualizar: sampleActualizar,
      errores: sampleErrores,
    },
    truncado: filas.length > SAMPLE_SIZE,
  });
});

// ── POST /importacion/jobs/:id/ejecutar ───────────────────────────────────

/**
 * Procesa un job de importación en background, por lotes y de forma resumible.
 * Cada fila se aísla en try/catch; los contadores y la auditoría se persisten
 * por chunk, de modo que el polling ve el progreso en vivo y, si el proceso se
 * reinicia, se retoma desde lo ya procesado (creados+actualizados+omitidos+errores).
 */
async function procesarJobImportacion(
  jobId: number,
  mapeo: Record<string, string>,
  resolucionGlobal: "actualizar" | "omitir" | null
): Promise<void> {
  const log = logger.child({ modulo: "importacion", jobId });
  try {
    const [job] = await db.select().from(jobImportacionesTable)
      .where(eq(jobImportacionesTable.id, jobId)).limit(1);
    if (!job) return;

    const filas = (job.filasData as AnyRecord[]) ?? [];

    // Reanudar desde la AUDITORÍA (fuente de verdad durable), no desde los
    // contadores: la auditoría de cada chunk se inserta de forma atómica ANTES
    // de actualizar los contadores, así que si el proceso muere entre ambos
    // pasos los contadores quedan viejos pero la auditoría es correcta. Retomar
    // por contadores reprocesaría un chunk ya escrito (evoluciones/diagnósticos
    // duplicados). Retomar por `max(fila)` de la auditoría es estrictamente más
    // seguro (auditoría >= contadores siempre).
    const conteos = await db
      .select({ accion: importacionAuditoriaTable.accion, n: sql<number>`count(*)::int` })
      .from(importacionAuditoriaTable)
      .where(eq(importacionAuditoriaTable.jobId, jobId))
      .groupBy(importacionAuditoriaTable.accion);
    const [{ maxFila }] = await db
      .select({ maxFila: sql<number>`coalesce(max(${importacionAuditoriaTable.fila}), 0)` })
      .from(importacionAuditoriaTable)
      .where(eq(importacionAuditoriaTable.jobId, jobId));

    let creados = conteos.find((c) => c.accion === "crear")?.n ?? 0;
    let actualizados = conteos.find((c) => c.accion === "actualizar")?.n ?? 0;
    let omitidos = conteos.find((c) => c.accion === "omitir")?.n ?? 0;
    let erroresCount = conteos.find((c) => c.accion === "error")?.n ?? 0;

    // `fila` es 1-based; si la auditoría llega hasta fila=N, el índice N-1 ya se
    // procesó, así que se retoma en el índice N.
    let inicio = maxFila;
    if (inicio < 0 || inicio > filas.length) inicio = 0;

    log.info({ total: filas.length, inicio }, "importación background iniciada");

    for (let i = inicio; i < filas.length; i += CHUNK_SIZE) {
      const fin = Math.min(i + CHUNK_SIZE, filas.length);
      const auditorias: typeof importacionAuditoriaTable.$inferInsert[] = [];

      for (let j = i; j < fin; j++) {
        const datos = applyMapping(filas[j], mapeo);
        let resultado: { accion: string; entidadId?: number; error?: string };
        try {
          resultado = await ejecutarFila(job.tipoEntidad, datos, undefined, resolucionGlobal);
        } catch (err) {
          resultado = { accion: "error", error: err instanceof Error ? err.message : "Error interno" };
        }
        auditorias.push({
          jobId,
          fila: j + 1,
          accion: resultado.accion,
          entidadTipo: job.tipoEntidad,
          entidadId: resultado.entidadId ?? undefined,
          datosOriginales: filas[j] as Record<string, unknown>,
          mensajeError: resultado.error ?? undefined,
        });
        if (resultado.accion === "crear") creados++;
        else if (resultado.accion === "actualizar") actualizados++;
        else if (resultado.accion === "omitir") omitidos++;
        else erroresCount++;
      }

      if (auditorias.length > 0) {
        await db.insert(importacionAuditoriaTable).values(auditorias);
      }
      await db.update(jobImportacionesTable).set({
        creados, actualizados, omitidos, errores: erroresCount,
      }).where(eq(jobImportacionesTable.id, jobId));
    }

    await db.update(jobImportacionesTable).set({
      estado: "completado",
      creados, actualizados, omitidos, errores: erroresCount,
      completadoAt: new Date(),
    }).where(eq(jobImportacionesTable.id, jobId));

    log.info({ creados, actualizados, omitidos, errores: erroresCount }, "importación completada");
  } catch (err) {
    log.error({ err }, "error fatal en importación background");
    await db.update(jobImportacionesTable).set({ estado: "error" })
      .where(eq(jobImportacionesTable.id, jobId)).catch(() => undefined);
  } finally {
    jobsEnEjecucion.delete(jobId);
  }
}

router.post("/importacion/jobs/:id/ejecutar", async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  const {
    dryRun = false,
    mapeoColumnas,
    resoluciones = {},
    resolucionGlobal = null,
  } = req.body as {
    dryRun?: boolean;
    mapeoColumnas: Record<string, string>;
    resoluciones?: Record<number, "crear" | "actualizar" | "omitir">;
    resolucionGlobal?: "actualizar" | "omitir" | null;
  };

  const [job] = await db.select().from(jobImportacionesTable)
    .where(eq(jobImportacionesTable.id, id)).limit(1);

  if (!job) { res.status(404).json({ error: "Job no encontrado" }); return; }

  const filas = (job.filasData as AnyRecord[]) ?? [];
  const mapeo = mapeoColumnas ?? (job.mapeoColumnas as Record<string, string>) ?? {};

  // ── Simulación (dry run): análisis síncrono, no escribe nada ──────────────
  if (dryRun) {
    let creados = 0, actualizados = 0, omitidos = 0, erroresCount = 0;
    for (let i = 0; i < filas.length; i++) {
      const datos = applyMapping(filas[i], mapeo);
      const analisis = await analizarFila(job.tipoEntidad, datos);
      let accion = resoluciones[i + 1] ?? analisis.accion;
      if (!resoluciones[i + 1] && resolucionGlobal === "omitir" && analisis.accion === "actualizar") {
        accion = "omitir";
      }
      if (accion === "crear") creados++;
      else if (accion === "actualizar") actualizados++;
      else if (accion === "omitir") omitidos++;
      else erroresCount++;
    }
    res.json({ jobId: id, dryRun: true, creados, actualizados, omitidos, errores: erroresCount, total: filas.length });
    return;
  }

  // ── Ejecución real: background, resumible, con polling ────────────────────
  const contadores = {
    creados: job.creados ?? 0,
    actualizados: job.actualizados ?? 0,
    omitidos: job.omitidos ?? 0,
    errores: job.errores ?? 0,
  };

  // Ya terminó: idempotente, devolver stats sin reprocesar
  if (job.estado === "completado") {
    res.json({ jobId: id, dryRun: false, estado: "completado", ...contadores, total: job.totalRegistros });
    return;
  }

  // Ya se está ejecutando en este proceso: devolver estado actual
  if (jobsEnEjecucion.has(id)) {
    res.status(202).json({ jobId: id, dryRun: false, estado: "ejecutando", ...contadores, total: job.totalRegistros });
    return;
  }

  jobsEnEjecucion.add(id);
  await db.update(jobImportacionesTable)
    .set({ estado: "ejecutando", mapeoColumnas: mapeo })
    .where(eq(jobImportacionesTable.id, id));

  void procesarJobImportacion(id, mapeo, resolucionGlobal);

  res.status(202).json({ jobId: id, dryRun: false, estado: "ejecutando", ...contadores, total: job.totalRegistros });
});

// ── GET /importacion/jobs ─────────────────────────────────────────────────
// Nota: se excluye `filasData` (puede ser un blob de cientos de MB) para que
// el listado y el polling de progreso sean baratos.

const jobResumenCols = {
  id: jobImportacionesTable.id,
  nombre: jobImportacionesTable.nombre,
  tipoEntidad: jobImportacionesTable.tipoEntidad,
  formato: jobImportacionesTable.formato,
  estado: jobImportacionesTable.estado,
  totalRegistros: jobImportacionesTable.totalRegistros,
  creados: jobImportacionesTable.creados,
  actualizados: jobImportacionesTable.actualizados,
  omitidos: jobImportacionesTable.omitidos,
  errores: jobImportacionesTable.errores,
  mapeoColumnas: jobImportacionesTable.mapeoColumnas,
  createdAt: jobImportacionesTable.createdAt,
  completadoAt: jobImportacionesTable.completadoAt,
};

router.get("/importacion/jobs", async (req, res): Promise<void> => {
  const jobs = await db.select(jobResumenCols).from(jobImportacionesTable)
    .orderBy(desc(jobImportacionesTable.createdAt))
    .limit(50);
  res.json(jobs);
});

// ── GET /importacion/jobs/:id ─────────────────────────────────────────────

router.get("/importacion/jobs/:id", async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  const [job] = await db.select(jobResumenCols).from(jobImportacionesTable)
    .where(eq(jobImportacionesTable.id, id)).limit(1);
  if (!job) { res.status(404).json({ error: "Job no encontrado" }); return; }
  res.json(job);
});

// ── GET /importacion/jobs/:id/auditoria ───────────────────────────────────

router.get("/importacion/jobs/:id/auditoria", async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  const limit = Number(req.query.limit ?? 100);
  const page = Number(req.query.page ?? 1);
  const offset = (page - 1) * limit;

  const rows = await db.select().from(importacionAuditoriaTable)
    .where(eq(importacionAuditoriaTable.jobId, id))
    .orderBy(importacionAuditoriaTable.fila)
    .limit(limit).offset(offset);

  const [{ count }] = await db.select({ count: importacionAuditoriaTable.id })
    .from(importacionAuditoriaTable)
    .where(eq(importacionAuditoriaTable.jobId, id));

  res.json({ data: rows, total: count, page, limit });
});

// ── GET /importacion/campos/:entidad ─────────────────────────────────────

router.get("/importacion/campos/:entidad", async (req, res): Promise<void> => {
  const entidad = req.params.entidad;
  const def = CAMPOS_POR_ENTIDAD[entidad];
  if (!def) {
    res.status(404).json({ error: "Entidad no encontrada", validas: Object.keys(CAMPOS_POR_ENTIDAD) });
    return;
  }
  res.json(def);
});

// ── GET /importacion/entidades ────────────────────────────────────────────

router.get("/importacion/entidades", async (req, res): Promise<void> => {
  res.json(
    Object.entries(CAMPOS_POR_ENTIDAD).map(([key, val]) => ({
      key,
      label: val.label,
      claveDedup: val.claveDedup,
      totalCampos: val.campos.length,
    }))
  );
});

// ── GET /importacion/perfiles ─────────────────────────────────────────────

router.get("/importacion/perfiles", (_req, res): void => {
  res.json(
    PERFILES_CANONICOS.map((p) => ({
      id: p.id,
      label: p.label,
      sistema: p.sistema,
      descripcion: p.descripcion,
      entidad: p.entidad,
      firma: p.firma,
    }))
  );
});

export default router;
