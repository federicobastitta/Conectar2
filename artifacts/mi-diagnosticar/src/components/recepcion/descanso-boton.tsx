import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useListAvisosMios,
  useSetRecepcionAviso,
  getListAvisosMiosQueryKey,
  getListDescansosActivosQueryKey,
  type DescansoActivoTipo,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { Loader2, DoorOpen, Hand, Users, RefreshCw, MessageSquare, ShieldAlert, Stethoscope } from "lucide-react";
import { useChatFlotante } from "@/components/chat/chat-flotante";

// Icono "nene levantando un cartel" (no existe en lucide, SVG propio con el
// mismo trazo que los íconos de la barra).
export function PersonaConCartel({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {/* cartel en alto */}
      <rect x="7" y="2" width="10" height="6" rx="1" />
      {/* brazos levantados sosteniendo el cartel */}
      <path d="M9 8 L10 12" />
      <path d="M15 8 L14 12" />
      {/* cabeza */}
      <circle cx="12" cy="14" r="2" />
      {/* cuerpo y piernas */}
      <path d="M12 16 v3" />
      <path d="M12 19 l-2 3" />
      <path d="M12 19 l2 3" />
    </svg>
  );
}

// Textos del toast por tipo de aviso.
const TOASTS: Record<DescansoActivoTipo, { onTitle: string; onDesc: string; offTitle: string; offDesc: string }> = {
  descanso: {
    onTitle: "Saliste de tu puesto",
    onDesc: "Avisamos a tus compañeros que no estás en tu puesto de trabajo.",
    offTitle: "De vuelta en el puesto",
    offDesc: "Avisamos a tus compañeros que volviste a tu puesto.",
  },
  asistencia: {
    onTitle: "Pedido de asistencia enviado",
    onDesc: "Avisamos a tus compañeros que necesitás asistencia en tu puesto.",
    offTitle: "Pedido de asistencia cancelado",
    offDesc: "Avisamos que ya no necesitás asistencia.",
  },
  mucha_gente: {
    onTitle: "Aviso enviado",
    onDesc: "Avisamos a tus compañeros que tenés mucha gente en tu puesto.",
    offTitle: "Aviso cancelado",
    offDesc: "Avisamos que la fila en tu puesto se descomprimió.",
  },
  reemplazo: {
    onTitle: "Pedido de reemplazo enviado",
    onDesc: "Avisamos a tus compañeros que necesitás un reemplazo temporal.",
    offTitle: "Pedido de reemplazo cancelado",
    offDesc: "Avisamos que ya no necesitás reemplazo.",
  },
  mensaje: {
    onTitle: "Aviso publicado",
    onDesc: "Tus compañeros van a ver tu mensaje en pantalla.",
    offTitle: "Aviso quitado",
    offDesc: "Tu mensaje ya no se muestra en pantalla.",
  },
  seguridad: {
    onTitle: "Aviso a seguridad enviado",
    onDesc: "Avisamos que necesitás seguridad en tu puesto.",
    offTitle: "Aviso a seguridad cancelado",
    offDesc: "Avisamos que la situación está controlada.",
  },
};

// Botón rojo de seguridad: un toque avisa a todos que hace falta seguridad en
// el puesto; otro toque lo cancela. Va al lado del botón de avisos.
export function SeguridadBoton() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  // Los avisos vencen solos al minuto: se re-consulta para apagar el botón.
  const { data: avisos } = useListAvisosMios({ query: { refetchInterval: 15_000 } });
  const mutation = useSetRecepcionAviso();

  const activo = !!avisos?.some((a) => a.tipo === "seguridad");

  const alternar = () => {
    mutation.mutate(
      { data: { tipo: "seguridad", accion: activo ? "fin" : "inicio" } },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListAvisosMiosQueryKey() });
          queryClient.invalidateQueries({ queryKey: getListDescansosActivosQueryKey() });
          const t = TOASTS.seguridad;
          toast({
            title: activo ? t.offTitle : t.onTitle,
            description: activo ? t.offDesc : t.onDesc,
          });
        },
        onError: () => {
          queryClient.invalidateQueries({ queryKey: getListAvisosMiosQueryKey() });
          toast({ title: "No se pudo registrar", description: "Probá de nuevo.", variant: "destructive" });
        },
      },
    );
  };

  return (
    <Button
      variant="ghost"
      size="icon"
      onClick={alternar}
      disabled={mutation.isPending}
      className={
        activo
          ? "relative h-9 w-9 rounded-lg bg-red-700 text-white hover:bg-red-600 ring-2 ring-red-300 animate-pulse"
          : "relative h-9 w-9 rounded-lg bg-red-600 text-white hover:bg-red-500 hover:text-white ring-1 ring-red-400/60"
      }
      title={activo ? "Cancelar aviso a seguridad" : "Aviso a seguridad"}
      data-testid="boton-header-seguridad"
    >
      {mutation.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <ShieldAlert className="w-4 h-4" />}
    </Button>
  );
}

// Botón de avisos del puesto: desplegable con salida del puesto, pedido de
// asistencia, mucha gente, reemplazo temporal y un mensaje de texto libre.
// Todos avisan a los compañeros con un banner en toda la página y quedan
// registrados en la auditoría.
export function DescansoBoton() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  // Ídem: el aviso caduca al minuto y el botón vuelve a su estado normal.
  const { data: avisos } = useListAvisosMios({ query: { refetchInterval: 15_000 } });
  const mutation = useSetRecepcionAviso();
  const [dialogAbierto, setDialogAbierto] = useState(false);
  const { abrir: abrirChat } = useChatFlotante();
  const [texto, setTexto] = useState("");

  const activo = (tipo: DescansoActivoTipo) => !!avisos?.some((a) => a.tipo === tipo);
  const hayActivos = !!avisos?.length;

  const invalidar = () => {
    queryClient.invalidateQueries({ queryKey: getListAvisosMiosQueryKey() });
    queryClient.invalidateQueries({ queryKey: getListDescansosActivosQueryKey() });
  };

  const enviar = (tipo: DescansoActivoTipo, mensaje?: string) => {
    const iniciar = tipo === "mensaje" ? !!mensaje : !activo(tipo);
    mutation.mutate(
      { data: { tipo, accion: iniciar ? "inicio" : "fin", ...(mensaje ? { mensaje } : {}) } },
      {
        onSuccess: () => {
          invalidar();
          const t = TOASTS[tipo];
          toast({
            title: iniciar ? t.onTitle : t.offTitle,
            description: iniciar ? t.onDesc : t.offDesc,
          });
        },
        onError: () => {
          invalidar();
          toast({ title: "No se pudo registrar", description: "Probá de nuevo.", variant: "destructive" });
        },
      },
    );
  };

  const publicarTexto = () => {
    const limpio = texto.trim();
    if (!limpio) return;
    enviar("mensaje", limpio);
    setTexto("");
    setDialogAbierto(false);
  };

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className={
              hayActivos
                ? "relative h-9 w-9 rounded-lg bg-orange-500 text-white hover:bg-orange-400 ring-2 ring-orange-300 animate-pulse"
                : "relative h-9 w-9 rounded-lg bg-orange-600 text-white hover:bg-orange-500 hover:text-white ring-1 ring-orange-400/60"
            }
            title="Avisos del puesto de trabajo"
            data-testid="boton-header-descanso"
            disabled={mutation.isPending}
          >
            {mutation.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <PersonaConCartel className="w-4 h-4" />}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-72">
          <DropdownMenuItem onClick={() => enviar("descanso")} data-testid="menu-descanso">
            <DoorOpen className="w-4 h-4 mr-2 text-amber-400" />
            {activo("descanso") ? "Vuelvo a mi puesto" : "Salgo de mi puesto"}
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => enviar("asistencia")} data-testid="menu-asistencia">
            <Hand className="w-4 h-4 mr-2 text-red-400" />
            {activo("asistencia") ? "Cancelar pedido de asistencia" : "Solicito asistencia"}
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => enviar("mucha_gente")} data-testid="menu-mucha-gente">
            <Users className="w-4 h-4 mr-2 text-orange-400" />
            {activo("mucha_gente") ? "Ya se descomprimió la fila" : "Tengo mucha gente"}
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => enviar("reemplazo")} data-testid="menu-reemplazo">
            <RefreshCw className="w-4 h-4 mr-2 text-violet-400" />
            {activo("reemplazo") ? "Cancelar pedido de reemplazo" : "Necesito reemplazo temporal"}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={() => abrirChat()} data-testid="menu-notificar-medico">
            <Stethoscope className="w-4 h-4 mr-2 text-emerald-400" />
            Chat con un médico…
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => setDialogAbierto(true)} data-testid="menu-mensaje">
            <MessageSquare className="w-4 h-4 mr-2 text-sky-400" />
            Escribir un aviso…
          </DropdownMenuItem>
          {activo("mensaje") && (
            <DropdownMenuItem onClick={() => enviar("mensaje")} data-testid="menu-mensaje-quitar">
              <MessageSquare className="w-4 h-4 mr-2 text-muted-foreground" />
              Quitar mi aviso
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      <Dialog open={dialogAbierto} onOpenChange={setDialogAbierto}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Aviso para tus compañeros</DialogTitle>
          </DialogHeader>
          <Textarea
            value={texto}
            onChange={(e) => setTexto(e.target.value)}
            maxLength={200}
            rows={3}
            placeholder="Ej: vuelvo en 10 minutos, estoy en el depósito…"
            data-testid="input-aviso-texto"
          />
          <DialogFooter>
            <Button variant="ghost" onClick={() => setDialogAbierto(false)}>
              Cancelar
            </Button>
            <Button onClick={publicarTexto} disabled={!texto.trim() || mutation.isPending} data-testid="boton-publicar-aviso">
              Publicar aviso
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
