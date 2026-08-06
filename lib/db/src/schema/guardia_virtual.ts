import { pgTable, serial, integer, text, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";
import { turnosTable } from "./turnos";

// Sesiones de la antesala de guardia virtual (videollamadas de Clínica Médica IOMA).
// Ciclo de vida: pre_registro → validando_token → en_cola → llamado → atendido
//                                               ↘ token_rechazado (reintentable con nuevo token)
//               en cualquier estado → abandonado
// El turno (en la bolsa esGuardia, modalidad="videoconsulta") se crea SOLO tras
// token ACCEPTED + bono: la regla inviolable del cartel verde se respeta desde la
// antesala.

export const GUARDIA_VIRTUAL_ESTADOS = [
  "pre_registro",
  "validando_token",
  "token_rechazado",
  "en_cola",
  "llamado",
  "atendido",
  "abandonado",
] as const;
export type GuardiaVirtualEstado = (typeof GUARDIA_VIRTUAL_ESTADOS)[number];

export const guardiaVirtualSesionesTable = pgTable(
  "guardia_virtual_sesiones",
  {
    id: serial("id").primaryKey(),
    // Credencial de polling (80 bits, sin ambigüedad): el paciente la recibe
    // al registrarse y la usa para hacer polling de estado y validar el token.
    sesionToken: text("sesion_token").notNull(),
    dni: text("dni").notNull(),
    nombre: text("nombre").notNull(),
    apellido: text("apellido").notNull(),
    telefono: text("telefono"),
    cobertura: text("cobertura").notNull().default("IOMA"),
    // "videollamada" (flujo original con meet) o "presencial" (el paciente se
    // registra desde la app, valida el token y avisa con el botón "Ya llegué";
    // su turno ocupa lugar en la fila desde que valida el token).
    modalidad: text("modalidad").notNull().default("videollamada"),
    // Qué guardia atiende esta sesión: "clinica" (adultos, flujo original) o
    // "pediatrica". Cada guardia tiene su propia turnera configurada.
    guardia: text("guardia").notNull().default("clinica"),
    ipOrigen: text("ip_origen"),
    estado: text("estado").$type<GuardiaVirtualEstado>().notNull().default("pre_registro"),
    // Últimos 4 chars del token (para logs/pantallas); el token completo nunca
    // sale de la capa de validación.
    tokenIomaEnmascarado: text("token_ioma_enmascarado"),
    tokenIomaEstado: text("token_ioma_estado"),
    nroBono: text("nro_bono"),
    // Linkeos post-validación
    turnoId: integer("turno_id").references(() => turnosTable.id),
    klinicosTrabajoId: integer("klinicos_trabajo_id"),
    // TTL: sesiones con expira_en < NOW() se tratan como abandonadas; un job
    // nightly cancela los turnos huérfanos que dejaron.
    expiraEn: timestamp("expira_en", { withTimezone: true }).notNull(),
    creadoEn: timestamp("creado_en", { withTimezone: true }).notNull().defaultNow(),
    actualizadoEn: timestamp("actualizado_en", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("guardia_virtual_sesiones_token_uidx").on(t.sesionToken),
    index("guardia_virtual_sesiones_dni_idx").on(t.dni, t.creadoEn),
    index("guardia_virtual_sesiones_turno_idx").on(t.turnoId),
    index("guardia_virtual_sesiones_estado_idx").on(t.estado, t.expiraEn),
  ],
);

export type GuardiaVirtualSesion = typeof guardiaVirtualSesionesTable.$inferSelect;
