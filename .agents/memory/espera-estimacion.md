---
name: Estimación de espera en sala
description: Modelo definido por el usuario para la demora estimada de la sala de espera/guardia
---
Regla (definida por Federico, ago 2026): la demora estimada se calcula con la duración real de cada atención — desde que el médico pone **Llamar** (`turnos.llamado_en`) hasta **Finalizar Consulta** (`turnos.finalizado_en`) — promediada sobre la ÚLTIMA HORA (respaldo: promedio del día), y la fila se reparte entre el **pool** de médicos atendiendo: `ceil(posición/pool) × ritmo`, descontando lo transcurrido de la consulta abierta más vieja.

**Why:** el cálculo anterior (15 min fijos por paciente / gaps de atendido_en) sobreestimaba en guardia con varios médicos.

**How to apply:** lógica en `api-server/src/lib/espera.ts`. El pool se mide por actividad real (médicos con consulta abierta o llamado/finalizado en los últimos 90 min, excluyendo llamados que terminaron cancelados/ausentes). NUNCA usar `acepta_demanda_espontanea` para el pool: los médicos lo dejan prendido para siempre (26 activos). `finalizado_en` se estampa al finalizar la consulta; si se agrega otro camino que cierre turnos a visto/pendiente_informe, estampar ahí también. Fallback sin datos del día: duración de la turnera (guardia: 15 min en sala_espera.ts).
