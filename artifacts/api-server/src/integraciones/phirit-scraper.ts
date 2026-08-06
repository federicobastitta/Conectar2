import { logger } from "../lib/logger";

// ── Robot / scraper del portal web de Phir-it ──────────────────────────────
// Phir-it NO expone un webhook saliente en este despliegue, así que nosotros
// entramos al portal web con las credenciales de la clínica, listamos los
// estudios y detectamos los que están en estado "Informado". Es un cliente
// HTTP manual (login ASP.NET Core con antiforgery + cookie de sesión), no un
// navegador. El parseo es por regex sobre el HTML: es frágil por naturaleza y
// puede romperse si Phir-it cambia el markup — por eso todo va con logging.

const BASE_URL = (process.env.PHIRIT_BASE_URL ?? "https://diagnosticar.phir-it.ar").replace(/\/$/, "");
const EMPRESA_ID = process.env.PHIRIT_EMPRESA_ID ?? "1";
const USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

// Vocabulario de estados posibles en el badge de la lista. Sirve para
// distinguir el badge de ESTADO del badge de MODALIDAD (US/DX/MR/CT/RX...).
const ESTADOS_CONOCIDOS = [
  "Informado",
  "Pendiente",
  "Anulado",
  "En proceso",
  "En Proceso",
  "Programado",
  "Realizado",
  "Cancelado",
];

export interface EstudioListado {
  externalId: string; // id del detalle en Phir-it (ej "134195"), estable y único
  estado: string; // texto del badge (ej "Informado")
  dni: string | null; // "ID" del paciente en Phir-it == DNI (confirmado por la clínica)
  descripcion: string | null;
  informeUrl: string;
}

// ── Cookie jar mínimo ──────────────────────────────────────────────────────
// fetch global de Node 24 no maneja cookies; llevamos un mapa nombre→valor y
// lo reenviamos en cada request. Suficiente para la sesión ASP.NET Core.
class CookieJar {
  private jar = new Map<string, string>();

  header(): string {
    return [...this.jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
  }

  store(setCookies: string[]): void {
    for (const sc of setCookies) {
      const first = sc.split(";", 1)[0];
      const eq = first.indexOf("=");
      if (eq <= 0) continue;
      const name = first.slice(0, eq).trim();
      const value = first.slice(eq + 1).trim();
      if (name) this.jar.set(name, value);
    }
  }

  clear(): void {
    this.jar.clear();
  }

  get size(): number {
    return this.jar.size;
  }
}

let sessionJar: CookieJar | null = null;

function decodeHtml(s: string): string {
  return s
    .replace(/&#x([0-9A-Fa-f]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, "&")
    .replace(/&nbsp;/g, " ")
    .replace(/&aacute;/g, "á")
    .replace(/&eacute;/g, "é")
    .replace(/&iacute;/g, "í")
    .replace(/&oacute;/g, "ó")
    .replace(/&uacute;/g, "ú")
    .replace(/&ntilde;/g, "ñ")
    .trim();
}

async function jarFetch(
  jar: CookieJar,
  path: string,
  init?: { method?: string; body?: string; contentType?: string },
): Promise<{ status: number; location: string | null; text: string }> {
  const headers: Record<string, string> = {
    "User-Agent": USER_AGENT,
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "es-AR,es;q=0.9",
  };
  const cookie = jar.header();
  if (cookie) headers.Cookie = cookie;
  if (init?.contentType) headers["Content-Type"] = init.contentType;

  const res = await fetch(`${BASE_URL}${path}`, {
    method: init?.method ?? "GET",
    headers,
    body: init?.body,
    redirect: "manual",
    signal: AbortSignal.timeout(30_000),
  });

  const setCookies = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
  jar.store(setCookies);

  // Con redirect:"manual" el body de un 3xx suele venir vacío; solo leemos
  // texto cuando lo vamos a parsear (200).
  const text = res.status >= 200 && res.status < 300 ? await res.text() : "";
  return { status: res.status, location: res.headers.get("location"), text };
}

function extraerAntiforgeryToken(html: string): string | null {
  const m = html.match(/name="__RequestVerificationToken"[^>]*value="([^"]+)"/);
  return m ? m[1] : null;
}

// Login contra el form ASP.NET Core: GET /login (token + cookies) → POST /login.
// Éxito == redirección (302) fuera de /login.
async function login(): Promise<CookieJar | null> {
  const usuario = process.env.PHIRIT_USUARIO?.trim();
  const password = process.env.PHIRIT_PASSWORD?.trim();
  if (!usuario || !password) {
    logger.warn("Phir-it robot: faltan credenciales (PHIRIT_USUARIO / PHIRIT_PASSWORD)");
    return null;
  }

  const jar = new CookieJar();
  const get = await jarFetch(jar, "/login");
  if (get.status !== 200) {
    logger.error({ status: get.status }, "Phir-it robot: GET /login no devolvió 200");
    return null;
  }
  const token = extraerAntiforgeryToken(get.text);
  if (!token) {
    logger.error("Phir-it robot: no se encontró __RequestVerificationToken en /login");
    return null;
  }

  const form = new URLSearchParams({
    UserName: usuario,
    Password: password,
    EmpresaId: EMPRESA_ID,
    __RequestVerificationToken: token,
  });

  const post = await jarFetch(jar, "/login", {
    method: "POST",
    body: form.toString(),
    contentType: "application/x-www-form-urlencoded",
  });

  const location = post.location ?? "";
  const exito = post.status === 302 && !/\/login/i.test(location);
  if (!exito) {
    logger.error(
      { status: post.status, location: location || null },
      "Phir-it robot: login fallido (revisar credenciales o cambios en el portal)",
    );
    return null;
  }

  logger.info("Phir-it robot: login OK");
  return jar;
}

// Devuelve una sesión válida, reusando la existente o re-logueando.
async function ensureSession(force = false): Promise<CookieJar | null> {
  if (!force && sessionJar && sessionJar.size > 0) return sessionJar;
  sessionJar = await login();
  return sessionJar;
}

// Parseo de una página de la lista de estudios.
// Regla validada contra HTML real: el badge de ESTADO precede al link del
// detalle en cada fila, y el DNI aparece como número de 7-9 dígitos justo
// antes de una fecha dd/mm/yyyy. Las filas pueden venir duplicadas (layout
// desktop + mobile): deduplicamos por externalId.
export function parseEstudiosPagina(html: string): EstudioListado[] {
  const badges = [...html.matchAll(/badge-\w+[^>]*>\s*([^<]+?)\s*</g)]
    .map((m) => ({ txt: decodeHtml(m[1]), pos: m.index ?? 0 }))
    .filter((b) => ESTADOS_CONOCIDOS.some((e) => e.toLowerCase() === b.txt.toLowerCase()));

  const links = [...html.matchAll(/\/estudio\/detalle\/(\d+)/g)].map((m) => ({
    id: m[1],
    pos: m.index ?? 0,
  }));

  const vistos = new Set<string>();
  const filas: EstudioListado[] = [];

  for (let i = 0; i < links.length; i++) {
    const { id, pos } = links[i];
    if (vistos.has(id)) continue;
    vistos.add(id);

    // Estado = badge de estado inmediatamente anterior a este link
    let estado: string | null = null;
    let mejorPos = -1;
    for (const b of badges) {
      if (b.pos < pos && b.pos > mejorPos) {
        mejorPos = b.pos;
        estado = b.txt;
      }
    }

    const next = links[i + 1]?.pos ?? html.length;
    const block = html.slice(pos, next);
    const texto = decodeHtml(block.replace(/<[^>]*>/g, " ").replace(/\s+/g, " "));

    const dniMatch = texto.match(/(\d{7,9})\s+(\d{2}\/\d{2}\/\d{4})/);
    const dni = dniMatch ? dniMatch[1] : null;

    const descMatch = texto.match(
      /\d{2}\/\d{2}\/\d{4}\s+\d{2}:\d{2}\s+([A-ZÁÉÍÓÚÑ][^]*?)\s+(?:DX|US|MR|CT|RX|Series)\b/,
    );
    const descripcion = descMatch ? descMatch[1].trim() : null;

    filas.push({
      externalId: id,
      estado: estado ?? "",
      dni,
      descripcion,
      informeUrl: `${BASE_URL}/estudio/detalle/${id}`,
    });
  }

  return filas;
}

// Fallback: obtiene el DNI ("ID") de un estudio desde su página de detalle,
// cuando la lista no lo trae. El detalle exige el param ?route (base64 de
// "/estudios"); sin él responde 500.
const ROUTE_PARAM = Buffer.from("/estudios").toString("base64");

export async function fetchDniDesdeDetalle(externalId: string): Promise<string | null> {
  const jar = await ensureSession();
  if (!jar) return null;
  const res = await jarFetch(jar, `/estudio/detalle/${externalId}?route=${ROUTE_PARAM}`);
  const html =
    res.status === 200 ? res.text : (await ensureSessionYReintentar(externalId));
  if (!html) return null;
  // Estructura del detalle: etiqueta "ID" seguida del número (== DNI)
  const m =
    html.match(/ID\s*<\/[^>]*>\s*<[^>]*>\s*(\d{7,9})/i) ||
    html.match(/>\s*ID\s*<[^]*?(\d{7,9})/i);
  return m ? m[1] : null;
}

// ── Descarga del PDF del informe ───────────────────────────────────────────
// El detalle de un estudio informado tiene un link tipo /pdf-informe/<a>-<b>
// (donde <a> suele ser el externalId y <b> un id interno del informe). Lo
// extraemos del HTML del detalle y lo bajamos con la misma sesión. Validamos
// la firma %PDF para no guardar páginas de error del portal como si fueran
// informes.
export function extraerPdfInformePath(html: string): string | null {
  const m = html.match(/\/pdf-informe\/([\w-]+)/);
  return m ? `/pdf-informe/${m[1]}` : null;
}

async function jarFetchBinary(jar: CookieJar, path: string): Promise<{ status: number; buf: Buffer }> {
  const headers: Record<string, string> = {
    "User-Agent": USER_AGENT,
    Accept: "application/pdf,*/*",
    Cookie: jar.header(),
  };
  const res = await fetch(`${BASE_URL}${path}`, {
    headers,
    redirect: "manual",
    signal: AbortSignal.timeout(60_000),
  });
  const setCookies = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
  jar.store(setCookies);
  const buf = res.status === 200 ? Buffer.from(await res.arrayBuffer()) : Buffer.alloc(0);
  return { status: res.status, buf };
}

export async function descargarPdfInforme(externalId: string): Promise<Buffer | null> {
  const jar = await ensureSession();
  if (!jar) return null;

  let res = await jarFetch(jar, `/estudio/detalle/${externalId}?route=${ROUTE_PARAM}`);
  if (res.status !== 200) {
    const jar2 = await ensureSession(true);
    if (!jar2) return null;
    res = await jarFetch(jar2, `/estudio/detalle/${externalId}?route=${ROUTE_PARAM}`);
    if (res.status !== 200) {
      logger.warn({ externalId, status: res.status }, "Phir-it robot: detalle no accesible para el PDF");
      return null;
    }
  }

  const pdfPath = extraerPdfInformePath(res.text);
  if (!pdfPath) {
    logger.warn({ externalId }, "Phir-it robot: el detalle no tiene link /pdf-informe (¿todavía sin PDF?)");
    return null;
  }

  const sesion = sessionJar;
  if (!sesion) return null;
  const bin = await jarFetchBinary(sesion, pdfPath);
  if (bin.status !== 200 || bin.buf.length === 0) {
    logger.warn({ externalId, status: bin.status }, "Phir-it robot: descarga del PDF fallida");
    return null;
  }
  // Firma PDF: evita guardar HTML de error como informe
  if (bin.buf.subarray(0, 5).toString("latin1") !== "%PDF-") {
    logger.warn({ externalId, bytes: bin.buf.length }, "Phir-it robot: la respuesta no es un PDF válido");
    return null;
  }
  return bin.buf;
}

async function ensureSessionYReintentar(externalId: string): Promise<string | null> {
  const jar = await ensureSession(true);
  if (!jar) return null;
  const res = await jarFetch(jar, `/estudio/detalle/${externalId}?route=${ROUTE_PARAM}`);
  return res.status === 200 ? res.text : null;
}

// Recorre las páginas de la lista y devuelve TODOS los estudios visibles.
// Se detiene cuando una página no aporta externalIds nuevos o al llegar al
// tope de páginas (defensa contra bucles).
export async function fetchEstudios(maxPaginas = 30): Promise<EstudioListado[]> {
  let jar = await ensureSession();
  if (!jar) return [];

  const acumulado = new Map<string, EstudioListado>();
  for (let page = 1; page <= maxPaginas; page++) {
    let res = await jarFetch(jar, `/estudios?page=${page}`);

    // Sesión vencida → 302 (a /login) o 401: re-login una vez y reintentar.
    if (res.status === 302 || res.status === 401) {
      const nueva = await ensureSession(true);
      if (!nueva) return [...acumulado.values()];
      jar = nueva;
      res = await jarFetch(jar, `/estudios?page=${page}`);
    }
    if (res.status !== 200) {
      logger.warn({ page, status: res.status }, "Phir-it robot: página de estudios no accesible");
      break;
    }

    const filas = parseEstudiosPagina(res.text);
    const nuevosEnPagina = filas.filter((f) => !acumulado.has(f.externalId));
    for (const f of nuevosEnPagina) acumulado.set(f.externalId, f);

    // Sin filas o sin ids nuevos: fin de la paginación.
    if (filas.length === 0 || nuevosEnPagina.length === 0) break;
  }

  return [...acumulado.values()];
}
