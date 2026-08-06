---
name: HC = DNI
description: Regla institucional — el número de historia clínica es el DNI del paciente.
---

**Regla:** numero_hc = DNI del paciente (pedido del usuario, jul 2026). Sin DNI → formato legacy HC000123.

**Why:** la clínica identifica las historias por DNI; tener dos numeraciones confundía a recepción.

**How to apply:** todo camino que cree o modifique pacientes con DNI debe fijar/sincronizar numeroHc (creación normal, PATCH de dni, importaciones, sync Pulso, auto-create en turnos y api pública). Hay migración idempotente al arrancar (dos pasos NULL→set en transacción por el índice único de numero_hc) que corrige la base conectada — incluida la AWS de prod en el próximo publish.
