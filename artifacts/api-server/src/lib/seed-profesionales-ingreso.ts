import { sql } from "drizzle-orm";
import { db, klinicosProfesionalesIngreso, configSistemaTable } from "@workspace/db";
import { logger } from "./logger";

// Profesionales del ingreso ambulatorio por especialidad.
// Regla vigente (Federico, 01/08/2026): las consultas de CLINICA MEDICA se
// cargan SIEMPRE con "SAEZ, IGNACIO" (nombre exacto del desplegable de
// Klinicos), sin importar qué médico atienda en Conectar. La rotación
// round-robin sigue disponible como mecanismo para otras especialidades o si
// gestión reactiva más nombres desde la DB (activo=true): elegirProfesional-
// Ingreso rota entre los ACTIVOS, así que con un solo activo devuelve siempre
// el mismo.
// El listado completo del desplegable queda sembrado (inactivo) para poder
// reactivar sin tocar código. "CANESTRO, FERREYRA" no se usa y
// "USUARIO, Medico" es una cuenta técnica del portal.
// Seed idempotente: solo inserta los que faltan; activar/desactivar o agregar
// nombres nuevos se hace desde la bandeja/DB sin tocar este archivo.
const CLINICA_MEDICA = "CLINICA MEDICA";
export const PROFESIONAL_FIJO_CLINICA_MEDICA = "SAEZ, IGNACIO";
const NOMBRES_CLINICA_MEDICA = [
  "ANDRADA, CAMILA",
  "ANNACONDIA, NAZARENO",
  "BRITOS, AGUSTIN",
  "CERVENY, VIVIANA",
  "DEL, BARCO",
  "FABIANO, DIEGO",
  "ORTEGA PINEDA, Luis Jair",
  "OSPINO, PEDRO",
  "PINTO, ROSA",
  "REINA, CIFUENTES",
  "SAEZ, IGNACIO",
  "SANGALLI, AGUSTINA",
];

// Flag de migración una sola vez: al aplicarla se desactivan todos los
// profesionales de CLINICA MEDICA salvo SAEZ. Con el flag puesto, cambios
// manuales posteriores (reactivar nombres desde la DB) se respetan.
const FLAG_MIGRACION_FIJO = "migracion_profesional_fijo_clinica_medica_v1";

// Regla Cardiología (Federico, 02/08/2026): las consultas de cardiología
// ("Cardiología", "Cardiología Lomas", "Cardiología Infantil", "Cardiología
// Demanda Espontánea") se cargan con el médico del turno si lo tiene; si no
// (demanda espontánea), se rota entre estos 5 cardiólogos del desplegable de
// Klinicos (lista completa confirmada por el usuario). Todos nacen activos.
// Pediatría (guardia pediátrica): todavía sin nombres sembrados — gestión
// debe cargar los pediatras del desplegable de Klinicos en la tabla
// klinicos_profesionales_ingreso (especialidad 'PEDIATRIA', activo=true).
// Sin activos, la validación de token pediátrica falla con mensaje claro.
const PEDIATRIA = "PEDIATRIA";

const CARDIOLOGIA = "CARDIOLOGIA";
const NOMBRES_CARDIOLOGIA = [
  "CACERES, FRANCO",
  "CASTILLO, MONICA",
  "FRANGIS, PATRICIO",
  "GIUFFRA, NESTOR",
  "GOMEZ, Leonardo Alberto",
];

export async function seedProfesionalesIngreso(): Promise<void> {
  try {
    // El índice único (especialidad, nombre) del esquema Drizzle no existe en
    // las bases AWS (drift de índices se aplica a mano): sin él, cada arranque
    // reinsertaba los 12 nombres (onConflictDoNothing no matchea nada).
    // Autocuración idempotente: dedupe conservando la fila más vieja y crear
    // el índice si falta. Con el índice presente esto es un no-op barato.
    const [idx] = (
      await db.execute(
        sql`SELECT 1 AS ok FROM pg_indexes WHERE tablename = 'klinicos_profesionales_ingreso' AND indexname = 'klinicos_prof_ingreso_unq'`,
      )
    ).rows;
    if (!idx) {
      await db.execute(sql`
        DELETE FROM klinicos_profesionales_ingreso a
        USING klinicos_profesionales_ingreso b
        WHERE a.especialidad = b.especialidad
          AND a.nombre = b.nombre
          AND a.id > b.id
      `);
      await db.execute(
        sql`CREATE UNIQUE INDEX IF NOT EXISTS klinicos_prof_ingreso_unq ON klinicos_profesionales_ingreso (especialidad, nombre)`,
      );
      logger.info("seed-profesionales-ingreso: duplicados depurados e índice único creado");
    }

    // Bases nuevas: solo SAEZ nace activo; el resto queda sembrado inactivo.
    const values = NOMBRES_CLINICA_MEDICA.map((nombre) => ({
      especialidad: CLINICA_MEDICA,
      nombre,
      activo: nombre === PROFESIONAL_FIJO_CLINICA_MEDICA,
    }));
    const insertados = await db
      .insert(klinicosProfesionalesIngreso)
      .values(values)
      .onConflictDoNothing()
      .returning({ id: klinicosProfesionalesIngreso.id });
    if (insertados.length > 0) {
      logger.info(
        { especialidad: CLINICA_MEDICA, nuevos: insertados.length },
        "seed-profesionales-ingreso: profesionales sembrados",
      );
    }

    // Cardiología: los 5 rotan (activos). Idempotente igual que arriba.
    const insertadosCardio = await db
      .insert(klinicosProfesionalesIngreso)
      .values(NOMBRES_CARDIOLOGIA.map((nombre) => ({ especialidad: CARDIOLOGIA, nombre, activo: true })))
      .onConflictDoNothing()
      .returning({ id: klinicosProfesionalesIngreso.id });
    if (insertadosCardio.length > 0) {
      logger.info(
        { especialidad: CARDIOLOGIA, nuevos: insertadosCardio.length },
        "seed-profesionales-ingreso: profesionales sembrados",
      );
    }

    // Bases existentes (rotación vieja activa): migración de una sola vez a
    // la regla "siempre SAEZ, IGNACIO" (Federico, 01/08/2026).
    const [flag] = await db
      .select({ valor: configSistemaTable.valor })
      .from(configSistemaTable)
      .where(sql`${configSistemaTable.clave} = ${FLAG_MIGRACION_FIJO}`)
      .limit(1);
    if (!flag) {
      const desactivados = await db
        .update(klinicosProfesionalesIngreso)
        .set({ activo: false })
        .where(
          sql`${klinicosProfesionalesIngreso.especialidad} = ${CLINICA_MEDICA}
              AND ${klinicosProfesionalesIngreso.nombre} <> ${PROFESIONAL_FIJO_CLINICA_MEDICA}
              AND ${klinicosProfesionalesIngreso.activo} = true`,
        )
        .returning({ id: klinicosProfesionalesIngreso.id });
      await db
        .update(klinicosProfesionalesIngreso)
        .set({ activo: true })
        .where(
          sql`${klinicosProfesionalesIngreso.especialidad} = ${CLINICA_MEDICA}
              AND ${klinicosProfesionalesIngreso.nombre} = ${PROFESIONAL_FIJO_CLINICA_MEDICA}
              AND ${klinicosProfesionalesIngreso.activo} = false`,
        );
      await db
        .insert(configSistemaTable)
        .values({ clave: FLAG_MIGRACION_FIJO, valor: "aplicada" })
        .onConflictDoNothing();
      logger.info(
        { desactivados: desactivados.length, fijo: PROFESIONAL_FIJO_CLINICA_MEDICA },
        "seed-profesionales-ingreso: migración a profesional fijo de CLINICA MEDICA aplicada",
      );
    }
  } catch (err) {
    logger.error({ err }, "seed-profesionales-ingreso: fallo (no bloquea el arranque)");
  }
}

// Round-robin atómico: elige el activo con uso más antiguo de la especialidad
// y marca su último uso en la misma operación (dos encolados concurrentes no
// repiten profesional). Devuelve null si la especialidad no tiene rotación.
// Con un solo activo (regla actual de CLINICA MEDICA) devuelve siempre ese.
// Las especialidades Conectar de clínica médica no coinciden textualmente con
// la de Klinicos ("Clínica médica Lomas de Zamora", "Guardia clínica médica",
// etc.): cualquier nombre normalizado que contenga "CLINICA MEDICA" cae en la
// regla de CLINICA MEDICA.
export async function elegirProfesionalIngreso(especialidadNormalizada: string): Promise<string | null> {
  const especialidad = especialidadNormalizada.includes(CLINICA_MEDICA)
    ? CLINICA_MEDICA
    : especialidadNormalizada.includes(CARDIOLOGIA)
      ? CARDIOLOGIA
      : especialidadNormalizada.includes("PEDIATR")
        ? PEDIATRIA
        : especialidadNormalizada;
  const [row] = await db
    .update(klinicosProfesionalesIngreso)
    .set({ ultimoUsoEn: sql`now()` })
    .where(
      sql`${klinicosProfesionalesIngreso.id} = (
        SELECT id FROM ${klinicosProfesionalesIngreso}
        WHERE activo = true AND especialidad = ${especialidad}
        ORDER BY ultimo_uso_en ASC NULLS FIRST, id ASC
        LIMIT 1
        FOR UPDATE SKIP LOCKED
      )`,
    )
    .returning({ nombre: klinicosProfesionalesIngreso.nombre });
  return row?.nombre ?? null;
}
