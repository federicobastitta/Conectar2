---
name: PACS Workspace v1.0
description: Integración DiagnosticPACS — informes, firma, imágenes clave, webhook HMAC, flag de feature.
---

# PACS Workspace v1.0 — decisiones y quirks

## Arquitectura general

- **Flag de activación**: `PACS_WORKSPACE_ENABLED=true` solo en environment `development` (Replit env-var scoped). La variable NO debe setearse en `shared` ni en `production`. Con el flag off, todas las rutas de `/api/pacs-workspace/*` y `/api/pacs/webhook/*` devuelven 404 transparent.
- **DB dev**: 5 tablas PACS aplicadas vía psql directo (DDL sin drizzle push): `pacs_informes`, `informe_versiones`, `informe_imagenes_clave_pacs`, `pacs_eventos`, `informe_estudios`. Columna adicional `firmado_por_nombre TEXT` en `informe_versiones`.
- **Schema en lib/db**: `lib/db/src/schema/pacs_workspace.ts` — exportado vía `export * from "./pacs_workspace"` en el index. `pacsAccessionSeq.maxValue` debe ser `number` no `bigint` (TS2322).

## Endpoints del backend (pacs_workspace.ts)

Todos detrás de `soloConFlag` middleware. Router registrado en `routes/index.ts` como `pacsWorkspaceRouter`.

| Ruta | Auth | Función |
|------|------|---------|
| GET  `/pacs-workspace/ordenes` | admin/recepcion/medico | Lista todas las órdenes con join a paciente, profesional e informe |
| GET  `/pacs-workspace/ordenes/:id` | admin/recepcion/medico | Detalle de una orden |
| GET  `/pacs-workspace/ordenes/:id/informe` | admin/recepcion/medico | Upsert: crea el informe si no existe |
| PUT  `/pacs-workspace/ordenes/:id/informe/borrador` | admin/medico | Actualiza texto del borrador |
| POST `/pacs-workspace/ordenes/:id/informe/firmar` | admin/medico | Crea versión inmutable, congela imágenes clave draft |
| POST `/pacs-workspace/ordenes/:id/informe/publicar` | admin/medico | Marca última versión como publicada |
| POST `/pacs-workspace/ordenes/:id/informe/corregir` | admin/medico | Reabre borrador (crea nueva versión al firmar de nuevo) |
| PUT  `/pacs-workspace/ordenes/:id/informe/imagenes-clave` | admin/medico | Reemplaza imágenes clave del borrador (draft) |
| PATCH `/pacs-workspace/ordenes/:id/estado` | admin/recepcion/medico | Cambia estado operativo |
| POST `/pacs-workspace/ordenes/:id/enviar` | admin/recepcion/medico | Upsert de orden en PACS, genera accession CM-1 |
| POST `/pacs-workspace/ordenes/:id/sesion-visor` | admin/recepcion/medico | Sesión de visor un solo uso |
| GET  `/pacs-workspace/ordenes/:id/estudios` | admin/recepcion/medico | Estudios espejo desde PACS |
| POST `/pacs/webhook/eventos` | HMAC anónimo | Idempotente por event_id, verifica firma |

## Webhook HMAC

- Header: `X-Conectar-Signature: sha256=<hex>`
- Payload firmado: `${ts}.${rawBody}`
- Ventana anti-replay: 300 segundos (configurable en `pacs-workspace-v1.ts`)
- Soporte rotación de clave: `PACS_WEBHOOK_SECRET` (actual) + `PACS_WEBHOOK_SECRET_ANTERIOR`
- El body crudo se captura en `req.rawBody` vía verify hook de `express.json` en app.ts solo para rutas `/api/pacs/webhook/*`
- Idempotencia: `pacs_eventos.event_id` tiene constraint UNIQUE; insert con `onConflictDoNothing` → 200 + `{duplicado: true}`

## Frontend API layer

- `src/api/pacs-workspace.ts` — hooks TanStack Query tipados + `PacsIndisponibleError` (detecta 404 de flag off)
- Error 404 del backend se transforma en `PacsIndisponibleError` → `pacsIndisponible: true` en los hooks
- Auth: `localStorage.getItem("auth_token")` con Bearer header (patrón estándar del frontend)
- `useToggleImagenClave` y `useComentarImagenClave` son hooks compuestos que llaman `useActualizarImagenesClave`

## Mocks aislados

- `src/mocks/pacs-workspace-mock.ts` — stub con warning (no exporta datos, mantiene tipos mínimos para compatibilidad con `.demo.ts`)
- `src/mocks/use-pacs-workspace-store.ts` — stub vacío con warning
- `src/mocks/*.demo.ts` — copias históricas excluidas del typecheck via `tsconfig.json` (`"exclude": ["**/*.demo.ts"]`)

## Accession number (CM-1)

- Formato: `C{AA}-{12 dígitos}` (ej: `C26-000000000001`)
- Generado una sola vez e inmutable (se asigna al primer `POST /enviar`)
- Secuencia PostgreSQL: `pacs_accession_seq` (ya existe en dev)

**Why:** El accession number es la clave de enlace con el PACS; si cambia, el PACS pierde la referencia al estudio.

## Visor

- Se abre con una sesión de un solo uso (`POST /sesion-visor` → `redeem_url` o `viewer_url`)
- El iframe puede fallar si el PACS no permite embedding → fallback a "abrir en nueva pestaña"
- Sesión expira en ~5 minutos (según contrato con DiagnosticPACS)

## Prod

- `PACS_WORKSPACE_ENABLED` NO se setea en producción (módulo desactivado → 404 en todas las rutas PACS)
- DDL de producción pendiente de aplicar cuando se active el módulo en prod
