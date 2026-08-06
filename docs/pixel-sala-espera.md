# Consulta de sala de espera para Pixel (PACS)

Endpoint de solo lectura para que Pixel consulte cuánta gente hay en sala de espera por agenda y lo publique en sus salas de admisión.

## Endpoint

```
GET https://diagnosticar-clinic-portal.replit.app/api/pacs/sala-espera
Authorization: Bearer <token>
```

- **Token:** el mismo token compartido de la integración PACS (`PACS_API_TOKEN` / `PACS_WORKLIST_TOKEN`). Sin token válido responde `401`; si la integración no está configurada, `503`.
- **Sin datos de pacientes:** la respuesta trae solo conteos y datos de la agenda (nombre, sede, profesional, especialidad). No expone nombres ni DNI.
- **Zona horaria:** "hoy" se calcula en hora argentina.

## Respuesta

```json
{
  "fecha": "2026-07-25",
  "horaLocal": "10:32",
  "totalEnSalaDeEspera": 7,
  "agendas": [
    {
      "turneraId": 12,
      "agenda": "Ergometría - Central",
      "sede": "Central- Berazategui",
      "profesional": "Pérez, Ana",
      "especialidad": "Cardiología",
      "enSalaDeEspera": 4,
      "llamados": 1,
      "enAtencion": 1
    }
  ]
}
```

## Semántica de los conteos

| Campo | Estados del turno que cuenta |
|---|---|
| `enSalaDeEspera` | `arribo` (llegó y se recepcionó) + `en_sala` (admitido) |
| `llamados` | `llamado` (el médico lo llamó) |
| `enAtencion` | `en_atencion` (está con el médico) |

Solo se listan agendas que hoy tienen al menos un turno en alguno de esos estados, ordenadas por `enSalaDeEspera` descendente. Se recomienda sondear cada 30–60 segundos.
