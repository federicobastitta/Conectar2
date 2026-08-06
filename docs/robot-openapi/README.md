# OpenAPI del Robot Klinicos (pendiente)

Carpeta preparada para recibir el **OpenAPI definitivo del Robot** (Centro de
Control Klinicos). Cuando el equipo del Robot lo entregue, guardarlo acá como:

```
docs/robot-openapi/robot-openapi.yaml
```

## Procedimiento acordado (NO modificar el circuito productivo antes)

1. **Comparar primero**: contrastar el spec contra lo ya implementado en
   `artifacts/api-server/src/integraciones/robot-cliente.ts` (token/validate,
   token/requests/{id}, health) y el esqueleto de
   `robot-consultas.ts` (consultations/process).
2. **Informe de compatibilidad** para el usuario ANTES de tocar código
   productivo: rutas coincidentes/divergentes, campos faltantes, diferencias de
   nombres, enums de estado nuevos, cambios necesarios de nuestro lado.
3. Recién con el visto bueno: generar tipos y actualizar el cliente.

## Generación de tipos (cuando llegue el spec)

Tipos TypeScript solo-backend (la clave X-Api-Key nunca sale del api-server):

```bash
pnpm --filter @workspace/api-server exec openapi-typescript docs/robot-openapi/robot-openapi.yaml \
  -o src/integraciones/generated/robot-api.d.ts
```

(`openapi-typescript` se agrega como devDependency del api-server recién en ese
momento; no está instalado todavía.)

## Reglas del circuito consultations/process (acordadas 19-jul-2026)

- Flag independiente `KLINICOS_CONSULTATIONS_PROCESS_ENABLED=false` (separado
  de `KLINICOS_TOKEN_VALIDATION_ENABLED`).
- Idempotencia por `request_id`; reintentos reutilizan el mismo.
- Aislamiento de paciente: solo datos del paciente del turno.
- **NO enviar médico, matrícula ni especialidad**: Conectar envía la práctica
  (`practice.id`, código, descripción, catálogo) y el Robot deriva la
  especialidad y elige el profesional en KLINICOS.
- El Robot NUNCA crea pacientes: si no existe en Klinicos, el trabajo falla y
  lo carga a mano recepción/administración.

## Sondeo de endpoints del Robot (19-jul-2026)

Base: `ROBOT_API_URL` (host `web-automation-bot.replit.app`).

| Ruta | Resultado |
|------|-----------|
| `GET /api` | 200 `{"status":"ok"}` |
| `GET /api/v1/klinicos/health` | 200 — `robot_available:true`, `klinicos_reachable:true`, `session_active:true`, `version:1.0.0` |
| `POST /api/v1/klinicos/token/validate` | **400 "Falta request_id"** → el endpoint YA está publicado |
| `GET /api/v1/klinicos/token/requests/{id}` | 404 JSON `{"error":"request_id no encontrado"}` → publicado; 404 = id inexistente |
| `POST /api/v1/klinicos/consultations/process` | **404 "Cannot POST"** → todavía NO publicado |

Conclusión del 404: nuestras rutas de token están bien; el 404 que veíamos era
del polling con request_id inexistente y de `consultations/process` (aún no
publicado). **No cambiar rutas hasta que el Robot confirme URL base y
endpoints definitivos.**
