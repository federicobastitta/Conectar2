import { pgTable, text, serial, integer, timestamp, unique, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

// Estudios cuya fuente de verdad es un sistema externo (Phir-it).
// Conectar NO actúa como PACS: solo refleja el estado (pendiente | informado),
// vincula el estudio a la ficha del paciente y dispara la comunicación.
export const estudiosExternosTable = pgTable(
  "estudios_externos",
  {
    id: serial("id").primaryKey(),
    origen: text("origen").notNull().default("phirit"),
    externalId: text("external_id").notNull(),
    patientId: integer("patient_id").notNull(),
    descripcion: text("descripcion"),
    estado: text("estado").notNull().default("pendiente"),
    informeUrl: text("informe_url"),
    // Fecha/hora del último cambio de estado reportado por el sistema externo
    estadoCambiadoEn: timestamp("estado_cambiado_en", { withTimezone: true }),
    informadoEn: timestamp("informado_en", { withTimezone: true }),
    // Dedupe de notificación: si no es null, el WhatsApp de "informe disponible" ya se envió
    notificadoEn: timestamp("notificado_en", { withTimezone: true }),
    notificacionId: integer("notificacion_id"),
    // PDF del informe descargado del portal Phir-it y guardado en la nube
    // (path /objects/uploads/<uuid>); null si todavía no se descargó.
    informePdfPath: text("informe_pdf_path"),
    informePdfEn: timestamp("informe_pdf_en", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("estudios_externos_origen_external_id_unique").on(t.origen, t.externalId),
    index("estudios_externos_patient_idx").on(t.patientId),
  ],
);

export const insertEstudioExternoSchema = createInsertSchema(estudiosExternosTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertEstudioExterno = z.infer<typeof insertEstudioExternoSchema>;
export type EstudioExterno = typeof estudiosExternosTable.$inferSelect;
