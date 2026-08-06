import type pino from "pino";
import { eq } from "drizzle-orm";
import { db, configSistemaTable } from "@workspace/db";

// ── Cliente Whaticket ──────────────────────────────────────────────────────
// Whaticket expone una API REST para enviar mensajes salientes:
//   POST {WHATICKET_API_URL}/messages
//   Authorization: Bearer {WHATICKET_API_TOKEN}
//   { "connectionId": WHATICKET_CONNECTION_UUID,
//     "messages": [{ "number": "5493511234567", "body": "texto", "templateId": "..." }] }
// El canal es WABA (API oficial de Meta): iniciar una conversación exige un
// templateId de plantilla aprobada ("templateId is require when connection
// channel is WABA"). Los errores vienen como JSON {"error": "..."} con 400.
// Si las credenciales no están configuradas, el envío queda en modo
// "simulada": se registra en notificaciones_salientes pero no sale nada.

export type ResultadoEnvioWhaticket =
  | { estado: "enviada" }
  | { estado: "simulada" }
  | { estado: "fallida"; error: string };

export function whaticketConfigurado(): boolean {
  return Boolean(
    process.env.WHATICKET_API_URL &&
      process.env.WHATICKET_API_TOKEN &&
      process.env.WHATICKET_CONNECTION_UUID,
  );
}

// ── Plantillas aprobadas por Meta (config_sistema, editable sin redeploy) ──
export const CLAVE_WHATICKET_TEMPLATE_ID = "whaticket_template_id";
// Segunda plantilla aprobada: incluye una variable {{1}} con el link de
// ingreso mágico a Mi Diagnosticar (autologin del paciente).
export const CLAVE_WHATICKET_TEMPLATE_LINK_ID = "whaticket_template_link_id";

async function obtenerConfig(clave: string): Promise<string | null> {
  const [row] = await db
    .select({ valor: configSistemaTable.valor })
    .from(configSistemaTable)
    .where(eq(configSistemaTable.clave, clave))
    .limit(1);
  return row?.valor?.trim() || null;
}

async function guardarConfig(clave: string, valor: string): Promise<void> {
  await db
    .insert(configSistemaTable)
    .values({ clave, valor: valor.trim(), actualizadoEn: new Date() })
    .onConflictDoUpdate({
      target: configSistemaTable.clave,
      set: { valor: valor.trim(), actualizadoEn: new Date() },
    });
}

/** templateId de la plantilla aprobada: config_sistema, con fallback a env. */
export async function obtenerTemplateIdAprobado(): Promise<string | null> {
  return (await obtenerConfig(CLAVE_WHATICKET_TEMPLATE_ID)) ?? (process.env.WHATICKET_TEMPLATE_ID?.trim() || null);
}

export async function guardarTemplateIdAprobado(templateId: string): Promise<void> {
  await guardarConfig(CLAVE_WHATICKET_TEMPLATE_ID, templateId);
}

/** templateId de la plantilla aprobada CON variable de link de ingreso ({{1}}). */
export async function obtenerTemplateIdLink(): Promise<string | null> {
  return (await obtenerConfig(CLAVE_WHATICKET_TEMPLATE_LINK_ID)) ?? (process.env.WHATICKET_TEMPLATE_LINK_ID?.trim() || null);
}

export async function guardarTemplateIdLink(templateId: string): Promise<void> {
  await guardarConfig(CLAVE_WHATICKET_TEMPLATE_LINK_ID, templateId);
}

/** Normaliza un teléfono argentino a dígitos con prefijo país (54). */
export function normalizarTelefonoWhatsapp(telefono: string): string | null {
  const digitos = telefono.replace(/\D/g, "");
  if (digitos.length < 8) return null;
  if (digitos.startsWith("54")) return digitos;
  if (digitos.startsWith("0")) return `54${digitos.slice(1)}`;
  return `54${digitos}`;
}

/** Enmascara un número para logs: nunca loguear el número completo. */
export function enmascararNumero(numero: string): string {
  return numero.length <= 4 ? "****" : `****${numero.slice(-4)}`;
}

/** Extrae el mensaje de error de una respuesta de la API de Whaticket. */
export function extraerErrorWhaticket(texto: string, status: number): string {
  try {
    const json: unknown = JSON.parse(texto);
    if (json && typeof json === "object" && "error" in json) {
      const detalle = (json as { error: unknown }).error;
      if (typeof detalle === "string" && detalle.trim()) {
        return `Whaticket rechazó el envío: ${detalle.trim()}`;
      }
    }
  } catch {
    // no era JSON: caemos al mensaje genérico
  }
  return `Whaticket respondió ${status}`;
}

// Plantilla de Meta aprobada para cancelación de turnos/estudios.
// Se envía como referencia junto al mensaje cuando Whaticket usa la API oficial.
export const PLANTILLA_META_CANCELACION_ID =
  process.env.WHATICKET_PLANTILLA_CANCELACION_ID ?? "44f9f9dd-c9fc-4719-9251-3bb80d4fd30a";

export async function enviarWhatsappWhaticket(
  telefono: string,
  mensaje: string,
  log: pino.Logger,
  opciones?: { templateId?: string; variables?: string[] },
): Promise<ResultadoEnvioWhaticket> {
  if (!whaticketConfigurado()) return { estado: "simulada" };

  const numero = normalizarTelefonoWhatsapp(telefono);
  if (!numero) return { estado: "fallida", error: "Teléfono inválido para WhatsApp" };

  const base = (process.env.WHATICKET_API_URL ?? "").replace(/\/+$/, "");
  try {
    const res = await fetch(`${base}/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.WHATICKET_API_TOKEN}`,
      },
      body: JSON.stringify({
        connectionId: process.env.WHATICKET_CONNECTION_UUID,
        // Verificado contra la API en vivo: el templateId va en el NIVEL
        // SUPERIOR del payload, no dentro de cada mensaje (ahí lo ignora y
        // responde "templateId is require when connection channel is WABA").
        ...(opciones?.templateId ? { templateId: opciones.templateId } : {}),
        // Verificado contra la API en vivo (ago 2026): las variables de la
        // plantilla van como ARRAY dentro de cada mensaje ("variables") y la
        // cantidad debe coincidir exactamente con las definidas en la
        // plantilla, si no responde 400 "The number of variables (N) must
        // match the template definition (M)".
        messages: [
          {
            number: numero,
            body: mensaje,
            ...(opciones?.variables?.length ? { variables: opciones.variables } : {}),
          },
        ],
      }),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) {
      const texto = (await res.text().catch(() => "")).slice(0, 500);
      const error = extraerErrorWhaticket(texto, res.status);
      log.warn(
        { status: res.status, destinatario: enmascararNumero(numero), conPlantilla: Boolean(opciones?.templateId) },
        "whaticket: envío rechazado",
      );
      return { estado: "fallida", error };
    }
    log.info(
      { destinatario: enmascararNumero(numero), conPlantilla: Boolean(opciones?.templateId) },
      "whaticket: mensaje enviado",
    );
    return { estado: "enviada" };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn({ err: msg }, "whaticket: error de conexión");
    return { estado: "fallida", error: `No se pudo conectar con Whaticket: ${msg}` };
  }
}

// ── Plantillas con variables ───────────────────────────────────────────────
export const PLANTILLA_CANCELACION_DEFAULT =
  "Hola {nombre}! Te escribimos de {clinica}. Lamentamos informarte que tu turno de {turnera} del {fecha} a las {hora} hs fue cancelado{motivo}. " +
  "Para reprogramarlo entrá a https://turno-facil.replit.app/ y elegí un nuevo horario. Disculpá las molestias.";

export const PLANTILLA_REPROGRAMACION_DEFAULT =
  "Hola {nombre}! Te escribimos de {clinica}. Tu turno de {turnera} fue reprogramado{motivo}: " +
  "pasa del {fechaAnterior} a las {horaAnterior} hs al {fecha} a las {hora} hs, en {sede}. " +
  "Si el nuevo horario no te sirve, respondé este WhatsApp y lo acomodamos.";

// Plantilla de Meta aprobada para avisar que hay un documento nuevo en la app.
export const PLANTILLA_META_DOCUMENTO_APP_ID: string | undefined =
  process.env.WHATICKET_PLANTILLA_DOCUMENTO_APP_ID;

export const PLANTILLA_DOCUMENTO_APP_DEFAULT =
  "Hola {nombre}! Te escribimos de {clinica}. {profesional} te envió {documento} a través de la app Mi Diagnosticar. " +
  "Si todavía no tenés la app, descargala e ingresá acá: {link}. " +
  "Ahí vas a encontrar tus recetas y certificados siempre disponibles.";

export function renderPlantilla(plantilla: string, variables: Record<string, string>): string {
  return plantilla.replace(/\{(\w+)\}/g, (_, clave: string) => variables[clave] ?? `{${clave}}`);
}
