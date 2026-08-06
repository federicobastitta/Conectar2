import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useListServicios,
  useGetDisponibilidadServicio,
  useCreateSolicitud,
  useListSolicitudesPaciente,
  getListSolicitudesPacienteQueryKey,
  type SlotServicio,
  type SolicitudInputAccion,
} from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { SolicitudEstadoControl } from "./solicitud-estado";
import { ArrowRight, CalendarCheck, Loader2, Send, Stethoscope } from "lucide-react";
import { format, parseISO } from "date-fns";
import { es } from "date-fns/locale";

function fmtFecha(fecha: string) {
  try {
    return format(parseISO(fecha), "EEE d MMM", { locale: es });
  } catch {
    return fecha;
  }
}

export function PanelDerivacion({ pacienteId, encounterId, profesionalIdAdmin }: {
  pacienteId: number;
  encounterId?: number;
  profesionalIdAdmin?: number;
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [servicioId, setServicioId] = useState<string>("");
  const [slotSel, setSlotSel] = useState<SlotServicio | null>(null);
  const [detalle, setDetalle] = useState("");
  const [prioridad, setPrioridad] = useState<"normal" | "alta" | "urgente">("normal");
  const [cobertura, setCobertura] = useState("");

  const { data: servicios, isLoading: cargandoServicios } = useListServicios();
  const sid = servicioId ? Number(servicioId) : 0;
  const { data: slots, isLoading: cargandoSlots } = useGetDisponibilidadServicio(sid, {
    query: { enabled: sid > 0 },
  });

  const servicio = (servicios ?? []).find((s) => s.id === sid);

  const invalidar = () =>
    queryClient.invalidateQueries({ queryKey: getListSolicitudesPacienteQueryKey(pacienteId) });

  const crear = useCreateSolicitud({
    mutation: {
      onSuccess: (s) => {
        toast({
          title: "Solicitud registrada",
          description: s.turnoFecha
            ? `${s.servicioNombre}: turno pre-reservado el ${fmtFecha(s.turnoFecha)} ${s.turnoHoraInicio} hs`
            : `${s.servicioNombre} — ${s.estado === "pendiente_validacion" ? "derivada a recepción" : "indicada"}`,
        });
        setSlotSel(null);
        setDetalle("");
        setCobertura("");
        setServicioId("");
        invalidar();
      },
      onError: (e) => {
        const msg = e instanceof Error ? e.message : "Error desconocido";
        toast({ title: "No se pudo crear la solicitud", description: msg, variant: "destructive" });
        invalidar();
      },
    },
  });

  const enviar = (accion: SolicitudInputAccion) => {
    if (!sid) return;
    crear.mutate({
      data: {
        patientId: pacienteId,
        servicioId: sid,
        tipo: "estudio",
        accion,
        ...(encounterId ? { encounterId } : {}),
        ...(detalle.trim() ? { detalle: detalle.trim() } : {}),
        prioridad,
        ...(cobertura.trim() ? { cobertura: cobertura.trim() } : {}),
        ...(profesionalIdAdmin ? { profesionalId: profesionalIdAdmin } : {}),
        ...(accion === "pre_reservar" && slotSel
          ? { turno: { turneraId: slotSel.turneraId, fecha: slotSel.fecha, horaInicio: slotSel.horaInicio } }
          : {}),
      },
    });
  };

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm flex items-center gap-2">
          <Stethoscope className="w-4 h-4" /> Indicar estudio / derivación
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {cargandoServicios ? (
          <Skeleton className="h-9 w-full" />
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            <div className="space-y-1">
              <Label className="text-xs">Servicio</Label>
              <Select value={servicioId} onValueChange={(v) => { setServicioId(v); setSlotSel(null); }}>
                <SelectTrigger className="h-9"><SelectValue placeholder="Elegir servicio…" /></SelectTrigger>
                <SelectContent>
                  {(servicios ?? []).map((s) => (
                    <SelectItem key={s.id} value={String(s.id)}>
                      {s.nombre}{s.requiereAutorizacion ? " ⚿" : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Prioridad</Label>
              <Select value={prioridad} onValueChange={(v) => setPrioridad(v as typeof prioridad)}>
                <SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="normal">Normal</SelectItem>
                  <SelectItem value="alta">Alta</SelectItem>
                  <SelectItem value="urgente">Urgente</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
        )}

        {servicio?.requiereAutorizacion && (
          <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded px-2 py-1.5">
            Este servicio requiere autorización de la cobertura: la solicitud pasará por validación en recepción.
          </p>
        )}

        {sid > 0 && (
          <div className="space-y-1.5">
            <Label className="text-xs">Próximos turnos disponibles (menor espera primero)</Label>
            {cargandoSlots ? (
              <Skeleton className="h-16 w-full" />
            ) : (slots ?? []).length === 0 ? (
              <p className="text-xs text-muted-foreground">Sin agenda online disponible — derivá a recepción.</p>
            ) : (
              <div className="flex flex-wrap gap-1.5">
                {(slots ?? []).slice(0, 8).map((s) => {
                  const sel = slotSel && slotSel.turneraId === s.turneraId && slotSel.fecha === s.fecha && slotSel.horaInicio === s.horaInicio;
                  return (
                    <button
                      key={`${s.turneraId}-${s.fecha}-${s.horaInicio}`}
                      type="button"
                      onClick={() => setSlotSel(sel ? null : s)}
                      className={`text-xs rounded-md border px-2 py-1.5 text-left transition-colors ${sel ? "border-primary bg-primary/10" : "hover:bg-muted"}`}
                    >
                      <span className="font-medium">{fmtFecha(s.fecha)} {s.horaInicio}</span>
                      <span className="block text-muted-foreground">
                        {s.sedeNombre ?? s.turneraNombre}
                        {s.esperaDias === 0 ? " · hoy" : ` · en ${s.esperaDias} d`}
                      </span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        )}

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          <div className="space-y-1">
            <Label className="text-xs">Detalle / indicación</Label>
            <Textarea rows={2} value={detalle} onChange={(e) => setDetalle(e.target.value)} placeholder="Ej: Ecografía abdominal completa" />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Cobertura</Label>
            <Input value={cobertura} onChange={(e) => setCobertura(e.target.value)} placeholder="OSDE 210 / PAMI / Particular" />
          </div>
        </div>

        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            disabled={!sid || !slotSel || crear.isPending}
            onClick={() => enviar("pre_reservar")}
          >
            {crear.isPending ? <Loader2 className="w-3.5 h-3.5 mr-1 animate-spin" /> : <CalendarCheck className="w-3.5 h-3.5 mr-1" />}
            Pre-reservar turno
          </Button>
          <Button size="sm" variant="secondary" disabled={!sid || crear.isPending} onClick={() => enviar("derivar_recepcion")}>
            <Send className="w-3.5 h-3.5 mr-1" /> Derivar a recepción
          </Button>
          <Button size="sm" variant="outline" disabled={!sid || crear.isPending} onClick={() => enviar("indicar")}>
            <ArrowRight className="w-3.5 h-3.5 mr-1" /> Solo indicar
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

export function ListaSolicitudesPaciente({ pacienteId }: { pacienteId: number }) {
  const queryClient = useQueryClient();
  const { data: solicitudes, isLoading } = useListSolicitudesPaciente(pacienteId);
  const invalidar = () =>
    queryClient.invalidateQueries({ queryKey: getListSolicitudesPacienteQueryKey(pacienteId) });

  if (isLoading) return <Skeleton className="h-24 w-full" />;
  const items = solicitudes ?? [];
  if (items.length === 0) {
    return <p className="text-sm text-muted-foreground py-3 text-center">Sin solicitudes registradas.</p>;
  }

  return (
    <div className="space-y-2">
      {items.map((s) => (
        <div key={s.id} className="flex items-start justify-between gap-2 rounded-md border p-2.5">
          <div className="min-w-0">
            <p className="text-sm font-medium flex items-center gap-1.5 flex-wrap">
              {s.servicioNombre ?? `Servicio #${s.servicioId}`}
              {s.prioridad !== "normal" && (
                <Badge variant="secondary" className={`border-0 text-[10px] ${s.prioridad === "urgente" ? "bg-red-100 text-red-700" : "bg-orange-100 text-orange-700"}`}>
                  {s.prioridad}
                </Badge>
              )}
            </p>
            <p className="text-xs text-muted-foreground">
              {s.profesionalNombre ? `Dr/a. ${s.profesionalNombre}` : ""}
              {s.turnoFecha ? ` · Turno ${fmtFecha(s.turnoFecha)} ${s.turnoHoraInicio} hs` : ""}
              {s.turnoSedeNombre ? ` · ${s.turnoSedeNombre}` : ""}
            </p>
            {s.detalle && <p className="text-xs mt-0.5">{s.detalle}</p>}
          </div>
          <SolicitudEstadoControl solicitud={s} onChanged={invalidar} />
        </div>
      ))}
    </div>
  );
}
