import {
  pgTable, bigserial, text, jsonb, timestamp, index,
} from "drizzle-orm/pg-core";

export const auditLog = pgTable(
  "audit_log",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    tabla: text("tabla").notNull(),
    operacion: text("operacion").notNull(),
    registroId: text("registro_id").notNull(),
    datosAnteriores: jsonb("datos_anteriores"),
    datosNuevos: jsonb("datos_nuevos"),
    actorId: text("actor_id"),
    actorOrigen: text("actor_origen"),
    ocurridoEn: timestamp("ocurrido_en", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index("idx_audit_tabla_registro").on(t.tabla, t.registroId, t.ocurridoEn),
    index("idx_audit_actor").on(t.actorId, t.ocurridoEn),
    index("idx_audit_fecha").on(t.ocurridoEn),
  ],
);

export type AuditLogEntry = typeof auditLog.$inferSelect;
