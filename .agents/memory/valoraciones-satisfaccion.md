---
name: Valoraciones de atención (satisfacción)
description: Cómo funciona la calificación 1-5 del paciente y el push de invitaciones a la app
---

- Cada consulta creada (POST /hce/encounters) genera una fila en `valoraciones_atencion` con token único; la MISMA fila es la cola de envío de la invitación a la app del paciente (patrón certificados_app_envios, worker cada 30s, APP_PACIENTE_PUSH_URL/TOKEN, endpoint `/api/integracion/valoraciones`). Contrato con el portal CONFIRMADO y funcionando en prod (circuito completo verificado).
- Invitaciones salen con demora (env `VALORACIONES_DEMORA_HORAS`, default 3) y solo en ventana 10–22 hs ART (`ajustarAVentanaDeEnvio`); fuera de ventana se reprograman a las 10:00. `POST /valoraciones/enviar-ahora` (admin, fuera de OpenAPI) adelanta todas las pendientes para pruebas.
- La app responde por API pública: GET/POST `/api/publico/valoraciones/:token` y GET `.../:token/estado` (x-api-key). La app verifica `/estado` antes de mostrar el formulario y descarta la invitación ante 404/409 — mantener esos códigos estables. El POST es un update condicional atómico (`WHERE token AND puntaje IS NULL`) → 201 una sola vez, 409 después; CHECK 1..5 en DB.
- **Why:** el pre-check SELECT+UPDATE permitía doble calificación en concurrencia (lo marcó el review); la escritura debe ser atómica.
- El tablero del médico muestra `satisfaccion` (promedio, respuestas, invitaciones, últimos 5 comentarios) en GET /consultorio/produccion.
- Tabla creada por migración idempotente al arrancar (`migrarValoracionesAtencion`) → prod se migra sola al publicar.
