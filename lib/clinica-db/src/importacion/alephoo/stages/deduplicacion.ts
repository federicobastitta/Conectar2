/**
 * Stage deduplicación — Detecta duplicados dentro del batch y contra la DB.
 * Estrategia: DNI exacto → duplicado exacto. Similitud de nombre/fecha → probable.
 */

import type pg from "pg";
import type { FilaNormalizada, ResultadoDedup } from "../types.js";

const DEFAULT_UMBRAL = 0.85;

// ── Similitud de cadenas (Sørensen–Dice) ─────────────────────────────────────

function bigramas(str: string): Set<string> {
  const s = new Set<string>();
  for (let i = 0; i < str.length - 1; i++) {
    s.add(str.substring(i, i + 2));
  }
  return s;
}

function similaridad(a: string, b: string): number {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const ba = bigramas(a);
  const bb = bigramas(b);
  let interseccion = 0;
  for (const bi of ba) {
    if (bb.has(bi)) interseccion++;
  }
  return (2 * interseccion) / (ba.size + bb.size);
}

function scorePersona(a: FilaNormalizada, b: FilaNormalizada): number {
  const scores: number[] = [];

  // DNI (peso alto)
  if (a.nroDocNorm && b.nroDocNorm) {
    scores.push(a.nroDocNorm === b.nroDocNorm ? 1.5 : 0); // 1.5 = peso extra
  }

  // Apellido (peso medio)
  if (a.apellidoNorm && b.apellidoNorm) {
    scores.push(similaridad(a.apellidoNorm, b.apellidoNorm));
  }

  // Nombre (peso medio)
  if (a.nombreNorm && b.nombreNorm) {
    scores.push(similaridad(a.nombreNorm, b.nombreNorm));
  }

  // Fecha de nacimiento (peso alto si coincide exacto)
  if (a.fechaNacimientoIso && b.fechaNacimientoIso) {
    scores.push(a.fechaNacimientoIso === b.fechaNacimientoIso ? 1.2 : 0);
  }

  if (scores.length === 0) return 0;
  const suma = scores.reduce((s, v) => s + v, 0);
  return Math.min(1, suma / scores.length);
}

// ── Dedup intra-batch ─────────────────────────────────────────────────────────

export function deduplicarBatch(
  filas: FilaNormalizada[],
  umbral: number = DEFAULT_UMBRAL,
): Map<number, ResultadoDedup> {
  const resultados = new Map<number, ResultadoDedup>();

  for (let i = 0; i < filas.length; i++) {
    const fila = filas[i]!;
    let resultado: ResultadoDedup = {
      filaNumero: fila.filaNumero,
      uploadId: fila.uploadId,
      tipo: "sin_duplicado",
    };

    for (let j = 0; j < i; j++) {
      const otra = filas[j]!;

      // Duplicado exacto: mismo DNI
      if (fila.nroDocNorm && otra.nroDocNorm && fila.nroDocNorm === otra.nroDocNorm) {
        resultado = {
          filaNumero: fila.filaNumero,
          uploadId: fila.uploadId,
          tipo: "duplicado_exacto",
          filaOriginalNumero: otra.filaNumero,
          camposCoindicen: ["nroDocNorm"],
        };
        break;
      }

      // Duplicado probable: score de similitud
      const score = scorePersona(fila, otra);
      if (score >= umbral) {
        resultado = {
          filaNumero: fila.filaNumero,
          uploadId: fila.uploadId,
          tipo: "duplicado_probable",
          filaOriginalNumero: otra.filaNumero,
          scoreSimiaridad: score,
          camposCoindicen: ["apellido", "nombre", "fechaNacimiento"].filter((c) => {
            const filaAsAny = fila as unknown as Record<string, unknown>;
            const otraAsAny = otra as unknown as Record<string, unknown>;
            return filaAsAny[c] !== undefined && filaAsAny[c] === otraAsAny[c];
          }),
        };
      }
    }

    resultados.set(fila.filaNumero, resultado);
  }

  return resultados;
}

// ── Dedup contra la DB ────────────────────────────────────────────────────────

export async function deduplicarContraDB(
  filas: FilaNormalizada[],
  pool: pg.Pool,
  umbral: number = DEFAULT_UMBRAL,
): Promise<Map<number, ResultadoDedup>> {
  const resultados = new Map<number, ResultadoDedup>();

  // Buscar por DNI exacto (el caso más común y confiable)
  const dnisUnicos = [...new Set(filas.map((f) => f.nroDocNorm).filter(Boolean))];

  let matchesDNI: Map<string, string> = new Map(); // dni → pacienteId (UUID)
  if (dnisUnicos.length > 0) {
    const { rows } = await pool.query<{ nro_doc_norm: string; id: string }>(
      `SELECT regexp_replace(nro_doc, '[^0-9]', '', 'g') AS nro_doc_norm, id::text AS id
       FROM pacientes
       WHERE regexp_replace(nro_doc, '[^0-9]', '', 'g') = ANY($1::text[])
         AND deleted_at IS NULL`,
      [dnisUnicos],
    );
    matchesDNI = new Map(rows.map((r) => [r.nro_doc_norm, r.id]));
  }

  for (const fila of filas) {
    // Verificar duplicado exacto por DNI en DB
    if (fila.nroDocNorm && matchesDNI.has(fila.nroDocNorm)) {
      resultados.set(fila.filaNumero, {
        filaNumero: fila.filaNumero,
        uploadId: fila.uploadId,
        tipo: "duplicado_exacto",
        pacienteExistenteId: matchesDNI.get(fila.nroDocNorm),
        camposCoindicen: ["nroDocNorm"],
      });
      continue;
    }

    // Para duplicados probables por nombre+fecha: consulta aproximada
    // Solo si no hay DNI (menos confiable)
    if (!fila.nroDocNorm && fila.apellidoNorm && fila.nombreNorm) {
      const { rows: candidatos } = await pool.query<{
        id: string;
        apellido: string;
        nombre: string;
        fecha_nacimiento: string | null;
      }>(
        `SELECT id::text, apellido, nombre, fecha_nacimiento::text
         FROM pacientes
         WHERE unaccent(upper(apellido)) ILIKE unaccent($1)
           AND deleted_at IS NULL
         LIMIT 10`,
        [`%${fila.apellidoNorm}%`],
      );

      for (const candidato of candidatos) {
        const candidatoFila = {
          apellidoNorm: candidato.apellido.toUpperCase(),
          nombreNorm: candidato.nombre.toUpperCase(),
          fechaNacimientoIso: candidato.fecha_nacimiento ?? undefined,
        } as FilaNormalizada;
        const score = scorePersona(fila, candidatoFila);
        if (score >= umbral) {
          resultados.set(fila.filaNumero, {
            filaNumero: fila.filaNumero,
            uploadId: fila.uploadId,
            tipo: "duplicado_probable",
            pacienteExistenteId: candidato.id,
            scoreSimiaridad: score,
          });
          break;
        }
      }
    }

    if (!resultados.has(fila.filaNumero)) {
      resultados.set(fila.filaNumero, {
        filaNumero: fila.filaNumero,
        uploadId: fila.uploadId,
        tipo: "sin_duplicado",
      });
    }
  }

  return resultados;
}
