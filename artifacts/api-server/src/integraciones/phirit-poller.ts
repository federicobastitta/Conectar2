import { and, eq, isNotNull, isNull } from "drizzle-orm";
import { db, estudiosExternosTable } from "@workspace/db";
import { logger } from "../lib/logger";
import { ObjectStorageService } from "../lib/objectStorage";
import { procesarEstudioPhirit, type PhiritActor } from "../routes/integraciones_phirit";
import { fetchEstudios, fetchDniDesdeDetalle, descargarPdfInforme } from "./phirit-scraper";

// ── Robot de sondeo de Phir-it ─────────────────────────────────────────────
// Cada N minutos, dentro de una ventana horaria, entra al portal de Phir-it,
// lista los estudios y, por cada estudio en estado "Informado" que todavía no
// notificamos, llama a procesarEstudioPhirit (que dispara el WhatsApp una sola
// vez por estudio). El estado se lee de la lista (barato); el detalle solo se
// consulta si falta el DNI. El dedupe vive en la DB (notificado_en).

const ACTOR: PhiritActor = { id: null, email: "phirit-robot", rol: "sistema" };

const INTERVALO_MS = Number(process.env.PHIRIT_POLL_MS ?? 120_000); // 2 min
const HORA_INICIO = Number(process.env.PHIRIT_POLL_HORA_INICIO ?? 8); // 08 hs
const HORA_FIN = Number(process.env.PHIRIT_POLL_HORA_FIN ?? 24); // hasta 24 hs
const TIMEZONE = process.env.PHIRIT_TZ ?? "America/Argentina/Buenos_Aires";

// IDs cuyo paciente no existe en Conectar: los recordamos en memoria para no
// re-consultar su detalle en cada ciclo (se reintenta al reiniciar el server).
// Cap acotado con evicción FIFO para que no crezca sin límite en procesos de
// larga vida (Set preserva orden de inserción).
const SIN_PACIENTE_MAX = 5000;
const sinPaciente = new Set<string>();
function recordarSinPaciente(externalId: string): void {
  sinPaciente.add(externalId);
  if (sinPaciente.size > SIN_PACIENTE_MAX) {
    const masViejo = sinPaciente.values().next().value;
    if (masViejo !== undefined) sinPaciente.delete(masViejo);
  }
}
let corriendo = false;

// Enmascara el DNI para no dejar PII completa en los logs (deja los últimos 3).
function maskDni(dni: string): string {
  return dni.length <= 3 ? "***" : `***${dni.slice(-3)}`;
}

function horaLocal(): number {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: TIMEZONE,
    hour: "numeric",
    hour12: false,
  });
  return Number(fmt.format(new Date()));
}

function enVentana(): boolean {
  const h = horaLocal();
  return h >= HORA_INICIO && h < HORA_FIN;
}

async function ejecutarCiclo(): Promise<void> {
  if (corriendo) return; // evita solapamiento si un ciclo tarda más que el intervalo
  corriendo = true;
  try {
    const estudios = await fetchEstudios();
    const informados = estudios.filter((e) => e.estado.toLowerCase() === "informado");
    const informadosSinDni = informados.filter((e) => !e.dni).length;
    // Observabilidad: si el markup de Phir-it cambia, el parseo degrada a 0
    // estudios / 0 informados y esto queda visible en los logs por ciclo.
    logger.info(
      { total: estudios.length, informados: informados.length, informadosSinDni },
      "Phir-it robot: lista parseada",
    );
    if (informados.length === 0) return;

    // Ya notificados en la DB: los saltamos sin tocar Phir-it.
    const yaNotificados = new Set(
      (
        await db
          .select({ externalId: estudiosExternosTable.externalId })
          .from(estudiosExternosTable)
          .where(and(eq(estudiosExternosTable.origen, "phirit"), isNotNull(estudiosExternosTable.notificadoEn)))
      ).map((r) => r.externalId),
    );

    let notificados = 0;
    let sinDni = 0;
    for (const estudio of informados) {
      if (yaNotificados.has(estudio.externalId)) continue;
      if (sinPaciente.has(estudio.externalId)) continue;

      let dni = estudio.dni;
      if (!dni) {
        // La lista no trajo el DNI: fallback al detalle.
        dni = await fetchDniDesdeDetalle(estudio.externalId);
      }
      if (!dni) {
        sinDni++;
        logger.warn(
          { externalId: estudio.externalId },
          "Phir-it robot: estudio informado sin DNI resoluble, se omite",
        );
        continue;
      }

      const res = await procesarEstudioPhirit(
        ACTOR,
        {
          externalId: estudio.externalId,
          estado: "informado",
          pacienteDni: dni,
          descripcion: estudio.descripcion,
          informeUrl: estudio.informeUrl,
        },
        logger,
      );

      if (!res.ok) {
        if (res.code === "PACIENTE_NO_ENCONTRADO") {
          recordarSinPaciente(estudio.externalId);
          logger.info(
            { externalId: estudio.externalId, dni: maskDni(dni) },
            "Phir-it robot: paciente no está en Conectar, se omite hasta reinicio",
          );
        } else {
          logger.warn(
            { externalId: estudio.externalId, code: res.code },
            "Phir-it robot: no se pudo procesar el estudio",
          );
        }
        continue;
      }
      if (res.notificacionDisparada) notificados++;
    }

    if (notificados > 0 || sinDni > 0) {
      logger.info(
        { informados: informados.length, notificados, sinDni },
        "Phir-it robot: ciclo completado",
      );
    }

    await descargarPdfsPendientes();
  } catch (err) {
    logger.error({ err }, "Phir-it robot: error en el ciclo de sondeo");
  } finally {
    corriendo = false;
  }
}

// ── Descarga de PDFs de informes a la nube ─────────────────────────────────
// Por cada estudio informado que todavía no tiene su PDF guardado, entra al
// detalle en Phir-it, baja el PDF con la sesión del robot y lo sube al
// almacenamiento privado. Tope por ciclo para no monopolizar el portal.
// Los que fallan (p. ej. detalle sin link al PDF) se reintentan en el próximo
// ciclo; un cap en memoria evita insistir para siempre con los mismos.
const PDF_MAX_POR_CICLO = Number(process.env.PHIRIT_PDF_MAX_POR_CICLO ?? 5);
const PDF_REINTENTOS_MAX = 10;
const intentosPdf = new Map<string, number>();

async function descargarPdfsPendientes(): Promise<void> {
  const pendientes = await db
    .select({
      id: estudiosExternosTable.id,
      externalId: estudiosExternosTable.externalId,
      patientId: estudiosExternosTable.patientId,
    })
    .from(estudiosExternosTable)
    .where(
      and(
        eq(estudiosExternosTable.origen, "phirit"),
        eq(estudiosExternosTable.estado, "informado"),
        isNull(estudiosExternosTable.informePdfPath),
      ),
    )
    .limit(50);
  if (pendientes.length === 0) return;

  const storage = new ObjectStorageService();
  let guardados = 0;
  for (const est of pendientes) {
    if (guardados >= PDF_MAX_POR_CICLO) break;
    const intentos = intentosPdf.get(est.externalId) ?? 0;
    if (intentos >= PDF_REINTENTOS_MAX) continue;

    try {
      const pdf = await descargarPdfInforme(est.externalId);
      if (!pdf) {
        intentosPdf.set(est.externalId, intentos + 1);
        continue;
      }
      const path = await storage.uploadPrivateBuffer(pdf, "application/pdf");
      // Guardado condicional: si otro ciclo/instancia ya lo guardó, no pisamos.
      const [row] = await db
        .update(estudiosExternosTable)
        .set({ informePdfPath: path, informePdfEn: new Date(), updatedAt: new Date() })
        .where(and(eq(estudiosExternosTable.id, est.id), isNull(estudiosExternosTable.informePdfPath)))
        .returning({ id: estudiosExternosTable.id });
      if (row) {
        guardados++;
        intentosPdf.delete(est.externalId);
        logger.info(
          { estudioId: est.id, externalId: est.externalId, bytes: pdf.length },
          "Phir-it robot: PDF del informe guardado en la nube",
        );
      }
    } catch (err) {
      intentosPdf.set(est.externalId, intentos + 1);
      logger.warn(
        { err, externalId: est.externalId },
        "Phir-it robot: error descargando/subiendo PDF del informe",
      );
    }
  }
}

// Arranca el robot. No-op si faltan credenciales o si está deshabilitado por
// env. Se llama una sola vez al levantar el servidor.
export function iniciarPhiritPoller(): void {
  const habilitado = (process.env.PHIRIT_POLLER_ENABLED ?? "true").toLowerCase() !== "false";
  if (!habilitado) {
    logger.info("Phir-it robot: deshabilitado por PHIRIT_POLLER_ENABLED=false");
    return;
  }
  if (!process.env.PHIRIT_USUARIO || !process.env.PHIRIT_PASSWORD) {
    logger.info("Phir-it robot: sin credenciales, no se inicia");
    return;
  }

  logger.info(
    { intervaloMs: INTERVALO_MS, horaInicio: HORA_INICIO, horaFin: HORA_FIN, timezone: TIMEZONE },
    "Phir-it robot: iniciado",
  );

  const tick = () => {
    if (enVentana()) void ejecutarCiclo();
  };

  // Primer disparo a los 15s (deja que el server termine de levantar), luego cada intervalo.
  setTimeout(tick, 15_000);
  const timer = setInterval(tick, INTERVALO_MS);
  timer.unref?.();
}
