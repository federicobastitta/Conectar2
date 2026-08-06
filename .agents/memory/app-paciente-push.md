---
name: Push de certificados a la app del paciente
description: Cola saliente de certificados hacia el portal del paciente (Diagnosticar Clinic); contrato propuesto y activación por env vars
---

Los certificados se encolan SIEMPRE al emitirse (tabla `certificados_app_envios`, misma mecánica que robot-ordenes: unique por certificado, backoff, error_permanente). El worker corre siempre pero solo envía cuando existen `APP_PACIENTE_PUSH_URL` + `APP_PACIENTE_PUSH_TOKEN` — al configurarlas, todo lo encolado sale solo, sin tocar código.

**Contrato confirmado y funcionando (jul 2026; portal publicado en https://diagnosticar-clinic-portal.replit.app, status sin token en GET /api/integracion/certificados/status):** `POST {URL}/api/integracion/certificados`, Bearer token, body con dni/tipo/diagnostico/diasReposo/fechaEmision/profesional/matricula/codigoVerificacion/pdfBase64; idempotencia del lado del portal por codigoVerificacion. Si el otro proyecto cambia el contrato, ajustar `integraciones/app-paciente-certificados.ts`.

**Indicaciones (plan de atención, jul 2026):** mismo diseño espejado en `integraciones/app-paciente-indicaciones.ts` (cola `indicaciones_app_envios`, tabla `indicaciones_pacientes`). Contrato: `POST {URL}/api/integracion/indicaciones` con {dni, fechaEmision, profesional, matricula, codigoVerificacion, estudios, medicamentos, otrasIndicaciones, pdfBase64}. Las indicaciones se ARMAN SOLAS: cada receta/orden/interconsulta agrega su línea a la indicación única del día (upsert atómico ON CONFLICT sobre patient+professional+fecha) y reencola el push con reenviar:true, por eso el portal debe hacer UPSERT por codigoVerificacion (no ignorar duplicados). PENDIENTE: el portal debe implementar ese endpoint (los primeros envíos quedaron en error_permanente por 404; reencolar cuando esté online). Los endpoints de emisión/preview exigen alcance médico (`puedeLeerPaciente`), no solo rol.

**Autologin por WhatsApp (ago 2026):** el portal del paciente es un proyecto Replit APARTE del mismo usuario e identifica pacientes por DNI. Contrato acordado: la clínica genera un código de un solo uso y manda el link apuntando al portal; el portal valida el código contra la API de la clínica (clave compartida, mismo esquema que el push) y la respuesta de verificación debe devolver el **DNI y el teléfono** del paciente. Si el código valida, el portal debe SALTEAR su login normal (crear la sesión directo con esos datos); la exigencia de seguridad queda del lado del código: un solo uso + vencimiento corto. La implementación del lado del portal se hace en ese otro proyecto.

**Why:** el usuario pidió envío automático al portal del paciente identificado por DNI; el portal aún no tenía endpoint, por eso el diseño "encolar ya, activar después".

**How to apply:** respuestas de error del portal se redactan antes de loguear/persistir (dígitos 7+ enmascarados, pdfBase64 redactado) — mantener esa regla en cualquier integración nueva con datos de pacientes.
