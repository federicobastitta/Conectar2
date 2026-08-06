// URL pública de la app web (para links de verificación en QR, etc.).
// En producción REPLIT_DOMAINS trae el dominio publicado; se puede forzar
// con URL_PUBLICA_APP si hiciera falta.
// Base del link de ingreso mágico que viaja por WhatsApp: apunta a la app del
// paciente (Mi Diagnosticar, proyecto aparte — misma URL del push de
// certificados). Si no está configurada, cae a la URL pública de esta app.
export function urlBaseLinkIngreso(): string {
  const portal = process.env.APP_PACIENTE_PUSH_URL?.trim();
  if (portal) {
    try {
      return new URL(portal).origin;
    } catch {
      // URL malformada: seguir con el fallback local.
    }
  }
  return urlPublicaApp();
}

export function urlPublicaApp(): string {
  const forzada = process.env.URL_PUBLICA_APP?.trim();
  if (forzada) return forzada.replace(/\/$/, "");
  const dominio = (process.env.REPLIT_DOMAINS ?? "").split(",")[0]?.trim();
  return dominio ? `https://${dominio}` : "";
}
