---
name: Salas de llamado (TV)
description: Cómo funciona el filtro de pantallas TV por sala de llamado y su precedencia.
---

Regla: las pantallas de sala de espera pueden filtrar por **sala de llamado** (tabla `salas_llamado`, elegida por cada médico en `profesionales.sala_llamado_id`), además de por turnera o sede. La precedencia es **sala > turnera > sede > todas** y debe mantenerse igual en backend (pantalla y canje de código TV), en `/tv` y en `pantalla-sala`.

**Why:** el usuario pidió que el médico elija desde qué sala (TV) se anuncia su llamado; la sala se filtra en memoria post-join porque el profesional del turno se resuelve con coalesce(turno.profesionalId, turnera.profesionalId).

**Actualización ago 2026:** las turneras también pueden tener `sala_llamado_id` (form de agenda); el filtro de pantalla usa `coalesce(sala del médico, sala de la turnera)` — así la TV de una sala muestra a los pacientes en espera aunque el médico no haya elegido su sala. Además, `devolver-sala` ahora lo puede usar el propio médico, pero SOLO sobre turnos que él mismo llamó (condición atómica sobre `llamado_por_profesional_id`); no computa atención.

**How to apply:** si se agrega otro tipo de destino de pantalla, tocar los 4 lugares en simultáneo (TvVinculo, canje, leerFiltro del frontend, TvSeleccion). Solo admin/recepción gestionan salas; el médico solo lista y elige la suya (PATCH profesionales valida que exista y esté activa; FK ON DELETE SET NULL).
