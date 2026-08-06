// Letra manuscrita "bolígrafo azul" única por profesional.
// Hay 5 tipografías caligráficas base; para que CADA médico tenga su propia
// letra, la base se combina con variaciones determinísticas derivadas de su
// id: tamaño de letra, separación entre caracteres y tono de tinta azul.
// El mismo médico escribe SIEMPRE igual; dos médicos nunca escriben idéntico
// (aunque compartan tipografía base, su tamaño/espaciado/tinta difieren).
// Criterio de selección: "manuscrita médica rápida", NO caligráfica ni
// decorativa. Trazos ágiles, letras parcialmente conectadas, algo desprolijo
// pero comprensible. Por eso NO se usan tipografías ornamentales tipo
// Dancing Script ni manuscritas "de imprenta" demasiado prolijas.
import { TTF_CAVEAT } from "./caveat";
import { TTF_KALAM } from "./kalam";
import { TTF_SHADOWS_INTO_LIGHT } from "./shadows_into_light";
import { TTF_ZEYADA } from "./zeyada";
import { TTF_LA_BELLE_AURORE } from "./la_belle_aurore";
import { TTF_PATRICK_HAND } from "./patrick_hand";

// Azul bolígrafo de referencia: el mismo tono que usamos al procesar las
// firmas escaneadas.
export const TINTA_AZUL = "#1B3FA8";

// Tonos de tinta creíbles de birome azul (ninguno demasiado claro).
const TINTAS = ["#1B3FA8", "#16368F", "#24449C", "#0F2E86", "#2A4AB0", "#1D3D93"];

export type FuenteManuscrita = {
  // Semilla determinística del "pulso" del médico (jitter de escritura).
  semilla: number;
  nombre: string; // nombre con el que se registra en PDFKit
  ttf: Buffer;
  // Factor de tamaño respecto de un Helvetica base: corrige la altura de x de
  // cada tipografía y aplica la variación personal del médico.
  escala: number;
  // Separación entre caracteres propia del médico (option characterSpacing).
  espaciado: number;
  // Tono de tinta azul propio del médico.
  tinta: string;
  // Factor de desprolijidad de la base: las tipografías "prolijas" necesitan
  // más caos (desnivel, giro, tamaño) para verse creíblemente manuscritas.
  caos: number;
};

const BASES = [
  { nombre: "Manuscrita-Caveat", ttf: TTF_CAVEAT, escala: 1.52, caos: 1.05 },
  // Kalam: base prolija — necesita mucho caos para no verse "de imprenta".
  { nombre: "Manuscrita-Kalam", ttf: TTF_KALAM, escala: 1.18, caos: 1.25 },
  // Zeyada: cursiva rápida y desprolija, la más "letra de médico" de todas.
  { nombre: "Manuscrita-Zeyada", ttf: TTF_ZEYADA, escala: 1.62, caos: 1.0 },
  // Shadows: redondeada y pareja — más caos para romper los círculos perfectos.
  { nombre: "Manuscrita-Shadows", ttf: TTF_SHADOWS_INTO_LIGHT, escala: 1.4, caos: 1.2 },
  // La Belle Aurore: escritura rápida semi-conectada, reemplaza a Dancing
  // Script (caligráfica ornamental, descartada por poco creíble).
  { nombre: "Manuscrita-Aurore", ttf: TTF_LA_BELLE_AURORE, escala: 1.42, caos: 1.05 },
  // Patrick Hand: manuscrita "de imprenta" (letra de molde). Solo elegible
  // explícitamente por el médico; NO entra en el sorteo por defecto.
  // Es la más regular de todas: lleva el máximo deterioro.
  { nombre: "Manuscrita-Patrick", ttf: TTF_PATRICK_HAND, escala: 1.22, caos: 1.3 },
];

// Cantidad de bases que entran en el sorteo por defecto (id % 5). Congelada
// en 5: si creciera, los médicos que nunca eligieron cambiarían de letra.
const BASES_SORTEO = 5;

// Hash entero determinístico (Knuth multiplicativo) para repartir variaciones.
function hash32(n: number): number {
  return Math.abs(Math.imul(n + 1, 2654435761) >>> 0);
}

// Cantidad de caligrafías base disponibles (para elegir en el perfil).
export const CANTIDAD_CALIGRAFIAS = BASES.length;

// TTF crudo de una caligrafía base, para que el frontend la muestre en vivo.
export function ttfDeCaligrafia(estilo: number): Buffer | null {
  if (!Number.isInteger(estilo) || estilo < 0 || estilo >= BASES.length) return null;
  return BASES[estilo].ttf;
}

export function fuenteManuscritaParaProfesional(
  profesionalId: number | null | undefined,
  // Caligrafía elegida por el médico (0-4); si es null se usa id % 5 como
  // siempre, así los documentos viejos no cambian de letra.
  caligrafiaElegida?: number | null,
): FuenteManuscrita {
  const id = typeof profesionalId === "number" && Number.isFinite(profesionalId) ? Math.abs(profesionalId) : 0;
  const elegida = typeof caligrafiaElegida === "number" && Number.isInteger(caligrafiaElegida)
    && caligrafiaElegida >= 0 && caligrafiaElegida < BASES.length ? caligrafiaElegida : null;
  const base = BASES[elegida ?? id % BASES_SORTEO];
  const h = hash32(id);
  // OJO: los shifts van SIN signo (>>>). Con >> los hashes grandes quedaban
  // negativos y TINTAS[negativo] daba undefined: la tinta no se aplicaba.
  // Tamaño personal: ±8% alrededor del tamaño de la base (7 pasos de 2.7%).
  const factorTamano = 0.92 + ((h >>> 2) % 7) * 0.027;
  // Espaciado personal entre letras: de -0.15 (apretada) a +0.45 (aireada).
  const espaciado = -0.15 + ((h >>> 7) % 5) * 0.15;
  const tinta = TINTAS[(h >>> 11) % TINTAS.length];
  return { nombre: base.nombre, ttf: base.ttf, escala: base.escala * factorTamano, espaciado, tinta, semilla: h, caos: base.caos };
}

// ── Escritura "imperfecta" ────────────────────────────────────────────────
// Imita el pulso real: cada palabra sale con leve desnivel de renglón,
// tamaño no exacto, presión de tinta variable y espacios irregulares.
// Todo sale de un PRNG determinístico (semilla del médico + texto), así el
// mismo documento se regenera siempre idéntico.

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export type OpcionesManuscrito = {
  width: number;
  tamano: number; // tamaño base YA multiplicado por la escala de la fuente
  // Alto máximo disponible; si el texto no entra se corta con "…".
  alto?: number;
  // Alto de línea fijo (p. ej. renglones de la planilla). Si falta, se usa
  // la altura natural de la fuente.
  interlineado?: number;
};

// Escribe texto manuscrito con imperfecciones. Devuelve la coordenada y de
// la línea siguiente (equivalente a doc.y tras un doc.text multilínea).
export function escribirManuscrito(
  doc: PDFKit.PDFDocument,
  m: FuenteManuscrita,
  texto: string,
  x: number,
  y: number,
  o: OpcionesManuscrito,
): number {
  // Semilla: pulso del médico + contenido del texto (no solo la longitud).
  let hTexto = 0;
  for (let i = 0; i < texto.length; i++) hTexto = (Math.imul(hTexto, 31) + texto.charCodeAt(i)) | 0;
  const rng = mulberry32(m.semilla ^ (hTexto >>> 0));
  doc.font(m.nombre).fontSize(o.tamano);
  const altoLinea = o.interlineado ?? doc.currentLineHeight() * 1.05;
  const limiteY = o.alto != null ? y + o.alto : Infinity;
  // Ni siquiera la primera línea entra: no se dibuja nada.
  if (y + altoLinea > limiteY + 0.5) return y;
  const anchoEspacio = doc.widthOfString(" ", { characterSpacing: m.espaciado });
  let cx = x;
  let cy = y;
  let cortado = false;
  // Última posición dibujada, para ubicar el "…" al final del contenido visible.
  let finX = x;
  let finY = y;

  const anchoDe = (s: string) => doc.widthOfString(s, { characterSpacing: m.espaciado });
  // Palabra más ancha que el espacio disponible: se recorta por caracteres
  // con "…" para que nunca se salga del casillero.
  const acotarPalabra = (palabra: string, disponible: number): string => {
    if (anchoDe(palabra) <= disponible) return palabra;
    let corte = palabra;
    while (corte.length > 1 && anchoDe(corte + "…") > disponible) corte = corte.slice(0, -1);
    return corte + "…";
  };

  doc.fillColor(m.tinta);
  const parrafos = texto.split("\n");
  for (let pi = 0; pi < parrafos.length && !cortado; pi++) {
    if (pi > 0) {
      cx = x; cy += altoLinea;
      if (cy + altoLinea > limiteY + 0.5) { cortado = true; break; }
    }
    // Deriva lenta del renglón: la mano va subiendo/bajando de a poco a lo
    // largo de la línea, además del salto propio de cada palabra.
    let deriva = (rng() - 0.5) * 1.6 * m.caos;
    for (const palabra of parrafos[pi].split(/\s+/).filter(Boolean)) {
      const tam = o.tamano * (1 + (rng() - 0.5) * 0.14 * m.caos * 0.9); // tamaño no exacto
      doc.fontSize(tam);
      let w = anchoDe(palabra);
      if (cx + w > x + o.width && cx > x) {
        // No entra en esta línea: bajar de renglón (si hay lugar).
        cx = x; cy += altoLinea;
        deriva = (rng() - 0.5) * 1.6 * m.caos;
        if (cy + altoLinea > limiteY + 0.5) { cortado = true; break; }
      }
      const visible = acotarPalabra(palabra, x + o.width - cx);
      w = anchoDe(visible);
      deriva += (rng() - 0.5) * 1.1 * m.caos; // la deriva se acumula palabra a palabra
      const topeDeriva = 2.6 * m.caos;
      if (deriva > topeDeriva) deriva = topeDeriva; else if (deriva < -topeDeriva) deriva = -topeDeriva;
      const dy = deriva + (rng() - 0.5) * 2.2 * m.caos; // desnivel del renglón
      const giro = (rng() - 0.5) * 2.4 * m.caos; // inclinación de cada palabra
      // Presión base de la birome en la palabra: rango amplio, con palabras
      // "recién entintadas" (bien cargadas) cada tanto y otras más suaves.
      const presion = rng() < 0.14 ? 0.94 + rng() * 0.06 : 0.72 + rng() * 0.24;
      doc.save();
      doc.rotate(giro, { origin: [cx, cy + dy + tam / 2] });
      // Cada carácter sale levemente distinto (tamaño, desnivel, espaciado y
      // presión): dos letras iguales dentro de la palabra nunca son idénticas.
      // Las variaciones son de media cero, así el ancho total queda muy cerca
      // del medido con anchoDe() y los recortes/casilleros siguen funcionando.
      let px = cx;
      const tope = x + o.width + 1.5;
      // La tinta se va "gastando" dentro de la palabra: el trazo arranca más
      // cargado y decae levemente hacia el final, con ruido letra a letra.
      const largo = Math.max(visible.length - 1, 1);
      let indiceCh = 0;
      for (const ch of visible) {
        const tamCh = tam * (1 + (rng() - 0.5) * 0.07 * m.caos); // tamaño por letra
        doc.fontSize(tamCh);
        const dyCh = dy + (rng() - 0.5) * 1.0 * m.caos; // baile vertical por letra
        const desgaste = (indiceCh / largo) * (0.06 + rng() * 0.08);
        const presionCh = presion - desgaste + (rng() - 0.5) * 0.16;
        doc.fillOpacity(Math.min(1, Math.max(0.6, presionCh)));
        indiceCh++;
        doc.text(ch, px, cy + dyCh, { lineBreak: false, characterSpacing: 0 });
        px += doc.widthOfString(ch) + m.espaciado + (rng() - 0.5) * 0.35 * m.caos;
        if (px > tope) break; // nunca invadir fuera del casillero
      }
      doc.restore();
      finX = Math.min(cx + w, x + o.width);
      finY = cy;
      cx += w + anchoEspacio * (0.7 + rng() * 0.75); // espacios irregulares
      if (visible !== palabra) { cortado = true; break; } // ya lleva "…"
    }
  }
  if (cortado) {
    // "…" pegado al final del último contenido visible (nunca al inicio de
    // una línea vacía ni fuera del área permitida).
    doc.fillOpacity(1).fontSize(o.tamano);
    const anchoPuntos = anchoDe("…");
    if (finX + anchoPuntos <= x + o.width + 1) doc.text("…", finX, finY, { lineBreak: false, characterSpacing: m.espaciado });
  }
  doc.fillOpacity(1);
  return cy + altoLinea;
}

// Versión para valores cortos de una sola línea (campos de formularios).
export function escribirManuscritoLinea(
  doc: PDFKit.PDFDocument,
  m: FuenteManuscrita,
  texto: string,
  x: number,
  y: number,
  tamano: number,
  maxWidth?: number,
): void {
  if (!texto) return;
  escribirManuscrito(doc, m, texto, x, y, { width: maxWidth ?? 10000, tamano, alto: tamano * 2.6 });
}
