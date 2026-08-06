# Guía práctica para entrenar el chatbot del portal del paciente

Escrita desde la experiencia de construir el Asistente de Recepción de Conectar (el sistema interno de la clínica). Está pensada para que el equipo la pueda aplicar directo, sin importar qué tecnología usen.

---

## 1. Lo más importante: el bot no se "capacita", se instruye

Un chatbot moderno no aprende con el uso como un empleado. Lo que lo hace bueno o malo es **el texto de instrucciones que tiene adentro** (el "prompt del sistema") y **a qué datos reales puede acceder**. Si el bot responde mal, casi siempre el arreglo es corregir las instrucciones, no "entrenarlo más".

Consejos para las instrucciones:

- Escribirlas como si le explicaran el trabajo a un empleado nuevo el primer día: qué hace, qué NO hace, y qué tono usa.
- Ser concretos: "respondé en una sola frase corta", "nunca inventes horarios", "si no sabés, decí que no sabés y ofrecé derivar a recepción".
- Definir el idioma y el tono: español rioplatense, simple, sin tecnicismos médicos.

## 2. Cuidado con los ejemplos: el bot los copia como si fueran reales

Error que nos pasó de verdad: le pusimos en las instrucciones un ejemplo — *"si el paciente pide 'jueves a la tarde', filtrá por jueves y tarde"* — y el bot empezó a filtrar por jueves a la tarde **aunque nadie lo hubiera pedido**.

Regla: cada vez que den un ejemplo, aclaren al lado: **"esto es solo un ejemplo; si el usuario no lo pidió, no lo apliques"**.

## 3. Conectarlo a datos reales, nunca dejarlo "adivinar"

Un bot sin conexión a los datos reales **inventa** con total seguridad: turnos que no existen, horarios de atención falsos, direcciones equivocadas. Eso en salud es grave.

- Todo dato que el bot diga (turnos disponibles, sedes, horarios, estudios) tiene que salir de una **consulta en vivo** al sistema (lo que técnicamente se llama "tools" o "function calling").
- En las instrucciones, prohibirlo explícitamente: *"nunca menciones un horario, precio o dirección que no venga de una consulta al sistema"*.
- Si la consulta no devuelve nada, el bot debe decir "no encontré turnos" — nunca rellenar.

## 4. Respuestas cortas + botones, no párrafos

Los pacientes no leen párrafos largos. Lo que mejor nos funcionó:

- El bot responde **una frase corta** y las opciones aparecen como **botones tocables** (por ejemplo, 4 turnos, uno por día).
- Prohibir en las instrucciones que repita en texto lo que ya se ve en los botones (si no, duplica todo).
- Limitar las opciones: 4 botones se entienden; 12 marean.

## 5. Ponerle límites claros (esto es una clínica)

En las instrucciones, dejar escrito:

- **Nunca dar consejo médico** ni interpretar estudios: siempre derivar al profesional o a la guardia.
- Ante síntomas de urgencia (dolor de pecho, dificultad para respirar, etc.): cortar la conversación normal e indicar guardia/emergencias.
- No pedir ni repetir datos sensibles de más. Verificar la identidad (por ejemplo DNI) antes de mostrar datos de un paciente.
- Si el paciente se frustra o pide hablar con una persona: derivar a recepción sin insistir.

## 6. Cómo probarlo (la parte que casi todos salteamos)

- Probar con **frases reales de pacientes**, mal escritas y todo: "nesecito un eco de avdomen", "tenes turno para el dr frontini?", "cuanto sale".
- Probar los casos donde **no hay** respuesta: práctica que no existe, agenda llena, paciente no registrado. Ahí es donde los bots inventan.
- Cada vez que cambien las instrucciones, repetir las mismas 10-15 preguntas de prueba para ver que no se rompió lo que ya andaba.
- Guardar las conversaciones reales y revisarlas cada semana: las respuestas malas de verdad son la mejor lista de tareas.

## 7. Empezar chico

No intenten que haga todo de entrada. Orden que recomendamos:

1. Responder preguntas fijas (sedes, horarios de atención, preparaciones de estudios) — casi sin riesgo.
2. Consultar turnos existentes del paciente.
3. Ofrecer y reservar turnos nuevos (recién cuando lo anterior funcione perfecto).

Cada paso se prueba bien antes de pasar al siguiente.

---

## 8. Los datos de las turneras: ya tienen una API lista para el chatbot

El chatbot **no necesita una base de datos propia ni copias de las agendas**: Conectar ya expone una API pública pensada para el portal del paciente, con los datos reales y al instante. Es la misma que usa la app del paciente.

**Cómo se accede**: todas las llamadas van a la app publicada de Conectar, bajo `/api/publico/...`, con el header `x-api-key` (la clave ya la tiene el equipo del portal; si no, Federico se las pasa — no va en este documento).

Lo que el chatbot puede consultar y hacer:

| Necesidad del chatbot | Endpoint |
|---|---|
| Listar sedes | `GET /api/publico/sedes` |
| Listar especialidades | `GET /api/publico/especialidades` |
| Listar profesionales | `GET /api/publico/profesionales` |
| Listar agendas (turneras) activas | `GET /api/publico/turneras` |
| Guardias del día | `GET /api/publico/guardias` |
| Horarios libres de una agenda en un día | `GET /api/publico/turneras/:id/disponibilidad/:fecha` |
| Horarios libres en un rango de fechas | `GET /api/publico/turneras/:id/disponibilidad` (con fechas desde/hasta) |
| Turnos existentes de un paciente | `GET /api/publico/turnos` (por DNI) |
| Reservar un turno | `POST /api/publico/turnos` (usar header `Idempotency-Key` para que un doble toque no cree dos turnos) |
| Cancelar un turno | `POST /api/publico/turnos/:id/cancelar` (con el DNI del paciente) |
| Reprogramar un turno | `POST /api/publico/turnos/:id/reprogramar` |
| Dar de alta un paciente | `POST /api/publico/pacientes` |
| Consultar cobertura del paciente | `GET /api/publico/pacientes/cobertura` |
| Validar el token de obra social del turno | `POST /api/publico/turnos/:id/validar-token` |
| Ver la fila: cuántos pacientes tiene adelante (solo con check-in hecho) | `GET /api/publico/turnos/:id/fila?dni=...` |

Reglas de oro para el bot con estos datos:

- **Disponibilidad siempre en vivo**: consultar la disponibilidad justo antes de ofrecer y de reservar. Nunca guardar horarios "de ayer".
- Si la reserva devuelve un error de "horario ocupado" (alguien lo tomó un segundo antes), el bot vuelve a consultar y ofrece otros — no reintenta a ciegas.
- **Siempre verificar por DNI** antes de mostrar o tocar turnos de un paciente.
- Los turnos ofrecidos deben salir solo de lo que la API devuelve: si no hay, decir "no hay turnos" y ofrecer otras fechas o agendas.

## Resumen en una línea

**Instrucciones concretas + datos siempre reales + respuestas cortas con botones + límites de seguridad + pruebas con frases de pacientes de verdad.** Con eso el bot madura rápido.

*Cualquier duda puntual (una respuesta que salió mal, cómo redactar una instrucción), mándenla con el ejemplo concreto y la corregimos.*
