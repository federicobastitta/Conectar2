---
name: Llave de autoenvíos Klinicos
description: Switch global que apaga los encolados automáticos de trabajos Klinicos; el encolado manual sigue vivo.
---

# Llave de autoenvíos a Klinicos

Regla: los encolados automáticos (al reservar, al recepcionar/admitir, auto-admisión por token, reencolado de turnos futuros) pasan todos por `encolarTrabajoKlinicos(..., origen="auto")` y se frenan si `config_sistema.klinicos_autoencolado = 'off'` (cache 15 s). El encolado manual (`POST /turnos/:id/encolar-klinicos`) pasa `origen="manual"` y NUNCA se bloquea.

**Why:** el 01/08/26 Federico pidió detener todos los envíos automáticos "hasta nuevas reglas" tras acumularse 250 trabajos en error en producción (guardias sin equivalencia de especialidad, pacientes inexistentes en Klinicos, envíos con resultado desconocido). Esos 250 se pasaron a `cancelado` directo en la base prod (reversible con Reintentar) con la marca "Detenido por pedido de administración (01/08/26)".

**How to apply:**
- Estado actual (ago 2026): llave en **off** en dev y prod (fila insertada directo en conectar_app_prod; recién surte efecto cuando se publique el build que la chequea).
- UI: Configuración → Robot Klinicos, tarjeta con Switch arriba de las pestañas. API: GET/PUT `/integraciones/klinicos/autoencolado` (PUT solo admin).
- Cualquier flujo nuevo que encole trabajos Klinicos automáticamente debe usar `origen="auto"` (el default) para respetar la llave.
- Ausencia de la fila = prendido (comportamiento histórico).

## Regla vigente (02-08-2026, orden explícita del usuario)
La llave global `klinicos_autoencolado` queda **off** en dev y prod. El único
camino que habilita comunicación automática con Klinicos es el botón
**Validar Token** de recepción: si el token es aceptado y no hay atención del
robot para el paciente (últimas 24 h), `autorizarConTope` encola el ingreso con
origen "manual" (bypass de la llave) y devuelve detalle pidiendo re-validar en
unos minutos. No agregar otros disparadores automáticos sin pedido del usuario.
