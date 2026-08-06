---
name: Pre-carga de consultas Klinicos (REVERTIDA)
description: La consulta NO debe generarse antes del token; se crea solo al Validar Token
---

**REVERTIDA el 02-ago-2026 el mismo día que se validó.** La pre-carga sin token (al registrar/recepcionar, al reservar turno de hoy y la diaria) funcionó técnicamente en prod (caso con bono real, $ FACTURABLE), pero el usuario recibió la regla de facturación de que la consulta NO puede generarse antes de que el paciente traiga el token ("me asesoraron mal").

Regla vigente:
- La consulta en Klinicos se genera ÚNICAMENTE en el circuito de Validar Token (origen "manual").
- Los encolados al registrar/recepcionar volvieron a origen "auto" (frenados por el kill-switch klinicos_autoencolado, normalmente en off).
- Las agendas de PRÁCTICAS sí se siguen encolando al reservar (eso no cambió).

**Why:** regla administrativa/facturación de la obra social, no técnica: crear la atención antes del token no está permitido aunque el portal lo acepte.
**How to apply:** no reintroducir disparadores de carga de consultas sin token, aunque el circuito técnico exista y haya funcionado; ante pedidos de "acelerar", la única vía válida es optimizar el flujo de Validar Token.
