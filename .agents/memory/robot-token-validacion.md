---
name: Validación de token IOMA — interna
description: El automatizador interno de Conectar valida el token directo contra Klinicos; el Robot externo queda solo de respaldo legado.
---

## Decisión (01/08/2026)
La validación de token la resuelve el automatizador INTERNO (`internoTokenValidationProvider` → `validarTokenConsultaKlinicos(dni, token)`), no el Robot externo. Se activa sola cuando existen credenciales `KLINICOS_USUARIO`/`KLINICOS_PASSWORD` (`validacionInternaDisponible()`); el proveedor externo (ROBOT_API_URL + flag `KLINICOS_TOKEN_VALIDATION_ENABLED`) queda solo como respaldo si no hay credenciales.
**Why:** el usuario decidió retirar el Robot externo ("antes iba al robot de klinicos, ahora lo resolvemos nosotros"); el equipo del robot viejo aún no fue notificado.

## Cómo valida el interno
- Llamada de SOLO LECTURA a `/ordenPrestacion/validarDatosObraSocialPaciente` (misma XHR que la pantalla de nueva atención de Klinicos); no crea nada.
- Mapeo: `ok && valido` → TOKEN_ACCEPTED (mensaje + afiliado); `ok && !valido` → TOKEN_DENIED (mensaje textual de Klinicos al cartel rojo); `!ok` → TECHNICAL_ERROR (reintentable); `requiereCargaManual` (paciente inexistente en Klinicos o sin obra social) → MANUAL_REVIEW, NO reintentable — evita loops de reintento por condiciones de datos persistentes.
- Con validación activa (interna O externa), `ingreso-consulta` sigue bloqueando el guardado directo del token: el gate contempla ambas.
- `referenciaKlinicos` viene null en el camino interno (no hay bono en la validación); el flujo aceptado (consultas_token, turno.klinicosToken, recepción automática) lo tolera.

## Pendiente conocido
- El semáforo `/robot-klinicos/estado` en modo interno reporta "disponible" solo por presencia de credenciales, sin probar login real: puede mostrar verde con credenciales vencidas.

## Reglas que siguen vigentes del contrato viejo
- Solo ACCEPTED habilita la consulta; TECHNICAL_ERROR/TIMEOUT no son denegaciones (reintento mismo request_id; auto-retry en el hook use-validar-token-reintento).
- Nunca loguear/persistir el token sin enmascarar en logs/audit_log; `consultas_token.token_completo` guarda el token completo (pedido de la clínica, jul 2026) y el reporte admin usa COALESCE(token_completo, token_masked).
- El token vale solo el día de la atención (409 si el turno es de otro día).

**HALLAZGO CRÍTICO (2-ago-2026, confirmado por experimento):** /ordenPrestacion/validarDatosObraSocialPaciente con OSToken NO es solo-lectura: IOMA CONSUME el token en esa llamada. Cuatro tokens rebotaron con "ya fue utilizado" porque la validación previa los quemaba antes de la autorización. Autorización directa sin validación previa → bono 18409970 a la primera (C-2026-199551). Regla: el token debe viajar a IOMA UNA sola vez, directo a autorizar-prestacion; la verificación previa debe ir sin token o eliminarse.

**Circuito e2e confirmado en prod (2-ago-2026):** con el token viajando una sola vez, la prueba real dio bono a la primera (token → autorización directa → bono → ACCEPTED persistido → cartel verde). El circuito completo (turno → carga automática → token → bono) queda validado en producción.
