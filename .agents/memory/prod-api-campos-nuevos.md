---
name: Seeding de columnas nuevas en prod
description: Por qué sembrar campos nuevos vía la API publicada no funciona antes del publish, y el patrón de seed de arranque
---

La build publicada valida los bodies con el Zod de SU versión: un campo agregado después del último publish (ej. `codigoEnvio`) es **silenciosamente stripeado** — el PATCH devuelve 200 pero no escribe nada. Verificar siempre releyendo el recurso tras el write.

**Regla:** para datos que deben existir en prod "tras el próximo publish" sobre columnas nuevas, usar un seed idempotente de arranque en el api-server (encadenado después de `sincronizarEsquemaAlArrancar`, solo completa valores NULL/vacíos, nunca pisa ediciones manuales). Ejemplo: `lib/seed-codigos-conectar.ts`.

**Además:** los endpoints `soloAdmin` exigen rol `admin` = usuarios por defecto `gerente@` o `desarrollador@` (clave estándar). `administrador@diagnosticar.ar` tiene rol `recepcionista` y da 403.
