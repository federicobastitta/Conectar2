---
name: Llamador con Pixel
description: Integración bidireccional del llamador entre Conectar y Pixel (DiagnostiPACS)
---

## Camino Conectar → Pixel (consultorios)
- `integraciones/pixel-llamador.ts`: `avisarLlamadoPixel(turnoId, log)` fire-and-forget al llamar (`transicionar` accion "llamar"). POST `{base}/api/v1/integration/llamador`, Bearer `CONECTAR_INTEGRATION_TOKEN`.
- Campos opcionales se OMITEN, nunca null. Incluye consultorio (turnera) y sala del médico que llamó.

## Camino Pixel → Conectar (imágenes: el médico llama desde la worklist de Pixel)
- `POST /api/integraciones/pixel/llamador/llamar` (x-api-key) body `{turno_id, sala_id?, consultorio_id?}`.
- `GET /llamador/consultorios` expone el catálogo `consultorios` (mismo que el desplegable del médico); `consultorio_id` actualiza `profesionales.consultorioId` y la TV muestra ese nombre como destino (la pantalla resuelve consultorio vía profesional.consultorioId, no via turnera.consultorio).
- Espeja la semántica del llamado interno: estado "llamado", guard atómico anti-carrera (otro médico → 409, incluso si pierde la carrera post pre-check), `llamadoPorProfesionalId` = profesional del turno o titular de agenda, auditoría con usuarioEmail "integracion-pixel".
- `sala_id` (de GET /llamador/salas) actualiza `profesionales.salaLlamadoId` — misma semántica que el médico eligiendo sala en Conectar; así la TV filtrada por sala lo muestra.
- NO re-avisa a Pixel (sin eco de avisarLlamadoPixel).

## Autenticación x-api-key
- `CONECTAR_PIXEL_API_KEY` (nueva, ASCII) o `PACS_API_TOKEN` (vieja, tiene tildes que no viajan en headers; secreto de CUENTA que no se puede pisar con un app secret del mismo nombre).
- `GET /api/integraciones/pixel/llamador/salas` → `{salas:[{sala_id,nombre}]}` solo activas.

## Pendiente
- Pixel debe implementar el llamado (mandar turno_id que reciben en la worklist + sala_id elegida por el médico en su UI).
- Dev dispara avisos reales a Pixel (mismo patrón que pacs-recepcion).
