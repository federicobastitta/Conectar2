import { useGetDashboardResumen, useGetTurnosSemana, useGetOcupacionTurneras, useGetPulsoSincronizadosHoy } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { format } from "date-fns";
import { es } from "date-fns/locale";
import {
  Calendar, Clock, CheckCircle2, XCircle, LayoutGrid, Users, FileText,
  Hospital, Bell, MessageSquare, UsersRound, Bot, FileBarChart2,
  Stethoscope, ChevronRight, Activity, RefreshCw, UserPlus, ScanSearch,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Bar, BarChart, ResponsiveContainer, XAxis, YAxis, Tooltip } from "recharts";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Progress } from "@/components/ui/progress";
import { Link, Redirect } from "wouter";
import { useAuth } from "@/hooks/use-auth";
import { PageHeader } from "@/components/layout/page-header";

const MODULOS = [
  {
    titulo: "Turnos del día",
    descripcion: "Lista, tablero y nuevo turno",
    icon: Calendar,
    href: "/turnos",
    color: "bg-blue-500/10 text-blue-600 dark:text-blue-400 border-blue-500/20",
    iconBg: "bg-blue-500/20",
    badge: null,
  },
  {
    titulo: "Tablero Operativo",
    descripcion: "Vista de todas las agendas y demoras",
    icon: LayoutGrid,
    href: "/turnos/tablero",
    color: "bg-indigo-500/10 text-indigo-600 dark:text-indigo-400 border-indigo-500/20",
    iconBg: "bg-indigo-500/20",
    badge: null,
  },
  {
    titulo: "Pacientes",
    descripcion: "Legajo, historia clínica y evoluciones",
    icon: Users,
    href: "/pacientes",
    color: "bg-violet-500/10 text-violet-600 dark:text-violet-400 border-violet-500/20",
    iconBg: "bg-violet-500/20",
    badge: null,
  },
  {
    titulo: "Sala de Espera",
    descripcion: "Cola en tiempo real y llamador",
    icon: Clock,
    href: "/sala-espera",
    color: "bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/20",
    iconBg: "bg-amber-500/20",
    badge: "Nuevo",
  },
  {
    titulo: "Mensajería",
    descripcion: "Conversaciones paciente–clínica–médico",
    icon: MessageSquare,
    href: "/mensajeria",
    color: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/20",
    iconBg: "bg-emerald-500/20",
    badge: "Nuevo",
  },
  {
    titulo: "Informes Médicos",
    descripcion: "Ver, descargar y compartir resultados",
    icon: FileText,
    href: "/informes",
    color: "bg-cyan-500/10 text-cyan-600 dark:text-cyan-400 border-cyan-500/20",
    iconBg: "bg-cyan-500/20",
    badge: "Nuevo",
  },
  {
    titulo: "Envío de Informes",
    descripcion: "Notificaciones y seguimiento de entregas",
    icon: Bell,
    href: "/notificaciones",
    color: "bg-orange-500/10 text-orange-600 dark:text-orange-400 border-orange-500/20",
    iconBg: "bg-orange-500/20",
    badge: "Nuevo",
  },
  {
    titulo: "Salas Grupales",
    descripcion: "Psicología, nutrición, preparación y talleres",
    icon: UsersRound,
    href: "/salas-grupales",
    color: "bg-pink-500/10 text-pink-600 dark:text-pink-400 border-pink-500/20",
    iconBg: "bg-pink-500/20",
    badge: "Nuevo",
  },
  {
    titulo: "Asistente IA",
    descripcion: "Turnos por texto o voz para todos los pacientes",
    icon: Bot,
    href: "/asistente",
    color: "bg-purple-500/10 text-purple-600 dark:text-purple-400 border-purple-500/20",
    iconBg: "bg-purple-500/20",
    badge: "Nuevo",
  },
  {
    titulo: "Estudios (PACS)",
    descripcion: "Listado de estudios de imágenes y su estado",
    icon: ScanSearch,
    href: "/estudios",
    color: "bg-sky-500/10 text-sky-600 dark:text-sky-400 border-sky-500/20",
    iconBg: "bg-sky-500/20",
    badge: "Nuevo",
  },
  {
    titulo: "Agendas / Turneras",
    descripcion: "Crear y gestionar agendas de profesionales",
    icon: Hospital,
    href: "/turneras",
    color: "bg-teal-500/10 text-teal-600 dark:text-teal-400 border-teal-500/20",
    iconBg: "bg-teal-500/20",
    badge: null,
  },
  {
    titulo: "Profesionales",
    descripcion: "Médicos, especialidades y configuración",
    icon: Stethoscope,
    href: "/profesionales",
    color: "bg-muted text-muted-foreground border-border",
    iconBg: "bg-muted/50",
    badge: null,
  },
];

export default function Dashboard() {
  const { user, isLoading: isLoadingAuth } = useAuth();
  const today = format(new Date(), "yyyy-MM-dd");

  const { data: resumen, isLoading: isLoadingResumen } = useGetDashboardResumen({ fecha: today });
  const { data: turnosSemana, isLoading: isLoadingSemana } = useGetTurnosSemana({});
  const { data: ocupacion, isLoading: isLoadingOcupacion } = useGetOcupacionTurneras({ fecha: today });
  const { data: pulso, isLoading: isLoadingPulso, isError: isErrorPulso } = useGetPulsoSincronizadosHoy(
    { fecha: today },
    { query: { refetchInterval: 60_000 } },
  );

  // El recepcionista no tiene acceso al dashboard: va directo a su agenda
  if (!isLoadingAuth && user?.rol === "recepcionista" && !user?.perfil) {
    return <Redirect to="/recepcion/agenda-medico" />;
  }
  // Los médicos tampoco ven el dashboard: van directo a "Mi agenda"
  if (!isLoadingAuth && user?.rol === "medico") {
    return <Redirect to="/recepcion/agenda-medico" />;
  }

  return (
    <>
      <PageHeader 
        title="Dashboard"
        breadcrumb={[{ label: "Inicio", href: "/" }, { label: "Dashboard" }]}
        action={
          <Link href="/turnos/nuevo">
            <Button variant="secondary" className="gap-2 bg-white/20 hover:bg-white/30 text-white border-0">
              <Calendar className="w-4 h-4" />
              Nuevo turno
            </Button>
          </Link>
        }
      />
      
      <div className="p-6 space-y-6">
        <div className="flex items-start justify-between mb-2">
          <div>
            <p className="text-muted-foreground">
              {format(new Date(), "EEEE d 'de' MMMM, yyyy", { locale: es })}
            </p>
          </div>
        </div>

        {/* KPI Cards */}
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Turnos hoy</CardTitle>
              <Calendar className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              {isLoadingResumen ? <Skeleton className="h-8 w-20" /> : (
                <>
                  <div className="text-2xl font-bold">{resumen?.turnosTotal ?? 0}</div>
                  <p className="text-xs text-muted-foreground">Agendados para hoy</p>
                </>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Pendientes</CardTitle>
              <Clock className="h-4 w-4 text-amber-500" />
            </CardHeader>
            <CardContent>
              {isLoadingResumen ? <Skeleton className="h-8 w-20" /> : (
                <>
                  <div className="text-2xl font-bold">{resumen?.turnosPendientes ?? 0}</div>
                  <p className="text-xs text-muted-foreground">Esperando atención</p>
                </>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Atendidos</CardTitle>
              <CheckCircle2 className="h-4 w-4 text-green-500" />
            </CardHeader>
            <CardContent>
              {isLoadingResumen ? <Skeleton className="h-8 w-20" /> : (
                <>
                  <div className="text-2xl font-bold">{resumen?.turnosAtendidos ?? 0}</div>
                  <p className="text-xs text-muted-foreground">Pacientes vistos</p>
                </>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Ausentes</CardTitle>
              <XCircle className="h-4 w-4 text-destructive" />
            </CardHeader>
            <CardContent>
              {isLoadingResumen ? <Skeleton className="h-8 w-20" /> : (
                <>
                  <div className="text-2xl font-bold">{resumen?.turnosAusentes ?? 0}</div>
                  <p className="text-xs text-muted-foreground">No se presentaron</p>
                </>
              )}
            </CardContent>
          </Card>
        </div>

        {/* Cartel: pacientes sincronizados desde Pulso hoy */}
        <Card>
          <CardHeader className="flex flex-row items-start justify-between space-y-0">
            <div>
              <CardTitle className="flex items-center gap-2">
                <RefreshCw className={`w-4 h-4 ${pulso?.sincronizando ? "animate-spin text-primary" : "text-muted-foreground"}`} />
                Pacientes desde Pulso hoy
              </CardTitle>
              <p className="text-xs text-muted-foreground mt-1">
                {pulso?.configurado === false
                  ? "Integración Pulso no configurada"
                  : pulso?.ultimaSincronizacion
                    ? `Último sync: ${format(new Date(pulso.ultimaSincronizacion), "d MMM HH:mm", { locale: es })}${pulso.ultimoModo ? ` (${pulso.ultimoModo})` : ""}`
                    : "Sin sincronizaciones registradas todavía"}
              </p>
            </div>
            {pulso?.sincronizando && (
              <Badge variant="secondary" className="gap-1">
                <RefreshCw className="w-3 h-3 animate-spin" />
                Sincronizando…
              </Badge>
            )}
          </CardHeader>
          <CardContent>
            {isLoadingPulso ? (
              <div className="space-y-4">
                <div className="grid gap-4 sm:grid-cols-3">
                  <Skeleton className="h-16 w-full" />
                  <Skeleton className="h-16 w-full" />
                  <Skeleton className="h-16 w-full" />
                </div>
                <Skeleton className="h-24 w-full" />
              </div>
            ) : isErrorPulso ? (
              <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-6 text-center text-sm text-destructive">
                No se pudo cargar el estado de sincronización de Pulso. Reintentando…
              </div>
            ) : (
              <div className="space-y-4">
                <div className="grid gap-4 sm:grid-cols-3">
                  <div className="rounded-lg border bg-emerald-500/10 p-3">
                    <div className="flex items-center gap-2 text-emerald-600 dark:text-emerald-400">
                      <UserPlus className="w-4 h-4" />
                      <span className="text-xs font-medium">Nuevos hoy</span>
                    </div>
                    <div className="text-2xl font-bold text-emerald-600 dark:text-emerald-400 mt-1">{pulso?.nuevosHoy ?? 0}</div>
                    <p className="text-[11px] text-emerald-600/70 dark:text-emerald-400/70">Pacientes importados por primera vez</p>
                  </div>
                  <div className="rounded-lg border bg-blue-500/10 p-3">
                    <div className="flex items-center gap-2 text-blue-600 dark:text-blue-400">
                      <RefreshCw className="w-4 h-4" />
                      <span className="text-xs font-medium">Tocados hoy</span>
                    </div>
                    <div className="text-2xl font-bold text-blue-600 dark:text-blue-400 mt-1">{pulso?.actualizadosHoy ?? 0}</div>
                    <p className="text-[11px] text-blue-600/70 dark:text-blue-400/70">Nuevos + actualizados por el sync</p>
                  </div>
                  <div className="rounded-lg border bg-muted/50 p-3">
                    <div className="flex items-center gap-2 text-foreground">
                      <Users className="w-4 h-4" />
                      <span className="text-xs font-medium">Total Pulso</span>
                    </div>
                    <div className="text-2xl font-bold text-foreground mt-1">{pulso?.totalPulso ?? 0}</div>
                    <p className="text-[11px] text-muted-foreground">Vinculados en total</p>
                  </div>
                </div>

                {!pulso?.pacientes?.length ? (
                  <div className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
                    No entraron pacientes desde Pulso hoy.
                    {pulso?.configurado === false
                      ? " La integración no está configurada."
                      : " El sync corre periódicamente; si esperabas pacientes nuevos, revisá la integración."}
                  </div>
                ) : (
                  <div className="rounded-lg border overflow-hidden">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Paciente</TableHead>
                          <TableHead>DNI</TableHead>
                          <TableHead>HC</TableHead>
                          <TableHead className="text-right">Sincronizado</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {pulso.pacientes.map((p) => (
                          <TableRow key={p.pacienteId}>
                            <TableCell className="font-medium text-sm">
                              <Link href={`/pacientes/${p.pacienteId}`} className="hover:underline">
                                {p.apellido}, {p.nombre}
                              </Link>
                              {p.esNuevoHoy && (
                                <Badge variant="secondary" className="ml-2 bg-emerald-500/20 text-emerald-600 dark:text-emerald-400 text-[10px]">
                                  Nuevo
                                </Badge>
                              )}
                            </TableCell>
                            <TableCell className="text-sm text-muted-foreground">{p.dni ?? "—"}</TableCell>
                            <TableCell className="text-sm text-muted-foreground">{p.numeroHc ?? "—"}</TableCell>
                            <TableCell className="text-right text-xs text-muted-foreground">
                              {format(new Date(p.lastSyncedAt), "HH:mm", { locale: es })}
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                )}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Módulos */}
        <div>
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-semibold">Módulos</h2>
            <span className="text-xs text-muted-foreground">{MODULOS.length} módulos disponibles</span>
          </div>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {MODULOS.map((mod) => {
              const Icon = mod.icon;
              return (
                <Link key={mod.href} href={mod.href}>
                  <Card className={`border cursor-pointer hover:shadow-md transition-all hover:-translate-y-0.5 ${mod.color}`}>
                    <CardContent className="p-4">
                      <div className="flex items-start justify-between mb-3">
                        <div className={`p-2 rounded-lg ${mod.iconBg}`}>
                          <Icon className="w-5 h-5" />
                        </div>
                        <div className="flex items-center gap-1">
                          {mod.badge && (
                            <span className="text-[10px] font-semibold bg-primary/10 text-primary px-1.5 py-0.5 rounded-full">
                              {mod.badge}
                            </span>
                          )}
                          <ChevronRight className="w-4 h-4 opacity-40" />
                        </div>
                      </div>
                      <div className="font-semibold text-sm leading-tight">{mod.titulo}</div>
                      <div className="text-xs opacity-70 mt-0.5 leading-snug">{mod.descripcion}</div>
                    </CardContent>
                  </Card>
                </Link>
              );
            })}
          </div>
        </div>

        {/* Charts */}
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-7">
          <Card className="lg:col-span-4">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Activity className="w-4 h-4" />
                Turnos en la semana
              </CardTitle>
            </CardHeader>
            <CardContent className="pl-2">
              {isLoadingSemana ? (
                <Skeleton className="h-[240px] w-full" />
              ) : (
                <div className="h-[240px] w-full">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={turnosSemana ?? []}>
                      <XAxis
                        dataKey="fecha"
                        stroke="#888888"
                        fontSize={12}
                        tickLine={false}
                        axisLine={false}
                        tickFormatter={(value) => {
                          try {
                            return format(new Date(value + "T00:00:00"), "E d", { locale: es });
                          } catch {
                            return value;
                          }
                        }}
                      />
                      <YAxis stroke="#888888" fontSize={12} tickLine={false} axisLine={false} />
                      <Tooltip />
                      <Bar dataKey="cantidad" fill="currentColor" radius={[4, 4, 0, 0]} className="fill-primary" />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              )}
            </CardContent>
          </Card>

          <Card className="lg:col-span-3">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <FileBarChart2 className="w-4 h-4" />
                Ocupación de turneras
              </CardTitle>
            </CardHeader>
            <CardContent>
              {isLoadingOcupacion ? (
                <div className="space-y-4">
                  <Skeleton className="h-10 w-full" />
                  <Skeleton className="h-10 w-full" />
                  <Skeleton className="h-10 w-full" />
                </div>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Turnera</TableHead>
                      <TableHead>Ocupación</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {!ocupacion?.length ? (
                      <TableRow>
                        <TableCell colSpan={2} className="text-center text-muted-foreground">
                          No hay turneras activas hoy
                        </TableCell>
                      </TableRow>
                    ) : (
                      ocupacion.map((item) => (
                        <TableRow key={item.turneraId}>
                          <TableCell className="font-medium text-sm">
                            <div>{item.nombre}</div>
                            <div className="text-xs text-muted-foreground">{item.profesional}</div>
                          </TableCell>
                          <TableCell>
                            <div className="flex items-center gap-2">
                              <Progress value={item.ocupacion} className="h-2" />
                              <span className="text-xs font-medium w-9 text-right">{Math.round(item.ocupacion)}%</span>
                            </div>
                            <div className="text-[10px] text-muted-foreground text-right mt-1">
                              {item.ocupados} / {item.totalSlots}
                            </div>
                          </TableCell>
                        </TableRow>
                      ))
                    )}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </>
  );
}
