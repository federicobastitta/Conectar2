---
name: Tests contra la DB dev compartida
description: Por qué los tests del api-server fallan de forma intermitente y cómo escribirlos para que no dependan del estado de la base.
---

Los tests del api-server corren contra la DB dev compartida (DATABASE_URL); corridas paralelas o abortadas dejan datos residuales y el catálogo real puede ser depurado por otras tareas.

**Reglas:**
- Cada suite debe crear (upsert idempotente) sus propios datos de catálogo/seed en `beforeAll`; nunca asumir que existen filas "de seed".
- Asserts sobre listados públicos deben matchear por el RUN_ID exacto de la corrida, nunca "el primer registro que empiece con X".
- Al matar corridas de vitest a mano quedan restos sin limpiar (pacientes, turneras, users de test); limpiar por patrón de nombre antes de re-validar.

**Bug real relacionado:** el cache de 30s de reglas de sector Klinicos no se invalidaba tras el upsert (arreglado con `invalidarCacheReglasSector()` en el POST); cualquier cache en memoria de tablas editables por API debe invalidarse en el endpoint de escritura.

- La suite de push de órdenes al Robot usa fixtures fijos (especialidad "…Test Push", DNI 43219876, matrícula "MP 5555") sin RUN_ID: si una corrida aborta, los restos rompen las siguientes con 23505. Limpiar esas filas (envíos→órdenes→paciente, profesional, especialidad) desbloquea la validación.
