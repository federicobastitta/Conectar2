import { useState } from "react";
import {
  useUpdateSolicitudEstado,
  useGetSolicitudHistorial,
  useGetDisponibilidadServicio,
  type Solicitud,
  type SolicitudEstadoInputEstado,
} from "@workspace/api-client-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/hooks/use-auth";
import { CalendarClock, ChevronDown, History, Loader2, ShieldCheck } from "lucide-react";
import { format } from "date-fns";
import { es } from "date-fns/locale";

// Espejo del backend
export const TRANSICIONES_SOLICITUD: Record<string, string[]> = {
  indicada: ["pre_reservada", "pendiente_validacion", "en_sala", "cancelada", "rechazada"],
  pre_reservada: ["pendiente_validacion", "validada", "programada", "cancelada", "rechazada"],
  pendiente_validacion: ["validada", "rechazada", "cancelada"],
  validada: ["programada", "en_sala", "cancelada"],
  programada: ["programada", "en_sala", "realizada", "cancelada"], // programada→programada = reprogramación
  en_sala: ["realizada", "cancelada"],
  realizada: ["informada"],
  informada: [],
  cancelada: [],
  rechazada: [],
};

const ESTADOS_RECEPCION = ["pendiente_validacion", "validada", "programada", "en_sala", "cancelada", "rechazada"];
const ESTADOS_MEDICO = ["pre_reservada", "pendiente_validacion", "en_sala", "realizada", "informada", "cancelada"];

export const ESTADOS_SOLICITUD: Record<string, { label: string; className: string }> = {
  indicada: { label: "Indicada", className: "bg-slate-100 text-slate-700" },
  pre_reservada: { label: "Pre-reservada", className: "bg-sky-100 text-sky-800" },
  pendiente_validacion: { label: "Pendiente validación", className: "bg-amber-100 text-amber-800" },
  validada: { label: "Validada", className: "bg-lime-100 text-lime-800" },
  programada: { label: "Programada", className: "bg-blue-100 text-blue-800" },
  en_sala: { label: "En sala", className: "bg-indigo-100 text-indigo-800" },
  realizada: { label: "Realizada", className: "bg-teal-100 text-teal-800" },
  informada: { label: "Informada", className: "bg-green-100 text-green-800" },
  cancelada: { label: "Cancelada", className: "bg-red-100 text-red-700" },
  rechazada: { label: "Rechazada", className: "bg-rose-100 text-rose-700" },
};

export function SolicitudEstadoBadge({ estado }: { estado?: string | null }) {
  if (!estado) return null;
  const meta = ESTADOS_SOLICITUD[estado];
  return (
    <Badge
      variant="secondary"
      className={`${meta?.className ?? "bg-muted text-muted-foreground"} border-0 text-xs whitespace-nowrap`}
    >
      {meta?.label ?? estado}
    </Badge>
  );
}

function ReprogramarDialog({ solicitud, open, onOpenChange, onConfirmar, isPending }: {
  solicitud: Solicitud;
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onConfirmar: (turno: { turneraId: number; fecha: string; horaInicio: string }) => void;
  isPending: boolean;
}) {
  const { data: slots, isLoading } = useGetDisponibilidadServicio(solicitud.servicioId, {
    query: { enabled: open },
  });
  const [seleccionado, setSeleccionado] = useState<number | null>(null);

  return (
    <Dialog open={open} onOpenChange={(v) => { onOpenChange(v); if (!v) setSeleccionado(null); }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <CalendarClock className="w-4 h-4" /> Reprogramar turno
          </DialogTitle>
          <DialogDescription>
            Elegí el nuevo turno para {solicitud.servicioNombre ?? "la práctica"}. El turno anterior se cancela automáticamente.
          </DialogDescription>
        </DialogHeader>
        {isLoading ? (
          <div className="space-y-2">{[1, 2, 3].map((i) => <Skeleton key={i} className="h-12 w-full" />)}</div>
        ) : !slots || slots.length === 0 ? (
          <p className="text-sm text-muted-foreground py-4 text-center">Sin turnos online disponibles para este servicio.</p>
        ) : (
          <div className="space-y-1.5 max-h-72 overflow-y-auto">
            {slots.map((s, i) => (
              <button
                key={`${s.turneraId}-${s.fecha}-${s.horaInicio}`}
                type="button"
                onClick={() => setSeleccionado(i)}
                className={`w-full text-left rounded-md border p-2.5 text-sm transition-colors ${
                  seleccionado === i ? "border-primary bg-primary/5" : "hover:bg-muted/50"
                }`}
              >
                <div className="font-medium">
                  {format(new Date(`${s.fecha}T12:00:00`), "EEEE d MMM", { locale: es })} · {s.horaInicio} hs
                </div>
                <div className="text-xs text-muted-foreground">
                  {s.profesionalNombre} · {s.sedeNombre}
                  {s.esperaDias === 0 ? " · Hoy" : ` · en ${s.esperaDias} día${s.esperaDias === 1 ? "" : "s"}`}
                </div>
              </button>
            ))}
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancelar</Button>
          <Button
            disabled={isPending || seleccionado === null || !slots}
            onClick={() => {
              if (seleccionado === null || !slots) return;
              const s = slots[seleccionado];
              onConfirmar({ turneraId: s.turneraId, fecha: s.fecha, horaInicio: s.horaInicio });
            }}
          >
            {isPending && <Loader2 className="w-3.5 h-3.5 mr-1 animate-spin" />}
            Confirmar reprogramación
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function HistorialSolicitudDialog({ solicitudId, open, onOpenChange }: {
  solicitudId: number;
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const { data, isLoading } = useGetSolicitudHistorial(solicitudId, { query: { enabled: open } });
  const eventos = data ?? [];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <History className="w-4 h-4" /> Historial de la solicitud #{solicitudId}
          </DialogTitle>
          <DialogDescription>Trazabilidad completa de la solicitud.</DialogDescription>
        </DialogHeader>
        {isLoading ? (
          <div className="space-y-2">{[1, 2].map((i) => <Skeleton key={i} className="h-12 w-full" />)}</div>
        ) : eventos.length === 0 ? (
          <p className="text-sm text-muted-foreground py-4 text-center">Sin eventos registrados.</p>
        ) : (
          <div className="relative pl-5 space-y-3 max-h-80 overflow-y-auto before:absolute before:left-1.5 before:top-1 before:bottom-1 before:w-px before:bg-border">
            {eventos.map((e) => {
              let detalle: { de?: string; a?: string; motivo?: string | null } | null = null;
              try {
                detalle = e.detail ? JSON.parse(e.detail) : null;
              } catch {
                detalle = null;
              }
              return (
                <div key={e.id} className="relative text-sm">
                  <div className="absolute -left-5 top-1.5 w-3 h-3 rounded-full bg-primary/20 border-2 border-primary" />
                  <div className="flex flex-wrap items-center gap-1.5">
                    {e.action === "crear" ? (
                      <span className="font-medium">Solicitud creada</span>
                    ) : detalle?.de && detalle?.a ? (
                      <span className="font-medium flex items-center gap-1.5 flex-wrap">
                        <SolicitudEstadoBadge estado={detalle.de} />
                        <span className="text-muted-foreground">→</span>
                        <SolicitudEstadoBadge estado={detalle.a} />
                      </span>
                    ) : (
                      <span className="font-medium">{e.action}</span>
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    {format(new Date(e.createdAt), "d MMM yyyy HH:mm", { locale: es })}
                    {e.userEmail ? ` · ${e.userEmail}` : ""}
                  </p>
                  {detalle?.motivo && <p className="text-xs mt-0.5 italic">"{detalle.motivo}"</p>}
                </div>
              );
            })}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

export function SolicitudEstadoControl({ solicitud, onChanged }: {
  solicitud: Solicitud;
  onChanged?: () => void;
}) {
  const { toast } = useToast();
  const { user } = useAuth();
  const rol = (user as { rol?: string } | undefined)?.rol;
  const [historialAbierto, setHistorialAbierto] = useState(false);
  const [validarAbierto, setValidarAbierto] = useState(false);
  const [reprogramarAbierto, setReprogramarAbierto] = useState(false);
  const [estadoPendiente, setEstadoPendiente] = useState<SolicitudEstadoInputEstado | null>(null);
  const [token, setToken] = useState("");
  const [cobertura, setCobertura] = useState(solicitud.cobertura ?? "");

  const cambiar = useUpdateSolicitudEstado({
    mutation: {
      onSuccess: (updated) => {
        toast({
          title: "Estado actualizado",
          description: `La solicitud pasó a "${ESTADOS_SOLICITUD[updated.estado]?.label ?? updated.estado}"`,
        });
        setValidarAbierto(false);
        setReprogramarAbierto(false);
        onChanged?.();
      },
      onError: (e) => {
        const msg = e instanceof Error ? e.message : "Error desconocido";
        toast({ title: "No se pudo cambiar el estado", description: msg, variant: "destructive" });
        onChanged?.();
      },
    },
  });

  const estado = solicitud.estado;
  let transiciones = (TRANSICIONES_SOLICITUD[estado] ?? []) as SolicitudEstadoInputEstado[];
  if (rol === "recepcionista") {
    transiciones = transiciones.filter((t) => ESTADOS_RECEPCION.includes(t));
  } else if (rol === "medico") {
    transiciones = transiciones.filter((t) => ESTADOS_MEDICO.includes(t));
  } else if (rol !== "admin") {
    transiciones = [];
  }

  const elegir = (t: SolicitudEstadoInputEstado) => {
    if (t === "validada" && solicitud.requiereAutorizacion && !solicitud.tokenValidado) {
      setEstadoPendiente(t);
      setValidarAbierto(true);
      return;
    }
    if (t === "programada" && estado === "programada") {
      setReprogramarAbierto(true);
      return;
    }
    cambiar.mutate({ id: solicitud.id, data: { estado: t } });
  };

  return (
    <div className="flex items-center gap-1.5">
      {transiciones.length > 0 ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button size="sm" variant="ghost" className="h-auto p-0.5 gap-1 hover:bg-transparent" disabled={cambiar.isPending}>
              <SolicitudEstadoBadge estado={estado} />
              {cambiar.isPending ? <Loader2 className="w-3 h-3 animate-spin" /> : <ChevronDown className="w-3 h-3 text-muted-foreground" />}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuLabel className="text-xs">Cambiar estado a</DropdownMenuLabel>
            {transiciones.map((t) => (
              <DropdownMenuItem
                key={t}
                onClick={() => elegir(t)}
                className={["cancelada", "rechazada"].includes(t) ? "text-red-600 focus:text-red-600" : ""}
              >
                {t === "programada" && estado === "programada"
                  ? "Reprogramar (nuevo turno)"
                  : ESTADOS_SOLICITUD[t]?.label ?? t}
              </DropdownMenuItem>
            ))}
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => setHistorialAbierto(true)}>
              <History className="w-3.5 h-3.5 mr-2" /> Ver historial
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      ) : (
        <>
          <SolicitudEstadoBadge estado={estado} />
          <Button size="icon" variant="ghost" className="w-6 h-6" onClick={() => setHistorialAbierto(true)} title="Ver historial">
            <History className="w-3.5 h-3.5 text-muted-foreground" />
          </Button>
        </>
      )}
      <HistorialSolicitudDialog solicitudId={solicitud.id} open={historialAbierto} onOpenChange={setHistorialAbierto} />
      <ReprogramarDialog
        solicitud={solicitud}
        open={reprogramarAbierto}
        onOpenChange={setReprogramarAbierto}
        isPending={cambiar.isPending}
        onConfirmar={(turno) => cambiar.mutate({ id: solicitud.id, data: { estado: "programada", turno } })}
      />

      <Dialog open={validarAbierto} onOpenChange={setValidarAbierto}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <ShieldCheck className="w-4 h-4" /> Validar autorización
            </DialogTitle>
            <DialogDescription>
              {solicitud.servicioNombre} requiere autorización de la cobertura.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1">
              <Label htmlFor="val-token">Token / N° de autorización</Label>
              <Input id="val-token" value={token} onChange={(e) => setToken(e.target.value)} placeholder="AUT-12345" />
            </div>
            <div className="space-y-1">
              <Label htmlFor="val-cob">Cobertura</Label>
              <Input id="val-cob" value={cobertura} onChange={(e) => setCobertura(e.target.value)} placeholder="OSDE 210" />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setValidarAbierto(false)}>Cancelar</Button>
            <Button
              disabled={cambiar.isPending || !token.trim()}
              onClick={() =>
                estadoPendiente &&
                cambiar.mutate({
                  id: solicitud.id,
                  data: {
                    estado: estadoPendiente,
                    token: token.trim(),
                    ...(cobertura.trim() ? { cobertura: cobertura.trim() } : {}),
                  },
                })
              }
            >
              {cambiar.isPending && <Loader2 className="w-3.5 h-3.5 mr-1 animate-spin" />}
              Validar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
