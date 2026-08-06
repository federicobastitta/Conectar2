import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { logger } from "./logger";

/**
 * Migración idempotente de arranque para la certificación sandbox del Robot
 * Klinicos. Solo CREA la tabla y sus índices si no existen; nunca borra ni
 * reemplaza objetos existentes. El DDL replica exactamente el aplicado en
 * desarrollo (ver lib/db/src/schema/klinicos_consultas.ts).
 */
export async function migrarKlinicosConsultasProcesos(): Promise<void> {
  const existe = await db.execute(
    sql`SELECT to_regclass('public.klinicos_consultas_procesos') AS tabla`,
  );
  const fila = (existe.rows?.[0] ?? {}) as Record<string, unknown>;
  if (fila["tabla"]) {
    logger.info("migraciones: klinicos_consultas_procesos ya existe, sin cambios");
    return;
  }

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS klinicos_consultas_procesos (
      id serial PRIMARY KEY,
      request_id text NOT NULL,
      consultation_id text NOT NULL,
      estado text NOT NULL DEFAULT 'PROCESSING',
      attempt_number integer NOT NULL DEFAULT 1,
      requires_manual_action boolean NOT NULL DEFAULT false,
      retry_allowed boolean NOT NULL DEFAULT false,
      prestation_created boolean NOT NULL DEFAULT false,
      missing_fields text,
      mapping_required text,
      reason_code text,
      reason_message text,
      authorization_number text,
      klinicos_reference text,
      token_masked text,
      practice_id text,
      practice_code text,
      paciente_dni text,
      scheduled_at text,
      es_prueba boolean NOT NULL DEFAULT true,
      validated_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT klinicos_consultas_procesos_request_id_key UNIQUE (request_id),
      CONSTRAINT klinicos_consultas_procesos_consultation_id_key UNIQUE (consultation_id)
    )
  `);
  await db.execute(
    sql`CREATE INDEX IF NOT EXISTS klinicos_consultas_procesos_estado_idx ON klinicos_consultas_procesos (estado)`,
  );
  logger.info("migraciones: klinicos_consultas_procesos creada");
}

/**
 * Migración idempotente de arranque para la cola de envío de órdenes de
 * estudio al Robot Klinicos (push saliente). Replica el DDL aplicado en dev
 * (ver lib/db/src/schema/robot_ordenes.ts).
 */
export async function migrarRobotOrdenesEnvios(): Promise<void> {
  const existe = await db.execute(sql`SELECT to_regclass('public.robot_ordenes_envios') AS tabla`);
  const fila = (existe.rows?.[0] ?? {}) as Record<string, unknown>;
  if (fila["tabla"]) {
    logger.info("migraciones: robot_ordenes_envios ya existe, sin cambios");
    return;
  }

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS robot_ordenes_envios (
      id serial PRIMARY KEY,
      orden_id integer NOT NULL,
      estado text NOT NULL DEFAULT 'pendiente',
      intentos integer NOT NULL DEFAULT 0,
      ultimo_error text,
      robot_respuesta text,
      ultimo_intento_en timestamptz,
      proximo_intento_en timestamptz DEFAULT now(),
      enviado_en timestamptz,
      creado_en timestamptz NOT NULL DEFAULT now(),
      actualizado_en timestamptz NOT NULL DEFAULT now()
    )
  `);
  await db.execute(
    sql`CREATE UNIQUE INDEX IF NOT EXISTS robot_ordenes_envios_orden_uidx ON robot_ordenes_envios (orden_id)`,
  );
  await db.execute(
    sql`CREATE INDEX IF NOT EXISTS robot_ordenes_envios_estado_proximo_idx ON robot_ordenes_envios (estado, proximo_intento_en)`,
  );
  logger.info("migraciones: robot_ordenes_envios creada");
}

/**
 * Migración idempotente de arranque para la cola de envío de certificados a
 * la app del paciente. Replica el DDL aplicado en dev (ver
 * lib/db/src/schema/certificados_app.ts).
 */
export async function migrarCertificadosAppEnvios(): Promise<void> {
  const existe = await db.execute(sql`SELECT to_regclass('public.certificados_app_envios') AS tabla`);
  const fila = (existe.rows?.[0] ?? {}) as Record<string, unknown>;
  if (fila["tabla"]) {
    logger.info("migraciones: certificados_app_envios ya existe, sin cambios");
    return;
  }

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS certificados_app_envios (
      id serial PRIMARY KEY,
      certificado_id integer NOT NULL,
      estado text NOT NULL DEFAULT 'pendiente',
      intentos integer NOT NULL DEFAULT 0,
      ultimo_error text,
      app_respuesta text,
      ultimo_intento_en timestamptz,
      proximo_intento_en timestamptz DEFAULT now(),
      enviado_en timestamptz,
      creado_en timestamptz NOT NULL DEFAULT now(),
      actualizado_en timestamptz NOT NULL DEFAULT now()
    )
  `);
  await db.execute(
    sql`CREATE UNIQUE INDEX IF NOT EXISTS certificados_app_envios_cert_uidx ON certificados_app_envios (certificado_id)`,
  );
  await db.execute(
    sql`CREATE INDEX IF NOT EXISTS certificados_app_envios_estado_proximo_idx ON certificados_app_envios (estado, proximo_intento_en)`,
  );
  logger.info("migraciones: certificados_app_envios creada");
}

/**
 * Migración idempotente de arranque para las indicaciones al paciente (plan
 * de atención) y su cola de envío a la app. Replica el DDL aplicado en dev
 * (ver lib/db/src/schema/indicaciones.ts).
 */
export async function migrarIndicacionesPaciente(): Promise<void> {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS indicaciones_pacientes (
      id serial PRIMARY KEY,
      patient_id integer NOT NULL,
      professional_id integer NOT NULL,
      consultation_id integer,
      estudios text,
      medicamentos text,
      otras_indicaciones text,
      verification_code text NOT NULL,
      created_by integer,
      created_at timestamptz NOT NULL DEFAULT now(),
      fecha date NOT NULL DEFAULT ((now() AT TIME ZONE 'America/Argentina/Buenos_Aires')::date)
    )
  `);
  // Columna fecha (día argentino) para el invariante "una indicación por
  // paciente+profesional+día": las expresiones AT TIME ZONE no son IMMUTABLE,
  // por eso es una columna real y no un índice funcional.
  await db.execute(sql`
    ALTER TABLE indicaciones_pacientes
      ADD COLUMN IF NOT EXISTS fecha date NOT NULL
      DEFAULT ((now() AT TIME ZONE 'America/Argentina/Buenos_Aires')::date)
  `);
  await db.execute(sql`
    UPDATE indicaciones_pacientes
      SET fecha = (created_at AT TIME ZONE 'America/Argentina/Buenos_Aires')::date
      WHERE fecha <> (created_at AT TIME ZONE 'America/Argentina/Buenos_Aires')::date
  `);
  await db.execute(
    sql`CREATE UNIQUE INDEX IF NOT EXISTS indicaciones_pacientes_dia_uidx ON indicaciones_pacientes (patient_id, professional_id, fecha)`,
  );
  await db.execute(
    sql`CREATE INDEX IF NOT EXISTS indicaciones_pacientes_patient_idx ON indicaciones_pacientes (patient_id, created_at)`,
  );
  await db.execute(
    sql`CREATE UNIQUE INDEX IF NOT EXISTS indicaciones_pacientes_codigo_uidx ON indicaciones_pacientes (verification_code)`,
  );
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS indicaciones_app_envios (
      id serial PRIMARY KEY,
      indicacion_id integer NOT NULL,
      estado text NOT NULL DEFAULT 'pendiente',
      intentos integer NOT NULL DEFAULT 0,
      ultimo_error text,
      app_respuesta text,
      ultimo_intento_en timestamptz,
      proximo_intento_en timestamptz DEFAULT now(),
      enviado_en timestamptz,
      creado_en timestamptz NOT NULL DEFAULT now(),
      actualizado_en timestamptz NOT NULL DEFAULT now()
    )
  `);
  await db.execute(
    sql`CREATE UNIQUE INDEX IF NOT EXISTS indicaciones_app_envios_ind_uidx ON indicaciones_app_envios (indicacion_id)`,
  );
  await db.execute(
    sql`CREATE INDEX IF NOT EXISTS indicaciones_app_envios_estado_proximo_idx ON indicaciones_app_envios (estado, proximo_intento_en)`,
  );
  logger.info("migraciones: indicaciones_pacientes / indicaciones_app_envios verificadas");
}

// Valoración de la atención por el paciente (promedio de satisfacción).
// Una fila por consulta, con token único para responder desde la app y
// campos de cola para empujar la invitación. Idempotente.
export async function migrarValoracionesAtencion(): Promise<void> {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS valoraciones_atencion (
      id serial PRIMARY KEY,
      encounter_id integer NOT NULL,
      paciente_id integer NOT NULL,
      profesional_id integer NOT NULL,
      token text NOT NULL,
      puntaje integer,
      comentario text,
      calificado_en timestamptz,
      estado_envio text NOT NULL DEFAULT 'pendiente',
      intentos integer NOT NULL DEFAULT 0,
      ultimo_error text,
      ultimo_intento_en timestamptz,
      proximo_intento_en timestamptz DEFAULT now(),
      enviado_en timestamptz,
      creado_en timestamptz NOT NULL DEFAULT now(),
      actualizado_en timestamptz NOT NULL DEFAULT now()
    )
  `);
  await db.execute(
    sql`CREATE UNIQUE INDEX IF NOT EXISTS valoraciones_atencion_encounter_uidx ON valoraciones_atencion (encounter_id)`,
  );
  await db.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS valoraciones_atencion_token_uidx ON valoraciones_atencion (token)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS valoraciones_atencion_prof_idx ON valoraciones_atencion (profesional_id)`);
  await db.execute(
    sql`CREATE INDEX IF NOT EXISTS valoraciones_atencion_envio_idx ON valoraciones_atencion (estado_envio, proximo_intento_en)`,
  );
  await db.execute(sql`
    DO $$ BEGIN
      ALTER TABLE valoraciones_atencion ADD CONSTRAINT valoraciones_puntaje_rango CHECK (puntaje BETWEEN 1 AND 5);
    EXCEPTION WHEN duplicate_object THEN NULL; END $$
  `);
  logger.info("migraciones: valoraciones_atencion verificada");
}

// Trazabilidad de derivaciones internas: el estado legado "emitida" pasa a
// "pedido" (pedido → agendado → realizado → informado). Idempotente.
export async function migrarDerivacionesTrazabilidad(): Promise<void> {
  await db.execute(sql`UPDATE referrals SET status = 'pedido' WHERE status = 'emitida'`);
  await db.execute(sql`ALTER TABLE referrals ALTER COLUMN status SET DEFAULT 'pedido'`);
  logger.info("migraciones: trazabilidad de derivaciones verificada");
}

// Salas de llamado: salas de espera con pantalla TV propia. El médico elige
// desde qué sala se anuncia su llamado. Idempotente.
export async function migrarSalasLlamado(): Promise<void> {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS salas_llamado (
      id serial PRIMARY KEY,
      nombre text NOT NULL,
      detalle text,
      activa boolean NOT NULL DEFAULT true
    )
  `);
  await db.execute(sql`ALTER TABLE profesionales ADD COLUMN IF NOT EXISTS sala_llamado_id integer`);
  // FK con SET NULL: si se borra la sala, los médicos quedan sin sala asignada.
  await db.execute(sql`
    DO $$ BEGIN
      ALTER TABLE profesionales
        ADD CONSTRAINT profesionales_sala_llamado_fk
        FOREIGN KEY (sala_llamado_id) REFERENCES salas_llamado(id) ON DELETE SET NULL;
    EXCEPTION WHEN duplicate_object THEN NULL; END $$
  `);
  logger.info("migraciones: salas_llamado verificada");
}

// Aprobación y firma de planillas IOMA de alta complejidad: estado de firma en
// study_orders + log inmutable de eventos de firma. Idempotente.
export async function migrarFirmaOrdenes(): Promise<void> {
  await db.execute(sql`ALTER TABLE study_orders ADD COLUMN IF NOT EXISTS firma_estado text NOT NULL DEFAULT 'pendiente_firma'`);
  await db.execute(sql`ALTER TABLE study_orders ADD COLUMN IF NOT EXISTS firma_version integer NOT NULL DEFAULT 1`);
  await db.execute(sql`ALTER TABLE study_orders ADD COLUMN IF NOT EXISTS firmado_en timestamptz`);
  await db.execute(sql`ALTER TABLE study_orders ADD COLUMN IF NOT EXISTS firmado_por integer`);
  await db.execute(sql`ALTER TABLE study_orders ADD COLUMN IF NOT EXISTS firma_hash text`);
  await db.execute(sql`ALTER TABLE study_orders ADD COLUMN IF NOT EXISTS firma_motivo_rechazo text`);
  await db.execute(sql`ALTER TABLE study_orders ADD COLUMN IF NOT EXISTS reemplaza_orden_id integer`);
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS study_orders_firma_log (
      id serial PRIMARY KEY,
      order_id integer NOT NULL,
      version integer NOT NULL,
      accion text NOT NULL,
      estado_anterior text NOT NULL,
      estado_nuevo text NOT NULL,
      hash text,
      usuario_id integer NOT NULL,
      profesional_id integer NOT NULL,
      detalle text,
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  logger.info("migraciones: firma de ordenes verificada");
}

/**
 * Migración idempotente para la antesala de guardia virtual (videollamadas IOMA).
 * Crea guardia_virtual_sesiones y sus índices si no existen.
 */
export async function migrarGuardiaVirtual(): Promise<void> {
  const existe = await db.execute(
    sql`SELECT to_regclass('public.guardia_virtual_sesiones') AS tabla`,
  );
  const fila = (existe.rows?.[0] ?? {}) as Record<string, unknown>;
  if (fila["tabla"]) {
    // La tabla puede venir de una versión anterior sin las columnas nuevas.
    // Regla: toda columna nueva de esta tabla se agrega acá Y en el CREATE de abajo.
    await db.execute(
      sql`ALTER TABLE guardia_virtual_sesiones ADD COLUMN IF NOT EXISTS modalidad text NOT NULL DEFAULT 'videollamada'`,
    );
    await db.execute(
      sql`ALTER TABLE guardia_virtual_sesiones ADD COLUMN IF NOT EXISTS guardia text NOT NULL DEFAULT 'clinica'`,
    );
    logger.info("migraciones: guardia_virtual_sesiones ya existe, columnas al día");
    return;
  }
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS guardia_virtual_sesiones (
      id              serial PRIMARY KEY,
      sesion_token    text NOT NULL,
      dni             text NOT NULL,
      nombre          text NOT NULL,
      apellido        text NOT NULL,
      telefono        text,
      cobertura       text NOT NULL DEFAULT 'IOMA',
      ip_origen       text,
      estado          text NOT NULL DEFAULT 'pre_registro',
      modalidad       text NOT NULL DEFAULT 'videollamada',
      guardia         text NOT NULL DEFAULT 'clinica',
      token_ioma_enmascarado text,
      token_ioma_estado text,
      nro_bono        text,
      turno_id        integer REFERENCES turnos(id),
      klinicos_trabajo_id integer,
      expira_en       timestamptz NOT NULL,
      creado_en       timestamptz NOT NULL DEFAULT now(),
      actualizado_en  timestamptz NOT NULL DEFAULT now()
    )
  `);
  await db.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS guardia_virtual_sesiones_token_uidx ON guardia_virtual_sesiones (sesion_token)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS guardia_virtual_sesiones_dni_idx ON guardia_virtual_sesiones (dni, creado_en)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS guardia_virtual_sesiones_turno_idx ON guardia_virtual_sesiones (turno_id)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS guardia_virtual_sesiones_estado_idx ON guardia_virtual_sesiones (estado, expira_en)`);
  logger.info("migraciones: guardia_virtual_sesiones creada");
}
