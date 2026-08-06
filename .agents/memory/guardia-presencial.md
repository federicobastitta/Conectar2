---
name: Guardia presencial (Berazategui)
description: Modalidad presencial de la guardia virtual — estado confirmado ocupa lugar, botón "ya llegué", allowlist de DNIs de prueba
---

# Guardia presencial

- La antesala de guardia virtual acepta `modalidad: "presencial"` en POST /publico/guardia-virtual/registros; el resto del flujo (token IOMA, posición en fila) es idéntico a videollamada.
- **Estado "agendado" no existe en el enum de turnos**: el turno presencial se crea con estado `confirmado` (= agendado sin llegar). Al usuario Federico se le explica como "agendado".
- `confirmado` en turneras `esGuardia` **ocupa lugar en la fila** (cola staff, conteo de posiciones y mi-posicion en sala_espera.ts lo incluyen con condición `confirmado && esGuardia`). LLAMABLES no cambia → el médico NO puede llamar a un confirmado.
- POST `/publico/guardia-virtual/registros/:sesionToken/llegue`: UPDATE atómico confirmado→arribo, admitidoPor "app paciente (ya llegué)", idempotente (`yaEstaba`), 409 si cancelado/ausente/anulado o si es videollamada.
- Allowlist: config_sistema `guardia_presencial_dnis_prueba` (JSON array). Default en código: `["*"]` = abierto a todos los IOMA (Federico lo abrió el 5-ago-2026); para restringir, setear la config con una lista de DNIs. El gate de cobertura (obras sociales habilitadas) aplica igual.
- `guardia_virtual_sesiones.modalidad` default 'videollamada'; **Why:** migrarGuardiaVirtual hacía early-return si la tabla existía y competía con el auto-drift → ahora aplica ADD COLUMN IF NOT EXISTS también en el camino "ya existe". Cualquier columna nueva de esa tabla debe agregarse en ambos caminos.
- Polling /estado: `jitsiUrl` solo si modalidad ≠ presencial; agrega `modalidad` y `llegoALaClinica`.
