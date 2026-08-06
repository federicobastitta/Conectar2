# Verificación post-publicación

Después de cada publicación, correr esta verificación contra la URL publicada
para detectar roturas antes de que las descubra el personal de la clínica
(la caída del 1/8 la descubrieron ellos, no el sistema).

## Endpoint de salud

`GET /api/salud` (sin autenticación) responde:

```json
{
  "ok": true,
  "app": "ok",
  "db": { "ok": true },
  "version": "0.0.0",
  "entorno": "produccion",
  "latenciaDbMs": 12,
  "verificadoEn": "2026-08-01T12:00:00.000Z"
}
```

- HTTP **200** si la app y la base de datos responden.
- HTTP **503** si la base de datos falla (con `db.error` explicando la causa).
- Sirve tanto para chequeo manual (`curl https://<app>/api/salud`) como para
  monitores externos (UptimeRobot, cron, etc.) que alerten ante un no-200.

## Script de verificación

`artifacts/api-server/scripts/verificacion-post-publicacion.mts` corre la
batería completa: salud, frontend, login de prueba y endpoints clave.

```bash
BASE_URL=https://<app-publicada> \
VERIF_EMAIL=<usuario> VERIF_PASSWORD=<clave> \
pnpm --filter @workspace/api-server exec tsx scripts/verificacion-post-publicacion.mts
```

Qué verifica:

1. `GET /api/salud` — app y DB responden, versión reportada.
2. `GET /` — el frontend publicado devuelve HTML (pantalla no en blanco).
3. `POST /api/auth/login` — login de prueba con las credenciales dadas.
4. `GET /api/auth/me`, `/api/dashboard/resumen`, `/api/pacientes?limit=1`,
   `/api/turnos?fecha=<hoy>` — pantallas principales (dashboard, pacientes,
   turnos) responden 200 con el token.
5. Cierra la sesión de prueba (`POST /api/auth/logout`).

Sale con código `0` si todo pasó y `1` si algo falló (imprime qué),
por lo que puede engancharse a cualquier automatización.

Notas:
- Sin `VERIF_EMAIL`/`VERIF_PASSWORD` solo corre los pasos públicos (1 y 2).
- Usar un usuario real de staff (p. ej. recepción); el script no crea datos,
  solo lee.
