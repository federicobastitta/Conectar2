import { pgTable, text, serial, integer, timestamp, doublePrecision, date } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const cajaMovimientosTable = pgTable("caja_movimientos", {
  id: serial("id").primaryKey(),
  fecha: date("fecha", { mode: "string" }).notNull(),
  pacienteId: integer("paciente_id"),
  profesionalId: integer("profesional_id"),
  turnoId: integer("turno_id"),
  tipo: text("tipo").notNull().default("turno"), // turno | sena | insumo
  concepto: text("concepto"),
  monto: doublePrecision("monto").notNull(),
  medioPago: text("medio_pago").notNull().default("efectivo"), // efectivo | tarjeta | transferencia | pago_digital
  creadoPor: integer("creado_por"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const cajaCierresTable = pgTable("caja_cierres", {
  id: serial("id").primaryKey(),
  fecha: date("fecha", { mode: "string" }).notNull().unique(),
  total: doublePrecision("total").notNull(),
  cerradaPor: integer("cerrada_por"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertCajaMovimientoSchema = createInsertSchema(cajaMovimientosTable).omit({ id: true, createdAt: true });
export type InsertCajaMovimiento = z.infer<typeof insertCajaMovimientoSchema>;
export type CajaMovimiento = typeof cajaMovimientosTable.$inferSelect;
export type CajaCierre = typeof cajaCierresTable.$inferSelect;
