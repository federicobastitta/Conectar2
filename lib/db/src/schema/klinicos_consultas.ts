import { pgTable, text, serial, integer, boolean, timestamp, index } from "drizzle-orm/pg-core";

// Procesos del flujo transaccional único consultations/process del Robot
// KLINICOS (contrato definitivo 19/07/2026, docs/robot-openapi/robot-openapi.yaml).
//
// Reglas que esta tabla garantiza del lado de Conectar:
// - request_id ÚNICO e inmutable durante todo el caso (idempotencia).
// - un consultation_id admite UN solo request_id (unique).
// - el token NUNCA se guarda: solo token_masked (últimos 4 caracteres).
export const ESTADOS_PROCESO_CONSULTA = [
  "PROCESSING",
  "TOKEN_ACCEPTED",
  "TOKEN_DENIED",
  "DATA_REQUIRED",
  "MAPPING_REQUIRED",
  "MANUAL_REVIEW",
  "TOKEN_REENTRY_REQUIRED",
  "TECHNICAL_ERROR",
] as const;
export type EstadoProcesoConsulta = (typeof ESTADOS_PROCESO_CONSULTA)[number];

export const klinicosConsultasProcesosTable = pgTable(
  "klinicos_consultas_procesos",
  {
    id: serial("id").primaryKey(),
    requestId: text("request_id").notNull().unique(),
    consultationId: text("consultation_id").notNull().unique(),
    estado: text("estado").$type<EstadoProcesoConsulta>().notNull().default("PROCESSING"),
    attemptNumber: integer("attempt_number").notNull().default(1),
    requiresManualAction: boolean("requires_manual_action").notNull().default(false),
    retryAllowed: boolean("retry_allowed").notNull().default(false),
    prestationCreated: boolean("prestation_created").notNull().default(false),
    missingFields: text("missing_fields"), // JSON string[] (solo DATA_REQUIRED)
    mappingRequired: text("mapping_required"), // JSON MapeoPendiente[] (solo MAPPING_REQUIRED)
    reasonCode: text("reason_code"),
    reasonMessage: text("reason_message"),
    authorizationNumber: text("authorization_number"),
    klinicosReference: text("klinicos_reference"),
    tokenMasked: text("token_masked"), // solo últimos 4, NUNCA el token completo
    practiceId: text("practice_id"),
    practiceCode: text("practice_code"),
    pacienteDni: text("paciente_dni"),
    scheduledAt: text("scheduled_at"), // ISO con -03:00, tal como se envió
    esPrueba: boolean("es_prueba").notNull().default(true), // pantalla admin (no productivo)
    validatedAt: timestamp("validated_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [index("klinicos_consultas_procesos_estado_idx").on(t.estado)],
);

export type KlinicosConsultaProceso = typeof klinicosConsultasProcesosTable.$inferSelect;
