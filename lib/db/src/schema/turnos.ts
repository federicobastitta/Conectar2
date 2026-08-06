import { pgTable, text, serial, integer, boolean, timestamp, date, index, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { randomBytes } from "node:crypto";

// 16 chars base32-like (sin caracteres ambiguos), ~80 bits de entropía.
const QR_ALFABETO = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export function generarQrCodigo(): string {
  const bytes = randomBytes(16);
  let out = "";
  for (let i = 0; i < 16; i++) out += QR_ALFABETO[bytes[i] % 32];
  return out;
}

export const turnosTable = pgTable("turnos", {
  id: serial("id").primaryKey(),
  turneraId: integer("turnera_id").notNull(),
  pacienteId: integer("paciente_id").notNull(),
  profesionalId: integer("profesional_id"),
  fecha: date("fecha", { mode: "string" }).notNull(),
  horaInicio: text("hora_inicio").notNull(),
  horaFin: text("hora_fin").notNull(),
  estado: text("estado").notNull().default("pendiente"),
  modalidad: text("modalidad").notNull().default("presencial"),
  sobreturno: boolean("sobreturno").notNull().default(false),
  motivoConsulta: text("motivo_consulta"),
  // Región anatómica / parte del cuerpo del estudio (obligatoria al agendar
  // prácticas, jul 2026). Texto libre: "Rodilla derecha", "Tórax", etc.
  // Va al PACS como body_part dentro de procedure.
  regionAnatomica: text("region_anatomica"),
  // Datos del ingreso ambulatorio estilo Klinicos (cargados por recepción en
  // la ficha del turno, para consultas): overrides por turno + token de la orden.
  klinicosEspecialidad: text("klinicos_especialidad"),
  klinicosProfesional: text("klinicos_profesional"),
  klinicosToken: text("klinicos_token"),
  // Práctica del nomenclador IOMA elegida por recepción (klinicos_practicas.id):
  // le da al Robot los códigos de práctica para cargar la prestación en Klinicos.
  klinicosPracticaId: integer("klinicos_practica_id"),
  observaciones: text("observaciones"),
  cobertura: text("cobertura"),
  nroAfiliado: text("nro_afiliado"),
  creadoPor: text("creado_por"),
  admitidoEn: timestamp("admitido_en", { withTimezone: true }),
  // Nombre del usuario de recepción que hizo el check-in (trazabilidad visible).
  admitidoPor: text("admitido_por"),
  // Marca visual del turno (ej: "naranja" cuando se recepcionó sin token
  // validado). Solo gerencia (admin) puede quitarla con "descolorear".
  marcaColor: text("marca_color"),
  llamadoEn: timestamp("llamado_en", { withTimezone: true }),
  // Profesional que ejecutó el último llamado (cuando el usuario que llama es
  // un médico con ficha). Permite que la TV muestre el consultorio del médico
  // aunque el turno de guardia no tenga profesional propio ni titular de agenda.
  llamadoPorProfesionalId: integer("llamado_por_profesional_id"),
  // Texto opcional que la TV muestra en lugar del nombre de la agenda cuando
  // el llamado viene de Pixel con la práctica del estudio (ej: "Ergometrías").
  // Se limpia en los llamados internos para no arrastrar un valor viejo.
  llamadoPractica: text("llamado_practica"),
  atendidoEn: timestamp("atendido_en", { withTimezone: true }),
  // Cuándo el médico finalizó la consulta. Junto con llamado_en da la duración
  // real de cada atención (llamar → finalizar), que alimenta la estimación de
  // espera en sala.
  finalizadoEn: timestamp("finalizado_en", { withTimezone: true }),
  // Circuito de informes vía DiagnostiPACS
  pacsEnviadoEn: timestamp("pacs_enviado_en", { withTimezone: true }),
  pacsEstudioId: text("pacs_estudio_id"),
  pacsInformadoEn: timestamp("pacs_informado_en", { withTimezone: true }),
  // Código único para el QR del turno: el paciente lo muestra en recepción
  // y al escanearlo se abre su ficha para cargar el token.
  qrCodigo: text("qr_codigo").$defaultFn(() => generarQrCodigo()),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("turnos_qr_codigo_unique").on(t.qrCodigo),
  index("turnos_fecha_idx").on(t.fecha),
  index("turnos_turnera_fecha_idx").on(t.turneraId, t.fecha),
  index("turnos_paciente_idx").on(t.pacienteId),
  index("turnos_profesional_idx").on(t.profesionalId),
  // Anti doble-reserva a nivel DB: un solo turno activo (no cancelado/ausente)
  // por slot, salvo sobreturnos explícitos.
  uniqueIndex("turnos_slot_activo_unique")
    .on(t.turneraId, t.fecha, t.horaInicio)
    .where(sql`estado NOT IN ('cancelado', 'ausente') AND sobreturno = false`),
]);

export const insertTurnoSchema = createInsertSchema(turnosTable).omit({ id: true, createdAt: true });
export type InsertTurno = z.infer<typeof insertTurnoSchema>;
export type Turno = typeof turnosTable.$inferSelect;
