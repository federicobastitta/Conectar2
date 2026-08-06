// ── Prefijos lógicos del bucket clínico ───────────────────────────────────
// GCS/App Storage no exige carpetas físicas: los prefijos se "crean" al guardar
// el primer objeto. Este módulo define la estructura canónica y provee helpers
// para construir rutas. El bucket es privado, cifrado y nunca contiene datos
// clínicos en el filesystem persistente de Replit.

export const PREFIJOS = {
  // Archivos originales subidos por los usuarios (sin modificar)
  importacionesOriginales: "importaciones/originales/",
  // Archivos procesados: filas parseadas como JSON
  importacionesProcesadas: "importaciones/procesadas/",
  // Filas rechazadas durante el import (JSON por sesión)
  importacionesRechazadas: "importaciones/rechazadas/",
  // Informes de conciliación (CSV/JSON con el resultado del lote)
  conciliaciones: "conciliaciones/",
  // Órdenes de práctica (PDFs generados)
  ordenes: "ordenes/",
  // Autorizaciones IOMA y otras coberturas
  autorizaciones: "autorizaciones/",
  // Informes médicos (turnos PACS, epicrisis, etc.)
  informes: "informes/",
  // Informes de facturación generados por el robot
  informesFacturacion: "informes/facturacion/",
  // Firmas escaneadas de médicos (para el informe de facturación)
  firmasMedicos: "firmas/medicos/",
} as const;

export type PrefijoKey = keyof typeof PREFIJOS;

/**
 * Construye la ruta completa dentro del PRIVATE_OBJECT_DIR.
 * El caller no necesita saber el directorio base del bucket.
 * GCS crea el "directorio lógico" al guardar el primer objeto.
 */
export function rutaObjeto(prefijo: PrefijoKey, nombre: string): string {
  const base = (process.env.PRIVATE_OBJECT_DIR ?? "").replace(/\/+$/, "");
  const pre = PREFIJOS[prefijo].replace(/^\/+/, "");
  return base ? `${base}/${pre}${nombre}` : `${pre}${nombre}`;
}

/**
 * Nombre de archivo para un import original, con timestamp idempotente.
 * Format: YYYYMMDD_HHMMSS_<nombre_sanitizado>
 */
export function nombreImportOriginal(nombreArchivo: string): string {
  const ts = new Date()
    .toISOString()
    .replace(/[-:T]/g, "")
    .replace(/\..+/, "");
  const sanitizado = nombreArchivo.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 80);
  return `${ts}_${sanitizado}`;
}

/**
 * Estructura de prefijos esperados en el bucket.
 * Usada por el endpoint de infraestructura para verificar/documentar la config.
 */
export function estructuraPrefijos(): Array<{ prefijo: string; descripcion: string }> {
  return [
    { prefijo: PREFIJOS.importacionesOriginales, descripcion: "Archivos XLS originales subidos" },
    { prefijo: PREFIJOS.importacionesProcesadas, descripcion: "Datos parseados de cada import" },
    { prefijo: PREFIJOS.importacionesRechazadas, descripcion: "Filas rechazadas con detalle de error" },
    { prefijo: PREFIJOS.conciliaciones, descripcion: "Informes CSV/JSON de conciliación" },
    { prefijo: PREFIJOS.ordenes, descripcion: "PDFs de órdenes de práctica" },
    { prefijo: PREFIJOS.autorizaciones, descripcion: "Autorizaciones IOMA y coberturas" },
    { prefijo: PREFIJOS.informes, descripcion: "Informes médicos (PACS, epicrisis)" },
    { prefijo: PREFIJOS.informesFacturacion, descripcion: "Informes de facturación (robot)" },
    { prefijo: PREFIJOS.firmasMedicos, descripcion: "Firmas escaneadas de médicos" },
  ];
}
