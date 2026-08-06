/**
 * Stage normalización — Transforma valores al formato canónico.
 * DNI → solo dígitos. Fechas → YYYY-MM-DD. Sexo → enum. etc.
 */

import type { FilaAlephooStaging, FilaNormalizada } from "../types.js";

// ── Helpers de normalización ─────────────────────────────────────────────────

function normalizarDNI(valor?: string): string | undefined {
  if (!valor) return undefined;
  // Quitar puntos, espacios, guiones
  const solo = valor.replace(/[\.\-\s]/g, "").replace(/\D/g, "");
  return solo || undefined;
}

const MESES_ES: Record<string, string> = {
  enero: "01", ene: "01", jan: "01",
  febrero: "02", feb: "02",
  marzo: "03", mar: "03",
  abril: "04", abr: "04", apr: "04",
  mayo: "05", may: "05",
  junio: "06", jun: "06",
  julio: "07", jul: "07",
  agosto: "08", ago: "08", aug: "08",
  septiembre: "09", sep: "09", sept: "09",
  octubre: "10", oct: "10",
  noviembre: "11", nov: "11",
  diciembre: "12", dic: "12", dec: "12",
};

function normalizarFecha(valor?: string): string | undefined {
  if (!valor) return undefined;
  const v = valor.trim();

  // ISO ya bien formado
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return v;

  // DD/MM/YYYY o DD-MM-YYYY
  const dmy = v.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
  if (dmy) {
    const [, d, m, y] = dmy;
    return `${y}-${m!.padStart(2, "0")}-${d!.padStart(2, "0")}`;
  }

  // MM/DD/YYYY (formato US)
  const mdy = v.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
  if (mdy && parseInt(mdy[1]!) > 12) {
    // Si el primer número > 12, asumimos que es día
    const [, d, m, y] = mdy;
    return `${y}-${m!.padStart(2, "0")}-${d!.padStart(2, "0")}`;
  }

  // "15 de enero de 2001" o "15 enero 2001"
  const textual = v.toLowerCase().match(/(\d{1,2})\s+(?:de\s+)?([a-záéíóú]+)\s+(?:de\s+)?(\d{4})/);
  if (textual) {
    const [, d, mes, y] = textual;
    const m = MESES_ES[mes!];
    if (m) return `${y}-${m}-${d!.padStart(2, "0")}`;
  }

  // Fecha solo con año-mes (ej: "2001-05")
  if (/^\d{4}-\d{2}$/.test(v)) return `${v}-01`;

  return undefined; // no se pudo parsear
}

function normalizarHora(valor?: string): string | undefined {
  if (!valor) return undefined;
  const v = valor.trim();
  const match = v.match(/^(\d{1,2})[:h](\d{2})/);
  if (match) {
    return `${match[1]!.padStart(2, "0")}:${match[2]}`;
  }
  return undefined;
}

function normalizarSexo(
  valor?: string,
): "masculino" | "femenino" | "indeterminado" | "desconocido" {
  if (!valor) return "desconocido";
  const v = valor.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim();
  if (v === "m" || v === "masculino" || v === "hombre" || v === "male" || v === "h") return "masculino";
  if (v === "f" || v === "femenino" || v === "mujer" || v === "female") return "femenino";
  if (v === "i" || v === "indeterminado" || v === "intersex") return "indeterminado";
  return "desconocido";
}

function normalizarTexto(valor?: string): string | undefined {
  if (!valor) return undefined;
  return valor
    .trim()
    .toUpperCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function normalizarEmail(valor?: string): string | undefined {
  if (!valor) return undefined;
  const email = valor.trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : undefined;
}

function normalizarTelefono(valor?: string): string | undefined {
  if (!valor) return undefined;
  const solo = valor.replace(/[\s\-\(\)\.]/g, "");
  return solo || undefined;
}

// ── Normalizador principal ────────────────────────────────────────────────────

export function normalizarFila(staging: FilaAlephooStaging): FilaNormalizada {
  const normalizada: FilaNormalizada = {
    ...staging,
    estado: "normalizada",
    erroresValidacion: [...staging.erroresValidacion],
    advertenciasValidacion: [...staging.advertenciasValidacion],
  };

  // Normalizar DNI
  const dniNorm = normalizarDNI(staging.nroDoc);
  normalizada.nroDocNorm = dniNorm;
  if (staging.nroDoc && !dniNorm) {
    normalizada.advertenciasValidacion.push(`DNI no normalizable: "${staging.nroDoc}"`);
  }

  // Normalizar fechas
  const fnNorm = normalizarFecha(staging.fechaNacimiento);
  normalizada.fechaNacimientoIso = fnNorm;
  if (staging.fechaNacimiento && !fnNorm) {
    normalizada.advertenciasValidacion.push(
      `Fecha de nacimiento no reconocida: "${staging.fechaNacimiento}"`,
    );
  }

  const ftNorm = normalizarFecha(staging.fechaTurno);
  normalizada.fechaTurnoIso = ftNorm;
  if (staging.fechaTurno && !ftNorm) {
    normalizada.advertenciasValidacion.push(
      `Fecha de turno no reconocida: "${staging.fechaTurno}"`,
    );
  }

  normalizada.horaTurnoNorm = normalizarHora(staging.horaTurno);

  // Normalizar nombre (para comparaciones de dedup)
  normalizada.apellidoNorm = normalizarTexto(staging.apellido);
  normalizada.nombreNorm = normalizarTexto(staging.nombre);

  // Sexo
  normalizada.sexoNorm = normalizarSexo(staging.sexo);

  // Email y teléfono
  normalizada.emailNorm = normalizarEmail(staging.email);
  normalizada.telefonoNorm = normalizarTelefono(staging.telefono);

  // Validaciones post-normalización
  if (fnNorm) {
    const nacimiento = new Date(fnNorm);
    const hoy = new Date();
    const anios = (hoy.getTime() - nacimiento.getTime()) / (365.25 * 24 * 3600 * 1000);
    if (anios < 0 || anios > 150) {
      normalizada.erroresValidacion.push(`Fecha de nacimiento fuera de rango: ${fnNorm} (${Math.round(anios)} años)`);
      normalizada.estado = "cuarentena";
    }
  }

  if (staging.email && !normalizada.emailNorm) {
    normalizada.advertenciasValidacion.push(`Email inválido: "${staging.email}"`);
  }

  return normalizada;
}

export function procesarNormalizacion(filas: FilaAlephooStaging[]): FilaNormalizada[] {
  return filas.map(normalizarFila);
}
