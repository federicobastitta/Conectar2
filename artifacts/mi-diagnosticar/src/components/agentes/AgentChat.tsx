/**
 * AgentChat — Widget flotante de IA contextual por rol
 *
 * Se monta en el AppLayout y permanece visible en toda la app autenticada.
 * El agente disponible depende del rol del usuario:
 *   admin        → Admin + Recepción + Médico (selector)
 *   recepcionista → solo Recepción
 *   medico       → Médico + Recepción (selector)
 *   paciente     → Paciente
 */

import { useState, useRef, useEffect, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useToast } from "@/hooks/use-toast";
import {
  Bot, X, Send, Loader2, ChevronDown, Headset,
  Stethoscope, BarChart3, UserCircle, RotateCcw,
  Minimize2, Maximize2, Sparkles,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { fraseAleatoria } from "./frases-manuel";

// Cada cuánto Manuel tira un comentario gracioso (30 minutos)
const INTERVALO_FRASE_MS = 30 * 60 * 1000;
// La primera frase aparece a los 45 segundos, para que se note que Manuel está vivo
const PRIMERA_FRASE_MS = 45 * 1000;
// Cuánto queda visible el globito
const DURACION_FRASE_MS = 25 * 1000;

// ── Tipos ─────────────────────────────────────────────────────────────────

type AgenteTipo = "recepcion" | "medico" | "admin" | "paciente";

type AgenteConfig = {
  tipo: AgenteTipo;
  nombre: string;
  descripcion: string;
  icono: string;
  color: string;
  capacidades: string[];
  limitaciones: string[];
};

type ConfigResponse = {
  agentesDisponibles: AgenteConfig[];
  predeterminado: AgenteTipo;
  usuarioRol: string;
};

type Sesion = {
  id: number;
  agenteTipo: AgenteTipo;
  titulo: string;
  estado: string;
};

export type HuecoOfrecido = {
  turneraId: number;
  agenda: string;
  fecha: string;
  hora: string;
  sedeId?: number | null;
  especialidadId?: number | null;
};

type Mensaje = {
  id: string;
  rol: "user" | "assistant";
  contenido: string;
  streaming?: boolean;
  /** Huecos ofrecidos por la herramienta proximos_huecos, para renderizar
      botones clickeables que preseleccionan agenda + fecha + hora. */
  huecos?: HuecoOfrecido[];
};

type AgentChatProps = {
  pacienteId?: number;
  profesionalId?: number;
  agenteForzado?: AgenteTipo;
  frasesGraciosas?: boolean;
  inicialAbierto?: boolean;
  /** Modo controlado desde el header: sin botón flotante; al cerrar se desmonta. */
  onCerrar?: () => void;
  /** Modo embebido: se renderiza dentro del layout de la página (sin botón
      flotante ni posición fija, sin minimizar/cerrar). */
  inline?: boolean;
  /** Si está definido, los huecos que ofrece el asistente se muestran como
      botones y al clickear uno se llama con ese hueco (la página lo usa para
      preseleccionar agenda + fecha + hora en el panel de carga). */
  onElegirHueco?: (hueco: HuecoOfrecido) => void;
};

// ── Iconos por tipo ───────────────────────────────────────────────────────

const AGENTE_ICONS: Record<AgenteTipo, React.ElementType> = {
  recepcion: Headset,
  medico: Stethoscope,
  admin: BarChart3,
  paciente: UserCircle,
};

const AGENTE_COLORS: Record<AgenteTipo, { bg: string; text: string; border: string; dot: string }> = {
  recepcion: {
    bg: "bg-blue-600",
    text: "text-blue-700",
    border: "border-blue-200",
    dot: "bg-blue-500",
  },
  medico: {
    bg: "bg-emerald-600",
    text: "text-emerald-700",
    border: "border-emerald-200",
    dot: "bg-emerald-500",
  },
  admin: {
    bg: "bg-violet-600",
    text: "text-violet-700",
    border: "border-violet-200",
    dot: "bg-violet-500",
  },
  paciente: {
    bg: "bg-teal-600",
    text: "text-teal-700",
    border: "border-teal-200",
    dot: "bg-teal-500",
  },
};

// ── Hook de sesión y mensajería ───────────────────────────────────────────

function useAgenteChat(agenteTipo: AgenteTipo | null, pacienteId?: number, profesionalId?: number) {
  const [sesion, setSesion] = useState<Sesion | null>(null);
  const [mensajes, setMensajes] = useState<Mensaje[]>([]);
  const [cargando, setCargando] = useState(false);
  const [iniciando, setIniciando] = useState(false);
  const { toast } = useToast();

  const token = typeof window !== "undefined"
    ? localStorage.getItem("auth_token") ?? ""
    : "";

  const iniciarSesion = useCallback(async (tipo: AgenteTipo) => {
    setIniciando(true);
    try {
      const r = await fetch("/api/agentes/sesiones", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ agenteTipo: tipo, pacienteId, profesionalId }),
      });
      if (!r.ok) throw new Error("Error al iniciar sesión");
      const { sesion: s } = await r.json() as { sesion: Sesion };
      setSesion(s);
      setMensajes([]);
    } catch {
      toast({ title: "No se pudo iniciar el agente", variant: "destructive" });
    } finally {
      setIniciando(false);
    }
  }, [token, pacienteId, profesionalId, toast]);

  useEffect(() => {
    if (agenteTipo) void iniciarSesion(agenteTipo);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agenteTipo]);

  const enviarMensaje = useCallback(async (contenido: string) => {
    if (!sesion || !contenido.trim() || cargando) return;

    const msgUsuario: Mensaje = {
      id: `u-${Date.now()}`,
      rol: "user",
      contenido,
    };
    const msgStreaming: Mensaje = {
      id: `a-${Date.now()}`,
      rol: "assistant",
      contenido: "",
      streaming: true,
    };

    setMensajes((prev) => [...prev, msgUsuario, msgStreaming]);
    setCargando(true);

    try {
      const r = await fetch(`/api/agentes/sesiones/${sesion.id}/mensajes`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ contenido }),
      });

      if (!r.ok || !r.body) throw new Error("Error en streaming");

      const reader = r.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          try {
            const data = JSON.parse(line.slice(6)) as { content?: string; done?: boolean; error?: string; huecos?: HuecoOfrecido[] };
            if (data.content) {
              setMensajes((prev) =>
                prev.map((m) =>
                  m.id === msgStreaming.id ? { ...m, contenido: m.contenido + data.content! } : m
                )
              );
            }
            if (data.huecos && data.huecos.length > 0) {
              setMensajes((prev) =>
                prev.map((m) =>
                  m.id === msgStreaming.id ? { ...m, huecos: data.huecos } : m
                )
              );
            }
            if (data.done || data.error) {
              setMensajes((prev) =>
                prev.map((m) =>
                  m.id === msgStreaming.id ? { ...m, streaming: false } : m
                )
              );
            }
          } catch { /* ignorar */ }
        }
      }
    } catch {
      toast({ title: "Error al enviar mensaje", variant: "destructive" });
      setMensajes((prev) => prev.filter((m) => m.id !== msgStreaming.id));
    } finally {
      setCargando(false);
    }
  }, [sesion, cargando, token, toast]);

  const reiniciar = useCallback(() => {
    if (agenteTipo) void iniciarSesion(agenteTipo);
  }, [agenteTipo, iniciarSesion]);

  return { sesion, mensajes, cargando, iniciando, enviarMensaje, reiniciar };
}

// ── Componente principal ──────────────────────────────────────────────────

export function AgentChat({ pacienteId, profesionalId, agenteForzado, frasesGraciosas, inicialAbierto, onCerrar, inline, onElegirHueco }: AgentChatProps) {
  const { toast } = useToast();
  const [abierto, setAbierto] = useState(inline || (inicialAbierto ?? false));
  const [fraseActual, setFraseActual] = useState<string | null>(null);
  const [minimizado, setMinimizado] = useState(false);
  const [config, setConfig] = useState<ConfigResponse | null>(null);
  const [agenteActivo, setAgenteActivo] = useState<AgenteTipo | null>(null);
  const [mostrarSelector, setMostrarSelector] = useState(false);
  const [input, setInput] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const token = typeof window !== "undefined"
    ? localStorage.getItem("auth_token") ?? ""
    : "";

  const { sesion, mensajes, cargando, iniciando, enviarMensaje, reiniciar } = useAgenteChat(
    abierto ? (agenteForzado ?? agenteActivo) : null,
    pacienteId,
    profesionalId
  );

  // Pregunta pendiente enviada desde un buscador rápido (BuscadorRapidoIA)
  const [preguntaPendiente, setPreguntaPendiente] = useState<string | null>(null);

  useEffect(() => {
    const handler = (e: Event) => {
      const pregunta = (e as CustomEvent<{ pregunta?: string }>).detail?.pregunta;
      setAbierto(true);
      setMinimizado(false);
      if (pregunta && pregunta.trim()) setPreguntaPendiente(pregunta.trim());
    };
    window.addEventListener("conectar:preguntar-agente", handler);
    return () => window.removeEventListener("conectar:preguntar-agente", handler);
  }, []);

  useEffect(() => {
    if (preguntaPendiente && sesion && !cargando && !iniciando) {
      void enviarMensaje(preguntaPendiente);
      setPreguntaPendiente(null);
    }
  }, [preguntaPendiente, sesion, cargando, iniciando, enviarMensaje]);

  // Cargar configuración al abrir por primera vez
  useEffect(() => {
    if (!abierto || config) return;
    void (async () => {
      try {
        const r = await fetch("/api/agentes/config", {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!r.ok) return;
        const data = await r.json() as ConfigResponse;
        setConfig(data);
        setAgenteActivo(agenteForzado ?? data.predeterminado);
      } catch {
        toast({ title: "No se pudo cargar la configuración del agente", variant: "destructive" });
      }
    })();
  }, [abierto, config, token, agenteForzado, toast]);

  // Comentario gracioso de Manuel: uno a los 45 seg y luego cada 30 min
  useEffect(() => {
    if (!frasesGraciosas) return;
    let ocultar: ReturnType<typeof setTimeout> | undefined;
    let intervalo: ReturnType<typeof setInterval> | undefined;
    const mostrar = () => {
      setFraseActual((prev) => fraseAleatoria(prev ?? undefined));
      if (ocultar) clearTimeout(ocultar);
      ocultar = setTimeout(() => setFraseActual(null), DURACION_FRASE_MS);
    };
    const primera = setTimeout(() => {
      mostrar();
      intervalo = setInterval(mostrar, INTERVALO_FRASE_MS);
    }, PRIMERA_FRASE_MS);
    return () => {
      clearTimeout(primera);
      if (ocultar) clearTimeout(ocultar);
      if (intervalo) clearInterval(intervalo);
    };
  }, [frasesGraciosas]);

  // Auto-scroll al último mensaje
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [mensajes]);

  const handleEnviar = () => {
    if (!input.trim() || cargando) return;
    void enviarMensaje(input.trim());
    setInput("");
    textareaRef.current?.focus();
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleEnviar();
    }
  };

  const tipoActivo = agenteForzado ?? agenteActivo;
  const colores = tipoActivo ? AGENTE_COLORS[tipoActivo] : AGENTE_COLORS.recepcion;
  const IconoActivo = tipoActivo ? AGENTE_ICONS[tipoActivo] : Bot;
  const nombreAgente = config?.agentesDisponibles.find((a) => a.tipo === tipoActivo)?.nombre ?? "Asistente IA";

  // Botón flotante
  if (!abierto && !inline) {
    // En modo controlado no hay botón flotante: el que abre/cierra es el header.
    if (onCerrar) return null;
    return (
      <>
        {fraseActual && (
          <div
            className="fixed bottom-24 right-6 z-50 max-w-xs bg-background border rounded-2xl rounded-br-sm shadow-xl p-3.5 animate-in fade-in slide-in-from-bottom-2 duration-300"
            data-testid="burbuja-frase-manuel"
          >
            <div className="flex items-start gap-2">
              <div className="flex-1">
                <p className="text-xs font-semibold text-muted-foreground mb-1">Manuel dice…</p>
                <p className="text-sm leading-snug">{fraseActual}</p>
              </div>
              <button
                onClick={() => setFraseActual(null)}
                className="text-muted-foreground/60 hover:text-muted-foreground shrink-0"
                aria-label="Cerrar comentario"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>
        )}
        <button
          onClick={() => { setFraseActual(null); setAbierto(true); }}
          className={cn(
            "fixed bottom-6 right-6 z-50 w-14 h-14 rounded-full shadow-lg flex items-center justify-center",
            "transition-all hover:scale-110 active:scale-95",
            colores.bg,
            "text-white"
          )}
          title="Abrir asistente IA"
        >
          <Bot className="w-6 h-6" />
          <span className={cn("absolute top-0 right-0 w-3.5 h-3.5 rounded-full border-2 border-white", colores.dot)} />
        </button>
      </>
    );
  }

  // Panel de chat
  return (
    <div
      className={cn(
        "flex flex-col bg-background border",
        inline
          ? "rounded-lg h-full w-full"
          : cn(
              "fixed bottom-6 right-6 z-50 rounded-2xl shadow-2xl transition-all duration-200",
              minimizado ? "w-72 h-14" : "w-[380px] h-[580px] sm:w-[420px] sm:h-[600px]"
            )
      )}
    >
      {/* Header */}
      <div className={cn("flex items-center gap-2 px-4 py-3 rounded-t-2xl shrink-0", colores.bg, "text-white")}>
        <div className="relative">
          <IconoActivo className="w-5 h-5" />
          <span className="absolute -top-0.5 -right-0.5 w-2.5 h-2.5 bg-green-400 rounded-full border border-white" />
        </div>

        <div className="flex-1 min-w-0">
          <p className="font-semibold text-sm leading-tight truncate">{nombreAgente}</p>
          {!minimizado && (
            <p className="text-xs opacity-75 leading-tight">
              {sesion ? "Sesión activa" : iniciando ? "Iniciando…" : "Conectar IA"}
            </p>
          )}
        </div>

        {/* Selector de agente (si hay más de uno disponible) */}
        {!minimizado && config && config.agentesDisponibles.length > 1 && !agenteForzado && (
          <div className="relative">
            <button
              onClick={() => setMostrarSelector(!mostrarSelector)}
              className="flex items-center gap-1 text-xs opacity-80 hover:opacity-100 bg-white/15 rounded px-2 py-1"
            >
              Cambiar <ChevronDown className="w-3 h-3" />
            </button>
            {mostrarSelector && (
              <div className="absolute top-full right-0 mt-1 bg-background border rounded-lg shadow-lg py-1 min-w-[180px] z-10">
                {config.agentesDisponibles.map((ag) => {
                  const Ic = AGENTE_ICONS[ag.tipo];
                  const cols = AGENTE_COLORS[ag.tipo];
                  return (
                    <button
                      key={ag.tipo}
                      className={cn(
                        "w-full flex items-center gap-2 px-3 py-2 text-sm text-left hover:bg-muted",
                        agenteActivo === ag.tipo && "font-semibold"
                      )}
                      onClick={() => {
                        setAgenteActivo(ag.tipo);
                        setMostrarSelector(false);
                        reiniciar();
                      }}
                    >
                      <Ic className={cn("w-4 h-4", cols.text)} />
                      {ag.nombre}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {!inline && (
          <>
            <button onClick={() => setMinimizado(!minimizado)} className="opacity-75 hover:opacity-100 p-1">
              {minimizado ? <Maximize2 className="w-4 h-4" /> : <Minimize2 className="w-4 h-4" />}
            </button>
            <button onClick={() => { setAbierto(false); onCerrar?.(); }} className="opacity-75 hover:opacity-100 p-1">
              <X className="w-4 h-4" />
            </button>
          </>
        )}
        {/* Embebido: la X borra la conversación (nueva sesión) y pliega el panel */}
        {inline && onCerrar && (
          <button
            onClick={() => { reiniciar(); onCerrar(); }}
            className="opacity-75 hover:opacity-100 p-1"
            title="Borrar conversación y plegar"
            data-testid="boton-cerrar-asistente-inline"
          >
            <X className="w-4 h-4" />
          </button>
        )}
      </div>

      {minimizado && (
        <div
          className="flex-1 flex items-center justify-center text-sm text-muted-foreground cursor-pointer"
          onClick={() => setMinimizado(false)}
        >
          {mensajes.length > 0 ? `${mensajes.length} mensajes` : "Hacé clic para abrir"}
        </div>
      )}

      {!minimizado && (
        <>
          {/* Área de mensajes */}
          <div
            ref={scrollRef}
            className="flex-1 overflow-y-auto px-4 py-3 space-y-3"
          >
            {/* Bienvenida */}
            {mensajes.length === 0 && !iniciando && config && (
              inline ? (
                <div className="h-full flex items-center justify-center">
                  <p className="text-xs text-muted-foreground italic text-center px-4">
                    Escribí tu consulta para comenzar
                  </p>
                </div>
              ) : (
                <WelcomeScreen
                  config={config.agentesDisponibles.find((a) => a.tipo === tipoActivo)!}
                  colores={colores}
                />
              )
            )}

            {iniciando && (
              <div className="flex items-center justify-center py-8 text-muted-foreground text-sm gap-2">
                <Loader2 className="w-4 h-4 animate-spin" /> Iniciando agente…
              </div>
            )}

            {mensajes.map((msg) => (
              <MensajeItem key={msg.id} msg={msg} colores={colores} onElegirHueco={onElegirHueco} />
            ))}
          </div>

          {/* Footer — input */}
          <div className="border-t px-3 py-2.5 shrink-0 space-y-2">
            {sesion && (
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-1.5">
                  <Sparkles className="w-3 h-3 text-muted-foreground" />
                  <span className="text-xs text-muted-foreground">
                    {nombreAgente} · Conectar IA
                  </span>
                </div>
                <Button variant="ghost" size="icon" className="h-5 w-5" onClick={reiniciar} title="Nueva sesión">
                  <RotateCcw className="w-3 h-3" />
                </Button>
              </div>
            )}

            <div className="flex gap-2 items-end">
              <Textarea
                ref={textareaRef}
                className="min-h-[60px] max-h-[120px] resize-none text-sm flex-1"
                placeholder={
                  !sesion
                    ? "Iniciando…"
                    : tipoActivo === "medico"
                    ? "Preguntá sobre el paciente…"
                    : tipoActivo === "recepcion"
                    ? "¿Hay demoras? ¿Cuántos pacientes esperan?"
                    : tipoActivo === "admin"
                    ? "¿Cuál es la ocupación de hoy?"
                    : "¿En qué te puedo ayudar?"
                }
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                disabled={!sesion || cargando}
              />
              <Button
                size="icon"
                className={cn("h-10 w-10 shrink-0", colores.bg, "hover:opacity-90 text-white")}
                onClick={handleEnviar}
                disabled={!input.trim() || cargando || !sesion}
              >
                {cargando ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <Send className="w-4 h-4" />
                )}
              </Button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

// ── Sub-componentes ───────────────────────────────────────────────────────

function WelcomeScreen({
  config,
  colores,
}: {
  config: AgenteConfig;
  colores: { bg: string; text: string; border: string };
}) {
  const Icon = AGENTE_ICONS[config.tipo];
  return (
    <div className="text-center py-4 space-y-3">
      <div className={cn("w-12 h-12 rounded-full flex items-center justify-center mx-auto", colores.bg, "text-white")}>
        <Icon className="w-6 h-6" />
      </div>
      <div>
        <h3 className="font-semibold text-base">{config.nombre}</h3>
        <p className="text-sm text-muted-foreground mt-1 leading-relaxed">{config.descripcion}</p>
      </div>
      <div className="text-left">
        <p className="text-xs font-medium text-muted-foreground mb-1.5">Puedo ayudarte con:</p>
        <ul className="space-y-1">
          {config.capacidades.slice(0, 4).map((cap) => (
            <li key={cap} className={cn("text-xs flex items-start gap-1.5 rounded px-2 py-1", colores.border, "border bg-card")}>
              <span className={cn("mt-0.5 shrink-0 w-1.5 h-1.5 rounded-full", colores.bg)} />
              {cap}
            </li>
          ))}
        </ul>
      </div>
      <p className="text-xs text-muted-foreground italic">Escribí tu consulta para comenzar</p>
    </div>
  );
}

function MensajeItem({
  msg,
  colores,
  onElegirHueco,
}: {
  msg: Mensaje;
  colores: { bg: string };
  onElegirHueco?: (hueco: HuecoOfrecido) => void;
}) {
  const esUsuario = msg.rol === "user";

  return (
    <div className={cn("flex", esUsuario ? "justify-end" : "justify-start")}>
      <div
        className={cn(
          "max-w-[85%] rounded-2xl px-3 py-2 text-sm leading-relaxed",
          esUsuario
            ? cn(colores.bg, "text-white rounded-br-sm")
            : "bg-muted text-foreground rounded-bl-sm"
        )}
      >
        {msg.streaming && msg.contenido === "" ? (
          <span className="flex items-center gap-1.5 text-muted-foreground">
            <Loader2 className="w-3 h-3 animate-spin" /> Pensando…
          </span>
        ) : (
          <MarkdownText text={msg.contenido} />
        )}
        {msg.streaming && msg.contenido !== "" && (
          <span className="inline-block w-1.5 h-4 bg-current animate-pulse ml-0.5 align-middle" />
        )}
        {/* Huecos ofrecidos: botones que preseleccionan agenda + fecha + hora */}
        {!esUsuario && !msg.streaming && onElegirHueco && (msg.huecos?.length ?? 0) > 0 && (
          <div className="flex flex-col gap-1 mt-2">
            {msg.huecos!.map((h, i) => (
              <button
                key={`${h.turneraId}-${h.fecha}-${h.hora}-${i}`}
                type="button"
                data-testid={`boton-hueco-${h.turneraId}-${h.fecha}-${h.hora}`}
                onClick={() => onElegirHueco(h)}
                className="w-full text-left rounded-md border bg-card hover:bg-accent px-2 py-1.5 text-xs transition-colors"
                title="Cargar esta agenda, fecha y hora en el panel de la derecha"
              >
                <span className="font-medium">{formatearFechaHueco(h.fecha)} · {h.hora} hs</span>
                <span className="block text-muted-foreground truncate">{h.agenda}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// "2026-08-10" → "lun 10/08" (sin depender de la zona horaria del navegador).
function formatearFechaHueco(fecha: string) {
  const [a, m, d] = fecha.split("-").map(Number);
  if (!a || !m || !d) return fecha;
  const dias = ["dom", "lun", "mar", "mié", "jue", "vie", "sáb"];
  const dow = new Date(a, m - 1, d).getDay();
  return `${dias[dow]} ${String(d).padStart(2, "0")}/${String(m).padStart(2, "0")}`;
}

// Los enlaces internos a PDFs (/api/...) requieren el token: se descargan con
// fetch autenticado y se abren como blob en una pestaña nueva.
async function abrirPdfConToken(url: string) {
  const token = typeof localStorage !== "undefined" ? localStorage.getItem("auth_token") ?? "" : "";
  try {
    const res = await fetch(url, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
    if (!res.ok) {
      alert(res.status === 403
        ? "No tenés permisos para descargar este documento."
        : "No se pudo descargar el documento. Probá de nuevo en unos segundos.");
      return;
    }
    const blob = await res.blob();
    const blobUrl = URL.createObjectURL(blob);
    window.open(blobUrl, "_blank");
    setTimeout(() => URL.revokeObjectURL(blobUrl), 60_000);
  } catch {
    alert("No se pudo descargar el documento. Revisá tu conexión y probá de nuevo.");
  }
}

function MarkdownText({ text }: { text: string }) {
  // Renderizado mínimo de markdown: negrita, listas y saltos de línea
  const lines = text.split("\n");
  const onClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const a = (e.target as HTMLElement).closest("a");
    if (!a) return;
    const href = a.getAttribute("href") ?? "";
    if (href.startsWith("/api/")) {
      e.preventDefault();
      void abrirPdfConToken(href);
    }
  };
  return (
    <div className="space-y-1" onClick={onClick}>
      {lines.map((line, i) => {
        if (line.startsWith("- ") || line.startsWith("• ")) {
          return (
            <div key={i} className="flex items-start gap-1.5">
              <span className="mt-1.5 w-1.5 h-1.5 rounded-full bg-current shrink-0 opacity-60" />
              <span dangerouslySetInnerHTML={{ __html: formatInline(line.slice(2)) }} />
            </div>
          );
        }
        if (line.startsWith("**") && line.endsWith("**")) {
          return <p key={i} className="font-semibold" dangerouslySetInnerHTML={{ __html: formatInline(line) }} />;
        }
        if (line === "") return <div key={i} className="h-1" />;
        return <p key={i} dangerouslySetInnerHTML={{ __html: formatInline(line) }} />;
      })}
    </div>
  );
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function formatInline(text: string): string {
  // Primero se escapa TODO el texto (nunca se inyecta HTML del modelo) y
  // recién después se aplican las marcas de markdown sobre el texto escapado.
  return escapeHtml(text)
    // Enlaces markdown: solo rutas internas (/...) o https, nunca javascript:
    .replace(/\[([^\]]+)\]\((\/[^)\s]*|https:\/\/[^)\s]+)\)/g, (_m, label: string, url: string) =>
      `<a href="${url}" target="_blank" rel="noopener noreferrer" class="underline font-medium">${label}</a>`)
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/\*(.+?)\*/g, "<em>$1</em>")
    .replace(/`(.+?)`/g, "<code class='bg-black/10 rounded px-1 text-xs'>$1</code>");
}

// Exportar también como default para uso en página completa
export default AgentChat;
