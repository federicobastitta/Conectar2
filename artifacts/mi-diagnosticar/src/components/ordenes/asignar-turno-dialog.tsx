import { useEffect, useState } from "react";
import { useLocation } from "wouter";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  getSugerenciasTurno,
  asignarTurnoOrden,
  type OrdenListItem,
  type OpcionTurnoSugerida,
} from "@/api/ordenes-practicas";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import {
  CalendarPlus,
  Clock,
  Loader2,
  MapPin,
  Siren,
  UserCircle,
  CalendarX2,
} from "lucide-react";

const DIAS = ["Domingo", "Lunes", "Martes", "Miércoles", "Jueves", "Viernes", "Sábado"];
const MESES = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];

function fechaLarga(f: string): string {
  const d = new Date(`${f}T00:00:00`);
  if (isNaN(d.getTime())) return f;
  return `${DIAS[d.getDay()]} ${d.getDate()} de ${MESES[d.getMonth()]}`;
}

export function AsignarTurnoDialog({
  item,
  onClose,
}: {
  item: OrdenListItem | null;
  onClose: () => void;
}) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [, navigate] = useLocation();
  const [opcionElegida, setOpcionElegida] = useState<OpcionTurnoSugerida | null>(null);
  // Para prácticas mixtas (turno + demanda espontánea): el recepcionista
  // informa las dos modalidades y el paciente elige.
  const [modalidadElegida, setModalidadElegida] = useState<"turno" | "demanda" | null>(null);

  const ordenId = item?.orden.id ?? null;
  // Al cambiar de orden, el diálogo arranca limpio (sin arrastrar la
  // modalidad u opción elegida de la orden anterior).
  useEffect(() => {
    setOpcionElegida(null);
    setModalidadElegida(null);
  }, [ordenId]);
  const { data, isLoading, error } = useQuery({
    queryKey: ["sugerencias-turno", ordenId],
    queryFn: () => getSugerenciasTurno(ordenId!),
    enabled: ordenId !== null,
    staleTime: 30_000,
  });

  const asignarMutation = useMutation({
    mutationFn: (body: { turneraId: number; fecha?: string; horaInicio?: string }) =>
      asignarTurnoOrden(ordenId!, body),
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ["ordenes-practicas"] });
      qc.invalidateQueries({ queryKey: ["sugerencias-turno", ordenId] });
      toast({
        title: res.turno.esGuardia ? "Paciente sumado a la guardia" : "Turno asignado",
        description: res.turno.esGuardia
          ? "Quedó en el circuito de demanda espontánea de hoy."
          : `${fechaLarga(res.turno.fecha)} a las ${res.turno.horaInicio} hs.`,
      });
      cerrar();
    },
    onError: (e: Error) => {
      toast({ title: "No se pudo asignar el turno", description: e.message, variant: "destructive" });
      // Otra recepción pudo haber ganado el slot: refrescamos las opciones.
      qc.invalidateQueries({ queryKey: ["sugerencias-turno", ordenId] });
      setOpcionElegida(null);
    },
  });

  function cerrar() {
    setOpcionElegida(null);
    setModalidadElegida(null);
    onClose();
  }

  function confirmarOpcion(op: OpcionTurnoSugerida) {
    setOpcionElegida(op);
    asignarMutation.mutate({ turneraId: op.turneraId, fecha: op.fecha, horaInicio: op.horaInicio });
  }

  // Flujo manual precargado: DNI del paciente + práctica en el buscador.
  function irAFlujoManual() {
    const q = new URLSearchParams();
    const pac = data?.paciente;
    if (pac?.dni) q.set("dni", pac.dni);
    if (pac) {
      q.set("nombre", pac.nombre);
      q.set("apellido", pac.apellido);
      if (pac.id) q.set("pacienteId", String(pac.id));
      if (pac.telefono) q.set("telefono", pac.telefono);
      if (pac.cobertura) q.set("cobertura", pac.cobertura);
      if (pac.nroAfiliado) q.set("nroAfiliado", pac.nroAfiliado);
    }
    if (data?.practica.codigoNomenclador) q.set("practica", data.practica.codigoNomenclador);
    if (data?.practica.nombre) q.set("busqueda", data.practica.nombre);
    cerrar();
    navigate(`/turnos/nuevo?${q.toString()}`);
  }

  const paciente = item?.paciente;
  // Mixta: hay agenda de turnos Y bolsa de demanda espontánea para la práctica.
  const esMixta =
    data?.modalidad === "mixta" &&
    !!data?.guardia &&
    (data?.tipo === "opciones" || data?.tipo === "sin_disponibilidad");

  return (
    <Dialog open={item !== null} onOpenChange={(open) => { if (!open) cerrar(); }}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <CalendarPlus className="h-5 w-5 text-blue-600" />
            Asignar turno
          </DialogTitle>
          <DialogDescription>
            {item?.practica?.nombre ?? "Práctica"} —{" "}
            {paciente ? `${paciente.apellido}, ${paciente.nombre}` : `Paciente #${item?.orden.patientId}`}
            {paciente?.dni ? ` (DNI ${paciente.dni})` : ""}
          </DialogDescription>
        </DialogHeader>

        {isLoading ? (
          <div className="py-10 text-center text-muted-foreground">
            <Loader2 className="h-6 w-6 animate-spin mx-auto mb-2" />
            Buscando horarios disponibles…
          </div>
        ) : error ? (
          <div className="py-6 text-center text-sm text-destructive">
            {(error as Error).message}
          </div>
        ) : data?.tipo === "demanda_espontanea" ? (
          <div className="rounded-lg border border-amber-300 bg-amber-50 dark:bg-amber-950/40 dark:border-amber-700 p-4 space-y-2">
            <div className="flex items-center gap-2 font-semibold text-amber-900 dark:text-amber-200">
              <Siren className="h-5 w-5" />
              Se atiende solo por demanda espontánea
            </div>
            <p className="text-sm text-amber-800 dark:text-amber-300">
              Esta práctica no da turnos: el paciente se atiende por orden de
              llegada en {data.guardia?.nombre ?? "la guardia"}
              {data.guardia?.sede ? ` (${data.guardia.sede})` : ""}. Informale al paciente y,
              si está de acuerdo, sumalo ahora al circuito de guardia.
            </p>
            <Button
              className="w-full mt-1"
              disabled={asignarMutation.isPending}
              onClick={() => data.guardia && asignarMutation.mutate({ turneraId: data.guardia.turneraId })}
              data-testid="button-sumar-guardia"
            >
              {asignarMutation.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin mr-2" />
              ) : (
                <Siren className="h-4 w-4 mr-2" />
              )}
              Sumar a la guardia ahora
            </Button>
          </div>
        ) : esMixta && modalidadElegida === null ? (
          <div className="rounded-lg border border-blue-300 bg-blue-50 dark:bg-blue-950/40 dark:border-blue-700 p-4 space-y-3" data-testid="card-modalidad-mixta">
            <div className="font-semibold text-blue-900 dark:text-blue-200">
              Esta práctica se atiende de dos maneras
            </div>
            <p className="text-sm text-blue-800 dark:text-blue-300">
              Con <strong>turno programado</strong> o por <strong>orden de llegada</strong> (demanda
              espontánea{data?.guardia?.sede ? ` en ${data.guardia.sede}` : ""}). Informale las dos
              opciones al paciente y elegí según lo que prefiera:
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              <Button
                variant="outline"
                className="w-full"
                onClick={() => setModalidadElegida("turno")}
                data-testid="button-modalidad-turno"
              >
                <CalendarPlus className="h-4 w-4 mr-2" />
                Quiere turno
              </Button>
              <Button
                variant="outline"
                className="w-full"
                onClick={() => setModalidadElegida("demanda")}
                data-testid="button-modalidad-demanda"
              >
                <Siren className="h-4 w-4 mr-2" />
                Orden de llegada
              </Button>
            </div>
          </div>
        ) : esMixta && modalidadElegida === "demanda" ? (
          <div className="rounded-lg border border-amber-300 bg-amber-50 dark:bg-amber-950/40 dark:border-amber-700 p-4 space-y-2">
            <div className="flex items-center gap-2 font-semibold text-amber-900 dark:text-amber-200">
              <Siren className="h-5 w-5" />
              Atención por orden de llegada
            </div>
            <p className="text-sm text-amber-800 dark:text-amber-300">
              El paciente se atiende por orden de llegada en {data?.guardia?.nombre ?? "la guardia"}
              {data?.guardia?.sede ? ` (${data.guardia.sede})` : ""}.
            </p>
            <Button
              className="w-full mt-1"
              disabled={asignarMutation.isPending}
              onClick={() => data?.guardia && asignarMutation.mutate({ turneraId: data.guardia.turneraId })}
              data-testid="button-sumar-guardia"
            >
              {asignarMutation.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin mr-2" />
              ) : (
                <Siren className="h-4 w-4 mr-2" />
              )}
              Sumar a la guardia ahora
            </Button>
            <Button
              variant="ghost"
              className="w-full"
              onClick={() => setModalidadElegida(null)}
              data-testid="button-volver-modalidad"
            >
              Volver a elegir modalidad
            </Button>
          </div>
        ) : data?.tipo === "sin_agenda" ? (
          <div className="py-6 text-center text-sm text-muted-foreground space-y-2">
            <CalendarX2 className="h-8 w-8 mx-auto text-muted-foreground/60" />
            <p>Ninguna agenda activa tiene cargada esta práctica.</p>
            <p>Revisá las prácticas de las agendas o usá el flujo manual.</p>
          </div>
        ) : data?.tipo === "sin_disponibilidad" ? (
          <div className="py-6 text-center text-sm text-muted-foreground space-y-2">
            <CalendarX2 className="h-8 w-8 mx-auto text-muted-foreground/60" />
            <p>Hay agendas compatibles pero sin horarios libres en los próximos 30 días.</p>
            <p>Probá el flujo manual para ver más opciones o sobreturnos.</p>
            {esMixta && (
              <Button
                variant="outline"
                className="w-full"
                onClick={() => setModalidadElegida("demanda")}
                data-testid="button-cambiar-a-demanda"
              >
                <Siren className="h-4 w-4 mr-2" />
                Ofrecerle orden de llegada (demanda espontánea)
              </Button>
            )}
          </div>
        ) : (
          <div className="space-y-2">
            <p className="text-xs text-muted-foreground">
              Elegí una de las próximas opciones disponibles:
            </p>
            {esMixta && (
              <button
                type="button"
                className="text-xs text-blue-700 dark:text-blue-300 underline underline-offset-2"
                onClick={() => setModalidadElegida(null)}
                data-testid="button-volver-modalidad"
              >
                ← El paciente prefiere orden de llegada (volver a elegir)
              </button>
            )}
            {(data?.opciones ?? []).map((op) => {
              const cargando =
                asignarMutation.isPending &&
                opcionElegida?.turneraId === op.turneraId &&
                opcionElegida?.fecha === op.fecha &&
                opcionElegida?.horaInicio === op.horaInicio;
              return (
                <button
                  key={`${op.turneraId}-${op.fecha}-${op.horaInicio}`}
                  type="button"
                  disabled={asignarMutation.isPending}
                  onClick={() => confirmarOpcion(op)}
                  className="w-full text-left rounded-lg border p-3 hover:border-blue-500 hover:bg-blue-50 dark:hover:bg-blue-950/40 transition-colors disabled:opacity-60"
                  data-testid={`option-turno-${op.fecha}-${op.horaInicio}`}
                >
                  <div className="flex items-center justify-between">
                    <div className="font-medium text-sm capitalize">{fechaLarga(op.fecha)}</div>
                    <div className="flex items-center gap-1 font-semibold text-blue-700 dark:text-blue-300 text-sm">
                      {cargando ? <Loader2 className="h-4 w-4 animate-spin" /> : <Clock className="h-4 w-4" />}
                      {op.horaInicio} hs
                    </div>
                  </div>
                  <div className="mt-1 flex flex-wrap gap-x-4 gap-y-0.5 text-xs text-muted-foreground">
                    {op.profesional && (
                      <span className="inline-flex items-center gap-1">
                        <UserCircle className="h-3.5 w-3.5" /> {op.profesional}
                      </span>
                    )}
                    {op.sede && (
                      <span className="inline-flex items-center gap-1">
                        <MapPin className="h-3.5 w-3.5" /> {op.sede}
                      </span>
                    )}
                    <span>{op.turneraNombre}</span>
                  </div>
                </button>
              );
            })}
          </div>
        )}

        <DialogFooter className="flex-col sm:flex-row gap-2">
          <Button variant="outline" onClick={cerrar}>
            Cerrar
          </Button>
          {!isLoading && (
            <Button variant="secondary" onClick={irAFlujoManual} data-testid="button-flujo-manual">
              Buscar otro horario (flujo manual)
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
