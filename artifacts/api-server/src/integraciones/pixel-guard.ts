// ── Guarda de entorno para envíos salientes a Pixel (DiagnosticPACS) ────────
// Las solicitudes que MUTAN datos en Pixel (métodos no-GET: POST, PATCH, PUT,
// DELETE) solo salen en producción. Los GETs de lectura pasan en dev porque
// no contaminan datos y son útiles para debug.
//
// Activación:
//   NODE_ENV=production   → siempre activo (app publicada)
//   PIXEL_INTEGRACION_ACTIVA=true → activo en cualquier entorno (integración manual)

export function pixelEnvioActivo(): boolean {
  return (
    process.env.NODE_ENV === "production" ||
    process.env.PIXEL_INTEGRACION_ACTIVA === "true"
  );
}
