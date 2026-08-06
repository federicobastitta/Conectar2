---
name: Obras sociales que validan en Klinicos
description: Regla general — solo la allowlist de coberturas (hoy IOMA) se envía a Klinicos / lleva token.
---
Regla (Federico, 02-ago-2026): a Klinicos SOLO van pacientes cuya cobertura está en la allowlist `OBRAS_SOCIALES_KLINICOS` (klinicos-cola.ts), hoy únicamente IOMA. El usuario irá avisando qué otras obras sociales se suman. Particulares, PAMI y demás coberturas NO validan token y no se encola nada (en ningún origen: auto, registro ni manual).

**Why:** esas coberturas no validan en Klinicos; encolar/pedir token genera trabajos y errores inútiles.

**How to apply:**
- Guard central en `encolarTrabajoKlinicos` (cobertura del turno, fallback paciente) + rechazo 409 en POST validar-token.
- Matching por inclusión normalizada ("IOMA - 123", "I.O.M.A." matchean); test puro en klinicos-cobertura.test.ts.
- Para habilitar una obra social nueva: agregarla a `OBRAS_SOCIALES_KLINICOS` y republicar.
