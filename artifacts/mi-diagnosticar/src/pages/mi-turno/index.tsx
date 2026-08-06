import { useState } from "react";
import { Link } from "wouter";
import { format } from "date-fns";
import { es } from "date-fns/locale";

import { useQueryClient } from "@tanstack/react-query";

import {
  useGetPortalTurnos,
  useListMisTurnos,
  useGetPatientPrescriptions,
  useGetPatientCertificates,
  useGetMiPosicionSalaEspera,
  useCancelarTurno,
  useReprogramarTurno,
  useGetDisponibilidadTurnera,
  getGetDisponibilidadTurneraQueryKey,
  getListTurnosQueryKey,
  getListMisTurnosQueryKey,
  getGetPortalTurnosQueryKey,
  getGetMiPosicionSalaEsperaQueryKey,
  type MiSalaEsperaTurno,
  type Turno,
  type PortalTurno,
} from "@workspace/api-client-react";
import { useAuth } from "@/hooks/use-auth";
import { MisEstudiosPrevios } from "@/components/estudios-previos/estudios-previos";
import { VideollamadaPacienteBanner } from "@/components/videollamada/videollamada-paciente";
import { useToast } from "@/hooks/use-toast";
import { useLlamadoAlert } from "@/hooks/use-llamado-alert";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { StatusBadge } from "@/components/ui/status-badge";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { CalendarIcon, Clock, MapPin, UserCircle, Search, Hospital, Bell, BellRing, Users, CheckCircle2, Stethoscope, CalendarClock, Pill, FileBadge, Video } from "lucide-react";
import { QRCodeSVG } from "qrcode.react";

function ordinal(n: number): string {
  return `${n}°`;
}

// Estados en los que el paciente todavía puede cancelar (antes de la atención)
const ESTADOS_CANCELABLES = ["pendiente", "reservado", "confirmado", "publicado", "arribo", "en_sala"];

function CancelarTurnoButton({ turno }: { turno: PortalTurno }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const cancelar = useCancelarTurno({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListTurnosQueryKey() });
        queryClient.invalidateQueries({ queryKey: getListMisTurnosQueryKey() });
        queryClient.invalidateQueries({ queryKey: getGetPortalTurnosQueryKey() });
        queryClient.invalidateQueries({ queryKey: getGetMiPosicionSalaEsperaQueryKey() });
        toast({
          title: "Turno cancelado",
          description: "Tu turno fue cancelado y el horario quedó disponible para otro paciente.",
        });
      },
      onError: (error: unknown) => {
        const status = (error as { status?: number })?.status;
        const mensaje =
          status === 401
            ? "Iniciá sesión con tu cuenta de paciente para cancelar el turno."
            : status === 403
              ? "Solo podés cancelar tus propios turnos."
              : status === 422
                ? "Este turno ya no se puede cancelar."
                : "No pudimos cancelar el turno. Intentá de nuevo.";
        toast({ title: "No se pudo cancelar", description: mensaje, variant: "destructive" });
      },
    },
  });

  if (!ESTADOS_CANCELABLES.includes(turno.estado)) return null;

  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className="text-destructive hover:text-destructive hover:bg-destructive/10"
          disabled={cancelar.isPending}
          data-testid={`button-cancelar-turno-${turno.id}`}
        >
          {cancelar.isPending ? "Cancelando..." : "Cancelar Turno"}
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>¿Cancelar este turno?</AlertDialogTitle>
          <AlertDialogDescription>
            Se cancelará tu turno del{" "}
            {format(new Date(`${turno.fecha}T00:00:00`), "EEEE d 'de' MMMM", { locale: es })} a las{" "}
            {turno.horaInicio.substring(0, 5)} hs. El horario quedará disponible para otro
            paciente. Esta acción no se puede deshacer.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel data-testid="button-mantener-turno">Mantener turno</AlertDialogCancel>
          <AlertDialogAction
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            onClick={() => cancelar.mutate({ id: turno.id })}
            data-testid="button-confirmar-cancelacion"
          >
            Sí, cancelar
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function ReprogramarTurnoButton({ turno }: { turno: PortalTurno }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const hoy = format(new Date(), "yyyy-MM-dd");
  const [fecha, setFecha] = useState(turno.fecha >= hoy ? turno.fecha : hoy);
  const [hora, setHora] = useState<string | null>(null);

  const { data: slots, isLoading: loadingSlots } = useGetDisponibilidadTurnera(
    turno.turneraId,
    fecha,
    { query: { enabled: open && !!fecha } }
  );

  const ahora = new Date();
  const slotsDisponibles = (slots ?? []).filter((s) => {
    if (!s.disponible) return false;
    // No ofrecer horarios que ya pasaron ni el mismo slot actual
    if (new Date(`${s.fecha}T${s.horaInicio}:00`) <= ahora) return false;
    return !(s.fecha === turno.fecha && s.horaInicio === turno.horaInicio.substring(0, 5));
  });

  const reprogramar = useReprogramarTurno({
    mutation: {
      onSuccess: (data) => {
        queryClient.invalidateQueries({ queryKey: getListTurnosQueryKey() });
        queryClient.invalidateQueries({ queryKey: getGetPortalTurnosQueryKey() });
        queryClient.invalidateQueries({ queryKey: getGetMiPosicionSalaEsperaQueryKey() });
        setOpen(false);
        setHora(null);
        toast({
          title: "Turno reprogramado",
          description: `Tu nuevo turno es el ${format(
            new Date(`${data.turnoNuevo.fecha}T00:00:00`),
            "EEEE d 'de' MMMM",
            { locale: es }
          )} a las ${data.turnoNuevo.horaInicio.substring(0, 5)} hs.`,
        });
      },
      onError: (error: unknown) => {
        const status = (error as { status?: number })?.status;
        const mensaje =
          status === 401
            ? "Iniciá sesión con tu cuenta de paciente para reprogramar el turno."
            : status === 403
              ? "Solo podés reprogramar tus propios turnos."
              : status === 409
                ? "Ese horario se acaba de ocupar. Elegí otro."
                : status === 422
                  ? "Este turno ya no se puede reprogramar o el horario elegido no es válido."
                  : "No pudimos reprogramar el turno. Intentá de nuevo.";
        toast({ title: "No se pudo reprogramar", description: mensaje, variant: "destructive" });
        // Refrescar la disponibilidad por si el slot se acaba de ocupar
        queryClient.invalidateQueries({
          queryKey: getGetDisponibilidadTurneraQueryKey(turno.turneraId, fecha),
        });
      },
    },
  });

  if (!ESTADOS_CANCELABLES.includes(turno.estado)) return null;

  return (
    <Dialog open={open} onOpenChange={(o) => { setOpen(o); if (!o) setHora(null); }}>
      <DialogTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          data-testid={`button-reprogramar-turno-${turno.id}`}
        >
          <CalendarClock className="w-4 h-4 mr-1.5" /> Reprogramar
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Reprogramar turno</DialogTitle>
          <DialogDescription>
            Tu turno actual es el{" "}
            {format(new Date(`${turno.fecha}T00:00:00`), "EEEE d 'de' MMMM", { locale: es })} a
            las {turno.horaInicio.substring(0, 5)} hs. Elegí el nuevo día y horario en la misma
            agenda.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-2">
            <label className="text-sm font-medium">Nueva fecha</label>
            <Input
              type="date"
              min={hoy}
              value={fecha}
              onChange={(e) => {
                setFecha(e.target.value);
                setHora(null);
              }}
              data-testid="input-fecha-reprogramar"
            />
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium">Horarios disponibles</label>
            {loadingSlots ? (
              <div className="py-6 text-center">
                <div className="w-5 h-5 border-4 border-primary border-t-transparent rounded-full animate-spin mx-auto" />
              </div>
            ) : slotsDisponibles.length === 0 ? (
              <p className="text-sm text-muted-foreground py-3" data-testid="text-sin-horarios">
                No hay horarios disponibles para ese día. Probá con otra fecha.
              </p>
            ) : (
              <div className="grid grid-cols-4 gap-2 max-h-48 overflow-y-auto pr-1">
                {slotsDisponibles.map((s) => (
                  <Button
                    key={s.horaInicio}
                    type="button"
                    size="sm"
                    variant={hora === s.horaInicio ? "default" : "outline"}
                    onClick={() => setHora(s.horaInicio)}
                    data-testid={`button-slot-${s.horaInicio}`}
                  >
                    {s.horaInicio}
                  </Button>
                ))}
              </div>
            )}
          </div>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => setOpen(false)} data-testid="button-cerrar-reprogramar">
            Volver
          </Button>
          <Button
            disabled={!hora || reprogramar.isPending}
            onClick={() => hora && reprogramar.mutate({ id: turno.id, data: { fecha, horaInicio: hora } })}
            data-testid="button-confirmar-reprogramacion"
          >
            {reprogramar.isPending ? "Reprogramando..." : "Confirmar cambio"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function MiTurnoHoyCard({ turno }: { turno: MiSalaEsperaTurno }) {
  const lugar = (
    <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-muted-foreground mt-2">
      <span className="flex items-center gap-1">
        <Clock className="w-3.5 h-3.5" /> Turno {turno.horaInicio.substring(0, 5)} hs
      </span>
      <span className="flex items-center gap-1">
        <MapPin className="w-3.5 h-3.5" /> {turno.turneraNombre}
        {turno.profesionalNombre ? ` — ${turno.profesionalNombre}` : ""}
      </span>
    </div>
  );

  if (turno.estado === "llamado") {
    return (
      <Card className="border-2 border-blue-500 bg-blue-50 shadow-lg animate-pulse" data-testid="card-llamado">
        <CardContent className="p-6 text-center space-y-2">
          <div className="mx-auto w-14 h-14 rounded-full bg-blue-600 flex items-center justify-center">
            <Bell className="w-7 h-7 text-white" />
          </div>
          <div className="text-2xl font-black text-blue-700">¡Te están llamando!</div>
          <p className="text-blue-700/80 font-medium">Acercate al consultorio ahora</p>
          <div className="flex justify-center">{lugar}</div>
        </CardContent>
      </Card>
    );
  }

  if (turno.estado === "arribo" || turno.estado === "en_sala") {
    return (
      <Card className="border-amber-300 bg-amber-50/60" data-testid="card-en-espera">
        <CardContent className="p-6">
          <div className="flex items-center gap-5">
            <div className="w-16 h-16 rounded-2xl bg-amber-500 text-white flex flex-col items-center justify-center shrink-0 shadow">
              <span className="text-2xl font-black leading-none">
                {turno.posicion != null ? ordinal(turno.posicion) : "—"}
              </span>
              <span className="text-[10px] uppercase tracking-wide">en fila</span>
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-lg font-bold text-amber-800 flex items-center gap-2">
                <Users className="w-5 h-5" /> En espera
                {turno.posicion != null && (
                  <span className="font-medium text-amber-700">
                    ({ordinal(turno.posicion)} en la fila de {turno.enEsperaTurnera})
                  </span>
                )}
              </div>
              {turno.esperaEstimadaMinutos != null && (
                <p
                  className="text-sm font-semibold text-amber-800 mt-0.5"
                  data-testid="text-espera-estimada"
                >
                  ~{turno.esperaEstimadaMinutos} min de espera estimada
                </p>
              )}
              {turno.esperaMinutos != null && (
                <p className="text-sm text-amber-700/80 mt-0.5">
                  Esperando hace {turno.esperaMinutos} min
                </p>
              )}
              {lugar}
            </div>
          </div>
        </CardContent>
      </Card>
    );
  }

  if (turno.estado === "en_atencion") {
    return (
      <Card className="border-purple-200 bg-purple-50/50" data-testid="card-en-atencion">
        <CardContent className="p-6">
          <div className="text-lg font-bold text-purple-700 flex items-center gap-2">
            <Stethoscope className="w-5 h-5" /> En atención
          </div>
          <p className="text-sm text-purple-700/70 mt-0.5">El profesional te está atendiendo</p>
          {lugar}
        </CardContent>
      </Card>
    );
  }

  if (["atendido", "finalizado", "informado", "publicado_informe"].includes(turno.estado)) {
    return (
      <Card className="bg-muted/20" data-testid="card-finalizado">
        <CardContent className="p-6">
          <div className="text-lg font-bold text-emerald-700 flex items-center gap-2">
            <CheckCircle2 className="w-5 h-5" /> Atención finalizada
          </div>
          {lugar}
        </CardContent>
      </Card>
    );
  }

  if (turno.estado === "ausente" || turno.estado === "cancelado") {
    return (
      <Card className="bg-muted/20" data-testid="card-ausente">
        <CardContent className="p-6">
          <div className="text-lg font-semibold text-muted-foreground">
            {turno.estado === "ausente" ? "Turno marcado como ausente" : "Turno cancelado"}
          </div>
          {lugar}
        </CardContent>
      </Card>
    );
  }

  // pendiente / reservado / confirmado / publicado, etc: todavía no se presentó
  return (
    <Card className="border-primary/30" data-testid="card-pendiente">
      <CardContent className="p-6">
        <div className="text-lg font-bold flex items-center gap-2">
          <CalendarIcon className="w-5 h-5 text-primary" /> Tenés turno hoy
        </div>
        <p className="text-sm text-muted-foreground mt-0.5">
          Cuando llegues, anunciate en recepción para entrar a la fila
        </p>
        {lugar}
      </CardContent>
    </Card>
  );
}

function MiColaEnVivo() {
  const { data, isLoading } = useGetMiPosicionSalaEspera({
    query: { refetchInterval: 5_000, refetchIntervalInBackground: true },
  });

  const turnos = data?.turnos ?? [];
  const { activarAvisos, sonidoActivado, notifPermission, preferenciaGuardada } =
    useLlamadoAlert(turnos);

  // Con la preferencia guardada, el audio desbloqueado alcanza: no forzamos el
  // pedido de permiso de notificaciones de nuevo en cada visita
  const avisosListos = sonidoActivado && (notifPermission !== "default" || preferenciaGuardada);
  const hayTurnoActivo = turnos.some((t) =>
    ["arribo", "en_sala", "llamado", "pendiente", "reservado", "confirmado", "publicado"].includes(
      t.estado
    )
  );

  return (
    <div className="space-y-4 animate-in fade-in duration-500" data-testid="seccion-mi-cola">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-bold">Hoy en la clínica</h2>
        <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
          En vivo
        </span>
      </div>
      {hayTurnoActivo && !avisosListos && (
        <Card className="border-blue-200 bg-blue-50/60" data-testid="card-activar-avisos">
          <CardContent className="p-4 flex flex-col sm:flex-row items-start sm:items-center gap-3">
            <div className="flex items-start gap-3 flex-1">
              <BellRing className="w-5 h-5 text-blue-600 mt-0.5 shrink-0" />
              <div className="text-sm">
                <p className="font-semibold text-blue-800">
                  {preferenciaGuardada
                    ? "Tocá la pantalla para reactivar los avisos"
                    : "Activá los avisos de llamado"}
                </p>
                <p className="text-blue-700/80">
                  {preferenciaGuardada
                    ? "Ya los habías activado: con tocar en cualquier parte de la página quedan listos de nuevo."
                    : "Te avisamos con sonido, vibración y una notificación cuando te llamen, aunque tengas la pantalla apagada o estés en otra app."}
                </p>
              </div>
            </div>
            <Button
              size="sm"
              className="shrink-0 bg-blue-600 hover:bg-blue-700 text-white"
              onClick={() => void activarAvisos()}
              data-testid="button-activar-avisos"
            >
              <Bell className="w-4 h-4 mr-1.5" /> Activar avisos
            </Button>
          </CardContent>
        </Card>
      )}
      {hayTurnoActivo && avisosListos && (
        <p
          className="text-xs text-muted-foreground flex items-center gap-1.5"
          data-testid="text-avisos-activados"
        >
          <BellRing className="w-3.5 h-3.5 text-emerald-600" />
          Avisos activados: vas a escuchar un tono
          {notifPermission === "granted"
            ? " y recibir una notificación cuando te llamen."
            : " cuando te llamen (notificaciones bloqueadas en el navegador)."}
        </p>
      )}
      {isLoading ? (
        <Card>
          <CardContent className="py-8 text-center">
            <div className="w-6 h-6 border-4 border-primary border-t-transparent rounded-full animate-spin mx-auto" />
          </CardContent>
        </Card>
      ) : turnos.length === 0 ? (
        <Card className="bg-muted/10 border-dashed">
          <CardContent className="py-8 text-center text-muted-foreground text-sm">
            No tenés turnos para hoy. Cuando tengas un turno, vas a poder seguir tu lugar en la
            fila desde acá, como en Uber.
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4">
          {turnos.map((t) => (
            <MiTurnoHoyCard key={t.turnoId} turno={t} />
          ))}
        </div>
      )}
    </div>
  );
}

function ListaTurnos({
  turnos,
  isLoading,
  emptyContent,
}: {
  turnos: PortalTurno[];
  isLoading: boolean;
  emptyContent: React.ReactNode;
}) {
  const futuros = turnos.filter(t => new Date(`${t.fecha}T${t.horaInicio}`) >= new Date());
  const pasados = turnos
    .filter(t => new Date(`${t.fecha}T${t.horaInicio}`) < new Date())
    .sort((a, b) => `${b.fecha}T${b.horaInicio}`.localeCompare(`${a.fecha}T${a.horaInicio}`));

  return (
    <div className="space-y-6 animate-in fade-in duration-500" data-testid="seccion-mis-turnos">
      {isLoading ? (
        <div className="text-center py-12"><div className="w-8 h-8 border-4 border-primary border-t-transparent rounded-full animate-spin mx-auto"></div></div>
      ) : turnos.length === 0 ? (
        <>{emptyContent}</>
      ) : (
        <>
              <div className="flex items-center justify-between">
                <h2 className="text-xl font-bold">Mis Turnos Próximos</h2>
                <Link href="/reservar"><Button variant="outline" size="sm">Nuevo Turno</Button></Link>
              </div>

              {futuros.length > 0 ? (
                <div className="grid gap-4">
                  {futuros.map(turno => (
                    <Card key={turno.id} className="overflow-hidden border-l-4 border-l-primary">
                      <div className="sm:flex">
                        <div className="bg-primary/5 p-6 sm:w-48 flex flex-col justify-center items-center text-center border-b sm:border-b-0 sm:border-r border-border/50">
                          <div className="text-sm font-semibold uppercase text-primary mb-1">
                            {format(new Date(turno.fecha), "MMM", { locale: es })}
                          </div>
                          <div className="text-4xl font-black text-foreground">
                            {format(new Date(turno.fecha), "dd")}
                          </div>
                          <div className="text-sm text-muted-foreground mt-1 capitalize">
                            {format(new Date(turno.fecha), "EEEE", { locale: es })}
                          </div>
                        </div>
                        <div className="p-6 flex-1 flex flex-col justify-between">
                          <div>
                            <div className="flex justify-between items-start mb-2">
                              <h3 className="text-lg font-bold flex items-center gap-2">
                                <Clock className="w-5 h-5 text-primary" /> {turno.horaInicio.substring(0, 5)} hs
                              </h3>
                              <StatusBadge estado={turno.estado} />
                            </div>
                            <div className="space-y-2 mt-4 text-sm">
                              <div className="flex items-center gap-2 text-muted-foreground">
                                <UserCircle className="w-4 h-4" /> 
                                <span className="font-medium text-foreground">Dr. {turno.profesionalApellido || 'Profesional Asignado'}</span>
                                {turno.especialidadNombre && ` • ${turno.especialidadNombre}`}
                              </div>
                              <div className="flex items-center gap-2 text-muted-foreground">
                                <MapPin className="w-4 h-4" />
                                {turno.sedeNombre || 'Sede Principal'}
                              </div>
                            </div>
                          </div>
                          {turno.videollamadaUrl && (
                            <div className="mt-5 flex flex-wrap items-center gap-4 rounded-lg border border-violet-200 dark:border-violet-800 bg-violet-50 dark:bg-violet-950/40 p-3">
                              <div className="bg-violet-600 text-white rounded-lg p-2 shrink-0">
                                <Video className="w-5 h-5" />
                              </div>
                              <div className="text-xs text-violet-900 dark:text-violet-100 flex-1 min-w-[160px]">
                                <span className="font-medium block mb-0.5">Turno por videollamada</span>
                                Cuando llegue el horario, unite desde este mismo link. No hace falta instalar nada.
                              </div>
                              <Button
                                asChild
                                size="sm"
                                className="bg-violet-600 hover:bg-violet-700 text-white gap-1.5"
                                data-testid={`button-videollamada-${turno.id}`}
                              >
                                <a href={turno.videollamadaUrl} target="_blank" rel="noopener noreferrer">
                                  <Video className="w-4 h-4" /> Unirse a la videollamada
                                </a>
                              </Button>
                            </div>
                          )}
                          {turno.qrCodigo && (
                            <div className="mt-5 flex items-center gap-4 rounded-lg border bg-muted/20 p-3">
                              <div className="bg-white p-1.5 rounded-md border shrink-0">
                                <QRCodeSVG value={turno.qrCodigo} size={84} level="M" />
                              </div>
                              <div className="text-xs text-muted-foreground">
                                <span className="font-medium text-foreground block mb-0.5">Tu código de acceso</span>
                                Mostralo en recepción al llegar: te identifican al instante, sin hacer fila para dar tus datos.
                              </div>
                            </div>
                          )}
                          <div className="mt-6 flex justify-end gap-2">
                            <ReprogramarTurnoButton turno={turno} />
                            <CancelarTurnoButton turno={turno} />
                          </div>
                        </div>
                      </div>
                    </Card>
                  ))}
                </div>
              ) : (
                <Card className="bg-muted/10">
                  <CardContent className="py-8 text-center text-muted-foreground">
                    No tiene turnos futuros programados.
                  </CardContent>
                </Card>
              )}

              {pasados.length > 0 && (
                <div className="pt-8">
                  <h3 className="text-lg font-semibold mb-4 text-muted-foreground">Historial de Atención</h3>
                  <div className="grid gap-3">
                    {pasados.map(turno => (
                      <Card key={turno.id} className="bg-muted/10 opacity-75">
                        <CardContent className="p-4 flex flex-wrap gap-4 justify-between items-center text-sm">
                          <div className="flex items-center gap-4 min-w-[200px]">
                            <div className="font-medium">{format(new Date(turno.fecha), "dd/MM/yyyy")}</div>
                            <StatusBadge estado={turno.estado} />
                          </div>
                          <div className="text-muted-foreground flex-1">
                            Dr. {turno.profesionalApellido || '-'} • {turno.especialidadNombre || '-'}
                          </div>
                        </CardContent>
                      </Card>
                    ))}
                  </div>
                </div>
              )}
        </>
      )}
    </div>
  );
}

function turnoAPortalTurno(t: Turno): PortalTurno {
  return {
    id: t.id,
    turneraId: t.turneraId,
    fecha: t.fecha,
    horaInicio: t.horaInicio,
    estado: t.estado,
    modalidad: t.modalidad ?? "presencial",
    profesionalNombre: t.profesional?.nombre ?? null,
    profesionalApellido: t.profesional?.apellido ?? null,
    especialidadNombre: t.turnera?.especialidad?.nombre ?? null,
    sedeNombre: t.turnera?.sede?.nombre ?? null,
    qrCodigo: t.qrCodigo ?? null,
    videollamadaUrl: t.videollamadaUrl ?? null,
  };
}

const TIPO_CERTIFICADO_LABEL: Record<string, string> = {
  reposo: "Reposo",
  aptitud: "Aptitud física",
  asistencia: "Asistencia",
  otro: "Certificado",
};

function MisDocumentos({ pacienteId }: { pacienteId: number }) {
  const { data: recetas, isLoading: cargandoRecetas, isError: errorRecetas } = useGetPatientPrescriptions(pacienteId);
  const { data: certificados, isLoading: cargandoCertificados, isError: errorCertificados } = useGetPatientCertificates(pacienteId);

  const cargando = cargandoRecetas || cargandoCertificados;
  const hayError = errorRecetas || errorCertificados;
  const hayDocumentos = (recetas?.length ?? 0) + (certificados?.length ?? 0) > 0;

  if (cargando) return null;
  if (hayError) {
    return (
      <Card className="bg-muted/10 border-dashed" data-testid="error-mis-documentos">
        <CardContent className="py-6 text-center text-sm text-muted-foreground">
          No pudimos cargar tus recetas y certificados. Actualizá la página para reintentar.
        </CardContent>
      </Card>
    );
  }
  if (!hayDocumentos) return null;

  return (
    <div className="space-y-4 animate-in fade-in duration-500" data-testid="seccion-mis-documentos">
      <h2 className="text-xl font-bold">Mis recetas y certificados</h2>
      <p className="text-sm text-muted-foreground -mt-2">
        Todo lo que te envía tu médico queda guardado acá, siempre disponible.
      </p>
      <div className="grid gap-3">
        {(recetas ?? []).map((r) => (
          <Card key={`receta-${r.id}`} data-testid={`card-receta-${r.id}`}>
            <CardContent className="p-4 flex items-start gap-3">
              <div className="bg-emerald-100 text-emerald-700 rounded-lg p-2 shrink-0">
                <Pill className="w-5 h-5" />
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-semibold">Receta: {r.medication}</span>
                  {r.createdAt && (
                    <span className="text-xs text-muted-foreground">
                      {format(new Date(r.createdAt), "dd/MM/yyyy")}
                    </span>
                  )}
                </div>
                <p className="text-sm text-muted-foreground mt-0.5">
                  {[r.dosage, r.frequency, r.duration].filter(Boolean).join(" • ") || "Ver indicaciones"}
                </p>
                {r.instructions && <p className="text-sm mt-1">{r.instructions}</p>}
              </div>
            </CardContent>
          </Card>
        ))}
        {(certificados ?? []).map((c) => (
          <Card key={`certificado-${c.id}`} data-testid={`card-certificado-${c.id}`}>
            <CardContent className="p-4 flex items-start gap-3">
              <div className="bg-blue-100 text-blue-700 rounded-lg p-2 shrink-0">
                <FileBadge className="w-5 h-5" />
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-semibold">
                    Certificado de {TIPO_CERTIFICADO_LABEL[c.certificateType] ?? c.certificateType}
                  </span>
                  {c.createdAt && (
                    <span className="text-xs text-muted-foreground">
                      {format(new Date(c.createdAt), "dd/MM/yyyy")}
                    </span>
                  )}
                </div>
                {c.restDays != null && (
                  <p className="text-sm text-muted-foreground mt-0.5">{c.restDays} día(s) de reposo</p>
                )}
                <p className="text-sm mt-1 whitespace-pre-wrap">{c.content}</p>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}

function MisTurnosLogueado() {
  const { data, isLoading } = useListMisTurnos();
  const turnos = (data ?? []).map(turnoAPortalTurno);

  return (
    <ListaTurnos
      turnos={turnos}
      isLoading={isLoading}
      emptyContent={
        <Card className="bg-muted/20 border-dashed">
          <CardContent className="flex flex-col items-center justify-center py-12 text-center">
            <CalendarIcon className="w-12 h-12 text-muted-foreground/30 mb-4" />
            <h3 className="text-lg font-medium">Todavía no tenés turnos</h3>
            <p className="text-muted-foreground mt-1 max-w-md">
              Cuando reserves un turno, lo vas a ver acá automáticamente.
            </p>
            <Link href="/reservar" className="mt-6">
              <Button>Solicitar un Nuevo Turno</Button>
            </Link>
          </CardContent>
        </Card>
      }
    />
  );
}

function BuscadorPorDni() {
  const [dni, setDni] = useState("");
  const [searchedDni, setSearchedDni] = useState("");

  // Endpoint específico del portal: el servidor devuelve solo los turnos del DNI consultado
  const { data: turnosRes, isLoading } = useGetPortalTurnos(
    { dni: searchedDni },
    { query: { enabled: searchedDni.length >= 7 } }
  );

  const misTurnos = turnosRes?.turnos ?? [];

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    if (dni.length >= 7) {
      setSearchedDni(dni);
    }
  };

  return (
    <>
      <Card className="border-primary/20 shadow-md">
        <CardContent className="p-6">
          <form onSubmit={handleSearch} className="flex flex-col sm:flex-row gap-4 items-end">
            <div className="flex-1 space-y-2 w-full">
              <label className="text-sm font-medium">Ingrese su DNI para acceder</label>
              <Input 
                placeholder="Sin puntos ni espacios" 
                value={dni}
                onChange={e => setDni(e.target.value)}
                className="h-12 text-lg"
              />
            </div>
            <Button type="submit" size="lg" className="w-full sm:w-auto h-12 px-8" disabled={dni.length < 7}>
              <Search className="w-5 h-5 mr-2" /> Buscar
            </Button>
          </form>
        </CardContent>
      </Card>

      {searchedDni && (
        <ListaTurnos
          turnos={misTurnos}
          isLoading={isLoading}
          emptyContent={
            <Card className="bg-muted/20 border-dashed">
              <CardContent className="flex flex-col items-center justify-center py-12 text-center">
                <CalendarIcon className="w-12 h-12 text-muted-foreground/30 mb-4" />
                <h3 className="text-lg font-medium">No se encontraron turnos</h3>
                <p className="text-muted-foreground mt-1 max-w-md">No tenemos registros asociados al DNI {searchedDni}. Verifique el número e intente nuevamente.</p>
                <Link href="/reservar" className="mt-6">
                  <Button>Solicitar un Nuevo Turno</Button>
                </Link>
              </CardContent>
            </Card>
          }
        />
      )}
    </>
  );
}

export default function MiTurno() {
  const { user } = useAuth();
  const esPaciente = user?.rol === "paciente";

  return (
    <div className="max-w-3xl mx-auto w-full space-y-8">
      <div className="text-center space-y-2">
        <div className="mx-auto bg-primary w-16 h-16 rounded-2xl flex items-center justify-center mb-6 shadow-lg shadow-primary/20 transform rotate-3">
          <Hospital className="w-8 h-8 text-white -rotate-3" />
        </div>
        <h1 className="text-3xl font-bold tracking-tight text-foreground">Portal del Paciente</h1>
        <p className="text-muted-foreground">
          {esPaciente ? "Tus turnos y estudios, siempre a mano" : "Consulte sus turnos y estudios"}
        </p>
      </div>

      {esPaciente ? (
        <>
          <VideollamadaPacienteBanner />
          <MiColaEnVivo />
          {user?.pacienteId != null && <MisDocumentos pacienteId={user.pacienteId} />}
          {user?.pacienteId != null && <MisEstudiosPrevios pacienteId={user.pacienteId} />}
          <MisTurnosLogueado />
        </>
      ) : (
        <BuscadorPorDni />
      )}
    </div>
  );
}
