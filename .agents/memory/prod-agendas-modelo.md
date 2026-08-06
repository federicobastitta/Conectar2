---
name: Agendas modelo vs reales en prod
description: En producción conviven agendas demo ("modelo") y agendas reales de Alephoo; cómo se ocultan de la turnera.
---

- Las pantallas de reserva filtran turneras solo por `activa: true` (no por `visibilidad`), así que para sacar una agenda de la toma de turnos hay que ponerla `activa: false`.
- En prod, las turneras id 1–6 ("Agenda Dr/a. Rodríguez/García/Fernández/Sánchez/Díaz" + "Agenda Tarde Dr. Rodríguez") son datos de demostración del seed: quedaron `activa: false, visibilidad: interna` (jul 2026). Los profesionales demo (id 1–5) siguen existiendo por pedido del usuario.
- Las agendas reales vienen de la extracción de Alephoo (autopilot-data.json, foto del 12 jul 2026) sincronizadas a prod vía la API con login admin.
- **Why:** el usuario reportó que se podían tomar turnos con médicos de prueba ("error en cascada"); pidió no dar de baja a los médicos, solo que no aparezcan sus agendas modelo.
- **How to apply:** al sembrar o sincronizar agendas nuevas, verificar que no reactiven las modelo; para ocultar agendas de la reserva usar `activa: false`. Quedaron 3 turnos futuros tomados sobre agendas modelo que el usuario decidió dejar como están.
