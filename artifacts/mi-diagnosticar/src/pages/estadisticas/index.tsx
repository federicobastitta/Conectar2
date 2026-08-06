import { useMemo, useState } from "react";
import {
  useGetEstadisticasResumen,
  type EstadisticaCantidadItem,
} from "@workspace/api-client-react";
import { useAuth } from "@/hooks/use-auth";
import { Link } from "wouter";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { BarChart3, TrendingUp, Activity, Gauge } from "lucide-react";
import {
  ResponsiveContainer,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  LineChart,
  Line,
  Legend,
  PieChart,
  Pie,
  Cell,
} from "recharts";
import { format, subDays } from "date-fns";

const COLORES = ["#0ea5e9", "#8b5cf6", "#f59e0b", "#10b981", "#ef4444", "#6366f1", "#14b8a6", "#f97316", "#ec4899", "#84cc16"];

const RANGOS: Record<string, { label: string; dias: number }> = {
  "30": { label: "Últimos 30 días", dias: 30 },
  "90": { label: "Últimos 90 días", dias: 90 },
  "180": { label: "Últimos 6 meses", dias: 180 },
  "365": { label: "Último año", dias: 365 },
};

function GraficoBarras({ titulo, data, color }: { titulo: string; data: EstadisticaCantidadItem[]; color?: string }) {
  return (
    <Card>
      <CardHeader className="pb-2"><CardTitle className="text-sm">{titulo}</CardTitle></CardHeader>
      <CardContent className="h-56">
        {data.length === 0 ? (
          <p className="text-sm text-muted-foreground text-center pt-16">Sin datos en el período.</p>
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={data.slice(0, 10)} layout="vertical" margin={{ left: 8, right: 16 }}>
              <CartesianGrid strokeDasharray="3 3" horizontal={false} />
              <XAxis type="number" allowDecimals={false} tick={{ fontSize: 11 }} />
              <YAxis type="category" dataKey="clave" width={130} tick={{ fontSize: 11 }} />
              <Tooltip />
              <Bar dataKey="cantidad" name="Cantidad" fill={color ?? "#0ea5e9"} radius={[0, 4, 4, 0]} />
            </BarChart>
          </ResponsiveContainer>
        )}
      </CardContent>
    </Card>
  );
}

export default function Estadisticas() {
  const { user } = useAuth();
  const [rango, setRango] = useState("90");

  const params = useMemo(() => {
    const hasta = new Date();
    const desde = subDays(hasta, RANGOS[rango]?.dias ?? 90);
    return {
      desde: format(desde, "yyyy-MM-dd"),
      hasta: format(hasta, "yyyy-MM-dd"),
    };
  }, [rango]);

  const esAdmin = (user as { rol?: string } | undefined)?.rol === "admin";
  const { data, isLoading, isError } = useGetEstadisticasResumen(params, {
    query: { enabled: esAdmin },
  });

  if (!esAdmin) {
    return (
      <div className="py-16 text-center text-muted-foreground">
        <BarChart3 className="w-10 h-10 mx-auto mb-3 opacity-40" />
        <p className="font-medium">Acceso restringido</p>
        <p className="text-sm">El tablero gerencial está disponible solo para administradores.</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-2 flex-wrap">
        <div>
          <h1 className="text-xl font-semibold flex items-center gap-2">
            <BarChart3 className="w-5 h-5" /> Estadísticas
          </h1>
          <p className="text-sm text-muted-foreground">
            Tablero gerencial de producción, derivaciones y capacidad instalada (sin datos de facturación).
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Link href="/estadisticas/reportes">
            <Button variant="outline" size="sm" className="h-8 text-xs" data-testid="link-reportes">
              Reportes entre fechas
            </Button>
          </Link>
          <Select value={rango} onValueChange={setRango}>
            <SelectTrigger className="h-8 w-44 text-xs"><SelectValue /></SelectTrigger>
            <SelectContent>
              {Object.entries(RANGOS).map(([k, v]) => (
                <SelectItem key={k} value={k}>{v.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {isLoading ? (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
          {[1, 2, 3, 4].map((i) => <Skeleton key={i} className="h-56 w-full" />)}
        </div>
      ) : isError || !data ? (
        <p className="text-sm text-muted-foreground text-center py-10">No se pudieron cargar las estadísticas.</p>
      ) : (
        <>
          {/* Evolución mensual */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm flex items-center gap-2">
                <TrendingUp className="w-4 h-4" /> Evolución mensual — consultas y solicitudes de estudios
              </CardTitle>
            </CardHeader>
            <CardContent className="h-64">
              {data.evolucionMensual.length === 0 ? (
                <p className="text-sm text-muted-foreground text-center pt-20">Sin datos en el período.</p>
              ) : (
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={data.evolucionMensual} margin={{ left: 0, right: 16 }}>
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis dataKey="mes" tick={{ fontSize: 11 }} />
                    <YAxis allowDecimals={false} tick={{ fontSize: 11 }} />
                    <Tooltip />
                    <Legend />
                    <Line type="monotone" dataKey="consultas" name="Consultas" stroke="#0ea5e9" strokeWidth={2} dot={false} />
                    <Line type="monotone" dataKey="solicitudes" name="Solicitudes" stroke="#8b5cf6" strokeWidth={2} dot={false} />
                  </LineChart>
                </ResponsiveContainer>
              )}
            </CardContent>
          </Card>

          {/* Producción */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
            <GraficoBarras titulo="Consultas por médico" data={data.consultasPorMedico} />
            <GraficoBarras titulo="Consultas por especialidad" data={data.consultasPorEspecialidad} color="#8b5cf6" />
            <GraficoBarras titulo="Estudios solicitados por servicio" data={data.estudiosPorServicio} color="#10b981" />
            <GraficoBarras titulo="Estudios por médico solicitante" data={data.estudiosPorMedico} color="#f59e0b" />
          </div>

          {/* Cobertura + estados */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
            <Card>
              <CardHeader className="pb-2"><CardTitle className="text-sm">Estudios por cobertura</CardTitle></CardHeader>
              <CardContent className="h-56">
                {data.estudiosPorCobertura.length === 0 ? (
                  <p className="text-sm text-muted-foreground text-center pt-16">Sin datos en el período.</p>
                ) : (
                  <ResponsiveContainer width="100%" height="100%">
                    <PieChart>
                      <Pie data={data.estudiosPorCobertura} dataKey="cantidad" nameKey="clave" cx="50%" cy="50%" outerRadius={75} label={(e) => e.clave}>
                        {data.estudiosPorCobertura.map((_, i) => (
                          <Cell key={i} fill={COLORES[i % COLORES.length]} />
                        ))}
                      </Pie>
                      <Tooltip />
                    </PieChart>
                  </ResponsiveContainer>
                )}
              </CardContent>
            </Card>
            <GraficoBarras titulo="Estados operativos de solicitudes" data={data.estadosOperativos} color="#6366f1" />
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            <GraficoBarras titulo="Estudios externos (Phir-it) por estado" data={data.estudiosExternosPorEstado} color="#0ea5e9" />
          </div>

          {/* Conversión por servicio */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm flex items-center gap-2">
                <Activity className="w-4 h-4" /> Conversión consulta → estudio por servicio
              </CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              {data.conversionPorServicio.length === 0 ? (
                <p className="text-sm text-muted-foreground text-center py-8">Sin datos en el período.</p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Servicio</TableHead>
                      <TableHead className="text-right">Solicitudes</TableHead>
                      <TableHead className="text-right">Consultas</TableHead>
                      <TableHead className="text-right">Conversión</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data.conversionPorServicio.map((c) => (
                      <TableRow key={c.servicioNombre}>
                        <TableCell className="font-medium">{c.servicioNombre}</TableCell>
                        <TableCell className="text-right">{c.solicitudes}</TableCell>
                        <TableCell className="text-right">{c.consultas}</TableCell>
                        <TableCell className="text-right">
                          <Badge variant="secondary" className="border-0">{c.conversionPct}%</Badge>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>

          {/* Indicadores por médico */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">Indicadores por médico</CardTitle>
            </CardHeader>
            <CardContent className="p-0 overflow-x-auto">
              {data.indicadoresPorMedico.length === 0 ? (
                <p className="text-sm text-muted-foreground text-center py-8">Sin datos en el período.</p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Médico</TableHead>
                      <TableHead>Especialidad</TableHead>
                      <TableHead className="text-right">Consultas</TableHead>
                      <TableHead className="text-right">Estudios sol.</TableHead>
                      <TableHead className="text-right">Derivaciones</TableHead>
                      <TableHead className="text-right">Est./consulta</TableHead>
                      <TableHead className="text-right">Conversión</TableHead>
                      <TableHead className="text-right">Resol. interna</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data.indicadoresPorMedico.map((m) => (
                      <TableRow key={m.profesionalId}>
                        <TableCell className="font-medium">{m.profesionalNombre}</TableCell>
                        <TableCell className="text-muted-foreground">{m.especialidadNombre ?? "—"}</TableCell>
                        <TableCell className="text-right">{m.consultas}</TableCell>
                        <TableCell className="text-right">{m.estudiosSolicitados}</TableCell>
                        <TableCell className="text-right">{m.derivaciones}</TableCell>
                        <TableCell className="text-right">{m.promedioEstudiosPorConsulta}</TableCell>
                        <TableCell className="text-right">{m.conversionPct}%</TableCell>
                        <TableCell className="text-right">{m.resolucionInternaPct}%</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>

          {/* Capacidad instalada */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm flex items-center gap-2">
                <Gauge className="w-4 h-4" /> Capacidad instalada — semana actual
              </CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              {data.capacidadInstalada.length === 0 ? (
                <p className="text-sm text-muted-foreground text-center py-8">Sin agendas activas.</p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Agenda</TableHead>
                      <TableHead>Sede</TableHead>
                      <TableHead className="text-right">Capacidad semanal</TableHead>
                      <TableHead className="text-right">Ocupados</TableHead>
                      <TableHead className="text-right w-40">Utilización</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data.capacidadInstalada.map((c) => (
                      <TableRow key={c.turneraId}>
                        <TableCell className="font-medium">{c.turneraNombre}</TableCell>
                        <TableCell className="text-muted-foreground">{c.sedeNombre ?? "—"}</TableCell>
                        <TableCell className="text-right">{c.capacidadSemanal}</TableCell>
                        <TableCell className="text-right">{c.ocupadosSemana}</TableCell>
                        <TableCell className="text-right">
                          <div className="flex items-center gap-2 justify-end">
                            <div className="w-20 h-2 rounded-full bg-muted overflow-hidden">
                              <div
                                className={`h-full rounded-full ${c.utilizacionPct >= 85 ? "bg-red-500" : c.utilizacionPct >= 60 ? "bg-amber-500" : "bg-green-500"}`}
                                style={{ width: `${Math.min(100, c.utilizacionPct)}%` }}
                              />
                            </div>
                            <span className="text-xs w-10 text-right">{c.utilizacionPct}%</span>
                          </div>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>

          {/* Rankings */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
            <GraficoBarras titulo="Ranking de estudios" data={data.rankingEstudios} color="#14b8a6" />
            <GraficoBarras titulo="Ranking de médicos" data={data.rankingMedicos} color="#f97316" />
            <GraficoBarras titulo="Ranking de especialidades" data={data.rankingEspecialidades} color="#ec4899" />
          </div>
        </>
      )}
    </div>
  );
}
