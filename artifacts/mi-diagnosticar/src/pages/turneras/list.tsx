import type React from "react";
import { useMemo, useState } from "react";
import { Link } from "wouter";
import { useListTurneras, useUpdateTurnera, useListProfesionales, useGetDemandaEspontanea, getListTurnerasQueryKey, type Turnera } from "@workspace/api-client-react";
import { Card, CardContent } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Input } from "@/components/ui/input";
import { Plus, Edit, CalendarRange, Globe, Lock, Phone, Search, X, Check, Users } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { useQueryClient } from "@tanstack/react-query";

// Búsqueda insensible a acentos y mayúsculas
function normalizar(s: string): string {
  return s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

const VISIBILIDAD_CONFIG: Record<string, { label: string; className: string; icon: React.ElementType }> = {
  online:     { label: "Online",      className: "bg-green-100 text-green-800 border-green-200",    icon: Globe },
  recepcion:  { label: "Recepción",   className: "bg-blue-100 text-blue-800 border-blue-200",      icon: Phone },
  callcenter: { label: "Call Center", className: "bg-purple-100 text-purple-800 border-purple-200", icon: Phone },
  interna:    { label: "Interna",     className: "bg-muted text-muted-foreground border-border",       icon: Lock },
};

// Agrupa las turneras de un mismo profesional + especialidad + sede en una fila.
type Grupo = {
  key: string;
  turneras: Turnera[];
};

function agruparTurneras(lista: Turnera[]): Grupo[] {
  const grupos = new Map<string, Grupo>();
  for (const t of lista) {
    const key = t.profesionalId
      ? `p${t.profesionalId}-e${t.especialidadId ?? "x"}-s${t.sedeId ?? "x"}`
      : `t${t.id}`;
    const g = grupos.get(key);
    if (g) g.turneras.push(t);
    else grupos.set(key, { key, turneras: [t] });
  }
  return [...grupos.values()];
}

export default function TurnerasList() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { data: turneras, isLoading } = useListTurneras({});
  const { data: profesionales } = useListProfesionales({});
  // Guardias: médicos con demanda espontánea prendida ahora, por turnera
  const { data: demanda } = useGetDemandaEspontanea({ query: { refetchInterval: 60_000 } });
  const medicosActivosPorTurnera = useMemo(() => {
    const map = new Map<number, { id: number; nombre: string; hastaHora?: string | null }[]>();
    for (const d of demanda ?? []) map.set(d.turneraId, d.medicos);
    return map;
  }, [demanda]);
  const updateTurnera = useUpdateTurnera();
  const [busqueda, setBusqueda] = useState("");

  const nombreProf = useMemo(() => {
    const map = new Map<number, string>();
    for (const p of profesionales ?? []) map.set(p.id, `${p.apellido}, ${p.nombre}`);
    return map;
  }, [profesionales]);

  const grupos = useMemo(() => {
    let lista = turneras ?? [];
    const q = normalizar(busqueda.trim());
    if (q) {
      lista = lista.filter((t) => {
        const prof = t.profesional ? `${t.profesional.apellido} ${t.profesional.nombre}` : "";
        const texto = normalizar(
          `${t.nombre} ${prof} ${t.especialidad?.nombre ?? ""} ${t.sede?.nombre ?? ""}`,
        );
        return q.split(/\s+/).every((palabra) => texto.includes(palabra));
      });
    }
    return agruparTurneras(lista);
  }, [turneras, busqueda]);

  const handleToggleActiva = (grupo: Grupo, current: boolean) => {
    let pendientes = grupo.turneras.length;
    for (const t of grupo.turneras) {
      updateTurnera.mutate({ id: t.id, data: { activa: !current } }, {
        onSuccess: () => {
          pendientes -= 1;
          if (pendientes === 0) {
            queryClient.invalidateQueries({ queryKey: getListTurnerasQueryKey() });
            toast({ title: `Agenda ${!current ? "activada" : "desactivada"}` });
          }
        },
      });
    }
  };

  const getDiasString = (dias?: number[]) => {
    if (!dias || dias.length === 0) return "Ninguno";
    const map = ["Dom", "Lun", "Mar", "Mié", "Jue", "Vie", "Sáb"];
    return dias.map(d => map[d]).join(", ");
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Agendas / Turneras</h1>
          <p className="text-muted-foreground">Configuración de agendas y horarios</p>
        </div>
        <Link href="/turneras/nueva">
          <Button>
            <Plus className="w-4 h-4 mr-2" />
            Nueva Agenda
          </Button>
        </Link>
      </div>

      <div className="flex items-center gap-3 flex-wrap">
        <div className="relative w-full max-w-sm">
          <Search className="w-4 h-4 absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none" />
          <Input
            value={busqueda}
            onChange={(e) => setBusqueda(e.target.value)}
            placeholder="Buscar por profesional, especialidad, sede o agenda…"
            className="pl-8 pr-8"
            data-testid="buscador-turneras"
          />
          {busqueda && (
            <button
              type="button"
              onClick={() => setBusqueda("")}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              data-testid="buscador-turneras-limpiar"
              aria-label="Limpiar búsqueda"
            >
              <X className="w-4 h-4" />
            </button>
          )}
        </div>
        {busqueda.trim() && (
          <span className="text-sm text-muted-foreground">
            {grupos.length === 0
              ? "Sin resultados"
              : `${grupos.length} agenda${grupos.length === 1 ? "" : "s"}`}
          </span>
        )}
      </div>

      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Nombre / Profesional</TableHead>
                <TableHead>Sede / Especialidad</TableHead>
                <TableHead>Horarios</TableHead>
                <TableHead>Cupos</TableHead>
                <TableHead className="text-center">Visibilidad</TableHead>
                <TableHead className="text-center">Activa</TableHead>
                <TableHead className="text-right">Acciones</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                Array.from({ length: 5 }).map((_, i) => (
                  <TableRow key={i}>
                    {Array.from({ length: 7 }).map((__, j) => (
                      <TableCell key={j}><Skeleton className="h-8 w-full" /></TableCell>
                    ))}
                  </TableRow>
                ))
              ) : grupos.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={7} className="h-32 text-center text-muted-foreground">
                    {busqueda.trim() ? "No se encontraron agendas para esa búsqueda." : "No hay turneras configuradas aún."}
                  </TableCell>
                </TableRow>
              ) : (
                grupos.map((grupo) => {
                  const principal = grupo.turneras[0];
                  const algunaActiva = grupo.turneras.some((t) => t.activa);
                  const visibilidades = [...new Set(grupo.turneras.flatMap((t) => (t.visibilidad ?? "").split(",").map((v) => v.trim()).filter(Boolean)))];
                  const llevaInforme = grupo.turneras.some((t) => t.llevaInforme);
                  return (
                    <TableRow key={grupo.key} className={!algunaActiva ? "opacity-55" : ""}>
                      <TableCell>
                        <div className="font-medium flex items-center gap-2">
                          <div className="w-3 h-3 rounded-full shrink-0" style={{ backgroundColor: principal.color || "#cbd5e1" }} />
                          {principal.nombre}
                        </div>
                        <div className="text-xs text-muted-foreground mt-0.5">
                          {principal.profesional
                            ? `${principal.profesional.apellido}, ${principal.profesional.nombre}`
                            : "Sin profesional asignado"}
                        </div>
                        {principal.esGuardia && (
                          <div className="mt-1.5 space-y-0.5" data-testid={`participantes-lista-${principal.id}`}>
                            <span className="inline-flex items-center gap-1 rounded-full border border-amber-400/60 bg-amber-100 dark:bg-amber-900/40 text-amber-800 dark:text-amber-200 px-2 py-0.5 text-[11px] font-semibold">
                              <Users className="w-3 h-3" /> Guardia · por orden de llegada
                            </span>
                            <div className="text-[11px] text-muted-foreground/70">
                              La atienden los médicos habilitados que prenden demanda espontánea
                            </div>
                            {(() => {
                              const activos = medicosActivosPorTurnera.get(principal.id) ?? [];
                              return activos.length > 0 ? (
                                <div className="flex flex-wrap items-center gap-1 pt-0.5" data-testid={`medicos-activos-${principal.id}`}>
                                  <span className="text-[11px] font-medium text-emerald-700 dark:text-emerald-300">Atendiendo ahora:</span>
                                  {activos.map((m) => (
                                    <span key={m.id} className="inline-flex items-center gap-1 rounded-full bg-emerald-100 dark:bg-emerald-900/40 text-emerald-800 dark:text-emerald-200 px-1.5 py-0.5 text-[11px]">
                                      <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
                                      {m.nombre}{m.hastaHora ? ` (hasta ${m.hastaHora.substring(0, 5)})` : ""}
                                    </span>
                                  ))}
                                </div>
                              ) : (
                                <div className="text-[11px] text-muted-foreground/70">Ahora no hay médicos atendiendo</div>
                              );
                            })()}
                          </div>
                        )}
                      </TableCell>
                      <TableCell>
                        <div className="text-sm font-medium">{principal.sede?.nombre ?? "—"}</div>
                        <div className="text-xs text-muted-foreground">{principal.especialidad?.nombre ?? "—"}</div>
                      </TableCell>
                      <TableCell>
                        <div className="space-y-1">
                          {grupo.turneras.map((t) => (
                            <div key={t.id}>
                              <div className="text-sm flex items-center gap-1">
                                <CalendarRange className="w-3.5 h-3.5 text-muted-foreground" />
                                {getDiasString(t.diasAtencion)}
                              </div>
                              {t.esGuardia ? (
                                <div className="text-xs text-amber-700 dark:text-amber-300">Por orden de llegada</div>
                              ) : (t.horariosDia ?? []).length > 0 ? (
                                <div className="text-xs text-muted-foreground">
                                  {[...(t.horariosDia ?? [])]
                                    .sort((a, b) => (a.dia ?? 0) - (b.dia ?? 0))
                                    .map((h) => `${["Dom", "Lun", "Mar", "Mié", "Jue", "Vie", "Sáb"][h.dia ?? 0]} ${h.horaInicio?.substring(0, 5)}–${h.horaFin?.substring(0, 5)}`)
                                    .join(" · ")} ({t.duracionMinutos}m)
                                </div>
                              ) : (
                                <div className="text-xs text-muted-foreground">
                                  {t.horaInicio?.substring(0, 5)} – {t.horaFin?.substring(0, 5)} ({t.duracionMinutos}m)
                                </div>
                              )}
                            </div>
                          ))}
                        </div>
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        {principal.cuposDiarios ? `${principal.cuposDiarios} cupos` : "Sin límite"}
                        {(principal.sobreturnos ?? 0) > 0 && (
                          <div className="text-xs">+{principal.sobreturnos} sobret.</div>
                        )}
                        {(principal.obrasSociales ?? []).length > 0 && (
                          <div className="text-xs mt-0.5" data-testid={`os-turnera-${principal.id}`}>
                            {(principal.obrasSociales ?? [])
                              .map((o) => `${o.nombre}${o.cupoDiario != null ? ` (${o.cupoDiario})` : ""}`)
                              .join(" · ")}
                          </div>
                        )}
                      </TableCell>
                      <TableCell className="text-center">
                        <div className="flex flex-col items-center gap-1">
                          {visibilidades.map((v) => {
                            const visConf = VISIBILIDAD_CONFIG[v] ?? VISIBILIDAD_CONFIG.interna;
                            const VisIcon = visConf.icon;
                            return (
                              <Badge key={v} variant="outline" className={`text-xs font-medium flex items-center gap-1 w-fit mx-auto ${visConf.className}`}>
                                <VisIcon className="w-3 h-3" />
                                {visConf.label}
                              </Badge>
                            );
                          })}
                          {llevaInforme && (
                            <Badge variant="outline" className="text-xs font-medium w-fit mx-auto bg-violet-50 text-violet-700 border-violet-200">
                              Lleva informe
                            </Badge>
                          )}
                        </div>
                      </TableCell>
                      <TableCell className="text-center">
                        <Switch
                          checked={algunaActiva}
                          onCheckedChange={() => handleToggleActiva(grupo, algunaActiva)}
                        />
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex flex-col items-end gap-0.5">
                          {grupo.turneras.map((t) => (
                            <div key={t.id} className="flex items-center gap-0.5">
                              <Link href={`/turneras/${t.id}/editar`}>
                                <Button variant="ghost" size="sm" title={`Editar ${getDiasString(t.diasAtencion)} ${t.horaInicio?.substring(0, 5)}–${t.horaFin?.substring(0, 5)}`}>
                                  <Edit className="w-4 h-4" />
                                  {grupo.turneras.length > 1 && (
                                    <span className="ml-1 text-xs text-muted-foreground">{t.horaInicio?.substring(0, 5)}</span>
                                  )}
                                </Button>
                              </Link>
                            </div>
                          ))}
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
