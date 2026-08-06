# Disponibilidad de turnos — contrato para la app Mi Diagnosticar

Endpoints para consultar los horarios disponibles de una agenda (turnera) antes de
ofrecer opciones al paciente. Todos requieren el header `x-api-key` con la clave
compartida (`API_PUBLICA_KEY`).

Base URL (producción): `https://clinic-core-suite.replit.app/api`

---

## 1. Slots por fecha individual

```
GET /publico/turneras/{id}/disponibilidad/{fecha}
```

Devuelve todos los slots de la agenda para una fecha específica (incluyendo los
ya ocupados, marcados como `disponible: false`).

### Parámetros de path

| Param  | Tipo   | Descripción                        |
|--------|--------|------------------------------------|
| `id`   | entero | ID de la agenda (turnera)          |
| `fecha`| string | Fecha en formato `YYYY-MM-DD`      |

### Respuesta 200

Array de slots. Cada elemento:

```json
[
  { "turneraId": 12, "fecha": "2026-09-02", "horaInicio": "08:00", "horaFin": "08:30", "disponible": true,  "turnoId": null },
  { "turneraId": 12, "fecha": "2026-09-02", "horaInicio": "08:30", "horaFin": "09:00", "disponible": false, "turnoId": 4871 }
]
```

- `disponible: false` significa que el horario ya tiene un turno activo.
- Si la agenda no atiende ese día de la semana, devuelve `[]`.
- Horarios ya pasados (hora argentina) se omiten directamente.

### Errores

| Código | Descripción                                          |
|--------|------------------------------------------------------|
| 400    | Formato de fecha inválido                            |
| 401    | Clave de API inválida o faltante                     |
| 404    | Agenda no encontrada, inactiva o sin reserva online  |

---

## 2. Slots por rango de fechas ← **nuevo**

```
GET /publico/turneras/{id}/disponibilidad?fechaDesde=YYYY-MM-DD&fechaHasta=YYYY-MM-DD
```

Devuelve los slots agrupados por fecha para un rango de hasta 31 días. Ideal para
pintar un picker de calendario mostrando qué días tienen turnos disponibles.

### Parámetros de path

| Param | Tipo   | Descripción               |
|-------|--------|---------------------------|
| `id`  | entero | ID de la agenda (turnera) |

### Query params

| Param        | Tipo   | Obligatorio | Descripción                                              |
|--------------|--------|-------------|----------------------------------------------------------|
| `fechaDesde` | string | sí          | Inicio del rango, inclusive. Formato `YYYY-MM-DD`.       |
| `fechaHasta` | string | sí          | Fin del rango, inclusive. Formato `YYYY-MM-DD`.          |

Restricciones:
- `fechaHasta` debe ser ≥ `fechaDesde`.
- El rango no puede superar 31 días (400 si se supera).

### Respuesta 200

```json
{
  "fechaDesde": "2026-09-01",
  "fechaHasta": "2026-09-30",
  "dias": {
    "2026-09-02": [
      { "horaInicio": "08:00", "horaFin": "08:30", "disponible": true  },
      { "horaInicio": "08:30", "horaFin": "09:00", "disponible": false }
    ],
    "2026-09-09": [
      { "horaInicio": "08:00", "horaFin": "08:30", "disponible": true  }
    ]
  }
}
```

- Solo aparecen fechas con al menos un slot futuro; días sin atención (la agenda
  no tiene horario ese día de la semana) y fechas completamente pasadas se omiten.
- `disponible: false` significa horario ya ocupado.
- `turnoId` **no se expone** en este endpoint.

### Errores

| Código | Descripción                                                    |
|--------|----------------------------------------------------------------|
| 400    | Formato inválido, `fechaHasta < fechaDesde`, o rango > 31 días |
| 401    | Clave de API inválida o faltante                               |
| 404    | Agenda no encontrada, inactiva o sin reserva online            |

### Ejemplo de uso

```
GET /api/publico/turneras/12/disponibilidad?fechaDesde=2026-09-01&fechaHasta=2026-09-30
x-api-key: <clave>
```

---

## Cómo descubrir los IDs de agenda

Usar el catálogo público (también con `x-api-key`):

```
GET /publico/turneras?sedeId=1&especialidadId=5
```

Devuelve agendas activas con reserva online. Cada elemento tiene `id` (turneraId),
`nombre`, `diasAtencion`, `horaInicio`, `horaFin`, `duracionMinutos`, etc.

---

## Notas importantes

- Los horarios se calculan en hora **argentina (America/Argentina/Buenos_Aires)**.
  El servidor descarta automáticamente slots que ya pasaron.
- Un slot `disponible: false` no se puede reservar vía `POST /publico/turnos`.
  Si se intenta, el servidor responde `409 cupo_tomado`.
- Para verificar disponibilidad inmediatamente antes de confirmar una reserva,
  usar el endpoint por fecha individual (es más liviano y exacto).
