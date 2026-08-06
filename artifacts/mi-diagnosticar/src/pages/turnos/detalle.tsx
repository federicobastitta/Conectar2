import { useState } from "react";
import { Link, useParams, useLocation } from "wouter";
import { DialogoCodigoSupervisor } from "@/components/recepcion/dialogo-codigo-supervisor";
import { format } from "date-fns";
import { es } from "date-fns/locale";
import { useQueryClient } from "@tanstack/react-query";
import {
  useGetTurno,
  getGetTurnoQueryKey,
  useAdmitirTurno,
  useCancelarTurno,
  useDescolorearTurno,
  useEncolarTurnoKlinicos,
} from "@workspace/api-client-react";
import { useAuth } from "@/hooks/use-auth";
import { marcaColorFondo, marcaColorLabel } from "@/lib/marca-color";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { getEstadoMeta, getEstadoMacro, ESTADO_MACRO_META } from "@/lib/episodio";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader,
  AlertDialogTitle, AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import {
  ArrowLeft, Calendar, Clock, User, Stethoscope, MapPin,
  LogIn, X, FileText, CreditCard, History, Send,
} from "lucide-react";

const RECEPCIONABLES = ["pendiente", "reservado", "confirmado", "publicado", "ausente"];
const CANCELABLES = ["pendiente", "reservado", "confirmado", "publicado", "ausente", "arribo"];

// Fecha de hoy en Argentina (YYYY-MM-DD): recepcionar solo el día de la consulta
function hoyArgentina(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Argentina/Buenos_Aires" }).format(new Date());
}

function fmtFechaHora(iso?: string | null): string | null {
  if (!iso) return null;
  try {
    return format(new Date(iso), "dd/MM/yyyy HH:mm", { locale: es });
  } catch {
    return null;
  }
}

function Dato({ label, valor }: { label: string; valor?: string | null }) {
  if (!valor) return null;
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="text-sm font-medium">{valor}</dd>
    </div>
  );
}

export default function TurnoDetalle() {
  const { id } = useParams<{ id: string }>();
  const turnoId = Number(id);
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const { data: turno, isLoading, error } = useGetTurno(turnoId, {
    query: { enabled: Number.isFinite(turnoId) },
  });

  const invalidar = () =>
    void queryClient.invalidateQueries({ queryKey: getGetTurnoQueryKey(turnoId) });

  const [pedirCodigoSupervisor, setPedirCodigoSupervisor] = useState(false);

  const admitir = useAdmitirTurno({
    mutation: {
      onSuccess: () => {
        toast({ title: "Paciente recepcionado", description: "Pasó a la sala de espera." });
        setPedirCodigoSupervisor(false);
        invalidar();
      },
      onError: (err: unknown) => {
        const e = (err as { data?: { codigo?: string; error?: string } })?.data ?? {};
        if (e?.codigo === "codigo_supervisor_requerido") {
          setPedirCodigoSupervisor(true);
        } else if (e?.codigo === "codigo_supervisor_invalido") {
          toast({ title: e.error ?? "Código de supervisor incorrecto", variant: "destructive" });
        } else {
          toast({ title: "Error", description: "No se pudo recepcionar al paciente", variant: "destructive" });
        }
      },
    },
  });

  const { user } = useAuth();
  const esAdmin = user?.rol === "admin";
  const esStaff = user?.rol === "admin" || user?.rol === "recepcionista" || user?.rol === "medico";

  const encolarKlinicos = useEncolarTurnoKlinicos({
    mutation: {
      onSuccess: (resultado) => {
        if (resultado.yaExistia) {
          toast({
            title: "Ya había un trabajo activo",
            description: `El turno ya está en la cola de Klinicos (trabajo #${resultado.trabajoId}).`,
          });
        } else {
          toast({
            title: "Encolado en Klinicos",
            description: `Se creó el trabajo #${resultado.trabajoId} para el robot.`,
          });
        }
        invalidar();
      },
      onError: (err: unknown) => {
        const e = (err as { data?: { error?: string } })?.data ?? {};
        toast({
          title: "No se pudo encolar",
          description: e.error ?? "Ocurrió un error al encolar el turno en Klinicos",
          variant: "destructive",
        });
      },
    },
  });

  const descolorear = useDescolorearTurno({
    mutation: {
      onSuccess: () => {
        toast({ title: "Marca de color quitada" });
        invalidar();
      },
      onError: () =>
        toast({ title: "Error", description: "No se pudo quitar la marca de color", variant: "destructive" }),
    },
  });

  const cancelar = useCancelarTurno({
    mutation: {
      onSuccess: () => {
        toast({ title: "Turno cancelado" });
        invalidar();
      },
      onError: () =>
        toast({ title: "Error", description: "No se pudo cancelar el turno", variant: "destructive" }),
    },
  });

  if (isLoading) {
    return (
      <div className="space-y-4 max-w-3xl">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-64 rounded-lg" />
      </div>
    );
  }

  if (error || !turno) {
    return (
      <div className="max-w-3xl space-y-4">
        <Button variant="ghost" onClick={() => navigate("/turnos")} className="gap-2">
          <ArrowLeft className="w-4 h-4" /> Volver a turnos
        </Button>
        <Card>
          <CardContent className="py-16 text-center text-muted-foreground">
            No se encontró el turno #{id}.
          </CardContent>
        </Card>
      </div>
    );
  }

  const meta = getEstadoMeta(turno.estado);
  const macroMeta = ESTADO_MACRO_META[getEstadoMacro(turno.estado)];
  const fechaLegible = format(new Date(`${turno.fecha}T00:00:00`), "EEEE d 'de' MMMM yyyy", { locale: es });
  const profesional = turno.profesional
    ? `${turno.profesional.apellido ?? ""}${turno.profesional.apellido && turno.profesional.nombre ? ", " : ""}${turno.profesional.nombre ?? ""}`
    : "Sin profesional asignado";

  return (
    <div className="max-w-3xl space-y-5">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <Button variant="ghost" onClick={() => history.length > 1 ? history.back() : navigate("/turnos")} className="gap-2 -ml-2">
          <ArrowLeft className="w-4 h-4" /> Volver
        </Button>
        <div className="flex items-center gap-2">
          <span className={`inline-flex items-center gap-1.5 text-sm font-medium px-3 py-1 rounded-full border ${macroMeta.bg} ${macroMeta.color} ${macroMeta.border}`}>
            <span className={`w-2 h-2 rounded-full ${macroMeta.dot}`} />
            {macroMeta.label}
          </span>
          {meta.label !== macroMeta.label && (
            <span className="text-xs text-muted-foreground">({meta.label})</span>
          )}
          {turno.marcaColor && (
            <span
              className={`inline-flex items-center gap-1.5 text-xs font-medium px-2.5 py-1 rounded-full border ${marcaColorFondo(turno.marcaColor)} ${turno.marcaColor === "naranja" ? "border-orange-300 text-orange-800 dark:text-orange-300" : "border-yellow-300 text-yellow-800 dark:text-yellow-300"}`}
              data-testid="badge-marca-color"
            >
              {marcaColorLabel(turno.marcaColor)}
            </span>
          )}
          {turno.marcaColor && esAdmin && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => descolorear.mutate({ id: turno.id })}
              disabled={descolorear.isPending}
              data-testid="boton-descolorear"
            >
              Descolorear paciente
            </Button>
          )}
        </div>
      </div>

      <div>
        <h1 className="text-3xl font-bold tracking-tight">Turno #{turno.id}</h1>
        <p className="text-muted-foreground capitalize">
          {fechaLegible} · {turno.horaInicio}–{turno.horaFin} hs
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base flex items-center gap-2">
              <User className="w-4 h-4 text-primary" /> Paciente
            </CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="space-y-2">
              <Dato
                label="Nombre"
                valor={turno.paciente ? `${turno.paciente.apellido}, ${turno.paciente.nombre}` : `#${turno.pacienteId}`}
              />
              <Dato label="DNI" valor={turno.paciente?.dni} />
              <Dato label="Teléfono" valor={turno.paciente?.telefono} />
              <Dato label="Cobertura" valor={turno.cobertura ?? turno.paciente?.cobertura} />
              <Dato label="N° de afiliado" valor={turno.nroAfiliado} />
            </dl>
            {turno.paciente && (
              <Link href={`/pacientes/${turno.pacienteId}`}>
                <Button variant="outline" size="sm" className="mt-4 gap-2" data-testid="link-paciente">
                  <FileText className="w-3.5 h-3.5" /> Ver ficha del paciente
                </Button>
              </Link>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base flex items-center gap-2">
              <Stethoscope className="w-4 h-4 text-primary" /> Agenda
            </CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="space-y-2">
              <Dato label="Profesional" valor={profesional} />
              <Dato label="Turnera" valor={turno.turnera?.nombre} />
              <Dato label="Especialidad" valor={turno.turnera?.especialidad?.nombre} />
              <Dato label="Sede" valor={turno.turnera?.sede?.nombre} />
              <Dato label="Modalidad" valor={turno.modalidad === "videoconsulta" ? "Videoconsulta" : "Presencial"} />
              {turno.sobreturn && <Dato label="Tipo" valor="Sobreturno" />}
            </dl>
          </CardContent>
        </Card>
      </div>

      {(turno.motivoConsulta || turno.observaciones) && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base flex items-center gap-2">
              <FileText className="w-4 h-4 text-primary" /> Notas
            </CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="space-y-2">
              <Dato label="Motivo de consulta" valor={turno.motivoConsulta} />
              <Dato label="Observaciones" valor={turno.observaciones} />
            </dl>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base flex items-center gap-2">
            <History className="w-4 h-4 text-primary" /> Recorrido
          </CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="grid gap-2 sm:grid-cols-2">
            <Dato label="Reservado" valor={fmtFechaHora(turno.createdAt)} />
            <Dato
              label="Recepcionado"
              valor={
                turno.admitidoEn
                  ? `${fmtFechaHora(turno.admitidoEn)}${turno.admitidoPor ? ` · por ${turno.admitidoPor}` : ""}`
                  : null
              }
            />
            <Dato label="Llamado" valor={fmtFechaHora(turno.llamadoEn)} />
            <Dato label="Atendido" valor={fmtFechaHora(turno.atendidoEn)} />
          </dl>
        </CardContent>
      </Card>

      <div className="flex gap-2 flex-wrap">
        {RECEPCIONABLES.includes(turno.estado) && turno.fecha === hoyArgentina() && (
          <Button
            onClick={() => admitir.mutate({ id: turno.id })}
            disabled={admitir.isPending}
            className="gap-2"
            data-testid="boton-recepcionar-detalle"
          >
            <LogIn className="w-4 h-4" /> Recepcionar
          </Button>
        )}
        {CANCELABLES.includes(turno.estado) && (
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button variant="destructive" className="gap-2" disabled={cancelar.isPending} data-testid="boton-cancelar-detalle">
                <X className="w-4 h-4" /> Cancelar turno
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>¿Cancelar este turno?</AlertDialogTitle>
                <AlertDialogDescription>
                  Se cancelará el turno de {turno.paciente ? `${turno.paciente.nombre} ${turno.paciente.apellido}` : "este paciente"} del {turno.fecha} a las {turno.horaInicio}. Esta acción libera el horario.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Volver</AlertDialogCancel>
                <AlertDialogAction onClick={() => cancelar.mutate({ id: turno.id })}>
                  Sí, cancelar
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        )}
        {esStaff && turno.estado !== "cancelado" && (
          <Button
            variant="outline"
            className="gap-2"
            onClick={() => encolarKlinicos.mutate({ id: turno.id })}
            disabled={encolarKlinicos.isPending}
            data-testid="boton-encolar-klinicos"
          >
            <Send className="w-4 h-4" /> Encolar en Klinicos
          </Button>
        )}
      </div>

      <DialogoCodigoSupervisor
        abierto={pedirCodigoSupervisor}
        pendiente={admitir.isPending}
        onConfirmar={(codigo) => admitir.mutate({ id: turno.id, data: { codigoSupervisor: codigo } })}
        onCancelar={() => setPedirCodigoSupervisor(false)}
      />
    </div>
  );
}
