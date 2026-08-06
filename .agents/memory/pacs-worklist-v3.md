---
name: PACS worklist v3
description: Integración worklist con PACS (publicador+webhook+simulador) — colisiones de rutas y lecciones de idempotencia.
---

- **Colisión de webhooks**: ya existía `POST /pacs/webhook/eventos` (contrato viejo pacs_workspace, firma `X-Conectar-Signature`). El webhook de worklist v3 vive en `POST /pacs/worklist/webhook/eventos` (firma `X-Pacs-Signature` + `X-Pacs-Timestamp`, HMAC `${ts}.${rawBody}`). **Why:** Express matchea el primer router montado; el evento del sim caía en el handler viejo y devolvía 401 "Firma inválida". **How to apply:** cualquier webhook nuevo bajo `/pacs/*` debe verificar que el path no exista en pacs_workspace.ts, y app.ts debe capturar rawBody para ese prefijo.
- **Canal real = órdenes v1 (jul 2026)**: el PACS real NO implementa `/integration/worklist`; la cola worklist publica por el canal de órdenes v1 (`POST /orders`, `POST /orders/{id}/reception`, `DELETE /orders/{id}`) con Idempotency-Keys estables (`accession:orden` / `accession:reception` / `accession:cancelled`). 409 en alta = éxito; 404 en DELETE = éxito; `ready_to_report` es no-op (lo determina el PACS). **Why:** PACS_WORKLIST_URL apuntaba a un simulador interno y los ítems figuraban "publicado" sin llegar al PACS real. **How to apply:** cualquier envío al PACS pasa por pacs-workspace-v1.ts; no reintroducir un fetch propio con PACS_WORKLIST_URL.
- **Simulador en memoria**: el sim PACS (solo dev) pierde su worklist al reiniciar el api-server. Para re-probar, resetear el ítem: `UPDATE pacs_worklist_items SET estado_envio='pendiente', proximo_intento_en=now() WHERE turno_id=...` y esperar ~35s al worker.
- **Idempotencia webhook**: serializada por `pg_advisory_xact_lock(hashtext('pacs_evento:'||event_id))` tomada en la MISMA transacción que escribe informe+turno+procesado_en; un claim previo que suelta el lock antes de procesar NO alcanza.
- **Worker multi-instancia**: claim por CAS (`UPDATE ... WHERE id AND estado_envio AND intentos ... RETURNING`) antes de publicar cada ítem; el flag en memoria `despachando` solo protege dentro del proceso.
- La transición del turno a "informado" la produce solo el PACS; incluye estados tempranos ("pendiente", "confirmado") porque el informe puede llegar sin pasos de recepción.

## 409 en el alta de órdenes (ago 2026)
Un 409 de POST /orders NO siempre es "la orden ya existe": si el detalle menciona
accession ("accession_number ya usado por otra orden"), el alta fue RECHAZADA y la
orden no existe en Pixel; tratarlo como éxito rompe la recepción con 404 "No encontrado"
(sin rastro del lado de Pixel, porque un 409 no crea registro).
**Fix:** `esConflictoDeAccession` + `regenerarAccessionItem` en pacs-worklist.ts: se
regenera el accession y el reintento sale con clave de idempotencia nueva.
**Origen del choque:** rangos de accession consumidos por otra fuente/era vieja; la
secuencia de prod se saltó a 20000 como colchón. Si vuelve a chocar, se autorepara.
