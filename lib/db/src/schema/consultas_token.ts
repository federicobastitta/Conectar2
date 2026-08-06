import { pgTable, text, serial, integer, timestamp, index } from "drizzle-orm/pg-core";
import { turnosTable } from "./turnos";

// Estados del token IOMA en el modelo de consulta (spec de preparación).
// Solo ACCEPTED habilita la consulta como autorizada.
// TECHNICAL_ERROR y TIMEOUT NO significan denegación.
export const TOKEN_ESTADOS = [
  "NOT_REQUESTED",
  "PENDING",
  "VALIDATING",
  "ACCEPTED",
  "DENIED",
  "EXPIRED",
  "ALREADY_USED",
  "PATIENT_MISMATCH",
  "TECHNICAL_ERROR",
  "TIMEOUT",
  "MANUAL_REVIEW",
] as const;
export type TokenEstado = (typeof TOKEN_ESTADOS)[number];

// Estado de sincronización con El Robot (separado del estado del token).
// La contingencia de carga manual vive acá: token PENDING +
// robot_sync_status MANUAL_PRESTATION_REQUIRED / READY_TO_RETRY.
export const ROBOT_SYNC_ESTADOS = [
  "NOT_SENT",
  "SENDING",
  "PROCESSING",
  "MANUAL_PRESTATION_REQUIRED",
  "READY_TO_RETRY",
  "COMPLETED",
  "ERROR",
] as const;
export type RobotSyncEstado = (typeof ROBOT_SYNC_ESTADOS)[number];

// Campos reservados del token en el modelo de consulta.
// Desde jul 2026 se guarda también el token completo (pedido de la clínica
// para el reporte de facturación); token_masked se mantiene para pantallas.
// La validación real la hará el Robot externo cuando esté operativo
// (feature flag KLINICOS_TOKEN_VALIDATION_ENABLED).
export const consultasTokenTable = pgTable(
  "consultas_token",
  {
    id: serial("id").primaryKey(),
    consultationId: integer("consultation_id")
      .notNull()
      .unique()
      .references(() => turnosTable.id),
    coverageType: text("coverage_type"), // ej: IOMA
    affiliateNumber: text("affiliate_number"),
    tokenStatus: text("token_status").$type<TokenEstado>().notNull().default("NOT_REQUESTED"),
    tokenMasked: text("token_masked"), // solo últimos 4 (para mostrar en pantallas)
    // Token completo: pedido explícito de la clínica (jul 2026) para el
    // reporte de facturación por profesional. Antes solo se guardaba enmascarado.
    tokenCompleto: text("token_completo"),
    tokenValidatedAt: timestamp("token_validated_at", { withTimezone: true }),
    tokenValidationRequestId: text("token_validation_request_id"),
    klinicosReference: text("klinicos_reference"),
    authorizationNumber: text("authorization_number"),
    tokenFailureCode: text("token_failure_code"),
    tokenFailureMessage: text("token_failure_message"),
    robotSyncStatus: text("robot_sync_status").$type<RobotSyncEstado>().notNull().default("NOT_SENT"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [index("consultas_token_status_idx").on(t.tokenStatus)],
);

export type ConsultaToken = typeof consultasTokenTable.$inferSelect;
