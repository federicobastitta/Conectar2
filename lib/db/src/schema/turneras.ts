import { pgTable, text, serial, integer, boolean, timestamp, uniqueIndex, jsonb } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const turnerasTable = pgTable("turneras", {
  id: serial("id").primaryKey(),
  nombre: text("nombre").notNull(),
  profesionalId: integer("profesional_id"),
  especialidadId: integer("especialidad_id"),
  sedeId: integer("sede_id"),
  duracionMinutos: integer("duracion_minutos").notNull().default(30),
  // diasAtencion stored as comma-separated string e.g. "1,2,3,4,5"
  diasAtencion: text("dias_atencion").notNull().default("1,2,3,4,5"),
  horaInicio: text("hora_inicio").notNull().default("08:00"),
  horaFin: text("hora_fin").notNull().default("18:00"),
  // Horario de atención por día de semana. Si tiene filas, el horario de cada
  // día pisa horaInicio/horaFin globales (que quedan como rango de referencia).
  // [{ dia: 0-6 (0=domingo), horaInicio: "HH:MM", horaFin: "HH:MM" }]
  horariosDia: jsonb("horarios_dia").$type<{ dia: number; horaInicio: string; horaFin: string }[] | null>(),
  cuposDiarios: integer("cupos_diarios"),
  sobreturnos: integer("sobreturnos").notNull().default(0),
  modalidad: text("modalidad").notNull().default("presencial"),
  activa: boolean("activa").notNull().default(true),
  // visibilidad: 'online' | 'recepcion' | 'callcenter' | 'interna'
  visibilidad: text("visibilidad").notNull().default("recepcion"),
  // Turnera de guardia (grupal): sin profesional fijo; cualquier médico de la
  // especialidad con atiende_guardia=true la ve y puede atender sus pacientes.
  esGuardia: boolean("es_guardia").notNull().default(false),
  color: text("color"),
  // Consultorio por regla de agenda (viene del Excel / importación administrativa)
  consultorio: text("consultorio"),
  // Sala de llamado asociada a la agenda: las pantallas TV filtradas por sala
  // muestran los pacientes en espera de estas agendas aunque el médico no haya
  // elegido su sala (el llamado del médico, si eligió sala, tiene precedencia).
  salaLlamadoId: integer("sala_llamado_id"),
  // true cuando duracion_minutos fue inferida (default 30 min), pendiente de confirmación
  duracionPendiente: boolean("duracion_pendiente").notNull().default(false),
  // Clave idempotente para reimportaciones: profesional::sede::especialidad::hi::hf::consultorio
  importKey: text("import_key"),
  // Tipo de agenda: 'consulta' | 'practica'
  tipo: text("tipo").notNull().default("consulta"),
  // Envío a la worklist del PACS: true/false explícito; null = hereda de
  // especialidades.envia_al_pacs (comportamiento histórico)
  enviaWorklist: boolean("envia_worklist"),
  // Circuito de informes vía DiagnostiPACS
  llevaInforme: boolean("lleva_informe").notNull().default(false),
  // destino del informe cuando el PACS lo devuelve: 'hce' | 'portal' | 'whatsapp'
  destinoInforme: text("destino_informe").notNull().default("hce"),
  // Vínculo con Klinicos: réplica exacta de cómo figura esta agenda en el
  // portal (el robot usa estos valores directo, sin heurísticas)
  klinicosSector: text("klinicos_sector"), // ej: CONSULTORIO | IMAGENES S/C
  klinicosEspecialidad: text("klinicos_especialidad"), // tal como figura en Klinicos
  klinicosProfesional: text("klinicos_profesional"), // profesional a machear en el ingreso
  klinicosMotivo: text("klinicos_motivo"), // motivo de consulta por defecto (obligatorio en Klinicos; se usa si el turno no trae uno)
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertTurneraSchema = createInsertSchema(turnerasTable).omit({ id: true, createdAt: true });
export type InsertTurnera = z.infer<typeof insertTurneraSchema>;
export type Turnera = typeof turnerasTable.$inferSelect;

export const bloqueosTable = pgTable("bloqueos", {
  id: serial("id").primaryKey(),
  turneraId: integer("turnera_id").notNull(),
  fechaDesde: timestamp("fecha_desde", { withTimezone: true }).notNull(),
  fechaHasta: timestamp("fecha_hasta", { withTimezone: true }).notNull(),
  motivo: text("motivo").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertBloqueoSchema = createInsertSchema(bloqueosTable).omit({ id: true, createdAt: true });
export type InsertBloqueo = z.infer<typeof insertBloqueoSchema>;
export type Bloqueo = typeof bloqueosTable.$inferSelect;

// Médicos que participan de una agenda grupal (esGuardia=true).
// Si la agenda tiene filas acá, SOLO estos profesionales ven/toman sus pacientes.
// Si no tiene ninguna, se usa el criterio anterior: atiende_guardia + misma especialidad.
export const turneraParticipantesTable = pgTable(
  "turnera_participantes",
  {
    id: serial("id").primaryKey(),
    turneraId: integer("turnera_id").notNull(),
    profesionalId: integer("profesional_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("turnera_participantes_unique").on(t.turneraId, t.profesionalId)],
);

export type TurneraParticipante = typeof turneraParticipantesTable.$inferSelect;

// Obras sociales que atiende una agenda, con cupo diario opcional por cada una.
// Si la agenda no tiene filas acá, atiende todas las obras sociales sin límite.
// cupoDiario null = la atiende sin límite de turnos por día.
export const turneraObrasSocialesTable = pgTable(
  "turnera_obras_sociales",
  {
    id: serial("id").primaryKey(),
    turneraId: integer("turnera_id").notNull(),
    obraSocialId: integer("obra_social_id").notNull(),
    cupoDiario: integer("cupo_diario"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("turnera_obras_sociales_unique").on(t.turneraId, t.obraSocialId)],
);

export type TurneraObraSocial = typeof turneraObrasSocialesTable.$inferSelect;

// Prácticas / estudios del nomenclador que realiza una agenda (ej: la agenda
// de mamografía lleva el código 340602). Se usan para buscar la agenda por
// código o nombre de estudio al dar turnos y para cargar la prestación en
// Klinicos. descripcion es un snapshot del nomenclador al momento de asociar.
export const turneraPracticasTable = pgTable(
  "turnera_practicas",
  {
    id: serial("id").primaryKey(),
    turneraId: integer("turnera_id").notNull(),
    codigo: text("codigo").notNull(),
    descripcion: text("descripcion").notNull().default(""),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("turnera_practicas_unique").on(t.turneraId, t.codigo)],
);

export type TurneraPractica = typeof turneraPracticasTable.$inferSelect;
