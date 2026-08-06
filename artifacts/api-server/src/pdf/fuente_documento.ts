// Carga de fuentes de documentos clínicos para el motor PDF.
// Módulo de dominio, sin dependencia de routers: lo usan las rutas de
// consultorio y las integraciones (push de órdenes al Robot Klinicos).
import { randomBytes } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import {
  db,
  profesionalesTable,
  prescriptionsTable,
  referralsTable,
  certificatesTable,
  indicacionesPacientesTable,
  studyOrdersTable,
  practicasCatalogoTable,
} from "@workspace/db";
import type { DatosDocumentoPdf } from "./documento_pdf";
import QRCode from "qrcode";
import { urlPublicaApp } from "../lib/url-publica";

// ── Motor PDF ─────────────────────────────────────────────────────────────
export type FuentePdf = {
  patientId: number;
  professionalId: number;
  consultationId: number | null;
  datos: Omit<DatosDocumentoPdf, "paciente" | "profesional">;
};

// Número institucional de la receta, derivable del registro: RM-AAAAMMDD-XXXXXXXX.
export function numeroReceta(r: { id: number; createdAt: Date | string }): string {
  const f = new Date(r.createdAt);
  const ymd = `${f.getUTCFullYear()}${String(f.getUTCMonth() + 1).padStart(2, "0")}${String(f.getUTCDate()).padStart(2, "0")}`;
  return `RM-${ymd}-${String(r.id).padStart(8, "0")}`;
}

// Token de verificación pública de la receta: reclamo atómico (solo escribe si
// sigue NULL); el QR impreso siempre sale del valor persistido en la base.
async function verificacionReceta(
  r: { id: number; createdAt: Date | string; verificationCode: string | null },
): Promise<DatosDocumentoPdf["verificacion"]> {
  const base = urlPublicaApp();
  if (!base) return null;
  let codigo = r.verificationCode;
  if (!codigo) {
    try {
      const candidato = randomBytes(10).toString("hex");
      const [fila] = await db
        .update(prescriptionsTable)
        .set({ verificationCode: candidato })
        .where(and(eq(prescriptionsTable.id, r.id), isNull(prescriptionsTable.verificationCode)))
        .returning({ verificationCode: prescriptionsTable.verificationCode });
      if (fila) {
        codigo = fila.verificationCode;
      } else {
        const [rec] = await db
          .select({ verificationCode: prescriptionsTable.verificationCode })
          .from(prescriptionsTable)
          .where(eq(prescriptionsTable.id, r.id))
          .limit(1);
        codigo = rec?.verificationCode ?? null;
      }
    } catch {
      codigo = null; // sin token persistido la receta sale sin QR (nunca un código huérfano)
    }
  }
  if (!codigo) return null;
  try {
    const url = `${base}/verificar-receta/${codigo}`;
    const qrPng = await QRCode.toBuffer(url, { margin: 1, width: 220 });
    return { qrPng, codigo, numero: numeroReceta(r), url };
  } catch {
    return null;
  }
}

export async function cargarFuente(sourceType: string, sourceId: number): Promise<FuentePdf | null> {
  if (sourceType === "receta") {
    const [r] = await db.select().from(prescriptionsTable).where(eq(prescriptionsTable.id, sourceId)).limit(1);
    if (!r || r.patientId == null || r.professionalId == null) return null;
    const verificacion = await verificacionReceta(r);
    return {
      patientId: r.patientId,
      professionalId: r.professionalId,
      consultationId: r.consultationId ?? null,
      datos: {
        titulo: "Receta médica",
        tipoDocumento: "receta",
        fechaEmision: r.createdAt,
        campos: [
          { etiqueta: r.type === "insumo" ? "Insumo" : "Medicamento", valor: r.medication },
          { etiqueta: "Dosis", valor: r.dosage ?? "" },
          { etiqueta: "Frecuencia", valor: r.frequency ?? "" },
          { etiqueta: "Duración", valor: r.duration ?? "" },
          { etiqueta: "Indicaciones", valor: r.instructions ?? "" },
        ],
        verificacion,
      },
    };
  }
  if (sourceType === "derivacion") {
    const [d] = await db.select().from(referralsTable).where(eq(referralsTable.id, sourceId)).limit(1);
    if (!d) return null;
    let nombreDestino: string | null = null;
    if (d.targetProfessionalId != null) {
      const [p] = await db.select().from(profesionalesTable).where(eq(profesionalesTable.id, d.targetProfessionalId)).limit(1);
      if (p) nombreDestino = `${p.apellido ? p.apellido + ", " : ""}${p.nombre}`;
    }
    return {
      patientId: d.patientId,
      professionalId: d.professionalId,
      consultationId: d.consultationId ?? null,
      datos: {
        titulo: "Derivación",
        tipoDocumento: "derivacion",
        fechaEmision: d.createdAt,
        campos: [
          { etiqueta: "Especialidad destino", valor: d.targetSpecialty },
          { etiqueta: "Profesional destino", valor: nombreDestino ?? "" },
          { etiqueta: "Motivo", valor: d.reason },
          { etiqueta: "Prioridad", valor: d.priority === "urgente" ? "URGENTE" : "Normal" },
        ],
        observaciones: d.observations,
      },
    };
  }
  if (sourceType === "certificado") {
    const [c] = await db.select().from(certificatesTable).where(eq(certificatesTable.id, sourceId)).limit(1);
    if (!c) return null;
    // QR de verificación pública: apunta a la página /verificar/<código>.
    let verificacion: DatosDocumentoPdf["verificacion"] = null;
    const baseVerificacion = urlPublicaApp();
    if (c.verificationCode && baseVerificacion) {
      try {
        const url = `${baseVerificacion}/verificar/${c.verificationCode}`;
        const qrPng = await QRCode.toBuffer(url, { margin: 1, width: 220 });
        const f = new Date(c.createdAt);
        const ymd = `${f.getUTCFullYear()}${String(f.getUTCMonth() + 1).padStart(2, "0")}${String(f.getUTCDate()).padStart(2, "0")}`;
        const numero = `CT-${ymd}-${String(c.id).padStart(8, "0")}`;
        verificacion = { qrPng, codigo: c.verificationCode, numero, url };
      } catch {
        verificacion = null;
      }
    }
    return {
      patientId: c.patientId,
      professionalId: c.professionalId,
      consultationId: c.consultationId ?? null,
      datos: {
        titulo: `Certificado médico`,
        tipoDocumento: "certificado",
        fechaEmision: c.createdAt,
        campos: [
          { etiqueta: "Tipo", valor: c.certificateType },
          { etiqueta: "Diagnóstico", valor: c.diagnosis ?? "" },
          { etiqueta: "Días de reposo", valor: c.restDays != null ? String(c.restDays) : "" },
        ],
        cuerpo: c.content,
        observaciones: c.observations,
        verificacion,
      },
    };
  }
  if (sourceType === "indicacion") {
    const [i] = await db.select().from(indicacionesPacientesTable).where(eq(indicacionesPacientesTable.id, sourceId)).limit(1);
    if (!i) return null;
    return {
      patientId: i.patientId,
      professionalId: i.professionalId,
      consultationId: i.consultationId ?? null,
      datos: armarDatosIndicaciones({
        fechaEmision: i.createdAt,
        estudios: i.estudios,
        medicamentos: i.medicamentos,
        otrasIndicaciones: i.otrasIndicaciones,
      }),
    };
  }
  if (sourceType === "orden_estudio") {
    const [o] = await db.select().from(studyOrdersTable).where(eq(studyOrdersTable.id, sourceId)).limit(1);
    if (!o) return null;
    // Token de verificación pública: se genera perezosamente al armar el
    // primer PDF de la orden (cubre también las órdenes anteriores al circuito).
    let codigo = o.verificationCode;
    if (!codigo) {
      // Reclamo atómico: solo escribe si sigue NULL. Si otro pedido concurrente
      // ganó la carrera, se usa el código que quedó persistido — el QR impreso
      // SIEMPRE sale del valor guardado en la base, nunca de un candidato local.
      try {
        const candidato = randomBytes(10).toString("hex");
        const [fila] = await db
          .update(studyOrdersTable)
          .set({ verificationCode: candidato })
          .where(and(eq(studyOrdersTable.id, o.id), isNull(studyOrdersTable.verificationCode)))
          .returning({ verificationCode: studyOrdersTable.verificationCode });
        if (fila) {
          codigo = fila.verificationCode;
        } else {
          const [rec] = await db
            .select({ verificationCode: studyOrdersTable.verificationCode })
            .from(studyOrdersTable)
            .where(eq(studyOrdersTable.id, o.id))
            .limit(1);
          codigo = rec?.verificationCode ?? null;
        }
      } catch {
        codigo = null; // si no se pudo persistir, la orden sale sin QR (nunca un código huérfano)
      }
    }
    const fuente = await armarFuenteOrdenEstudio(o);
    // QR + link de verificación: SOLO en la orden de baja complejidad (las de
    // alta complejidad salen como planilla IOMA, sin verificador por ahora).
    const baseVerificacion = urlPublicaApp();
    if (!fuente.datos.planilla && codigo && baseVerificacion) {
      try {
        const url = `${baseVerificacion}/verificar-orden/${codigo}`;
        const qrPng = await QRCode.toBuffer(url, { margin: 1, width: 220 });
        fuente.datos.verificacion = { qrPng, codigo, numero: numeroOrdenEstudio(o), url };
      } catch {
        fuente.datos.verificacion = null;
      }
    }
    return fuente;
  }
  return null;
}

// Arma los datos del PDF de "Indicaciones para el paciente". Compartido por
// la emisión, la vista previa (borrador sin persistir) y el push a la app.
export function armarDatosIndicaciones(i: {
  fechaEmision: Date;
  estudios?: string | null;
  medicamentos?: string | null;
  otrasIndicaciones?: string | null;
}): Omit<DatosDocumentoPdf, "paciente" | "profesional"> {
  const secciones: string[] = [];
  if (i.estudios?.trim()) secciones.push(`ESTUDIOS A REALIZAR:\n${i.estudios.trim()}`);
  if (i.medicamentos?.trim()) secciones.push(`MEDICAMENTOS Y CÓMO TOMARLOS:\n${i.medicamentos.trim()}`);
  if (i.otrasIndicaciones?.trim()) secciones.push(`OTRAS INDICACIONES:\n${i.otrasIndicaciones.trim()}`);
  return {
    titulo: "Indicaciones para el paciente",
    tipoDocumento: "indicaciones",
    fechaEmision: i.fechaEmision,
    campos: [],
    cuerpo: secciones.join("\n\n"),
    observaciones: "Ante dudas sobre estas indicaciones, consultá con tu médico o comunicate con Diagnosticar Medical Center.",
  };
}

// Número institucional de la orden de estudio, derivable del registro
// (fecha de emisión + id con ceros): OE-AAAAMMDD-XXXXXXXX. Mismo criterio
// que el número CT de los certificados.
export function numeroOrdenEstudio(o: { id: number; createdAt: Date | string }): string {
  const f = new Date(o.createdAt);
  const ymd = `${f.getUTCFullYear()}${String(f.getUTCMonth() + 1).padStart(2, "0")}${String(f.getUTCDate()).padStart(2, "0")}`;
  return `OE-${ymd}-${String(o.id).padStart(8, "0")}`;
}

// Campos de una orden de estudio necesarios para armar el PDF. Acepta tanto
// una fila persistida como un borrador (vista previa antes de emitir).
export type OrdenEstudioParaPdf = {
  patientId: number;
  professionalId: number;
  consultationId?: number | null;
  createdAt: Date;
  studyType: string;
  studyName: string;
  practicaId?: number | null;
  contraste?: boolean | null;
  billingCodes?: string | null;
  clinicalJustification?: string | null;
  priority?: string | null;
  preparationRequired?: string | null;
  observations?: string | null;
  resumenHc?: string | null;
  // Estado de firma persistido en la base ("pendiente_firma" | "firmada" | ...).
  // Si no viene (vista previa / borrador), la planilla sale SIN firma.
  firmaEstado?: string | null;
};

export async function armarFuenteOrdenEstudio(o: OrdenEstudioParaPdf): Promise<FuentePdf> {
  {
    // Órdenes de alta complejidad (elegidas del catálogo de prácticas) se
    // imprimen como Planilla de Denuncia IOMA, con el resumen de HC del paciente.
    let planilla: NonNullable<DatosDocumentoPdf["planilla"]> | null = null;
    if (o.practicaId != null) {
      const [pc] = await db
        .select()
        .from(practicasCatalogoTable)
        .where(eq(practicasCatalogoTable.id, o.practicaId))
        .limit(1);
      // Códigos: primero el snapshot de facturación (nomenclador IOMA); si la
      // práctica no lo tiene cargado, cae al código de facturación del catálogo.
      // Nunca imprimimos el código interno (ej. RM-COL-LUMBAR): si no hay código
      // IOMA, la columna queda en blanco para completar a mano.
      let codigosFuente = o.billingCodes ?? "";
      if (!codigosFuente.trim()) {
        const reglas = (pc?.reglasKlinicos ?? null) as { practiceCode?: string } | null;
        codigosFuente = reglas?.practiceCode ?? "";
      }
      const codigos = codigosFuente
        .split(/[,;]+/)
        .map((c) => c.trim())
        .filter(Boolean);
      // Las resonancias se hacen siempre en resonador abierto: va aclarado en la planilla.
      const esResonancia = pc?.categoria === "resonancia" || /resonancia|angiorresonancia/i.test(o.studyName);
      let nombrePractica = o.studyName;
      if (esResonancia && !/resonador abierto/i.test(nombrePractica)) nombrePractica = `${nombrePractica} en resonador abierto`;
      if (o.contraste) nombrePractica = `${nombrePractica} CON CONTRASTE`;
      const practicas =
        codigos.length > 0
          ? codigos.map((codigo, i) => ({ codigo, subgrupo: "", descripcion: i === 0 ? nombrePractica : "" }))
          : [{ codigo: "", subgrupo: "", descripcion: nombrePractica }];

      // Resumen de HC: solo lo que redactó el médico (o el asistente IA) en la
      // orden. Sin autotexto desde la consulta: si no hay resumen, va en blanco.
      const resumenHistoria: string | null = o.resumenHc?.trim() || null;
      const justificacion = o.clinicalJustification?.trim() || null;
      planilla = {
        practicas,
        diagnostico: justificacion,
        resumenHistoria: [resumenHistoria, justificacion ? `Justificación del estudio: ${justificacion}` : null]
          .filter(Boolean)
          .join("\n") || null,
        examenesPrevios: o.observations?.trim() || null,
      };
    }

    return {
      patientId: o.patientId,
      professionalId: o.professionalId,
      consultationId: o.consultationId ?? null,
      datos: {
        titulo: "Orden de estudio",
        tipoDocumento: "orden_estudio",
        fechaEmision: o.createdAt,
        campos: [
          { etiqueta: "Tipo de estudio", valor: o.studyType },
          { etiqueta: "Estudio", valor: o.contraste ? `${o.studyName} con contraste` : o.studyName },
          { etiqueta: "Códigos", valor: o.billingCodes ?? "" },
          { etiqueta: "Justificación clínica", valor: o.clinicalJustification ?? "" },
          { etiqueta: "Prioridad", valor: o.priority === "urgente" ? "URGENTE" : "Normal" },
          { etiqueta: "Preparación previa", valor: o.preparationRequired ?? "" },
        ],
        observaciones: o.observations,
        planilla,
        // La autorización de firma sale EXCLUSIVAMENTE del estado persistido en
        // la base: solo una planilla con firma_estado = 'firmada' estampa firma
        // y sello. Vista previa y borradores nunca la traen.
        ...(planilla ? { firmaAutorizada: o.firmaEstado === "firmada" } : {}),
      },
    };
  }
}
