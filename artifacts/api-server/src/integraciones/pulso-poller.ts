import { logger } from "../lib/logger";
import { pulsoConfigurado } from "./pulso-client";
import { sincronizarPacientesPulso, getEstadoSync } from "./pulso-sync";
import { sincronizarEstudiosPulso, getEstadoEstudiosSync } from "./pulso-estudios-sync";

// ── Poller de pacientes de Pulso ────────────────────────────────────────────
// Pulso es una entrada continua de pacientes de la clínica. Como su API no
// envía webhooks, sondeamos periódicamente e importamos de forma incremental
// (frena al toparse con pacientes ya importados). Arranca solo si hay
// credenciales y no está deshabilitado por env.

const DEFAULT_INTERVALO_MS = 30 * 60 * 1000; // 30 minutos
const DELAY_INICIAL_MS = 20 * 1000; // esperar a que el server esté estable

function intervaloMs(): number {
  const raw = process.env["PULSO_SYNC_MS"]?.trim();
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n >= 60_000 ? n : DEFAULT_INTERVALO_MS;
}

export function iniciarPulsoPoller(): void {
  const log = logger.child({ modulo: "pulso-poller" });

  if (process.env["PULSO_SYNC_ENABLED"]?.trim() === "false") {
    log.info("Pulso poller deshabilitado (PULSO_SYNC_ENABLED=false)");
    return;
  }
  if (!pulsoConfigurado()) {
    log.info("Pulso poller inactivo: faltan credenciales (PULSO_USERNAME/PULSO_PASSWORD)");
    return;
  }

  const intervalo = intervaloMs();
  log.info({ intervaloMs: intervalo }, "Pulso poller activo");

  const correr = async () => {
    if (!getEstadoSync().sincronizando) {
      try {
        await sincronizarPacientesPulso({ full: false, log });
      } catch (err) {
        log.error({ err }, "Pulso: ciclo de sync de pacientes falló");
      }
    } else {
      log.debug("Pulso: sync de pacientes aún en curso, se omite este ciclo");
    }

    // Los estudios se sincronizan después de los pacientes para poder vincular
    // los estudios nuevos con pacientes recién importados.
    if (!getEstadoEstudiosSync().sincronizando) {
      try {
        await sincronizarEstudiosPulso({ full: false, log });
      } catch (err) {
        log.error({ err }, "Pulso: ciclo de sync de estudios falló");
      }
    } else {
      log.debug("Pulso: sync de estudios aún en curso, se omite este ciclo");
    }
  };

  const primer = setTimeout(() => {
    void correr();
  }, DELAY_INICIAL_MS);
  primer.unref();

  const timer = setInterval(() => {
    void correr();
  }, intervalo);
  timer.unref();
}
