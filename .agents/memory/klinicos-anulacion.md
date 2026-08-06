---
name: Anulación automática de prestaciones Klinicos
description: Contrato de anularOrden del portal y flujo de anulación automática al cancelar un turno ya cargado.
---

# Anulación de prestaciones en Klinicos

**Contrato del portal** (calibrado en vivo 05/08/2026, solo lectura del JS del detalle):
- `POST /ordenPrestacion/anularOrden/{Id de fila}` con body form-urlencoded `{ motivo }` — el motivo es OBLIGATORIO (el JS lo exige aunque el staff diga que "no se hace").
- Respuesta JSON `{error, message, data}` con `data` como JSON-string `IsSuccessStatus/Mensaje` (mismo formato que la autorización).
- El `Id` de fila sale del crudo de la grilla AJAX de prestaciones (`"Id":\d+`), NO es el número de prestación.

**Flujo automático**: cancelar un turno cuyo trabajo Klinicos está `completado` con atención+prestación identificadas lo pasa a `anulacion_pendiente`; el worker lo procesa fail-closed (relee grilla, ya-ANULADA = éxito idempotente, confirma por relectura) → `anulado`, o `error` con "anular a mano" SIN reintentos. Dry-run nunca toca el portal.

**Why:** regla de facturación — la prestación cargada con bono debe anularse en Klinicos si el paciente cancela antes de atenderse; los reintentos automáticos ante incertidumbre podrían anular de más o duplicar POSTs.

**How to apply:** cualquier módulo nuevo que toque prestaciones debe respetar los estados `anulacion_pendiente`/`anulado` en filtros por estado de `klinicos_trabajos`; procedimiento manual equivalente en docs/klinicos-flujo-administrativo.md §2.4.1.

**Ampliación 05/08/2026 (circuito inverso app):** la anulación automática aplica a cualquier cancelación INDIVIDUAL (app o recepción, cualquier modalidad), no solo videollamada. `cancelarTrabajosDeTurno(turnoId, {anularSiCargado:false})` es el modo de la cancelación masiva de turnera: pendientes se cancelan, cargadas quedan con warning para anular a mano (nunca anulaciones masivas). La app puede cancelar en pendiente/confirmado/reservado/arribo/en_sala; nunca llamado/en_atencion/atendido (ESTADOS_CANCELABLES en api_publica).
