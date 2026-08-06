import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useListChatConversaciones,
  useListChatMensajes,
  useEnviarChatMensaje,
  useListProfesionales,
  getListChatConversacionesQueryKey,
  getListChatMensajesQueryKey,
  type ChatConversacion,
} from "@workspace/api-client-react";
import { useAuth } from "@/hooks/use-auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Combobox } from "@/components/ui/combobox";
import { MessageCircle, X, ArrowLeft, Send, Loader2, Plus, Users } from "lucide-react";

// Chat flotante abajo a la derecha: recepción/administración chatea con un
// médico y el médico responde desde la misma ventana en su pantalla.

type Conversacion = { profesionalId: number; staffUsuarioId: number | null; canal: boolean; nombre: string };

type ChatCtx = {
  abrirChatConProfesional: (profesionalId: number, nombre?: string) => void;
  abrir: () => void;
};

const Ctx = createContext<ChatCtx>({ abrirChatConProfesional: () => {}, abrir: () => {} });
export const useChatFlotante = () => useContext(Ctx);

export function ChatFlotanteProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const [abierto, setAbierto] = useState(false);
  const [activa, setActiva] = useState<Conversacion | null>(null);
  const [nuevo, setNuevo] = useState(false);

  const esStaff = user?.rol === "admin" || user?.rol === "recepcionista";
  const esMedico = user?.rol === "medico";
  const habilitado = !!user && (esStaff || esMedico);

  const ctx = useMemo<ChatCtx>(
    () => ({
      abrirChatConProfesional: (profesionalId, nombre) => {
        setActiva({ profesionalId, staffUsuarioId: user?.id ?? 0, canal: false, nombre: nombre ?? "" });
        setNuevo(false);
        setAbierto(true);
      },
      abrir: () => setAbierto(true),
    }),
    [user?.id],
  );

  return (
    <Ctx.Provider value={ctx}>
      {children}
      {habilitado && (
        <ChatWidget
          esStaff={!!esStaff}
          abierto={abierto}
          setAbierto={setAbierto}
          activa={activa}
          setActiva={setActiva}
          nuevo={nuevo}
          setNuevo={setNuevo}
        />
      )}
    </Ctx.Provider>
  );
}

function ChatWidget({
  esStaff,
  abierto,
  setAbierto,
  activa,
  setActiva,
  nuevo,
  setNuevo,
}: {
  esStaff: boolean;
  abierto: boolean;
  setAbierto: (v: boolean) => void;
  activa: Conversacion | null;
  setActiva: (c: Conversacion | null) => void;
  nuevo: boolean;
  setNuevo: (v: boolean) => void;
}) {
  const { data: conversaciones } = useListChatConversaciones({
    query: { refetchInterval: 10_000 },
  });
  const noLeidosTotal = (conversaciones ?? []).reduce((acc, c) => acc + c.noLeidos, 0);

  return (
    <div className="fixed bottom-4 right-4 z-50 flex flex-col items-end gap-2" data-testid="chat-flotante">
      {abierto && (
        <div className="w-80 h-[26rem] rounded-xl border bg-background shadow-xl flex flex-col overflow-hidden">
          {activa ? (
            <ChatThread
              esStaff={esStaff}
              conversacion={activa}
              onVolver={() => setActiva(null)}
              onCerrar={() => setAbierto(false)}
            />
          ) : (
            <ChatLista
              esStaff={esStaff}
              conversaciones={conversaciones ?? []}
              nuevo={nuevo}
              setNuevo={setNuevo}
              onElegir={(c) => setActiva(c)}
              onCerrar={() => setAbierto(false)}
            />
          )}
        </div>
      )}
      <Button
        size="icon"
        className="relative h-12 w-12 rounded-full shadow-lg"
        onClick={() => setAbierto(!abierto)}
        data-testid="boton-chat-flotante"
        title="Chat interno"
      >
        {abierto ? <X className="w-5 h-5" /> : <MessageCircle className="w-5 h-5" />}
        {!abierto && noLeidosTotal > 0 && (
          <span className="absolute -top-1 -right-1 min-w-5 h-5 px-1 rounded-full bg-red-500 text-white text-xs font-bold flex items-center justify-center" data-testid="badge-chat-no-leidos">
            {noLeidosTotal > 9 ? "9+" : noLeidosTotal}
          </span>
        )}
      </Button>
    </div>
  );
}

function ChatLista({
  esStaff,
  conversaciones,
  nuevo,
  setNuevo,
  onElegir,
  onCerrar,
}: {
  esStaff: boolean;
  conversaciones: ChatConversacion[];
  nuevo: boolean;
  setNuevo: (v: boolean) => void;
  onElegir: (c: Conversacion) => void;
  onCerrar: () => void;
}) {
  const { user } = useAuth();
  const esMedico = user?.rol === "medico";
  const profesionalIdPropio = esMedico && user?.profesionalId ? Number(user.profesionalId) : null;
  const { data: profesionales } = useListProfesionales({ activo: true }, { query: { enabled: esStaff && nuevo } });
  const opciones = useMemo(
    () =>
      [...(profesionales ?? [])]
        .sort((a, b) => `${a.apellido ?? ""} ${a.nombre}`.localeCompare(`${b.apellido ?? ""} ${b.nombre}`, "es"))
        .map((p) => ({ value: String(p.id), label: p.apellido ? `${p.apellido}, ${p.nombre}` : p.nombre })),
    [profesionales],
  );

  return (
    <>
      <div className="flex items-center justify-between px-3 py-2 border-b bg-primary text-primary-foreground">
        <span className="font-semibold text-sm">Chat interno</span>
        <button onClick={onCerrar} aria-label="Cerrar chat" data-testid="boton-cerrar-chat">
          <X className="w-4 h-4" />
        </button>
      </div>
      <div className="flex-1 overflow-y-auto">
        {esStaff && (
          <div className="p-2 border-b">
            {nuevo ? (
              <Combobox
                testId="select-chat-profesional"
                value=""
                onChange={(v) => {
                  const op = opciones.find((o) => o.value === v);
                  if (op) onElegir({ profesionalId: Number(v), staffUsuarioId: user?.id ?? 0, canal: false, nombre: op.label });
                  setNuevo(false);
                }}
                placeholder="Buscar profesional…"
                options={opciones}
              />
            ) : (
              <Button variant="outline" size="sm" className="w-full" onClick={() => setNuevo(true)} data-testid="boton-nuevo-chat">
                <Plus className="w-4 h-4 mr-1" /> Nuevo chat con un médico
              </Button>
            )}
          </div>
        )}
        {esMedico && profesionalIdPropio != null && !conversaciones.some((c) => c.canal) && (
          <button
            className="w-full text-left px-3 py-2 border-b hover:bg-muted flex items-center gap-2"
            onClick={() => onElegir({ profesionalId: profesionalIdPropio, staffUsuarioId: null, canal: true, nombre: "Recepción (todos)" })}
            data-testid="boton-chat-canal-recepcion"
          >
            <Users className="w-4 h-4 text-primary shrink-0" />
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium">Escribir a recepción</p>
              <p className="text-xs text-muted-foreground">Canal con todos los recepcionistas</p>
            </div>
          </button>
        )}
        {conversaciones.length === 0 && !nuevo && (
          <p className="p-4 text-sm text-muted-foreground text-center">
            {esStaff ? "Todavía no hay conversaciones." : "Cuando recepción te escriba, el chat aparece acá."}
          </p>
        )}
        {conversaciones.map((c) => (
          <button
            key={`${c.profesionalId}-${c.staffUsuarioId ?? "canal"}`}
            className="w-full text-left px-3 py-2 border-b hover:bg-muted flex items-start gap-2"
            onClick={() => onElegir({ profesionalId: c.profesionalId, staffUsuarioId: c.staffUsuarioId ?? null, canal: !!c.canal, nombre: c.nombre })}
            data-testid={`chat-conversacion-${c.profesionalId}-${c.staffUsuarioId ?? "canal"}`}
          >
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium truncate">{c.nombre}</p>
              <p className="text-xs text-muted-foreground truncate">{c.ultimoMensaje}</p>
            </div>
            {c.noLeidos > 0 && (
              <span className="mt-1 min-w-5 h-5 px-1 rounded-full bg-red-500 text-white text-xs font-bold flex items-center justify-center">
                {c.noLeidos > 9 ? "9+" : c.noLeidos}
              </span>
            )}
          </button>
        ))}
      </div>
    </>
  );
}

function ChatThread({
  esStaff,
  conversacion,
  onVolver,
  onCerrar,
}: {
  esStaff: boolean;
  conversacion: Conversacion;
  onVolver: () => void;
  onCerrar: () => void;
}) {
  const queryClient = useQueryClient();
  const params = conversacion.canal
    ? { profesionalId: conversacion.profesionalId, canal: true }
    : esStaff
      ? { profesionalId: conversacion.profesionalId }
      : { staffUsuarioId: conversacion.staffUsuarioId ?? undefined };
  const { data: mensajes } = useListChatMensajes(params, {
    query: { refetchInterval: 4_000 },
  });
  const enviar = useEnviarChatMensaje();
  const [texto, setTexto] = useState("");
  const finRef = useRef<HTMLDivElement>(null);
  const cantidad = mensajes?.length ?? 0;

  useEffect(() => {
    finRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [cantidad]);

  // Al abrir el hilo se marcan leídos en el server: refrescar el contador.
  useEffect(() => {
    if (cantidad > 0) {
      void queryClient.invalidateQueries({ queryKey: getListChatConversacionesQueryKey() });
    }
  }, [cantidad, queryClient]);

  const mandar = () => {
    const limpio = texto.trim();
    if (!limpio || enviar.isPending) return;
    enviar.mutate(
      {
        data: conversacion.canal
          ? { mensaje: limpio, profesionalId: conversacion.profesionalId, canal: true }
          : esStaff
            ? { mensaje: limpio, profesionalId: conversacion.profesionalId }
            : { mensaje: limpio, staffUsuarioId: conversacion.staffUsuarioId ?? undefined },
      },
      {
        onSuccess: () => {
          setTexto("");
          void queryClient.invalidateQueries({ queryKey: getListChatMensajesQueryKey(params) });
          void queryClient.invalidateQueries({ queryKey: getListChatConversacionesQueryKey() });
        },
      },
    );
  };

  const mios = esStaff ? "staff" : "medico";

  return (
    <>
      <div className="flex items-center gap-2 px-3 py-2 border-b bg-primary text-primary-foreground">
        <button onClick={onVolver} aria-label="Volver" data-testid="boton-chat-volver">
          <ArrowLeft className="w-4 h-4" />
        </button>
        <span className="font-semibold text-sm flex-1 truncate">{conversacion.nombre || "Chat"}</span>
        <button onClick={onCerrar} aria-label="Cerrar chat">
          <X className="w-4 h-4" />
        </button>
      </div>
      <div className="flex-1 overflow-y-auto p-3 space-y-2 bg-muted/30">
        {(mensajes ?? []).map((m) => (
          <div key={m.id} className={`flex ${m.emisor === mios ? "justify-end" : "justify-start"}`}>
            <div
              className={`max-w-[80%] rounded-2xl px-3 py-1.5 text-sm whitespace-pre-wrap break-words ${
                m.emisor === mios ? "bg-primary text-primary-foreground rounded-br-sm" : "bg-background border rounded-bl-sm"
              }`}
            >
              {conversacion.canal && m.emisor !== mios && m.enviadoPorNombre && (
                <div className="text-[10px] font-semibold text-primary mb-0.5">{m.enviadoPorNombre}</div>
              )}
              {m.mensaje}
              <div className={`text-[10px] mt-0.5 ${m.emisor === mios ? "text-primary-foreground/70" : "text-muted-foreground"}`}>
                {new Date(m.creadoEn).toLocaleTimeString("es-AR", { hour: "2-digit", minute: "2-digit" })}
              </div>
            </div>
          </div>
        ))}
        {(mensajes ?? []).length === 0 && (
          <p className="text-center text-sm text-muted-foreground pt-8">Escribí el primer mensaje.</p>
        )}
        <div ref={finRef} />
      </div>
      <div className="p-2 border-t flex gap-2">
        <Input
          value={texto}
          onChange={(e) => setTexto(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              mandar();
            }
          }}
          maxLength={1000}
          placeholder="Escribí un mensaje…"
          data-testid="input-chat-mensaje"
        />
        <Button size="icon" onClick={mandar} disabled={!texto.trim() || enviar.isPending} data-testid="boton-chat-enviar">
          {enviar.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
        </Button>
      </div>
    </>
  );
}
