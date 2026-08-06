---
name: Push de órdenes al Robot Klinicos
description: Política de reintentos y rearmado de la cola de envío de órdenes de estudio al Robot.
---

- Cola durable `robot_ordenes_envios` única por orden; el worker clasifica 4xx como permanente **excepto** 401/403/408/429 (clave rotada o transitorio → se reintenta).
- **Regla clave:** reencolar (`encolarEnvioOrdenRobot`) es un upsert que rearma filas en `error_permanente` (pendiente, intentos=0); un envío `enviado` nunca se repite.
- **Why:** una revisión detectó que `onConflictDoNothing` dejaba envíos perdidos para siempre tras un 4xx puntual.
- **How to apply:** cualquier cola de envío saliente nueva debe tener vía de rearmado y no tratar 401/403 como permanente.
- `cargarFuente` (motor PDF) vive en `pdf/fuente_documento.ts` como módulo de dominio: las integraciones no deben importar desde `routes/*` (circularidad frágil).
- Los tests dejan filas huérfanas en la cola (órdenes borradas) que el worker marca error_permanente con WARN "Orden no encontrada" — inofensivo, se limpian con DELETE de huérfanos.

## Envío automático desactivado (jul 2026)
El usuario decidió que las planillas NO viajen al Robot con "PENDIENTE DE FIRMA" y, por ahora, que no se envíe nada automáticamente: los puntos de encolado al emitir (creación de orden y orden automática al recepcionar) fueron removidos. La cola robot_ordenes_envios y el worker siguen operativos.
**Cuando se habilite:** encolar desde el endpoint de firmar cuando firma_estado pasa a 'firmada', y reencolar nuevas versiones firmadas (ojo: el upsert actual solo rearma filas en error_permanente; una fila 'enviado' no se reenvía sin cambiar esa lógica).
