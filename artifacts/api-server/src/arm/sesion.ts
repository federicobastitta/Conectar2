// ARM v2 — Módulo 1: Sesión Klinicos
// Alcance: SOLO iniciar/verificar sesión (incluida la selección de contexto
// establecimiento/sector/puesto que el portal exige post-login). No busca
// pacientes, no crea consultas, no toca datos.
//
// Estados de salida (contrato aprobado por el usuario, ago 2026):
//   SESSION_ACTIVE      — la sesión previa sigue viva; no se reloguea
//   LOGIN_SUCCESS       — login + contexto OK (redirección + cookie de sesión)
//   INVALID_CREDENTIALS — el portal rechazó usuario/contraseña (definitivo)
//   TECHNICAL_ERROR     — Klinicos no responde / error de servidor / timeout
//   MANUAL_REVIEW       — pantalla o respuesta no reconocida (CAPTCHA, 2FA,
//                         form sin los campos esperados): detenerse sin reintentar
//
// Reglas duras: credenciales SOLO de env (KLINICOS_USUARIO/PASSWORD); jamás en
// logs. Sin esperas rígidas: cada paso se decide por la respuesta del servidor.

import {
  CookieJar,
  jarFetch,
  loginKlinicos,
  seleccionarContextoKlinicos,
  klinicosHabilitado,
} from "../integraciones/klinicos-robot";

export type EstadoSesion =
  | "SESSION_ACTIVE"
  | "LOGIN_SUCCESS"
  | "INVALID_CREDENTIALS"
  | "TECHNICAL_ERROR"
  | "MANUAL_REVIEW";

export interface ResultadoSesion {
  estado: EstadoSesion;
  /** Detalle técnico legible; NUNCA incluye credenciales ni cookies. */
  detalle: string;
  /** Jar con la sesión lista para los módulos siguientes (solo si ACTIVE/SUCCESS). */
  jar: CookieJar | null;
}

export type EstadoVerificacion = "SESSION_ACTIVE" | "SESSION_EXPIRED" | "TECHNICAL_ERROR" | "MANUAL_REVIEW";

// Verificación de sesión por CONTENIDO de pantalla (aprobado ago 2026):
// - SESSION_ACTIVE  → aparece el enlace "Cerrar sesión" (href /Login/Logout),
//   exclusivo del área interna autenticada.
// - SESSION_EXPIRED → aparece el formulario de acceso (UserName + Password).
//   El portal NO muestra aviso de "sesión vencida": vuelve al form, y esa es
//   la única señal (verificado en vivo — la página fría redirige
//   /GestionTurnos/ListadoTurnos → /inicio → /Login).
// - Nunca se decide por URL ni por cookies. Solo lectura, no modifica datos.
export async function verificarSesionKlinicos(jar: CookieJar): Promise<{ estado: EstadoVerificacion; detalle: string }> {
  let res: { status: number; location: string | null; text: string };
  try {
    res = await jarFetch(jar, "/GestionTurnos/ListadoTurnos");
    // Seguir la cadena de redirecciones hasta una página con contenido.
    for (let i = 0; i < 5 && res.status >= 300 && res.status < 400 && res.location; i++) {
      res = await jarFetch(jar, res.location.replace(/^https?:\/\/[^/]+/, ""));
    }
  } catch (e) {
    return { estado: "TECHNICAL_ERROR", detalle: `Klinicos no respondió: ${e instanceof Error ? e.message : String(e)}` };
  }
  if (res.status >= 500) return { estado: "TECHNICAL_ERROR", detalle: `Klinicos devolvió error de servidor (${res.status})` };
  if (res.status !== 200) return { estado: "MANUAL_REVIEW", detalle: `Respuesta inesperada (${res.status}) — no coincide con sesión activa ni con la pantalla de acceso` };

  const hayLogout = /href="\/Login\/Logout"/i.test(res.text);
  const hayFormAcceso = /name="UserName"/i.test(res.text) && /name="Password"/i.test(res.text);
  if (hayLogout && !hayFormAcceso) return { estado: "SESSION_ACTIVE", detalle: 'Área interna visible (enlace "Cerrar sesión" presente)' };
  if (hayFormAcceso && !hayLogout) return { estado: "SESSION_EXPIRED", detalle: "Apareció el formulario de acceso (Usuario/Contraseña)" };
  return { estado: "MANUAL_REVIEW", detalle: "La pantalla no coincide claramente con el área interna ni con el formulario de acceso" };
}

async function sesionViva(jar: CookieJar): Promise<boolean> {
  return (await verificarSesionKlinicos(jar)).estado === "SESSION_ACTIVE";
}

export async function iniciarSesionKlinicos(jarPrevio?: CookieJar | null): Promise<ResultadoSesion> {
  if (!klinicosHabilitado()) {
    return { estado: "TECHNICAL_ERROR", detalle: "Faltan credenciales en el entorno (KLINICOS_USUARIO/KLINICOS_PASSWORD)", jar: null };
  }

  // Idempotencia: si ya hay una sesión previa viva, no se reloguea.
  if (jarPrevio && (await sesionViva(jarPrevio))) {
    return { estado: "SESSION_ACTIVE", detalle: "La sesión previa sigue activa — no se reloguea", jar: jarPrevio };
  }

  const jar = new CookieJar();
  let login: { ok: boolean; detalle: string };
  try {
    login = await loginKlinicos(jar);
  } catch (e) {
    return { estado: "TECHNICAL_ERROR", detalle: `Klinicos no respondió al login: ${e instanceof Error ? e.message : String(e)}`, jar: null };
  }

  if (!login.ok) {
    // Rechazo EXPLÍCITO de credenciales → INVALID_CREDENTIALS (definitivo).
    if (/rechaz[oó] las credenciales|incorrecta/i.test(login.detalle)) {
      return { estado: "INVALID_CREDENTIALS", detalle: "El portal rechazó las credenciales", jar: null };
    }
    // 5xx / timeouts / sin respuesta → TECHNICAL_ERROR.
    if (/→ 5\d\d|timeout|ECONN|fetch failed/i.test(login.detalle)) {
      return { estado: "TECHNICAL_ERROR", detalle: `Klinicos no responde: ${login.detalle}`, jar: null };
    }
    // Cualquier otra cosa (página sin campos esperados, respuesta rara,
    // posible CAPTCHA/2FA/pantalla nueva) → detenerse.
    return { estado: "MANUAL_REVIEW", detalle: `Respuesta no reconocida en el login: ${login.detalle}`, jar: null };
  }

  // Post-login el portal exige elegir establecimiento/sector/puesto: sin eso
  // la sesión no opera. Forma parte del módulo de sesión (aprobado ago 2026).
  let contexto: { ok: boolean; detalle: string };
  try {
    contexto = await seleccionarContextoKlinicos(jar);
  } catch (e) {
    return { estado: "TECHNICAL_ERROR", detalle: `Klinicos no respondió al seleccionar contexto: ${e instanceof Error ? e.message : String(e)}`, jar: null };
  }
  if (!contexto.ok) {
    return { estado: "MANUAL_REVIEW", detalle: `Login OK pero la selección de contexto no se reconoció: ${contexto.detalle}`, jar: null };
  }

  // Verificación final inequívoca: una página interna responde con sesión.
  if (!(await sesionViva(jar))) {
    return { estado: "MANUAL_REVIEW", detalle: "Login y contexto respondieron OK pero la verificación final de sesión falló", jar: null };
  }

  return { estado: "LOGIN_SUCCESS", detalle: "Sesión iniciada y contexto seleccionado (verificado contra una página interna)", jar };
}
