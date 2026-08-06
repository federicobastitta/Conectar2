import { useMemo, useState } from "react";
import { useSearch, Link } from "wouter";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  Send,
  CheckCircle2,
  AlertCircle,
  Clock,
  RefreshCw,
  FlaskConical,
  MessageSquarePlus,
  X,
} from "lucide-react";
import { useListNotificacionesSalientes } from "@workspace/api-client-react";

const ESTADO_CONFIG: Record<string, { color: string; label: string; icon: React.ElementType }> = {
  enviada: { color: "bg-emerald-100 text-emerald-700", label: "Enviada", icon: CheckCircle2 },
  simulada: { color: "bg-amber-100 text-amber-700", label: "Simulada", icon: FlaskConical },
  pendiente: { color: "bg-blue-100 text-blue-700", label: "Pendiente", icon: Clock },
  fallida: { color: "bg-red-100 text-red-700", label: "Fallida", icon: AlertCircle },
};

const EVENTO_LABELS: Record<string, string> = {
  turnera_cancelada: "Turnera cancelada",
  solicitud_indicada: "Estudio indicado",
  cambio_estado: "Cambio de estado",
  informe_disponible: "Informe disponible",
};

export default function Notificaciones() {
  const search = useSearch();
  const loteParam = useMemo(() => new URLSearchParams(search).get("lote") ?? undefined, [search]);
  const [evento, setEvento] = useState<string>("todos");
  const [lote, setLote] = useState<string | undefined>(loteParam);

  const { data: notificaciones, isLoading, refetch, isFetching } = useListNotificacionesSalientes({
    ...(lote ? { loteId: lote } : {}),
    ...(evento !== "todos" ? { evento } : {}),
  });

  const rows = notificaciones ?? [];
  const enviadas = rows.filter((n) => n.estadoEntrega === "enviada").length;
  const simuladas = rows.filter((n) => n.estadoEntrega === "simulada").length;
  const fallidas = rows.filter((n) => n.estadoEntrega === "fallida").length;
  const pendientes = rows.filter((n) => n.estadoEntrega === "pendiente").length;

  const eventosDisponibles = useMemo(() => {
    const s = new Set(rows.map((n) => n.evento));
    Object.keys(EVENTO_LABELS).forEach((e) => s.add(e));
    return Array.from(s).sort();
  }, [rows]);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Notificaciones</h1>
          <p className="text-muted-foreground">Seguimiento de los avisos por WhatsApp a pacientes</p>
        </div>
        <div className="flex gap-2">
          <Link href="/mensajeria">
            <Button variant="outline">
              <MessageSquarePlus className="w-4 h-4 mr-2" /> Nuevo aviso masivo
            </Button>
          </Link>
          <Button variant="outline" onClick={() => refetch()} disabled={isFetching}>
            <RefreshCw className={`w-4 h-4 mr-2 ${isFetching ? "animate-spin" : ""}`} />
            Actualizar
          </Button>
        </div>
      </div>

      {lote && (
        <div className="flex items-center gap-2">
          <Badge variant="secondary" className="text-sm">
            Viendo el lote {lote.slice(0, 8)}…
            <button className="ml-2" onClick={() => setLote(undefined)} aria-label="Quitar filtro de lote">
              <X className="w-3 h-3" />
            </button>
          </Badge>
        </div>
      )}

      <div className="grid gap-4 md:grid-cols-5">
        <Card>
          <CardContent className="pt-6">
            <div className="text-2xl font-bold">{rows.length}</div>
            <div className="flex items-center gap-1 mt-1">
              <Send className="w-3 h-3 text-muted-foreground" />
              <p className="text-sm text-muted-foreground">Total</p>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <div className="text-2xl font-bold text-emerald-600">{enviadas}</div>
            <div className="flex items-center gap-1 mt-1">
              <CheckCircle2 className="w-3 h-3 text-emerald-600" />
              <p className="text-sm text-muted-foreground">Enviadas</p>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <div className="text-2xl font-bold text-amber-600">{simuladas}</div>
            <div className="flex items-center gap-1 mt-1">
              <FlaskConical className="w-3 h-3 text-amber-600" />
              <p className="text-sm text-muted-foreground">Simuladas</p>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <div className="text-2xl font-bold text-blue-600">{pendientes}</div>
            <div className="flex items-center gap-1 mt-1">
              <Clock className="w-3 h-3 text-blue-600" />
              <p className="text-sm text-muted-foreground">Pendientes</p>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <div className="text-2xl font-bold text-red-600">{fallidas}</div>
            <div className="flex items-center gap-1 mt-1">
              <AlertCircle className="w-3 h-3 text-red-600" />
              <p className="text-sm text-muted-foreground">Fallidas</p>
            </div>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0">
          <CardTitle>Historial de envíos</CardTitle>
          <div className="w-56">
            <Select value={evento} onValueChange={setEvento}>
              <SelectTrigger>
                <SelectValue placeholder="Filtrar por evento" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="todos">Todos los eventos</SelectItem>
                {eventosDisponibles.map((e) => (
                  <SelectItem key={e} value={e}>
                    {EVENTO_LABELS[e] ?? e}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <p className="text-sm text-muted-foreground py-8 text-center">Cargando...</p>
          ) : rows.length === 0 ? (
            <p className="text-sm text-muted-foreground py-8 text-center">
              Todavía no hay notificaciones registradas.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Fecha</TableHead>
                  <TableHead>Paciente</TableHead>
                  <TableHead className="hidden md:table-cell">Evento</TableHead>
                  <TableHead className="hidden lg:table-cell">Teléfono</TableHead>
                  <TableHead>Estado</TableHead>
                  <TableHead className="hidden xl:table-cell">Mensaje</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((n) => {
                  const cfg = ESTADO_CONFIG[n.estadoEntrega] ?? ESTADO_CONFIG.pendiente;
                  const Icon = cfg.icon;
                  return (
                    <TableRow key={n.id}>
                      <TableCell className="text-xs text-muted-foreground whitespace-nowrap">
                        {new Date(n.createdAt).toLocaleString("es-AR", {
                          day: "2-digit",
                          month: "2-digit",
                          hour: "2-digit",
                          minute: "2-digit",
                        })}
                      </TableCell>
                      <TableCell className="font-medium text-sm">{n.pacienteNombre ?? `#${n.patientId}`}</TableCell>
                      <TableCell className="hidden md:table-cell">
                        <div className="flex items-center gap-1.5">
                          <span className="text-sm">{EVENTO_LABELS[n.evento] ?? n.evento}</span>
                          {n.loteId && (
                            <button
                              className="text-[10px] text-muted-foreground underline decoration-dotted"
                              onClick={() => setLote(n.loteId ?? undefined)}
                              title="Ver todo el lote"
                            >
                              lote
                            </button>
                          )}
                        </div>
                      </TableCell>
                      <TableCell className="hidden lg:table-cell text-sm text-muted-foreground">
                        {n.destinatario ?? "—"}
                      </TableCell>
                      <TableCell>
                        <span
                          className={`inline-flex items-center gap-1 text-xs font-medium px-2 py-0.5 rounded-full ${cfg.color}`}
                          title={n.errorDetalle ?? undefined}
                        >
                          <Icon className="w-3 h-3" />
                          {cfg.label}
                        </span>
                        {n.errorDetalle && (
                          <p className="text-[10px] text-red-600 mt-0.5 max-w-[180px]">{n.errorDetalle}</p>
                        )}
                      </TableCell>
                      <TableCell className="hidden xl:table-cell text-xs text-muted-foreground max-w-md truncate" title={n.contenido}>
                        {n.contenido}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
