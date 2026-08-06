// Validación sincrónica de token IOMA para la guardia virtual:
// Crea un klinicos_trabajo (turnoId=null) con el token pre-seteado,
// ejecuta el pipeline del worker (ingreso + prestación + autorización)
// y espera el bono con un tope de tiempo.
//
// Regla inviolable: NADA se crea en Klinicos ni en turnos antes de tener
// TOKEN_ACCEPTED + bono. Este módulo devuelve solo esos dos estados.

import { eq, sql } from "drizzle-orm";
import { db, klinicosTrabajos } from "@workspace/db";
import { logger } from "./logger";
import { klinicosHabilitado, klinicosDryRun } from "../integraciones/klinicos-robot";
import { procesarTrabajo, ejecutarTrabajoAprobado } from "../integraciones/klinicos-worker";
import { elegirProfesionalIngreso } from "./seed-profesionales-ingreso";

const TOPE_MS = 45_000;
// Especialidad Klinicos según la guardia: adultos = CLINICA MEDICA (flujo
// original); pediátrica = PEDIATRIA (el robot detecta /PEDIATR/ y usa el
// desplegable "PEDIATRIA-LACTANTES" + motivos pediátricos).
const ESPECIALIDAD_POR_GUARDIA: Record<string, string> = {
  clinica: "CLINICA MEDICA",
  pediatrica: "PEDIATRIA",
};

export type ResultadoValidacionGuardia =
  | { ok: true; nroBono: string; trabajoId: number }
  | { ok: false; estado: "DENIED" | "TECHNICAL_ERROR" | "TIMEOUT" | "NO_CONFIGURADO"; mensaje: string; reintentable: boolean };

interface ParamsValidacion {
  pacienteId: number;
  dni: string;
  sexo?: string | null;
  celular?: string | null;
  tokenIoma: string;
  /** "clinica" (default) o "pediatrica" */
  guardia?: "clinica" | "pediatrica";
}

/**
 * Valida el token IOMA para guardia virtual de forma sincrónica.
 * Crea un klinicos_trabajo (sin turnoId), ejecuta el pipeline del worker y
 * espera el bono con tope de 45 s. Solo devuelve ok:true si hay bono real.
 */
export async function validarTokenGuardiaVirtual(
  params: ParamsValidacion,
): Promise<ResultadoValidacionGuardia> {
  if (!klinicosHabilitado()) {
    return {
      ok: false,
      estado: "NO_CONFIGURADO",
      mensaje:
        "El servicio de validación IOMA no está configurado. Comunicate con el centro para completar el trámite de forma presencial.",
      reintentable: false,
    };
  }

  const { pacienteId, dni, sexo, celular, tokenIoma } = params;
  const guardia = params.guardia ?? "clinica";
  const especialidadGuardia = ESPECIALIDAD_POR_GUARDIA[guardia] ?? ESPECIALIDAD_POR_GUARDIA["clinica"]!;
  const token = tokenIoma.replace(/\s+/g, "");
  if (token.length < 4) {
    return {
      ok: false,
      estado: "TECHNICAL_ERROR",
      mensaje: "El token es demasiado corto. Verificá que lo copiaste completo.",
      reintentable: false,
    };
  }

  // Elegir profesional de ingreso (mismo criterio que consultas-espejo)
  const profesional = await elegirProfesionalIngreso(especialidadGuardia).catch((err: unknown) => {
    logger.error({ err }, "guardia-virtual-token: fallo al elegir profesional de ingreso");
    return null;
  });
  if (!profesional) {
    return {
      ok: false,
      estado: "TECHNICAL_ERROR",
      mensaje:
        "No hay médicos activos configurados para la guardia en este momento. Intentá más tarde.",
      reintentable: true,
    };
  }

  // Anti-duplicado atómico: si el mismo paciente+token ya tiene un trabajo
  // no cancelado/error, reutilizarlo (el bono puede ya estar ahí).
  let trabajoId: number;
  {
    const [existente] = await db
      .select({ id: klinicosTrabajos.id, estado: klinicosTrabajos.estado, klinicosNroBono: klinicosTrabajos.klinicosNroBono })
      .from(klinicosTrabajos)
      .where(
        sql`${klinicosTrabajos.pacienteId} = ${pacienteId}
            AND ${klinicosTrabajos.tokenAutorizacion} = ${token}
            AND ${klinicosTrabajos.especialidad} = ${especialidadGuardia}
            AND ${klinicosTrabajos.estado} NOT IN ('cancelado', 'error')
            AND ${klinicosTrabajos.creadoEn} > now() - interval '4 hours'`,
      )
      .limit(1);

    if (existente) {
      if (existente.klinicosNroBono) {
        // Ya tiene bono: devolver directamente
        return { ok: true, nroBono: existente.klinicosNroBono, trabajoId: existente.id };
      }
      trabajoId = existente.id;
    } else {
      // Crear nuevo trabajo (turnoId=null, como consultas-espejo)
      const [nuevo] = await db
        .insert(klinicosTrabajos)
        .values({
          pacienteId,
          turnoId: null,
          dni,
          sexo: sexo ?? null,
          celular: celular ?? null,
          especialidad: especialidadGuardia,
          motivo:
            guardia === "pediatrica"
              ? "Consulta guardia pediátrica (IOMA)"
              : "Consulta guardia virtual (videollamada IOMA)",
          sectorServicio: "CONSULTORIO",
          profesionalKlinicos: profesional,
          tokenAutorizacion: token,
        })
        .returning({ id: klinicosTrabajos.id });
      trabajoId = nuevo.id;
    }
  }

  // Pipeline sincrónico con tope de tiempo
  const tarea = (async () => {
    // Paso 1: simulación / procesamiento
    await procesarTrabajo(trabajoId);

    // Paso 2: si quedó esperando aprobación, auto-aprobamos (igual que en
    // cargarYAutorizarAutomatico en sala_espera.ts)
    if (!klinicosDryRun()) {
      const [t] = await db
        .select({ estado: klinicosTrabajos.estado, klinicosNroBono: klinicosTrabajos.klinicosNroBono })
        .from(klinicosTrabajos)
        .where(eq(klinicosTrabajos.id, trabajoId))
        .limit(1);

      if (t?.klinicosNroBono) return t.klinicosNroBono;

      if (t?.estado === "esperando_aprobacion") {
        const [claim] = await db
          .update(klinicosTrabajos)
          .set({
            estado: "en_proceso",
            aprobadoPor: "guardia virtual (auto)",
            aprobadoEn: new Date(),
          })
          .where(
            sql`${klinicosTrabajos.id} = ${trabajoId}
                AND ${klinicosTrabajos.estado} = 'esperando_aprobacion'`,
          )
          .returning({ id: klinicosTrabajos.id });

        if (claim) {
          await ejecutarTrabajoAprobado(trabajoId);
        }
      }
    }

    // Paso 3: leer resultado final
    const [final] = await db
      .select({
        klinicosNroBono: klinicosTrabajos.klinicosNroBono,
        ultimoError: klinicosTrabajos.ultimoError,
        autorizacionResultado: klinicosTrabajos.autorizacionResultado,
      })
      .from(klinicosTrabajos)
      .where(eq(klinicosTrabajos.id, trabajoId))
      .limit(1);

    return final;
  })();

  const timeout = new Promise<null>((resolve) =>
    setTimeout(() => resolve(null), TOPE_MS).unref?.(),
  );

  let resultado: { klinicosNroBono?: string | null; ultimoError?: string | null; autorizacionResultado?: string | null } | string | null;
  try {
    resultado = await Promise.race([tarea, timeout]);
  } catch (err) {
    logger.warn({ err, trabajoId }, "guardia-virtual-token: pipeline falló");
    resultado = null;
  }

  // Resultado es null → timeout
  if (resultado === null) {
    return {
      ok: false,
      estado: "TIMEOUT",
      mensaje:
        "El servicio de autorización IOMA está tardando. El trámite sigue en proceso: volvé a intentar en unos minutos.",
      reintentable: true,
    };
  }

  // El pipeline devolvió un string cuando encontró el bono antes del final del flujo
  if (typeof resultado === "string") {
    return { ok: true, nroBono: resultado, trabajoId };
  }

  if (resultado.klinicosNroBono) {
    return { ok: true, nroBono: resultado.klinicosNroBono, trabajoId };
  }

  // Rechazo explícito del financiador
  if (resultado.autorizacionResultado === "rechazado") {
    return {
      ok: false,
      estado: "DENIED",
      mensaje:
        "IOMA no autorizó la consulta con este token. Verificá que el token sea del día de hoy y que tu cobertura esté activa.",
      reintentable: false,
    };
  }

  // Error técnico / en proceso
  return {
    ok: false,
    estado: "TECHNICAL_ERROR",
    mensaje:
      resultado.ultimoError ??
      "La autorización no se confirmó todavía. Esperá unos segundos y volvé a intentar.",
    reintentable: true,
  };
}
