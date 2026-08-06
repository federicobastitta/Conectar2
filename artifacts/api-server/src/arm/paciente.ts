// ARM v2 — Módulo 3: Búsqueda de paciente en Klinicos
// Alcance: SOLO buscar por DNI exacto y clasificar el resultado. No crea ni
// edita pacientes, no selecciona filas ambiguas, no toca consultas/tokens.
//
// Estados de salida (contrato aprobado por el usuario, ago 2026):
//   PATIENT_UNIQUE_MATCH     — exactamente UNA fila con ese DNI exacto
//   PATIENT_NOT_FOUND        — ninguna fila con ese DNI exacto
//   PATIENT_MULTIPLE_MATCHES — más de una fila con el MISMO DNI (no se elige)
//   PATIENT_DATA_MISMATCH    — la fila del DNI existe pero le faltan datos
//                              esenciales (sin id interno o sin apellido)
//   SESSION_EXPIRED          — la pantalla respondió con el form de acceso
//   TECHNICAL_ERROR          — Klinicos no responde / error de servidor
//   MANUAL_REVIEW            — respuesta no reconocida
//
// Privacidad: el DNI completo NUNCA va a registros — solo los últimos 3
// dígitos enmascarados (p.ej. "…369").

import { CookieJar, jarFetch } from "../integraciones/klinicos-robot";
import { verificarSesionKlinicos } from "./sesion";

export type EstadoBusqueda =
  | "PATIENT_UNIQUE_MATCH"
  | "PATIENT_NOT_FOUND"
  | "PATIENT_MULTIPLE_MATCHES"
  | "PATIENT_DATA_MISMATCH"
  | "SESSION_EXPIRED"
  | "TECHNICAL_ERROR"
  | "MANUAL_REVIEW";

export interface PacienteEncontrado {
  id: string; // GUID interno de Klinicos
  apellido: string;
  nombre: string;
  hc: string | null;
  estado: string | null;
}

export interface ResultadoBusqueda {
  estado: EstadoBusqueda;
  /** Detalle apto para registros: jamás incluye el DNI completo. */
  detalle: string;
  paciente: PacienteEncontrado | null;
}

/** Enmascara el DNI para registros: solo los últimos 3 dígitos. */
export function dniEnmascarado(dni: string): string {
  const limpio = dni.replace(/\D/g, "");
  return limpio.length > 3 ? `…${limpio.slice(-3)}` : "…";
}

// Cuerpo DataTables del grid de pacientes (calibrado en el portal: el buscador
// de /paciente consulta POST /paciente/grid/{documento}/null/null/null).
function cuerpoGridPacientes(): string {
  const cols = ["documento", "hc", "primerApellido", "", "primerNombre", "otrosNombres", "fechaNacimiento", "estadoNombre", ""];
  const p = new URLSearchParams({ draw: "1", start: "0", length: "20", "search[value]": "", "search[regex]": "false" });
  cols.forEach((c, i) => {
    p.set(`columns[${i}][data]`, c);
    p.set(`columns[${i}][name]`, "");
    p.set(`columns[${i}][searchable]`, "true");
    p.set(`columns[${i}][orderable]`, "false");
    p.set(`columns[${i}][search][value]`, "");
    p.set(`columns[${i}][search][regex]`, "false");
  });
  p.set("order[0][column]", "2");
  p.set("order[0][dir]", "asc");
  return p.toString();
}

export async function buscarPacientePorDni(jar: CookieJar, dni: string): Promise<ResultadoBusqueda> {
  const limpio = dni.replace(/\D/g, "");
  const mascara = dniEnmascarado(dni);
  if (!limpio) return { estado: "MANUAL_REVIEW", detalle: "DNI vacío o inválido — no se busca", paciente: null };

  // Paso 1: la sesión tiene que estar activa (verificación por contenido).
  const sesion = await verificarSesionKlinicos(jar);
  if (sesion.estado !== "SESSION_ACTIVE") {
    if (sesion.estado === "SESSION_EXPIRED") return { estado: "SESSION_EXPIRED", detalle: sesion.detalle, paciente: null };
    if (sesion.estado === "TECHNICAL_ERROR") return { estado: "TECHNICAL_ERROR", detalle: sesion.detalle, paciente: null };
    return { estado: "MANUAL_REVIEW", detalle: sesion.detalle, paciente: null };
  }

  // Paso 2: consulta al buscador de pacientes (solo lectura).
  let res: { status: number; text: string };
  try {
    res = await jarFetch(jar, `/paciente/grid/${limpio}/null/null/null`, {
      method: "POST",
      body: cuerpoGridPacientes(),
      contentType: "application/x-www-form-urlencoded; charset=UTF-8",
      referer: `${(process.env.KLINICOS_BASE_URL ?? "https://klinicos.aceapp.ar").replace(/\/$/, "")}/paciente`,
      xhr: true,
    });
  } catch (e) {
    return { estado: "TECHNICAL_ERROR", detalle: `Klinicos no respondió al buscar (DNI ${mascara}): ${e instanceof Error ? e.message : String(e)}`, paciente: null };
  }
  if (res.status >= 500) return { estado: "TECHNICAL_ERROR", detalle: `El buscador devolvió error de servidor (${res.status})`, paciente: null };
  if (res.status !== 200) return { estado: "MANUAL_REVIEW", detalle: `El buscador respondió ${res.status} — no reconocido`, paciente: null };

  let filas: Array<Record<string, unknown>>;
  try {
    const j = JSON.parse(res.text) as { data?: Array<Record<string, unknown>> };
    filas = Array.isArray(j.data) ? j.data : [];
  } catch {
    // Un HTML acá suele ser la pantalla de acceso re-renderizada.
    if (/name="UserName"/i.test(res.text)) return { estado: "SESSION_EXPIRED", detalle: "El buscador devolvió la pantalla de acceso", paciente: null };
    return { estado: "MANUAL_REVIEW", detalle: "La respuesta del buscador no es la grilla esperada", paciente: null };
  }

  // Paso 3: SOLO coincidencia exacta de DNI (el grid puede traer parecidos).
  const exactas = filas.filter((f) => String(f.numeroDocumento ?? "") === limpio);
  if (exactas.length === 0) {
    return { estado: "PATIENT_NOT_FOUND", detalle: `Sin coincidencia exacta para DNI ${mascara} (${filas.length} resultado(s) parecidos descartados) — NO se crea el paciente`, paciente: null };
  }
  if (exactas.length > 1) {
    return { estado: "PATIENT_MULTIPLE_MATCHES", detalle: `${exactas.length} fichas con el mismo DNI ${mascara} — no se elige ninguna, revisar en Klinicos`, paciente: null };
  }

  const f = exactas[0]!;
  const id = f.id != null ? String(f.id) : "";
  const apellido = f.primerApellido != null ? String(f.primerApellido).trim() : "";
  if (!id || !apellido) {
    return { estado: "PATIENT_DATA_MISMATCH", detalle: `La ficha del DNI ${mascara} está incompleta (${!id ? "sin id interno" : "sin apellido"}) — revisar en Klinicos`, paciente: null };
  }
  return {
    estado: "PATIENT_UNIQUE_MATCH",
    detalle: `Única coincidencia exacta (DNI ${mascara}): ${apellido}, ${String(f.primerNombre ?? "").trim()} (HC ${f.hc ?? "s/d"})`,
    paciente: {
      id,
      apellido,
      nombre: String(f.primerNombre ?? "").trim(),
      hc: f.hc ? String(f.hc) : null,
      estado: f.estadoNombre ? String(f.estadoNombre) : f.estado ? String(f.estado) : null,
    },
  };
}
