import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { logger } from "./logger";

// ── Seed idempotente: especialidades que envían al worklist de Pixel ─────────
// Activa envia_al_pacs=true (y fija modalidad_dicom si está vacía) para toda
// especialidad cuyo nombre coincida con las prácticas que Pixel procesa:
//   Imágenes: resonancia, ecografía/doppler, radiografía/rayos, mamografía, tomografía
//   Cardiología: ergometría, electrocardiograma, Holter, presurometría/MAPA, ecocardiograma
//   Otros: electroencefalograma, OCT, PAP, espirometría
//
// Reglas:
//   - NUNCA pone envia_al_pacs=false (solo suma, nunca resta).
//   - Solo completa modalidad_dicom cuando está NULL (nunca pisa un valor ya cargado).
//   - Matching sin acentos, normalizado en JS (no depende de f_unaccent en la DB).
//   - Idempotente: dos arranques seguidos producen el mismo resultado.
//
// Mejora futura (Opción C): migrar el matching a nivel de práctica del catálogo
// (campo enviaPacs en practicas_catalogo), de modo que cualquier agenda nueva
// que tenga una práctica Pixel-cubierta empiece a enviar sin configuración manual.
// Ver docs/pacs-workspace-plan.md para el diseño.

interface PatronPixel {
  /** Substring normalizado (sin acentos, mayúsculas) que debe estar en el nombre */
  patron: string;
  /** Modalidad DICOM a asignar si modalidad_dicom está NULL */
  modalidad: string;
}

// El orden importa: el primer patrón que matchee determina la modalidad.
// Patrones más específicos van antes que los genéricos.
const PATRONES: PatronPixel[] = [
  // Imágenes
  { patron: "RESONANC", modalidad: "MR" },
  { patron: "TOMOGRAF", modalidad: "CT" },
  { patron: "MAMOGRAF", modalidad: "MG" },
  { patron: "ECOCARDIOGRAMA", modalidad: "US" },
  { patron: "ECODOPPLER", modalidad: "US" },
  { patron: "EDOPPLER", modalidad: "US" }, // variante con typo frecuente en datos
  { patron: "DOPPLER", modalidad: "US" },
  { patron: "ECOGRAF", modalidad: "US" },
  { patron: "RADIOGRAF", modalidad: "CR" },
  { patron: "RAYOS", modalidad: "CR" },
  // Cardiología de función
  { patron: "ELECTROCARDIOGRAMA", modalidad: "ECG" },
  { patron: "ERGOMETR", modalidad: "ECG" },
  { patron: "HOLTER", modalidad: "ECG" },
  { patron: "PRESUROMET", modalidad: "OT" },
  // Neurofisiología / otros
  { patron: "ELECTROENCEFALOGRAMA", modalidad: "EEG" },
  { patron: "ENCEFALOGRAMA", modalidad: "EEG" },
  { patron: "ESPIROMETR", modalidad: "OT" },
  // PAP y OCT pueden no existir aún como especialidades; si se agregan, el seed
  // las activa automáticamente en el próximo arranque.
  { patron: "OCT", modalidad: "OT" },
  { patron: "PAP", modalidad: "OT" },
];

function normalizar(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .trim();
}

/** Devuelve la modalidad DICOM que corresponde al nombre, o null si no matchea. */
function modalidadParaNombre(nombre: string): { activa: true; modalidad: string } | null {
  const n = normalizar(nombre);
  // "PAP" y "OCT" son muy cortos: solo matchear si el normalizado ES esa palabra
  // o la contiene con separadores (espacio, inicio, fin) para evitar falsos positivos.
  for (const { patron, modalidad } of PATRONES) {
    if (patron === "PAP" || patron === "OCT") {
      // Match exacto o separado por espacios
      if (n === patron || n.startsWith(patron + " ") || n.endsWith(" " + patron) || n.includes(" " + patron + " ")) {
        return { activa: true, modalidad };
      }
      continue;
    }
    if (n.includes(patron)) return { activa: true, modalidad };
  }
  return null;
}

export async function seedEspecialidadesAlPacs(): Promise<void> {
  // Carga todas las especialidades de una sola consulta
  const res = await db.execute(
    sql`SELECT id, nombre, envia_al_pacs, modalidad_dicom FROM especialidades ORDER BY id`,
  );
  const filas = (res.rows ?? []) as Array<{
    id: number;
    nombre: string;
    envia_al_pacs: boolean;
    modalidad_dicom: string | null;
  }>;

  const activar: number[] = [];
  const fijarModalidad: Array<{ id: number; modalidad: string }> = [];

  for (const fila of filas) {
    const match = modalidadParaNombre(fila.nombre);
    if (!match) continue;

    // ¿Hay que activar envia_al_pacs?
    if (!fila.envia_al_pacs) {
      activar.push(fila.id);
    }
    // ¿Hay que fijar modalidad_dicom?
    if (!fila.modalidad_dicom) {
      fijarModalidad.push({ id: fila.id, modalidad: match.modalidad });
    }
  }

  if (activar.length === 0 && fijarModalidad.length === 0) {
    logger.info("seed especialidades PACS: sin cambios (todo ya configurado)");
    return;
  }

  // Activar envia_al_pacs en lote
  if (activar.length > 0) {
    const ids = activar.map(String).join(",");
    await db.execute(
      sql`UPDATE especialidades SET envia_al_pacs = true WHERE id = ANY(ARRAY[${sql.raw(ids)}]::int[]) AND NOT envia_al_pacs`,
    );
    logger.info({ activadas: activar.length, ids: activar }, "seed especialidades PACS: envia_al_pacs activado");
  }

  // Fijar modalidad_dicom donde está NULL
  for (const { id, modalidad } of fijarModalidad) {
    await db.execute(
      sql`UPDATE especialidades SET modalidad_dicom = ${modalidad} WHERE id = ${id} AND modalidad_dicom IS NULL`,
    );
  }
  if (fijarModalidad.length > 0) {
    logger.info(
      { actualizadas: fijarModalidad.length, detalle: fijarModalidad },
      "seed especialidades PACS: modalidad_dicom completada",
    );
  }
}
