# Autologin del paciente por link mágico — contrato para la app Mi Diagnosticar

La app del paciente (diagnosticar-clinic-portal) recibe links del tipo:

    https://diagnosticar-clinic-portal.replit.app/ingreso/<CODIGO>

donde `<CODIGO>` es un token opaco permanente y reutilizable generado por Conectar
(el sistema de la clínica). Al abrir ese link, la app debe loguear al paciente
automáticamente y dejarlo en su pantalla de inicio, sin pedirle usuario ni clave.

## Qué tiene que hacer la app del paciente

1. Crear la ruta `GET /ingreso/:codigo` (frontend).
2. Su backend valida el código llamando de servidor a servidor a Conectar:

   POST https://clinic-core-suite.replit.app/api/integraciones/app-paciente/autologin
   Headers:
     Authorization: Bearer <APP_PACIENTE_PUSH_TOKEN>   ← la misma clave compartida que ya usa para el push de certificados
     Content-Type: application/json
   Body:
     { "codigo": "<CODIGO del link>" }

3. Respuestas:
   - 200 → `{ "ok": true, "dni": "...", "telefono": "... | null", "nombre": "...", "apellido": "..." }`
     Con esos datos la app crea (o encuentra) al paciente y le abre sesión,
     redirigiendo a la pantalla de inicio.
   - 410 → `{ "ok": false, "motivo": "invalido" | "vencido" | "usado" }`
     Mostrar un mensaje simple ("El link no es válido, pedí uno nuevo en la clínica")
     y ofrecer el ingreso normal.
   - 401 → clave compartida incorrecta (revisar el secret).

## Importante

- El código es **reutilizable**: el mismo link le sirve al paciente todas las veces
  (es su llave personal; la app puede canjearlo en cada apertura si no tiene sesión).
- Nunca loguear al paciente confiando solo en el link: siempre validar contra Conectar.
- No mostrar ni guardar el código en logs.
