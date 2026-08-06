// ── Código de facturación IOMA según la planilla Conectar ─────────────────
// Pedido de Conectar (30/07/2026): cada solicitud al Robot debe llevar el
// practice_code EXACTO de la planilla acordada, con sus separadores. Los
// combos viajan como UN solo practice_code ("290101-290102-420102", nunca
// solicitudes separadas) y no hay que inventar variantes.
//
// Fuente de verdad, en orden:
//   1. klinicos_practicas.codigo_envio (string textual de la planilla)
//   2. klinicos_practicas.codigo_facturacion (override manual legado)
//   3. la planilla embebida acá (match por el multiconjunto de códigos)
//   4. código único → tal cual; varios códigos sin entrada → null: NUNCA se
//      inventa un código (el caso queda para revisión manual del staff, para
//      no frenar la validación del lado de Conectar con un código que no
//      reconoce).

/** Clave canónica: multiconjunto de códigos, ordenado y unido con "|". */
function clave(codigos: string[]): string {
  return [...codigos].sort().join("|");
}

/** Planilla Conectar (30/07/2026): multiconjunto de códigos → practice_code exacto. */
const PLANILLA_CONECTAR: Record<string, string> = {
  // Combos completos
  [clave(["290101", "290102", "420102"])]: "290101-290102-420102", // EEG
  [clave(["290101", "202102"])]: "290101-202102", // EEG (combo alternativo de la planilla jul 2026)
  [clave(["880502", "880501", "280102"])]: "880502-880501-280102", // Espirometría
  [clave(["180106", "881806"])]: "180106-881806", // Eco mamas
  [clave(["180112", "180113"])]: "180112-180113", // Eco abdomen
  [clave(["340601", "340601", "340602", "340602"])]: "340601+340601+340602+340602", // Mamografía
  // Catálogos viejos guardan mamografía sin las repeticiones: mismo combo.
  [clave(["340601", "340602"])]: "340601+340601+340602+340602",
  [clave(["881841/A", "881841/B"])]: "881841/A+881841/B", // Doppler arterial y venoso MMII/MMSS
  // Rx frente / perfil (formato literal de la planilla)
  [clave(["340201", "340202"])]: "340201 / 340202", // Rx cráneo, cavum, senos paranasales
  [clave(["340209", "340210"])]: "340209 / 340210", // Rx columna
  [clave(["340211", "340212"])]: "340211 / 340212", // Rx hombro, pelvis, cadera, fémur, húmero
  [clave(["340301", "340302"])]: "340301 / 340302", // Rx tórax, parrilla costal
  [clave(["340421", "340422"])]: "340421 / 340422", // Rx abdomen
};

/** Consulta de especialidad: siempre 420101 (la planilla lo fija para toda consulta). */
export const CODIGO_FACTURACION_CONSULTA = "420101";

/**
 * Resuelve el practice_code a enviar al Robot para una práctica del catálogo.
 * Devuelve null si no hay código acordado resoluble (nunca inventa uno:
 * el caso debe ir a revisión manual).
 */
export function codigoFacturacionPractica(practica: {
  codigoEnvio?: string | null;
  codigoFacturacion?: string | null;
  codigos?: string[] | null;
}): string | null {
  const envio = practica.codigoEnvio?.trim();
  if (envio) return envio;
  const override = practica.codigoFacturacion?.trim();
  if (override) return override;
  const codigos = (practica.codigos ?? []).map((c) => c.trim()).filter(Boolean);
  if (codigos.length === 0) return null;
  const dePlanilla = PLANILLA_CONECTAR[clave(codigos)];
  if (dePlanilla) return dePlanilla;
  if (codigos.length === 1) return codigos[0];
  return null;
}
