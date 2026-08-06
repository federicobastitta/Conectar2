---
name: Validación y suite sobre DB compartida
description: Por qué la validación de tareas falla con tests intermitentes y cómo no empeorarlo
---

La validación de tareas corre `vitest run` completo contra la DB de desarrollo compartida.

**Reglas:**
- Nunca correr vitest local mientras una validación está en curso: dos corridas simultáneas chocan (claves únicas de fixtures fijas, filas "Ana LópezTest<otro RUN_ID>" en sala de espera, etc.).
- Corridas anteriores que crashean dejan fixtures huérfanos (pacientes/turnos de test) que rompen corridas futuras; limpiarlos vía SQL (ojo FK klinicos_trabajos → turnos).
- Tests intermitentes conocidos: klinicos "upsert crea y actualiza una regla" y "permite editar campos revisables del trabajo" (fallan a veces en suite completa, pasan al reintentar el archivo), algunos de ordenes_practicas, token_afiliado_imagenes "el reintento lo incluye en el payload" (ultimoBodyRobot null solo bajo suite completa), y klinicos "rota round-robin y excluye ginecólogos" (el estado de rotación es global; otros tests de la suite lo corren). Si son los únicos fallos, documentarlo en skip_validation_reason.
- Tests cuyo flujo reserva turnos vía API deben borrar klinicos_trabajos ANTES de borrar sus turnos en afterAll (el encolado es fire-and-forget y deja FK colgando).

**Why:** tres validaciones de ~8 min fallaron seguidas solo por estas causas, sin relación con el cambio bajo prueba.
