---
name: Cartel del token IOMA — regla única de verdad
description: Cómo se decide el cartel verde/amarillo/rojo de la validación de token en recepción
---
Regla: el frontend NUNCA decide éxito. Verde ("Token aceptado. Consulta habilitada.") SOLO si el backend persistió `consultas_token.token_status='ACCEPTED'` **y** `authorization_number` (bono) no vacío. Token guardado sin bono → amarillo "VALIDACIÓN NO CONFIRMADA"; `DENIED` → rojo.

**Why:** incidente 2-ago-2026: el cartel verde salía con solo tener `turnos.klinicos_token` seteado (la validación del token lo guarda ANTES de la autorización), mostrando "habilitada" tras un error técnico sin bono.

**How to apply:**
- `GET /turnos/:id/ingreso-consulta` expone `tokenEstado` (enum real: ACCEPTED/DENIED/…, NO "TOKEN_ACCEPTED") + `nroBono`; todas las superficies (ficha, panel, carga rápida, listado recepción) usan la misma condición.
- El branch "mismo token" de POST validar-token responde según estado persistido: bono→TOKEN_ACCEPTED, DENIED→TOKEN_DENIED, resto→TECHNICAL_ERROR reintentable. Nunca fuerza aceptado.
- Rechazo explícito de la autorización persiste DENIED en consultas_token (autorizarConTope).
- Contrato fijado en token_estado_cartel.test.ts.
- El indicador "Robot disponible" es técnico: se muestra neutro (celeste), no verde.

**Bono real pisa estados engañosos:** si la relectura de Klinicos encuentra la prestación objetivo ya autorizada (p. ej. FACTURABLE con bono, autorizada por fuera de la app), eso ES un aceptado: se persiste el bono Y se corrige token_status a ACCEPTED (limpiando failure code/message). Nunca dejar DENIED/MANUAL_REVIEW conviviendo con un bono real — el cartel jamás se pondría verde.
