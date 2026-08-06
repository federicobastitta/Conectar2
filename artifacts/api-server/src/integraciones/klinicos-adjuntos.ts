// Adjuntar la orden médica (PDF) a la atención en Klinicos.
//
// Lección del usuario (03/08/2026, prácticas de cardiología): tras confirmar
// la prestación, en el detalle de la atención se usa Acciones (herramienta) →
// "Adjuntar documentación" → "Documentos múltiples", se tilda el tipo
// "Orden de práctica/s" (máx 1.5 MB), se sube el PDF de la orden y se guarda
// con descripción "orden medica". El PDF es la orden de baja complejidad de
// Conectar (logo Diagnosticar, prescriptor de la práctica, datos del
// paciente, fecha 1–7 días antes de la carga).
//
// Calibración en vivo, fail-closed (patrón ARM v2): los endpoints y nombres
// de campos exactos del formulario de adjuntos se descubren en la primera
// corrida real; si algo no aparece como se espera, NO se envía nada y el
// detalle explica qué faltó (el operador adjunta a mano).

import { eq } from "drizzle-orm";
import {
  db,
  especialidadesTable,
  ordenesPracticasTable,
  pacientesTable,
  practicasCatalogoTable,
  profesionalesTable,
} from "@workspace/db";
import { generarPdfDocumento } from "../pdf/documento_pdf";
import { prepararDatosPdf } from "../pdf/escaneado";
import { logger } from "../lib/logger";
import { jarFetch, camposDeForm, type CookieJar, BASE_URL } from "./klinicos-robot";

// Límite del portal (visto en la pantalla: "máximo 1.5 MB")
const MAX_PDF_BYTES = 1.5 * 1024 * 1024;

export interface GuardasAdjunto {
  yaAdjuntada: boolean;
  postYaIntentado: boolean;
  marcarIntentado: () => Promise<void>;
  marcarAdjuntada: (detalle: string) => Promise<void>;
  /** El portal rechazó el envío con validación explícita (no guardó nada):
   * limpiar el intento para que Reintentar pueda volver a subir. */
  limpiarIntento?: () => Promise<void>;
  /** El adjunto NO pudo subirse (PDF demasiado grande, portal caído, etc.):
   * persistir el motivo para que la bandeja muestre el aviso al staff. */
  marcarFallo?: (detalle: string) => Promise<void>;
}

export interface AdjuntoOrdenOpciones {
  obtenerPdf: () => Promise<{ ok: true; pdf: Buffer; nombre: string } | { ok: false; detalle: string }>;
  guardas: GuardasAdjunto;
}

// ── PDF de la orden desde la ficha de Conectar ──────────────────────────────
export async function generarPdfOrdenBuffer(
  ordenId: number,
): Promise<{ ok: true; pdf: Buffer; nombre: string } | { ok: false; detalle: string }> {
  const [orden] = await db.select().from(ordenesPracticasTable).where(eq(ordenesPracticasTable.id, ordenId)).limit(1);
  if (!orden) return { ok: false, detalle: `la orden ${ordenId} no existe en Conectar` };
  const [paciente] = await db.select().from(pacientesTable).where(eq(pacientesTable.id, orden.patientId)).limit(1);
  if (!paciente) return { ok: false, detalle: "la orden no tiene paciente válido" };
  const [profesional] = await db
    .select()
    .from(profesionalesTable)
    .where(eq(profesionalesTable.id, orden.professionalId))
    .limit(1);
  if (!profesional) return { ok: false, detalle: "la orden no tiene profesional prescriptor válido" };
  if (!profesional.matricula) return { ok: false, detalle: `el prescriptor ${profesional.apellido} no tiene matrícula registrada` };
  const [practica] = await db
    .select()
    .from(practicasCatalogoTable)
    .where(eq(practicasCatalogoTable.id, orden.practicaId))
    .limit(1);
  if (!practica) return { ok: false, detalle: "la orden no tiene práctica válida del catálogo" };

  let especialidad: string | null = null;
  if (profesional.especialidadId != null) {
    const [esp] = await db
      .select()
      .from(especialidadesTable)
      .where(eq(especialidadesTable.id, profesional.especialidadId))
      .limit(1);
    especialidad = esp?.nombre ?? null;
  }

  const campos: Array<{ etiqueta: string; valor: string }> = [
    { etiqueta: "Práctica", valor: practica.nombre },
    ...(orden.region ? [{ etiqueta: "Región", valor: orden.region }] : []),
    ...(orden.lateralidad ? [{ etiqueta: "Lateralidad", valor: orden.lateralidad }] : []),
    ...(orden.diagnosticoCie10 ? [{ etiqueta: "Diagnóstico (CIE-10)", valor: orden.diagnosticoCie10 }] : []),
    { etiqueta: "Fecha de la orden", valor: orden.fechaOrden },
  ];

  // La fecha de emisión del PDF es la fecha de la ORDEN (1–7 días antes de la
  // carga, regla 03/08/2026), no el momento en que el robot genera el archivo.
  const fechaEmision = new Date(`${orden.fechaOrden}T12:00:00-03:00`);
  const doc = generarPdfDocumento(await prepararDatosPdf({
    titulo: "Orden de práctica",
    tipoDocumento: "orden_estudio",
    paciente: {
      nombre: paciente.nombre,
      apellido: paciente.apellido,
      dni: paciente.dni,
      cobertura: orden.coberturaObra ?? paciente.cobertura,
      nroAfiliado: orden.coberturaNumeroAfiliado ?? paciente.nroAfiliado,
      fechaNacimiento: paciente.fechaNacimiento,
      sexo: paciente.sexo,
      direccion: paciente.direccion,
      localidad: paciente.localidad,
      telefono: paciente.telefono,
    },
    profesional: {
      id: profesional.id,
      nombre: profesional.nombre,
      apellido: profesional.apellido,
      matricula: profesional.matricula,
      especialidad,
      telefonoMovil: profesional.telefonoMovil,
      telefono: profesional.telefono,
      firmaImagen: profesional.firmaImagen,
      caligrafia: profesional.caligrafia,
    },
    fechaEmision,
    campos,
    cuerpo: orden.motivoClinico,
    observaciones: null,
  }));

  const pdf = await new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
    doc.end();
  });
  if (pdf.length > MAX_PDF_BYTES) {
    return { ok: false, detalle: `el PDF de la orden pesa ${(pdf.length / 1024 / 1024).toFixed(2)} MB y el portal acepta hasta 1.5 MB` };
  }
  const nombre = `orden_${paciente.apellido.toLowerCase().replace(/[^a-z0-9]+/gi, "_")}_${orden.numeroOrden.replace(/[^A-Za-z0-9-]+/g, "")}.pdf`;
  return { ok: true, pdf, nombre };
}

// ── Multipart a mano (el portal es ASP.NET clásico; sin FormData para poder
// pasar por jarFetch con cookies y dispatcher propios) ──────────────────────
export function armarMultipart(
  fields: Record<string, string>,
  file: { name: string; filename: string; content: Buffer; contentType: string },
): { body: Buffer; contentType: string } {
  const boundary = `----conectar${Date.now().toString(16)}${Math.floor(Math.random() * 1e8).toString(16)}`;
  const partes: Buffer[] = [];
  for (const [k, v] of Object.entries(fields)) {
    partes.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`, "utf-8"));
  }
  partes.push(
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${file.name}"; filename="${file.filename}"\r\nContent-Type: ${file.contentType}\r\n\r\n`,
      "utf-8",
    ),
    file.content,
    Buffer.from(`\r\n--${boundary}--\r\n`, "utf-8"),
  );
  return { body: Buffer.concat(partes), contentType: `multipart/form-data; boundary=${boundary}` };
}

// Descubre TODAS las URLs candidatas de un patrón en el HTML (href/action/ajax)
function descubrirUrls(html: string, patron: RegExp): string[] {
  const urls = [...html.matchAll(/(?:url\s*[:=]\s*|action=|href=|\.post\(\s*|\.ajax\(\s*\{[^}]*url\s*:\s*)["']([^"']+)["']/gi)]
    .map((m) => m[1]!)
    .filter((u) => u.startsWith("/") && patron.test(u));
  return [...new Set(urls)];
}

interface FormAdjunto {
  action: string;
  campos: Record<string, string>;
  fileInputName: string;
  descripcionField: string | null;
  tipoOrdenCampo: { name: string; value: string } | null;
}

// Busca en el HTML de la pantalla de adjuntos el form multipart y sus campos.
export function extraerFormAdjunto(html: string, fallbackAction: string): FormAdjunto | null {
  // Form que contenga un input type="file" (con o sin enctype declarado)
  const forms = [...html.matchAll(/<form([^>]*)>([\s\S]*?)<\/form>/gi)];
  const conFile = forms.find((f) => /<input[^>]*type="file"/i.test(f[2]!));
  const formHtml = conFile?.[2] ?? (/<input[^>]*type="file"/i.test(html) ? html : null);
  if (!formHtml) return null;
  const action = conFile?.[1]?.match(/action="([^"]*)"/i)?.[1] || fallbackAction;
  const fileInputName = formHtml.match(/<input[^>]*type="file"[^>]*name="([^"]*)"/i)?.[1]
    ?? formHtml.match(/name="([^"]*)"[^>]*type="file"/i)?.[1];
  if (!fileInputName) return null;
  const campos = camposDeForm(formHtml);
  delete campos[fileInputName];

  // Tipo de documento "Orden de práctica/s": checkbox o radio cuyo contexto
  // cercano menciona "orden de práctica". Si es un select, camposDeForm ya lo
  // trae; acá cubrimos checkboxes con label alrededor.
  let tipoOrdenCampo: { name: string; value: string } | null = null;
  for (const m of formHtml.matchAll(/<input([^>]*type="(?:checkbox|radio)"[^>]*)>/gi)) {
    const attrs = m[1]!;
    const name = attrs.match(/name="([^"]*)"/)?.[1];
    if (!name) continue;
    const idx = m.index ?? 0;
    const contexto = formHtml.slice(Math.max(0, idx - 300), idx + 400);
    if (/orden\s+de\s+pr[aá]ctica/i.test(contexto)) {
      tipoOrdenCampo = { name, value: attrs.match(/value="([^"]*)"/)?.[1] ?? "true" };
      break;
    }
  }
  // Select de tipo de documento: elegir la opción "Orden de práctica/s"
  if (!tipoOrdenCampo) {
    for (const m of formHtml.matchAll(/<select[^>]*name="([^"]*)"[^>]*>([\s\S]*?)<\/select>/gi)) {
      const opcion = [...m[2]!.matchAll(/<option[^>]*value="([^"]*)"[^>]*>([^<]*)</gi)].find((o) =>
        /orden\s+de\s+pr[aá]ctica/i.test(o[2]!),
      );
      if (opcion) {
        tipoOrdenCampo = { name: m[1]!, value: opcion[1]! };
        break;
      }
    }
  }

  const descripcionField =
    formHtml.match(/<(?:input|textarea)[^>]*name="([^"]*(?:descripcion|Descripcion|description)[^"]*)"/i)?.[1] ?? null;
  return { action, campos, fileInputName, descripcionField, tipoOrdenCampo };
}

// ── Subida real (contrato calibrado en vivo el 03/08/2026 con el Holter de
// Frontini). Dos pasos del portal:
//   1. POST /repositorio/UploadMultipleFile (multipart): sube el PDF al
//      repositorio del paciente con selAcronimo=6 ("Orden de práctica/s",
//      máx 1.5 MB), descripcionesArchivos, idPacienteRepositorio (GUID del
//      paciente que aparece en el JS del detalle como `let idPaciente = '…'`),
//      tipoEntidadAsociada="Prestacion" e idEntidadAsociada=Id numérico de la
//      fila de la prestación (grilla AJAX).
//   2. POST /ordenPrestacion/vincular-documentacion {id, idArchivo,
//      vincularA:"PRESTACION"} — sin este paso el archivo queda en el
//      repositorio pero la prestación NO lo muestra adjunto
//      (TieneDocumentacionCargada sigue en false).
// Fail-closed: cualquier pieza que no aparezca como se espera aborta con
// detalle para adjuntar a mano.
export async function adjuntarOrdenReal(
  jar: CookieJar,
  atencionId: string,
  pdf: Buffer,
  nombreArchivo: string,
  detallePath?: string,
  numeroPrestacion?: string,
): Promise<{ ok: boolean; detalle: string; rechazoDefinitivo?: boolean }> {
  // 1. Detalle de la atención → GUID del paciente para el repositorio
  const pathDetalle = detallePath ?? `/atencion/detalle/${atencionId}`;
  const detalle = await jarFetch(jar, pathDetalle, { referer: `${BASE_URL}/paciente` });
  if (detalle.status !== 200) {
    return { ok: false, detalle: `GET detalle de la atención → ${detalle.status} (no se pudo abrir la pantalla para adjuntar)`, rechazoDefinitivo: true };
  }
  const idPacienteRepo = detalle.text.match(/(?:let|var)\s+idPaciente\s*=\s*'([0-9a-f-]{36})'/i)?.[1];
  if (!idPacienteRepo) {
    return { ok: false, detalle: "No se encontró el GUID del paciente para el repositorio en el detalle de la atención — adjuntar la orden a mano", rechazoDefinitivo: true };
  }

  // 2. Id numérico de la fila de la prestación (grilla AJAX)
  const { leerFilasPrestacionesAjax } = await import("./klinicos-prestaciones");
  const grilla = await leerFilasPrestacionesAjax(jar, atencionId);
  if (!grilla.ok) {
    return { ok: false, detalle: `No se pudo leer la grilla de prestaciones para ubicar la fila: ${grilla.detalle}`, rechazoDefinitivo: true };
  }
  const numeros = [...grilla.crudos.keys()];
  const numero = numeroPrestacion ?? numeros.filter((n) => n.startsWith("P-")).sort().pop();
  const crudo = numero ? grilla.crudos.get(numero) : undefined;
  const filaId = crudo?.match(/"Id"\s*:\s*(\d+)/)?.[1];
  if (!filaId) {
    return { ok: false, detalle: `No se encontró la prestación ${numeroPrestacion ?? "(práctica)"} en la grilla para vincular el adjunto — adjuntar a mano`, rechazoDefinitivo: true };
  }

  // 3. Subida al repositorio (el intento ya quedó persistido por la guarda del llamador)
  const { body, contentType } = armarMultipart(
    {
      descripcionesArchivos: "orden medica",
      idPacienteRepositorio: idPacienteRepo,
      tipoEntidadAsociada: "Prestacion",
      idEntidadAsociada: filaId,
      selAcronimo: "6", // "Orden de práctica/s"
    },
    { name: "files", filename: nombreArchivo, content: pdf, contentType: "application/pdf" },
  );
  const post = await jarFetch(jar, "/repositorio/UploadMultipleFile", {
    method: "POST",
    body,
    contentType,
    xhr: true,
    referer: `${BASE_URL}${pathDetalle}`,
  });
  logger.info({ atencionId, filaId, status: post.status }, "klinicos-adjuntos: POST de adjunto enviado");
  if (post.status !== 200) {
    return { ok: false, detalle: `POST subida del adjunto → ${post.status}${post.location ? ` (${post.location})` : ""}` };
  }
  let archivoId: string | undefined;
  try {
    const r = JSON.parse(post.text) as { error?: boolean; message?: string; data?: string };
    if (r.error) {
      return { ok: false, detalle: `El portal rechazó el adjunto: ${r.message ?? "(sin mensaje)"}`, rechazoDefinitivo: true };
    }
    const items = JSON.parse(r.data ?? "[]") as Array<{ archivo?: string; response?: string }>;
    for (const item of items) {
      const archivo = item.archivo ? (JSON.parse(item.archivo) as { id?: string }) : null;
      if (archivo?.id) archivoId = archivo.id;
    }
  } catch {
    /* respuesta no parseable */
  }
  if (!archivoId) {
    return { ok: false, detalle: "El portal devolvió 200 sin confirmar el archivo subido: verificar A MANO en Klinicos si la orden quedó adjunta (no se re-envía sola)" };
  }

  // 4. Vincular el archivo a la prestación (paso obligatorio)
  const vinc = await jarFetch(jar, "/ordenPrestacion/vincular-documentacion", {
    method: "POST",
    xhr: true,
    contentType: "application/x-www-form-urlencoded; charset=UTF-8",
    body: new URLSearchParams({ id: filaId, idArchivo: archivoId, vincularA: "PRESTACION" }).toString(),
    referer: `${BASE_URL}${pathDetalle}`,
  });
  try {
    const rv = JSON.parse(vinc.text) as { error?: boolean; message?: string };
    if (vinc.status === 200 && rv.error === false) {
      return { ok: true, detalle: `Orden adjuntada y vinculada a ${numero} (descripción "orden medica", archivo ${nombreArchivo})` };
    }
    return { ok: false, detalle: `El archivo subió (id ${archivoId}) pero la vinculación a la prestación falló: ${rv.message ?? `HTTP ${vinc.status}`} — vincular a mano en Klinicos` };
  } catch {
    return { ok: false, detalle: `El archivo subió (id ${archivoId}) pero la vinculación devolvió una respuesta no reconocible (HTTP ${vinc.status}) — verificar a mano en Klinicos` };
  }
}
