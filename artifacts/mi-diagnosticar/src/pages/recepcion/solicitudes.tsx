import { useMemo, useState } from "react";
import { Link } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import {
  useListSolicitudes,
  getListSolicitudesQueryKey,
  useListServicios,
  type Solicitud,
} from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { SolicitudEstadoControl, SolicitudEstadoBadge, ESTADOS_SOLICITUD } from "@/pages/pacientes/solicitud-estado";
import { Inbox, ShieldAlert, Clock, CheckCircle2, CalendarClock } from "lucide-react";
import { format, parseISO } from "date-fns";
import { es } from "date-fns/locale";

const ESTADOS_ACTIVOS = ["indicada", "pre_reservada", "pendiente_validacion", "validada", "programada", "en_sala"];

function fmtFecha(fecha?: string | null) {
  if (!fecha) return "";
  try {
    return format(parseISO(fecha), "d MMM", { locale: es });
  } catch {
    return fecha;
  }
}

function KpiCard({ icono: Icono, label, valor, className }: {
  icono: typeof Inbox;
  label: string;
  valor: number;
  className?: string;
}) {
  return (
    <Card>
      <CardContent className="p-4 flex items-center gap-3">
        <div className={`w-9 h-9 rounded-lg flex items-center justify-center ${className ?? "bg-primary/10 text-primary"}`}>
          <Icono className="w-4.5 h-4.5" />
        </div>
        <div>
          <p className="text-2xl font-semibold leading-none">{valor}</p>
          <p className="text-xs text-muted-foreground mt-1">{label}</p>
        </div>
      </CardContent>
    </Card>
  );
}

export default function BandejaSolicitudes() {
  const queryClient = useQueryClient();
  const [estadoFiltro, setEstadoFiltro] = useState("activas");
  const [servicioFiltro, setServicioFiltro] = useState("todos");

  const params = estadoFiltro !== "activas" && estadoFiltro !== "todas" ? { estado: estadoFiltro } : undefined;
  const { data, isLoading } = useListSolicitudes(params, {
    query: { refetchInterval: 15_000 },
  });
  const { data: servicios } = useListServicios();

  const invalidar = () => queryClient.invalidateQueries({ queryKey: getListSolicitudesQueryKey(undefined) });

  const solicitudes = useMemo(() => {
    let items: Solicitud[] = data ?? [];
    if (estadoFiltro === "activas") items = items.filter((s) => ESTADOS_ACTIVOS.includes(s.estado));
    if (servicioFiltro !== "todos") items = items.filter((s) => String(s.servicioId) === servicioFiltro);
    const orden: Record<string, number> = { urgente: 0, alta: 1, normal: 2 };
    return [...items].sort((a, b) =>
      (orden[a.prioridad] ?? 2) - (orden[b.prioridad] ?? 2) ||
      new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
    );
  }, [data, estadoFiltro, servicioFiltro]);

  const todas: Solicitud[] = data ?? [];
  const kpis = useMemo(() => ({
    pendientes: todas.filter((s) => s.estado === "pendiente_validacion").length,
    preReservadas: todas.filter((s) => s.estado === "pre_reservada").length,
    programadas: todas.filter((s) => s.estado === "programada").length,
    validadas: todas.filter((s) => s.estado === "validada").length,
  }), [todas]);

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold flex items-center gap-2">
          <Inbox className="w-5 h-5" /> Bandeja de solicitudes
        </h1>
        <p className="text-sm text-muted-foreground">
          Derivaciones y estudios indicados desde el consultorio, priorizados por urgencia.
        </p>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <KpiCard icono={ShieldAlert} label="Pendientes de validación" valor={kpis.pendientes} className="bg-amber-100 text-amber-700" />
        <KpiCard icono={Clock} label="Pre-reservadas" valor={kpis.preReservadas} className="bg-sky-100 text-sky-700" />
        <KpiCard icono={CheckCircle2} label="Validadas" valor={kpis.validadas} className="bg-lime-100 text-lime-700" />
        <KpiCard icono={CalendarClock} label="Programadas" valor={kpis.programadas} className="bg-blue-100 text-blue-700" />
      </div>

      <Card>
        <CardHeader className="pb-3 flex-row items-center justify-between space-y-0 gap-2 flex-wrap">
          <CardTitle className="text-base">Solicitudes</CardTitle>
          <div className="flex gap-2">
            <Select value={servicioFiltro} onValueChange={setServicioFiltro}>
              <SelectTrigger className="h-8 w-44 text-xs"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="todos">Todos los servicios</SelectItem>
                {(servicios ?? []).map((s) => (
                  <SelectItem key={s.id} value={String(s.id)}>{s.nombre}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={estadoFiltro} onValueChange={setEstadoFiltro}>
              <SelectTrigger className="h-8 w-48 text-xs"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="activas">Activas</SelectItem>
                <SelectItem value="todas">Todas</SelectItem>
                {Object.entries(ESTADOS_SOLICITUD).map(([k, v]) => (
                  <SelectItem key={k} value={k}>{v.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="p-4 space-y-2">{[1, 2, 3].map((i) => <Skeleton key={i} className="h-12 w-full" />)}</div>
          ) : solicitudes.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-10">No hay solicitudes para mostrar.</p>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Paciente</TableHead>
                    <TableHead>Servicio</TableHead>
                    <TableHead>Indicado por</TableHead>
                    <TableHead>Turno</TableHead>
                    <TableHead>Cobertura</TableHead>
                    <TableHead>Prioridad</TableHead>
                    <TableHead className="text-right">Estado</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {solicitudes.map((s) => (
                    <TableRow key={s.id}>
                      <TableCell>
                        <Link href={`/pacientes/${s.patientId}/hce`} className="font-medium hover:underline">
                          {s.pacienteNombre ?? `Paciente #${s.patientId}`}
                        </Link>
                        {s.pacienteDni && <p className="text-xs text-muted-foreground">DNI {s.pacienteDni}</p>}
                      </TableCell>
                      <TableCell>
                        <p className="text-sm">{s.servicioNombre ?? `#${s.servicioId}`}</p>
                        {s.requiereAutorizacion && (
                          <p className="text-[11px] text-amber-700 flex items-center gap-0.5">
                            <ShieldAlert className="w-3 h-3" /> Requiere autorización
                            {s.tokenValidado ? " · token OK" : ""}
                          </p>
                        )}
                        {s.detalle && <p className="text-xs text-muted-foreground truncate max-w-48">{s.detalle}</p>}
                      </TableCell>
                      <TableCell className="text-sm">{s.profesionalNombre ?? "—"}</TableCell>
                      <TableCell className="text-sm">
                        {s.turnoFecha ? (
                          <>
                            {fmtFecha(s.turnoFecha)} {s.turnoHoraInicio}
                            {s.turnoSedeNombre && <p className="text-xs text-muted-foreground">{s.turnoSedeNombre}</p>}
                          </>
                        ) : (
                          <span className="text-muted-foreground">Sin turno</span>
                        )}
                      </TableCell>
                      <TableCell className="text-sm">
                        {s.cobertura ?? "—"}
                        {s.coberturaValidada && <CheckCircle2 className="w-3.5 h-3.5 inline ml-1 text-green-600" />}
                      </TableCell>
                      <TableCell>
                        {s.prioridad === "normal" ? (
                          <span className="text-xs text-muted-foreground">Normal</span>
                        ) : (
                          <Badge variant="secondary" className={`border-0 text-[10px] ${s.prioridad === "urgente" ? "bg-red-100 text-red-700" : "bg-orange-100 text-orange-700"}`}>
                            {s.prioridad}
                          </Badge>
                        )}
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex justify-end">
                          <SolicitudEstadoControl solicitud={s} onChanged={invalidar} />
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
