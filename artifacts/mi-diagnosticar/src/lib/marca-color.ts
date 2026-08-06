// Marca visual de turnos: la fila/tarjeta se pinta según turno.marcaColor.
// "naranja" = recepcionado sin token validado (lo quita solo gerencia).
// "amarillo" = token cargado por Klinicos (amarillo bien clarito, casi blanco).
export function marcaColorFondo(marca?: string | null): string | null {
  if (marca === "naranja") return "bg-orange-100 dark:bg-orange-950/40";
  if (marca === "amarillo") return "bg-yellow-50 dark:bg-yellow-950/20";
  return null;
}

export function marcaColorLabel(marca?: string | null): string | null {
  if (marca === "naranja") return "Recepcionado sin token";
  if (marca === "amarillo") return "Token por Klinicos";
  return null;
}
