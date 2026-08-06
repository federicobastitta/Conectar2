import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { useToast } from "@/hooks/use-toast";
import { Link } from "wouter";
import {
  ArrowLeft,
  CheckCircle,
  AlertTriangle,
  RefreshCw,
  ChevronDown,
  ChevronRight,
  Clock,
  Building,
  Stethoscope,
  Users,
  Calendar,
} from "lucide-react";

// ── Tipos ────────────────────────────────────────────────────────────────────

interface ImportacionAdmin {
  id: number;
  runId: string;
  fuente: string;
  archivo: string | null;
  estado: string;
  totalFilas: number;
  sedesCreadas: number;
  sedesReutilizadas: number;
  especialidadesCreadas: number;
  especialidadesReutilizadas: number;
  profesionalesCreados: number;
  profesionalesReutilizados: number;
  agendasCreadas: number;
  agendasActualizadas: number;
  filasOmitidas: number;
  conflictos: number;
  detalle: {
    agendasReutilizadas?: number;
    agendasReutilizadasDetalle?: {
      turneraId: number;
      motivo: string;
      turneraNombre?: string | null;
    }[];
  } | null;
  createdAt: string;
}

interface ImportacionConflicto {
  id: number;
  runId: string;
  tipo: string;
  motivo: string;
  profesionalNombre: string | null;
  filaOriginal: Record<string, unknown>;
  filasRelacionadas: Record<string, unknown>[] | null;
  resuelto: boolean;
  resueltoPor: string | null;
  resueltoAt: string | null;
  createdAt: string;
}

// ── Fetch helpers ────────────────────────────────────────────────────────────

const authHeaders = () => ({
  "Content-Type": "application/json",
  Authorization: `Bearer ${localStorage.getItem("auth_token") ?? ""}`,
});

async function fetchRuns(): Promise<ImportacionAdmin[]> {
  const r = await fetch("/api/importaciones-admin", { headers: authHeaders() });
  if (!r.ok) throw new Error("Error al cargar historial");
  return r.json();
}

async function fetchConflictos(abiertos: boolean): Promise<ImportacionConflicto[]> {
  const r = await fetch(`/api/importaciones-admin-conflictos?abiertos=${abiertos}`, {
    headers: authHeaders(),
  });
  if (!r.ok) throw new Error("Error al cargar conflictos");
  return r.json();
}

async function resolverConflicto(id: number): Promise<ImportacionConflicto> {
  const r = await fetch(`/api/importaciones-admin-conflictos/${id}/resolver`, {
    method: "PATCH",
    headers: authHeaders(),
  });
  if (!r.ok) throw new Error("Error al resolver conflicto");
  return r.json();
}

// ── Componentes auxiliares ───────────────────────────────────────────────────

function StatChip({
  label,
  creados,
  reutilizados,
  icon: Icon,
  color,
}: {
  label: string;
  creados: number;
  reutilizados: number;
  icon: React.ElementType;
  color: string;
}) {
  return (
    <div className="flex items-center gap-2 text-sm">
      <Icon className={`h-4 w-4 ${color}`} />
      <span className="text-muted-foreground">{label}:</span>
      <Badge variant="default" className="text-xs">{creados} nuevas</Badge>
      <Badge variant="secondary" className="text-xs">{reutilizados} reutilizadas</Badge>
    </div>
  );
}

function RunCard({ run }: { run: ImportacionAdmin }) {
  const [expanded, setExpanded] = useState(false);
  const date = new Date(run.createdAt).toLocaleString("es-AR", {
    timeZone: "America/Argentina/Buenos_Aires",
    day: "2-digit", month: "2-digit", year: "numeric",
    hour: "2-digit", minute: "2-digit",
  });

  return (
    <Card className="border">
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-2">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <Badge variant={run.estado === "completado" ? "default" : "secondary"}>
                {run.estado === "completado" ? "Completado" : "Parcial"}
              </Badge>
              {run.conflictos > 0 && (
                <Badge variant="destructive" className="gap-1">
                  <AlertTriangle className="h-3 w-3" />
                  {run.conflictos} conflictos
                </Badge>
              )}
              <span className="text-xs text-muted-foreground font-mono truncate">
                {run.runId}
              </span>
            </div>
            <div className="flex items-center gap-1 mt-1 text-xs text-muted-foreground">
              <Clock className="h-3 w-3" />
              {date}
              {run.archivo && <span className="ml-2">· {run.archivo}</span>}
            </div>
          </div>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7 shrink-0"
            onClick={() => setExpanded((v) => !v)}
          >
            {expanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
          </Button>
        </div>
      </CardHeader>

      {expanded && (
        <CardContent className="pt-0 space-y-3">
          <Separator />
          {/* Totales generales */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-center">
            {[
              { label: "Filas totales", value: run.totalFilas },
              { label: "Omitidas", value: run.filasOmitidas },
              { label: "Agendas creadas", value: run.agendasCreadas },
              { label: "Agendas actualizadas", value: run.agendasActualizadas },
            ].map(({ label, value }) => (
              <div key={label} className="bg-muted/40 rounded-lg p-2">
                <p className="text-lg font-semibold">{value}</p>
                <p className="text-xs text-muted-foreground">{label}</p>
              </div>
            ))}
          </div>

          {/* Por entidad */}
          <div className="space-y-2">
            <StatChip label="Sedes" creados={run.sedesCreadas} reutilizados={run.sedesReutilizadas} icon={Building} color="text-blue-500" />
            <StatChip label="Especialidades" creados={run.especialidadesCreadas} reutilizados={run.especialidadesReutilizadas} icon={Stethoscope} color="text-green-500" />
            <StatChip label="Profesionales" creados={run.profesionalesCreados} reutilizados={run.profesionalesReutilizados} icon={Users} color="text-purple-500" />
            <StatChip label="Agendas" creados={run.agendasCreadas} reutilizados={run.agendasActualizadas} icon={Calendar} color="text-orange-500" />
          </div>

          {/* Agendas reutilizadas */}
          {(run.detalle?.agendasReutilizadasDetalle?.length ?? 0) > 0 && (
            <div className="space-y-2">
              <Separator />
              <div className="flex items-center gap-2 text-sm">
                <RefreshCw className="h-4 w-4 text-orange-500" />
                <span className="font-medium">
                  {run.detalle?.agendasReutilizadas ?? run.detalle?.agendasReutilizadasDetalle?.length} agendas reutilizadas
                </span>
                <span className="text-xs text-muted-foreground">
                  (no se crearon duplicadas)
                </span>
              </div>
              <ul className="space-y-1">
                {run.detalle?.agendasReutilizadasDetalle?.map((a, i) => (
                  <li
                    key={`${a.turneraId}-${i}`}
                    className="text-xs bg-muted/40 rounded p-2 flex flex-wrap items-baseline gap-x-2"
                  >
                    <span className="font-medium">
                      {a.turneraNombre ?? `Agenda #${a.turneraId}`}
                    </span>
                    <span className="text-muted-foreground font-mono">#{a.turneraId}</span>
                    <span className="text-muted-foreground w-full sm:w-auto sm:flex-1">
                      {a.motivo}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </CardContent>
      )}
    </Card>
  );
}

function ConflictoCard({
  conflicto,
  onResolver,
  resolving,
}: {
  conflicto: ImportacionConflicto;
  onResolver: (id: number) => void;
  resolving: boolean;
}) {
  const [expanded, setExpanded] = useState(false);

  return (
    <Card className={`border ${conflicto.resuelto ? "opacity-60" : "border-destructive/40"}`}>
      <CardHeader className="pb-2">
        <div className="flex items-start justify-between gap-2">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <Badge variant={conflicto.resuelto ? "secondary" : "destructive"} className="text-xs">
                {conflicto.tipo}
              </Badge>
              {conflicto.profesionalNombre && (
                <span className="text-sm font-medium capitalize">
                  {conflicto.profesionalNombre}
                </span>
              )}
            </div>
            <p className="text-sm text-muted-foreground mt-1 line-clamp-2">
              {conflicto.motivo}
            </p>
          </div>
          <div className="flex gap-1 shrink-0">
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              onClick={() => setExpanded((v) => !v)}
            >
              {expanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
            </Button>
            {!conflicto.resuelto && (
              <Button
                size="sm"
                variant="outline"
                className="gap-1 h-7"
                disabled={resolving}
                onClick={() => onResolver(conflicto.id)}
              >
                <CheckCircle className="h-3 w-3" />
                Resolver
              </Button>
            )}
          </div>
        </div>
      </CardHeader>

      {expanded && (
        <CardContent className="pt-0">
          <Separator className="mb-3" />
          <div className="space-y-2">
            <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Fila original</p>
            <pre className="text-xs bg-muted rounded p-2 overflow-x-auto whitespace-pre-wrap">
              {JSON.stringify(conflicto.filaOriginal, null, 2)}
            </pre>
            {conflicto.filasRelacionadas && (conflicto.filasRelacionadas as Record<string, unknown>[]).length > 0 && (
              <>
                <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Filas relacionadas</p>
                <pre className="text-xs bg-muted rounded p-2 overflow-x-auto whitespace-pre-wrap">
                  {JSON.stringify(conflicto.filasRelacionadas, null, 2)}
                </pre>
              </>
            )}
            {conflicto.resuelto && (
              <p className="text-xs text-muted-foreground">
                Resuelto por {conflicto.resueltoPor} ·{" "}
                {new Date(conflicto.resueltoAt!).toLocaleString("es-AR", {
                  timeZone: "America/Argentina/Buenos_Aires",
                })}
              </p>
            )}
          </div>
        </CardContent>
      )}
    </Card>
  );
}

// ── Página principal ─────────────────────────────────────────────────────────

export default function ImportacionAdmin() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [soloAbiertos, setSoloAbiertos] = useState(true);

  const runsQuery = useQuery({ queryKey: ["importaciones-admin"], queryFn: fetchRuns });
  const conflictosQuery = useQuery({
    queryKey: ["importaciones-admin-conflictos", soloAbiertos],
    queryFn: () => fetchConflictos(soloAbiertos),
  });

  const resolverMutation = useMutation({
    mutationFn: resolverConflicto,
    onSuccess: () => {
      toast({ title: "Conflicto marcado como resuelto" });
      queryClient.invalidateQueries({ queryKey: ["importaciones-admin-conflictos"] });
      queryClient.invalidateQueries({ queryKey: ["importaciones-admin"] });
    },
    onError: () => toast({ title: "Error al resolver", variant: "destructive" }),
  });

  const runs = runsQuery.data ?? [];
  const conflictos = conflictosQuery.data ?? [];
  const conflictosAbiertos = conflictos.filter((c) => !c.resuelto);

  return (
    <div className="space-y-6 max-w-4xl mx-auto pb-10">
      {/* Header */}
      <div className="flex items-center gap-3">
        <Link href="/configuracion">
          <Button variant="ghost" size="icon" className="h-8 w-8">
            <ArrowLeft className="h-4 w-4" />
          </Button>
        </Link>
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Importación Administrativa</h1>
          <p className="text-sm text-muted-foreground">
            Historial de cargas masivas de sedes, especialidades, profesionales y agendas
          </p>
        </div>
        <Button
          variant="ghost"
          size="icon"
          className="ml-auto h-8 w-8"
          onClick={() => {
            runsQuery.refetch();
            conflictosQuery.refetch();
          }}
        >
          <RefreshCw className="h-4 w-4" />
        </Button>
      </div>

      {/* Instrucciones de ejecución */}
      <Card className="bg-blue-50 border-blue-200">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm text-blue-800">¿Cómo ejecutar una importación?</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-xs text-blue-700 font-mono bg-blue-100 rounded p-2">
            pnpm --filter @workspace/scripts run importar-agendas -- /ruta/al/archivo.xlsx
          </p>
          <p className="text-xs text-blue-600 mt-2">
            Idempotente: se puede correr múltiples veces. Deduplicar por nombre normalizado. Agrupa días con mismo horario y consultorio en una agenda. Los conflictos de solapamiento quedan en la bandeja de abajo.
          </p>
        </CardContent>
      </Card>

      {/* Bandeja de conflictos */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <h2 className="text-lg font-semibold">Bandeja de conflictos</h2>
            {conflictosAbiertos.length > 0 && (
              <Badge variant="destructive">{conflictosAbiertos.length}</Badge>
            )}
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setSoloAbiertos((v) => !v)}
            className="text-xs"
          >
            {soloAbiertos ? "Ver todos (incluye resueltos)" : "Solo abiertos"}
          </Button>
        </div>

        {conflictosQuery.isLoading ? (
          <p className="text-sm text-muted-foreground">Cargando conflictos…</p>
        ) : conflictos.length === 0 ? (
          <Card className="border-dashed">
            <CardContent className="py-8 text-center text-muted-foreground text-sm">
              <CheckCircle className="h-8 w-8 mx-auto mb-2 text-green-500" />
              {soloAbiertos
                ? "No hay conflictos pendientes de revisión."
                : "No hay conflictos registrados todavía."}
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-2">
            {conflictos.map((c) => (
              <ConflictoCard
                key={c.id}
                conflicto={c}
                onResolver={(id) => resolverMutation.mutate(id)}
                resolving={resolverMutation.isPending}
              />
            ))}
          </div>
        )}
      </div>

      <Separator />

      {/* Historial de runs */}
      <div className="space-y-3">
        <h2 className="text-lg font-semibold">Historial de importaciones</h2>

        {runsQuery.isLoading ? (
          <p className="text-sm text-muted-foreground">Cargando historial…</p>
        ) : runs.length === 0 ? (
          <Card className="border-dashed">
            <CardContent className="py-8 text-center text-muted-foreground text-sm">
              Todavía no se ejecutó ninguna importación administrativa.
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-2">
            {runs.map((run) => (
              <RunCard key={run.id} run={run} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
