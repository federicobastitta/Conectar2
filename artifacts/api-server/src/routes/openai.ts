import { randomUUID } from "node:crypto";
import { Router, type Request, type Response, type NextFunction } from "express";
import { eq, asc } from "drizzle-orm";
import {
  db,
  conversations,
  messages,
  especialidadesTable,
  sedesTable,
} from "@workspace/db";
import { openai } from "@workspace/integrations-openai-ai-server";

const router = Router();

// ── Abuse protection ───────────────────────────────────────────────────────

const MAX_MESSAGE_LENGTH = 2000;
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX_REQUESTS = 20;

const rateBuckets = new Map<string, { count: number; resetAt: number }>();

setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of rateBuckets) {
    if (bucket.resetAt <= now) rateBuckets.delete(key);
  }
}, RATE_LIMIT_WINDOW_MS).unref();

function rateLimit(req: Request, res: Response, next: NextFunction): void {
  const key = req.ip ?? "unknown";
  const now = Date.now();
  const bucket = rateBuckets.get(key);

  if (!bucket || bucket.resetAt <= now) {
    rateBuckets.set(key, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    next();
    return;
  }

  bucket.count += 1;
  if (bucket.count > RATE_LIMIT_MAX_REQUESTS) {
    res
      .status(429)
      .json({ error: "Demasiadas solicitudes. Esperá un momento e intentá de nuevo." });
    return;
  }
  next();
}

async function findAuthorizedConversation(
  req: Request
): Promise<{ id: number; title: string } | null> {
  const id = Number(req.params.id);
  const token = req.get("x-conversation-token");
  if (!Number.isInteger(id) || !token) return null;

  const [conv] = await db
    .select()
    .from(conversations)
    .where(eq(conversations.id, id));

  if (!conv || conv.token !== token) return null;
  return conv;
}

async function buildAsistenteSystemPrompt(): Promise<string> {
  const [espRows, sedeRows] = await Promise.all([
    db.select({ nombre: especialidadesTable.nombre }).from(especialidadesTable),
    db
      .select({ nombre: sedesTable.nombre, direccion: sedesTable.direccion })
      .from(sedesTable),
  ]);

  const espList = espRows.length
    ? espRows.map((e) => e.nombre).join(", ")
    : "consultar con recepción";

  const sedesList = sedeRows.length
    ? sedeRows
        .map((s) => `${s.nombre}${s.direccion ? ` (${s.direccion})` : ""}`)
        .join(" | ")
    : "consultar con recepción";

  const today = new Date().toLocaleDateString("es-AR", {
    weekday: "long",
    day: "numeric",
    month: "long",
  });

  return `Sos el Asistente Virtual de Diagnosticar, una red clínica digital argentina. Hoy es ${today}.

ESPECIALIDADES DISPONIBLES: ${espList}
SEDES: ${sedesList}

REGLAS ESTRICTAS:
- Respondé SIEMPRE en español argentino, tuteo, empático y simple
- Frases cortas (máx 3-4 oraciones). Pensá en personas mayores o con poca experiencia digital
- NUNCA das diagnósticos médicos ni interpretás síntomas
- Para síntomas graves o urgencias: "Por una urgencia llamá al 107 o dirigite a la guardia más cercana"
- Para ver informes, resultados o datos médicos personales: "Para eso necesitás ingresar a tu cuenta"
- Para cancelar/reprogramar turnos: "Podés hacerlo desde 'Mis Turnos' en la app"
- Si no podés resolver: "Podés contactar recepción por WhatsApp o llamando a tu sede"

CUANDO EL PACIENTE QUIERE SACAR UN TURNO:
1. Identificá la especialidad más adecuada de la lista ESPECIALIDADES DISPONIBLES
2. Confirmala con el paciente en tu respuesta
3. Al FINAL de tu respuesta (en línea nueva) incluí exactamente:
##ACCION##{"tipo":"reservar","especialidad":"NOMBRE_EXACTO","label":"Ver turnos disponibles"}

Ejemplo — paciente dice "me duele la rodilla":
"Para dolor de rodilla lo mejor es Traumatología. ¿Querés ver los horarios disponibles?"
##ACCION##{"tipo":"reservar","especialidad":"Traumatología","label":"Ver turnos disponibles"}

IMPORTANTE:
- Solo usá especialidades de la lista ESPECIALIDADES DISPONIBLES, en su nombre exacto
- No inventes horarios, médicos ni disponibilidad específica que no conozcas
- Tono: cercano, como un recepcionista amable y profesional`;
}

async function buildCopilotoSystemPrompt(
  espRows: Array<{ nombre: string }>
): Promise<string> {
  return `Sos el copiloto IA de recepción de Diagnosticar, una red clínica argentina.
Analizás el motivo de consulta del paciente y determinás qué especialidad necesita.

ESPECIALIDADES DISPONIBLES (solo estas, nombres exactos): ${espRows.map((e) => e.nombre).join(", ")}

Respondé ÚNICAMENTE con un JSON válido en este formato, sin texto adicional:
{
  "especialidadSugerida": "nombre exacto de la especialidad principal",
  "especialidadesAlternativas": ["alternativa 1", "alternativa 2"],
  "razonamiento": "explicación breve de 1 oración de por qué esa especialidad",
  "sugerencias": []
}

Reglas:
- Solo usá especialidades de la lista
- Si hay varias opciones razonables, poné la más probable como sugerida y las demás como alternativas
- Si no hay coincidencia clara, elegí la más cercana y explicalo en razonamiento`;
}

// ── Conversations (token-scoped, sin listado global) ──────────────────────

router.post("/openai/conversations", rateLimit, async (req, res): Promise<void> => {
  try {
    const { title } = req.body as { title?: string };
    const token = randomUUID();
    const [conv] = await db
      .insert(conversations)
      .values({ title: (title ?? "Conversación").slice(0, 200), token })
      .returning();
    res.status(201).json({ id: conv.id, title: conv.title, token: conv.token });
  } catch (err) {
    req.log.error({ err }, "Error creating conversation");
    res.status(500).json({ error: "Error al crear conversación" });
  }
});

router.get("/openai/conversations/:id", rateLimit, async (req, res): Promise<void> => {
  try {
    const conv = await findAuthorizedConversation(req);
    if (!conv) {
      res.status(404).json({ error: "Conversación no encontrada" });
      return;
    }
    const msgs = await db
      .select()
      .from(messages)
      .where(eq(messages.conversationId, conv.id))
      .orderBy(asc(messages.createdAt));
    res.json({ id: conv.id, title: conv.title, messages: msgs });
  } catch (err) {
    req.log.error({ err }, "Error getting conversation");
    res.status(500).json({ error: "Error al obtener conversación" });
  }
});

router.delete("/openai/conversations/:id", rateLimit, async (req, res): Promise<void> => {
  try {
    const conv = await findAuthorizedConversation(req);
    if (!conv) {
      res.status(404).json({ error: "Conversación no encontrada" });
      return;
    }
    await db.delete(messages).where(eq(messages.conversationId, conv.id));
    await db.delete(conversations).where(eq(conversations.id, conv.id));
    res.status(204).end();
  } catch (err) {
    req.log.error({ err }, "Error deleting conversation");
    res.status(500).json({ error: "Error al eliminar conversación" });
  }
});

// ── Streaming message endpoint ─────────────────────────────────────────────

router.post(
  "/openai/conversations/:id/messages",
  rateLimit,
  async (req, res): Promise<void> => {
    const { content } = req.body as { content?: unknown };

    try {
      if (typeof content !== "string" || !content.trim()) {
        res.status(400).json({ error: "El mensaje no puede estar vacío" });
        return;
      }
      if (content.length > MAX_MESSAGE_LENGTH) {
        res.status(400).json({ error: "El mensaje es demasiado largo" });
        return;
      }

      const conv = await findAuthorizedConversation(req);
      if (!conv) {
        res.status(404).json({ error: "Conversación no encontrada" });
        return;
      }
      const id = conv.id;

      await db
        .insert(messages)
        .values({ conversationId: id, role: "user", content });

      const history = await db
        .select()
        .from(messages)
        .where(eq(messages.conversationId, id))
        .orderBy(asc(messages.createdAt));

      const systemPrompt = await buildAsistenteSystemPrompt();

      const chatMessages: Array<{
        role: "system" | "user" | "assistant";
        content: string;
      }> = [
        { role: "system", content: systemPrompt },
        ...history.map((m) => ({
          role: m.role as "user" | "assistant",
          content: m.content,
        })),
      ];

      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");

      let fullResponse = "";

      const stream = await openai.chat.completions.create({
        model: "gpt-5.4-mini",
        max_completion_tokens: 512,
        messages: chatMessages,
        stream: true,
      });

      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta?.content;
        if (delta) {
          fullResponse += delta;
          res.write(`data: ${JSON.stringify({ content: delta })}\n\n`);
        }
      }

      await db
        .insert(messages)
        .values({ conversationId: id, role: "assistant", content: fullResponse });

      res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
      res.end();
    } catch (err) {
      req.log.error({ err }, "Error in chat stream");
      if (!res.headersSent) {
        res.status(500).json({ error: "Error al procesar mensaje" });
      } else {
        res.write(
          `data: ${JSON.stringify({ error: "Error al procesar" })}\n\n`
        );
        res.end();
      }
    }
  }
);

// ── Copiloto recepción ─────────────────────────────────────────────────────

router.post("/ai/copiloto", rateLimit, async (req, res): Promise<void> => {
  const { consulta } = req.body as {
    consulta?: unknown;
    sedeId?: number;
    fecha?: string;
  };

  try {
    if (typeof consulta !== "string" || !consulta.trim()) {
      res.status(400).json({ error: "La consulta no puede estar vacía" });
      return;
    }
    if (consulta.length > MAX_MESSAGE_LENGTH) {
      res.status(400).json({ error: "La consulta es demasiado larga" });
      return;
    }

    const espRows = await db
      .select({ nombre: especialidadesTable.nombre })
      .from(especialidadesTable);

    const systemPrompt = await buildCopilotoSystemPrompt(espRows);

    const response = await openai.chat.completions.create({
      model: "gpt-5.4-mini",
      max_completion_tokens: 300,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: consulta },
      ],
    });

    const rawJson = response.choices[0]?.message?.content ?? "{}";

    let parsed: {
      especialidadSugerida?: string;
      especialidadesAlternativas?: string[];
      razonamiento?: string;
      sugerencias?: unknown[];
    };

    try {
      parsed = JSON.parse(rawJson);
    } catch {
      parsed = {
        especialidadSugerida: "Medicina General",
        especialidadesAlternativas: [],
        razonamiento:
          "No se pudo determinar la especialidad. Consultar con el paciente.",
        sugerencias: [],
      };
    }

    res.json({
      especialidadSugerida: parsed.especialidadSugerida ?? "",
      especialidadesAlternativas: parsed.especialidadesAlternativas ?? [],
      razonamiento: parsed.razonamiento ?? "",
      sugerencias: [],
    });
  } catch (err) {
    req.log.error({ err }, "Error in copiloto");
    res.status(500).json({ error: "Error al consultar el copiloto" });
  }
});

export default router;
