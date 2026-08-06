import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { logger } from "./logger";

/**
 * Seed idempotente de arranque: códigos de ENVÍO a Conectar según la planilla
 * acordada (attached_assets/codigos1_1785459199036.pdf). Necesario porque la
 * base de producción (AWS) es distinta de la de desarrollo y el publish no
 * copia datos.
 *
 * Reglas:
 *  - Matchea por nombre EXACTO de la práctica.
 *  - Solo completa codigo_envio cuando está NULL o vacío (nunca pisa un valor
 *    ya cargado o corregido a mano); en ese caso también alinea codigos.
 *  - No crea prácticas nuevas ni toca las que no figuran en la planilla.
 */

// [nombre en catálogo, codigo_envio EXACTO planilla, codigos individuales (repeticiones = cantidad)]
export const PLANILLA_CONECTAR: ReadonlyArray<readonly [string, string, readonly string[]]> = [
  ["ECG", "170101", ["170101"]],
  ["ERGOMETRIA", "881706", ["881706"]],
  ["HOLTER", "881710", ["881710"]],
  ["MAPA", "881701", ["881701"]],
  ["EEG", "290101-290102-420102", ["290101", "290102", "420102"]],
  ["ESPIROMETRIA", "880502-880501-280102", ["880502", "880501", "280102"]],
  ["ECO TOCOGINECOLOGICA", "180104", ["180104"]],
  ["ECO TV TRANSVAGINAL", "881807", ["881807"]],
  ["ECO PARTES BLANDAS", "881806", ["881806"]],
  ["ECO CADERAS BEBE", "881803", ["881803"]],
  ["ECO MAMAS", "180106-881806", ["180106", "881806"]],
  ["ECO TIROIDES", "180110", ["180110"]],
  ["ECO TESTICULAR", "180111", ["180111"]],
  ["ECO ABDOMEN", "180112-180113", ["180112", "180113"]],
  ["ECO HBP", "180113", ["180113"]],
  ["ECO VESICAL Y/O PROSTATA", "180114", ["180114"]],
  ["ECO RENAL", "180116", ["180116"]],
  ["MAMOGRAFIA", "340601+340601+340602+340602", ["340601", "340601", "340602", "340602"]],
  ["RX CRANEO/CAVUM / SENOS PARANASALES……... ( FRENTE)", "340201", ["340201"]],
  ["RX CRANEO / SENOS PARANASALES….… ( PERFIL)", "340202", ["340202"]],
  ["RX COLUMNA CERVICAL, DORSAL Y LUMBAR……….. ( FRENTE)", "340209", ["340209"]],
  ["RX COLUMNA CERVICAL, DORSAL Y LUMBAR …………( PERFIL)", "340210", ["340210"]],
  ["RX HOMBRO / PELVIS/CADERA/ FEMUR/HUMERO……..… .(FRENTE)", "340211", ["340211"]],
  ["RX HOMBRO/PELVIS/CADERA/ FEMUR/HUMERO ……..….. ( PERFIL)", "340212", ["340212"]],
  [
    "RX CODO, ANTEBRAZO, MUÑECA, MANO, DEDOS, RODILLA,ROTULA, PIERNA, TOBILLO , PIE TODO FRENTE Y PERFIL",
    "340213",
    ["340213"],
  ],
  ["RX TORAX / PARRILLA COSTAL…..……. (FRENTE)", "340301", ["340301"]],
  ["RX TORAX/PARILLA COSTAL……..…. ( PERFIL)", "340302", ["340302"]],
  ["RX ABDOMEN ……....(FRENTE)", "340421", ["340421"]],
  ["RX ABDOMEN ………( PERFIL)", "340422", ["340422"]],
  ["DOPPLER CARDIACO - PESADO 88", "881840", ["881840"]],
  ["DOPPLER ARTERIAL MMSS O MMII- PESADO 88", "881841/A", ["881841/A"]],
  ["DOPPLER VENOSO MMSS O MMII - PESADO 88", "881841/A", ["881841/A"]],
  ["DOPPLER ARTERIAL Y VENOSO MMII O MMSS - PESADO 88", "881841/A+881841/B", ["881841/A", "881841/B"]],
  ["DOPPLER VASOS CUELLO - PESADO 88", "881841/A", ["881841/A"]],
  ["DOPPLER RENAL PESADO 88", "881842", ["881842"]],
  ["COLPOSCOPIA", "220101", ["220101"]],
  ["PAP", "150106", ["150106"]],
  ["EXTRACCION DE PUNTOS", "130110", ["130110"]],
];

// Especialidad Klinicos confirmada por el Robot (jul 2026) para el circuito
// de ecografías/imágenes: manda el código de práctica, pero fijar el literal
// evita variantes de nombre al machear en Klinicos.
export const ESPECIALIDAD_KLINICOS_IMAGENES = "IMAGENES S/C";

// Palabras que identifican turneras de imágenes por nombre (sin acentos).
const PALABRAS_TURNERA_IMAGENES = ["ECOGRAF", "DOPPLER", "IMAGEN", "RADIOLOG", "RAYOS", "MAMOGRAF", "RX"];

function normalizarNombre(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .trim();
}

/**
 * Seed idempotente de arranque: fija "IMAGENES S/C" como especialidad Klinicos
 * de las turneras de ecografía/doppler/imágenes que NO tienen especialidad
 * cargada (nunca pisa un override ya cargado a mano en la pantalla de
 * turneras). Detecta las turneras por klinicos_sector = 'IMAGENES S/C' o por
 * nombre (ECOGRAF/DOPPLER/RX/etc., comparación sin acentos hecha en JS para no
 * depender de unaccent en la base).
 */
export async function sembrarEspecialidadImagenesTurneras(): Promise<void> {
  const res = await db.execute(sql`
    SELECT id, nombre, klinicos_sector
    FROM turneras
    WHERE klinicos_especialidad IS NULL OR btrim(klinicos_especialidad) = ''
  `);
  const filas = (res.rows ?? []) as Array<{ id: number; nombre: string; klinicos_sector: string | null }>;
  const ids = filas
    .filter((f) => {
      const sector = normalizarNombre(f.klinicos_sector ?? "");
      if (sector === ESPECIALIDAD_KLINICOS_IMAGENES) return true;
      const nombre = normalizarNombre(f.nombre ?? "");
      return PALABRAS_TURNERA_IMAGENES.some((p) => nombre.includes(p));
    })
    .map((f) => f.id);
  if (ids.length === 0) {
    logger.info("seed especialidad imágenes: sin turneras para completar");
    return;
  }
  const idsPg = `{${ids.join(",")}}`;
  await db.execute(sql`
    UPDATE turneras
    SET klinicos_especialidad = ${ESPECIALIDAD_KLINICOS_IMAGENES}
    WHERE id = ANY(${idsPg}::int[])
      AND (klinicos_especialidad IS NULL OR btrim(klinicos_especialidad) = '')
  `);
  logger.info({ turneras: ids.length }, "seed especialidad imágenes: klinicos_especialidad = IMAGENES S/C completada");
}

export async function sembrarCodigosEnvioConectar(): Promise<void> {
  // La columna la crea la sincronización aditiva del esquema; si todavía no
  // existe (carrera al arrancar), salimos sin error y queda para el próximo boot.
  const col = await db.execute(sql`
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'klinicos_practicas' AND column_name = 'codigo_envio'
  `);
  if (!col.rows?.length) {
    logger.warn("seed codigos Conectar: columna codigo_envio aún no existe; se omite");
    return;
  }

  let completadas = 0;
  for (const [nombre, codigoEnvio, codigos] of PLANILLA_CONECTAR) {
    // Literal de array PG para la columna text[] (los códigos son [0-9A-Z/+-])
    const codigosPg = `{${codigos.map((c) => `"${c}"`).join(",")}}`;
    const res = await db.execute(sql`
      UPDATE klinicos_practicas
      SET codigo_envio = ${codigoEnvio},
          codigos = ${codigosPg}::text[],
          activo = true
      WHERE nombre = ${nombre}
        AND (codigo_envio IS NULL OR btrim(codigo_envio) = '')
    `);
    completadas += res.rowCount ?? 0;
  }
  if (completadas > 0) {
    logger.info({ completadas }, "seed codigos Conectar: codigo_envio completado desde la planilla");
  } else {
    logger.info("seed codigos Conectar: sin cambios (códigos ya cargados)");
  }
}
