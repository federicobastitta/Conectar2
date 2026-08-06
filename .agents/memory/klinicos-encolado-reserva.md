---
name: Encolado Klinicos al reservar
description: Los turnos de prácticas se cargan en Klinicos al reservar, pendientes de token; cancelaciones del turno cancelan el trabajo.
---

Regla (pedido del usuario 01/08/2026): los turnos de agendas de prácticas (sector Klinicos ≠ CONSULTORIO, resuelto por klinicos_sector/heurística, o con turnera_practicas) se encolan al **reservar** (POST /turnos), no al recepcionar. La carga queda en Klinicos "pendiente de carga de token" (el paciente lo genera después). Las consultas siguen encolándose al recepcionar.

**Why:** el usuario quiere el ingreso ya cargado antes de que el paciente llegue a recepción; el robot ya soporta cargar sin token (prestación "CONFIRMADA sin autorizar").

**How to apply:**
- La cancelación/borrado del turno cancela trabajos pendiente/esperando_aprobacion/error; el worker re-chequea el estado del turno tras el claim, tras la simulación y antes de la ejecución real aprobada (nunca cargar un ingreso de turno cancelado). Un trabajo completado NO se revierte: se loguea warning para anular a mano.
- Si el token llega después (PATCH turno), se copia a los trabajos aún no cargados.
- Ojo: agendas de eco de Conectar traen al ecografista como profesional y Klinicos no lo tiene en IMAGENES S/C → trabajo en error (tarea de seguimiento: usar el efector rotado como profesional del ingreso).

**Flujo aprobado por el usuario (2-ago-2026):** para cargar una atención de consulta SIN token todavía: crear turno → POST /turnos/:id/encolar-klinicos (encolado manual) → el trabajo simula (modo asistido, queda esperando_aprobacion) → aprobar → carga real: el ingreso crea la consulta CONFIRMADA con casillero de token, sin autorizar. El token se agrega después y la autorización corre sobre esa misma consulta.

**Preparación inmediata al reservar (03-ago-2026):** encolarTrabajoAlReservar dispara procesarTrabajo fire-and-forget apenas se encola (import dinámico para evitar ciclo con el worker): la simulación + orden automática quedan listas antes de que llegue el paciente, y en el mostrador solo queda validar token y confirmar. El tick de 60 s sigue como red de seguridad.
