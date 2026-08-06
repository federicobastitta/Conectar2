import PDFDocument from "pdfkit";
import { LOGO_DIAGNOSTICAR } from "./logo_diagnosticar";
import { LOGO_IOMA, BANDA_TITULO_IOMA } from "./logo_ioma";
import {
  fuenteManuscritaParaProfesional,
  escribirManuscrito,
  escribirManuscritoLinea,
  type FuenteManuscrita,
} from "./fuentes_manuscritas";

// Motor PDF centralizado con identidad Diagnosticar.
// Genera el PDF on-the-fly a partir de los datos del documento clínico.

export type DatosDocumentoPdf = {
  titulo: string;
  tipoDocumento: string;
  paciente: {
    nombre: string;
    apellido: string;
    dni: string | null;
    cobertura: string | null;
    // N° de beneficiario / afiliado en la obra social (modelo de orden médica)
    nroAfiliado?: string | null;
    fechaNacimiento?: string | null;
    sexo?: string | null;
    direccion?: string | null;
    localidad?: string | null;
    telefono?: string | null;
  };
  profesional: {
    // Id del profesional: define qué letra manuscrita "escribe" la orden
    // (cada médico usa siempre la misma). Si falta, se usa la primera.
    id?: number | null;
    nombre: string;
    apellido: string | null;
    matricula: string | null;
    especialidad?: string | null;
    telefonoMovil?: string | null;
    telefono?: string | null;
    // Data URL PNG/JPEG con la firma escaneada del profesional; se estampa
    // sobre la línea de firma cuando está presente.
    firmaImagen?: string | null;
    // Caligrafía manuscrita elegida por el médico (0-4); null = usa id % 5.
    caligrafia?: number | null;
  };
  fechaEmision: Date;
  campos: Array<{ etiqueta: string; valor: string }>;
  cuerpo?: string | null;
  observaciones?: string | null;
  // Cuando está presente, la orden de estudio se imprime con el formato de
  // "Planilla de denuncia — Alta complejidad" (modelo IOMA) autocompletada.
  planilla?: {
    practicas: Array<{ codigo: string; subgrupo: string; descripcion: string }>;
    diagnostico: string | null;
    resumenHistoria: string | null;
    examenesPrevios: string | null;
  } | null;
  // QR de verificación de autenticidad (certificados): imagen PNG ya generada
  // y código legible que también figura impreso. Para certificados con la
  // presentación digital: número institucional (CT-...) y URL clickeable.
  verificacion?: { qrPng: Buffer; codigo: string; numero?: string | null; url?: string | null } | null;
  // Planillas IOMA: la firma y el sello se estampan SOLO cuando este flag es
  // true. Lo setea el backend a partir del estado persistido en la base
  // (study_orders.firma_estado = 'firmada'); jamás viene del frontend.
  // undefined = documentos sin circuito de aprobación (comportamiento clásico).
  firmaAutorizada?: boolean;
  // Efecto "escaneado" (órdenes en blanco y negro): logos ya convertidos a
  // escala de grises por prepararDatosPdf (pdf/escaneado.ts).
  escaneado?: { logoDiagnosticar?: Buffer; logoIoma?: Buffer };
};

const AZUL = "#1d4ed8";
const GRIS = "#6b7280";
const NEGRO = "#111827";

// Registra en el documento la letra manuscrita que le corresponde al
// profesional (siempre la misma para cada médico) y la devuelve.
// Tinta: desde jul-2026 todo lo "escrito" por el médico sale en NEGRO para
// que las órdenes escaneen bien (pedido de la clínica). La única excepción
// son los CERTIFICADOS, que conservan la birome azul clásica.
function registrarManuscrita(doc: PDFKit.PDFDocument, datos: DatosDocumentoPdf): FuenteManuscrita {
  const fuente = fuenteManuscritaParaProfesional(datos.profesional.id, datos.profesional.caligrafia);
  doc.registerFont(fuente.nombre, fuente.ttf);
  if (datos.tipoDocumento === "certificado") return fuente;
  return { ...fuente, tinta: NEGRO };
}

export function generarPdfDocumento(datos: DatosDocumentoPdf): PDFKit.PDFDocument {
  if (datos.tipoDocumento === "orden_estudio" && datos.planilla) {
    // Alta complejidad: DOS hojas en el mismo archivo — la Planilla de
    // Denuncia IOMA y, en la segunda página, la orden médica común (igual a
    // la de baja complejidad) pidiendo el mismo estudio.
    const doc = generarPdfPlanillaAltaComplejidad(datos);
    doc.addPage({ size: "A4", margins: { top: 50, bottom: 50, left: 50, right: 50 } });
    return generarPdfOrdenEstudio(datos, doc);
  }
  if (datos.tipoDocumento === "orden_estudio") return generarPdfOrdenEstudio(datos);
  return generarPdfGenerico(datos);
}

function edadDesdeFechaNacimiento(fecha: string | null | undefined, hoy: Date): string {
  if (!fecha) return "";
  const nac = new Date(`${fecha}T00:00:00.000Z`);
  if (isNaN(nac.getTime())) return "";
  let edad = hoy.getUTCFullYear() - nac.getUTCFullYear();
  const m = hoy.getUTCMonth() - nac.getUTCMonth();
  if (m < 0 || (m === 0 && hoy.getUTCDate() < nac.getUTCDate())) edad--;
  return edad >= 0 && edad < 130 ? String(edad) : "";
}

// Réplica digital de la "PLANILLA DE DENUNCIA - ALTA COMPLEJIDAD" (IOMA),
// autocompletada con los datos del paciente, el profesional, las prácticas
// con sus códigos y el resumen de historia clínica.
function generarPdfPlanillaAltaComplejidad(datos: DatosDocumentoPdf): PDFKit.PDFDocument {
  const doc = new PDFDocument({ size: "A4", margin: 40 });
  const p = datos.planilla!;
  // Letra manuscrita del médico (bolígrafo azul) para lo que él "escribe":
  // diagnóstico, prácticas, resumen de HC y exámenes previos.
  const manuscrita = registrarManuscrita(doc, datos);
  const X = 40;
  const ANCHO = 515;
  const MITAD = X + ANCHO / 2;

  // Firma + sello del profesional (como en el modelo IOMA: la firma manuscrita
  // superpuesta al sello con nombre, especialidad y matrícula).
  const estamparFirmaYSello = (x: number, yTope: number, anchoImg: number, altoImg: number) => {
    // Circuito de aprobación: mientras la planilla no esté firmada en la base,
    // no se estampa NADA (ni firma ni sello); el espacio queda en blanco,
    // como un formulario sin completar (pedido del usuario: sin cartel).
    if (datos.firmaAutorizada === false) return;
    // La firma escaneada real ya trae el sello del médico dentro de la
    // imagen: si hay firma, va SOLO la firma (pedido 03/08/2026, evitar
    // doble sello). El sello en texto es solo respaldo sin firma cargada.
    if (datos.profesional.firmaImagen) {
      try {
        const base64 = datos.profesional.firmaImagen.split(",")[1] ?? "";
        const buf = Buffer.from(base64, "base64");
        doc.image(buf, x, yTope, { fit: [anchoImg, altoImg - 4], align: "center", valign: "bottom" });
        return;
      } catch {
        // Si la imagen está corrupta, la planilla sale igual con el sello en texto.
      }
    }
    const nombreSello = `${datos.profesional.apellido ? "Dr/a. " : ""}${datos.profesional.nombre} ${datos.profesional.apellido ?? ""}`.trim();
    const lineasSello = [
      nombreSello,
      (datos.profesional.especialidad ?? "").toUpperCase(),
      datos.profesional.matricula ? `M.P. ${datos.profesional.matricula.replace(/^\s*M\.?\s*P\.?\s*/i, "")}` : "",
    ].filter(Boolean);
    const tamanoSello = anchoImg < 130 ? 6 : anchoImg > 200 ? 9 : 7.5;
    const interlineado = tamanoSello + 2;
    const ySello = yTope + altoImg - lineasSello.length * interlineado;
    doc.fontSize(tamanoSello).font("Helvetica").fillColor(NEGRO);
    lineasSello.forEach((linea, i) => {
      doc.text(linea, x, ySello + i * interlineado, { width: anchoImg, align: "center", lineBreak: false });
    });
  };

  // Logo IOMA arriba a la derecha (imagen extraída del modelo oficial)
  try {
    doc.image(datos.escaneado?.logoIoma ?? LOGO_IOMA, X + ANCHO - 130, 36, { fit: [130, 28], align: "right" });
  } catch {
    doc.fillColor(NEGRO).fontSize(30).font("Helvetica-BoldOblique")
      .text("IOMA", X + ANCHO - 130, 34, { width: 130, align: "right", characterSpacing: 2 });
  }

  // Banda negra con el título (imagen extraída del modelo oficial)
  const yBanda = 70;
  try {
    doc.image(BANDA_TITULO_IOMA, X, yBanda, { fit: [ANCHO, 20] });
  } catch {
    doc.roundedRect(X, yBanda, ANCHO, 20, 9).fill(NEGRO);
    doc.fillColor("#ffffff").fontSize(11).font("Helvetica-Bold")
      .text("PLANILLA DE DENUNCIA - ALTA COMPLEJIDAD", X, yBanda + 5, { width: ANCHO, align: "center" });
  }

  const fecha = datos.fechaEmision.toLocaleDateString("es-AR", { day: "2-digit", month: "2-digit", year: "numeric" });
  doc.fillColor(NEGRO).fontSize(9.5).font("Helvetica")
    .text(`Fecha: ${fecha}`, X, yBanda + 30, { width: ANCHO, align: "right" });
  doc.fontSize(10.5).font("Helvetica-Bold")
    .text("COBERTURA 100% A CARGO DE IOMA", X, yBanda + 44, { width: ANCHO, align: "center" });

  // Tabla de datos paciente / profesional: filas con líneas horizontales
  const yBox = yBanda + 60;
  const altoFilaDato = 16;
  const filasDatos = 8; // encabezado + 7 filas de campos
  const altoBox = altoFilaDato * filasDatos;
  doc.lineWidth(0.9).strokeColor(NEGRO);
  doc.rect(X, yBox, ANCHO, altoBox).stroke();
  doc.moveTo(MITAD, yBox).lineTo(MITAD, yBox + altoBox).stroke();
  for (let i = 1; i < filasDatos; i++) {
    const yl = yBox + i * altoFilaDato;
    doc.moveTo(X, yl).lineTo(X + ANCHO, yl).lineWidth(0.5).stroke();
  }
  doc.lineWidth(0.9);

  const campo = (etiqueta: string, valor: string, x: number, fila: number, ancho: number) => {
    const yc = yBox + fila * altoFilaDato + 4;
    doc.fontSize(8.5).font("Helvetica-Bold").fillColor(NEGRO).text(`${etiqueta}: `, x, yc, { lineBreak: false });
    // El valor lo "escribe" el médico: letra manuscrita con pulso imperfecto.
    const anchoEtiqueta = doc.widthOfString(`${etiqueta}: `);
    escribirManuscritoLinea(doc, manuscrita, valor || "", x + anchoEtiqueta + 2, yc - 2, 8.5 * manuscrita.escala, ancho - anchoEtiqueta - 4);
    doc.fillColor(NEGRO);
  };

  const edad = edadDesdeFechaNacimiento(datos.paciente.fechaNacimiento, datos.fechaEmision);
  const sexo = (datos.paciente.sexo ?? "").charAt(0).toUpperCase();
  const anchoCol = ANCHO / 2 - 16;

  doc.fontSize(9).font("Helvetica-Bold").text("DATOS DEL PACIENTE", X + 8, yBox + 4);
  campo("Apellido", datos.paciente.apellido.toUpperCase(), X + 8, 1, anchoCol);
  campo("Nombres", datos.paciente.nombre, X + 8, 2, anchoCol);
  // Pedido 03/08/2026: en "Afiliado N°" va SOLO el número de afiliado real.
  // Si el paciente no lo tiene cargado, el campo queda en blanco para
  // completar a mano (nunca el DNI, que iba a parar al casillero equivocado).
  campo("Afiliado N°", datos.paciente.nroAfiliado ?? "", X + 8, 3, anchoCol);
  campo("Edad", edad, X + 8, 4, anchoCol / 2);
  // Pedido 04/08/2026: sin dato, el campo queda en blanco para completar a
  // mano (nada de "F - M" ni direcciones basura tipo "11 11" sin calle).
  // Se considera dirección real si tiene letras (nombre de calle) o, siendo
  // solo numérica (calles numeradas tipo La Plata), incluye una altura de 3+
  // dígitos. Relleno tipo "11 11" o "-" queda en blanco.
  const direccion = (datos.paciente.direccion ?? "").trim();
  const direccionValida = /[a-záéíóúñ]/i.test(direccion) || /\d{3,}/.test(direccion) ? direccion : "";
  campo("Sexo", sexo, X + 8 + anchoCol / 2, 4, anchoCol / 2);
  campo("Dirección", direccionValida, X + 8, 5, anchoCol);
  campo("Localidad", datos.paciente.localidad ?? "", X + 8, 6, anchoCol);
  campo("Teléfono", datos.paciente.telefono ?? "", X + 8, 7, anchoCol);

  // Los datos del profesional quedan en blanco: los completa la firma + sello,
  // que va grande ocupando el recuadro (sin tapar texto porque no hay).
  doc.fontSize(9).font("Helvetica-Bold").text("DATOS DEL PROFESIONAL SOLICITANTE", MITAD + 8, yBox + 4);
  campo("Apellido", "", MITAD + 8, 1, anchoCol);
  campo("Nombres", "", MITAD + 8, 2, anchoCol);
  campo("Matrícula Prov.", "", MITAD + 8, 3, anchoCol);
  campo("Tel. celular", "", MITAD + 8, 4, anchoCol);
  campo("Tel. part.", "", MITAD + 8, 5, anchoCol);
  campo("Tel. consult.", "", MITAD + 8, 6, anchoCol);
  // La última fila derecha queda vacía, como en el modelo oficial.

  // Firma + sello grandes sobre el recuadro del profesional
  estamparFirmaYSello(MITAD + 70, yBox + 22, ANCHO / 2 - 80, altoBox - 32);

  // Diagnóstico presuntivo o confirmado — sobre renglones
  let y = yBox + altoBox + 14;
  doc.fontSize(10).font("Helvetica-Bold").fillColor(NEGRO).text("Diagnóstico presuntivo o confirmado", X, y);
  y += 16;
  // La letra manuscrita se apoya SOBRE cada renglón: la altura de línea del
  // texto se iguala al espaciado de los renglones y la primera línea se
  // posiciona para que su base quede justo encima de la primera raya.
  {
    const espaciado = 15;
    doc.font(manuscrita.nombre).fontSize(8.5 * manuscrita.escala);
    const altoLinea = doc.currentLineHeight();
    escribirManuscrito(doc, manuscrita, p.diagnostico ?? "", X + 2, y + 8 - altoLinea + 2, {
      width: ANCHO - 4, tamano: 8.5 * manuscrita.escala, alto: 2 * espaciado - 2, interlineado: espaciado,
    });
    doc.fillColor(NEGRO);
  }
  for (let i = 0; i < 2; i++) {
    doc.moveTo(X, y + 8).lineTo(X + ANCHO, y + 8).lineWidth(0.7).strokeColor(NEGRO).stroke();
    y += 15;
  }
  y += 8;

  // Tabla de prácticas solicitadas (título dentro de la caja)
  const colCodigo = 90;
  const colSub = 55;
  const altoTitulo = 16;
  const altoFilaEnc = 18;
  doc.lineWidth(0.9).strokeColor(NEGRO);
  doc.rect(X, y, ANCHO, altoTitulo).stroke();
  doc.fontSize(9.5).font("Helvetica-Bold").text("PRÁCTICAS SOLICITADAS", X, y + 4, { width: ANCHO, align: "center" });
  y += altoTitulo;
  doc.rect(X, y, ANCHO, altoFilaEnc).stroke();
  doc.fontSize(8).font("Helvetica-Bold");
  doc.text("Código", X, y + 5, { width: colCodigo, align: "center" });
  doc.text("Sub\ngrupo", X + colCodigo, y + 1, { width: colSub, align: "center", lineGap: -1 });
  doc.text("Descripción", X + colCodigo + colSub, y + 5, { width: ANCHO - colCodigo - colSub, align: "center" });
  doc.moveTo(X + colCodigo, y).lineTo(X + colCodigo, y + altoFilaEnc).stroke();
  doc.moveTo(X + colCodigo + colSub, y).lineTo(X + colCodigo + colSub, y + altoFilaEnc).stroke();
  y += altoFilaEnc;
  const filas = p.practicas.length > 0 ? p.practicas : [{ codigo: "", subgrupo: "", descripcion: "" }];
  const filasTotales = Math.max(filas.length, 3);
  doc.fontSize(9 * manuscrita.escala).font(manuscrita.nombre).fillColor(manuscrita.tinta);
  for (let i = 0; i < filasTotales; i++) {
    const f = filas[i];
    const altoFila = 18;
    doc.strokeColor(NEGRO);
    doc.rect(X, y, ANCHO, altoFila).stroke();
    doc.moveTo(X + colCodigo, y).lineTo(X + colCodigo, y + altoFila).stroke();
    doc.moveTo(X + colCodigo + colSub, y).lineTo(X + colCodigo + colSub, y + altoFila).stroke();
    if (f) {
      escribirManuscritoLinea(doc, manuscrita, f.codigo, X + 12, y + 3, 9 * manuscrita.escala, colCodigo - 16);
      escribirManuscritoLinea(doc, manuscrita, f.subgrupo, X + colCodigo + 8, y + 3, 9 * manuscrita.escala, colSub - 12);
      escribirManuscritoLinea(doc, manuscrita, f.descripcion, X + colCodigo + colSub + 6, y + 3, 9 * manuscrita.escala, ANCHO - colCodigo - colSub - 12);
    }
    y += altoFila;
  }
  doc.fillColor(NEGRO);
  y += 14;

  // Sección de texto sobre renglones (resumen / exámenes previos)
  const seccionRenglones = (texto: string, renglones: number) => {
    const espaciado = 15;
    // Igual que en el diagnóstico: cada línea manuscrita ocupa exactamente un
    // renglón y su base queda apoyada sobre la raya correspondiente.
    doc.font(manuscrita.nombre).fontSize(8.5 * manuscrita.escala);
    const altoLinea = doc.currentLineHeight();
    escribirManuscrito(doc, manuscrita, texto, X + 2, y + 8 - altoLinea + 2, {
      width: ANCHO - 4, tamano: 8.5 * manuscrita.escala, alto: renglones * espaciado - 2, interlineado: espaciado,
    });
    doc.fillColor(NEGRO);
    for (let i = 0; i < renglones; i++) {
      doc.moveTo(X, y + 8).lineTo(X + ANCHO, y + 8).lineWidth(0.7).strokeColor(NEGRO).stroke();
      y += espaciado;
    }
  };

  // Resumen de historia clínica y justificación
  doc.fontSize(10).font("Helvetica-Bold")
    .text("Resumen de historia clínica y justificación del estudio o práctica solicitada", X, y);
  y += 11;
  doc.fontSize(7).font("Helvetica").fillColor(NEGRO).text("(Si no es suficiente el espacio, continúe al dorso)", X, y);
  y += 14;
  seccionRenglones(p.resumenHistoria ?? "", 7);
  y += 12;

  // Exámenes previos
  doc.fontSize(10).font("Helvetica-Bold").fillColor(NEGRO)
    .text("Exámenes previos relacionados con la solicitud ", X, y, { continued: true, width: ANCHO });
  doc.font("Helvetica").fontSize(8.5)
    .text("(Enumerar con informe y fecha los estudios avalatorios, además se deberá adjuntar copia de los mismos al momento del estudio).", { width: ANCHO });
  y += 26;
  doc.fontSize(7).font("Helvetica").text("(Si no es suficiente el espacio, continúe al dorso)", X, y);
  y += 12;
  seccionRenglones(p.examenesPrevios ?? "", 5);
  y += 14;

  // Aclaración + firma al pie
  doc.fontSize(8.5).font("Helvetica-Bold").fillColor(NEGRO)
    .text("ACLARACIÓN: ", X, y, { continued: true });
  doc.font("Helvetica").text("Los datos consignados en la presente planilla tienen carácter de DECLARACIÓN JURADA.");

  const yFirma = Math.max(y + 60, 764);
  estamparFirmaYSello(X + ANCHO - 180, yFirma - 62, 170, 58);
  doc.moveTo(X + ANCHO - 190, yFirma).lineTo(X + ANCHO, yFirma).lineWidth(1).strokeColor(NEGRO).stroke();
  doc.fontSize(8).font("Helvetica").fillColor(NEGRO)
    .text("Firma y sello del profesional solicitante", X + ANCHO - 190, yFirma + 4, { width: 190, align: "center" });

  return doc;
}

// Layout según el modelo de orden médica provisto por la clínica:
// Paciente / N° Beneficiario / Entidad / Fecha de consulta, título
// "ORDEN DE ESTUDIO" centrado, el estudio en grande y el diagnóstico.
function generarPdfOrdenEstudio(datos: DatosDocumentoPdf, docExistente?: PDFKit.PDFDocument): PDFKit.PDFDocument {
  // Puede dibujar sobre un documento ya abierto (segunda hoja de una orden
  // de alta complejidad) o crear uno nuevo (orden común de baja complejidad).
  const doc = docExistente ?? new PDFDocument({ size: "A4", margin: 50 });
  // Letra manuscrita del médico (bolígrafo azul) para el texto "escrito":
  // estudio pedido, diagnóstico, preparación y observaciones.
  const manuscrita = registrarManuscrita(doc, datos);

  // Encabezado institucional con el logo de la clínica. Las órdenes salen en
  // blanco y negro "efecto escaneado" (pedido 03/08/2026): logo en grises y
  // todas las líneas en negro.
  try {
    doc.image(datos.escaneado?.logoDiagnosticar ?? LOGO_DIAGNOSTICAR, 50, 46, { fit: [200, 62] });
  } catch {
    doc.fillColor(NEGRO).fontSize(20).font("Helvetica-Bold").text("Diagnosticar", 50, 50);
    doc.fillColor(GRIS).fontSize(9).font("Helvetica").text("Red Clínica Digital — Conectar", 50, 74);
  }
  doc.moveTo(50, 116).lineTo(545, 116).lineWidth(2).strokeColor(NEGRO).stroke();

  const buscar = (etiqueta: string) =>
    datos.campos.find((c) => c.etiqueta.toLowerCase() === etiqueta.toLowerCase())?.valor ?? "";

  // Datos del paciente (formato del modelo)
  let y = 140;
  const linea = (etiqueta: string, valor: string) => {
    if (!valor) return;
    doc.fontSize(11).font("Helvetica-Bold").fillColor(NEGRO).text(`${etiqueta}: `, 50, y, { lineBreak: false });
    // El dato lo "escribe" el médico, pero en el encabezado va alineado con
    // la etiqueta: pulso mucho más contenido (pedido 03/08/2026).
    const anchoEtiqueta = doc.widthOfString(`${etiqueta}: `);
    const prolija = { ...manuscrita, caos: Math.min(manuscrita.caos, 0.35) };
    escribirManuscritoLinea(doc, prolija, valor, 50 + anchoEtiqueta + 3, y - 6, 11 * manuscrita.escala, 495 - anchoEtiqueta - 6);
    doc.fillColor(NEGRO);
    y += 20;
  };
  linea("Paciente", `${datos.paciente.apellido.toUpperCase()} ${datos.paciente.nombre.toUpperCase()}`);
  linea("N° Beneficiario", datos.paciente.nroAfiliado ?? "");
  linea("Entidad", datos.paciente.cobertura ?? "");
  if (!datos.paciente.nroAfiliado && datos.paciente.dni) linea("DNI", datos.paciente.dni);
  linea(
    "Fecha de consulta",
    datos.fechaEmision.toLocaleDateString("es-AR", { day: "2-digit", month: "2-digit", year: "numeric" }),
  );

  // Título centrado
  y += 30;
  doc.fontSize(16).font("Helvetica-Bold").fillColor(NEGRO).text("ORDEN DE ESTUDIO", 50, y, { width: 495, align: "center" });
  y += 50;

  // Estudio solicitado, en grande y alineado a la izquierda, una práctica
  // por renglón con guion adelante.
  const estudio = buscar("Estudio") || datos.titulo;
  const practicasLista = estudio
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => `-${s}`)
    .join("\n");
  // Todo el texto manuscrito se acota al espacio antes de la zona de firma
  // (con "…" si no entra): la orden SIEMPRE sale en una sola hoja.
  const LIMITE_TEXTO_ORDEN = 590;
  y = Math.min(
    escribirManuscrito(doc, manuscrita, practicasLista, 50, y, {
      width: 495, tamano: 15 * manuscrita.escala, alto: Math.max(LIMITE_TEXTO_ORDEN - y, 20),
    }),
    LIMITE_TEXTO_ORDEN,
  ) + 12;
  // Códigos de facturación (nomenclador IOMA) listos para el robot
  const codigos = buscar("Códigos");
  if (codigos) {
    doc.fontSize(11).font("Helvetica").fillColor(GRIS).text(`Código(s): ${codigos}`, 50, y, { width: 495, align: "left" });
    y = doc.y + 8;
  }
  const prioridad = buscar("Prioridad");
  if (prioridad && prioridad.toUpperCase() === "URGENTE") {
    doc.fontSize(12).font("Helvetica-Bold").fillColor(NEGRO).text("URGENTE", 50, y, { width: 495, align: "left" });
    y = doc.y + 8;
  }

  // Diagnóstico
  const diagnostico = buscar("Justificación clínica") || buscar("Diagnóstico");
  if (diagnostico) {
    y += 30;
    doc.fontSize(11).font("Helvetica-Bold").fillColor(NEGRO).text("Diagnóstico:", 50, y);
    y += 18;
    y = Math.min(
      escribirManuscrito(doc, manuscrita, diagnostico.toUpperCase(), 50, y, {
        width: 495, tamano: 12 * manuscrita.escala, alto: Math.max(LIMITE_TEXTO_ORDEN - y, 16),
      }),
      LIMITE_TEXTO_ORDEN,
    ) + 10;
  }
  const preparacion = buscar("Preparación previa");
  if (preparacion) {
    y += 12;
    doc.fontSize(11).font("Helvetica-Bold").fillColor(NEGRO).text("Preparación previa:", 50, y);
    y += 18;
    y = Math.min(
      escribirManuscrito(doc, manuscrita, preparacion, 50, y, {
        width: 495, tamano: 11 * manuscrita.escala, alto: Math.max(LIMITE_TEXTO_ORDEN - y, 15),
      }),
      LIMITE_TEXTO_ORDEN,
    ) + 10;
  }
  if (datos.observaciones) {
    y += 12;
    doc.fontSize(11).font("Helvetica-Bold").fillColor(NEGRO).text("Observaciones:", 50, y);
    y += 18;
    y = Math.min(
      escribirManuscrito(doc, manuscrita, datos.observaciones, 50, y, {
        width: 495, tamano: 11 * manuscrita.escala, alto: Math.max(LIMITE_TEXTO_ORDEN - y, 15),
      }),
      LIMITE_TEXTO_ORDEN,
    ) + 10;
  }
  doc.fillColor(NEGRO);

  dibujarFirma(doc, datos, y);
  // Mismo tope de firma que dibujarFirma: referencia para el QR y el pie claro.
  const yFirma = Math.min(Math.max(y + 150, 640), 700);
  // QR + link de verificación pública (solo órdenes de baja complejidad:
  // el backend adjunta `verificacion` únicamente en ese caso).
  if (datos.verificacion) {
    try {
      const lado = 72;
      const yQr = yFirma - lado + 14;
      doc.image(datos.verificacion.qrPng, 50, yQr, { fit: [lado, lado] });
      doc.fontSize(7.5).font("Helvetica-Bold").fillColor(NEGRO)
        .text("Validación de veracidad", 132, yQr + 2, { width: 185 });
      doc.fontSize(7).font("Helvetica").fillColor(GRIS)
        .text("Escaneá el QR o entrá al enlace para validar que esta orden fue emitida realmente por Diagnosticar Medical Center y no es una copia adulterada.", 132, doc.y + 2, { width: 185 });
      if (datos.verificacion.url) {
        doc.fontSize(7).font("Helvetica").fillColor(NEGRO)
          .text(datos.verificacion.url, 132, doc.y + 2, { width: 185, link: datos.verificacion.url, underline: true });
      }
      if (datos.verificacion.numero) {
        doc.fontSize(7).font("Helvetica-Bold").fillColor(NEGRO)
          .text(`Código de verificación: ${datos.verificacion.numero}`, 132, doc.y + 3, { width: 185 });
      }
    } catch {
      // Si el QR falla, la orden sale igual sin él.
    }
  }
  // Pedido 03/08/2026: debajo de la firma, EN LETRA CLARA (imprenta), el
  // médico y la matrícula que emitieron la orden.
  const nombreClaro = `${datos.profesional.nombre} ${datos.profesional.apellido ?? ""}`.trim().toUpperCase();
  doc.fontSize(9).font("Helvetica-Bold").fillColor(NEGRO)
    .text(`Orden emitida por ${nombreClaro}`, 330, yFirma + 6, { width: 215, align: "center" });
  const matriculaClara = datos.profesional.matricula
    ? `M.P. ${datos.profesional.matricula.replace(/^\s*M\.?\s*P\.?\s*/i, "")}`.toUpperCase()
    : null;
  if (matriculaClara) {
    // Debajo del nombre (que puede ocupar dos renglones): nunca encimados.
    doc.fontSize(8.5).font("Helvetica").fillColor(NEGRO)
      .text(matriculaClara, 330, doc.y + 2, { width: 215, align: "center" });
  }
  dibujarPie(doc);
  return doc;
}

function dibujarFirma(doc: PDFKit.PDFDocument, datos: DatosDocumentoPdf, y: number): void {
  // Tope superior: la firma y el pie quedan siempre dentro de la hoja A4.
  const yFirma = Math.min(Math.max(y + 150, 640), 700);
  // Pedido 03/08/2026: la orden lleva SELLO tipográfico (mayúsculas, apenas
  // inclinado, como sello de goma) y ENCIMA la firma escaneada del médico.
  // La firma tiene fondo transparente, así el sello se lee detrás del trazo,
  // como un papel sellado y firmado de verdad.
  // Pedido 03/08/2026: las firmas escaneadas reales ya traen el sello del
  // médico dentro de la imagen, así que si hay firma cargada NO se imprime
  // el sello tipográfico (quedaban dos sellos, uno arriba del otro). El
  // sello tipográfico es solo el respaldo cuando no hay firma.
  let firmaDibujada = false;
  if (datos.firmaAutorizada !== false && datos.profesional.firmaImagen) {
    try {
      const base64 = datos.profesional.firmaImagen.split(",")[1] ?? "";
      const buf = Buffer.from(base64, "base64");
      doc.image(buf, 348, yFirma - 100, { fit: [180, 92], align: "center", valign: "bottom" });
      firmaDibujada = true;
    } catch {
      // Imagen corrupta: la orden sale igual, con el sello tipográfico.
    }
  }
  if (!firmaDibujada) {
    const nombreSello = `${datos.profesional.nombre} ${datos.profesional.apellido ?? ""}`.trim().toUpperCase();
    const lineasSello = [
      nombreSello,
      (datos.profesional.especialidad ?? "MÉDICO/A").toUpperCase(),
      // La matrícula puede venir ya con el prefijo ("MP 238844"): se quita para
      // no imprimir "M.P. MP 238844".
      datos.profesional.matricula
        ? `M.P. ${datos.profesional.matricula.replace(/^\s*M\.?\s*P\.?\s*/i, "")}`.toUpperCase()
        : null,
    ].filter((l): l is string => Boolean(l));
    doc.save();
    // Rotación leve alrededor del centro del sello, como estampado a mano.
    const cx = 437.5;
    const cySello = yFirma - 30;
    doc.rotate(-3.5, { origin: [cx, cySello] });
    let ySello = cySello - (lineasSello.length * 13) / 2;
    for (const [i, linea] of lineasSello.entries()) {
      doc
        .fontSize(i === 0 ? 11 : 9.5)
        .font("Helvetica-Bold")
        .fillColor(NEGRO)
        .text(linea, 330, ySello, { width: 215, align: "center", characterSpacing: 1.2 });
      ySello += i === 0 ? 15 : 12;
    }
    doc.restore();
  }
  // Pedido 03/08/2026: sin la leyenda "Firma y sello del profesional"
  // (la firma escaneada ya la trae impresa). Queda solo la línea.
  doc.moveTo(330, yFirma).lineTo(545, yFirma).lineWidth(1).strokeColor(NEGRO).stroke();
}

function dibujarPie(doc: PDFKit.PDFDocument): void {
  // Sin margen inferior mientras se dibuja el pie: si no, pdfkit agrega
  // una segunda página cuando el texto queda cerca del borde.
  doc.page.margins.bottom = 0;
  doc.moveTo(50, 756).lineTo(545, 756).lineWidth(0.8).strokeColor(NEGRO).stroke();
  doc.fontSize(8.5).font("Helvetica-Bold").fillColor(NEGRO).text(
    "Diagonal Lisandro de la Torre 1342, Berazategui  ·  Hipólito Yrigoyen 9477, Lomas de Zamora",
    50, 762, { width: 495, align: "center" },
  );
  doc.fontSize(8.5).font("Helvetica").fillColor(NEGRO).text(
    "Tel: 5256-7028  ·  Diagnosticar.org",
    50, 774, { width: 495, align: "center" },
  );
  doc.fontSize(7).font("Helvetica").fillColor(GRIS).text(
    "Documento generado digitalmente por Conectar — Red Clínica Digital de Diagnosticar.",
    50, 786, { width: 495, align: "center", lineBreak: false },
  );
}

function generarPdfGenerico(datos: DatosDocumentoPdf): PDFKit.PDFDocument {
  const doc = new PDFDocument({ size: "A4", margin: 50 });
  // Letra manuscrita del médico (bolígrafo azul) para todo lo que él "escribe":
  // valores de los campos, cuerpo del documento y observaciones.
  const manuscrita = registrarManuscrita(doc, datos);
  // CERTIFICADOS (ago 2026, pedido de la clínica): el cuerpo del documento va
  // en tipografía digital profesional (Helvetica), NO manuscrita. La firma del
  // profesional sigue siendo la imagen manuscrita digitalizada.
  const digital = datos.tipoDocumento === "certificado";
  const escribir = (
    texto: string,
    x: number,
    y0: number,
    opts: { width: number; tamano: number; alto: number; interlineado?: number },
  ): number => {
    if (!digital) return escribirManuscrito(doc, manuscrita, texto, x, y0, opts);
    doc.font("Helvetica").fontSize(opts.tamano).fillColor(NEGRO);
    doc.text(texto, x, y0, { width: opts.width, height: opts.alto, ellipsis: true, lineGap: 2 });
    return y0 + Math.min(doc.heightOfString(texto, { width: opts.width, lineGap: 2 }), opts.alto);
  };
  // En modo digital no hay escala de caligrafía.
  const escala = digital ? 1 : manuscrita.escala;

  // Encabezado institucional con el logo de la clínica
  try {
    doc.image(LOGO_DIAGNOSTICAR, 50, 44, { fit: [160, 46] });
  } catch {
    doc.fillColor(AZUL).fontSize(20).font("Helvetica-Bold").text("Diagnosticar", 50, 50);
    doc.fillColor(GRIS).fontSize(9).font("Helvetica").text("Red Clínica Digital — Conectar", 50, 74);
  }
  doc.fillColor(GRIS).fontSize(9).font("Helvetica").text(
    `Emitido: ${datos.fechaEmision.toLocaleDateString("es-AR", { day: "2-digit", month: "2-digit", year: "numeric" })} ${datos.fechaEmision.toLocaleTimeString("es-AR", { hour: "2-digit", minute: "2-digit" })}`,
    350, 55, { width: 195, align: "right" },
  );
  doc.moveTo(50, 95).lineTo(545, 95).lineWidth(2).strokeColor(AZUL).stroke();

  // Título del documento
  doc.fillColor(NEGRO).fontSize(16).font("Helvetica-Bold").text(datos.titulo.toUpperCase(), 50, 115);

  // Datos del paciente
  let y = 150;
  // Los datos del paciente también los "escribe" el médico a mano.
  doc.fontSize(10).font("Helvetica-Bold").fillColor(GRIS).text("PACIENTE", 50, y);
  y += 14;
  y = escribir(`${datos.paciente.apellido}, ${datos.paciente.nombre}`, 50, y, {
    width: 495, tamano: 12 * escala, alto: 26,
  }) + 4;
  const lineaPaciente = [
    datos.paciente.dni ? `DNI ${datos.paciente.dni}` : null,
    datos.paciente.cobertura ? `Cobertura: ${datos.paciente.cobertura}` : null,
  ].filter(Boolean).join("  ·  ");
  if (lineaPaciente) {
    y = escribir(lineaPaciente, 50, y, {
      width: 495, tamano: 10 * escala, alto: 22,
    }) + 4;
  }
  y += 10;

  // El documento SIEMPRE sale en una sola hoja: todo el texto (campos, cuerpo
  // y observaciones) se acota al espacio disponible antes de la zona de firma
  // (con "…" si no entra) y la fuente se achica un poco cuando el cuerpo es
  // largo. Si hay observaciones, se les reserva espacio para que nunca
  // desaparezcan por completo.
  const Y_LIMITE_TEXTO = 600;
  const ALTO_RESERVA_OBS = datos.observaciones ? 45 : 0;
  const limiteContenido = Y_LIMITE_TEXTO - ALTO_RESERVA_OBS;

  // Campos del documento
  for (const campo of datos.campos) {
    if (!campo.valor) continue;
    if (y >= limiteContenido - 26) break;
    doc.fontSize(10).font("Helvetica-Bold").fillColor(GRIS).text(campo.etiqueta.toUpperCase(), 50, y);
    y += 13;
    y = Math.min(
      escribir(campo.valor, 50, y, {
        width: 495, tamano: 11 * escala, alto: Math.max(limiteContenido - y, 13),
      }) + 10,
      limiteContenido,
    );
  }

  // Cuerpo libre (certificados)
  if (datos.cuerpo && y < limiteContenido - 20) {
    // Las indicaciones para el paciente van con letra más grande para que
    // sean fáciles de leer (el paciente suele mirarlas desde el celular).
    const tamano = datos.tipoDocumento === "indicaciones"
      ? (datos.cuerpo.length > 900 ? 12 : 13)
      : (datos.cuerpo.length > 900 ? 10 : 11);
    doc.font(digital ? "Helvetica" : manuscrita.nombre).fontSize(tamano * escala);
    const interlineado = doc.currentLineHeight() * 1.05 + 3;
    const yFinCuerpo = escribir(datos.cuerpo, 50, y, {
      width: 495, tamano: tamano * escala, alto: Math.max(limiteContenido - y, 20), interlineado,
    });
    y = Math.min(yFinCuerpo + 12, limiteContenido);
  }

  if (datos.observaciones) {
    doc.fontSize(10).font("Helvetica-Bold").fillColor(GRIS).text("OBSERVACIONES", 50, y);
    y += 13;
    const yFinObs = escribir(datos.observaciones, 50, y, {
      width: 495, tamano: 10 * escala, alto: Math.max(Y_LIMITE_TEXTO - y, 15),
    });
    y = Math.min(yFinObs + 10, Y_LIMITE_TEXTO);
  }

  // Firma (siempre dentro de la primera hoja)
  const yFirma = Math.min(Math.max(y + 150, 640), 700);
  if (datos.profesional.firmaImagen) {
    try {
      const base64 = datos.profesional.firmaImagen.split(",")[1] ?? "";
      const buf = Buffer.from(base64, "base64");
      // Centrada sobre la línea de firma, encajada en 180x55.
      // Caja más alta (180x85) para que las firmas verticales no salgan chicas.
      doc.image(buf, 330, yFirma - 148, { fit: [215, 145], align: "center", valign: "bottom" });
    } catch {
      // Si la imagen está corrupta, el documento sale igual con firma en texto.
    }
  }
  // QR de verificación de autenticidad (a la izquierda de la firma)
  if (datos.verificacion) {
    try {
      doc.image(datos.verificacion.qrPng, 50, yFirma - 48, { fit: [90, 90] });
      if (digital && datos.verificacion.numero) {
        // El bloque fluye renglón por renglón (el enlace puede ocupar varias
        // líneas según el dominio): nada de posiciones fijas que se pisen.
        doc.fontSize(7.5).font("Helvetica-Bold").fillColor(NEGRO)
          .text("Validación de veracidad", 145, yFirma - 48, { width: 175 });
        doc.moveDown(0.3);
        doc.fontSize(7).font("Helvetica").fillColor(GRIS)
          .text("Escaneá el código QR o ingresá en el enlace para validar que este certificado fue emitido realmente por Diagnosticar Medical Center y no es una copia adulterada.", 145, doc.y, { width: 175 });
        if (datos.verificacion.url) {
          doc.moveDown(0.4);
          doc.fontSize(6.5).font("Helvetica").fillColor(AZUL)
            .text(datos.verificacion.url, 145, doc.y, { width: 175, link: datos.verificacion.url });
        }
        doc.moveDown(0.4);
        doc.fontSize(7).font("Helvetica-Bold").fillColor(NEGRO)
          .text(`Código de verificación: ${datos.verificacion.numero}`, 145, doc.y, { width: 175 });
      } else {
        doc.fontSize(7).font("Helvetica").fillColor(GRIS)
          .text("Escaneá el QR para validar que este documento fue emitido realmente por Diagnosticar Medical Center.", 145, yFirma - 40, { width: 160 });
        doc.fontSize(7).fillColor(GRIS)
          .text(`Código: ${datos.verificacion.codigo}`, 145, yFirma - 6, { width: 170 });
      }
    } catch {
      // Si el QR falla, el certificado sale igual sin él.
    }
  }
  doc.moveTo(330, yFirma).lineTo(545, yFirma).lineWidth(1).strokeColor(NEGRO).stroke();
  const nombreProf = `${datos.profesional.apellido ? datos.profesional.apellido + ", " : ""}${datos.profesional.nombre}`;
  doc.fontSize(10).font("Helvetica-Bold").fillColor(NEGRO).text(nombreProf, 330, yFirma + 6, { width: 215, align: "center" });
  const detalleProf = [
    datos.profesional.matricula ? `M.P. ${datos.profesional.matricula}` : null,
    datos.profesional.especialidad ?? null,
  ].filter(Boolean).join(" · ");
  if (detalleProf) {
    doc.fontSize(9).font("Helvetica").fillColor(GRIS).text(detalleProf, 330, yFirma + 20, { width: 215, align: "center" });
  }

  // Certificados: bloque legal de validación al pie (pedido institucional)
  if (digital && datos.verificacion?.numero) {
    doc.page.margins.bottom = 0;
    doc.fontSize(6.5).font("Helvetica").fillColor(GRIS).text(
      "Este documento fue emitido por Diagnosticar Medical Center y registrado electrónicamente en la plataforma Conectar. " +
      "Su autenticidad, vigencia e integridad pueden verificarse mediante el código QR, el enlace o el código único del documento. " +
      "Cuando este certificado sea utilizado para justificar una inasistencia laboral, queda sujeto al artículo 210 de la Ley de Contrato de Trabajo N.º 20.744, conforme sus modificaciones y reglamentación vigente.",
      // Siempre por debajo del QR (que llega hasta yFirma+42) y de los datos
      // del profesional, sin invadir el pie de página fijo (y=780).
      50, Math.min(yFirma + 50, 748), { width: 495, align: "justify", lineGap: 0.5 },
    );
  }

  // Pie (sin margen inferior: si no, pdfkit agrega una segunda página)
  doc.page.margins.bottom = 0;
  doc.fontSize(8).fillColor(GRIS).text(
    "Documento generado digitalmente por Conectar — Red Clínica Digital de Diagnosticar.",
    50, 780, { width: 495, align: "center" },
  );

  return doc;
}
