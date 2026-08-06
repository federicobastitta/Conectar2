import React, { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Loader2, Inbox, MessageCircleWarning, ArrowLeft } from "lucide-react";
import { cn } from "@/lib/utils";
import { useAuth } from "@/hooks/use-auth";
import {
  BurbujaMensaje,
  FeedbackCompositor,
  type FeedbackMensaje,
} from "@/components/feedback/feedback-burbuja";

// ── Bandeja de feedback (perfil desarrollador) ──────────────────────────────
// Una conversación por usuario del sistema: reportes de fallas y mejoras.

function authHeaders(): Record<string, string> {
  return { Authorization: `Bearer ${localStorage.getItem("auth_token") ?? ""}` };
}

type Conversacion = {
  usuarioId: number;
  nombre: string;
  email: string;
  rol: string;
  perfil: string | null;
  ultimoMensaje: string;
  ultimoEn: string;
  noLeidos: number;
  total: number;
};

function Hilo({ usuarioId }: { usuarioId: number }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const { data: mensajes = [], isLoading } = useQuery<FeedbackMensaje[]>({
    queryKey: ["feedback", "hilo", usuarioId],
    queryFn: async () => {
      const r = await fetch(`/api/feedback/mensajes?usuarioId=${usuarioId}`, { headers: authHeaders() });
      if (!r.ok) throw new Error("No se pudieron cargar los mensajes");
      return r.json();
    },
    refetchInterval: 7000,
  });
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [mensajes.length]);

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <div ref={scrollRef} className="flex-1 overflow-y-auto p-4 space-y-2 bg-muted/30">
        {isLoading ? (
          <div className="flex justify-center py-8">
            <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
          </div>
        ) : mensajes.length === 0 ? (
          <p className="text-center text-sm text-muted-foreground py-8">Sin mensajes en este hilo.</p>
        ) : (
          mensajes.map((m) => <BurbujaMensaje key={m.id} m={m} mio={m.emisor === "desarrollo"} />)
        )}
      </div>
      <FeedbackCompositor usuarioId={usuarioId} />
    </div>
  );
}

export default function FeedbackPage() {
  const { user } = useAuth();
  const [seleccionado, setSeleccionado] = useState<number | null>(null);
  const perfil = (user as { perfil?: string | null } | undefined)?.perfil ?? null;

  // Modo "solo chat" para la PWA dedicada de Feedback: se activa con ?solo=1
  // (start_url del manifest) y queda pegado a la sesión del navegador.
  const modoSolo = useMemo(() => {
    if (new URLSearchParams(window.location.search).get("solo") === "1") {
      sessionStorage.setItem("feedback_solo", "1");
      return true;
    }
    if (sessionStorage.getItem("feedback_solo") === "1") return true;
    // App instalada (standalone) + desarrollador = siempre solo-chat.
    return (
      window.matchMedia("(display-mode: standalone)").matches ||
      (navigator as { standalone?: boolean }).standalone === true
    );
  }, []);

  // Mientras esta página está abierta, el navegador ve el manifest propio de
  // Feedback: si el desarrollador la instala desde acá, el ícono abre directo
  // el chat (sin el resto del sistema). Al salir se restaura el manifest general.
  useEffect(() => {
    const link = document.querySelector<HTMLLinkElement>('link[rel="manifest"]');
    if (!link) return;
    const original = link.getAttribute("href");
    link.setAttribute("href", "/manifest-feedback.webmanifest");
    return () => {
      if (original) link.setAttribute("href", original);
    };
  }, []);
  const { data: conversaciones = [], isLoading } = useQuery<Conversacion[]>({
    queryKey: ["feedback", "conversaciones"],
    queryFn: async () => {
      const r = await fetch("/api/feedback/conversaciones", { headers: authHeaders() });
      if (!r.ok) throw new Error("No se pudo cargar la bandeja");
      return r.json();
    },
    refetchInterval: 10000,
  });
  const activa = conversaciones.find((c) => c.usuarioId === seleccionado) ?? null;

  // Guard de ruta: la bandeja es exclusiva del perfil desarrollador (el
  // backend igual responde 403; esto evita una pantalla confusa).
  if (user && perfil !== "desarrollador") {
    return (
      <div className="p-8 text-center text-sm text-muted-foreground">
        Esta bandeja es exclusiva del equipo de desarrollo. Para mandar feedback usá la burbuja roja de abajo.
      </div>
    );
  }

  return (
    <div
      className={cn(
        "p-4 md:p-6 flex flex-col",
        // En modo solo-chat la página tapa el layout completo (menú incluido).
        modoSolo ? "fixed inset-0 z-[100] bg-background h-dvh" : "h-[calc(100dvh-3.5rem)]",
      )}
    >
      <div className="mb-4 shrink-0">
        <h1 className="text-xl font-bold flex items-center gap-2">
          <MessageCircleWarning className="w-5 h-5 text-red-600" /> Feedback de usuarios
        </h1>
        <p className="text-sm text-muted-foreground">
          Reportes de fallas y pedidos de mejora que los usuarios mandan desde la burbuja roja. Respondé acá: el
          usuario lo ve en su chat.
        </p>
      </div>
      <div className="flex-1 min-h-0 grid grid-cols-1 md:grid-cols-[320px_1fr] gap-4">
        {/* Lista de conversaciones (en mobile se oculta cuando hay un hilo abierto) */}
        <div className={cn("border border-border rounded-xl overflow-y-auto bg-background", activa && "hidden md:block")}>
          {isLoading ? (
            <div className="flex justify-center py-8">
              <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
            </div>
          ) : conversaciones.length === 0 ? (
            <div className="text-center text-sm text-muted-foreground py-10 px-4">
              <Inbox className="w-8 h-8 mx-auto mb-2 opacity-40" />
              Todavía nadie mandó feedback.
            </div>
          ) : (
            conversaciones.map((c) => (
              <button
                key={c.usuarioId}
                onClick={() => setSeleccionado(c.usuarioId)}
                data-testid={`conversacion-feedback-${c.usuarioId}`}
                className={cn(
                  "w-full text-left px-3 py-2.5 border-b border-border/60 hover:bg-muted/60 transition-colors",
                  seleccionado === c.usuarioId && "bg-muted",
                )}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="font-semibold text-sm truncate">{c.nombre}</span>
                  {c.noLeidos > 0 && (
                    <span className="shrink-0 min-w-[18px] h-[18px] px-1 rounded-full bg-red-600 text-white text-[10px] font-bold flex items-center justify-center">
                      {c.noLeidos}
                    </span>
                  )}
                </div>
                <div className="text-[11px] text-muted-foreground truncate">
                  {c.email} · {c.perfil ?? c.rol}
                </div>
                <div className="text-xs text-muted-foreground truncate mt-0.5">
                  {c.ultimoMensaje || "(adjunto)"}
                </div>
                <div className="text-[10px] text-muted-foreground/70 mt-0.5">
                  {new Date(c.ultimoEn).toLocaleString("es-AR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}
                </div>
              </button>
            ))
          )}
        </div>
        {/* Hilo (en mobile ocupa toda la pantalla, con botón para volver) */}
        <div className={cn("border border-border rounded-xl overflow-hidden flex flex-col bg-background", !activa && "hidden md:flex")}>
          {activa ? (
            <>
              <div className="px-3 md:px-4 py-2.5 border-b border-border shrink-0 flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setSeleccionado(null)}
                  className="md:hidden p-1.5 -ml-1 rounded-md hover:bg-muted shrink-0"
                  data-testid="boton-feedback-volver"
                >
                  <ArrowLeft className="w-4 h-4" />
                </button>
                <div className="min-w-0">
                  <div className="font-semibold text-sm truncate">{activa.nombre}</div>
                  <div className="text-[11px] text-muted-foreground truncate">
                    {activa.email} · {activa.perfil ?? activa.rol}
                  </div>
                </div>
              </div>
              <Hilo usuarioId={activa.usuarioId} />
            </>
          ) : (
            <div className="flex-1 flex items-center justify-center text-sm text-muted-foreground">
              Elegí una conversación para leer y responder.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
