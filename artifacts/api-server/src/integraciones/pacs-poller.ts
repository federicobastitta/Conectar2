import { logger } from "../lib/logger";
import { dicomPacsConfigurado } from "./diagnostipacs-api";
import { procesarTurnosEsperandoInforme } from "./pacs-flujo";

// ── Robot de sondeo de DiagnostiPACS ───────────────────────────────────────
// Cada N minutos revisa si los turnos que esperan informe (pendiente_informe /
// informando, ya enviados al PACS) tienen su estudio informado en el PACS y,
// si es así, cierra el circuito (informado/publicado/WhatsApp según turnera).
// Complemento del webhook POST /api/pacs/webhook/estudio-informado, que hace
// lo mismo pero al instante cuando el PACS avisa.

const INTERVALO_MS = Number(process.env.PACS_POLL_MS ?? 120_000); // 2 min
const HORA_INICIO = Number(process.env.PACS_POLL_HORA_INICIO ?? 7); // 07 hs
const HORA_FIN = Number(process.env.PACS_POLL_HORA_FIN ?? 24); // hasta 24 hs
const TIMEZONE = process.env.PACS_TZ ?? "America/Argentina/Buenos_Aires";

let corriendo = false;

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
  if (corriendo) return;
  corriendo = true;
  try {
    const procesados = await procesarTurnosEsperandoInforme(logger);
    if (procesados > 0) {
      logger.info({ procesados }, "PACS robot: turnos informados en este ciclo");
    }
  } catch (err) {
    logger.error({ err }, "PACS robot: error en el ciclo de sondeo");
  } finally {
    corriendo = false;
  }
}

export function iniciarPacsPoller(): void {
  const habilitado = (process.env.PACS_POLLER_ENABLED ?? "true").toLowerCase() !== "false";
  if (!habilitado) {
    logger.info("PACS robot: deshabilitado por PACS_POLLER_ENABLED=false");
    return;
  }
  if (!dicomPacsConfigurado()) {
    logger.info("PACS robot: sin PACS_API_TOKEN, no se inicia");
    return;
  }

  logger.info(
    { intervaloMs: INTERVALO_MS, horaInicio: HORA_INICIO, horaFin: HORA_FIN, timezone: TIMEZONE },
    "PACS robot: iniciado",
  );

  const tick = () => {
    if (enVentana()) void ejecutarCiclo();
  };

  // Primer disparo a los 20s, luego cada intervalo.
  setTimeout(tick, 20_000);
  const timer = setInterval(tick, INTERVALO_MS);
  timer.unref?.();
}
