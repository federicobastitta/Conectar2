import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { logger } from "./logger";

// ── Migration runner con tracking ─────────────────────────────────────────
// Tabla `conectar_migraciones` como registro de aplicadas.
// Las migraciones están definidas como constantes (no archivos) para funcionar
// en cualquier entorno sin filesystem específico (Replit dev, AWS RDS, etc.).
// Reglas: nunca borra ni reemplaza objetos existentes; siempre CREATE IF NOT
// EXISTS; idempotente para reintentos; solo admin puede disparar via API.

interface Migracion {
  id: string; // e.g. "001_klinicos_outbox"
  descripcion: string;
  sentencias: string[]; // DDL statements in order
}

const MIGRACIONES: Migracion[] = [
  {
    id: "001_klinicos_eventos_salida",
    descripcion: "Bandeja de salida al Robot — outbox transaccional de eventos de turno",
    sentencias: [
      `CREATE TABLE IF NOT EXISTS klinicos_eventos_salida (
        id serial PRIMARY KEY,
        turno_id integer NOT NULL,
        version integer NOT NULL,
        tipo_evento text NOT NULL,
        payload jsonb NOT NULL,
        estado text NOT NULL DEFAULT 'pendiente',
        intentos integer NOT NULL DEFAULT 0,
        ultimo_intento_en timestamptz,
        proximo_intento_en timestamptz DEFAULT now(),
        robot_confirmacion_id text,
        robot_confirmado_en timestamptz,
        error_texto text,
        creado_en timestamptz NOT NULL DEFAULT now(),
        actualizado_en timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT klinicos_ev_salida_turno_version_uidx UNIQUE (turno_id, version)
      )`,
      `CREATE INDEX IF NOT EXISTS klinicos_ev_salida_estado_proximo_idx
        ON klinicos_eventos_salida (estado, proximo_intento_en)`,
      `CREATE INDEX IF NOT EXISTS klinicos_ev_salida_turno_idx
        ON klinicos_eventos_salida (turno_id)`,
    ],
  },
  {
    id: "002_klinicos_estado_robot",
    descripcion: "Estado operativo del Robot por turno (callback del Robot a Conectar)",
    sentencias: [
      `CREATE TABLE IF NOT EXISTS klinicos_estado_robot (
        id serial PRIMARY KEY,
        turno_id integer NOT NULL,
        estado_operativo text NOT NULL DEFAULT 'sin_evento',
        klinicos_ingreso_id text,
        klinicos_ingreso_url text,
        ultimo_evento_id integer,
        ultimo_reporte_en timestamptz,
        detalle_robot text,
        creado_en timestamptz NOT NULL DEFAULT now(),
        actualizado_en timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT klinicos_estado_robot_turno_uidx UNIQUE (turno_id)
      )`,
    ],
  },
  {
    id: "003_klinicos_equivalencias",
    descripcion: "Tablas de equivalencia Conectar → Klinicos (sedes, especialidades, profesionales)",
    sentencias: [
      `CREATE TABLE IF NOT EXISTS klinicos_eq_sedes (
        id serial PRIMARY KEY,
        sede_id integer NOT NULL,
        klinicos_establecimiento text NOT NULL,
        klinicos_sector text,
        activo boolean NOT NULL DEFAULT true,
        creado_en timestamptz NOT NULL DEFAULT now(),
        actualizado_en timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT klinicos_eq_sedes_sede_uidx UNIQUE (sede_id)
      )`,
      `CREATE TABLE IF NOT EXISTS klinicos_eq_especialidades (
        id serial PRIMARY KEY,
        especialidad_id integer NOT NULL,
        klinicos_especialidad text NOT NULL,
        activo boolean NOT NULL DEFAULT true,
        creado_en timestamptz NOT NULL DEFAULT now(),
        actualizado_en timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT klinicos_eq_especialidades_esp_uidx UNIQUE (especialidad_id)
      )`,
      `CREATE TABLE IF NOT EXISTS klinicos_eq_profesionales (
        id serial PRIMARY KEY,
        profesional_id integer NOT NULL,
        klinicos_profesional_nombre text NOT NULL,
        activo boolean NOT NULL DEFAULT true,
        creado_en timestamptz NOT NULL DEFAULT now(),
        actualizado_en timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT klinicos_eq_profesionales_prof_uidx UNIQUE (profesional_id)
      )`,
    ],
  },
  {
    id: "004_klinicos_eventos_log",
    descripcion: "Auditoría de la bandeja de salida: fecha prevista, real, timezone, resultado",
    sentencias: [
      `CREATE TABLE IF NOT EXISTS klinicos_eventos_log (
        id serial PRIMARY KEY,
        evento_id integer NOT NULL,
        turno_id integer NOT NULL,
        accion text NOT NULL,
        estado_antes text,
        estado_despues text,
        fecha_prevista timestamptz,
        fecha_real_intento timestamptz,
        timezone text NOT NULL DEFAULT 'America/Argentina/Buenos_Aires',
        resultado text,
        detalle text,
        creado_en timestamptz NOT NULL DEFAULT now()
      )`,
      `CREATE INDEX IF NOT EXISTS klinicos_eventos_log_evento_idx ON klinicos_eventos_log (evento_id)`,
      `CREATE INDEX IF NOT EXISTS klinicos_eventos_log_turno_idx ON klinicos_eventos_log (turno_id)`,
    ],
  },
  {
    id: "005_alephoo_importaciones",
    descripcion: "Sesiones de importación Alephoo y filas de conciliación por turno",
    sentencias: [
      `CREATE TABLE IF NOT EXISTS alephoo_importaciones (
        id serial PRIMARY KEY,
        nombre_archivo text NOT NULL,
        fecha_turno text NOT NULL,
        total_filas integer NOT NULL DEFAULT 0,
        procesados integer NOT NULL DEFAULT 0,
        creados_pacientes integer NOT NULL DEFAULT 0,
        reutilizados_pacientes integer NOT NULL DEFAULT 0,
        creados_turnos integer NOT NULL DEFAULT 0,
        reutilizados_turnos integer NOT NULL DEFAULT 0,
        excluidos integer NOT NULL DEFAULT 0,
        sin_equivalencia integer NOT NULL DEFAULT 0,
        bandeja_revision integer NOT NULL DEFAULT 0,
        errores integer NOT NULL DEFAULT 0,
        estado text NOT NULL DEFAULT 'iniciando',
        iniciado_en timestamptz NOT NULL DEFAULT now(),
        finalizado_en timestamptz,
        ultimo_proceso_en timestamptz,
        creado_por text,
        resumen jsonb
      )`,
      `CREATE TABLE IF NOT EXISTS alephoo_importaciones_filas (
        id serial PRIMARY KEY,
        importacion_id integer NOT NULL,
        nro_fila integer NOT NULL,
        origen_estado text,
        origen_apellido text,
        origen_nombre text,
        origen_dni text,
        origen_hc text,
        origen_fecha text,
        origen_hora text,
        origen_sede text,
        origen_especialidad text,
        origen_medico text,
        origen_medico_dni text,
        origen_consultorio text,
        origen_cobertura text,
        origen_afiliado text,
        origen_plan text,
        resultado text,
        paciente_id integer,
        turno_id integer,
        evento_id integer,
        alertas text[],
        detalle text,
        creado_en timestamptz NOT NULL DEFAULT now()
      )`,
      `CREATE INDEX IF NOT EXISTS alephoo_import_filas_importacion_idx ON alephoo_importaciones_filas (importacion_id)`,
      `CREATE INDEX IF NOT EXISTS alephoo_import_filas_turno_idx ON alephoo_importaciones_filas (turno_id)`,
      `CREATE INDEX IF NOT EXISTS alephoo_import_filas_resultado_idx ON alephoo_importaciones_filas (resultado)`,
    ],
  },
];

// ── Tabla de tracking ─────────────────────────────────────────────────────

async function asegurarTablaMigraciones(): Promise<void> {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS conectar_migraciones (
      id text PRIMARY KEY,
      descripcion text,
      aplicado_en timestamptz NOT NULL DEFAULT now()
    )
  `);
}

async function migAplicadas(): Promise<Set<string>> {
  try {
    const rows = await db.execute(sql`SELECT id FROM conectar_migraciones`);
    return new Set((rows.rows as Array<{ id: string }>).map((r) => r.id));
  } catch {
    return new Set();
  }
}

// ── API pública ───────────────────────────────────────────────────────────

export interface EstadoMigracion {
  id: string;
  descripcion: string;
  estado: "aplicada" | "pendiente";
  aplicadoEn?: string;
}

export interface EstadoInfraestructura {
  db: { ok: boolean; error?: string };
  storage: { ok: boolean; bucketId?: string; error?: string };
  migraciones: {
    total: number;
    aplicadas: number;
    pendientes: number;
    detalle: EstadoMigracion[];
  };
  verificadoEn: string;
}

export async function obtenerEstado(): Promise<EstadoInfraestructura> {
  const ahora = new Date().toISOString();

  // DB check
  let dbOk = false;
  let dbError: string | undefined;
  let aplicadasMap: Map<string, string> = new Map();
  try {
    await asegurarTablaMigraciones();
    const rows = await db.execute(
      sql`SELECT id, aplicado_en FROM conectar_migraciones ORDER BY aplicado_en`,
    );
    rows.rows.forEach((r) => {
      const row = r as { id: string; aplicado_en: string };
      aplicadasMap.set(row.id, row.aplicado_en);
    });
    dbOk = true;
  } catch (err) {
    dbError = err instanceof Error ? err.message : String(err);
  }

  // Storage check
  let storageOk = false;
  let storageError: string | undefined;
  const bucketId = process.env.DEFAULT_OBJECT_STORAGE_BUCKET_ID;
  if (!bucketId) {
    storageError = "DEFAULT_OBJECT_STORAGE_BUCKET_ID no configurado";
  } else {
    try {
      const { Storage } = await import("@google-cloud/storage");
      const client = new Storage();
      const [exists] = await client.bucket(bucketId).exists();
      storageOk = exists;
      if (!exists) storageError = `Bucket ${bucketId} no existe`;
    } catch (err) {
      storageError = err instanceof Error ? err.message : String(err);
    }
  }

  const detalle: EstadoMigracion[] = MIGRACIONES.map((m) => {
    const aplicadoEn = aplicadasMap.get(m.id);
    return {
      id: m.id,
      descripcion: m.descripcion,
      estado: aplicadoEn ? "aplicada" : "pendiente",
      aplicadoEn,
    };
  });

  return {
    db: { ok: dbOk, error: dbError },
    storage: {
      ok: storageOk,
      bucketId: bucketId ? `${bucketId.slice(0, 8)}…` : undefined,
      error: storageError,
    },
    migraciones: {
      total: MIGRACIONES.length,
      aplicadas: detalle.filter((d) => d.estado === "aplicada").length,
      pendientes: detalle.filter((d) => d.estado === "pendiente").length,
      detalle,
    },
    verificadoEn: ahora,
  };
}

export async function aplicarMigraciones(): Promise<{
  aplicadas: string[];
  errores: Array<{ id: string; error: string }>;
}> {
  await asegurarTablaMigraciones();
  const aplicadas = await migAplicadas();
  const resultado: { aplicadas: string[]; errores: Array<{ id: string; error: string }> } = {
    aplicadas: [],
    errores: [],
  };

  for (const mig of MIGRACIONES) {
    if (aplicadas.has(mig.id)) continue;

    logger.info({ migId: mig.id }, "migraciones: aplicando %s", mig.id);
    try {
      for (const sentencia of mig.sentencias) {
        await db.execute(sql.raw(sentencia));
      }
      await db.execute(
        sql`INSERT INTO conectar_migraciones (id, descripcion) VALUES (${mig.id}, ${mig.descripcion})
            ON CONFLICT (id) DO NOTHING`,
      );
      resultado.aplicadas.push(mig.id);
      logger.info({ migId: mig.id }, "migraciones: %s aplicada OK", mig.id);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      resultado.errores.push({ id: mig.id, error: msg });
      logger.error({ migId: mig.id, err }, "migraciones: error aplicando %s", mig.id);
      break; // no continuar si una falla (preservar orden)
    }
  }
  return resultado;
}

// Función de arranque idempotente para llamar desde index.ts
export async function iniciarMigraciones(): Promise<void> {
  try {
    const res = await aplicarMigraciones();
    if (res.aplicadas.length > 0) {
      logger.info({ aplicadas: res.aplicadas }, "migraciones: %d aplicadas", res.aplicadas.length);
    }
    if (res.errores.length > 0) {
      logger.error({ errores: res.errores }, "migraciones: %d con error", res.errores.length);
    }
  } catch (err) {
    logger.error({ err }, "migraciones: fallo crítico al iniciar");
  }
}
