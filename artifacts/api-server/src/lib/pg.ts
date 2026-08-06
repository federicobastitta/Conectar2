// Detecta violación de índice/constraint único de Postgres (código 23505),
// incluso si viene envuelta en err.cause.
export function esViolacionUnique(err: unknown): boolean {
  return typeof err === "object" && err !== null &&
    (("code" in err && (err as { code?: string }).code === "23505") ||
      ("cause" in err && esViolacionUnique((err as { cause?: unknown }).cause)));
}
