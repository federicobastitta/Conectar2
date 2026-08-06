import React, { useEffect, useRef, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { MessageCircleWarning, Paperclip, Send, X, Loader2, ImageIcon, FileText } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";

// ── Burbuja de feedback "hablá con desarrollo" ──────────────────────────────
// Visible para TODOS los usuarios del sistema (menos el propio desarrollador,
// que tiene su bandeja en el menú). Muy visible, roja, llama a la acción.

function authHeaders(extra: Record<string, string> = {}): Record<string, string> {
  const token = localStorage.getItem("auth_token") ?? "";
  return { Authorization: `Bearer ${token}`, ...extra };
}

export type FeedbackAdjunto = { path: string; nombre: string; tipo?: string };
export type FeedbackMensaje = {
  id: number;
  usuarioId: number;
  emisor: "usuario" | "desarrollo";
  enviadoPorNombre: string | null;
  mensaje: string;
  adjuntos: FeedbackAdjunto[];
  creadoEn: string;
  leido: boolean;
};

export function esImagen(a: FeedbackAdjunto): boolean {
  return (a.tipo ?? "").startsWith("image/") || /\.(png|jpe?g|gif|webp)$/i.test(a.nombre);
}

export function urlAdjunto(a: FeedbackAdjunto): string {
  // objectPath viene como "/objects/..." → se sirve por /api/storage/objects/...
  return `/api/storage${a.path}`;
}

export function AdjuntoChip({ a }: { a: FeedbackAdjunto }) {
  return (
    <a href={urlAdjunto(a)} target="_blank" rel="noopener noreferrer" className="block mt-1">
      {esImagen(a) ? (
        <img
          src={urlAdjunto(a)}
          alt={a.nombre}
          className="max-h-40 max-w-full rounded-md border border-black/10 dark:border-white/10 object-contain bg-black/5"
        />
      ) : (
        <span className="inline-flex items-center gap-1.5 text-xs underline break-all">
          <FileText className="w-3.5 h-3.5 shrink-0" />
          {a.nombre}
        </span>
      )}
    </a>
  );
}

export function BurbujaMensaje({ m, mio }: { m: FeedbackMensaje; mio: boolean }) {
  return (
    <div className={cn("flex", mio ? "justify-end" : "justify-start")}>
      <div
        className={cn(
          "max-w-[85%] rounded-2xl px-3 py-2 text-sm whitespace-pre-wrap break-words shadow-sm",
          mio
            ? "bg-red-600 text-white rounded-br-sm"
            : "bg-muted text-foreground rounded-bl-sm border border-border",
        )}
      >
        {!mio && m.enviadoPorNombre && (
          <div className="text-[11px] font-semibold opacity-70 mb-0.5">{m.enviadoPorNombre}</div>
        )}
        {m.mensaje}
        {m.adjuntos.map((a, i) => (
          <AdjuntoChip key={i} a={a} />
        ))}
        <div className={cn("text-[10px] mt-1 text-right", mio ? "text-white/70" : "text-muted-foreground")}>
          {new Date(m.creadoEn).toLocaleString("es-AR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}
        </div>
      </div>
    </div>
  );
}

/** Subida de archivos: pide URL prefirmada y hace PUT directo. */
export async function subirAdjuntos(files: File[], toast: ReturnType<typeof useToast>["toast"]): Promise<FeedbackAdjunto[]> {
  const subidos: FeedbackAdjunto[] = [];
  for (const file of files) {
    if (file.size > 15 * 1024 * 1024) {
      toast({ title: `"${file.name}" es muy grande`, description: "Máximo 15 MB por archivo.", variant: "destructive" });
      continue;
    }
    const rUrl = await fetch("/api/storage/uploads/request-url", {
      method: "POST",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ name: file.name, size: file.size, contentType: file.type || "application/octet-stream" }),
    });
    if (!rUrl.ok) {
      toast({ title: "No se pudo iniciar la subida", variant: "destructive" });
      continue;
    }
    const { uploadURL, objectPath } = (await rUrl.json()) as { uploadURL: string; objectPath: string };
    const rPut = await fetch(uploadURL, { method: "PUT", headers: { "Content-Type": file.type || "application/octet-stream" }, body: file });
    if (!rPut.ok) {
      toast({ title: `Falló la subida de "${file.name}"`, variant: "destructive" });
      continue;
    }
    subidos.push({ path: objectPath, nombre: file.name, tipo: file.type });
  }
  return subidos;
}

/** Compositor compartido (usuario y desarrollo): texto + adjuntos + enviar. */
export function FeedbackCompositor({ usuarioId, onEnviado }: { usuarioId?: number; onEnviado?: () => void }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [texto, setTexto] = useState("");
  const [archivos, setArchivos] = useState<File[]>([]);
  const [subiendo, setSubiendo] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const enviar = useMutation({
    mutationFn: async () => {
      setSubiendo(true);
      try {
        const adjuntos = archivos.length > 0 ? await subirAdjuntos(archivos, toast) : [];
        if (!texto.trim() && adjuntos.length === 0) throw new Error("Escribí un mensaje o adjuntá una captura");
        const r = await fetch("/api/feedback/mensajes", {
          method: "POST",
          headers: authHeaders({ "Content-Type": "application/json" }),
          body: JSON.stringify({ mensaje: texto.trim(), adjuntos, ...(usuarioId ? { usuarioId } : {}) }),
        });
        if (!r.ok) {
          const body = (await r.json().catch(() => ({}))) as { error?: string };
          throw new Error(body.error ?? "No se pudo enviar el mensaje");
        }
      } finally {
        setSubiendo(false);
      }
    },
    onSuccess: () => {
      setTexto("");
      setArchivos([]);
      queryClient.invalidateQueries({ queryKey: ["feedback"] });
      onEnviado?.();
    },
    onError: (e: Error) => toast({ title: e.message, variant: "destructive" }),
  });

  return (
    <div className="border-t border-border p-2 space-y-1.5 bg-background">
      {archivos.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {archivos.map((f, i) => (
            <span key={i} className="inline-flex items-center gap-1 text-xs bg-muted rounded-full pl-2 pr-1 py-0.5 border border-border">
              <ImageIcon className="w-3 h-3" />
              <span className="max-w-[120px] truncate">{f.name}</span>
              <button
                type="button"
                className="hover:bg-black/10 dark:hover:bg-white/10 rounded-full p-0.5"
                onClick={() => setArchivos((prev) => prev.filter((_, j) => j !== i))}
              >
                <X className="w-3 h-3" />
              </button>
            </span>
          ))}
        </div>
      )}
      <div className="flex items-end gap-1.5">
        <input
          ref={fileRef}
          type="file"
          multiple
          accept="image/*,.pdf"
          className="hidden"
          onChange={(e) => {
            const nuevos = Array.from(e.target.files ?? []);
            setArchivos((prev) => [...prev, ...nuevos].slice(0, 5));
            e.target.value = "";
          }}
        />
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="shrink-0 h-9 w-9 text-muted-foreground"
          title="Adjuntar captura de pantalla o archivo"
          data-testid="boton-feedback-adjuntar"
          onClick={() => fileRef.current?.click()}
        >
          <Paperclip className="w-4 h-4" />
        </Button>
        <textarea
          value={texto}
          onChange={(e) => setTexto(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              if (!enviar.isPending) enviar.mutate();
            }
          }}
          rows={2}
          placeholder="Contanos qué no anda o qué mejorarías…"
          className="flex-1 resize-none rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-red-500/50"
          data-testid="input-feedback-mensaje"
        />
        <Button
          type="button"
          size="icon"
          className="shrink-0 h-9 w-9 bg-red-600 hover:bg-red-700 text-white"
          disabled={enviar.isPending || subiendo || (!texto.trim() && archivos.length === 0)}
          onClick={() => enviar.mutate()}
          data-testid="boton-feedback-enviar"
        >
          {enviar.isPending || subiendo ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
        </Button>
      </div>
    </div>
  );
}

/** Panel del hilo del propio usuario (dentro de la burbuja). */
function FeedbackPanel({ onCerrar }: { onCerrar: () => void }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const { data: mensajes = [], isLoading } = useQuery<FeedbackMensaje[]>({
    queryKey: ["feedback", "hilo-propio"],
    queryFn: async () => {
      const r = await fetch("/api/feedback/mensajes", { headers: authHeaders() });
      if (!r.ok) throw new Error("No se pudieron cargar los mensajes");
      return r.json();
    },
    refetchInterval: 7000,
  });
  const queryClient = useQueryClient();
  useEffect(() => {
    // Al abrir/leer, el contador del badge se recalcula.
    queryClient.invalidateQueries({ queryKey: ["feedback", "no-leidos"] });
  }, [mensajes.length, queryClient]);
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [mensajes.length]);

  return (
    <div className="fixed bottom-24 left-4 z-50 w-[min(24rem,calc(100vw-2rem))] h-[min(32rem,calc(100dvh-9rem))] rounded-xl border border-border bg-background shadow-2xl flex flex-col overflow-hidden">
      <div className="bg-red-600 text-white px-4 py-3 flex items-start justify-between gap-2 shrink-0">
        <div>
          <div className="font-bold text-sm flex items-center gap-1.5">
            <MessageCircleWarning className="w-4 h-4" /> Chat directo con desarrollo
          </div>
          <p className="text-[11px] text-white/85 mt-1 leading-snug">
            Este canal va directo al equipo que hace el sistema. Si algo <b>no funciona</b> o se te ocurre una{" "}
            <b>mejora</b>, escribilo acá y adjuntá capturas de pantalla. Tu mensaje sale con tu usuario, no hace falta
            aclarar quién sos.
          </p>
        </div>
        <button onClick={onCerrar} className="p-1 rounded hover:bg-white/20 shrink-0" data-testid="boton-feedback-cerrar">
          <X className="w-4 h-4" />
        </button>
      </div>
      <div ref={scrollRef} className="flex-1 overflow-y-auto p-3 space-y-2 bg-muted/30">
        {isLoading ? (
          <div className="flex justify-center py-8">
            <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
          </div>
        ) : mensajes.length === 0 ? (
          <p className="text-center text-sm text-muted-foreground py-8 px-4">
            Todavía no escribiste nada. Contanos qué anda mal o qué te gustaría mejorar — leemos todo.
          </p>
        ) : (
          mensajes.map((m) => <BurbujaMensaje key={m.id} m={m} mio={m.emisor === "usuario"} />)
        )}
      </div>
      <FeedbackCompositor />
    </div>
  );
}

/** Botón de asistencia para la barra superior: abre el mismo chat con desarrollo. */
export function FeedbackHeaderBoton() {
  const [abierto, setAbierto] = useState(false);
  const { data } = useQuery<{ noLeidos: number }>({
    queryKey: ["feedback", "no-leidos"],
    queryFn: async () => {
      const r = await fetch("/api/feedback/no-leidos", { headers: authHeaders() });
      if (!r.ok) return { noLeidos: 0 };
      return r.json();
    },
    refetchInterval: 30000,
  });
  const noLeidos = data?.noLeidos ?? 0;

  return (
    <>
      {abierto && <FeedbackPanel onCerrar={() => setAbierto(false)} />}
      <button
        type="button"
        onClick={() => setAbierto((v) => !v)}
        title="Asistencia: mandale un mensaje al desarrollador"
        data-testid="boton-header-feedback"
        className="relative h-9 w-9 rounded-lg bg-pink-600 text-white hover:bg-pink-500 ring-1 ring-pink-400/60 inline-flex items-center justify-center"
      >
        <MessageCircleWarning className="w-4 h-4" />
        {noLeidos > 0 && (
          <span className="absolute -top-1.5 -right-1.5 min-w-[16px] h-4 px-1 rounded-full bg-red-600 text-white text-[10px] font-bold flex items-center justify-center">
            {noLeidos}
          </span>
        )}
      </button>
    </>
  );
}

/** Pop-up para el DESARROLLADOR: se abre solo cuando entra un mensaje nuevo. */
export function FeedbackAvisoDesarrollador({ onIrABandeja }: { onIrABandeja: () => void }) {
  const [visible, setVisible] = useState(false);
  const previoRef = useRef<number | null>(null);
  const { data } = useQuery<{ noLeidos: number }>({
    queryKey: ["feedback", "no-leidos"],
    queryFn: async () => {
      const r = await fetch("/api/feedback/no-leidos", { headers: authHeaders() });
      if (!r.ok) return { noLeidos: 0 };
      return r.json();
    },
    refetchInterval: 15000,
  });
  const noLeidos = data?.noLeidos ?? 0;

  useEffect(() => {
    if (previoRef.current === null) {
      // Primera medición: si ya hay pendientes al entrar, también avisamos.
      previoRef.current = 0;
    }
    if (noLeidos > previoRef.current) setVisible(true);
    previoRef.current = noLeidos;
  }, [noLeidos]);

  if (!visible || noLeidos === 0) return null;
  return (
    <div className="fixed inset-0 z-[90] flex items-center justify-center bg-black/50 p-4" data-testid="popup-feedback-desarrollador">
      <div className="w-full max-w-sm rounded-xl border border-border bg-background shadow-2xl overflow-hidden">
        <div className="bg-red-600 text-white px-4 py-3 flex items-center gap-2">
          <MessageCircleWarning className="w-5 h-5 shrink-0" />
          <span className="font-bold text-sm">Tenés {noLeidos === 1 ? "un mensaje nuevo" : `${noLeidos} mensajes nuevos`}</span>
        </div>
        <div className="p-4 space-y-3">
          <p className="text-sm text-muted-foreground">
            Alguien del equipo te escribió pidiendo asistencia.
          </p>
          <div className="flex gap-2 justify-end">
            <Button variant="outline" size="sm" onClick={() => setVisible(false)} data-testid="boton-popup-feedback-despues">
              Más tarde
            </Button>
            <Button
              size="sm"
              className="bg-red-600 hover:bg-red-700 text-white"
              onClick={() => {
                setVisible(false);
                onIrABandeja();
              }}
              data-testid="boton-popup-feedback-ver"
            >
              Ver mensajes
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

/** Burbuja flotante roja, MUY visible, para todos los perfiles (no desarrollador). */
export function FeedbackBurbuja() {
  const [abierto, setAbierto] = useState(false);
  const { data } = useQuery<{ noLeidos: number }>({
    queryKey: ["feedback", "no-leidos"],
    queryFn: async () => {
      const r = await fetch("/api/feedback/no-leidos", { headers: authHeaders() });
      if (!r.ok) return { noLeidos: 0 };
      return r.json();
    },
    refetchInterval: 30000,
  });
  const noLeidos = data?.noLeidos ?? 0;

  return (
    <>
      {abierto && <FeedbackPanel onCerrar={() => setAbierto(false)} />}
      <button
        type="button"
        onClick={() => setAbierto((v) => !v)}
        data-testid="burbuja-feedback"
        title="¿Algo no anda? Hablá con desarrollo"
        className={cn(
          // Abajo a la IZQUIERDA: la esquina derecha es del chat interno staff-médico.
          "fixed bottom-5 left-4 z-50 flex items-center gap-2 rounded-full shadow-xl shadow-red-600/30",
          "bg-red-600 hover:bg-red-700 text-white pl-3.5 pr-4 py-3 transition-transform hover:scale-105",
          !abierto && "animate-pulse",
        )}
      >
        <span className="relative">
          <MessageCircleWarning className="w-5 h-5" />
          {noLeidos > 0 && (
            <span className="absolute -top-2 -right-2 min-w-[16px] h-4 px-1 rounded-full bg-white text-red-600 text-[10px] font-bold flex items-center justify-center">
              {noLeidos}
            </span>
          )}
        </span>
        <span className="text-sm font-semibold hidden sm:inline">¿Algo no anda?</span>
      </button>
    </>
  );
}
