import { useState, useMemo, useCallback } from "react";
import { format } from "date-fns";
import { es } from "date-fns/locale";
import {
  useGetTablero,
  useListSedes,
  useListEspecialidades,
  useGetRecepcionTurnosDia,
  useGetRobotKlinicosEstado,
  useListProfesionales,
  getGetRecepcionTurnosDiaQueryKey,
} from "@workspace/api-client-react";
import { Combobox } from "@/components/ui/combobox";
import { CargaRapidaTurno } from "@/components/recepcion/carga-rapida-turno";
import { FichaRecepcionDialog } from "@/components/recepcion/ficha-recepcion-dialog";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { StatusBadge } from "@/components/ui/status-badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import {
  CalendarIcon, LogIn, UserX, X, Stethoscope, CheckCircle,
  FileText, RefreshCcw, Users, Clock, ClipboardList, Activity,
} from "lucide-react";
import { getEstadoMeta, ACCIONES_POR_ESTADO, needsInforme } from "@/lib/episodio";
import { marcaColorFondo, marcaColorLabel } from "@/lib/marca-color";
import { Link } from "wouter";
import { useToast } from "@/hooks/use-toast";
import { useQueryClient } from "@tanstack/react-query";
import { getGetTableroQueryKey } from "@workspace/api-client-react";

const ICON_MAP: Record<string, React.ElementType> = {
  LogIn, UserX, X, Stethoscope, CheckCircle, FileText,
};

type TurnoRow = {
  id: number;
  horaInicio: string;
  horaFin: string;
  estado: string;
  profesionalId?: number | null;
  llamadoPorProfesionalId?: number | null;
  marcaColor?: string | null;
  motivoConsulta?: string | null;
  observaciones?: string | null;
  paciente?: { id: number; nombre: string; apellido: string; dni?: string | null } | null;
  profesional?: { nombre: string; apellido: string } | null;
  turnera?: {
    nombre: string;
    especialidad?: { nombre: string; color?: string | null } | null;
    sede?: { nombre: string } | null;
  } | null;
};

type TableroEntry = {
  turnera: {
    id: number;
    nombre: string;
    profesional?: { nombre: string; apellido: string } | null;
    especialidad?: { nombre: string; color?: string | null } | null;
    sede?: { nombre: string } | null;
  };
  turnos: TurnoRow[];
  primerDisponible: string | null;
  ocupacion: number;
};

export default function TableroOperativo() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [fecha, setFecha] = useState<string>(format(new Date(), "yyyy-MM-dd"));
  const [sedeId, setSedeId] = useState<string>("all");
  const [especialidadFilter, setEspecialidadFilter] = useState<string>("all");
  const [observacionDialog, setObservacionDialog] = useState<{
    turnoId: number; paciente: string; obs: string;
  } | null>(null);
  const [obsText, setObsText] = useState("");
  const [loadingEstado, setLoadingEstado] = useState<number | null>(null);
  // Turno sin médico asignado que recepción marca como atendido: hay que
  // elegir quién lo atendió para que la atención quede a nombre de alguien.
  const [atendidoDialog, setAtendidoDialog] = useState<{
    turnoId: number; paciente: string; nuevoEstado: string;
  } | null>(null);
  const [atendidoProfId, setAtendidoProfId] = useState<string>("");

  const queryParams = {
    fecha,
    sedeId: sedeId !== "all" ? Number(sedeId) : undefined,
  };
  const { data: tablero, isLoading, refetch } = useGetTablero(queryParams);
  const { data: sedes } = useListSedes();
  const { data: especialidades } = useListEspecialidades();

  // Carga rápida por turno (token / orden médica / informe)
  const { data: turnosDia } = useGetRecepcionTurnosDia({ fecha }, {
    query: { refetchInterval: 30000 },
  });
  const infoPorTurno = useMemo(
    () => new Map((turnosDia ?? []).map((t) => [t.turnoId, t])),
    [turnosDia],
  );
  const { data: robot } = useGetRobotKlinicosEstado(undefined, { query: { refetchInterval: 60000 } });
  const { data: profesionalesActivos } = useListProfesionales({ activo: true }, { query: { enabled: !!atendidoDialog } });
  const opcionesProfesional = useMemo(
    () =>
      [...(profesionalesActivos ?? [])]
        .sort((a, b) => `${a.apellido ?? ""} ${a.nombre}`.localeCompare(`${b.apellido ?? ""} ${b.nombre}`, "es"))
        .map((p) => ({ value: String(p.id), label: p.apellido ? `${p.apellido}, ${p.nombre}` : p.nombre })),
    [profesionalesActivos],
  );
  const [fichaTurnoId, setFichaTurnoId] = useState<number | null>(null);

  const allEntries = (tablero ?? []) as TableroEntry[];

  const filtered = useMemo(() => {
    if (especialidadFilter === "all") return allEntries;
    return allEntries.filter(
      (e) => e.turnera.especialidad?.nombre === especialidadFilter
    );
  }, [allEntries, especialidadFilter]);

  const flatTurnos: TurnoRow[] = useMemo(() =>
    filtered.flatMap((e) =>
      e.turnos.map((t) => ({
        ...t,
        turnera: e.turnera,
        profesional: e.turnera.profesional ?? null,
      }))
    ).sort((a, b) => a.horaInicio.localeCompare(b.horaInicio)),
    [filtered]
  );

  // KPIs
  const kpis = useMemo(() => {
    const reservados = flatTurnos.filter((t) =>
      ["pendiente", "reservado"].includes(t.estado)
    ).length;
    const arriados = flatTurnos.filter((t) => t.estado === "arribo").length;
    const enAtencion = flatTurnos.filter((t) => t.estado === "en_atencion").length;
    const pendInforme = flatTurnos.filter((t) =>
      ["pendiente_informe", "informando"].includes(t.estado)
    ).length;
    const informados = flatTurnos.filter((t) =>
      ["informado", "publicado", "visto_usuario"].includes(t.estado)
    ).length;
    const vistos = flatTurnos.filter((t) => t.estado === "visto").length;
    return { reservados, arriados, enAtencion, pendInforme, informados, vistos, total: flatTurnos.length };
  }, [flatTurnos]);

  const cambiarEstado = useCallback(async (turnoId: number, nuevoEstado: string, atendidoPorProfesionalId?: number): Promise<boolean> => {
    setLoadingEstado(turnoId);
    try {
      const r = await fetch(`/api/turnos/${turnoId}/estado`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${localStorage.getItem("auth_token") ?? ""}`,
        },
        credentials: "include",
        body: JSON.stringify({ estado: nuevoEstado, ...(atendidoPorProfesionalId ? { atendidoPorProfesionalId } : {}) }),
      });
      if (!r.ok) {
        const err = await r.json() as { error?: string };
        toast({ title: "Error", description: err.error ?? "No se pudo cambiar el estado", variant: "destructive" });
        return false;
      }
      await refetch();
      void queryClient.invalidateQueries({ queryKey: getGetTableroQueryKey(queryParams) });
      return true;
    } catch {
      toast({ title: "Error de red", description: "No se pudo conectar con el servidor", variant: "destructive" });
      return false;
    } finally {
      setLoadingEstado(null);
    }
  }, [refetch, queryClient, queryParams, toast]);

  const guardarObservacion = useCallback(async () => {
    if (!observacionDialog) return;
    setLoadingEstado(observacionDialog.turnoId);
    try {
      await fetch(`/api/turnos/${observacionDialog.turnoId}/estado`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${localStorage.getItem("auth_token") ?? ""}`,
        },
        credentials: "include",
        body: JSON.stringify({ estado: observacionDialog.obs || undefined, observaciones: obsText }),
      });
    } catch { /* ignore */ }
    // Update via PATCH (plain update for observaciones)
    await fetch(`/api/turnos/${observacionDialog.turnoId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ observaciones: obsText }),
    });
    setObservacionDialog(null);
    setObsText("");
    await refetch();
    setLoadingEstado(null);
  }, [observacionDialog, obsText, refetch]);

  const fechaLabel = format(new Date(fecha + "T00:00:00"), "EEEE d 'de' MMMM", { locale: es });

  return (
    <div className="h-[calc(100vh-2rem)] flex flex-col gap-3">
      {/* Header */}
      <div className="flex items-center justify-between shrink-0 flex-wrap gap-2">
        <div>
          <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
            <Activity className="w-6 h-6 text-primary" />
            Tablero de Recepción
          </h1>
          <p className="text-muted-foreground text-sm capitalize">{fechaLabel}</p>
        </div>
        <div className="flex gap-2 flex-wrap">
          <div className="flex items-center gap-2 border rounded-md px-3 bg-background h-9">
            <CalendarIcon className="w-4 h-4 text-muted-foreground" />
            <Input
              type="date"
              value={fecha}
              onChange={(e) => setFecha(e.target.value)}
              className="border-0 focus-visible:ring-0 px-0 w-[130px] h-8"
            />
          </div>
          <Select value={sedeId} onValueChange={setSedeId}>
            <SelectTrigger className="w-[150px] h-9">
              <SelectValue placeholder="Sede" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Todas las sedes</SelectItem>
              {sedes?.map((s) => (
                <SelectItem key={s.id} value={s.id.toString()}>{s.nombre}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={especialidadFilter} onValueChange={setEspecialidadFilter}>
            <SelectTrigger className="w-[160px] h-9">
              <SelectValue placeholder="Especialidad" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Todas</SelectItem>
              {/* Solo las especialidades presentes en el tablero (ya filtrado por sede) */}
              {(especialidades ?? [])
                .filter((e) => allEntries.some((en) => en.turnera.especialidad?.nombre === e.nombre))
                .map((e) => (
                  <SelectItem key={e.id} value={e.nombre}>{e.nombre}</SelectItem>
                ))}
            </SelectContent>
          </Select>
          <Button variant="outline" size="sm" onClick={() => void refetch()} className="h-9">
            <RefreshCcw className="w-4 h-4 mr-1" /> Actualizar
          </Button>
        </div>
      </div>

      {/* KPIs */}
      <div className="flex gap-2 shrink-0 flex-wrap">
        {[
          { label: "Reservados", value: kpis.reservados, icon: <ClipboardList className="w-4 h-4" />, cls: "bg-slate-50 border-slate-200 text-slate-700" },
          { label: "Arriados", value: kpis.arriados, icon: <LogIn className="w-4 h-4" />, cls: "bg-amber-50 border-amber-200 text-amber-700" },
          { label: "En atención", value: kpis.enAtencion, icon: <Stethoscope className="w-4 h-4" />, cls: "bg-blue-50 border-blue-200 text-blue-700" },
          { label: "Pend. informe", value: kpis.pendInforme, icon: <FileText className="w-4 h-4" />, cls: "bg-orange-50 border-orange-200 text-orange-700" },
          { label: "Informados", value: kpis.informados, icon: <CheckCircle className="w-4 h-4" />, cls: "bg-teal-50 border-teal-200 text-teal-700" },
          { label: "Vistos", value: kpis.vistos, icon: <Users className="w-4 h-4" />, cls: "bg-green-50 border-green-200 text-green-700" },
          { label: "Total", value: kpis.total, icon: <Activity className="w-4 h-4" />, cls: "bg-card border-border text-foreground" },
        ].map((k) => (
          <div key={k.label} className={`flex items-center gap-2 border rounded-lg px-3 py-1.5 text-sm ${k.cls}`}>
            {k.icon}
            <span className="font-bold text-base">{k.value}</span>
            <span className="text-xs opacity-80">{k.label}</span>
          </div>
        ))}
      </div>

      {/* Table */}
      <div className="flex-1 overflow-auto rounded-lg border bg-background">
        {isLoading ? (
          <div className="p-6 space-y-3">
            {Array.from({ length: 8 }).map((_, i) => (
              <Skeleton key={i} className="h-14 w-full" />
            ))}
          </div>
        ) : flatTurnos.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-64 gap-3 text-muted-foreground">
            <ClipboardList className="w-12 h-12 opacity-20" />
            <p>No hay episodios para esta fecha y filtros</p>
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-muted/80 backdrop-blur border-b z-10">
              <tr>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground w-16">Hora</th>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">Paciente</th>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">Especialidad / Profesional</th>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">Estado</th>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">Carga rápida</th>
                <th className="text-right px-4 py-3 font-medium text-muted-foreground">Acciones</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {flatTurnos.map((turno) => {
                const meta = getEstadoMeta(turno.estado);
                const acciones = ACCIONES_POR_ESTADO[turno.estado] ?? [];
                const isActive = ["arribo", "en_atencion"].includes(turno.estado);
                const isPendInforme = needsInforme(turno.estado);

                return (
                  <tr
                    key={turno.id}
                    className={`transition-colors ${
                      marcaColorFondo(turno.marcaColor) ??
                      (isActive ? "bg-amber-50/50 hover:bg-amber-50" :
                      isPendInforme ? "bg-orange-50/30 hover:bg-orange-50/60" :
                      ["cancelado", "ausente"].includes(turno.estado) ? "opacity-50 hover:opacity-70" :
                      "hover:bg-muted/30")
                    }`}
                    title={marcaColorLabel(turno.marcaColor) ?? undefined}
                  >
                    {/* Hora */}
                    <td className="px-4 py-3 w-16">
                      <span className="font-mono font-semibold text-sm">
                        {turno.horaInicio.substring(0, 5)}
                      </span>
                    </td>

                    {/* Paciente */}
                    <td className="px-4 py-3">
                      <div className="font-medium leading-tight">
                        {turno.paciente
                          ? `${turno.paciente.apellido}, ${turno.paciente.nombre}`
                          : "—"}
                      </div>
                      <div className="text-xs text-muted-foreground">
                        {turno.paciente?.dni ? `DNI ${turno.paciente.dni}` : "Sin DNI"}
                        {turno.motivoConsulta && (
                          <span className="ml-2 italic">· {turno.motivoConsulta}</span>
                        )}
                      </div>
                    </td>

                    {/* Especialidad / Profesional */}
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-1.5">
                        {turno.turnera?.especialidad?.color && (
                          <span
                            className="w-2 h-2 rounded-full shrink-0"
                            style={{ backgroundColor: turno.turnera.especialidad.color }}
                          />
                        )}
                        <span className="font-medium text-sm">
                          {turno.turnera?.especialidad?.nombre ?? "Sin especialidad"}
                        </span>
                      </div>
                      <div className="text-xs text-muted-foreground">
                        {turno.profesional
                          ? `${turno.profesional.apellido}, ${turno.profesional.nombre}`
                          : turno.turnera?.nombre ?? "—"}
                      </div>
                    </td>

                    {/* Estado */}
                    <td className="px-4 py-3">
                      <StatusBadge estado={turno.estado} />
                      {turno.observaciones && (
                        <div className="text-xs text-muted-foreground mt-1 italic truncate max-w-[160px]" title={turno.observaciones}>
                          {turno.observaciones}
                        </div>
                      )}
                    </td>

                    {/* Carga rápida */}
                    <td className="px-4 py-3 align-top" onClick={(e) => e.stopPropagation()}>
                      {(() => {
                        const info = infoPorTurno.get(turno.id);
                        if (!info || !turno.paciente || ["cancelado", "ausente"].includes(turno.estado)) {
                          return <span className="text-xs text-muted-foreground">—</span>;
                        }
                        return (
                          <CargaRapidaTurno
                            turnoId={turno.id}
                            pacienteId={turno.paciente.id}
                            esConsulta={info.esConsulta ?? true}
                            token={info.token ?? null}
                            tokenEstado={info.tokenStatus ?? null}
                            nroBono={info.nroBono ?? null}
                            ordenCargada={
                              info.ordenMedicaArchivo === true ||
                              info.ordenMedicaEstado === "validada"
                            }
                            informeCargado={info.informeArchivo === true}
                            validacionHabilitada={robot?.validacionHabilitada === true}
                            onAbrirFicha={() => setFichaTurnoId(turno.id)}
                            onChanged={() => {
                              void queryClient.invalidateQueries({
                                queryKey: getGetRecepcionTurnosDiaQueryKey({ fecha }),
                              });
                            }}
                          />
                        );
                      })()}
                    </td>

                    {/* Acciones */}
                    <td className="px-4 py-3">
                      <div className="flex items-center justify-end gap-1.5 flex-wrap">
                        {acciones.map((accion) => {
                          const Icon = ICON_MAP[accion.icon] ?? CheckCircle;
                          return (
                            <Button
                              key={accion.nuevoEstado}
                              size="sm"
                              variant={accion.variant}
                              className="h-7 text-xs px-2"
                              disabled={loadingEstado === turno.id}
                              onClick={() => {
                                // Al cerrar la atención de un turno sin médico
                                // (guardia/grupal sin llamado), pedir quién lo atendió.
                                if (
                                  ["visto", "pendiente_informe"].includes(accion.nuevoEstado) &&
                                  !turno.llamadoPorProfesionalId &&
                                  !turno.profesionalId
                                ) {
                                  setAtendidoProfId("");
                                  setAtendidoDialog({
                                    turnoId: turno.id,
                                    nuevoEstado: accion.nuevoEstado,
                                    paciente: turno.paciente
                                      ? `${turno.paciente.apellido}, ${turno.paciente.nombre}`
                                      : "Paciente",
                                  });
                                  return;
                                }
                                void cambiarEstado(turno.id, accion.nuevoEstado);
                              }}
                            >
                              <Icon className="w-3 h-3 mr-1" />
                              {accion.label}
                            </Button>
                          );
                        })}

                        {/* Observaciones */}
                        {!["cancelado", "ausente"].includes(turno.estado) && (
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-7 text-xs px-2"
                            onClick={() => {
                              setObservacionDialog({
                                turnoId: turno.id,
                                paciente: turno.paciente
                                  ? `${turno.paciente.apellido}, ${turno.paciente.nombre}`
                                  : "Paciente",
                                obs: turno.observaciones ?? "",
                              });
                              setObsText(turno.observaciones ?? "");
                            }}
                          >
                            <ClipboardList className="w-3 h-3 mr-1" />
                            Obs.
                          </Button>
                        )}

                        {/* Ver/Crear informe */}
                        {isPendInforme && turno.paciente && (
                          <Link href={`/worklist/informe/${turno.id}`}>
                            <Button size="sm" variant="outline" className="h-7 text-xs px-2 border-orange-300 text-orange-700 hover:bg-orange-50">
                              <FileText className="w-3 h-3 mr-1" />
                              Informe
                            </Button>
                          </Link>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {fichaTurnoId && (
        <FichaRecepcionDialog
          turnoId={fichaTurnoId}
          abierto={!!fichaTurnoId}
          tabInicial="consulta"
          onClose={() => setFichaTurnoId(null)}
          onCambio={() => {
            void queryClient.invalidateQueries({ queryKey: getGetRecepcionTurnosDiaQueryKey({ fecha }) });
            void refetch();
          }}
        />
      )}

      {/* Observaciones dialog */}
      <Dialog open={!!observacionDialog} onOpenChange={(o) => { if (!o) { setObservacionDialog(null); setObsText(""); } }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Observaciones — {observacionDialog?.paciente}</DialogTitle>
          </DialogHeader>
          <Textarea
            value={obsText}
            onChange={(e) => setObsText(e.target.value)}
            placeholder="Ingresá las observaciones del episodio..."
            rows={4}
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => { setObservacionDialog(null); setObsText(""); }}>Cancelar</Button>
            <Button onClick={() => void guardarObservacion()}>Guardar</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Atribución de atención: turno sin médico marcado como atendido a mano */}
      <Dialog open={!!atendidoDialog} onOpenChange={(o) => { if (!o) { setAtendidoDialog(null); setAtendidoProfId(""); } }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>¿Qué médico atendió a {atendidoDialog?.paciente}?</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            Este turno no tiene médico asignado. Elegí quién lo atendió para que la atención quede registrada a su nombre.
          </p>
          <Combobox
            testId="select-atendido-por"
            value={atendidoProfId}
            onChange={setAtendidoProfId}
            placeholder="Buscar médico…"
            options={opcionesProfesional}
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => { setAtendidoDialog(null); setAtendidoProfId(""); }}>Cancelar</Button>
            <Button
              disabled={!atendidoProfId || loadingEstado === atendidoDialog?.turnoId}
              data-testid="boton-confirmar-atendido"
              onClick={() => {
                if (!atendidoDialog || !atendidoProfId) return;
                void cambiarEstado(atendidoDialog.turnoId, atendidoDialog.nuevoEstado, Number(atendidoProfId)).then((ok) => {
                  // Si falló, el diálogo queda abierto con el médico elegido
                  if (ok) {
                    setAtendidoDialog(null);
                    setAtendidoProfId("");
                  }
                });
              }}
            >
              Confirmar atención
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
