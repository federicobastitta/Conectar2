import tls from "node:tls";
import { Agent, fetch as undiciFetch } from "undici";
import { logger } from "../lib/logger";
import { SECTIGO_DV_R36_PEM } from "./klinicos-ca";

// ── Robot Klinicos (ACEAPP) ────────────────────────────────────────────────
// Cliente HTTP contra klinicos.aceapp.ar, estilo phirit-scraper (fetch +
// cookie jar, sin navegador). Flujo calibrado contra las capacitaciones
// oficiales "Usuarios Administrativos" (ver docs/klinicos-flujo-administrativo.md):
//   login (usuario nombre.apellido) →
//   selección de contexto OBLIGATORIA: establecimiento + sector + puesto de
//   trabajo (especialidad vacía para administrativos) →
//   Pacientes → búsqueda común por DNI. REGLA: el robot NUNCA crea pacientes
//   en Klinicos — si el DNI no existe, el trabajo falla con un mensaje claro
//   y el paciente lo carga a mano recepción/administración →
//   Ingreso ambulatorio: macheo sector + especialidad + profesional con el
//   login del médico + motivo de consulta obligatorio → Guardar →
//   queda en Detalle de la atención; si es IMÁGENES S/C: Nueva Prestación →
//   Práctica (prescriptor externo: nombre + especialidad + matrícula;
//   efector; diagnóstico CIE10; códigos de práctica) → Guardar.
//   Cadena posterior a calibrar: token del paciente (app IOMA) → autorizar →
//   Realizar → adjuntar orden → Informar por código → facturable.
//
// IMPORTANTE: Klinicos es un sistema de PRODUCCIÓN real. Por eso:
//  - El robot queda DESHABILITADO si faltan las credenciales (Secrets).
//  - KLINICOS_DRY_RUN=1 (default) simula los pasos sin escribir nada.
//  - Los selectores/rutas exactas del portal se calibran recién cuando haya
//    credenciales; hasta entonces cada paso registra qué haría.

export const BASE_URL = (process.env.KLINICOS_BASE_URL ?? "https://klinicos.aceapp.ar").replace(/\/$/, "");
const USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

export function klinicosHabilitado(): boolean {
  return Boolean(process.env.KLINICOS_USUARIO && process.env.KLINICOS_PASSWORD);
}

// ── Pool de credenciales (ago 2026, pedido de Federico) ─────────────────────
// Varias cuentas de Klinicos (KLINICOS_USUARIO/_2/_3) para tener más sesiones
// abiertas a la vez: los logins concurrentes rotan de cuenta, así dos cargas
// en paralelo no se pisan la sesión (el portal invalida la sesión anterior
// del mismo usuario) y el worker puede procesar varios trabajos a la vez.
export interface CredencialKlinicos {
  usuario: string;
  password: string;
  /** Etiqueta segura para logs (nunca el usuario real). */
  etiqueta: string;
}

export function credencialesKlinicos(): CredencialKlinicos[] {
  const creds: CredencialKlinicos[] = [];
  const pares: Array<[string | undefined, string | undefined, string]> = [
    [process.env.KLINICOS_USUARIO, process.env.KLINICOS_PASSWORD, "cuenta 1"],
    [process.env.KLINICOS_USUARIO_2, process.env.KLINICOS_PASSWORD_2, "cuenta 2"],
    [process.env.KLINICOS_USUARIO_3, process.env.KLINICOS_PASSWORD_3, "cuenta 3"],
  ];
  for (const [u, p, etiqueta] of pares) {
    if (u?.trim() && p?.trim()) creds.push({ usuario: u.trim(), password: p.trim(), etiqueta });
  }
  return creds;
}

// Reparto de cuentas: round-robin entre los logins. El worker, además, fija
// una cuenta distinta por trabajo en paralelo para que dos cargas simultáneas
// nunca compartan usuario.
let rr = 0;

function proximaCredencial(): CredencialKlinicos | null {
  const creds = credencialesKlinicos();
  if (creds.length === 0) return null;
  return creds[rr++ % creds.length]!;
}

export function klinicosDryRun(): boolean {
  // Dry-run por defecto: solo se desactiva explícitamente con "0"
  return process.env.KLINICOS_DRY_RUN !== "0";
}

// El portal envía la cadena TLS incompleta: agregamos la CA intermedia Sectigo
// a las CAs default de Node solo para las requests del robot.
const klinicosDispatcher = new Agent({
  connect: { ca: [...tls.rootCertificates, SECTIGO_DV_R36_PEM] },
});

export class CookieJar {
  private jar = new Map<string, string>();
  header(): string {
    return [...this.jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
  }
  store(setCookies: string[]): void {
    for (const sc of setCookies) {
      const [first, ...attrs] = sc.split(";");
      const eq = first.indexOf("=");
      if (eq <= 0) continue;
      const name = first.slice(0, eq).trim();
      const value = first.slice(eq + 1).trim();
      if (!name) continue;
      // El portal borra cookies (p.ej. .AspNet.ExternalCookie tras el login)
      // con Expires en el pasado: hay que respetarlo o la sesión se corrompe.
      const expira = attrs.find((a) => /expires=/i.test(a));
      if (expira && new Date(expira.slice(expira.indexOf("=") + 1)).getTime() < Date.now()) {
        this.jar.delete(name);
      } else {
        this.jar.set(name, value);
      }
    }
  }
}

export async function jarFetch(
  jar: CookieJar,
  path: string,
  init?: { method?: string; body?: string | Buffer; contentType?: string; referer?: string; xhr?: boolean },
): Promise<{ status: number; location: string | null; text: string }> {
  // El portal a veces redirige con URL absoluta (incluso http://): nos quedamos
  // solo con path + query para no salir del BASE_URL.
  if (path.startsWith("http")) {
    const u = new URL(path);
    path = u.pathname + u.search;
  }
  const headers: Record<string, string> = {
    "User-Agent": USER_AGENT,
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "es-AR,es;q=0.9",
  };
  const cookie = jar.header();
  if (cookie) headers.Cookie = cookie;
  if (init?.contentType) headers["Content-Type"] = init.contentType;
  if (init?.referer) headers.Referer = init.referer;
  if (init?.method === "POST") headers.Origin = BASE_URL;
  if (init?.xhr) headers["X-Requested-With"] = "XMLHttpRequest";

  // fetch del paquete undici (no el global): el dispatcher debe ser de la
  // misma versión de undici que el fetch que lo consume.
  const res = await undiciFetch(`${BASE_URL}${path}`, {
    method: init?.method ?? "GET",
    headers,
    body: init?.body,
    redirect: "manual",
    signal: AbortSignal.timeout(30_000),
    dispatcher: klinicosDispatcher,
  });
  const setCookies = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
  jar.store(setCookies);
  const text = res.status >= 200 && res.status < 300 ? await res.text() : "";
  return { status: res.status, location: res.headers.get("location"), text };
}

// Login real contra el portal (calibrado 17/07/2026): GET / redirige a
// /Login?ReturnUrl=%2F, el form postea UserName + Password + antiforgery al
// mismo path. Si las credenciales fallan, la página devuelve 200 con el
// mensaje "usuario o contraseña incorrecta"; si funcionan, redirige.
export async function loginKlinicos(
  jar: CookieJar,
  credencial?: CredencialKlinicos | null,
): Promise<{ ok: boolean; detalle: string }> {
  const creds = credencialesKlinicos();
  const cred = credencial ?? proximaCredencial();
  if (!cred) {
    return { ok: false, detalle: "Faltan KLINICOS_USUARIO / KLINICOS_PASSWORD" };
  }
  const primero = await loginKlinicosCon(jar, cred);
  if (primero.ok || cred.usuario === creds[0]?.usuario || !primero.credencialRechazada) {
    return { ok: primero.ok, detalle: `${primero.detalle} [${cred.etiqueta}]` };
  }
  // Si el portal rechaza una cuenta extra (p. ej. clave mal cargada), se
  // reintenta UNA vez con la cuenta principal sobre el mismo jar (el portal
  // pisa las cookies al re-loguear) para no frenar la operación.
  const respaldo = await loginKlinicosCon(jar, creds[0]!);
  return { ok: respaldo.ok, detalle: `${respaldo.detalle} [cuenta 1, tras rechazo de ${cred.etiqueta}]` };
}

async function loginKlinicosCon(
  jar: CookieJar,
  cred: CredencialKlinicos,
): Promise<{ ok: boolean; detalle: string; credencialRechazada?: boolean }> {
  const inicio = await jarFetch(jar, "/");
  const loginPath = inicio.status >= 300 && inicio.location ? inicio.location : "/Login?ReturnUrl=%2F";
  const pagina = await jarFetch(jar, loginPath);
  if (pagina.status !== 200) {
    return { ok: false, detalle: `GET ${loginPath} → ${pagina.status}` };
  }
  const rvt = pagina.text.match(/name="__RequestVerificationToken"[^>]*value="([^"]*)"/i)?.[1];
  const action = pagina.text.match(/<form[^>]*action="([^"]*)"[^>]*>/i)?.[1] ?? loginPath;

  const body = new URLSearchParams();
  body.set("UserName", cred.usuario);
  body.set("Password", cred.password);
  if (rvt) body.set("__RequestVerificationToken", rvt);

  const post = await jarFetch(jar, action, {
    method: "POST",
    body: body.toString(),
    contentType: "application/x-www-form-urlencoded",
    referer: `${BASE_URL}${loginPath.startsWith("/") ? loginPath : `/${loginPath}`}`,
  });

  if (post.status >= 300 && post.status < 400) {
    return { ok: true, detalle: `Login OK (→ ${post.location ?? "/"})` };
  }
  const esError = /incorrecta|inv[aá]lid/i.test(post.text);
  return {
    ok: false,
    detalle: esError
      ? "El portal rechazó las credenciales (usuario o contraseña incorrecta)"
      : `POST login → ${post.status} sin redirección`,
    credencialRechazada: esError,
  };
}
export function camposDeForm(html: string): Record<string, string> {
  const campos: Record<string, string> = {};
  for (const m of html.matchAll(/<input([^>]*)>/gi)) {
    const attrs = m[1];
    const name = attrs.match(/name="([^"]*)"/)?.[1];
    if (!name) continue;
    const raw = attrs.match(/value="([^"]*)"/)?.[1] ?? "";
    campos[name] = raw
      .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
      .replace(/&quot;/g, '"')
      .replace(/&amp;/g, "&");
  }
  // Selects: el navegador SIEMPRE envía el select con su opción elegida (o la
  // primera). Sin esto el POST omite campos como TipoAfiliado y el portal
  // rechaza con "field is required" (visto en vivo 02/08/2026).
  for (const m of html.matchAll(/<select[^>]*name="([^"]*)"[^>]*>([\s\S]*?)<\/select>/gi)) {
    const name = m[1]!;
    if (name in campos) continue;
    const cuerpo = m[2]!;
    const seleccionada =
      cuerpo.match(/<option[^>]*selected[^>]*value="([^"]*)"/i)?.[1] ??
      cuerpo.match(/<option[^>]*value="([^"]*)"[^>]*selected/i)?.[1] ??
      cuerpo.match(/<option[^>]*value="([^"]*)"/i)?.[1] ??
      "";
    campos[name] = seleccionada;
  }
  return campos;
}

async function jsonGet(jar: CookieJar, path: string): Promise<unknown> {
  const res = await jarFetch(jar, path);
  try {
    return JSON.parse(res.text);
  } catch {
    return null;
  }
}

// Selección de contexto post-login (calibrada 17/07/2026): GET
// /Login/SeleccionarSector, resolver el id del sector por nombre vía el
// endpoint AJAX del portal y POSTear el form completo (incluidos los hidden
// avatar/nombres/tipoUsuario — si van vacíos el portal cierra la sesión).
export async function seleccionarContextoKlinicos(
  jar: CookieJar,
  sectorNombre = "ADMINISTRACIÓN",
): Promise<{ ok: boolean; detalle: string }> {
  const pagina = await jarFetch(jar, "/Login/SeleccionarSector");
  if (pagina.status !== 200) {
    return { ok: false, detalle: `GET /Login/SeleccionarSector → ${pagina.status}` };
  }
  const campos = camposDeForm(pagina.text);
  const estId = pagina.text.match(/UsuarioEstablecimientoRefId[\s\S]*?<option[^>]*value="(\d+)"/)?.[1];
  if (!estId) return { ok: false, detalle: "No se encontró el establecimiento en la página" };

  const sectores = (await jsonGet(
    jar,
    `/sector/porEstablecimiento/selectList?idUsuarioEstablecimiento=${estId}`,
  )) as Array<{ Text: string; Value: string | number }> | null;
  const sector = sectores?.find((s) => s.Text.localeCompare(sectorNombre, "es", { sensitivity: "base" }) === 0)
    ?? sectores?.find((s) => new RegExp(sectorNombre.slice(0, 8), "i").test(s.Text));
  if (!sector) {
    return { ok: false, detalle: `Sector "${sectorNombre}" no encontrado (hay: ${sectores?.map((s) => s.Text).join(", ") ?? "ninguno"})` };
  }

  const action = pagina.text.match(/<form[^>]*action="([^"]*)"/i)?.[1]?.replace(/&amp;/g, "&") ?? "/Login/SeleccionarSector";
  const body = new URLSearchParams({
    ...campos,
    UsuarioEstablecimientoRefId: estId,
    SectorRefId: String(sector.Value),
    PuestoTrabajoRefId: "-1",
    EspecialidadRefId: "-1",
  });
  const post = await jarFetch(jar, action, {
    method: "POST",
    body: body.toString(),
    contentType: "application/x-www-form-urlencoded",
    referer: `${BASE_URL}/Login/SeleccionarSector`,
  });
  if (post.status >= 300 && post.location && !/logout/i.test(post.location)) {
    return { ok: true, detalle: `Contexto ${sector.Text} seleccionado (→ ${post.location})` };
  }
  return { ok: false, detalle: `POST contexto → ${post.status}${post.location ? ` (${post.location})` : ""}` };
}

// ── Búsqueda de paciente por DNI (calibrada 18/07/2026) ────────────────────
// El grid de /paciente es un DataTables server-side: POST a
// /paciente/grid/{documento}/{apellido}/{nombre}/{nroHC} con el payload
// completo de DataTables (columns[i][data] etc. — sin eso el portal tira 500).
export interface PacienteKlinicos {
  id: string; // GUID del paciente en Klinicos
  numeroDocumento: string;
  apellido: string;
  nombre: string;
  hc: string | null;
  estado: string | null; // PERM, etc.
}

function dataTablesBody(): string {
  const cols = ["documento", "hc", "primerApellido", "", "primerNombre", "otrosNombres", "fechaNacimiento", "estadoNombre", ""];
  const p = new URLSearchParams({ draw: "1", start: "0", length: "20", "search[value]": "", "search[regex]": "false" });
  cols.forEach((c, i) => {
    p.set(`columns[${i}][data]`, c);
    p.set(`columns[${i}][name]`, "");
    p.set(`columns[${i}][searchable]`, "true");
    p.set(`columns[${i}][orderable]`, "false");
    p.set(`columns[${i}][search][value]`, "");
    p.set(`columns[${i}][search][regex]`, "false");
  });
  p.set("order[0][column]", "2");
  p.set("order[0][dir]", "asc");
  return p.toString();
}

export async function buscarPacienteKlinicos(
  jar: CookieJar,
  dni: string,
): Promise<{ ok: boolean; paciente: PacienteKlinicos | null; detalle: string }> {
  const limpio = dni.replace(/\D/g, "");
  if (!limpio) return { ok: false, paciente: null, detalle: "DNI vacío o inválido" };
  const res = await jarFetch(jar, `/paciente/grid/${limpio}/null/null/null`, {
    method: "POST",
    body: dataTablesBody(),
    contentType: "application/x-www-form-urlencoded; charset=UTF-8",
    referer: `${BASE_URL}/paciente`,
    xhr: true,
  });
  if (res.status !== 200) return { ok: false, paciente: null, detalle: `POST /paciente/grid → ${res.status}` };
  let filas: Array<Record<string, unknown>> = [];
  try {
    const j = JSON.parse(res.text) as { data?: Array<Record<string, unknown>> };
    filas = j.data ?? [];
  } catch {
    return { ok: false, paciente: null, detalle: "Respuesta del grid de pacientes no es JSON" };
  }
  // Coincidencia ESTRICTA de DNI: jamás usar otra fila del grid (riesgo de
  // cargar el ingreso a otro paciente). REGLA: el robot NUNCA crea pacientes.
  const fila = filas.find((f) => String(f.numeroDocumento ?? "") === limpio);
  if (!fila) {
    return { ok: false, paciente: null, detalle: `Paciente DNI ${limpio} NO existe en Klinicos (coincidencia exacta) — NO se crea: cargar a mano por recepción/administración y reintentar` };
  }
  return {
    ok: true,
    paciente: {
      id: String(fila.id),
      numeroDocumento: String(fila.numeroDocumento ?? limpio),
      apellido: String(fila.primerApellido ?? ""),
      nombre: String(fila.primerNombre ?? ""),
      hc: fila.hc ? String(fila.hc) : null,
      estado: fila.estado ? String(fila.estado) : null,
    },
    detalle: `Paciente encontrado: ${fila.primerApellido}, ${fila.primerNombre} (HC ${fila.hc ?? "s/d"})`,
  };
}

// ── Obras sociales del paciente (calibrada 18/07/2026) ─────────────────────
export interface ObraSocialPaciente {
  idObraSocial: number;
  nombre: string;
  nroAfiliado: string | null;
  plan: string | null;
  grupo: string | null; // "IOMA" para IOMA
}

export async function obrasSocialesPacienteKlinicos(
  jar: CookieJar,
  idPaciente: string,
): Promise<ObraSocialPaciente[]> {
  const res = await jarFetch(jar, "/paciente/obras-sociales-listado", {
    method: "POST",
    body: new URLSearchParams({ idPaciente }).toString(),
    contentType: "application/x-www-form-urlencoded; charset=UTF-8",
    referer: `${BASE_URL}/paciente`,
    xhr: true,
  });
  try {
    const outer = JSON.parse(res.text) as { data?: string };
    const inner = outer.data ? (JSON.parse(outer.data) as { obrasSociales?: Array<Record<string, any>> }) : null;
    return (inner?.obrasSociales ?? [])
      .filter((os) => os.vigente !== false)
      .map((os) => ({
        idObraSocial: Number(os.idObraSocial),
        nombre: String(os.obraSocialNombre ?? ""),
        nroAfiliado: os.nroAfiliado ? String(os.nroAfiliado) : null,
        plan: os.planObraSocial ? String(os.planObraSocial) : null,
        grupo: os.obraSocial?.Grupo ? String(os.obraSocial.Grupo) : null,
      }));
  } catch {
    return [];
  }
}

// ── Cascadas sector → especialidad → profesional (calibradas 18/07/2026) ───
interface OpcionSelect {
  Text: string;
  Value: string | number;
  Type?: string;
}

async function especialidadesPorSector(jar: CookieJar, idSector: string): Promise<OpcionSelect[]> {
  const res = await jarFetch(jar, `/Especialidad/traerEspecialidadDisponiblePorIdSector?idSector=${idSector}`, { xhr: true });
  try {
    return JSON.parse(res.text) as OpcionSelect[];
  } catch {
    return [];
  }
}

async function profesionalesPorEspecialidad(jar: CookieJar, idEspecialidad: string): Promise<OpcionSelect[]> {
  const res = await jarFetch(jar, "/atencion/listaProfesionales", {
    method: "POST",
    body: new URLSearchParams({ idEspecialidad }).toString(),
    contentType: "application/x-www-form-urlencoded; charset=UTF-8",
    xhr: true,
  });
  try {
    return JSON.parse(res.text) as OpcionSelect[];
  } catch {
    return [];
  }
}

function normalizarTexto(s: string): string {
  return s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toUpperCase().replace(/[^A-Z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
}

// Machea "APELLIDO, NOMBRE" del portal contra el nombre guardado en Conectar
// (puede venir "Apellido Nombre", "nombre.apellido", etc.).
// FAIL-CLOSED (regla 7 del manual): solo devuelve una opción si la
// coincidencia es exacta (texto normalizado igual) o si TODAS las palabras
// buscadas aparecen en EXACTAMENTE una opción. "Mejor puntaje" parcial o
// empate entre varias opciones → null (deriva a revisión humana).
export function machearOpcion(opciones: OpcionSelect[], buscado: string | null): OpcionSelect | null {
  if (!buscado) return null;
  const buscadoNorm = normalizarTexto(buscado.replace(/\./g, " "));
  if (!buscadoNorm) return null;

  // 1) Coincidencia exacta del texto normalizado, única.
  const exactas = opciones.filter((op) => normalizarTexto(op.Text) === buscadoNorm);
  if (exactas.length === 1) return exactas[0];
  if (exactas.length > 1) return null; // ambiguo → revisión

  // 2) Todas las palabras (>=3 letras) presentes como PALABRA COMPLETA
  //    (no substring: "JUAN" NO machea "JUANA"), en exactamente una opción.
  const palabras = buscadoNorm.split(" ").filter((w) => w.length >= 3);
  if (!palabras.length) return null;
  const candidatas = opciones.filter((op) => {
    const tokens = new Set(normalizarTexto(op.Text).split(" "));
    return palabras.every((w) => tokens.has(w));
  });
  return candidatas.length === 1 ? candidatas[0] : null;
}

// ── Ingreso ambulatorio (calibrado 18/07/2026) ─────────────────────────────
// GET /atencion/nuevo/{idPaciente}?formaIngreso=1&buscarOS=true trae el form
// "AtencionForm" (POST multipart a /atencion/nuevo/{idPaciente}). Campos clave:
// motivo (Consulta por), idSectorDestino, idEspecialidadDestino,
// idProfesionalDestino, IdObraSocialSeleccionada + hidden (antiforgery,
// idFormaIngreso=1, idAtencionEstado=2, fechaCrea...). Éxito = redirect 3xx.
interface PlanIngreso {
  action: string;
  campos: Record<string, string>;
  resumen: string;
}

function extraerFormAtencion(html: string): { action: string; html: string } | null {
  const idx = html.indexOf('id="AtencionForm"');
  if (idx < 0) return null;
  const open = html.lastIndexOf("<form", idx);
  const end = html.indexOf("</form>", idx);
  if (open < 0 || end < 0) return null;
  const tag = html.slice(open, html.indexOf(">", open) + 1);
  const action = tag.match(/action="([^"]*)"/)?.[1] ?? "";
  return { action, html: html.slice(open, end) };
}

function opcionesDeSelect(formHtml: string, name: string): OpcionSelect[] {
  const m = formHtml.match(new RegExp(`<select[^>]*name="${name}"[^>]*>([\\s\\S]*?)</select>`));
  if (!m) return [];
  return [...m[1].matchAll(/<option[^>]*value="([^"]*)"[^>]*>([^<]*)</g)]
    .filter((o) => o[1] !== "")
    .map((o) => ({ Value: o[1], Text: o[2].replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n))).trim() }));
}

// ── Especialidades de CONSULTA soportadas ───────────────────────────────────
// Reglas dictadas por el usuario (02-ago-2026): de Conectar solo se
// correlaciona DNI + especialidad + día. La especialidad de Conectar se
// detecta por regex sobre el texto normalizado y se machea contra el
// desplegable del portal; el diagnóstico presuntivo ("Consulta por") rota por
// semilla entre la lista de cada especialidad. El profesional rota entre los
// del desplegable del portal (excluyendo CANESTRO y el usuario de sistema),
// SALVO cardiología, donde viene decidido por la cola (rotación sembrada) y
// acá solo se machea. La rotación es determinística por trabajo (semilla =
// id del trabajo): un reintento repite el mismo diagnóstico/profesional.
export const DIAGNOSTICOS_CLINICA_MEDICA = [
  "Dolor abdominal",
  "Fiebre",
  "Cefalea",
  "Mareos",
  "Tos y síntomas respiratorios",
  "Dolor de garganta",
  "Dolor lumbar",
  "Control de hipertensión arterial",
  "Malestar general",
  "Control clínico general",
];

export const DIAGNOSTICOS_CARDIOLOGIA = [
  "Control cardiológico general",
  "Control de hipertensión arterial",
  "Dolor en el pecho",
  "Palpitaciones",
  "Falta de aire",
  "Mareos o desmayos",
  "Control de arritmia",
  "Evaluación prequirúrgica",
  "Seguimiento posterior a una internación cardiovascular",
  "Control de medicación cardiológica",
];

export const DIAGNOSTICOS_TRAUMATOLOGIA = [
  "Lumbalgia",
  "Cervicalgia",
  "Gonalgia",
  "Omalgia",
  "Esguince de tobillo",
  "Traumatismo de mano",
  "Traumatismo de rodilla",
  "Dolor de cadera",
  "Tendinitis",
  "Probable fractura",
];

export const DIAGNOSTICOS_GINECOLOGIA = [
  "Dolor pélvico",
  "Sangrado vaginal",
  "Flujo vaginal",
  "Irregularidad menstrual",
  "Amenorrea",
  "Dismenorrea",
  "Prurito vulvovaginal",
  "Control ginecológico",
];

// Lista dictada por el usuario (02-ago-2026).
export const DIAGNOSTICOS_PEDIATRIA = [
  "Fiebre",
  "Tos",
  "Dolor de garganta",
  "Congestión nasal",
  "Dolor abdominal",
  "Vómitos",
  "Diarrea",
  "Erupción cutánea",
  "Dificultad respiratoria",
];

export interface EspecialidadConsulta {
  /** Nombre EXACTO (normalizado) de la especialidad en el select del portal. */
  portal: string;
  /** Si el nombre del portal puede variar, se machea por inclusión única. */
  portalPorInclusion?: boolean;
  /** Detección sobre la especialidad de Conectar, ya normalizada. */
  deteccion: RegExp;
  /** Motivos "Consulta por" que rotan por semilla. */
  diagnosticos: string[];
  /** true = el profesional viene de la cola (rotación sembrada) y solo se machea. */
  profesionalDeLaCola?: boolean;
}

// ¡EL ORDEN IMPORTA! Se evalúa de arriba hacia abajo: las detecciones más
// específicas van primero (NEUROLOGIA antes que UROLOGIA porque "neurologia"
// contiene "urolog"; CLINICA MEDICA al final porque /CLINICA/ es amplísimo).
export const ESPECIALIDADES_CONSULTA: EspecialidadConsulta[] = [
  { portal: "CARDIOLOGIA", deteccion: /CARDIOLOGIA/, diagnosticos: DIAGNOSTICOS_CARDIOLOGIA, profesionalDeLaCola: true },
  // En el portal figura "ORTOPEDIA Y TRAUMATOLOGIA" (verificado 02-ago-2026).
  { portal: "TRAUMATOLOGIA", portalPorInclusion: true, deteccion: /TRAUMATOLOG|ORTOPED/, diagnosticos: DIAGNOSTICOS_TRAUMATOLOGIA },
  { portal: "GINECOLOGIA", deteccion: /GINECO/, diagnosticos: DIAGNOSTICOS_GINECOLOGIA },
  { portal: "PEDIATRIA-LACTANTES", portalPorInclusion: true, deteccion: /PEDIATR|LACTANTE/, diagnosticos: DIAGNOSTICOS_PEDIATRIA },
  {
    portal: "DERMATOLOGIA",
    deteccion: /DERMATO/,
    diagnosticos: ["Control de lunares", "Dermatitis", "Acné", "Psoriasis", "Prurito cutáneo", "Micosis cutánea", "Urticaria", "Lesión en la piel"],
  },
  {
    portal: "ENDOCRINOLOGIA",
    deteccion: /ENDOCRIN/,
    diagnosticos: ["Control de tiroides", "Hipotiroidismo", "Control de diabetes", "Nódulo tiroideo", "Obesidad", "Osteoporosis", "Trastorno hormonal", "Control metabólico"],
  },
  {
    portal: "FLEBOLOGIA",
    deteccion: /FLEBO/,
    diagnosticos: ["Várices en miembros inferiores", "Dolor y pesadez de piernas", "Edema de miembros inferiores", "Arañitas vasculares", "Insuficiencia venosa", "Úlcera venosa", "Control flebológico"],
  },
  {
    portal: "GASTROENTEROLOGIA",
    deteccion: /GASTRO/,
    diagnosticos: ["Dolor abdominal", "Reflujo gastroesofágico", "Gastritis", "Constipación", "Diarrea crónica", "Colon irritable", "Hígado graso", "Distensión abdominal"],
  },
  {
    portal: "MEDICINA GENERAL Y/O DE FAMILIA",
    portalPorInclusion: true,
    deteccion: /MEDICINA GENERAL|FAMILIA/,
    diagnosticos: ["Control clínico general", "Control de presión arterial", "Cefalea", "Dolor lumbar", "Cuadro gripal", "Control de medicación", "Chequeo general", "Malestar general"],
  },
  {
    portal: "NEUMONOLOGIA",
    deteccion: /NEUMO/,
    diagnosticos: ["Tos crónica", "Asma", "EPOC", "Falta de aire", "Bronquitis a repetición", "Apnea del sueño", "Control por tabaquismo", "Control neumonológico"],
  },
  // NEUROLOGIA SIEMPRE antes que UROLOGIA ("NEUROLOGIA" contiene "UROLOG").
  {
    portal: "NEUROLOGIA",
    deteccion: /NEUROLOG/,
    diagnosticos: ["Cefalea", "Migraña", "Mareos", "Pérdida de memoria", "Temblor", "Hormigueo en extremidades", "Trastornos del sueño", "Control neurológico"],
  },
  {
    portal: "ODONTOLOGIA",
    deteccion: /ODONTO/,
    diagnosticos: ["Dolor dental", "Caries", "Control odontológico", "Extracción dental", "Gingivitis", "Sensibilidad dental", "Control de prótesis"],
  },
  {
    portal: "OFTALMOLOGIA",
    deteccion: /OFTALMO/,
    diagnosticos: ["Disminución de la agudeza visual", "Control oftalmológico", "Ojo rojo", "Ojo seco", "Picazón ocular", "Control de presión ocular", "Lagrimeo"],
  },
  {
    portal: "ONCOLOGIA",
    deteccion: /ONCOLOG/,
    diagnosticos: ["Control oncológico", "Seguimiento de tratamiento", "Evaluación de estudios", "Control posterior a quimioterapia", "Nódulo en estudio", "Control posquirúrgico oncológico"],
  },
  {
    portal: "OTORRINOLARINGOLOGIA",
    deteccion: /OTORRINO/,
    diagnosticos: ["Dolor de oído", "Disminución de la audición", "Vértigo", "Obstrucción nasal", "Ronquera", "Sinusitis", "Zumbido de oídos", "Amigdalitis a repetición"],
  },
  {
    portal: "REUMATOLOGIA",
    deteccion: /REUMATO/,
    diagnosticos: ["Dolor articular", "Artrosis", "Artritis", "Dolor lumbar crónico", "Fibromialgia", "Rigidez matinal", "Osteoporosis", "Dolor muscular generalizado"],
  },
  {
    portal: "UROLOGIA",
    deteccion: /UROLOG/,
    diagnosticos: ["Ardor al orinar", "Infección urinaria", "Control de próstata", "Cólico renal", "Litiasis renal", "Incontinencia urinaria", "Control urológico"],
  },
  {
    portal: "CIRUGIA",
    deteccion: /CIRUGIA|CIRUJANO/,
    diagnosticos: ["Control postoperatorio", "Hernia inguinal", "Hernia umbilical", "Dolor abdominal en estudio", "Litiasis vesicular", "Evaluación prequirúrgica", "Lesión de partes blandas"],
  },
  {
    portal: "ANATOMIA PATOLOGICA",
    deteccion: /ANATOMIA PATOLOGICA|ANATOMOPATOLOG/,
    diagnosticos: ["Revisión de biopsia", "Consulta por resultado de estudio", "Control anatomopatológico"],
  },
  // CLINICA MEDICA al final: /CLINICA/ matchea cualquier cosa con "clínica".
  { portal: "CLINICA MEDICA", deteccion: /CLINICA/, diagnosticos: DIAGNOSTICOS_CLINICA_MEDICA },
];

/** Detecta la especialidad de consulta soportada (primer match del orden). */
export function detectarEspecialidadConsulta(
  ...textos: Array<string | null | undefined>
): EspecialidadConsulta | null {
  for (const cfg of ESPECIALIDADES_CONSULTA) {
    if (textos.some((t) => t && cfg.deteccion.test(normalizarTexto(t)))) return cfg;
  }
  return null;
}

/** Machea la especialidad contra el select del portal: exacto primero; si es
 *  por inclusión, exige match ÚNICO (0 o varios → fail-closed). */
function machearEspecialidadPortal(
  opciones: OpcionSelect[],
  cfg: EspecialidadConsulta,
): { opcion: OpcionSelect | null; detalle?: string } {
  const exacta = opciones.find((e) => normalizarTexto(e.Text) === cfg.portal);
  if (exacta) return { opcion: exacta };
  if (!cfg.portalPorInclusion) return { opcion: null };
  const incluidas = opciones.filter((e) => normalizarTexto(e.Text).includes(cfg.portal));
  if (incluidas.length === 1) return { opcion: incluidas[0] };
  return {
    opcion: null,
    detalle: incluidas.length
      ? `"${cfg.portal}" es ambigua en el desplegable (${incluidas.map((e) => e.Text).join(" / ")})`
      : undefined,
  };
}

export async function prepararIngresoAmbulatorio(
  jar: CookieJar,
  paciente: PacienteKlinicos,
  datos: DatosIngreso,
): Promise<{ ok: boolean; plan: PlanIngreso | null; detalle: string }> {
  const pagina = await jarFetch(
    jar,
    `/atencion/nuevo/${paciente.id}?formaIngreso=1&buscarOS=true&returnUrl=%2Fpaciente`,
    { referer: `${BASE_URL}/paciente` },
  );
  if (pagina.status !== 200) {
    return { ok: false, plan: null, detalle: `GET form de ingreso → ${pagina.status}${pagina.location ? ` (${pagina.location})` : ""}` };
  }
  const form = extraerFormAtencion(pagina.text);
  if (!form) return { ok: false, plan: null, detalle: "No se encontró AtencionForm en la página de ingreso" };

  // Sector destino: "IMAGENES S/C" vive bajo el sector IMAGENES; el resto va a
  // CONSULTORIOS. Los ids salen del propio select (no hardcodeamos).
  const sectores = opcionesDeSelect(form.html, "idSectorDestino");
  const nombreSector = /IMAGENES/i.test(datos.sectorServicio) ? "IMAGENES" : "CONSULTORIOS";
  const sector = sectores.find((s) => normalizarTexto(s.Text) === nombreSector) ?? machearOpcion(sectores, nombreSector);
  if (!sector) {
    return { ok: false, plan: null, detalle: `Sector destino "${nombreSector}" no está en el select (hay: ${sectores.map((s) => s.Text).join(", ")})` };
  }

  // Especialidad de consulta soportada (tabla ESPECIALIDADES_CONSULTA; el
  // orden de la tabla resuelve ambigüedades como "clínica" o "urología").
  const consulta =
    nombreSector === "CONSULTORIOS" ? detectarEspecialidadConsulta(datos.especialidad, datos.sectorServicio) : null;
  const semilla = Math.abs(datos.rotacionSemilla ?? 0);

  // Especialidad: para imágenes va exacto "IMAGENES S/C"; para consultorios se
  // machea la especialidad de la agenda contra las del sector.
  const especialidades = await especialidadesPorSector(jar, String(sector.Value));
  let especialidad: OpcionSelect | null;
  if (consulta) {
    const m = machearEspecialidadPortal(especialidades, consulta);
    if (!m.opcion && m.detalle) return { ok: false, plan: null, detalle: m.detalle };
    especialidad = m.opcion;
  } else {
    especialidad =
      especialidades.find((e) => normalizarTexto(e.Text) === normalizarTexto(datos.sectorServicio)) ??
      machearOpcion(especialidades, datos.especialidad ?? datos.sectorServicio);
  }
  if (!especialidad) {
    return { ok: false, plan: null, detalle: `Especialidad "${datos.especialidad ?? datos.sectorServicio}" no encontrada en sector ${sector.Text} (hay: ${especialidades.map((e) => e.Text).join(", ")})` };
  }

  // Práctica en consultorios (lección 03/08/2026, ej. Holter/MAPA/ergometría
  // de cardio): el ingreso NO es una consulta — el motivo es el nombre del
  // estudio y el profesional viene decidido por la cola (efector fijo), sin
  // rotaciones de consulta.
  const esPractica = Boolean(datos.practicaCodigos?.length);

  // Profesional: en las especialidades de consulta rota entre los del select
  // (sin CANESTRO ni el usuario de sistema), salvo cardiología, donde viene
  // decidido por la cola y es obligatorio machearlo.
  const profesionales = await profesionalesPorEspecialidad(jar, String(especialidad.Value));
  let profesional: OpcionSelect | null;
  if (consulta && !consulta.profesionalDeLaCola && !esPractica) {
    // normalizarTexto quita la coma: "USUARIO, Medico" queda "USUARIO MEDICO".
    const candidatos = profesionales.filter((p) => !/CANESTRO|USUARIO MEDICO/.test(normalizarTexto(p.Text)));
    if (!candidatos.length) {
      return { ok: false, plan: null, detalle: `No hay profesionales elegibles para la rotación de ${especialidad.Text} (todos excluidos o lista vacía)` };
    }
    profesional = candidatos[semilla % candidatos.length];
  } else {
    profesional = machearOpcion(profesionales, datos.profesionalKlinicos);
  }
  if (!profesional) {
    return { ok: false, plan: null, detalle: `Profesional "${datos.profesionalKlinicos ?? "(sin definir)"}" no encontrado en ${especialidad.Text} (hay ${profesionales.length}: ${profesionales.slice(0, 10).map((p) => p.Text.trim()).join("; ")}${profesionales.length > 10 ? "…" : ""})` };
  }

  // Obra social del paciente: preferimos IOMA (80% de los casos); si no, la
  // primera vigente; si no tiene ninguna, el ingreso va sin OS (particular).
  const obrasSociales = await obrasSocialesPacienteKlinicos(jar, paciente.id);
  const os = obrasSociales.find((o) => o.grupo === "IOMA") ?? obrasSociales[0] ?? null;

  const campos = camposDeForm(form.html);
  // Textareas no son <input>: motivo va aparte. En Clínica Médica el
  // diagnóstico presuntivo rota entre los 10 definidos por el usuario.
  const motivoFinal = consulta && !esPractica
    ? consulta.diagnosticos[semilla % consulta.diagnosticos.length]
    : datos.consultaPor;
  campos.motivo = motivoFinal;
  campos.idSectorDestino = String(sector.Value);
  campos.idEspecialidadDestino = String(especialidad.Value);
  campos.idProfesionalDestino = String(profesional.Value);
  campos.IdObraSocialSeleccionada = os ? String(os.idObraSocial) : "";
  campos.OSToken = datos.tokenAutorizacion ?? "";
  // Selects vacíos que el form espera presentes
  campos.idSNOMed ??= "";
  campos.edadAparenteUnidad ??= "";
  // Parentesco del responsable: el portal lo exige aunque no haya responsable
  // (verificado en la primera carga real: "The Parentesco field is required").
  // Se elige "OTRO" si existe; si no, la primera opción con valor.
  if (!campos.idParentescoResponsable) {
    const parentescos = opcionesDeSelect(form.html, "idParentescoResponsable");
    const otro = parentescos.find((p) => normalizarTexto(p.Text) === "OTRO") ?? parentescos.find((p) => String(p.Value).trim() !== "");
    campos.idParentescoResponsable = otro ? String(otro.Value) : "";
  }
  campos.idPuestoDeTrabajo ??= "";
  campos.observaciones ??= "";
  // Checkboxes no marcados: solo el hidden "false" (camposDeForm ya deja el
  // último value, que es el hidden false)
  campos.conPrioridad = "false";
  campos.internarConLaMadre = "false";

  const resumen = `sector ${sector.Text} (${sector.Value}) · especialidad ${especialidad.Text} (${especialidad.Value}) · profesional ${profesional.Text.trim()} (${profesional.Value}) · OS ${os ? `${os.nombre} af. ${os.nroAfiliado ?? "s/d"}${os.grupo === "IOMA" ? " [IOMA]" : ""}` : "sin obra social"} · motivo "${motivoFinal}"${consulta ? ` [rotación ${consulta.portal}, semilla ${semilla}]` : ""}`;
  return { ok: true, plan: { action: form.action || `/atencion/nuevo/${paciente.id}`, campos, resumen }, detalle: resumen };
}

export async function confirmarIngresoAmbulatorio(
  jar: CookieJar,
  plan: PlanIngreso,
): Promise<{ ok: boolean; atencionUrl: string | null; detalle: string; rechazoDefinitivo?: boolean }> {
  const body = new URLSearchParams(plan.campos).toString();
  const post = await jarFetch(jar, plan.action, {
    method: "POST",
    body,
    contentType: "application/x-www-form-urlencoded",
    referer: `${BASE_URL}${plan.action}`,
  });
  if (post.status >= 300 && post.status < 400 && post.location && !/login/i.test(post.location)) {
    return { ok: true, atencionUrl: post.location, detalle: `Ingreso creado (→ ${post.location})` };
  }
  if (post.status === 200) {
    // El portal re-renderiza el form con errores de validación
    const errores = [...post.text.matchAll(/field-validation-error[^>]*>([^<]+)</g)].map((m) => m[1].trim());
    const resumenErr = post.text.match(/validation-summary-errors[\s\S]{0,400}?<li>([^<]+)</)?.[1]?.trim();
    // Rechazo DEFINITIVO solo si hay errores de validación EXPLÍCITOS: el
    // portal re-renderizó el form sin crear nada y es seguro reintentar el
    // POST. Un 200 sin marcadores de validación queda como resultado
    // desconocido (NO se limpia la guarda anti-duplicado).
    const hayValidacion = errores.length > 0 || Boolean(resumenErr);
    const detalle = [resumenErr, ...errores].filter(Boolean).join(" | ") || "El portal devolvió 200 sin redirección: resultado desconocido, verificar a mano";
    return { ok: false, atencionUrl: null, detalle, rechazoDefinitivo: hayValidacion };
  }
  return { ok: false, atencionUrl: null, detalle: `POST ingreso → ${post.status}${post.location ? ` (${post.location})` : ""}` };
}

// ── Validaciones previas al Guardar (secuencia del navegador, 2-ago-2026) ──
// La pantalla "Nueva atención" dispara dos AJAX antes del submit: el recuadro
// verde del afiliado (validarDatosObraSocialPaciente con token vacío) y
// /paciente/obra-social-validar. Se replican para ser fieles al circuito
// aprobado. Fail-closed: si obra-social-validar devuelve error (la pantalla
// pediría confirmación humana), NO se guarda.
export async function validacionesPreGuardado(
  jar: CookieJar,
  idPaciente: string,
  idObraSocial: string,
): Promise<{ ok: boolean; detalle: string }> {
  if (!idObraSocial) return { ok: true, detalle: "Sin obra social: la pantalla no valida nada antes de guardar" };
  let estadoAfiliado = "(sin datos)";
  try {
    const vd = await jarFetch(jar, "/ordenPrestacion/validarDatosObraSocialPaciente", {
      method: "POST",
      body: new URLSearchParams({ idPaciente, idObraSocial, grupoNomenclador: "IOMA", OSToken: "", tipoEspecialidadDestino: "MED" }).toString(),
      contentType: "application/x-www-form-urlencoded; charset=UTF-8",
      referer: `${BASE_URL}/atencion/nuevo/${idPaciente}`,
      xhr: true,
    });
    let o: unknown = JSON.parse(vd.text);
    if (typeof o === "string") o = JSON.parse(o);
    const data = (o as { data?: string | null }).data;
    const d = data ? (JSON.parse(data) as { Status?: string; ApellidoNombre?: string | null }) : null;
    if (d) estadoAfiliado = `${d.Status ?? "?"}${d.ApellidoNombre ? ` ${d.ApellidoNombre}` : ""}`;
  } catch {
    // El recuadro verde es informativo en la pantalla: no bloquea el guardado.
    estadoAfiliado = "(no se pudo consultar)";
  }
  const osv = await jarFetch(jar, "/paciente/obra-social-validar", {
    method: "POST",
    body: new URLSearchParams({ idPaciente, idObraSocial }).toString(),
    contentType: "application/x-www-form-urlencoded; charset=UTF-8",
    referer: `${BASE_URL}/atencion/nuevo/${idPaciente}`,
    xhr: true,
  });
  if (osv.status !== 200) return { ok: false, detalle: `obra-social-validar respondió ${osv.status}` };
  try {
    const r = JSON.parse(osv.text) as { error?: boolean; message?: string | null };
    if (r.error) {
      return { ok: false, detalle: `La validación de obra social devolvió un aviso: ${r.message ?? "(sin mensaje)"} — en la pantalla esto pide confirmación humana` };
    }
  } catch {
    return { ok: false, detalle: "obra-social-validar no devolvió JSON" };
  }
  return { ok: true, detalle: `Afiliado ${estadoAfiliado} · obra social validada` };
}

export interface DatosIngreso {
  dni: string;
  sexo: string | null;
  celular: string | null;
  sectorServicio: string; // CONSULTORIO | IMAGENES S/C
  especialidad: string | null; // especialidad de la agenda (para machear en consultorios)
  profesionalKlinicos: string | null; // profesional a machear en el ingreso
  consultaPor: string; // redacción para el campo "Consulta por"
  // Prestación (cualquier sector con códigos resueltos: imágenes y consultorios)
  practicaCodigos: string[] | null;
  efectorNombre: string | null;
  prescriptorNombre: string | null;
  prescriptorMatricula: string | null;
  prescriptorEspecialidad: string | null;
  // Token de autorización IOMA: lo genera el paciente en su app y se lo da a
  // recepción — es el ÚNICO paso humano del circuito.
  tokenAutorizacion: string | null;
  /** Nota sobre la orden médica de respaldo (existente/creada/faltante). */
  ordenNota?: string | null;
  cie10Codigo: string | null;
  cie10Descripcion: string | null;
  /** Semilla de rotación (id del trabajo): fija diagnóstico y profesional en
   * la regla de Clínica Médica de forma determinística por trabajo. */
  rotacionSemilla?: number | null;
}

export interface ResultadoPaso {
  paso: string;
  ok: boolean;
  detalle: string;
}

export interface ResultadoRobot {
  ok: boolean;
  dryRun: boolean;
  pasos: ResultadoPaso[];
  ingresoCreado: boolean;
  prestacionCreada: boolean;
  atencionUrl?: string | null;
  error?: string;
  // Modo simulación: POST del ingreso que se HABRÍA enviado (token enmascarado)
  simulacionIngreso?: Record<string, unknown>;
  // Modo asistido (ejecución real aprobada por el operador)
  prestacionNumero?: string | null;
  autorizacionResultado?: "aceptado" | "rechazado" | "incierto" | null;
  nroBono?: string | null;
}

// El token completo jamás sale en pasos/logs/payloads (decisión 31/07/2026).
function enmascararTokenCampo(token: string | undefined): string {
  if (!token || !token.trim()) return "";
  const limpio = token.trim();
  return `••••${limpio.length > 4 ? limpio.slice(-4) : limpio.slice(-1)}`;
}

// Guardas anti-duplicado para el modo real: el worker persiste el intento de
// POST ANTES de enviarlo. Si un reintento encuentra un intento previo sin
// confirmación, NO re-postea (el resultado anterior es desconocido).
export interface GuardasIngreso {
  ingresoYaCreado: boolean; // el ingreso ya se confirmó en un intento anterior
  postYaIntentado: boolean; // hubo un POST previo con resultado desconocido
  marcarPostIntentado: () => Promise<void>; // persistir ANTES del POST
  marcarIngresoCreado: (atencionUrl: string | null) => Promise<void>; // persistir apenas confirma
  /** El portal rechazó el POST con validación (no creó nada): limpiar el intento para permitir Reintentar. */
  marcarPostRechazado?: () => Promise<void>;
  // Para reintentos aprobados: URL de la atención ya creada (permite seguir
  // con prestación/autorización sin re-crear el ingreso)
  atencionUrlPrevia?: string | null;
}

export interface OpcionesEjecucion {
  modoReal?: boolean;
  /** Cuenta de Klinicos a usar (pool); sin especificar, rota round-robin. */
  credencial?: CredencialKlinicos | null;
  prestacion?: import("./klinicos-prestaciones").GuardasPrestacion;
  autorizacion?: import("./klinicos-prestaciones").GuardasAutorizacion;
  /** Adjunto de la orden médica (lección 03/08/2026): PDF de la orden de
   * Conectar que se sube a la atención vía "Adjuntar documentación". */
  adjunto?: import("./klinicos-adjuntos").AdjuntoOrdenOpciones;
}
export async function ejecutarIngresoKlinicos(
  datos: DatosIngreso,
  guardas?: GuardasIngreso,
  opciones?: OpcionesEjecucion,
): Promise<ResultadoRobot> {
  const pasos: ResultadoPaso[] = [];
  // Doble llave: real solo con aprobación explícita (modoReal) Y sin dry-run
  // de entorno. Cualquier otra combinación simula.
  const dryRun = opciones?.modoReal ? klinicosDryRun() : true;

  if (!klinicosHabilitado()) {
    return {
      ok: false,
      dryRun,
      pasos: [{ paso: "credenciales", ok: false, detalle: "Faltan KLINICOS_USUARIO / KLINICOS_PASSWORD" }],
      ingresoCreado: false,
      prestacionCreada: false,
      error: "Robot deshabilitado: faltan credenciales",
    };
  }

  const jar = new CookieJar();

  try {
    // ── Paso 1: login real ─────────────────────────────────────────────────
    const login = await loginKlinicos(jar, opciones?.credencial);
    pasos.push({ paso: "login", ok: login.ok, detalle: login.detalle });
    if (!login.ok) {
      // También en dry-run: si el login falla, el trabajo NO puede figurar
      // como completado (evita falsos positivos si las credenciales se rompen).
      return { ok: false, dryRun, pasos, ingresoCreado: false, prestacionCreada: false, error: `Login Klinicos falló: ${login.detalle}` };
    } else {
      // ── Paso 2: selección de contexto real (no escribe datos clínicos) ────
      const contexto = await seleccionarContextoKlinicos(jar);
      pasos.push({ paso: "seleccionar_contexto", ok: contexto.ok, detalle: contexto.detalle });
      if (!contexto.ok && !dryRun) {
        return { ok: false, dryRun, pasos, ingresoCreado: false, prestacionCreada: false, error: `Selección de contexto falló: ${contexto.detalle}` };
      }
    }
    // ── Paso 3: buscar paciente por DNI (real, solo lectura — también en
    // dry-run: valida el circuito completo sin escribir nada) ───────────────
    const busqueda = await buscarPacienteKlinicos(jar, datos.dni);
    pasos.push({ paso: "buscar_paciente", ok: busqueda.ok, detalle: busqueda.detalle });
    if (!busqueda.ok || !busqueda.paciente) {
      // REGLA: NUNCA crear pacientes — el trabajo falla para carga manual.
      return { ok: false, dryRun, pasos, ingresoCreado: false, prestacionCreada: false, error: busqueda.detalle };
    }

    // ── Paso 4: preparar el ingreso ambulatorio (real, solo lectura:
    // resuelve sector, especialidad, profesional y obra social) ─────────────
    const prep = await prepararIngresoAmbulatorio(jar, busqueda.paciente, datos);
    pasos.push({
      paso: "preparar_ingreso",
      ok: prep.ok,
      detalle: prep.ok ? `${dryRun ? "[dry-run] " : ""}Ingreso resuelto: ${prep.detalle}` : prep.detalle,
    });
    if (!prep.ok || !prep.plan) {
      return { ok: false, dryRun, pasos, ingresoCreado: false, prestacionCreada: false, error: `No se pudo preparar el ingreso: ${prep.detalle}` };
    }

    if (dryRun) {
      pasos.push({
        paso: "ingreso_ambulatorio",
        ok: true,
        detalle: `[dry-run] NO se envía: el POST está listo y validado (${prep.plan.resumen})`,
      });
      const esConsultaDry = !datos.practicaCodigos?.length && !/IMAGENES/i.test(datos.sectorServicio);
      if (esConsultaDry) {
        pasos.push({
          paso: "prestacion",
          ok: true,
          detalle: "[dry-run] La fila de la CONSULTA (C-…) la crea el propio ingreso ambulatorio (regla 2-ago-2026); tras el guardado se verificaría en la grilla que nació con su casillero de token. NO se usa /ordenPrestacion/create.",
        });
      }
      if (datos.practicaCodigos?.length) {
        pasos.push({
          paso: "prestacion",
          ok: true,
          detalle: `[dry-run] Crearía prestación Práctica — códigos: ${datos.practicaCodigos.join(", ")} — efector: ${datos.efectorNombre ?? "(sin definir)"} — prescriptor externo: ${datos.prescriptorNombre ?? "(rotación)"}${datos.prescriptorMatricula ? ` (MP ${datos.prescriptorMatricula}${datos.prescriptorEspecialidad ? `, ${datos.prescriptorEspecialidad}` : ""})` : " (falta matrícula)"} — CIE10: ${datos.cie10Codigo ?? "(pendiente)"}${datos.ordenNota ? ` — ${datos.ordenNota}` : ""}`,
        });
        pasos.push({
          paso: "adjuntar_orden",
          ok: true,
          detalle: `[dry-run] Adjuntaría el PDF de la orden médica a la atención (Acciones → Adjuntar documentación → Documentos múltiples → tipo "Orden de práctica/s", descripción "orden medica")${datos.ordenNota ? ` — ${datos.ordenNota}` : ""}`,
        });
      }
      return {
        ok: true,
        dryRun: true,
        pasos,
        ingresoCreado: false,
        prestacionCreada: false,
        // Payload exacto del POST que se habría enviado, con el token IOMA
        // enmascarado: se persiste en klinicos_trabajos.simulacion_payload.
        simulacionIngreso: {
          accion: "ingreso_ambulatorio",
          action: prep.plan.action,
          resumen: prep.plan.resumen,
          campos: { ...prep.plan.campos, OSToken: enmascararTokenCampo(prep.plan.campos.OSToken) },
        },
      };
    }

    // ── Paso 5 (modo real): confirmar el ingreso ambulatorio ────────────────
    // Guardas anti-duplicado:
    let atencionUrl: string | null = null;
    if (guardas?.ingresoYaCreado) {
      pasos.push({ paso: "ingreso_ambulatorio", ok: true, detalle: "Ingreso ya creado en un intento anterior — no se re-envía" });
      atencionUrl = guardas.atencionUrlPrevia ?? null;
    } else if (guardas?.postYaIntentado) {
      pasos.push({
        paso: "ingreso_ambulatorio",
        ok: false,
        detalle: "Hubo un envío previo con resultado desconocido — NO se re-envía para evitar un ingreso duplicado. Verificar a mano en Klinicos si el ingreso existe y cerrar/reencolar el trabajo.",
      });
      return { ok: false, dryRun: false, pasos, ingresoCreado: false, prestacionCreada: false, error: "Envío previo con resultado desconocido: revisar manualmente en Klinicos" };
    } else {
      // Secuencia del navegador (2-ago-2026): validar la obra social antes de
      // Guardar, como hace la pantalla.
      const preval = await validacionesPreGuardado(jar, busqueda.paciente.id, prep.plan.campos.IdObraSocialSeleccionada ?? "");
      pasos.push({ paso: "validacion_obra_social", ok: preval.ok, detalle: preval.detalle });
      if (!preval.ok) {
        return { ok: false, dryRun: false, pasos, ingresoCreado: false, prestacionCreada: false, error: `Validación de obra social previa al guardado: ${preval.detalle}` };
      }
      await guardas?.marcarPostIntentado();
      const ingreso = await confirmarIngresoAmbulatorio(jar, prep.plan);
      pasos.push({ paso: "ingreso_ambulatorio", ok: ingreso.ok, detalle: ingreso.detalle });
      if (!ingreso.ok) {
        // Rechazo definitivo de validación: no se creó nada, así que se limpia
        // el intento para que Reintentar pueda volver a postear sin trabarse.
        if (ingreso.rechazoDefinitivo) await guardas?.marcarPostRechazado?.();
        return { ok: false, dryRun: false, pasos, ingresoCreado: false, prestacionCreada: false, error: `El portal no aceptó el ingreso: ${ingreso.detalle}` };
      }
      // Persistir la confirmación de inmediato, independiente del update final
      // del worker (si ese update fallara, un reintento vería ingresoYaCreado).
      await guardas?.marcarIngresoCreado(ingreso.atencionUrl ?? null);
      logger.info({ atencionUrl: ingreso.atencionUrl }, "klinicos-robot: ingreso ambulatorio creado");
      atencionUrl = ingreso.atencionUrl ?? null;
    }

    // ── Pasos 6-7 (modo real): prestación + autorización ────────────────────
    // Aplica a cualquier sector con códigos de práctica resueltos (IMAGENES
    // S/C y también CONSULTORIOS — Holter, MAPA, ergometría, ECG). La primera
    // carga real (01/08/2026) confirmó que el form de /ordenPrestacion es el
    // mismo en ambos sectores; las guardas anti-duplicado y el fail-closed de
    // calibración de klinicos-prestaciones cubren cualquier diferencia.
    let prestacionCreada = false;
    let prestacionNumero: string | null = null;
    let autorizacionResultado: "aceptado" | "rechazado" | "incierto" | null = null;
    let nroBono: string | null = null;
    // Consulta ambulatoria (sin códigos de práctica, sector no-imágenes): el
    // ingreso NO crea el bono de consulta solo — el robot lo crea (tipo 1).
    const esConsulta = !datos.practicaCodigos?.length && !/IMAGENES/i.test(datos.sectorServicio);
    if (datos.practicaCodigos?.length || esConsulta) {
      const { extraerAtencionId, crearPrestacionReal, leerFilasPrestacionesAjax, autorizarPrestacionReal } = await import("./klinicos-prestaciones");
      const atencionId = atencionUrl ? extraerAtencionId(atencionUrl) : null;
      if (!atencionId) {
        pasos.push({ paso: "prestacion", ok: false, detalle: `No se pudo determinar el id de la atención (URL: ${atencionUrl ?? "desconocida"}) — cargar la prestación a mano` });
        return { ok: false, dryRun: false, pasos, ingresoCreado: true, prestacionCreada: false, atencionUrl, error: "Ingreso creado pero sin id de atención para la prestación: carga manual" };
      }
      if (!opciones?.prestacion) {
        pasos.push({ paso: "prestacion", ok: false, detalle: "Ejecución real sin guardas de prestación configuradas — abortado (fail-closed)" });
        return { ok: false, dryRun: false, pasos, ingresoCreado: true, prestacionCreada: false, atencionUrl, error: "Guardas de prestación ausentes" };
      }
      let prest: { ok: boolean; numero: string | null; detalle: string };
      if (datos.practicaCodigos?.length) {
        prest = await crearPrestacionReal(jar, atencionId, {
          practicaCodigos: datos.practicaCodigos,
          prescriptorNombre: datos.prescriptorNombre,
          prescriptorMatricula: datos.prescriptorMatricula,
          prescriptorEspecialidad: datos.prescriptorEspecialidad,
          cie10Codigo: datos.cie10Codigo,
          cie10Descripcion: datos.cie10Descripcion,
        }, opciones.prestacion);
      } else {
        // Regla 2-ago-2026: en consultas la fila C-… la crea el PROPIO ingreso
        // ambulatorio (verificado en vivo: C-2026-199472). NO se usa
        // /ordenPrestacion/create (circuito "Nueva Prestación", prohibido por
        // el usuario). Acá solo se LEE la grilla para confirmar que nació.
        const grilla = await leerFilasPrestacionesAjax(jar, atencionId);
        const consultas = grilla.filas.filter((f) => f.tipo === "C");
        if (opciones.prestacion.prestacionYaCreada) {
          // Idempotencia: un reintento de un trabajo que YA confirmó la fila
          // no vuelve a exigir "exactamente 1" (la grilla pudo cambiar a mano).
          prest = { ok: true, numero: consultas[0]?.numero ?? null, detalle: "La consulta ya estaba confirmada en un intento anterior (guarda anti-duplicado)" };
        } else if (!grilla.ok) {
          prest = { ok: false, numero: null, detalle: `No se pudo leer la grilla de la atención: ${grilla.detalle}` };
        } else if (consultas.length === 1) {
          prest = { ok: true, numero: consultas[0].numero, detalle: `Consulta ${consultas[0].numero} creada por el ingreso (${consultas[0].estado}) — casillero de token disponible` };
          await opciones.prestacion.marcarPrestacionCreada(consultas[0].numero);
        } else if (consultas.length === 0) {
          prest = { ok: false, numero: null, detalle: "El ingreso se creó pero NO nació la fila de la consulta. Causa típica: el paciente ya tiene una atención con ese mismo profesional en Klinicos — revisar y resolver a mano (fail-closed)" };
        } else {
          prest = { ok: false, numero: null, detalle: `La atención tiene ${consultas.length} filas de consulta — ambiguo, revisión manual (fail-closed)` };
        }
      }
      pasos.push({ paso: "prestacion", ok: prest.ok, detalle: prest.detalle });
      if (!prest.ok) {
        // El ingreso SÍ se creó: dejar el paso manual clarísimo, con el link
        // directo a la atención para confirmar la prestación a mano.
        const link = atencionUrl ? `${BASE_URL}${atencionUrl.startsWith("http") ? new URL(atencionUrl).pathname : atencionUrl}` : "(sin URL de atención)";
        return {
          ok: false, dryRun: false, pasos, ingresoCreado: true, prestacionCreada: false, atencionUrl,
          error: `Ingreso creado, pero la prestación ${esConsulta ? "de consulta " : ""}NO quedó cargada: ${prest.detalle} — confirmarla a mano en Klinicos: ${link}`,
        };
      }
      prestacionCreada = true;
      prestacionNumero = prest.numero;

      // Adjuntar la orden médica (lección 03/08/2026): tras confirmar la
      // prestación se sube el PDF de la orden vía "Adjuntar documentación".
      // Fail-closed: un intento fallido deja el trabajo en error con el paso
      // manual claro (el ingreso y la prestación YA están creados).
      if (datos.practicaCodigos?.length) {
        const adjunto = opciones?.adjunto;
        if (!adjunto) {
          pasos.push({
            paso: "adjuntar_orden",
            ok: false,
            detalle: "Sin orden de Conectar vinculada al trabajo: subir el PDF de la orden a mano en Klinicos (Acciones → Adjuntar documentación)",
          });
        } else if (adjunto.guardas.yaAdjuntada) {
          pasos.push({ paso: "adjuntar_orden", ok: true, detalle: "La orden ya fue adjuntada en un intento anterior — no se re-envía" });
        } else if (adjunto.guardas.postYaIntentado) {
          pasos.push({
            paso: "adjuntar_orden",
            ok: false,
            detalle: "Hubo un intento previo de adjuntar con resultado desconocido — NO se re-envía para evitar un documento duplicado. Verificar en Klinicos (Adjuntar documentación) si la orden ya figura.",
          });
          return { ok: false, dryRun: false, pasos, ingresoCreado: true, prestacionCreada, prestacionNumero, atencionUrl, error: "Adjunto previo con resultado desconocido: revisar manualmente en Klinicos" };
        } else {
          const pdf = await adjunto.obtenerPdf();
          if (!pdf.ok) {
            pasos.push({ paso: "adjuntar_orden", ok: false, detalle: `No se pudo generar el PDF de la orden: ${pdf.detalle} — adjuntarla a mano en Klinicos` });
            await adjunto.guardas.marcarFallo?.(`No se pudo generar el PDF de la orden: ${pdf.detalle}`);
            return { ok: false, dryRun: false, pasos, ingresoCreado: true, prestacionCreada, prestacionNumero, atencionUrl, error: `Prestación creada, pero la orden NO quedó adjunta: ${pdf.detalle} — subirla a mano en Klinicos` };
          }
          const { adjuntarOrdenReal } = await import("./klinicos-adjuntos");
          const { pathDetalleAtencion } = await import("./klinicos-prestaciones");
          await adjunto.guardas.marcarIntentado();
          const adj = await adjuntarOrdenReal(jar, atencionId, pdf.pdf, pdf.nombre, atencionUrl ? pathDetalleAtencion(atencionUrl) : undefined, prestacionNumero ?? undefined);
          pasos.push({ paso: "adjuntar_orden", ok: adj.ok, detalle: adj.detalle });
          if (adj.ok) {
            await adjunto.guardas.marcarAdjuntada(adj.detalle);
          } else {
            if (adj.rechazoDefinitivo) await adjunto.guardas.limpiarIntento?.();
            await adjunto.guardas.marcarFallo?.(adj.detalle);
            const link = atencionUrl ? `${BASE_URL}${atencionUrl.startsWith("http") ? new URL(atencionUrl).pathname : atencionUrl}` : "";
            return {
              ok: false, dryRun: false, pasos, ingresoCreado: true, prestacionCreada, prestacionNumero, atencionUrl,
              error: `Prestación creada, pero la orden NO quedó adjunta: ${adj.detalle} — subirla a mano en Klinicos${link ? `: ${link}` : ""}`,
            };
          }
        }
      }

      // Autorización con token (fail-closed; el token nunca se reconsume)
      if (datos.tokenAutorizacion?.trim()) {
        if (!opciones.autorizacion) {
          pasos.push({ paso: "autorizacion", ok: false, detalle: "Ejecución real sin guardas de autorización configuradas — abortado (fail-closed)" });
          return { ok: false, dryRun: false, pasos, ingresoCreado: true, prestacionCreada, prestacionNumero, atencionUrl, error: "Guardas de autorización ausentes" };
        }
        const aut = await autorizarPrestacionReal(jar, atencionId, datos.tokenAutorizacion, opciones.autorizacion, prestacionNumero);
        pasos.push({ paso: "autorizacion", ok: aut.ok, detalle: aut.detalle });
        autorizacionResultado = aut.resultado;
        nroBono = aut.nroBono;
        if (!aut.ok) {
          return {
            ok: false, dryRun: false, pasos, ingresoCreado: true, prestacionCreada, prestacionNumero,
            autorizacionResultado, nroBono, atencionUrl,
            error: `Autorización ${aut.resultado}: ${aut.detalle}`,
          };
        }
      } else {
        pasos.push({ paso: "autorizacion", ok: true, detalle: "Sin token de autorización: la prestación queda CONFIRMADA sin autorizar (el token se carga cuando el paciente lo genere)" });
      }
    }
    return { ok: true, dryRun: false, pasos, ingresoCreado: true, prestacionCreada, prestacionNumero, autorizacionResultado, nroBono, atencionUrl };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ err }, "klinicos-robot: error inesperado");
    return { ok: false, dryRun, pasos, ingresoCreado: false, prestacionCreada: false, error: msg };
  }
}

// ── Validación en vivo del token IOMA (calibrada 18/07/2026) ────────────────
// El portal valida el token contra Yoma vía POST
// /ordenPrestacion/validarDatosObraSocialPaciente. La respuesta es un JSON
// doblemente serializado: body → string JSON → { error, message, data }, y
// data → string JSON → { Status: "OK"|"WARNING"|"NO", Mensaje, ... }.
// OJO: si el token no es numérico el portal devuelve error:true con
// "Input string was not in a correct format".
export interface ResultadoValidacionToken {
  ok: boolean; // false = no se pudo consultar (Klinicos caído, login falló, etc.)
  valido: boolean;
  mensaje: string;
  afiliado: string | null;
  /** Condición de datos persistente (paciente inexistente en Klinicos, sin
   * obra social): reintentar no sirve, requiere carga manual previa. */
  requiereCargaManual?: boolean;
}

export async function validarTokenConsultaKlinicos(
  dni: string,
  token: string,
): Promise<ResultadoValidacionToken> {
  if (!klinicosHabilitado()) {
    return { ok: false, valido: false, mensaje: "Integración Klinicos no configurada", afiliado: null };
  }
  if (!/^\d+$/.test(token.trim())) {
    return { ok: true, valido: false, mensaje: "Token inválido: debe ser numérico", afiliado: null };
  }
  try {
    const jar = new CookieJar();
    const login = await loginKlinicos(jar);
    if (!login.ok) return { ok: false, valido: false, mensaje: `No se pudo ingresar a Klinicos: ${login.detalle}`, afiliado: null };
    const ctx = await seleccionarContextoKlinicos(jar);
    if (!ctx.ok) return { ok: false, valido: false, mensaje: `No se pudo seleccionar contexto en Klinicos: ${ctx.detalle}`, afiliado: null };
    const busq = await buscarPacienteKlinicos(jar, dni);
    if (!busq.ok || !busq.paciente) {
      // Paciente inexistente en Klinicos: condición de datos, no error técnico.
      const noExiste = busq.ok && !busq.paciente;
      return { ok: false, valido: false, mensaje: busq.detalle, afiliado: null, requiereCargaManual: noExiste || /NO existe/i.test(busq.detalle) };
    }
    const oss = await obrasSocialesPacienteKlinicos(jar, busq.paciente.id);
    const os = oss.find((o) => o.grupo === "IOMA") ?? oss[0] ?? null;
    if (!os) {
      return { ok: true, valido: false, mensaje: "El paciente no tiene obra social cargada en Klinicos — el token no se puede validar", afiliado: null, requiereCargaManual: true };
    }
    const res = await jarFetch(jar, "/ordenPrestacion/validarDatosObraSocialPaciente", {
      method: "POST",
      body: new URLSearchParams({
        idPaciente: busq.paciente.id,
        idObraSocial: String(os.idObraSocial),
        grupoNomenclador: os.grupo ?? "IOMA",
        OSToken: token.trim(),
        tipoEspecialidadDestino: "MED",
      }).toString(),
      contentType: "application/x-www-form-urlencoded; charset=UTF-8",
      referer: `${BASE_URL}/atencion/nuevo/${busq.paciente.id}`,
      xhr: true,
    });
    if (res.status !== 200) {
      return { ok: false, valido: false, mensaje: `Klinicos respondió ${res.status} al validar el token`, afiliado: null };
    }
    let outer: { error?: boolean; message?: string; data?: string | null };
    try {
      let parsed: unknown = JSON.parse(res.text);
      if (typeof parsed === "string") parsed = JSON.parse(parsed);
      outer = parsed as typeof outer;
    } catch {
      return { ok: false, valido: false, mensaje: "Respuesta de Klinicos no es JSON", afiliado: null };
    }
    if (outer.error) {
      const msg = outer.message ?? "";
      if (/input string/i.test(msg)) {
        return { ok: true, valido: false, mensaje: "Token inválido: formato incorrecto", afiliado: null };
      }
      return { ok: false, valido: false, mensaje: msg || "Klinicos devolvió un error al validar el token", afiliado: null };
    }
    const data = outer.data ? (JSON.parse(outer.data) as { Status?: string; Mensaje?: string; ApellidoNombre?: string | null }) : null;
    if (!data) return { ok: false, valido: false, mensaje: "Klinicos no devolvió datos de la validación", afiliado: null };
    const valido = data.Status === "OK" || data.Status === "WARNING";
    return {
      ok: true,
      valido,
      mensaje: data.Mensaje || (valido ? "OK" : "Token inválido"),
      afiliado: data.ApellidoNombre ?? null,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ err }, "klinicos-robot: error validando token");
    return { ok: false, valido: false, mensaje: `No se pudo consultar Klinicos: ${msg}`, afiliado: null };
  }
}
