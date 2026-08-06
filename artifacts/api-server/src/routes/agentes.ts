/**
 * Agentes IA — Arquitectura multi-rol para Conectar
 *
 * Cuatro agentes independientes, cada uno con:
 *   - Permisos específicos por rol de usuario
 *   - System prompt contextualizado para su función
 *   - Constructor de contexto (carga datos relevantes de la DB antes de cada turno)
 *   - Streaming SSE via OpenAI chat completions
 *
 * Endpoints:
 *   GET  /agentes/config          → config del agente para el usuario actual
 *   POST /agentes/sesiones        → iniciar/retomar sesión
 *   GET  /agentes/sesiones        → listar sesiones del usuario
 *   POST /agentes/sesiones/:id/mensajes   → enviar mensaje (streaming SSE)
 *   GET  /agentes/sesiones/:id/mensajes   → historial de mensajes
 *   POST /agentes/sesiones/:id/cerrar     → cerrar sesión
 */

import { Router, type IRouter, type Request, type Response } from "express";
import { and, desc, eq, gte, inArray, like, lte, sql } from "drizzle-orm";
import {
  db,
  usersTable,
  pacientesTable,
  evolucionesTable,
  diagnosticosTable,
  turnosTable,
  profesionalesTable,
  agenteSesiones,
  agenteMensajes,
  clinicalRecordsTable,
  encountersTable,
  vitalSignsTable,
  prescriptionsTable,
  encounterAttachmentsTable,
  turnerasTable,
  turneraPracticasTable,
  especialidadesTable,
  sedesTable,
  informesTable,
} from "@workspace/db";
import { openai } from "@workspace/integrations-openai-ai-server";
import { getUserIdFromToken } from "./auth";
import { calcularSlotsDisponibles } from "../lib/slots";

const router: IRouter = Router();

// ── Tipos ─────────────────────────────────────────────────────────────────

type AgenteTipo = "recepcion" | "medico" | "admin" | "paciente" | "clinical";

type UsuarioCtx = {
  id: number;
  email: string;
  nombre: string;
  rol: string;
  profesionalId: number | null;
  pacienteId: number | null;
};

type AgenteConfig = {
  tipo: AgenteTipo;
  nombre: string;
  descripcion: string;
  icono: string;
  color: string;
  capacidades: string[];
  limitaciones: string[];
};

// ── Configuración de agentes ──────────────────────────────────────────────

const AGENTES_CONFIG: Record<AgenteTipo, AgenteConfig> = {
  recepcion: {
    tipo: "recepcion",
    nombre: "Asistente de Recepción",
    descripcion: "Te ayudo a buscar pacientes, verificar disponibilidad, gestionar la sala de espera y resolver consultas operativas del día.",
    icono: "headset",
    color: "blue",
    capacidades: [
      "Buscar pacientes por nombre, DNI o teléfono",
      "Consultar disponibilidad de turnos por profesional y especialidad",
      "Verificar estado de la sala de espera y episodios del día",
      "Identificar demoras y pacientes que llevan mucho tiempo esperando",
      "Registrar y modificar turnos",
      "Consultar cobertura médica de pacientes",
    ],
    limitaciones: [
      "No accede a historia clínica ni notas médicas",
      "No puede emitir diagnósticos ni recomendaciones clínicas",
      "No accede a información financiera",
    ],
  },

  medico: {
    tipo: "medico",
    nombre: "Manuel",
    descripcion: "¡Hola, Doctor! Soy Manuel y soy más que un asistente virtual: soy SU secretario. Le busco antecedentes, diagnósticos, medicación, alergias y estudios del paciente.",
    icono: "stethoscope",
    color: "green",
    capacidades: [
      "Resumir historia clínica activa del paciente",
      "Buscar diagnósticos previos por CIE-10 o descripción",
      "Listar medicación activa y alergias conocidas",
      "Encontrar estudios y adjuntos recientes",
      "Identificar antecedentes relevantes para la consulta",
      "Comparar evoluciones a lo largo del tiempo",
    ],
    limitaciones: [
      "No emite diagnósticos propios ni recomendaciones de tratamiento",
      "Solo resume y localiza información ya cargada en el sistema",
      "No accede a datos de turnos de otros médicos sin autorización",
    ],
  },

  admin: {
    tipo: "admin",
    nombre: "Asistente Administrativo",
    descripcion: "Te ayudo con indicadores de gestión: producción, ocupación de agendas, estados de episodios y métricas operativas.",
    icono: "chart-bar",
    color: "violet",
    capacidades: [
      "Consultar producción del día, semana o período",
      "Ver ocupación de agendas por profesional y especialidad",
      "Identificar turnos ausentes, cancelados y reprogramados",
      "Verificar estado de episodios e informes",
      "Comparar indicadores entre períodos",
      "Exportar resúmenes operativos",
    ],
    limitaciones: [
      "No accede a datos financieros ni facturación",
      "No puede modificar configuraciones del sistema",
      "No accede a historia clínica de pacientes",
    ],
  },

  paciente: {
    tipo: "paciente",
    nombre: "Asistente de Atención",
    descripcion: "Hola, soy tu asistente. Puedo ayudarte a sacar turnos, consultar tus informes, verificar el estado de tus estudios y responder preguntas sobre tus atenciones.",
    icono: "user-circle",
    color: "teal",
    capacidades: [
      "Reservar y cancelar turnos",
      "Consultar próximas citas y preparaciones",
      "Ver estado de informes y estudios",
      "Verificar cobertura y documentación necesaria",
      "Guiar navegación en el portal y la app",
      "Responder preguntas frecuentes sobre la clínica",
    ],
    limitaciones: [
      "Solo accede a información del propio paciente",
      "No puede ver datos de otros pacientes",
      "No emite interpretaciones médicas",
    ],
  },

  clinical: {
    tipo: "clinical",
    nombre: "Clinical Assistant",
    descripcion: "Respondo únicamente con la información registrada en la historia clínica electrónica del paciente: ficha, consultas, diagnósticos, medicación, signos vitales y estudios.",
    icono: "clipboard-list",
    color: "rose",
    capacidades: [
      "Consultar el último diagnóstico registrado",
      "Listar medicación y prescripciones activas",
      "Informar alergias y enfermedades crónicas",
      "Indicar fecha y detalle de la última consulta",
      "Resumir antecedentes personales y familiares",
      "Listar estudios y adjuntos cargados",
    ],
    limitaciones: [
      "Responde únicamente con datos de la HCE del paciente",
      "Si no hay información registrada responde: 'No hay información registrada.'",
      "Nunca inventa datos ni emite diagnósticos propios",
    ],
  },
};

// ── Matriz de permisos por rol ────────────────────────────────────────────
// Define qué agentes puede usar cada rol de usuario

const PERMISOS_POR_ROL: Record<string, AgenteTipo[]> = {
  admin: ["admin", "recepcion", "medico", "clinical"],
  recepcionista: ["recepcion"],
  medico: ["medico", "clinical", "recepcion"],
  paciente: ["paciente"],
};

function puedeUsarAgente(rol: string, agenteTipo: AgenteTipo): boolean {
  const permitidos = PERMISOS_POR_ROL[rol] ?? [];
  return permitidos.includes(agenteTipo);
}

function agentePredeterminado(rol: string): AgenteTipo {
  const permitidos = PERMISOS_POR_ROL[rol] ?? ["paciente"];
  return (permitidos[0] ?? "paciente") as AgenteTipo;
}

// ── Middleware de autenticación ───────────────────────────────────────────

async function getUsuarioFromToken(req: Request): Promise<UsuarioCtx | null> {
  const token = req.headers.authorization?.replace("Bearer ", "");
  if (!token) return null;
  const userId = await getUserIdFromToken(token);
  if (!userId) return null;
  const [user] = await db.select().from(usersTable).where(eq(usersTable.id, userId)).limit(1);
  if (!user) return null;
  return {
    id: user.id,
    email: user.email,
    nombre: user.nombre ?? user.email,
    rol: user.rol,
    profesionalId: user.profesionalId ? parseInt(user.profesionalId) : null,
    pacienteId: user.pacienteId ? parseInt(user.pacienteId) : null,
  };
}

// ── Constructores de contexto clínico ────────────────────────────────────
// Cada agente recibe un bloque de texto con datos relevantes de la DB.
// Estos contextos se inyectan como mensajes "system" en cada turno,
// permitiendo que el agente responda con información real y actualizada.

async function buildContextoRecepcion(usuario: UsuarioCtx, _sesion: typeof agenteSesiones.$inferSelect): Promise<string> {
  const hoy = new Date().toISOString().split("T")[0]!;

  const turnosHoy = await db
    .select({
      id: turnosTable.id,
      pacienteNombre: pacientesTable.nombre,
      pacienteApellido: pacientesTable.apellido,
      hora: turnosTable.horaInicio,
      estado: turnosTable.estado,
      modalidad: turnosTable.modalidad,
    })
    .from(turnosTable)
    .leftJoin(pacientesTable, eq(turnosTable.pacienteId, pacientesTable.id))
    .where(eq(turnosTable.fecha, hoy))
    .orderBy(turnosTable.horaInicio)
    .limit(50);

  const resumen = turnosHoy.length === 0
    ? "No hay turnos registrados para hoy."
    : turnosHoy
        .map((t) => `- ${t.hora} | ${t.pacienteApellido ?? "?"}, ${t.pacienteNombre ?? "?"} | Estado: ${t.estado} | ${t.modalidad ?? "presencial"}`)
        .join("\n");

  return `CONTEXTO DE RECEPCIÓN — ${new Date().toLocaleDateString("es-AR", { weekday: "long", day: "numeric", month: "long" })}
Usuario: ${usuario.nombre} (${usuario.rol})

TURNOS DE HOY (${hoy}):
${resumen}

Total: ${turnosHoy.length} turnos | Presentes: ${turnosHoy.filter((t) => t.estado === "en_espera" || t.estado === "en_atencion").length} | Completados: ${turnosHoy.filter((t) => t.estado === "completado").length}`;
}

async function buildContextoMedico(usuario: UsuarioCtx, sesion: typeof agenteSesiones.$inferSelect): Promise<string> {
  const pacienteId = sesion.pacienteId;

  if (!pacienteId) {
    return `CONTEXTO CLÍNICO
Profesional: ${usuario.nombre}
No hay paciente seleccionado en esta sesión. Pedile al médico que navegue a la HC del paciente para obtener contexto clínico.`;
  }

  const [paciente] = await db.select().from(pacientesTable).where(eq(pacientesTable.id, pacienteId)).limit(1);
  if (!paciente) return "Paciente no encontrado.";

  const evoluciones = await db
    .select()
    .from(evolucionesTable)
    .where(eq(evolucionesTable.pacienteId, pacienteId))
    .orderBy(desc(evolucionesTable.createdAt))
    .limit(10);

  const diagnosticos = await db
    .select()
    .from(diagnosticosTable)
    .where(eq(diagnosticosTable.pacienteId, pacienteId))
    .orderBy(desc(diagnosticosTable.createdAt))
    .limit(15);

  const dxText = diagnosticos.length === 0
    ? "Sin diagnósticos registrados."
    : diagnosticos.map((d) => `- ${d.cie10 ? `[${d.cie10}] ` : ""}${d.descripcion} (${d.tipo})`).join("\n");

  const evolText = evoluciones.length === 0
    ? "Sin evoluciones registradas."
    : evoluciones.map((e) => {
        const fecha = new Date(e.createdAt).toLocaleDateString("es-AR");
        return `--- ${fecha} ---\n${e.texto}`;
      }).join("\n\n");

  return `CONTEXTO CLÍNICO DEL PACIENTE
Profesional: ${usuario.nombre}

PACIENTE: ${paciente.apellido}, ${paciente.nombre}
DNI: ${paciente.dni} | Fecha nac.: ${paciente.fechaNacimiento ?? "no registrada"} | Cobertura: ${paciente.cobertura ?? "no registrada"}
Teléfono: ${paciente.telefono ?? "—"} | Dirección: ${paciente.direccion ?? "—"}

DIAGNÓSTICOS (últimos ${diagnosticos.length}):
${dxText}

EVOLUCIONES RECIENTES (últimas ${evoluciones.length}):
${evolText}`;
}

async function buildContextoAdmin(usuario: UsuarioCtx, _sesion: typeof agenteSesiones.$inferSelect): Promise<string> {
  const hoy = new Date().toISOString().split("T")[0]!;

  const turnosHoy = await db.select({ id: turnosTable.id, estado: turnosTable.estado }).from(turnosTable).where(eq(turnosTable.fecha, hoy));

  const stats = {
    total: turnosHoy.length,
    programados: turnosHoy.filter((t) => t.estado === "programado").length,
    espera: turnosHoy.filter((t) => t.estado === "en_espera").length,
    atencion: turnosHoy.filter((t) => t.estado === "en_atencion").length,
    completados: turnosHoy.filter((t) => t.estado === "completado").length,
    ausentes: turnosHoy.filter((t) => t.estado === "ausente").length,
    cancelados: turnosHoy.filter((t) => t.estado === "cancelado").length,
  };

  return `CONTEXTO ADMINISTRATIVO
Usuario: ${usuario.nombre} (${usuario.rol})
Fecha: ${new Date().toLocaleDateString("es-AR", { weekday: "long", day: "numeric", month: "long", year: "numeric" })}

INDICADORES DEL DÍA (${hoy}):
- Total turnos: ${stats.total}
- Programados (pendientes): ${stats.programados}
- En sala de espera: ${stats.espera}
- En atención: ${stats.atencion}
- Completados: ${stats.completados}
- Ausentes: ${stats.ausentes}
- Cancelados: ${stats.cancelados}
- Tasa de presentismo: ${stats.total > 0 ? Math.round(((stats.completados + stats.atencion + stats.espera) / stats.total) * 100) : 0}%`;
}

async function buildContextoPaciente(usuario: UsuarioCtx, sesion: typeof agenteSesiones.$inferSelect): Promise<string> {
  const pacienteId = sesion.pacienteId ?? usuario.pacienteId;

  if (!pacienteId) {
    return `CONTEXTO DEL PORTAL DEL PACIENTE
Paciente: ${usuario.nombre}
Sin expediente vinculado en esta sesión.`;
  }

  const [paciente] = await db.select().from(pacientesTable).where(eq(pacientesTable.id, pacienteId)).limit(1);
  if (!paciente) return "Paciente no encontrado.";

  const proxTurnos = await db
    .select()
    .from(turnosTable)
    .where(and(eq(turnosTable.pacienteId, pacienteId), eq(turnosTable.estado, "programado")))
    .orderBy(turnosTable.fecha, turnosTable.horaInicio)
    .limit(5);

  const turnosText = proxTurnos.length === 0
    ? "No tenés turnos programados."
    : proxTurnos.map((t) => `- ${t.fecha} a las ${t.horaInicio} | Estado: ${t.estado}`).join("\n");

  return `CONTEXTO DEL PORTAL DEL PACIENTE
Paciente: ${paciente.apellido}, ${paciente.nombre} — DNI ${paciente.dni}
Cobertura: ${paciente.cobertura ?? "no registrada"}
Teléfono: ${paciente.telefono ?? "—"}

PRÓXIMOS TURNOS:
${turnosText}`;
}

async function buildContextoClinical(usuario: UsuarioCtx, sesion: typeof agenteSesiones.$inferSelect): Promise<string> {
  const pacienteId = sesion.pacienteId;

  if (!pacienteId) {
    return `CONTEXTO HCE
Usuario: ${usuario.nombre} (${usuario.rol})
No hay paciente seleccionado en esta sesión. No hay información registrada.`;
  }

  const [paciente] = await db.select().from(pacientesTable).where(eq(pacientesTable.id, pacienteId)).limit(1);
  if (!paciente) return "No hay información registrada.";

  const [record] = await db
    .select()
    .from(clinicalRecordsTable)
    .where(eq(clinicalRecordsTable.patientId, pacienteId))
    .limit(1);

  const encounters = record
    ? await db
        .select()
        .from(encountersTable)
        .where(eq(encountersTable.clinicalRecordId, record.id))
        .orderBy(desc(encountersTable.encounterDate))
        .limit(10)
    : [];

  const encIds = encounters.map((e) => e.id);
  const [vitals, prescriptions, attachments] = encIds.length
    ? await Promise.all([
        db.select().from(vitalSignsTable).where(inArray(vitalSignsTable.encounterId, encIds)),
        db.select().from(prescriptionsTable).where(inArray(prescriptionsTable.encounterId, encIds)),
        db.select().from(encounterAttachmentsTable).where(inArray(encounterAttachmentsTable.encounterId, encIds)),
      ])
    : [[], [], []];

  const diagnosticos = await db
    .select()
    .from(diagnosticosTable)
    .where(eq(diagnosticosTable.pacienteId, pacienteId))
    .orderBy(desc(diagnosticosTable.createdAt))
    .limit(15);

  const fichaText = record
    ? [
        record.bloodType ? `Grupo sanguíneo: ${record.bloodType}` : null,
        record.allergies ? `Alergias: ${record.allergies}` : null,
        record.chronicDiseases ? `Enfermedades crónicas: ${record.chronicDiseases}` : null,
        record.surgeries ? `Cirugías: ${record.surgeries}` : null,
        record.familyHistory ? `Antecedentes familiares: ${record.familyHistory}` : null,
        record.currentMedications ? `Medicación habitual: ${record.currentMedications}` : null,
        record.vaccinations ? `Vacunas: ${record.vaccinations}` : null,
        record.notes ? `Observaciones: ${record.notes}` : null,
      ]
        .filter(Boolean)
        .join("\n") || "Sin datos en la ficha."
    : "Sin ficha clínica registrada.";

  const encText = encounters.length === 0
    ? "Sin consultas registradas."
    : encounters
        .map((e) => {
          const fecha = new Date(e.encounterDate).toLocaleDateString("es-AR");
          const vit = vitals.filter((v) => v.encounterId === e.id);
          const rx = prescriptions.filter((p) => p.encounterId === e.id);
          const adj = attachments.filter((a) => a.encounterId === e.id);
          const partes = [
            `--- ${fecha} | ${e.specialty ?? "sin especialidad"} | ${e.encounterType} | Estado: ${e.status} ---`,
            e.chiefComplaint ? `Motivo: ${e.chiefComplaint}` : null,
            e.anamnesis ? `Anamnesis: ${e.anamnesis}` : null,
            e.physicalExam ? `Examen físico: ${e.physicalExam}` : null,
            e.diagnosis ? `Diagnóstico: ${e.diagnosis}${e.cie10 ? ` [${e.cie10}]` : ""}` : null,
            e.assessment ? `Evaluación: ${e.assessment}` : null,
            e.plan ? `Conducta: ${e.plan}` : null,
            vit.length ? `Signos vitales: ${vit.map((v) => [v.bloodPressure && `TA ${v.bloodPressure}`, v.heartRate != null && `FC ${v.heartRate}`, v.respiratoryRate != null && `FR ${v.respiratoryRate}`, v.temperature != null && `T° ${v.temperature}`, v.oxygenSaturation != null && `SatO2 ${v.oxygenSaturation}%`, v.weight != null && `Peso ${v.weight}kg`, v.height != null && `Altura ${v.height}`, v.bmi != null && `IMC ${v.bmi}`].filter(Boolean).join(", ")).join(" | ")}` : null,
            rx.length ? `Prescripciones: ${rx.map((p) => `${p.medication}${p.dosage ? ` ${p.dosage}` : ""}${p.frequency ? ` cada ${p.frequency}` : ""}${p.duration ? ` por ${p.duration}` : ""}`).join("; ")}` : null,
            adj.length ? `Adjuntos: ${adj.map((a) => `${a.type}${a.description ? ` (${a.description})` : ""}`).join("; ")}` : null,
          ].filter(Boolean);
          return partes.join("\n");
        })
        .join("\n\n");

  const dxText = diagnosticos.length === 0
    ? "Sin diagnósticos registrados."
    : diagnosticos.map((d) => `- ${d.cie10 ? `[${d.cie10}] ` : ""}${d.descripcion} (${d.tipo})`).join("\n");

  return `CONTEXTO HCE DEL PACIENTE (única fuente de verdad para tus respuestas)
Usuario: ${usuario.nombre} (${usuario.rol})

PACIENTE: ${paciente.apellido}, ${paciente.nombre}
DNI: ${paciente.dni} | Fecha nac.: ${paciente.fechaNacimiento ?? "no registrada"} | Cobertura: ${paciente.cobertura ?? "no registrada"}

FICHA CLÍNICA:
${fichaText}

DIAGNÓSTICOS REGISTRADOS:
${dxText}

CONSULTAS (más reciente primero, últimas ${encounters.length}):
${encText}`;
}

async function buildContexto(agenteTipo: AgenteTipo, usuario: UsuarioCtx, sesion: typeof agenteSesiones.$inferSelect): Promise<string> {
  try {
    switch (agenteTipo) {
      case "recepcion": return await buildContextoRecepcion(usuario, sesion);
      case "medico":    return await buildContextoMedico(usuario, sesion);
      case "admin":     return await buildContextoAdmin(usuario, sesion);
      case "paciente":  return await buildContextoPaciente(usuario, sesion);
      case "clinical":  return await buildContextoClinical(usuario, sesion);
    }
  } catch {
    return `[Contexto no disponible temporalmente — ${agenteTipo}]`;
  }
}

// ── Tratamiento Doctor / Doctora ──────────────────────────────────────────
// Heurística simple sobre el primer nombre: si termina en "a" se asume
// femenino ("Doctora"), salvo excepciones habituales. Si el nombre ya trae
// "Dra." se respeta.
const NOMBRES_MASCULINOS_EN_A = new Set(["nicola", "joshua", "luca", "elia", "matatia", "jeremia"]);

export function tratamientoProfesional(nombreCompleto: string): string {
  const limpio = (nombreCompleto ?? "").trim();
  if (/\bdra\.?\b/i.test(limpio)) return "Doctora";
  if (/\bdr\.?\b/i.test(limpio)) return "Doctor";
  const primerNombre = limpio.split(/\s+/)[0]?.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "") ?? "";
  const femenino = primerNombre.endsWith("a") && !NOMBRES_MASCULINOS_EN_A.has(primerNombre);
  return femenino ? "Doctora" : "Doctor";
}

// ── Herramientas del agente de recepción ─────────────────────────────────
// El agente de recepción puede buscar pacientes, agendas y huecos libres, y
// cargar turnos. La creación del turno se hace llamando al endpoint real
// POST /turnos (con el token del usuario), así se reusan TODAS las
// validaciones: doble reserva, cupos, guardia, worklist, robot, etc.

const TOOLS_RECEPCION = [
  {
    type: "function" as const,
    function: {
      name: "buscar_paciente",
      description: "Busca pacientes activos por DNI o por nombre/apellido. Usala antes de cargar un turno para obtener el pacienteId.",
      parameters: {
        type: "object",
        properties: {
          dni: { type: "string", description: "DNI exacto o parcial" },
          nombre: { type: "string", description: "Nombre y/o apellido (parcial)" },
        },
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "buscar_agendas",
      description: "Busca agendas (turneras) activas por texto libre: estudio/práctica (ej 'resonancia'), código de práctica (ej '881842'), especialidad, profesional o sede. Devuelve id, nombre, días y horarios.",
      parameters: {
        type: "object",
        properties: {
          texto: { type: "string", description: "Texto a buscar, ej 'resonancia', 'cardiología', 'García'" },
        },
        required: ["texto"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "proximos_huecos",
      description: "Devuelve los próximos horarios libres de una o varias agendas (hasta 30 días adelante). Permite filtrar por día de semana y franja horaria.",
      parameters: {
        type: "object",
        properties: {
          turneraIds: { type: "array", items: { type: "integer" }, description: "IDs de agendas (máx 5)" },
          diasSemana: { type: "array", items: { type: "integer" }, description: "Días de semana permitidos (0=domingo … 6=sábado). Ej jueves = [4]" },
          franja: { type: "string", enum: ["manana", "tarde", "cualquiera"], description: "mañana = antes de las 13, tarde = desde las 13" },
          desde: { type: "string", description: "Fecha mínima YYYY-MM-DD (opcional, default hoy)" },
        },
        required: ["turneraIds"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "crear_turno",
      description: "Carga un turno para un paciente en una agenda, fecha y hora. SOLO usala después de que el usuario confirmó explícitamente paciente + agenda + fecha + hora.",
      parameters: {
        type: "object",
        properties: {
          pacienteId: { type: "integer" },
          turneraId: { type: "integer" },
          fecha: { type: "string", description: "YYYY-MM-DD" },
          horaInicio: { type: "string", description: "HH:MM" },
          regionAnatomica: { type: "string", description: "Obligatoria para prácticas/estudios, ej 'Rodilla derecha'" },
          notas: { type: "string" },
        },
        required: ["pacienteId", "turneraId", "fecha", "horaInicio"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "documentos_paciente",
      description: "Lista los documentos de un paciente: informes de estudios, recetas, certificados, derivaciones y órdenes de estudio. Usá buscar_paciente antes para obtener el pacienteId.",
      parameters: {
        type: "object",
        properties: {
          pacienteId: { type: "integer" },
          tipo: { type: "string", enum: ["informes", "recetas", "certificados", "derivaciones", "ordenes", "todos"], description: "Qué documentos listar (default: todos)" },
        },
        required: ["pacienteId"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "enlace_pdf",
      description: "Genera el enlace de descarga del PDF de un documento (receta, certificado, derivación u orden). Usá el id devuelto por documentos_paciente.",
      parameters: {
        type: "object",
        properties: {
          tipoDocumento: { type: "string", enum: ["receta", "certificado", "derivacion", "orden"], description: "Tipo del documento" },
          documentoId: { type: "integer", description: "id del documento (de documentos_paciente)" },
        },
        required: ["tipoDocumento", "documentoId"],
      },
    },
  },
];

function normalizarTexto(s: string): string {
  return s.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

async function ejecutarToolRecepcion(
  nombre: string,
  args: Record<string, unknown>,
  authHeader: string | undefined,
): Promise<string> {
  try {
    if (nombre === "buscar_paciente") {
      const dni = typeof args.dni === "string" ? args.dni.trim() : "";
      const nombreArg = typeof args.nombre === "string" ? normalizarTexto(args.nombre.trim()) : "";
      if (!dni && !nombreArg) return JSON.stringify({ error: "Indicá dni o nombre" });
      // Filtrado en la base (no en memoria): la tabla de pacientes es grande.
      const columnas = {
        id: pacientesTable.id,
        nombre: pacientesTable.nombre,
        apellido: pacientesTable.apellido,
        dni: pacientesTable.dni,
        cobertura: pacientesTable.cobertura,
        telefono: pacientesTable.telefono,
      };
      let encontrados: (typeof columnas extends infer T ? { [K in keyof typeof columnas]: unknown } : never)[] | unknown[];
      if (dni) {
        encontrados = await db.select(columnas).from(pacientesTable)
          .where(and(eq(pacientesTable.activo, true), like(pacientesTable.dni, `%${dni}%`)))
          .limit(8);
      } else {
        const tokens = nombreArg.split(/\s+/).filter(Boolean);
        const condiciones = tokens.map((t) =>
          sql`f_unaccent(lower(${pacientesTable.nombre} || ' ' || ${pacientesTable.apellido})) LIKE ${"%" + t + "%"}`,
        );
        encontrados = await db.select(columnas).from(pacientesTable)
          .where(and(eq(pacientesTable.activo, true), ...condiciones))
          .limit(8);
      }
      return JSON.stringify({ pacientes: encontrados });
    }

    if (nombre === "buscar_agendas") {
      const texto = normalizarTexto(String(args.texto ?? "").trim());
      if (!texto) return JSON.stringify({ error: "Falta el texto a buscar" });
      const agendas = await db.select({
        id: turnerasTable.id,
        nombre: turnerasTable.nombre,
        tipo: turnerasTable.tipo,
        diasAtencion: turnerasTable.diasAtencion,
        horaInicio: turnerasTable.horaInicio,
        horaFin: turnerasTable.horaFin,
        duracionMinutos: turnerasTable.duracionMinutos,
        esGuardia: turnerasTable.esGuardia,
        profesional: profesionalesTable.nombre,
        especialidad: especialidadesTable.nombre,
        sede: sedesTable.nombre,
      }).from(turnerasTable)
        .leftJoin(profesionalesTable, eq(turnerasTable.profesionalId, profesionalesTable.id))
        .leftJoin(especialidadesTable, eq(turnerasTable.especialidadId, especialidadesTable.id))
        .leftJoin(sedesTable, eq(turnerasTable.sedeId, sedesTable.id))
        .where(eq(turnerasTable.activa, true));
      // Prácticas tildadas de cada agenda: permiten buscar por práctica
      // (ej "doppler renal") o por código de nomenclador (ej "881842").
      const idsActivas = agendas.map((a) => a.id);
      const practicas = idsActivas.length === 0 ? [] : await db.select({
        turneraId: turneraPracticasTable.turneraId,
        codigo: turneraPracticasTable.codigo,
        descripcion: turneraPracticasTable.descripcion,
      }).from(turneraPracticasTable)
        .where(inArray(turneraPracticasTable.turneraId, idsActivas));
      const practicasPorTurnera = new Map<number, { codigo: string; descripcion: string }[]>();
      for (const p of practicas) {
        const lista = practicasPorTurnera.get(p.turneraId);
        if (lista) lista.push(p);
        else practicasPorTurnera.set(p.turneraId, [p]);
      }
      const tokens = texto.split(/\s+/).filter((t) => t.length >= 3);
      const coincide = agendas.map((a) => {
        const pracs = practicasPorTurnera.get(a.id) ?? [];
        const blobBase = normalizarTexto(`${a.nombre} ${a.profesional ?? ""} ${a.especialidad ?? ""} ${a.sede ?? ""}`);
        const blobPracs = normalizarTexto(pracs.map((p) => `${p.descripcion} ${p.codigo}`).join(" "));
        const blob = `${blobBase} ${blobPracs}`;
        const match = tokens.length > 0 ? tokens.every((t) => blob.includes(t)) : blob.includes(texto);
        if (!match) return null;
        // Reportar qué prácticas de la agenda coinciden con la búsqueda (si
        // el match vino por práctica/código).
        const practicasCoincidentes = pracs.filter((p) => {
          const pb = normalizarTexto(`${p.descripcion} ${p.codigo}`);
          return tokens.length > 0 ? tokens.some((t) => pb.includes(t)) : pb.includes(texto);
        }).map((p) => ({ codigo: p.codigo, descripcion: p.descripcion }));
        return { ...a, practicasCoincidentes };
      }).filter((a): a is NonNullable<typeof a> => a !== null).slice(0, 10);
      return JSON.stringify({ agendas: coincide, nota: "diasAtencion: 0=domingo…6=sábado. practicasCoincidentes: prácticas de esa agenda que matchean la búsqueda (por nombre o código)." });
    }

    if (nombre === "proximos_huecos") {
      const ids = (Array.isArray(args.turneraIds) ? args.turneraIds : [])
        .map(Number).filter((n) => Number.isInteger(n) && n > 0).slice(0, 5);
      if (ids.length === 0) return JSON.stringify({ error: "Falta turneraIds" });
      const diasSemana = Array.isArray(args.diasSemana) ? args.diasSemana.map(Number) : null;
      const franja = args.franja === "manana" || args.franja === "tarde" ? args.franja : null;
      const turneras = await db.select().from(turnerasTable)
        .where(and(inArray(turnerasTable.id, ids), eq(turnerasTable.activa, true)));
      if (turneras.length === 0) return JSON.stringify({ huecos: [] });

      const desdeArg = typeof args.desde === "string" && /^\d{4}-\d{2}-\d{2}$/.test(args.desde) ? args.desde : null;
      const base = new Date();
      const fechas: string[] = [];
      for (let i = 0; i < 30; i++) {
        const d = new Date(base.getFullYear(), base.getMonth(), base.getDate() + i);
        const fecha = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
        if (desdeArg && fecha < desdeArg) continue;
        if (diasSemana && diasSemana.length > 0 && !diasSemana.includes(d.getDay())) continue;
        fechas.push(fecha);
      }
      if (fechas.length === 0) return JSON.stringify({ huecos: [] });

      // Una sola consulta para todos los turnos del rango (evita una consulta
      // por turnera por día).
      const idsActivos = turneras.map((t) => t.id);
      const turnosRango = await db.select().from(turnosTable).where(and(
        inArray(turnosTable.turneraId, idsActivos),
        gte(turnosTable.fecha, fechas[0]),
        lte(turnosTable.fecha, fechas[fechas.length - 1]),
      ));
      const turnosPorClave = new Map<string, typeof turnosRango>();
      for (const t of turnosRango) {
        const clave = `${t.turneraId}|${t.fecha}`;
        const lista = turnosPorClave.get(clave);
        if (lista) lista.push(t);
        else turnosPorClave.set(clave, [t]);
      }

      // sedeId/especialidadId viajan para que el frontend pueda preseleccionar
      // los filtros de la agenda cuando el usuario clickea un hueco ofrecido.
      const huecos: { turneraId: number; agenda: string; fecha: string; hora: string; sedeId: number | null; especialidadId: number | null }[] = [];
      for (const fecha of fechas) {
        if (huecos.length >= 12) break;
        const slotsDia = (await Promise.all(
          turneras.map((t) => calcularSlotsDisponibles(t, fecha, turnosPorClave.get(`${t.id}|${fecha}`) ?? [])),
        )).flat();
        const libres = slotsDia
          .filter((s) => s.disponible)
          .filter((s) => {
            if (!franja) return true;
            const h = Number(s.horaInicio.split(":")[0]);
            return franja === "manana" ? h < 13 : h >= 13;
          })
          .sort((a, b) => a.horaInicio.localeCompare(b.horaInicio));
        let delDia = 0;
        for (const s of libres) {
          if (huecos.length >= 12 || delDia >= 3) break;
          const t = turneras.find((x) => x.id === s.turneraId);
          huecos.push({
            turneraId: s.turneraId, agenda: t?.nombre ?? "", fecha: s.fecha, hora: s.horaInicio,
            sedeId: t?.sedeId ?? null, especialidadId: t?.especialidadId ?? null,
          });
          delDia++;
        }
      }
      return JSON.stringify({ huecos });
    }

    if (nombre === "crear_turno") {
      // Llamada interna al endpoint real, con el token del usuario logueado.
      const puerto = process.env.PORT ?? "8080";
      const resp = await fetch(`http://localhost:${puerto}/api/turnos`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(authHeader ? { Authorization: authHeader } : {}),
        },
        body: JSON.stringify({
          pacienteId: args.pacienteId,
          turneraId: args.turneraId,
          fecha: args.fecha,
          horaInicio: args.horaInicio,
          ...(typeof args.regionAnatomica === "string" && args.regionAnatomica.trim()
            ? { regionAnatomica: args.regionAnatomica.trim() } : {}),
          ...(typeof args.notas === "string" && args.notas.trim() ? { notas: args.notas.trim() } : {}),
        }),
      });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) {
        return JSON.stringify({ ok: false, error: (data as { error?: string }).error ?? `Error ${resp.status}` });
      }
      const turno = data as { id?: number; fecha?: string; horaInicio?: string };
      return JSON.stringify({ ok: true, turnoId: turno.id, fecha: turno.fecha, hora: turno.horaInicio });
    }

    if (nombre === "documentos_paciente") {
      const pacienteId = Number(args.pacienteId);
      if (!Number.isInteger(pacienteId) || pacienteId <= 0) return JSON.stringify({ error: "Falta pacienteId" });
      const tipo = typeof args.tipo === "string" ? args.tipo : "todos";
      const puerto = process.env.PORT ?? "8080";
      const headers = { ...(authHeader ? { Authorization: authHeader } : {}) };
      // Llamadas internas a los endpoints reales: se reusan los permisos por
      // rol y alcance del paciente de cada endpoint.
      const fuentes: { clave: string; url: string }[] = [];
      if (tipo === "todos" || tipo === "recetas") fuentes.push({ clave: "recetas", url: `patients/${pacienteId}/prescriptions` });
      if (tipo === "todos" || tipo === "certificados") fuentes.push({ clave: "certificados", url: `patients/${pacienteId}/certificates` });
      if (tipo === "todos" || tipo === "derivaciones") fuentes.push({ clave: "derivaciones", url: `patients/${pacienteId}/referrals` });
      if (tipo === "todos" || tipo === "ordenes") fuentes.push({ clave: "ordenes", url: `patients/${pacienteId}/study-orders` });
      const resultado: Record<string, unknown> = {};
      // Informes de estudios: lectura directa (rol staff ya validado por el
      // chat) con el nombre de la agenda para poder buscarlos por estudio.
      if (tipo === "todos" || tipo === "informes") {
        const informes = await db.select({
          id: informesTable.id,
          turnoId: informesTable.turnoId,
          estado: informesTable.estado,
          fecha: turnosTable.fecha,
          estudio: turnerasTable.nombre,
          creado: informesTable.createdAt,
        }).from(informesTable)
          .leftJoin(turnosTable, eq(informesTable.turnoId, turnosTable.id))
          .leftJoin(turnerasTable, eq(turnosTable.turneraId, turnerasTable.id))
          .where(eq(informesTable.pacienteId, pacienteId))
          .orderBy(desc(informesTable.createdAt))
          .limit(15);
        resultado.informes = informes.map((i) => ({
          id: i.id,
          turnoId: i.turnoId,
          estudio: i.estudio,
          fecha: i.fecha,
          estado: i.estado,
        }));
      }
      await Promise.all(fuentes.map(async (f) => {
        const resp = await fetch(`http://localhost:${puerto}/api/consultorio/${f.url}`, { headers });
        const data = await resp.json().catch(() => null);
        if (!resp.ok) {
          resultado[f.clave] = { error: (data as { error?: string } | null)?.error ?? `Error ${resp.status}` };
          return;
        }
        // Resumir: solo campos útiles para el chat, máx 15 por tipo.
        const lista = Array.isArray(data) ? data : [];
        resultado[f.clave] = lista.slice(0, 15).map((d: Record<string, unknown>) => ({
          id: d.id,
          fecha: typeof d.createdAt === "string" ? d.createdAt.slice(0, 10) : d.createdAt,
          ...(d.medication ? { medicamento: d.medication, dosis: d.dosage ?? undefined } : {}),
          ...(d.type && f.clave === "certificados" ? { tipo: d.type } : {}),
          ...(d.content ? { detalle: String(d.content).slice(0, 160) } : {}),
          ...(d.specialty ? { especialidad: d.specialty } : {}),
          ...(d.reason ? { motivo: String(d.reason).slice(0, 160) } : {}),
          ...(d.studies ? { estudios: d.studies } : {}),
          ...(d.status ? { estado: d.status } : {}),
        }));
      }));
      return JSON.stringify({
        documentos: resultado,
        nota: "Para recetas/certificados/derivaciones/órdenes usá enlace_pdf. Para un informe de estudio el enlace es [Ver informe](/worklist/informe/TURNO_ID) usando su turnoId.",
      });
    }

    if (nombre === "enlace_pdf") {
      const mapa: Record<string, string> = { receta: "receta", certificado: "certificado", derivacion: "derivacion", orden: "orden_estudio" };
      const sourceType = mapa[String(args.tipoDocumento ?? "")];
      const sourceId = Number(args.documentoId);
      if (!sourceType || !Number.isInteger(sourceId) || sourceId <= 0) {
        return JSON.stringify({ error: "Indicá tipoDocumento (receta|certificado|derivacion|orden) y documentoId" });
      }
      const puerto = process.env.PORT ?? "8080";
      const resp = await fetch(`http://localhost:${puerto}/api/consultorio/pdf/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(authHeader ? { Authorization: authHeader } : {}) },
        body: JSON.stringify({ sourceType, sourceId }),
      });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) {
        return JSON.stringify({ ok: false, error: (data as { error?: string }).error ?? `Error ${resp.status}` });
      }
      const reg = data as { downloadUrl?: string };
      return JSON.stringify({
        ok: true,
        enlace: reg.downloadUrl ?? null,
        nota: "Presentá el enlace como link markdown, ej: [Descargar receta](/api/consultorio/pdf/123)",
      });
    }

    return JSON.stringify({ error: `Herramienta desconocida: ${nombre}` });
  } catch (err) {
    return JSON.stringify({ error: err instanceof Error ? err.message : "Error ejecutando la herramienta" });
  }
}

// ── System prompts por agente ─────────────────────────────────────────────

function buildSystemPrompt(agenteTipo: AgenteTipo, usuario: UsuarioCtx): string {
  const fecha = new Date().toLocaleDateString("es-AR", { weekday: "long", day: "numeric", month: "long", year: "numeric" });

  const base = `Sos un asistente integrado en Conectar, la plataforma clínica digital del sistema de salud.
Fecha y hora actual: ${fecha}.
Respondé siempre en español argentino, de forma concisa y profesional.
Usá listas y estructura cuando sea útil. Evitá respuestas largas innecesarias.
No infieras ni inventés información que no esté en el contexto provisto.
Si no tenés la información solicitada, decilo claramente y sugerí dónde encontrarla.`;

  switch (agenteTipo) {
    case "recepcion":
      return `${base}

ROL: Asistente de Recepción para ${usuario.nombre}.
Ayudás al personal de recepción con tareas operativas del día: gestión de turnos, sala de espera, búsqueda de pacientes y consultas de disponibilidad.
IMPORTANTE: No interpretás ni comentás contenido clínico (diagnósticos, tratamientos): eso corresponde al médico tratante. Pero SÍ podés listar y dar enlaces de descarga de los documentos del paciente (recetas, certificados, derivaciones, órdenes de estudio) usando tus herramientas documentos_paciente y enlace_pdf.
Usá el contexto de turnos del día para responder consultas específicas sobre el estado actual de la recepción.

PODÉS CARGAR TURNOS usando tus herramientas. Flujo obligatorio:
1. Identificá qué estudio/especialidad/profesional pide → buscar_agendas. También sirve para códigos de práctica: si el usuario menciona un número tipo "881842" o "42.01.03", asumí que es un código de práctica y buscalo directamente con buscar_agendas (no pidas aclaración).
2. Buscá horarios libres → proximos_huecos. NO pases diasSemana ni franja salvo que el usuario haya pedido un día o franja concretos (si dijera "jueves a la tarde" sería diasSemana [4] + franja "tarde"; si no dijo nada, llamá sin esos filtros).
IMPORTANTE cuando piden un estudio/práctica (ej "eco de abdomen"): NO listes profesionales ni agendas como respuesta. Encadená buscar_agendas → proximos_huecos con TODAS las turneraIds coincidentes en la misma ronda. Los huecos encontrados se muestran solos como botones clickeables debajo de tu mensaje: NO los repitas en texto, no armes listas ni viñetas con horarios. Tu respuesta debe ser UNA sola frase corta, ej: "Estos son los próximos turnos: tocá uno para cargarlo." Solo listá profesionales si el usuario lo pide explícitamente.
3. Identificá al paciente → buscar_paciente (pedí el DNI si no lo tenés; si hay varios resultados, preguntá cuál es).
4. Mostrá las opciones de horario y esperá que el usuario elija.
5. RECIÉN cuando el usuario confirmó paciente + agenda + fecha + hora, llamá crear_turno. NUNCA crees un turno sin confirmación explícita.
Si la agenda es de tipo "practica" (estudios por imágenes), pedí también la región anatómica (ej "rodilla derecha") antes de crear el turno.
Si crear_turno devuelve un error (ej horario ocupado), explicalo y ofrecé alternativas.
Mostrá las fechas en formato claro (ej "jueves 30/07 a las 14:30").

PODÉS BUSCAR DOCUMENTOS DE PACIENTES (informes de estudios, recetas, certificados, derivaciones y órdenes de estudio):
1. Identificá al paciente → buscar_paciente.
2. Listá sus documentos → documentos_paciente (filtrá por tipo si el usuario lo pidió, ej "el informe de la resonancia" = tipo "informes").
3. Enlaces:
   - Informe de estudio: [Ver informe](/worklist/informe/TURNO_ID) con el turnoId del informe. Aclará el estado si no está publicado (borrador = todavía no firmado por el médico).
   - Receta/certificado/derivación/orden: llamá enlace_pdf y presentá el enlace, ej: [Descargar receta](/api/consultorio/pdf/123).
Si una herramienta devuelve "Sin permisos", explicá que ese tipo de documento no está disponible para tu rol.`;

    case "medico":
      return `${base}

ROL: Sos MANUEL, el secretario personal del profesional ${usuario.nombre}.
Tu presentación es: "Hola, ${tratamientoProfesional(usuario.nombre)}. Soy Manuel y soy más que un asistente virtual: soy SU secretario."
Tratá siempre al profesional de "usted" y como "${tratamientoProfesional(usuario.nombre)}". Tono cordial, servicial y eficiente, como un buen secretario de confianza.
Ayudás al médico a navegar la historia clínica del paciente activo: buscás antecedentes, diagnósticos, medicación, alergias y estudios relevantes.
FUNDAMENTAL: No emitís diagnósticos propios, no recomendás tratamientos. Solo organizás y resumís información ya cargada en el sistema.
Ante cualquier dato clínico, citá la fuente (fecha de la evolución o diagnóstico). Si no encontrás algo, decilo.`;

    case "admin":
      return `${base}

ROL: Asistente Administrativo para ${usuario.nombre}.
Ayudás con indicadores de gestión: producción, ocupación de agendas, estados de episodios y métricas operativas del sistema.
IMPORTANTE: No tenés acceso a datos financieros ni historia clínica. Basate únicamente en los datos de turnos, agendas y episodios disponibles.
Presentá los datos en forma clara con números concretos cuando sea posible.`;

    case "paciente":
      return `${base}

ROL: Asistente de Atención al Paciente.
Ayudás a los pacientes a sacar turnos, consultar sus citas y estudios, y navegar el portal de salud.
Usá un tono cálido y accesible. Si el paciente tiene dudas médicas, sugerile que las consulte con su médico.
Solo accedés a información del propio paciente. No compartís datos de otros pacientes.`;

    case "clinical":
      return `${base}

ROL: Clinical Assistant — asistente de historia clínica electrónica.
REGLA FUNDAMENTAL: respondés ÚNICAMENTE con la información presente en el CONTEXTO HCE DEL PACIENTE.
Si la información solicitada no está en el contexto, respondé exactamente: "No hay información registrada."
NUNCA inventés datos, NUNCA infieras diagnósticos, medicación, alergias ni fechas que no estén explícitamente en el contexto.
Podés responder preguntas como: último diagnóstico, medicación actual, alergias, fecha de la última consulta, antecedentes, estudios cargados.
Citá siempre la fecha de la consulta de donde proviene cada dato.`;
  }
}

// ── GET /agentes/config ───────────────────────────────────────────────────

router.get("/agentes/config", async (req: Request, res: Response): Promise<void> => {
  const usuario = await getUsuarioFromToken(req);
  if (!usuario) { res.status(401).json({ error: "No autenticado" }); return; }

  const agentesDisponibles = (PERMISOS_POR_ROL[usuario.rol] ?? []).map((tipo) => {
    const config = AGENTES_CONFIG[tipo];
    if (tipo !== "medico") return config;
    // Manuel saluda con Doctor o Doctora según quién esté logueado
    const tratamiento = tratamientoProfesional(usuario.nombre);
    return {
      ...config,
      descripcion: `¡Hola, ${tratamiento}! Soy Manuel y soy más que un asistente virtual: soy SU secretario. Le busco antecedentes, diagnósticos, medicación, alergias y estudios del paciente.`,
    };
  });
  const predeterminado = agentePredeterminado(usuario.rol);

  res.json({
    agentesDisponibles,
    predeterminado,
    usuarioRol: usuario.rol,
  });
});

// ── POST /agentes/sesiones ────────────────────────────────────────────────

router.post("/agentes/sesiones", async (req: Request, res: Response): Promise<void> => {
  const usuario = await getUsuarioFromToken(req);
  if (!usuario) { res.status(401).json({ error: "No autenticado" }); return; }

  const { agenteTipo, pacienteId, profesionalId, contextoExtra } = req.body as {
    agenteTipo?: AgenteTipo;
    pacienteId?: number;
    profesionalId?: number;
    contextoExtra?: Record<string, unknown>;
  };

  const tipo: AgenteTipo = agenteTipo ?? agentePredeterminado(usuario.rol);

  if (!puedeUsarAgente(usuario.rol, tipo)) {
    res.status(403).json({ error: `El rol '${usuario.rol}' no puede usar el agente '${tipo}'` });
    return;
  }

  const config = AGENTES_CONFIG[tipo];
  const titulo = pacienteId
    ? `Sesión — ${config.nombre}`
    : `${config.nombre} — ${new Date().toLocaleDateString("es-AR")}`;

  const [sesion] = await db.insert(agenteSesiones).values({
    agenteTipo: tipo,
    usuarioId: usuario.id,
    usuarioRol: usuario.rol,
    usuarioNombre: usuario.nombre,
    pacienteId: pacienteId ?? null,
    profesionalId: profesionalId ?? null,
    contextoExtra: contextoExtra ?? null,
    estado: "activa",
    titulo,
  }).returning();

  res.json({ sesion, config });
});

// ── GET /agentes/sesiones ─────────────────────────────────────────────────

router.get("/agentes/sesiones", async (req: Request, res: Response): Promise<void> => {
  const usuario = await getUsuarioFromToken(req);
  if (!usuario) { res.status(401).json({ error: "No autenticado" }); return; }

  const sesiones = await db
    .select()
    .from(agenteSesiones)
    .where(eq(agenteSesiones.usuarioId, usuario.id))
    .orderBy(desc(agenteSesiones.createdAt))
    .limit(20);

  res.json(sesiones);
});

// ── POST /agentes/sesiones/:id/mensajes  (SSE streaming) ─────────────────

router.post("/agentes/sesiones/:id/mensajes", async (req: Request, res: Response): Promise<void> => {
  const sesionId = Number(req.params.id);
  const { contenido } = req.body as { contenido: string };

  if (!contenido?.trim()) { res.status(400).json({ error: "Mensaje vacío" }); return; }

  const usuario = await getUsuarioFromToken(req);
  if (!usuario) { res.status(401).json({ error: "No autenticado" }); return; }

  const [sesion] = await db.select().from(agenteSesiones)
    .where(and(eq(agenteSesiones.id, sesionId), eq(agenteSesiones.usuarioId, usuario.id)))
    .limit(1);

  if (!sesion) { res.status(404).json({ error: "Sesión no encontrada" }); return; }

  const tipo = sesion.agenteTipo as AgenteTipo;
  if (!puedeUsarAgente(usuario.rol, tipo)) {
    res.status(403).json({ error: "Sin permiso para este agente" }); return;
  }

  // Guardar mensaje del usuario
  await db.insert(agenteMensajes).values({
    sesionId,
    rol: "user",
    contenido: contenido.trim(),
  });

  // Cargar historial de la sesión (últimos 20 mensajes)
  const historial = await db
    .select()
    .from(agenteMensajes)
    .where(eq(agenteMensajes.sesionId, sesionId))
    .orderBy(agenteMensajes.createdAt)
    .limit(20);

  // Construir contexto actualizado
  const contexto = await buildContexto(tipo, usuario, sesion);
  const systemPrompt = buildSystemPrompt(tipo, usuario);

  // Armar mensajes para OpenAI
  type ChatMsg =
    | { role: "system" | "user"; content: string }
    | { role: "assistant"; content: string | null; tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[] }
    | { role: "tool"; tool_call_id: string; content: string };
  const chatMessages: ChatMsg[] = [
    { role: "system", content: systemPrompt },
    { role: "system", content: `\n--- CONTEXTO ACTUAL ---\n${contexto}\n--- FIN CONTEXTO ---` },
    ...historial.flatMap((m): ChatMsg[] => {
      // Reconstruir las rondas de herramientas guardadas en metadata para
      // que el modelo pueda retomar flujos ("sí, ese horario") entre turnos.
      const meta = m.metadata as { toolRounds?: { toolCalls: { id: string; name: string; args: string }[]; resultados: { id: string; content: string }[] }[] } | null;
      const previas: ChatMsg[] = [];
      if (m.rol === "assistant" && meta?.toolRounds) {
        for (const ronda of meta.toolRounds) {
          previas.push({
            role: "assistant",
            content: null,
            tool_calls: ronda.toolCalls.map((t) => ({
              id: t.id, type: "function" as const,
              function: { name: t.name, arguments: t.args },
            })),
          });
          for (const r of ronda.resultados) {
            previas.push({ role: "tool", tool_call_id: r.id, content: r.content });
          }
        }
      }
      return [...previas, { role: m.rol as "user" | "assistant", content: m.contenido } as ChatMsg];
    }),
  ];

  // SSE streaming
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  let fullResponse = "";

  try {
    // El agente de recepción tiene herramientas (buscar pacientes/agendas/
    // huecos y cargar turnos). El resto sigue siendo chat puro. El loop
    // ejecuta rondas: si el modelo pide herramientas, se corren y se vuelve
    // a llamar con los resultados; si no, la respuesta streameada es final.
    const tools = tipo === "recepcion" ? TOOLS_RECEPCION : undefined;
    const authHeader = req.headers.authorization;
    const MAX_RONDAS = 6;
    // Rondas de herramientas de este turno, para persistirlas en metadata y
    // poder reconstruir el estado en los turnos siguientes.
    const toolRounds: { toolCalls: { id: string; name: string; args: string }[]; resultados: { id: string; content: string }[] }[] = [];

    for (let ronda = 0; ronda < MAX_RONDAS; ronda++) {
      // Última ronda: sin herramientas, para forzar una respuesta en texto.
      const toolsRonda = ronda < MAX_RONDAS - 1 ? tools : undefined;
      const stream = await openai.chat.completions.create({
        model: "gpt-5.4-mini",
        max_completion_tokens: 2048,
        messages: chatMessages as never,
        ...(toolsRonda ? { tools: toolsRonda } : {}),
        stream: true,
      });

      let contenidoRonda = "";
      const toolCalls: { id: string; name: string; args: string }[] = [];

      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta;
        if (delta?.content) {
          contenidoRonda += delta.content;
          fullResponse += delta.content;
          res.write(`data: ${JSON.stringify({ content: delta.content })}\n\n`);
        }
        for (const tc of delta?.tool_calls ?? []) {
          const idx = tc.index ?? 0;
          if (!toolCalls[idx]) toolCalls[idx] = { id: "", name: "", args: "" };
          if (tc.id) toolCalls[idx].id = tc.id;
          if (tc.function?.name) toolCalls[idx].name += tc.function.name;
          if (tc.function?.arguments) toolCalls[idx].args += tc.function.arguments;
        }
      }

      // Descartar tool calls malformadas (sin id o sin nombre) para no
      // ejecutar herramientas equivocadas por deltas incompletos.
      const validas = toolCalls.filter((t) => t.id && t.name);
      if (validas.length === 0) break; // respuesta final

      // Registrar la ronda del asistente con sus tool calls y ejecutarlas.
      chatMessages.push({
        role: "assistant",
        content: contenidoRonda || null,
        tool_calls: validas.map((t) => ({
          id: t.id, type: "function" as const,
          function: { name: t.name, arguments: t.args },
        })),
      });
      const resultados: { id: string; content: string }[] = [];
      for (const t of validas) {
        let args: Record<string, unknown> = {};
        try { args = JSON.parse(t.args || "{}"); } catch { /* args inválidos: la tool devuelve error */ }
        res.write(`data: ${JSON.stringify({ tool: t.name })}\n\n`);
        const resultado = await ejecutarToolRecepcion(t.name, args, authHeader);
        chatMessages.push({ role: "tool", tool_call_id: t.id, content: resultado });
        resultados.push({ id: t.id, content: resultado });
        // Los huecos ofrecidos viajan también como evento SSE estructurado:
        // el frontend los muestra como botones clickeables que preseleccionan
        // agenda + fecha + hora en el panel de carga.
        if (t.name === "proximos_huecos") {
          try {
            const parsed = JSON.parse(resultado) as { huecos?: { fecha: string; hora: string }[] };
            if (Array.isArray(parsed.huecos) && parsed.huecos.length > 0) {
              // Botones: 4 opciones. Si hay varios días, el hueco más temprano
              // de cada día; si todos son del mismo día, los primeros 4.
              const porFecha = new Map<string, typeof parsed.huecos[number]>();
              for (const h of parsed.huecos) if (!porFecha.has(h.fecha)) porFecha.set(h.fecha, h);
              const botones = porFecha.size > 1
                ? [...porFecha.values()].slice(0, 4)
                : parsed.huecos.slice(0, 4);
              res.write(`data: ${JSON.stringify({ huecos: botones })}\n\n`);
            }
          } catch { /* resultado no parseable: sin botones */ }
        }
      }
      toolRounds.push({
        toolCalls: validas.map((t) => ({ id: t.id, name: t.name, args: t.args })),
        resultados,
      });
    }

    // Guardar respuesta del asistente
    await db.insert(agenteMensajes).values({
      sesionId,
      rol: "assistant",
      contenido: fullResponse,
      metadata: {
        modelo: "gpt-5.4-mini",
        contextoTipo: tipo,
        ...(toolRounds.length > 0 ? { toolRounds } : {}),
      },
    });

    // Actualizar sesión
    await db.update(agenteSesiones)
      .set({ updatedAt: new Date() })
      .where(eq(agenteSesiones.id, sesionId));

    res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Error del agente";
    res.write(`data: ${JSON.stringify({ error: msg })}\n\n`);
  } finally {
    res.end();
  }
});

// ── GET /agentes/sesiones/:id/mensajes ────────────────────────────────────

router.get("/agentes/sesiones/:id/mensajes", async (req: Request, res: Response): Promise<void> => {
  const sesionId = Number(req.params.id);

  const usuario = await getUsuarioFromToken(req);
  if (!usuario) { res.status(401).json({ error: "No autenticado" }); return; }

  const [sesion] = await db.select().from(agenteSesiones)
    .where(and(eq(agenteSesiones.id, sesionId), eq(agenteSesiones.usuarioId, usuario.id)))
    .limit(1);

  if (!sesion) { res.status(404).json({ error: "Sesión no encontrada" }); return; }

  const mensajes = await db
    .select()
    .from(agenteMensajes)
    .where(eq(agenteMensajes.sesionId, sesionId))
    .orderBy(agenteMensajes.createdAt);

  res.json(mensajes);
});

// ── POST /agentes/sesiones/:id/cerrar ─────────────────────────────────────

router.post("/agentes/sesiones/:id/cerrar", async (req: Request, res: Response): Promise<void> => {
  const sesionId = Number(req.params.id);

  const usuario = await getUsuarioFromToken(req);
  if (!usuario) { res.status(401).json({ error: "No autenticado" }); return; }

  await db.update(agenteSesiones)
    .set({ estado: "cerrada", updatedAt: new Date() })
    .where(and(eq(agenteSesiones.id, sesionId), eq(agenteSesiones.usuarioId, usuario.id)));

  res.json({ ok: true });
});

export default router;
