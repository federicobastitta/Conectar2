import { CookieJar, jarFetch, camposDeForm } from "./klinicos-robot";

// Action del form de prestación. Calibrado en vivo 02/08/2026: la página de
// create trae DOS forms — el buscador de la barra (action="") primero y el de
// la prestación (id="orderForm") después. Tomar "el primer action" posteaba a
// "" → 404. Se busca el form correcto por id, con respaldo al primer action
// NO vacío, y último recurso el propio createPath.
export function accionDelFormPrestacion(html: string, createPath: string): string {
  const tagOrderForm = html.match(/<form[^>]*id="orderForm"[^>]*>/i)?.[0];
  const deOrderForm = tagOrderForm?.match(/action="([^"]+)"/i)?.[1];
  if (deOrderForm) return deOrderForm.replace(/&amp;/g, "&");
  const primeraNoVacia = [...html.matchAll(/<form[^>]*action="([^"]+)"/gi)].map((m) => m[1]!)[0];
  return (primeraNoVacia ?? createPath).replace(/&amp;/g, "&");
}

// ── Pantalla Prestaciones → Autorizar (calibrada 31/07/2026, video ECG) ────
// Reglas del manual de facturación v1.0 (30/07/2026):
//  - Para validar un token: encontrar EXACTAMENTE UNA prestación CONFIRMADA y
//    sin autorización → Autorizar → releer → aceptado solo si aparece el bono.
//  - 0 o >1 candidatas → NO adivinar: revisión humana (fail-closed).
//  - Eco Doppler y resonancias: carga manual (decisión 22/07/2026).
//  - El token completo NUNCA viaja a logs/pasos/payloads: solo enmascarado
//    (decisión del usuario 31/07/2026: Conectar lo guarda, el RPA no lo expone).
//
// La creación de la práctica va por /ordenPrestacion/create/{atencionId}/3
// (3 = tipo Práctica). Campos observados en el video: prescriptor (select2,
// autocompleta matrícula si es interno), efector precargado del ingreso,
// diagnóstico CIE-10 OBLIGATORIO ("Debe indicar un diagnóstico general o
// asociar cada práctica con un diagnóstico en particular."), prácticas por
// código exacto (ej. 170101 ECG). Éxito = redirect + "Prestación creada
// correctamente" y fila P-AAAA-NNNNNN en CONFIRMADO.

// Prácticas excluidas de la automatización (decisión registrada 22/07/2026):
// mantener SIEMPRE la carga manual. Ante una modificación expresa de la regla
// se ajusta acá.
const PATRONES_EXCLUIDOS: Array<{ patron: RegExp; motivo: string }> = [
  { patron: /DOPPLER/, motivo: "eco Doppler" },
  { patron: /RESONANCIA/, motivo: "resonancia" },
  { patron: /\bRMN\b/, motivo: "resonancia (RMN)" },
  { patron: /\bRNM\b/, motivo: "resonancia (RNM)" },
];

function normalizar(s: string): string {
  return s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toUpperCase();
}

// Devuelve el motivo de exclusión si alguno de los textos (especialidad,
// motivo, nombre de práctica, etc.) matchea una práctica de carga manual.
export function esPracticaExcluida(textos: Array<string | null | undefined>): string | null {
  for (const t of textos) {
    if (!t) continue;
    const norm = normalizar(t);
    for (const { patron, motivo } of PATRONES_EXCLUIDOS) {
      if (patron.test(norm)) return motivo;
    }
  }
  return null;
}

// Versión enmascarada del token: lo único que puede aparecer en logs, pasos
// y payloads de simulación. Nunca el token completo.
export function enmascararToken(token: string | null | undefined): string | null {
  if (!token) return null;
  const limpio = token.trim();
  if (!limpio) return null;
  const visibles = limpio.length > 4 ? limpio.slice(-4) : limpio.slice(-1);
  return `••••${visibles}`;
}

// ── Grilla de prestaciones del detalle de atención ─────────────────────────
export interface PrestacionFila {
  numero: string; // ej. "P-2026-198669" (Tipo-Año-Número)
  tipo: string; // C = consulta, P = práctica, etc.
  estado: string; // CONFIRMADO | AUTORIZADA | ...
  nroBono: string | null; // presente solo cuando la autorización fue real
}

const ESTADOS_CONOCIDOS = [
  "CONFIRMADO",
  "AUTORIZADA POR REALIZAR",
  "AUTORIZADA",
  "ESPERANDO INFORME",
  "INFORMADO",
  "FACTURABLE",
  "ANULADA",
];

// Parsea las filas de la grilla "Prestaciones" del detalle de atención.
// Fail-closed: si el HTML no matchea lo esperado devuelve [] y el caso va a
// revisión (nunca se opera sobre una lectura dudosa).
export function parsePrestaciones(html: string): PrestacionFila[] {
  const filas: PrestacionFila[] = [];
  // Cada fila contiene el identificador Tipo-Año-Número (ej. P-2026-198669).
  const trs = html.split(/<tr[\s>]/i).slice(1);
  for (const tr of trs) {
    const fin = tr.indexOf("</tr>");
    const cuerpo = fin >= 0 ? tr.slice(0, fin) : tr;
    const numero = cuerpo.match(/\b([A-Z]{1,3}-\d{4}-\d+)\b/)?.[1];
    if (!numero) continue;
    const texto = normalizar(cuerpo.replace(/<[^>]*>/g, " ").replace(/\s+/g, " "));
    // El estado más específico gana ("AUTORIZADA POR REALIZAR" antes que "AUTORIZADA")
    const estado = ESTADOS_CONOCIDOS.find((e) => texto.includes(e)) ?? "DESCONOCIDO";
    // N° de bono: número largo que aparece después del estado (la celda Token
    // es un input, no texto). Solo lo tomamos si es inequívoco.
    const despuesEstado = texto.slice(texto.indexOf(estado) + estado.length);
    const bono = despuesEstado.match(/\b(\d{6,})\b/)?.[1] ?? null;
    filas.push({ numero, tipo: numero.split("-")[0] ?? "", estado, nroBono: bono });
  }
  return filas;
}

// ── Selección fail-closed de la prestación a autorizar ─────────────────────
export type SeleccionAutorizar =
  | { ok: true; fila: PrestacionFila }
  | { ok: false; motivo: string };

export function elegirPrestacionParaAutorizar(filas: PrestacionFila[]): SeleccionAutorizar {
  if (filas.length === 0) {
    return { ok: false, motivo: "La grilla de prestaciones vino vacía o no se pudo leer — revisión manual (fail-closed)" };
  }
  const candidatas = filas.filter((f) => f.estado === "CONFIRMADO" && !f.nroBono);
  if (candidatas.length === 0) {
    return { ok: false, motivo: `No hay ninguna prestación CONFIRMADA sin autorización (hay: ${filas.map((f) => `${f.numero} ${f.estado}${f.nroBono ? ` bono ${f.nroBono}` : ""}`).join("; ")}) — revisión manual` };
  }
  if (candidatas.length > 1) {
    return { ok: false, motivo: `Hay ${candidatas.length} prestaciones candidatas (${candidatas.map((f) => f.numero).join(", ")}) — el manual prohíbe adivinar: revisión manual` };
  }
  return { ok: true, fila: candidatas[0]! };
}

// Releer la grilla después de Autorizar: el token se considera aceptado SOLO
// cuando aparece el número de bono (o la prestación pasó a autorizada).
// Cualquier otra cosa = resultado incierto (NUNCA reintentar el consumo).
export type ResultadoRelectura =
  | { resultado: "aceptado"; nroBono: string | null }
  | { resultado: "rechazado" }
  | { resultado: "incierto"; motivo: string };

export function evaluarRelectura(filas: PrestacionFila[], numero: string): ResultadoRelectura {
  const fila = filas.find((f) => f.numero === numero);
  if (!fila) return { resultado: "incierto", motivo: `La prestación ${numero} no aparece en la relectura` };
  if (fila.nroBono) return { resultado: "aceptado", nroBono: fila.nroBono };
  if (fila.estado.startsWith("AUTORIZADA")) return { resultado: "aceptado", nroBono: null };
  if (fila.estado === "CONFIRMADO") return { resultado: "rechazado" };
  return { resultado: "incierto", motivo: `Estado inesperado tras autorizar: ${fila.estado}` };
}

// ── Plan de simulación de la carga de práctica ──────────────────────────────
// En modo simulación NO se navega ni se confirma nada en Klinicos: se arma y
// persiste el payload exacto que habría viajado (token enmascarado).
export interface PlanPracticaSimulado {
  accion: "crear_prestacion_practica";
  url: string; // /ordenPrestacion/create/{atencionId}/3 — atencionId real recién tras el ingreso
  tipoOrden: "Practica";
  practicaCodigos: string[];
  prescriptor: { nombre: string | null; matricula: string | null; especialidad: string | null };
  efector: string | null;
  diagnostico: { codigo: string | null; descripcion: string | null };
  tokenEnmascarado: string | null;
  advertencias: string[];
}

export function armarPlanPracticaSimulado(datos: {
  practicaCodigos: string[];
  prescriptorNombre: string | null;
  prescriptorMatricula: string | null;
  prescriptorEspecialidad: string | null;
  efectorNombre: string | null;
  cie10Codigo: string | null;
  cie10Descripcion: string | null;
  tokenAutorizacion: string | null;
}): PlanPracticaSimulado {
  const advertencias: string[] = [];
  if (!datos.cie10Codigo) {
    advertencias.push('Falta diagnóstico CIE-10: el portal rechaza el form ("Debe indicar un diagnóstico general…")');
  }
  if (!datos.prescriptorMatricula) {
    advertencias.push("Falta matrícula del prescriptor (obligatoria para prescriptor externo)");
  }
  if (!datos.tokenAutorizacion) {
    advertencias.push("Sin token de autorización: la prestación quedaría CONFIRMADA sin autorizar");
  }
  return {
    accion: "crear_prestacion_practica",
    url: "/ordenPrestacion/create/{atencionId}/3",
    tipoOrden: "Practica",
    practicaCodigos: datos.practicaCodigos,
    prescriptor: {
      nombre: datos.prescriptorNombre,
      matricula: datos.prescriptorMatricula,
      especialidad: datos.prescriptorEspecialidad,
    },
    efector: datos.efectorNombre,
    diagnostico: { codigo: datos.cie10Codigo, descripcion: datos.cie10Descripcion },
    tokenEnmascarado: enmascararToken(datos.tokenAutorizacion),
    advertencias,
  };
}

// ── Etapa 4 (modo asistido): ejecución REAL con confirmación del operador ──
// Todo lo de abajo escribe en Klinicos. Solo se llega acá cuando el operador
// aprobó el caso en la bandeja. Principios (manual de facturación v1.0):
//  - Fail-closed: si una pantalla/endpoint no matchea lo calibrado, se aborta
//    ANTES de cualquier POST con un mensaje que sirva para calibrar en vivo.
//  - Anti doble-POST (patrón post_intentado_en) para la creación de la
//    prestación Y para la autorización.
//  - Un token nunca se reconsume: ante reintento se relee la grilla primero;
//    incierto ≠ rechazo.

// Extrae el id de la atención de la URL del detalle (GUID o id numérico).
export function extraerAtencionId(atencionUrl: string): string | null {
  const guid = atencionUrl.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i)?.[0];
  if (guid) return guid;
  const num = atencionUrl.match(/\/(\d+)(?:[/?#]|$)/)?.[1];
  return num ?? null;
}

// Ruta del detalle de la atención a partir de la URL que devolvió el portal
// tras crear el ingreso (puede venir absoluta): siempre path + query.
export function pathDetalleAtencion(atencionUrl: string): string {
  if (atencionUrl.startsWith("http")) {
    const u = new URL(atencionUrl);
    return u.pathname + u.search;
  }
  return atencionUrl;
}

// Busca en el HTML/JS de una página la URL de un endpoint cuyo path matchee el
// patrón (ej. /autoriza/i). Se usa para descubrir los endpoints AJAX exactos
// en la primera corrida real (calibración en vivo, fail-closed si no aparece).
export function descubrirEndpoint(html: string, patron: RegExp): string | null {
  const urls = [...html.matchAll(/(?:url\s*[:=]\s*|action=|href=|\.post\(\s*|\.ajax\(\s*\{[^}]*url\s*:\s*)["']([^"']+)["']/gi)]
    .map((m) => m[1]!)
    .filter((u) => u.startsWith("/") && patron.test(u));
  return urls[0] ?? null;
}

// Resultado de la autorización asistida. Regla del task/manual: aceptado SOLO
// con N° de bono visible tras releer. "AUTORIZADA" sin bono = incierto (se
// verifica a mano, pero el token NO se reconsume). CONFIRMADO intacto = rechazo.
export function resultadoAutorizacionDesdeRelectura(
  filas: PrestacionFila[],
  numero: string,
): { resultado: "aceptado" | "rechazado" | "incierto"; nroBono: string | null; detalle: string } {
  const base = evaluarRelectura(filas, numero);
  if (base.resultado === "aceptado") {
    if (base.nroBono) {
      return { resultado: "aceptado", nroBono: base.nroBono, detalle: `Token aceptado — N° de bono ${base.nroBono}` };
    }
    return {
      resultado: "incierto",
      nroBono: null,
      detalle: `La prestación ${numero} figura autorizada pero SIN N° de bono visible — verificar a mano en Klinicos (el token NO se reintenta)`,
    };
  }
  if (base.resultado === "rechazado") {
    return { resultado: "rechazado", nroBono: null, detalle: `El token fue rechazado (la prestación ${numero} sigue CONFIRMADA sin bono) — avisar al paciente y cargar a mano` };
  }
  return { resultado: "incierto", nroBono: null, detalle: `${base.motivo} — NO reintentar la autorización (el token no se reconsume)` };
}

export interface DatosPrestacionReal {
  practicaCodigos: string[];
  prescriptorNombre: string | null;
  prescriptorMatricula: string | null;
  prescriptorEspecialidad: string | null;
  cie10Codigo: string | null;
  cie10Descripcion: string | null;
}

export interface GuardasPrestacion {
  prestacionYaCreada: boolean;
  postYaIntentado: boolean;
  marcarPostIntentado: () => Promise<void>;
  marcarPrestacionCreada: (numero: string | null) => Promise<void>;
  // Rechazo con validación EXPLÍCITA del portal = el POST seguro NO creó nada:
  // se puede limpiar la guarda anti doble-POST para permitir el reintento.
  limpiarPostIntentado?: () => Promise<void>;
}

// Busca en un endpoint select2 (descubierto de la página) el id exacto de una
// opción cuyo texto empiece con el código/término. Exige coincidencia ÚNICA.
async function buscarOpcionSelect2(
  jar: CookieJar,
  endpoint: string,
  term: string,
): Promise<{ ok: boolean; id: string | null; text: string | null; detalle: string }> {
  const sep = endpoint.includes("?") ? "&" : "?";
  const res = await jarFetch(jar, `${endpoint}${sep}term=${encodeURIComponent(term)}`, { xhr: true });
  if (res.status !== 200) return { ok: false, id: null, text: null, detalle: `GET ${endpoint} → ${res.status}` };
  let items: Array<{ id?: unknown; text?: unknown; Text?: unknown; Value?: unknown }> = [];
  try {
    const parsed = JSON.parse(res.text) as unknown;
    items = Array.isArray(parsed)
      ? (parsed as typeof items)
      : ((parsed as { results?: typeof items; items?: typeof items }).results ??
        (parsed as { results?: typeof items; items?: typeof items }).items ??
        []);
  } catch {
    return { ok: false, id: null, text: null, detalle: `Respuesta de ${endpoint} no es JSON` };
  }
  const opciones = items.map((i) => ({
    id: String(i.id ?? i.Value ?? ""),
    text: String(i.text ?? i.Text ?? ""),
  }));
  // Coincidencia exacta por código al inicio del texto ("170101 | ELECTRO...")
  const matches = opciones.filter((o) => normalizar(o.text).startsWith(normalizar(term)));
  if (matches.length === 1) return { ok: true, id: matches[0]!.id, text: matches[0]!.text, detalle: matches[0]!.text };
  return {
    ok: false,
    id: null,
    text: null,
    detalle: `Búsqueda "${term}" en ${endpoint}: ${matches.length} coincidencias exactas (hay ${opciones.length} resultados) — el manual prohíbe adivinar`,
  };
}

// Crea la prestación Práctica en /ordenPrestacion/create/{atencionId}/3.
// Fail-closed en cada paso: si el form no matchea lo calibrado por video, se
// aborta ANTES del POST con el detalle de lo encontrado (calibración en vivo).
export async function crearPrestacionReal(
  jar: CookieJar,
  atencionId: string,
  datos: DatosPrestacionReal,
  guardas: GuardasPrestacion,
): Promise<{ ok: boolean; numero: string | null; detalle: string }> {
  if (guardas.prestacionYaCreada) {
    return { ok: true, numero: null, detalle: "La prestación ya se creó en un intento anterior — no se re-envía" };
  }
  if (guardas.postYaIntentado) {
    return {
      ok: false,
      numero: null,
      detalle: "Hubo un POST de prestación previo con resultado desconocido — NO se re-envía (verificar a mano en Klinicos)",
    };
  }
  // Igual que la consulta (lección 03/08/2026, carga real Holter Frontini):
  // el create exige el id NUMÉRICO IdAtencionACobrar — con el GUID devuelve 500.
  const resuelto = await resolverIdAtencionACobrar(jar, atencionId);
  if (!resuelto.id) {
    return { ok: false, numero: null, detalle: `No se pudo resolver el id de la atención a cobrar: ${resuelto.detalle}` };
  }
  const createPath = `/ordenPrestacion/create/${resuelto.id}/3`;
  const pagina = await jarFetch(jar, createPath);
  if (pagina.status !== 200) {
    return { ok: false, numero: null, detalle: `GET ${createPath} → ${pagina.status}${pagina.location ? ` (${pagina.location})` : ""}` };
  }
  const campos = camposDeForm(pagina.text);
  const nombres = Object.keys(campos);
  if (!nombres.some((n) => /RequestVerificationToken/i.test(n))) {
    return { ok: false, numero: null, detalle: `Calibración pendiente: el form de ${createPath} no trae antiforgery (campos: ${nombres.join(", ") || "ninguno"})` };
  }
  const action = accionDelFormPrestacion(pagina.text, createPath);

  // Campo del diagnóstico: input cuyo name contenga "diagnost" y "cod"
  const campoDiag = nombres.find((n) => /diagnost/i.test(n) && /cod/i.test(n)) ?? nombres.find((n) => /diagnost/i.test(n));
  if (!campoDiag) {
    return { ok: false, numero: null, detalle: `Calibración pendiente: no se encontró el campo de diagnóstico en ${createPath} (campos: ${nombres.join(", ")})` };
  }
  if (!datos.cie10Codigo) {
    return { ok: false, numero: null, detalle: "Falta el diagnóstico CIE-10 (obligatorio) — revisar el trabajo en la bandeja" };
  }

  // Prácticas (calibrado en vivo 03/08/2026, carga real del Holter de Frontini):
  // los ítems se buscan en /ordenPrestacion/itemJSON/{OS}/{plan}/{convenio}/{tipoOrden}/{idProfesion}?q=…
  // con los valores del propio form; idProfesion sale del option seleccionado
  // de EspecialidadId (atributo data-idProfesion). Coincidencia ÚNICA por código.
  const idProfesion = pagina.text.match(/<option[^>]*data-idProfesion="(\d+)"[^>]*selected[^>]*>/i)?.[1]
    ?? pagina.text.match(/<option[^>]*selected[^>]*data-idProfesion="(\d+)"[^>]*>/i)?.[1];
  const os = campos["ObraSocialid"];
  const plan = campos["IdObraSocialPlan"];
  const convenio = campos["IdConvenio"];
  const tipoOrden = campos["TipoOrdenPrestacionId"];
  if (!idProfesion || !os || !plan || !convenio || !tipoOrden) {
    return { ok: false, numero: null, detalle: `Calibración pendiente: faltan datos para itemJSON (idProfesion=${idProfesion ?? "?"}, OS=${os ?? "?"}, plan=${plan ?? "?"}, convenio=${convenio ?? "?"}, tipoOrden=${tipoOrden ?? "?"}) en ${createPath}` };
  }
  interface ItemKlinicos { Value: unknown; Text: unknown; data: Record<string, string | null> }
  const items: ItemKlinicos[] = [];
  for (const codigo of datos.practicaCodigos) {
    const res = await jarFetch(jar, `/ordenPrestacion/itemJSON/${os}/${plan}/${convenio}/${tipoOrden}/${idProfesion}?q=${encodeURIComponent(codigo)}`, { xhr: true });
    let arr: ItemKlinicos[] = [];
    try { arr = JSON.parse(res.text) as ItemKlinicos[]; } catch { /* fail-closed abajo */ }
    const matches = arr.filter((o) => normalizar(String(o.Text ?? "")).startsWith(normalizar(codigo)));
    if (matches.length !== 1) {
      return { ok: false, numero: null, detalle: `Práctica ${codigo}: ${matches.length} coincidencias exactas en itemJSON (HTTP ${res.status}, ${arr.length} resultados) — el manual prohíbe adivinar; revisión manual` };
    }
    items.push(matches[0]!);
  }

  // Prescriptor EXTERNO (texto libre): el portal exige tipo de matrícula además
  // del nombre y la matrícula, si falta rechaza "Debe indicar el profesional
  // solicitante" (calibrado 03/08/2026). Se usa MP (provincial) por defecto.
  if (!datos.prescriptorNombre || !datos.prescriptorMatricula) {
    return { ok: false, numero: null, detalle: "Falta nombre o matrícula del prescriptor (obligatorios para prescriptor externo)" };
  }
  campos["ProfesionalOrdenId"] = "";
  campos["ProfesionalOrdenApellidoYNombre"] = datos.prescriptorNombre;
  campos["ProfesionalOrdenTipoMatricula"] = "MP";
  campos["ProfesionalOrdenTipoMatricula_list"] = "MP";
  campos["ProfesionalOrdenMatricula"] = datos.prescriptorMatricula;
  // Especialidad del prescriptor: la misma de la atención (option seleccionado)
  const espSeleccionada = campos["EspecialidadId"];
  if (espSeleccionada) campos["EspecialidadProfesionalOrdenId"] = espSeleccionada;
  campos[campoDiag] = datos.cie10Codigo;
  if ("TipoAfiliado" in campos && !campos["TipoAfiliado"]) campos["TipoAfiliado"] = "OBL";

  // Filas de ítems: réplica de la plantilla server-rendered del form de
  // consulta precargado (misma estructura para tipo Práctica).
  const fechaVto = campos["Fecha"] || "";
  const body = new URLSearchParams(campos);
  items.forEach((item, i) => {
    const p = (k: string) => `ordenPrestacionItems[${i}].${k}`;
    const d = item.data ?? {};
    body.append(p("id"), "0");
    body.append(p("OrdenPrestacionid"), "0");
    body.append(p("IdNomencladorPrestador"), String(item.Value));
    body.append(p("Copago"), d.copago ?? "0");
    body.append(p("Honorarios"), d.honorarios ?? "0");
    body.append(p("Gastos"), d.gastos ?? "0");
    body.append(p("Ayudante1"), d.ayudante1 ?? "0");
    body.append(p("Ayudante2"), d.ayudante2 ?? "0");
    body.append(p("Ayudante3"), d.ayudante3 ?? "0");
    body.append(p("FechaVencimientoMesCobertura"), fechaVto);
    body.append(p("FechaVencimientoAnioCobertura"), fechaVto);
    body.append(p("FechaVencimientoGarantia"), fechaVto);
    body.append(p("ConfiguracionDatosAdicionales"), d.configuracionDatosAdicionales ?? "");
    body.append(p("TiposDocumentosRequeridosPorPrestacion"), "");
    body.append(p("TiposDocumentosRequeridosPorPractica"), "");
    body.append(p("codigoNomenclador"), d.codigo ?? datos.practicaCodigos[i] ?? "");
    body.append(p("terminologia"), String(item.Text ?? "").split("|")[1]?.trim() ?? "");
    body.append(p("codigoDiagnostico"), datos.cie10Codigo ?? "");
    body.append(p("cantidad"), "1");
    body.append(p("precio"), d.valor ?? "0");
    body.append(p("CopagoPaciente"), d.copagoPaciente ?? "0");
    body.append(p("estado"), "C");
  });

  // Snapshot de la grilla ANTES del POST: la confirmación exige una fila P- nueva.
  // La grilla del detalle es 100% AJAX (igual que en la consulta): el HTML no
  // trae filas, así que el snapshot y la relectura van contra el endpoint AJAX.
  const antes = await leerFilasPrestacionesAjax(jar, atencionId);
  if (!antes.ok) {
    return { ok: false, numero: null, detalle: `No se pudo leer la grilla de prestaciones antes del POST (${antes.detalle}) — abortado sin enviar` };
  }
  const numerosAntes = new Set(antes.filas.map((f) => f.numero));

  await guardas.marcarPostIntentado();
  const post = await jarFetch(jar, action, {
    method: "POST",
    body: body.toString(),
    contentType: "application/x-www-form-urlencoded",
    referer: `${(process.env.KLINICOS_BASE_URL ?? "https://klinicos.aceapp.ar").replace(/\/$/, "")}${createPath}`,
  });

  if (post.status === 200) {
    const errores = [...post.text.matchAll(/field-validation-error[^>]*>([^<]+)</g)].map((m) => m[1]!.trim());
    const resumenErr = post.text.match(/validation-summary-errors[\s\S]{0,400}?<li>([^<]+)</)?.[1]?.trim();
    const det = [resumenErr, ...errores].filter(Boolean).join(" | ");
    // Sin redirect y sin errores visibles = resultado incierto: NO reintentar
    if (det) {
      await guardas.limpiarPostIntentado?.();
      return { ok: false, numero: null, detalle: `El portal rechazó la prestación: ${det}` };
    }
  }

  // Confirmación por relectura (vale para redirect Y para resultado dudoso)
  const despues = await leerFilasPrestacionesAjax(jar, atencionId);
  const nueva = despues.filas.find((f) => f.tipo === "P" && !numerosAntes.has(f.numero));
  if (nueva) {
    await guardas.marcarPrestacionCreada(nueva.numero);
    return { ok: true, numero: nueva.numero, detalle: `Prestación ${nueva.numero} creada (${nueva.estado})` };
  }
  return {
    ok: false,
    numero: null,
    detalle: `POST prestación → ${post.status}${post.location ? ` (${post.location})` : ""} pero la relectura no muestra una fila P- nueva — verificar a mano en Klinicos ANTES de reintentar`,
  };
}

// Decisión pura del reintento tras un POST de autorización con resultado
// desconocido: SOLO un bono visible en la prestación objetivo resuelve como
// aceptado. Bonos de otras prestaciones (históricas o de consulta) no cuentan;
// sin objetivo conocido, siempre incierto. El token jamás se reenvía.
export function resolverReintentoAutorizacion(
  filas: PrestacionFila[],
  prestacionNumeroObjetivo: string | null,
): { resultado: "aceptado" | "incierto"; nroBono: string | null; detalle: string } {
  if (prestacionNumeroObjetivo) {
    const objetivo = filas.find((f) => f.numero === prestacionNumeroObjetivo);
    if (objetivo?.nroBono) {
      return {
        resultado: "aceptado",
        nroBono: objetivo.nroBono,
        detalle: `Relectura tras intento previo: ${objetivo.numero} con bono ${objetivo.nroBono}`,
      };
    }
    return {
      resultado: "incierto",
      nroBono: null,
      detalle: `Hubo un envío de autorización previo con resultado desconocido y la prestación ${prestacionNumeroObjetivo} sigue sin bono — el token NO se reenvía; verificar a mano en Klinicos`,
    };
  }
  return {
    resultado: "incierto",
    nroBono: null,
    detalle: "Hubo un envío de autorización previo con resultado desconocido y no se conoce el número de la prestación objetivo — el token NO se reenvía; verificar a mano en Klinicos",
  };
}

export interface GuardasAutorizacion {
  postYaIntentado: boolean;
  // Número de la prestación creada en un intento anterior (persistido), para
  // que la relectura del reintento evalúe la fila correcta.
  prestacionNumeroPrevio?: string | null;
  marcarPostIntentado: () => Promise<void>;
  marcarResultado: (resultado: "aceptado" | "rechazado" | "incierto", nroBono: string | null) => Promise<void>;
}

// Autoriza con token la ÚNICA prestación CONFIRMADA sin bono (fail-closed).
// Ante un intento previo con resultado desconocido: primero RELEE la grilla
// (manual: "consultar primero el resultado"); si sigue incierto, NUNCA
// reconsume el token.
export async function autorizarPrestacionReal(
  jar: CookieJar,
  atencionId: string,
  token: string,
  guardas: GuardasAutorizacion,
  prestacionNumeroObjetivo: string | null = null,
): Promise<{ ok: boolean; resultado: "aceptado" | "rechazado" | "incierto"; nroBono: string | null; detalle: string }> {
  const detallePath = `/atencion/detalle/atencionesEstados/${atencionId}`;
  const pagina = await jarFetch(jar, detallePath);
  if (pagina.status !== 200) {
    return { ok: false, resultado: "incierto", nroBono: null, detalle: `GET ${detallePath} → ${pagina.status}` };
  }
  // El HTML del detalle NO trae las filas en vivo (la grilla es AJAX):
  // si el parse del HTML da vacío, se relee vía el endpoint DataTables.
  let filas = parsePrestaciones(pagina.text);
  let crudosAjax: Map<string, string> | null = null;
  if (filas.length === 0) {
    const ajax = await leerFilasPrestacionesAjax(jar, atencionId);
    if (ajax.ok) {
      filas = ajax.filas;
      crudosAjax = ajax.crudos;
    }
  }
  const seleccion = elegirPrestacionParaAutorizar(filas);

  // Autorización preexistente (caso Frontini, ago 2026): si la prestación
  // objetivo YA tiene N° de bono (p. ej. quedó FACTURABLE porque se autorizó
  // por fuera de la app), el resultado es ACEPTADO con ese bono — sin enviar
  // el token y sin caer en "revisión manual" por no haber CONFIRMADAS.
  const objetivoConocido = prestacionNumeroObjetivo ?? guardas.prestacionNumeroPrevio ?? null;
  if (objetivoConocido) {
    const yaAutorizada = filas.find((f) => f.numero === objetivoConocido && f.nroBono);
    if (yaAutorizada) {
      const r = {
        ok: true,
        resultado: "aceptado" as const,
        nroBono: yaAutorizada.nroBono,
        detalle: `La prestación ${yaAutorizada.numero} ya está autorizada en Klinicos (${yaAutorizada.estado}, bono ${yaAutorizada.nroBono}) — el token NO se envía`,
      };
      await guardas.marcarResultado(r.resultado, r.nroBono);
      return r;
    }
  }

  if (guardas.postYaIntentado) {
    // Reintento tras un envío con resultado desconocido: la relectura decide,
    // pero SOLO mirando la prestación objetivo de este trabajo (bonos de otras
    // prestaciones —históricas o de consulta— no cuentan).
    const objetivo = prestacionNumeroObjetivo ?? guardas.prestacionNumeroPrevio ?? null;
    const r = resolverReintentoAutorizacion(filas, objetivo);
    await guardas.marcarResultado(r.resultado, r.nroBono);
    return { ok: r.resultado === "aceptado", ...r };
  }

  if (!seleccion.ok) {
    return { ok: false, resultado: "incierto", nroBono: null, detalle: seleccion.motivo };
  }

  // Endpoint de autorización: se descubre de la propia página (calibración en
  // vivo). Si no aparece, se aborta SIN consumir el token.
  const endpoint = descubrirEndpoint(pagina.text, /autoriza/i);
  if (!endpoint) {
    return {
      ok: false,
      resultado: "incierto",
      nroBono: null,
      detalle: `Calibración pendiente: no se descubrió el endpoint de autorización en ${detallePath} — el token NO se consumió; autorizar a mano o calibrar`,
    };
  }
  // Id interno de la fila: atributo data-* o value cercano al número de
  // prestación. Si las filas vinieron de la grilla AJAX, el id se busca en el
  // crudo de ESA fila (el HTML del detalle no las trae).
  const crudoFila = crudosAjax?.get(seleccion.fila.numero);
  let contexto: string;
  if (crudoFila) {
    contexto = crudoFila.replace(/\\u003c/gi, "<").replace(/\\u003e/gi, ">").replace(/\\"/g, '"').replace(/\\\//g, "/");
  } else {
    const idxFila = pagina.text.indexOf(seleccion.fila.numero);
    contexto = pagina.text.slice(Math.max(0, idxFila - 800), idxFila + 800);
  }
  const filaId =
    // Formato REAL de la grilla AJAX (calibrado 02/08/2026): el id interno de
    // la fila viene como campo JSON "Id" (ej. {"Id":3312058,...}).
    crudoFila?.match(/"Id"\s*:\s*(\d+)/)?.[1] ??
    contexto.match(/data-(?:id|orden|prestacion)[^=]*="(\d+)"/i)?.[1] ??
    contexto.match(/value="(\d{4,})"/)?.[1] ??
    null;
  if (!filaId) {
    return {
      ok: false,
      resultado: "incierto",
      nroBono: null,
      detalle: `Calibración pendiente: no se pudo identificar el id interno de la prestación ${seleccion.fila.numero} — el token NO se consumió`,
    };
  }

  await guardas.marcarPostIntentado();
  // Réplica EXACTA del navegador (calibrado 02/08/2026 leyendo el JS de la
  // página, función ValidarTokenAjax): es un GET con querystring
  // ?idOrdenPrestacion=<id de fila>&token=<token>. El intento anterior con
  // POST {id, OSToken} provocaba un 500 en Klinicos ANTES de llegar a IOMA.
  const sep = endpoint.includes("?") ? "&" : "?";
  const post = await jarFetch(
    jar,
    `${endpoint}${sep}${new URLSearchParams({ idOrdenPrestacion: filaId, token: token.trim() }).toString()}`,
    {
      referer: `${(process.env.KLINICOS_BASE_URL ?? "https://klinicos.aceapp.ar").replace(/\/$/, "")}${detallePath}`,
      xhr: true,
    },
  );
  const sanitizar = (s: string) => s.replace(new RegExp(token.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"), "••••").slice(0, 300);
  if (post.status !== 200 && !(post.status >= 300 && post.status < 400)) {
    const r = {
      ok: false,
      resultado: "incierto" as const,
      nroBono: null,
      detalle: `Autorización → HTTP ${post.status}: resultado desconocido, NO reintentar (verificar a mano). Respuesta: ${sanitizar(post.text) || "(vacía)"}`,
    };
    await guardas.marcarResultado(r.resultado, null);
    return r;
  }
  // Interpretación de la respuesta como lo hace el navegador: {error, message,
  // data} donde data es un JSON string con IsSuccessStatus/Mensaje/CodigoMensaje.
  // Solo un IsSuccessStatus === false es un RECHAZO EXPLÍCITO del financiador.
  let rechazoExplicito: string | null = null;
  let respuestaIoma = "";
  try {
    const j = JSON.parse(post.text) as { error?: boolean; errorCode?: string; message?: string; data?: string };
    const data = j.data ? (JSON.parse(j.data) as { IsSuccessStatus?: boolean; Mensaje?: string; CodigoMensaje?: string }) : null;
    respuestaIoma = sanitizar([j.message, data?.Mensaje].filter(Boolean).join(" · "));
    if (data && data.IsSuccessStatus === false) rechazoExplicito = data.Mensaje ?? "rechazo sin mensaje";
  } catch {
    respuestaIoma = sanitizar(post.text);
  }

  // Releer y exigir N° de bono (regla del manual). Misma consideración: en
  // vivo la relectura confiable va contra la grilla AJAX.
  const relectura = await listarPrestacionesAtencion(jar, detallePath);
  let filasRelectura = relectura.filas;
  if (filasRelectura.length === 0) {
    const ajax = await leerFilasPrestacionesAjax(jar, atencionId);
    if (ajax.ok) filasRelectura = ajax.filas;
  }
  const veredicto = resultadoAutorizacionDesdeRelectura(filasRelectura, seleccion.fila.numero);
  // El rechazo explícito del financiador (IsSuccessStatus=false) prevalece
  // sobre una relectura incierta; nunca pisa un "aceptado" con bono.
  if (rechazoExplicito && veredicto.resultado !== "aceptado") {
    const r = { ok: false, resultado: "rechazado" as const, nroBono: null, detalle: `IOMA rechazó el token: ${sanitizar(rechazoExplicito)}` };
    await guardas.marcarResultado(r.resultado, null);
    return r;
  }
  await guardas.marcarResultado(veredicto.resultado, veredicto.nroBono);
  const detalleFinal = respuestaIoma ? `${veredicto.detalle} · Respuesta Klinicos: ${respuestaIoma}` : veredicto.detalle;
  return { ok: veredicto.resultado === "aceptado", ...veredicto, detalle: detalleFinal };
}

// ── Prestación de CONSULTA (tipo 1) — sector CONSULTORIOS ──────────────────
// Verificado en la primera carga real (Frontini, ago 2026): en CONSULTORIOS el
// ingreso ambulatorio NO crea el bono de consulta solo (la grilla de la
// atención quedó vacía) — quedaba "a mano". El form
// /ordenPrestacion/create/{idAtencionACobrar}/1 viene PRECARGADO (item 420101
// CONSULTA MEDICA, cantidad 1), así que el robot lo postea tal cual, con el
// diagnóstico CIE-10 si lo tiene.
//
// Detalles calibrados en vivo (01-02/08/2026, solo lectura):
//  - El create usa el id NUMÉRICO IdAtencionACobrar (ej. 2866026), no el GUID
//    de la atención: se resuelve del atributo data-idAtencionACobrar del
//    detalle de la atención.
//  - La grilla de prestaciones del detalle se carga por AJAX
//    (POST /ordenPrestacion/porIdAtencionesEstados, DataTables server-side,
//    columns[0].search.value = GUID): el HTML de la página NO trae filas, así
//    que la relectura de confirmación va contra ese endpoint.

// Resuelve el id numérico IdAtencionACobrar a partir del GUID de la atención.
export async function resolverIdAtencionACobrar(
  jar: CookieJar,
  atencionId: string,
): Promise<{ id: string | null; detalle: string }> {
  if (/^\d+$/.test(atencionId)) return { id: atencionId, detalle: `id numérico directo (${atencionId})` };
  const res = await jarFetch(jar, `/atencion/detalle/atencionesEstados/${atencionId}`);
  if (res.status !== 200) return { id: null, detalle: `GET detalle de atención → ${res.status}` };
  const id = res.text.match(/data-idAtencionACobrar="(\d+)"/i)?.[1] ?? null;
  return { id, detalle: id ? `IdAtencionACobrar ${id}` : "el detalle de la atención no expone data-idAtencionACobrar (calibración pendiente)" };
}

// Parsea UNA fila cruda de la grilla AJAX (JSON.stringify de la row de
// DataTables, que trae HTML escapado) al mismo shape que parsePrestaciones.
// Puro para poder testearlo sin red.
// Fila desde el objeto JSON REAL de porIdAtencionesEstados (calibrado en vivo
// 02/08/2026 con la atención de Frontini): las filas NO traen "C-2026-N" como
// texto; vienen campos separados {Anio, Numero, TipoOrdenPrestacion, EstadoStr,
// OSNroPrestacion, OSNroTransaccion, Id}. El bono real es OSNroPrestacion
// (fallback OSNroTransaccion). Fail-closed: si faltan campos clave → null.
export function filaDesdeObjetoGrilla(r: unknown): PrestacionFila | null {
  if (!r || typeof r !== "object") return null;
  const o = r as Record<string, unknown>;
  const anio = o.Anio != null ? String(o.Anio) : null;
  const numeroCampo = o.Numero != null ? String(o.Numero) : null;
  const tipo = typeof o.TipoOrdenPrestacion === "string" ? o.TipoOrdenPrestacion : null;
  if (!anio || !numeroCampo || !tipo) return null;
  const numero = `${tipo}-${anio}-${numeroCampo}`;
  const estadoCrudo = typeof o.EstadoStr === "string" ? o.EstadoStr : "DESCONOCIDO";
  // El JSON dice "ANULADO"; la grilla HTML decía "ANULADA" — se unifica.
  const estado = normalizar(estadoCrudo) === "ANULADO" ? "ANULADA" : normalizar(estadoCrudo);
  const bonoCrudo = o.OSNroPrestacion ?? o.OSNroTransaccion ?? null;
  const nroBono = bonoCrudo != null && String(bonoCrudo).trim() !== "" ? String(bonoCrudo).trim() : null;
  return { numero, tipo, estado, nroBono };
}

export function filaDesdeTextoCrudo(crudo: string): PrestacionFila | null {
  const html = crudo
    .replace(/\\u003c/gi, "<")
    .replace(/\\u003e/gi, ">")
    .replace(/\\"/g, '"')
    .replace(/\\\//g, "/");
  const numero = html.match(/\b([A-Z]{1,3}-\d{4}-\d+)\b/)?.[1];
  if (!numero) return null;
  const texto = normalizar(html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " "));
  const estado = ESTADOS_CONOCIDOS.find((e) => texto.includes(e)) ?? "DESCONOCIDO";
  const despuesEstado = texto.slice(texto.indexOf(estado) + estado.length);
  const bono = despuesEstado.match(/\b(\d{6,})\b/)?.[1] ?? null;
  return { numero, tipo: numero.split("-")[0] ?? "", estado, nroBono: bono };
}

// Lee la grilla AJAX y devuelve filas parseadas + el crudo de cada una (el
// crudo sirve para extraer el id interno de la fila al autorizar, porque el
// HTML del detalle NO trae las filas — la grilla es 100% AJAX en vivo).
export async function leerFilasPrestacionesAjax(
  jar: CookieJar,
  atencionGuid: string,
): Promise<{ ok: boolean; filas: PrestacionFila[]; crudos: Map<string, string>; detalle: string }> {
  const res = await postGrillaPrestaciones(jar, atencionGuid);
  if (res.status !== 200) return { ok: false, filas: [], crudos: new Map(), detalle: `POST porIdAtencionesEstados → ${res.status}` };
  try {
    const json = JSON.parse(res.text) as { data?: unknown[] };
    const data = Array.isArray(json.data) ? json.data : [];
    const filas: PrestacionFila[] = [];
    const crudos = new Map<string, string>();
    for (const r of data) {
      const crudo = typeof r === "string" ? r : JSON.stringify(r);
      // Primero el formato REAL (objeto con campos); el parser de texto queda
      // solo de respaldo por si el endpoint volviera a devolver HTML crudo.
      const fila = filaDesdeObjetoGrilla(r) ?? filaDesdeTextoCrudo(crudo);
      if (fila) {
        filas.push(fila);
        crudos.set(fila.numero, crudo);
      }
    }
    return { ok: true, filas, crudos, detalle: `${filas.length} fila(s) vía grilla AJAX` };
  } catch {
    return { ok: false, filas: [], crudos: new Map(), detalle: "La respuesta de porIdAtencionesEstados no es JSON (calibración pendiente)" };
  }
}

async function postGrillaPrestaciones(
  jar: CookieJar,
  atencionGuid: string,
): Promise<{ status: number; text: string }> {
  const p = new URLSearchParams();
  p.set("draw", "1");
  p.set("start", "0");
  p.set("length", "100");
  p.set("search[value]", "");
  p.set("search[regex]", "false");
  p.set("columns[0][data]", "0");
  p.set("columns[0][name]", "");
  p.set("columns[0][searchable]", "true");
  p.set("columns[0][orderable]", "false");
  p.set("columns[0][search][value]", atencionGuid);
  p.set("columns[0][search][regex]", "false");
  p.set("order[0][column]", "0");
  p.set("order[0][dir]", "desc");
  return jarFetch(jar, "/ordenPrestacion/porIdAtencionesEstados", {
    method: "POST",
    body: p.toString(),
    contentType: "application/x-www-form-urlencoded; charset=UTF-8",
    xhr: true,
  });
}

// Lee la grilla AJAX de prestaciones de una atención (solo lectura).
export async function leerGrillaPrestaciones(
  jar: CookieJar,
  atencionGuid: string,
): Promise<{ ok: boolean; total: number; numeros: string[]; detalle: string }> {
  const res = await postGrillaPrestaciones(jar, atencionGuid);
  if (res.status !== 200) return { ok: false, total: -1, numeros: [], detalle: `POST porIdAtencionesEstados → ${res.status}` };
  try {
    const json = JSON.parse(res.text) as { recordsTotal?: number; data?: unknown[] };
    const data = Array.isArray(json.data) ? json.data : [];
    // Solo cuentan las prestaciones VIVAS: una ANULADA no es "prestación ya
    // creada" (caso real Frontini 02/08/2026 — la consulta del viernes quedó
    // anulada y el robot no debía darla por cargada).
    const filas = data
      .map((r) => filaDesdeObjetoGrilla(r) ?? filaDesdeTextoCrudo(typeof r === "string" ? r : JSON.stringify(r)))
      .filter((f): f is PrestacionFila => f != null);
    const vivas = filas.filter((f) => f.estado !== "ANULADA");
    const numeros = vivas.map((f) => f.numero);
    const anuladas = filas.length - vivas.length;
    return {
      ok: true,
      total: vivas.length,
      numeros,
      detalle: `${vivas.length} prestación(es) viva(s)${anuladas ? ` (+${anuladas} anulada(s))` : ""}${numeros.length ? `: ${numeros.join(", ")}` : ""}`,
    };
  } catch {
    return { ok: false, total: -1, numeros: [], detalle: "La respuesta de porIdAtencionesEstados no es JSON (calibración pendiente)" };
  }
}

// Elección pura del número nuevo tras el POST: la fila que no estaba antes.
export function elegirNumeroNuevo(antes: string[], despues: string[]): string | null {
  const previos = new Set(antes);
  const nuevos = despues.filter((n) => !previos.has(n));
  // Preferir la consulta (C-) si hay varias filas nuevas.
  return nuevos.find((n) => n.startsWith("C-")) ?? nuevos[0] ?? null;
}

// Crea la prestación de CONSULTA en /ordenPrestacion/create/{id}/1.
// Fail-closed en cada paso, mismas guardas anti doble-POST que la práctica.
export async function crearPrestacionConsultaReal(
  jar: CookieJar,
  atencionGuid: string,
  datos: { cie10Codigo: string | null },
  guardas: GuardasPrestacion,
): Promise<{ ok: boolean; numero: string | null; detalle: string }> {
  if (guardas.prestacionYaCreada) {
    return { ok: true, numero: null, detalle: "La prestación ya se creó en un intento anterior — no se re-envía" };
  }
  if (guardas.postYaIntentado) {
    // Relectura antes de rendirse: si la grilla ya muestra una prestación,
    // el POST anterior en realidad funcionó (klinicosPrestacionCreada debe
    // reflejar la realidad).
    const grilla = await leerGrillaPrestaciones(jar, atencionGuid);
    if (grilla.ok && grilla.total > 0) {
      const numero = grilla.numeros.find((n) => n.startsWith("C-")) ?? grilla.numeros[0] ?? null;
      await guardas.marcarPrestacionCreada(numero);
      return { ok: true, numero, detalle: `El envío previo sí creó la prestación (${grilla.detalle})` };
    }
    return {
      ok: false,
      numero: null,
      detalle: "Hubo un POST de prestación previo con resultado desconocido y la grilla sigue vacía — NO se re-envía (verificar a mano en Klinicos)",
    };
  }

  const resuelto = await resolverIdAtencionACobrar(jar, atencionGuid);
  if (!resuelto.id) {
    return { ok: false, numero: null, detalle: `No se pudo resolver el id de la atención a cobrar: ${resuelto.detalle}` };
  }
  const createPath = `/ordenPrestacion/create/${resuelto.id}/1`;
  const pagina = await jarFetch(jar, createPath);
  if (pagina.status !== 200) {
    return { ok: false, numero: null, detalle: `GET ${createPath} → ${pagina.status}${pagina.location ? ` (${pagina.location})` : ""}` };
  }
  const campos = camposDeForm(pagina.text);
  const nombres = Object.keys(campos);
  if (!nombres.some((n) => /RequestVerificationToken/i.test(n))) {
    return { ok: false, numero: null, detalle: `Calibración pendiente: el form de ${createPath} no trae antiforgery (campos: ${nombres.join(", ") || "ninguno"})` };
  }
  // El form debe venir precargado como Consulta con al menos un ítem (420101
  // CONSULTA MEDICA en la calibración): si no matchea, se aborta ANTES del POST.
  // TipoAfiliado: el desplegable viene sin valor y recepción "no pone nada" —
  // el portal lo completa solo. Calibrado 02/08/2026 leyendo la prestación
  // cargada a mano (edit): quedó guardado "OBL" (OBLIGATORIO). Sin esto el
  // POST vuelve con "The TipoAfiliado field is required".
  if ("TipoAfiliado" in campos && !campos["TipoAfiliado"]) campos["TipoAfiliado"] = "OBL";
  if (!/CONSULTA/i.test(campos["TipoOrdenPrestacionNombre"] ?? "")) {
    return { ok: false, numero: null, detalle: `Calibración pendiente: el form de ${createPath} no es de Consulta (TipoOrdenPrestacionNombre: "${campos["TipoOrdenPrestacionNombre"] ?? "ausente"}")` };
  }
  if (!nombres.some((n) => /^ordenPrestacionItems\[0\]\./.test(n))) {
    return { ok: false, numero: null, detalle: `Calibración pendiente: el form de ${createPath} no trae el ítem de consulta precargado (campos: ${nombres.join(", ")})` };
  }
  // Diagnóstico CIE-10 si lo tenemos (el form de consulta viene con el campo
  // vacío; si el portal lo exige, el rechazo de validación lo va a decir).
  if (datos.cie10Codigo) {
    if ("codigoDiagnostico" in campos) campos["codigoDiagnostico"] = datos.cie10Codigo;
    const campoItemDiag = nombres.find((n) => /^ordenPrestacionItems\[0\]\..*[Dd]iagnostico/.test(n));
    if (campoItemDiag) campos[campoItemDiag] = datos.cie10Codigo;
  }
  const action = accionDelFormPrestacion(pagina.text, createPath);

  // Snapshot de la grilla ANTES del POST (fail-closed: sin snapshot no hay
  // forma segura de confirmar después).
  const antes = await leerGrillaPrestaciones(jar, atencionGuid);
  if (!antes.ok) {
    return { ok: false, numero: null, detalle: `No se pudo leer la grilla de prestaciones antes del POST (${antes.detalle}) — abortado sin enviar` };
  }

  await guardas.marcarPostIntentado();
  const post = await jarFetch(jar, action, {
    method: "POST",
    body: new URLSearchParams(campos).toString(),
    contentType: "application/x-www-form-urlencoded",
    referer: `${(process.env.KLINICOS_BASE_URL ?? "https://klinicos.aceapp.ar").replace(/\/$/, "")}${createPath}`,
  });

  if (post.status === 200) {
    const errores = [...post.text.matchAll(/field-validation-error[^>]*>([^<]+)</g)].map((m) => m[1]!.trim());
    const resumenErr = post.text.match(/validation-summary-errors[\s\S]{0,400}?<li>([^<]+)</)?.[1]?.trim();
    const det = [resumenErr, ...errores].filter(Boolean).join(" | ");
    if (det) {
      await guardas.limpiarPostIntentado?.();
      return { ok: false, numero: null, detalle: `El portal rechazó la prestación de consulta: ${det}` };
    }
  }

  // Confirmación por relectura de la grilla AJAX (vale para redirect y para
  // resultado dudoso): tiene que haber una fila más que antes.
  const despues = await leerGrillaPrestaciones(jar, atencionGuid);
  if (despues.ok && despues.total > antes.total) {
    const numero = elegirNumeroNuevo(antes.numeros, despues.numeros);
    await guardas.marcarPrestacionCreada(numero);
    return { ok: true, numero, detalle: `Prestación de consulta creada${numero ? ` (${numero})` : ""} — la atención pasó de ${antes.total} a ${despues.total} prestación(es)` };
  }
  return {
    ok: false,
    numero: null,
    detalle: `POST prestación de consulta → ${post.status}${post.location ? ` (${post.location})` : ""} pero la relectura no muestra una fila nueva (${despues.detalle}) — verificar a mano en Klinicos ANTES de reintentar`,
  };
}

// ── Lectura en vivo (solo lectura, segura también en simulación) ────────────
// Lee la grilla de prestaciones del detalle de una atención existente.
// No escribe nada: sirve para calibrar la pantalla Autorizar sin cargas reales.
export async function listarPrestacionesAtencion(
  jar: CookieJar,
  atencionPath: string,
): Promise<{ ok: boolean; filas: PrestacionFila[]; detalle: string }> {
  const res = await jarFetch(jar, atencionPath);
  if (res.status !== 200) {
    return { ok: false, filas: [], detalle: `GET ${atencionPath} → ${res.status}` };
  }
  const filas = parsePrestaciones(res.text);
  if (filas.length === 0) {
    return { ok: false, filas: [], detalle: "No se pudo leer la grilla de prestaciones (fail-closed → revisión manual)" };
  }
  return { ok: true, filas, detalle: `${filas.length} prestación(es): ${filas.map((f) => `${f.numero} ${f.estado}`).join("; ")}` };
}

// ── Anular prestación ────────────────────────────────────────────────────────
// Calibrado en vivo (05/08/2026, solo lectura del JS del detalle, función
// AnularPrestacion): POST /ordenPrestacion/anularOrden/{Id de la fila} con
// body form-urlencoded { motivo } (el motivo es OBLIGATORIO para el portal).
// Respuesta JSON {error, message, data} donde data es un JSON string con
// IsSuccessStatus/Mensaje — mismo formato que la autorización.
// Procedimiento manual equivalente: docs/klinicos-flujo-administrativo.md §2.4.1.
// Fail-closed: exige encontrar EXACTAMENTE la prestación objetivo por número,
// y confirma releyendo la grilla hasta verla ANULADA.
export async function anularPrestacionReal(
  jar: CookieJar,
  atencionGuid: string,
  prestacionNumero: string,
  motivo: string,
): Promise<{ ok: boolean; yaAnulada: boolean; detalle: string }> {
  const detallePath = `/atencion/detalle/atencionesEstados/${atencionGuid}`;
  const pagina = await jarFetch(jar, detallePath);
  if (pagina.status !== 200) {
    return { ok: false, yaAnulada: false, detalle: `GET ${detallePath} → ${pagina.status}` };
  }
  const ajax = await leerFilasPrestacionesAjax(jar, atencionGuid);
  if (!ajax.ok) {
    return { ok: false, yaAnulada: false, detalle: `No se pudo leer la grilla de prestaciones: ${ajax.detalle}` };
  }
  const fila = ajax.filas.find((f) => f.numero === prestacionNumero);
  if (!fila) {
    return {
      ok: false,
      yaAnulada: false,
      detalle: `La prestación ${prestacionNumero} no aparece en la atención (${ajax.filas.map((f) => f.numero).join(", ") || "grilla vacía"}) — anular a mano`,
    };
  }
  if (fila.estado === "ANULADA") {
    return { ok: true, yaAnulada: true, detalle: `La prestación ${prestacionNumero} ya estaba ANULADA en Klinicos` };
  }
  const filaId = ajax.crudos.get(prestacionNumero)?.match(/"Id"\s*:\s*(\d+)/)?.[1] ?? null;
  if (!filaId) {
    return { ok: false, yaAnulada: false, detalle: `No se pudo identificar el id interno de ${prestacionNumero} — anular a mano` };
  }

  const post = await jarFetch(jar, `/ordenPrestacion/anularOrden/${filaId}`, {
    method: "POST",
    contentType: "application/x-www-form-urlencoded; charset=UTF-8",
    body: new URLSearchParams({ motivo }).toString(),
    referer: `${(process.env.KLINICOS_BASE_URL ?? "https://klinicos.aceapp.ar").replace(/\/$/, "")}${detallePath}`,
    xhr: true,
  });
  let respuesta = "";
  let rechazo: string | null = null;
  try {
    const j = JSON.parse(post.text) as { error?: boolean; message?: string; data?: string };
    const data = j.data ? (JSON.parse(j.data) as { IsSuccessStatus?: boolean; Mensaje?: string }) : null;
    respuesta = [j.message, data?.Mensaje].filter(Boolean).join(" · ").slice(0, 300);
    if (j.error) rechazo = j.message ?? "error sin mensaje";
    if (data && data.IsSuccessStatus === false) rechazo = data.Mensaje ?? "rechazo sin mensaje";
  } catch {
    respuesta = post.text.slice(0, 300);
  }
  if (post.status !== 200) {
    return { ok: false, yaAnulada: false, detalle: `Anulación → HTTP ${post.status}: resultado desconocido, verificar a mano. Respuesta: ${respuesta || "(vacía)"}` };
  }

  // Confirmación por relectura: la anulación vale solo si la grilla la muestra ANULADA.
  const relectura = await leerFilasPrestacionesAjax(jar, atencionGuid);
  const confirmada = relectura.ok && relectura.filas.some((f) => f.numero === prestacionNumero && f.estado === "ANULADA");
  if (rechazo && !confirmada) {
    return { ok: false, yaAnulada: false, detalle: `Klinicos rechazó la anulación: ${rechazo}` };
  }
  if (!confirmada) {
    return { ok: false, yaAnulada: false, detalle: `El POST de anulación respondió pero la relectura no muestra ${prestacionNumero} como ANULADA — verificar a mano. Respuesta: ${respuesta || "(vacía)"}` };
  }
  return { ok: true, yaAnulada: false, detalle: `Prestación ${prestacionNumero} ANULADA en Klinicos${respuesta ? ` · Respuesta: ${respuesta}` : ""}` };
}
