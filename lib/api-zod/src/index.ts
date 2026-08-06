export * from "./generated/api";
export * from "./generated/types";
// Resolver ambigüedad: PublicoGetDisponibilidadRangoParams existe como Zod const
// en generated/api.ts (path param "id") y como TypeScript type en generated/types/
// (query params fechaDesde/fechaHasta). orval los genera con el mismo nombre cuando
// un endpoint tiene path params + query params. El Zod const de api.ts tiene prioridad
// porque es el validador que usa el api-server.
export { PublicoGetDisponibilidadRangoParams } from "./generated/api";
// Misma ambigüedad para el body del check in público (Zod const vs. tipo TS).
export { PublicoCheckinValidarTokenBody } from "./generated/api";
