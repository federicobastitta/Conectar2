import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import app from "./app";
import { logger } from "./lib/logger";
import { iniciarPhiritPoller } from "./integraciones/phirit-poller";
import { iniciarPulsoPoller } from "./integraciones/pulso-poller";
import { iniciarPacsPoller } from "./integraciones/pacs-poller";
import { iniciarKlinicosWorker } from "./integraciones/klinicos-worker";
import { iniciarPacsWorklistWorker } from "./integraciones/pacs-worklist";
import { iniciarRobotOrdenesWorker } from "./integraciones/robot-ordenes";
import { iniciarCertificadosAppWorker } from "./integraciones/app-paciente-certificados";
import { iniciarVideollamadasAppWorker } from "./integraciones/app-paciente-videollamadas";
import { iniciarAvisosTurnosWorker } from "./integraciones/app-paciente-turnos";
import { iniciarIndicacionesAppWorker } from "./integraciones/app-paciente-indicaciones";
import { initClinicaDBIfConfigured } from "./integraciones/clinica-db-init";
import { migrarKlinicosConsultasProcesos, migrarRobotOrdenesEnvios, migrarCertificadosAppEnvios, migrarIndicacionesPaciente, migrarDerivacionesTrazabilidad, migrarValoracionesAtencion, migrarSalasLlamado, migrarFirmaOrdenes, migrarGuardiaVirtual } from "./lib/migraciones";
import { iniciarValoracionesAppWorker } from "./integraciones/app-paciente-valoraciones";
import { iniciarBackupDbWorker } from "./integraciones/backup-db";
import { migrarRobotTurnosEventos } from "./lib/robot-turnos-eventos";
import { migrarTurnoPracticas } from "./lib/turno-practicas";
import { seedPlanillaConectar } from "./lib/seed-planilla-conectar";
import { seedReglasCie10 } from "./lib/seed-reglas-cie10";
import { sincronizarEsquemaAlArrancar } from "./lib/esquema-drift";
import { migrarNumeroHcIgualDni } from "./lib/migrar-numero-hc-dni";
import { asegurarUsuariosPorDefecto } from "./routes/usuarios";
import {
  sembrarCodigosEnvioConectar,
  sembrarEspecialidadImagenesTurneras,
} from "./lib/seed-codigos-conectar";
import { seedEspecialidadesAlPacs } from "./lib/seed-especialidades-pacs";

// Bootstrap idempotente de extensiones de DB requeridas (búsqueda sin acentos)
db.execute(sql`CREATE EXTENSION IF NOT EXISTS unaccent`).catch((err: unknown) => {
  logger.error({ err }, "No se pudo crear la extensión unaccent");
});

// Sincronización aditiva del esquema Drizzle contra la base conectada.
// Crítico en prod AWS (conectar_app_prod): el publish NO sincroniza esa base,
// así que las columnas/tablas nuevas se agregan acá al arrancar (idempotente).
sincronizarEsquemaAlArrancar()
  .then(() => sembrarCodigosEnvioConectar())
  .then(() => sembrarEspecialidadImagenesTurneras())
  .then(() => seedEspecialidadesAlPacs())
  // Después del drift: la tabla klinicos_profesionales_ingreso puede ser nueva
  .then(() => seedProfesionalesIngreso())
  .catch((err: unknown) => {
    logger.error({ err }, "No se pudo sincronizar el esquema / sembrar códigos Conectar al arrancar");
  });

// Saneo idempotente (2-ago-2026): trabajos cuya autorización terminó en
// RECHAZO EXPLÍCITO quedaron con la guarda anti-reenvío puesta, bloqueando
// tokens NUEVOS. El resultado conocido libera la guarda; "incierto" no se toca.
db.execute(
  sql`UPDATE klinicos_trabajos SET autorizacion_post_intentado_en = NULL
      WHERE autorizacion_resultado = 'rechazado' AND autorizacion_post_intentado_en IS NOT NULL AND klinicos_nro_bono IS NULL`,
).catch((err: unknown) => {
  logger.error({ err }, "No se pudo liberar la guarda de autorización de rechazos explícitos");
});

// HC = DNI: iguala numero_hc al DNI de cada paciente (idempotente)
migrarNumeroHcIgualDni().catch((err: unknown) => {
  logger.error({ err }, "No se pudo igualar numero_hc al DNI");
});

// Migración idempotente (solo crea si falta; nunca borra ni reemplaza)
migrarKlinicosConsultasProcesos().catch((err: unknown) => {
  logger.error({ err }, "No se pudo migrar klinicos_consultas_procesos");
});

// Log de eventos de turnos para el Robot Klinicos (pull)
migrarRobotTurnosEventos().catch((err: unknown) => {
  logger.error({ err }, "No se pudo migrar robot_turnos_eventos");
});

// Varias prácticas (estudios) por turno
migrarTurnoPracticas().catch((err: unknown) => {
  logger.error({ err }, "No se pudo migrar turno_practicas");
});

// Catálogo completo de estudios con el código de envío exacto de la planilla
// Conectar (pedido del Robot Klinicos). Idempotente; corre en dev y prod.
void seedPlanillaConectar();

// Los 20 diagnósticos/motivos reales de la clínica (planilla Alephoo) para el
// ingreso Klinicos. Idempotente; solo carga si la tabla está vacía.
void seedReglasCie10();

// Rotación de profesionales del ingreso Klinicos por especialidad: se siembra
// arriba, encadenado después del drift de esquema (la tabla puede ser nueva).
import { seedProfesionalesIngreso } from "./lib/seed-profesionales-ingreso";

// Cola de envío de órdenes de estudio al Robot Klinicos (push)
migrarCertificadosAppEnvios().catch((err: unknown) => {
  logger.error({ err }, "No se pudo migrar certificados_app_envios");
});

migrarRobotOrdenesEnvios().catch((err: unknown) => {
  logger.error({ err }, "No se pudo migrar robot_ordenes_envios");
});

// Indicaciones para el paciente (plan de atención) + su cola de envío a la app
migrarIndicacionesPaciente().catch((err: unknown) => {
  logger.error({ err }, "No se pudo migrar indicaciones_pacientes");
});

// Trazabilidad de derivaciones internas (emitida → pedido, idempotente)
migrarValoracionesAtencion().catch((err: unknown) => {
  logger.error({ err }, "No se pudo migrar valoraciones_atencion");
});

migrarSalasLlamado().catch((err: unknown) => {
  logger.error({ err }, "No se pudo migrar salas_llamado");
});

migrarFirmaOrdenes().catch((err: unknown) => {
  logger.error({ err }, "No se pudo migrar la firma de ordenes");
});

migrarDerivacionesTrazabilidad().catch((err: unknown) => {
  logger.error({ err }, "No se pudo migrar la trazabilidad de derivaciones");
});

// Antesala de guardia virtual (videollamadas IOMA)
migrarGuardiaVirtual().catch((err: unknown) => {
  logger.error({ err }, "No se pudo migrar guardia_virtual_sesiones");
});

// Columna perfil en users + usuarios por defecto de cada perfil (idempotente)
db.execute(sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS perfil text`)
  .then(() => asegurarUsuariosPorDefecto())
  .catch((err: unknown) => {
    logger.error({ err }, "No se pudieron asegurar los usuarios por defecto");
  });

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");

  // Robot de sondeo de Phir-it (login + scraping de estudios informados)
  iniciarPhiritPoller();

  // Sincronización periódica de pacientes desde Pulso (import incremental)
  iniciarPulsoPoller();

  // Robot de DiagnostiPACS (detecta estudios informados y cierra el circuito)
  iniciarPacsPoller();

  // Worker del robot Klinicos (deshabilitado si faltan credenciales)
  iniciarKlinicosWorker();

  // Publicador de worklist al PACS (detrás de PACS_WORKLIST_ENABLED)
  iniciarPacsWorklistWorker();

  // Push de órdenes de estudio al Robot Klinicos (requiere ROBOT_API_URL/KEY)
  iniciarRobotOrdenesWorker();

  // Push de certificados a la app del paciente (requiere APP_PACIENTE_PUSH_URL/TOKEN;
  // sin configurar, los certificados quedan encolados y salen al configurarse)
  iniciarCertificadosAppWorker();

  // Push de indicaciones (plan de atención) a la app del paciente
  iniciarIndicacionesAppWorker();

  iniciarValoracionesAppWorker();

  // Avisos de la guardia virtual (videollamadas) al portal del paciente
  iniciarVideollamadasAppWorker();
  iniciarAvisosTurnosWorker();

  // Backup diario de la base clinica-db (pg_dump → Object Storage); en dev
  // queda inactivo salvo BACKUP_DB_ENABLED=true. Ver docs/backups-db.md.
  iniciarBackupDbWorker();

  // Conexión opcional a clinica-db (AWS RDS) — solo si CLINICA_DB_URL está configurada
  initClinicaDBIfConfigured(logger).catch((err: unknown) => {
    logger.error({ err, modulo: "clinica-db" }, "clinica-db: init falló");
  });
});
