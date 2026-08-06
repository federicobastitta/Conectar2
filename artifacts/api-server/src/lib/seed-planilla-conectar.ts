import { eq } from "drizzle-orm";
import { db, klinicosPracticas } from "@workspace/db";
import { logger } from "./logger";

// ── Catálogo completo de estudios según la planilla Conectar ──────────────
// Pedido del Robot Klinicos (jul 2026, "Sandoval"): TODAS las prácticas
// cargadas en el catálogo con su codigo_envio EXACTO de la planilla (con
// guiones, barras y signos + incluidos) — es la llave con la que el robot
// identifica qué cargar en Klinicos. Seed idempotente de arranque: matchea
// por nombre exacto, actualiza codigo_envio + codigos y crea las que faltan.
// Las consultas de especialidad NO llevan código de planilla (circuito
// propio del robot).

// [nombre en catálogo, codigo_envio EXACTO planilla, codigos individuales (repeticiones = cantidad)]
const PLANILLA: Array<[string, string, string[]]> = [
  // Cardiología
  ["ECG", "170101", ["170101"]],
  ["ERGOMETRIA", "881706", ["881706"]],
  ["HOLTER", "881710", ["881710"]],
  ["MAPA", "881701", ["881701"]],
  // Neurología (dos combos vigentes de EEG, ambos textuales de la planilla)
  ["EEG", "290101-290102-420102", ["290101", "290102", "420102"]],
  ["EEG (290101-202102)", "290101-202102", ["290101", "202102"]],
  // Neumonología
  ["ESPIROMETRIA", "880502-880501-280102", ["880502", "880501", "280102"]],
  // Ecografías
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
  // Mamografía
  ["MAMOGRAFIA", "340601+340601+340602+340602", ["340601", "340601", "340602", "340602"]],
  // Rayos
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
  // Doppler
  ["DOPPLER CARDIACO - PESADO 88", "881840", ["881840"]],
  ["DOPPLER ARTERIAL MMSS O MMII- PESADO 88", "881841/A", ["881841/A"]],
  ["DOPPLER VENOSO MMSS O MMII - PESADO 88", "881841/A", ["881841/A"]],
  ["DOPPLER ARTERIAL Y VENOSO MMII O MMSS - PESADO 88", "881841/A+881841/B", ["881841/A", "881841/B"]],
  ["DOPPLER VASOS CUELLO - PESADO 88", "881841/A", ["881841/A"]],
  ["DOPPLER RENAL PESADO 88", "881842", ["881842"]],
  // Otras
  ["COLPOSCOPIA", "220101", ["220101"]],
  ["PAP", "150106", ["150106"]],
  ["EXTRACCION DE PUNTOS", "130110", ["130110"]],
];

/** Aplica la planilla al catálogo. Nunca lanza: loguea y sigue. */
export async function seedPlanillaConectar(): Promise<void> {
  try {
    let actualizadas = 0;
    let creadas = 0;
    for (const [nombre, codigoEnvio, codigos] of PLANILLA) {
      const [existente] = await db
        .select({
          id: klinicosPracticas.id,
          codigoEnvio: klinicosPracticas.codigoEnvio,
          codigos: klinicosPracticas.codigos,
          activo: klinicosPracticas.activo,
        })
        .from(klinicosPracticas)
        .where(eq(klinicosPracticas.nombre, nombre))
        .limit(1);
      if (existente) {
        const igual =
          existente.codigoEnvio === codigoEnvio &&
          JSON.stringify(existente.codigos ?? []) === JSON.stringify(codigos) &&
          existente.activo;
        if (!igual) {
          await db
            .update(klinicosPracticas)
            .set({ codigoEnvio, codigos, activo: true })
            .where(eq(klinicosPracticas.id, existente.id));
          actualizadas++;
        }
      } else {
        await db.insert(klinicosPracticas).values({ nombre, codigoEnvio, codigos });
        creadas++;
      }
    }
    logger.info({ actualizadas, creadas }, "seed planilla Conectar aplicado al catálogo de prácticas");
  } catch (err) {
    logger.error({ err }, "No se pudo aplicar el seed de la planilla Conectar");
  }
}
