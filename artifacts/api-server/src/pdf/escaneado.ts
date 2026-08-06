// Efecto "escaneado" para las órdenes médicas (pedido de Federico, 03/08/2026):
// tanto la orden de baja complejidad como la planilla de alta complejidad
// salen en blanco y negro, como una orden en papel fotocopiada/escaneada.
// - La FIRMA del profesional (imagen a color, típicamente birome azul) se
//   binariza: tinta negra pura sobre fondo blanco.
// - Los LOGOS (Diagnosticar / IOMA) pasan a escala de grises.
// - El texto y las líneas ya salen en negro desde documento_pdf.
//
// Los demás documentos (certificados, recetas, informes) NO se tocan: esta
// preparación solo actúa cuando tipoDocumento === "orden_estudio".

import sharp from "sharp";
import type { DatosDocumentoPdf } from "./documento_pdf";
import { LOGO_DIAGNOSTICAR } from "./logo_diagnosticar";
import { LOGO_IOMA } from "./logo_ioma";
import { logger } from "../lib/logger";

function bufferDesdeDataUrl(dataUrl: string): Buffer | null {
  const base64 = dataUrl.includes(",") ? dataUrl.split(",")[1] : dataUrl;
  if (!base64) return null;
  try {
    return Buffer.from(base64, "base64");
  } catch {
    return null;
  }
}

// Firma: fondo blanco + binarizado (la tinta queda negra pura, como una
// fotocopia). normalise estira el rango para que trazos claros no se pierdan.
async function firmaEscaneada(dataUrl: string): Promise<string | null> {
  const buf = bufferDesdeDataUrl(dataUrl);
  if (!buf) return null;
  // Máscara: tinta=255, fondo=0. Se usa como canal alfa sobre un lienzo negro:
  // la tinta queda negra pura y el fondo TRANSPARENTE (el texto de la orden se
  // ve detrás de la firma). PDFKit exige PNG32 RGBA (palette/1-bit sale mal).
  const mascara = sharp(buf).flatten({ background: "#ffffff" }).grayscale().normalise().threshold(180).negate();
  const { data: alfa, info } = await mascara.raw().toBuffer({ resolveWithObject: true });
  // Limpieza del pie del escaneo (pedido 03/08/2026): muchas firmas escaneadas
  // traen abajo la línea impresa con la leyenda "Sello y Firma Profesional".
  // NO se recorta la imagen (el trazo de la firma suele cruzar la línea y
  // quedaba cortado): se BORRA la línea y el texto suelto de abajo, y se
  // conserva todo lo que está conectado con la firma de arriba.
  limpiarPieConLinea(alfa, info.width, info.height);
  const png = await sharp({
    create: { width: info.width, height: info.height, channels: 3, background: "#000000" },
  })
    .joinChannel(alfa, { raw: { width: info.width, height: info.height, channels: 1 } })
    .png({ palette: false })
    .toBuffer();
  return `data:image/png;base64,${png.toString("base64")}`;
}

// Busca, en el pie de la máscara (tinta=255), la línea horizontal impresa y
// la borra junto con el texto suelto de abajo ("Sello y Firma Profesional"),
// conservando los trazos de la firma que la cruzan (todo lo conectado con la
// tinta de arriba de la línea). Si no hay línea, no toca nada.
function limpiarPieConLinea(alfa: Buffer, ancho: number, alto: number): void {
  // Una línea impresa es un tramo CONTINUO de tinta bien ancho; el texto y la
  // firma dejan huecos. Se mide el tramo continuo más largo de cada fila
  // (tolerando cortes de hasta 2 píxeles por el binarizado).
  const tramoContinuo = (y: number): number => {
    const base = y * ancho;
    let mejor = 0;
    let actual = 0;
    let huecos = 0;
    for (let x = 0; x < ancho; x++) {
      if (alfa[base + x] > 127) {
        actual += 1 + huecos;
        huecos = 0;
        if (actual > mejor) mejor = actual;
      } else if (actual > 0 && huecos < 2) {
        huecos++;
      } else {
        actual = 0;
        huecos = 0;
      }
    }
    return mejor;
  };
  const desde = Math.floor(alto * 0.55);
  const umbral = ancho * 0.3;
  let filaLinea = -1;
  for (let y = alto - 1; y >= desde; y--) {
    if (tramoContinuo(y) > umbral) filaLinea = y; // se queda con la más alta del pie
  }
  if (filaLinea < 0) return;
  // Tope superior de la banda de la línea (puede venir torcida o gruesa).
  let topeLinea = filaLinea;
  while (topeLinea > 1 && tramoContinuo(topeLinea - 1) > ancho * 0.08) topeLinea--;
  topeLinea = Math.max(topeLinea - 1, 0);
  // 1) Borrar los tramos horizontales largos dentro de la banda de la línea
  //    (los trazos de la firma que la cruzan son angostos y sobreviven).
  const bandaFin = Math.min(filaLinea + Math.max(3, Math.round(alto * 0.02)), alto - 1);
  const minRun = Math.max(6, Math.round(ancho * 0.05));
  for (let y = topeLinea; y <= bandaFin; y++) {
    const base = y * ancho;
    let inicio = -1;
    for (let x = 0; x <= ancho; x++) {
      const tinta = x < ancho && alfa[base + x] > 127;
      if (tinta && inicio < 0) inicio = x;
      if (!tinta && inicio >= 0) {
        if (x - inicio >= minRun) alfa.fill(0, base + inicio, base + x);
        inicio = -1;
      }
    }
  }
  // 2) Conservar solo la tinta conectada con lo de arriba de la línea:
  //    inundación desde todas las filas superiores; lo que queda aislado en
  //    el pie (la leyenda impresa) se borra.
  const marca = new Uint8Array(ancho * alto);
  const pila: number[] = [];
  for (let i = 0; i < topeLinea * ancho; i++) {
    if (alfa[i] > 127) marca[i] = 1;
    if (alfa[i] > 127 && Math.floor(i / ancho) === topeLinea - 1) pila.push(i);
  }
  while (pila.length) {
    const i = pila.pop()!;
    const x = i % ancho;
    const y = Math.floor(i / ancho);
    for (const j of [i - 1, i + 1, i - ancho, i + ancho]) {
      if (j < 0 || j >= ancho * alto) continue;
      const jx = j % ancho;
      if (Math.abs(jx - x) > 1) continue; // no cruzar bordes laterales
      if (marca[j] || alfa[j] <= 127) continue;
      if (Math.floor(j / ancho) < y - 1 && Math.floor(j / ancho) < topeLinea) continue;
      marca[j] = 1;
      pila.push(j);
    }
  }
  for (let y = topeLinea; y < alto; y++) {
    const base = y * ancho;
    for (let x = 0; x < ancho; x++) {
      if (alfa[base + x] > 127 && !marca[base + x]) alfa[base + x] = 0;
    }
  }
}

// Logos: escala de grises (conservan los medios tonos, como un escaneo real).
async function logoGris(imagen: Buffer | string): Promise<Buffer> {
  const buf = typeof imagen === "string" ? bufferDesdeDataUrl(imagen) : imagen;
  if (!buf) throw new Error("logo inválido");
  return sharp(buf).flatten({ background: "#ffffff" }).grayscale().png().toBuffer();
}

// Los logos son estáticos: se convierten una sola vez por proceso.
let logosCache: Promise<{ diagnosticar: Buffer; ioma: Buffer }> | null = null;
function logosEscaneados(): Promise<{ diagnosticar: Buffer; ioma: Buffer }> {
  if (!logosCache) {
    logosCache = Promise.all([logoGris(LOGO_DIAGNOSTICAR), logoGris(LOGO_IOMA)])
      .then(([diagnosticar, ioma]) => ({ diagnosticar, ioma }))
      .catch((err) => {
        logosCache = null; // no cachear errores
        throw err;
      });
  }
  return logosCache;
}

// Punto único de entrada: prepara los datos de un PDF para generarlo.
// Para órdenes de estudio aplica el efecto escaneado; el resto pasa igual.
// Nunca rompe la generación: si la conversión falla, el PDF sale como antes.
export async function prepararDatosPdf(datos: DatosDocumentoPdf): Promise<DatosDocumentoPdf> {
  if (datos.tipoDocumento !== "orden_estudio") return datos;
  try {
    // Regla del usuario (03/08/2026): cada orden sale SIEMPRE con el médico
    // que la emitió (su letra, su firma y su sello). Si no tiene la firma
    // cargada, la orden sale sin firma y la UI le avisa que pida en
    // administración que se la carguen. (Se eliminó la regla transitoria del
    // prescriptor institucional Dr. Piropo.)
    const profesional = datos.profesional;
    const [logos, firma] = await Promise.all([
      logosEscaneados(),
      profesional.firmaImagen ? firmaEscaneada(profesional.firmaImagen) : Promise.resolve(null),
    ]);
    return {
      ...datos,
      profesional: { ...profesional, firmaImagen: firma ?? profesional.firmaImagen },
      escaneado: { logoDiagnosticar: logos.diagnosticar, logoIoma: logos.ioma },
    };
  } catch (err) {
    logger.error({ err }, "escaneado: fallo la conversión a blanco y negro, la orden sale con los colores originales");
    return datos;
  }
}
