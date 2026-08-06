# Guardia virtual — Guía para la app del paciente (Mi Diagnosticar)

**Para:** equipo del portal / app del paciente
**Fecha:** 05/08/2026
**Novedad:** las respuestas de la API de guardia virtual ahora incluyen textos listos para mostrar, para que el paciente sepa qué hacer en cada paso y no crea que "quemó" el token cuando algo falla.

## Endpoints (sin cambios de URL ni de autenticación)

Base: `/api/integraciones/app-paciente/videollamadas`
Autenticación: igual que hasta ahora (clave compartida por header `Authorization: Bearer …` en `/cola` y `/token`; `/status` y `/espera` siguen abiertos).

**Los campos nuevos son aditivos**: no se sacó ni se renombró nada. Si no hacen nada, todo sigue funcionando igual — pero el paciente se pierde la guía.

## Campos nuevos en las respuestas

| Campo | Tipo | Qué hacer con él |
|---|---|---|
| `mensaje` | string | Mostrarlo tal cual en pantalla. Ya viene redactado para el paciente. |
| `siguientePaso` | string | Para decidir qué pantalla/acción mostrar: `cargar_token`, `reintentar_token` o `esperar_llamado`. |
| `instrucciones` | string[] | Lista de pasos para mostrar como checklist o viñetas (cuando viene). |

## Paso a paso con ejemplos reales

### 1) El paciente se anota — `POST /cola` → 201

```json
{
  "colaId": 3,
  "estado": "en_cola",
  "posicion": 1,
  "demoraMinutos": 0,
  "guardiaAtendiendo": false,
  "horario": "Lunes a sábado de 00:00 a 23:59 hs, domingo de 12:00 a 18:00 hs",
  "siguientePaso": "cargar_token",
  "mensaje": "Listo, quedaste anotado en la guardia virtual (posición 1). Ahora generá el token en tu app de IOMA y cargalo acá para confirmar tu lugar.",
  "instrucciones": [
    "Abrí la app de IOMA y generá un token nuevo.",
    "Cargá el token acá apenas lo tengas: los tokens vencen a los pocos minutos.",
    "Con el token aceptado quedás en la fila y te avisamos cuando el médico te llame por videollamada."
  ]
}
```

**Qué mostrar:** el `mensaje` + las `instrucciones`, y llevar al paciente a la pantalla de carga de token.

Si el paciente ya estaba anotado (reintento), la respuesta viene con `repetido: true` y el `mensaje` cambia según si ya cargó el token o no; `siguientePaso` indica a qué pantalla llevarlo.

### 2) El token fue rechazado — `POST /token` → 422

```json
{
  "estado": "TOKEN_DENIED",
  "error": "El token fue rechazado ... Respuesta Klinicos: Debe indicar un token válido.",
  "reintentable": false,
  "siguientePaso": "reintentar_token",
  "mensaje": "Tranquilo: no perdiste tu lugar en la fila ni se gastó nada. Generá un token nuevo en tu app de IOMA (los tokens vencen rápido), fijate de copiarlo bien y cargalo de nuevo acá."
}
```

**Qué mostrar:** el `mensaje` bien visible (es el texto tranquilizador) y dejar el campo de token listo para reintentar. **No** mostrar solo el `error` técnico a secas.

Si el problema fue técnico (no un token inválido), `estado` viene distinto de `TOKEN_DENIED` y el `mensaje` le dice que espere unos minutos y reintente, o que se comunique con la clínica.

### 3) Token aceptado — `POST /token` → 200

```json
{
  "ok": true,
  "estado": "recepcionado",
  "colaId": 3,
  "turnoId": 50615,
  "posicion": 1,
  "demoraMinutos": 0,
  "siguientePaso": "esperar_llamado",
  "mensaje": "¡Token aceptado! Tu consulta ya quedó autorizada por IOMA y tenés tu lugar en la fila (posición 1, espera aproximada 0 min). No hace falta cargar otro token. Dejá la app abierta: te avisamos por acá cuando el médico te llame por videollamada.",
  "instrucciones": [
    "No cierres la app: el aviso de la videollamada llega por acá.",
    "Cuando sea tu turno, se va a abrir el enlace de la videollamada.",
    "Si se te corta, volvé a entrar: tu lugar queda guardado con tu DNI."
  ]
}
```

**Qué mostrar:** pantalla de espera con el `mensaje` y las `instrucciones`. A partir de acá les llegan los avisos push de siempre (`en_cola`, `tu_turno` con el enlace de la videollamada).

## Pedido de la clínica: una "sala de espera virtual" en la app

Además de mostrar los mensajes, la clínica pide que armen una **pantalla dedicada de espera** para el paso 3 (token aceptado, `siguientePaso: "esperar_llamado"`). La idea:

**Un espacio bien claro donde el paciente entra a esperar la comunicación con el médico:**
- Que el paciente sienta que "ya está adentro": un encabezado tipo *"Estás en la sala de espera de la guardia virtual"*, con su posición en la fila y la espera aproximada (vienen en la respuesta: `posicion` y `demoraMinutos`, y se pueden refrescar con `GET /espera`).
- Un aviso permanente y visible: *"No cierres la app: cuando el médico te llame, la videollamada se abre acá."*
- Cuando llega el aviso `tu_turno`, que la pantalla cambie de forma bien evidente (color, sonido/vibración) y muestre el botón para entrar a la videollamada.

**Que la espera sea didáctica y sirva para comunicar cosas de la clínica:**
- Un carrusel o feed en el centro de la pantalla donde se pueda pasar **publicidad y contenidos de la clínica**: servicios, especialidades, campañas de prevención, consejos de salud, horarios.
- Ideal que el contenido sea administrable por la clínica (aunque sea una lista simple de imágenes/textos que puedan actualizar sin publicar una app nueva).
- El contenido nunca debe tapar el aviso del llamado: si suena `tu_turno`, el llamado pisa todo.

Este espacio es de la app (Mi Diagnosticar); del lado de Conectar ya está todo lo necesario: posición y demora en las respuestas, y los avisos push de siempre.

## Resumen para la reunión

1. No hay que cambiar llamadas ni URLs: solo **mostrar** `mensaje` (+ `instrucciones` cuando viene) y usar `siguientePaso` para navegar.
2. El caso más importante es el **token rechazado**: hoy el paciente ve un error seco y cree que gastó el token. El texto nuevo le aclara que no perdió nada y que cargue uno nuevo.
3. La clínica pide una **sala de espera virtual**: pantalla dedicada de espera, clara y didáctica, con espacio para publicidad/contenidos de la clínica (ver sección anterior).
4. Cualquier duda del contrato, contactar al equipo de Conectar (este sistema).
