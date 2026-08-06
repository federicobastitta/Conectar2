const JITSI_BASE = "https://meet.jit.si";
const ESTADOS_SIN_VIDEOLLAMADA = new Set(["cancelado", "ausente"]);

// Sala Jitsi derivada del qrCodigo del turno (único, 80 bits de entropía):
// mismo link para el médico y el paciente sin cambios de schema.
export function urlVideollamadaTurno(t: {
  modalidad?: string | null;
  qrCodigo?: string | null;
  estado?: string | null;
}): string | null {
  if (t.modalidad !== "videoconsulta") return null;
  if (!t.qrCodigo) return null;
  if (t.estado && ESTADOS_SIN_VIDEOLLAMADA.has(t.estado)) return null;
  return `${JITSI_BASE}/ConectarDx-Turno-${t.qrCodigo}#config.prejoinConfig.enabled=false`;
}
