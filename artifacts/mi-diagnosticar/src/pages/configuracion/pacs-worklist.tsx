import {
  useGetPacsWorklist, getGetPacsWorklistQueryKey,
  useGetPacsSimWorklist, getGetPacsSimWorklistQueryKey,
  useFirmarPacsSimOrden,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";

import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { MonitorCog, PenLine, FileDown, Loader2, RefreshCw } from "lucide-react";

const ESTADO_ENVIO_BADGE: Record<string, { label: string; className: string }> = {
  pendiente: { label: "Pendiente de envío", className: "bg-amber-100 text-amber-800 hover:bg-amber-100" },
  publicado: { label: "Publicado en PACS", className: "bg-emerald-100 text-emerald-800 hover:bg-emerald-100" },
  error: { label: "Error de envío", className: "bg-red-100 text-red-800 hover:bg-red-100" },
  cancelado: { label: "Cancelado", className: "bg-slate-200 text-slate-700 hover:bg-slate-200" },
};

const WORKLIST_STATUS_LABEL: Record<string, string> = {
  scheduled: "Agendado",
  arrived: "Paciente presente",
  ready_to_report: "Listo para informar",
  cancelled: "Cancelado",
};

export default function PacsWorklistPage() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const worklist = useGetPacsWorklist({ query: { refetchInterval: 10000 } });
  const sim = useGetPacsSimWorklist({ query: { refetchInterval: 10000 } });
  const firmar = useFirmarPacsSimOrden();

  const refrescar = () => {
    queryClient.invalidateQueries({ queryKey: getGetPacsWorklistQueryKey() });
    queryClient.invalidateQueries({ queryKey: getGetPacsSimWorklistQueryKey() });
  };

  const firmarOrden = (orderId: string) => {
    firmar.mutate(
      { orderId },
      {
        onSuccess: () => {
          toast({ title: "Informe firmado en el PACS simulado", description: "Se disparó el webhook hacia Conectar." });
          setTimeout(refrescar, 1000);
        },
        onError: () => toast({ title: "No se pudo firmar la orden", variant: "destructive" }),
      },
    );
  };

  const items = worklist.data?.data ?? [];
  const simOrdenes = sim.data?.data ?? [];

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-3xl font-bold tracking-tight flex items-center gap-2">
            <MonitorCog className="w-7 h-7" /> Worklist PACS
          </h1>
          <p className="text-muted-foreground">
            Turnos de especialidades con envío al PACS y su estado de publicación.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {worklist.data && (
            <Badge variant={worklist.data.habilitado ? "default" : "secondary"} data-testid="badge-habilitado">
              {worklist.data.habilitado ? "Integración activa" : "Integración apagada"}
            </Badge>
          )}
          <Button variant="outline" size="sm" onClick={refrescar} data-testid="btn-refrescar">
            <RefreshCw className="w-4 h-4 mr-1.5" /> Refrescar
          </Button>
        </div>
      </div>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Órdenes enviadas desde Conectar</CardTitle>
          <CardDescription>Lo que Conectar publicó (o intenta publicar) en la worklist del PACS.</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="border rounded-md overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow className="bg-slate-800 hover:bg-slate-800">
                  <TableHead className="text-slate-100 text-xs font-semibold uppercase">Accession</TableHead>
                  <TableHead className="text-slate-100 text-xs font-semibold uppercase">Paciente</TableHead>
                  <TableHead className="text-slate-100 text-xs font-semibold uppercase">Estudio</TableHead>
                  <TableHead className="text-slate-100 text-xs font-semibold uppercase">Turno</TableHead>
                  <TableHead className="text-slate-100 text-xs font-semibold uppercase">Estado worklist</TableHead>
                  <TableHead className="text-slate-100 text-xs font-semibold uppercase">Envío</TableHead>
                  <TableHead className="text-slate-100 text-xs font-semibold uppercase">Informe</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {worklist.isLoading ? (
                  Array.from({ length: 3 }).map((_, i) => (
                    <TableRow key={i}>
                      {Array.from({ length: 7 }).map((__, j) => (
                        <TableCell key={j}><Skeleton className="h-7 w-full" /></TableCell>
                      ))}
                    </TableRow>
                  ))
                ) : items.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={7} className="h-24 text-center text-muted-foreground">
                      Todavía no hay órdenes en la worklist. Marcá una especialidad con "Envía al PACS" y creá un turno.
                    </TableCell>
                  </TableRow>
                ) : (
                  items.map((it) => {
                    const badge = ESTADO_ENVIO_BADGE[it.estadoEnvio] ?? { label: it.estadoEnvio, className: "" };
                    const informe = it.informes[0];
                    return (
                      <TableRow key={it.id} data-testid={`worklist-item-${it.turnoId}`}>
                        <TableCell className="font-mono text-xs">{it.accessionNumber}</TableCell>
                        <TableCell className="text-sm">
                          {it.paciente.apellido ? `${it.paciente.apellido}, ${it.paciente.nombre}` : it.paciente.nombre}
                          {it.paciente.dni && <span className="block text-xs text-muted-foreground">DNI {it.paciente.dni}</span>}
                        </TableCell>
                        <TableCell className="text-sm">
                          {it.descripcionEstudio || "—"}
                          {it.modalidad && <Badge variant="outline" className="ml-1.5 text-[10px]">{it.modalidad}</Badge>}
                        </TableCell>
                        <TableCell className="text-sm whitespace-nowrap">
                          {it.fecha}{it.horaInicio ? ` · ${it.horaInicio.slice(0, 5)}` : ""}
                        </TableCell>
                        <TableCell className="text-sm">{WORKLIST_STATUS_LABEL[it.worklistStatus] ?? it.worklistStatus}</TableCell>
                        <TableCell>
                          <Badge className={badge.className} variant="secondary">{badge.label}</Badge>
                          {it.estadoEnvio === "error" && it.ultimoError && (
                            <span className="block text-[11px] text-red-600 mt-0.5 max-w-[220px] truncate" title={it.ultimoError}>
                              {it.ultimoError}
                            </span>
                          )}
                        </TableCell>
                        <TableCell>
                          {informe ? (
                            <Button asChild variant="outline" size="sm" data-testid={`ver-informe-${it.turnoId}`}>
                              <a href={`/api/pacs/informes-firmados/${it.turnoId}/pdf?token=`} onClick={(e) => {
                                e.preventDefault();
                                const token = localStorage.getItem("auth_token") ?? "";
                                fetch(`/api/pacs/informes-firmados/${it.turnoId}/pdf`, { headers: { Authorization: `Bearer ${token}` } })
                                  .then((r) => { if (!r.ok) throw new Error(); return r.blob(); })
                                  .then((b) => window.open(URL.createObjectURL(b), "_blank"))
                                  .catch(() => toast({ title: "No se pudo abrir el PDF", variant: "destructive" }));
                              }}>
                                <FileDown className="w-3.5 h-3.5 mr-1" /> PDF v{informe.version}
                              </a>
                            </Button>
                          ) : (
                            <span className="text-xs text-muted-foreground">Sin informe</span>
                          )}
                        </TableCell>
                      </TableRow>
                    );
                  })
                )}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      <Card className="border-dashed">
        <CardHeader className="pb-3">
          <CardTitle className="text-base">PACS simulado (solo desarrollo)</CardTitle>
          <CardDescription>
            Lo que el PACS de prueba recibió. Podés "firmar" un informe para simular al médico informante y probar el circuito completo.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="border rounded-md overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="text-xs uppercase">Accession</TableHead>
                  <TableHead className="text-xs uppercase">Estudio</TableHead>
                  <TableHead className="text-xs uppercase">Estado</TableHead>
                  <TableHead className="text-xs uppercase">Recibido</TableHead>
                  <TableHead className="text-xs uppercase text-right">Acción</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {sim.isLoading ? (
                  <TableRow><TableCell colSpan={5}><Skeleton className="h-7 w-full" /></TableCell></TableRow>
                ) : simOrdenes.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={5} className="h-20 text-center text-muted-foreground">
                      El PACS simulado todavía no recibió órdenes.
                    </TableCell>
                  </TableRow>
                ) : (
                  simOrdenes.map((o) => (
                    <TableRow key={o.orderId} data-testid={`sim-orden-${o.orderId}`}>
                      <TableCell className="font-mono text-xs">{o.accessionNumber}</TableCell>
                      <TableCell className="text-sm">
                        {o.studyDescription || "—"}
                        {o.modality && <Badge variant="outline" className="ml-1.5 text-[10px]">{o.modality}</Badge>}
                      </TableCell>
                      <TableCell className="text-sm">{WORKLIST_STATUS_LABEL[o.worklistStatus] ?? o.worklistStatus}</TableCell>
                      <TableCell className="text-xs text-muted-foreground whitespace-nowrap">
                        {new Date(o.recibidoEn).toLocaleString("es-AR")}
                      </TableCell>
                      <TableCell className="text-right">
                        {o.informeFirmado ? (
                          <Badge variant="secondary">Informe firmado</Badge>
                        ) : (
                          <Button
                            size="sm"
                            onClick={() => firmarOrden(o.orderId)}
                            disabled={firmar.isPending}
                            data-testid={`firmar-${o.orderId}`}
                          >
                            {firmar.isPending ? <Loader2 className="w-3.5 h-3.5 mr-1 animate-spin" /> : <PenLine className="w-3.5 h-3.5 mr-1" />}
                            Firmar informe
                          </Button>
                        )}
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
