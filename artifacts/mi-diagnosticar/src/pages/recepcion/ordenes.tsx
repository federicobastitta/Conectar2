import { useState } from "react";
import { Link } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import {
  useGetRecepcionOrdenesEstudio,
  getGetRecepcionOrdenesEstudioQueryKey,
  useGetRecepcionOrdenesPendientes,
  getGetRecepcionOrdenesPendientesQueryKey,
  useAsignarTurnoOrdenEstudio,
  type RecepcionOrdenEstudio,
} from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useToast } from "@/hooks/use-toast";
import { Search, FileSearch, FileText, CalendarX2, ClipboardList, ArrowLeft, ChevronDown, ChevronUp } from "lucide-react";
import { Fragment } from "react";
import { format, parseISO } from "date-fns";
import { es } from "date-fns/locale";

const ESTADO_LABEL: Record<string, { label: string; className: string }> = {
  solicitado: { label: "Solicitada", className: "bg-amber-500/15 text-amber-600 dark:text-amber-400" },
  pendiente_programacion: { label: "Pendiente de turno", className: "bg-orange-500/15 text-orange-600 dark:text-orange-400" },
  programado: { label: "Programada", className: "bg-blue-500/15 text-blue-600 dark:text-blue-400" },
};

function fmtFecha(fecha?: string | null) {
  if (!fecha) return "";
  try {
    return format(parseISO(fecha), "EEE d MMM yyyy", { locale: es });
  } catch {
    return fecha;
  }
}

// Abre en otra pestaña el PDF de la orden pedida por el médico (tal como la
// firmó), para que recepción la vea y cargue el turno a mano por el circuito
// normal de agendas. Exportado: también lo usa la consola /ordenes.
export async function abrirPdfOrdenMedico(id: number, onError: (msg: string) => void) {
  try {
    const token = localStorage.getItem("auth_token");
    const r = await fetch(`/api/recepcion/ordenes-estudio/${id}/pdf`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      credentials: "include",
    });
    if (!r.ok) {
      onError("No pudimos abrir la orden. Intentá de nuevo.");
      return;
    }
    const blob = await r.blob();
    const url = URL.createObjectURL(blob);
    window.open(url, "_blank", "noopener");
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  } catch {
    onError("No pudimos abrir la orden. Revisá tu conexión.");
  }
}

export default function OrdenesRecepcion() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [dniInput, setDniInput] = useState("");
  const [dni, setDni] = useState<string | null>(null);
  const [ordenExpandida, setOrdenExpandida] = useState<number | null>(null);

  const { data, isLoading, error } = useGetRecepcionOrdenesEstudio(
    { dni: dni ?? "" },
    { query: { enabled: !!dni, retry: false } },
  );
  // Listado global: todas las órdenes pendientes generadas por los médicos,
  // visible sin necesidad de buscar por DNI.
  const { data: pendientes, isLoading: cargandoPendientes } = useGetRecepcionOrdenesPendientes({
    query: { enabled: !dni, retry: false },
  });
  const desvincular = useAsignarTurnoOrdenEstudio();

  const buscar = () => {
    const limpio = dniInput.trim().replace(/\D/g, "");
    if (limpio.length < 6) {
      toast({ title: "DNI inválido", description: "Ingresá un DNI de al menos 6 dígitos.", variant: "destructive" });
      return;
    }
    setDni(limpio);
  };

  const refrescar = () => {
    if (dni) void queryClient.invalidateQueries({ queryKey: getGetRecepcionOrdenesEstudioQueryKey({ dni }) });
    void queryClient.invalidateQueries({ queryKey: getGetRecepcionOrdenesPendientesQueryKey() });
  };

  const quitarTurno = (orden: RecepcionOrdenEstudio) => {
    desvincular.mutate(
      { id: orden.id, data: { turnoId: null } },
      {
        onSuccess: () => {
          toast({ title: "Turno desvinculado", description: `La orden "${orden.studyName}" volvió a pendiente.` });
          refrescar();
        },
        onError: () => toast({ title: "Error", description: "No se pudo desvincular el turno", variant: "destructive" }),
      },
    );
  };

  return (
    <div className="p-4 md:p-6 max-w-5xl mx-auto space-y-4">
      <div className="flex items-center gap-3">
        <Button asChild variant="ghost" size="icon">
          <Link href="/recepcion"><ArrowLeft className="w-4 h-4" /></Link>
        </Button>
        <div>
          <h1 className="text-xl font-semibold flex items-center gap-2">
            <ClipboardList className="w-5 h-5 text-primary" />
            Órdenes de estudio
          </h1>
          <p className="text-sm text-muted-foreground">Buscá las órdenes pendientes del paciente por DNI y abrí la orden para cargar el turno por agenda.</p>
        </div>
      </div>

      <Card>
        <CardContent className="p-4 flex gap-2">
          <Input
            placeholder="DNI del paciente"
            inputMode="numeric"
            value={dniInput}
            onChange={(e) => setDniInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && buscar()}
            className="max-w-xs"
            data-testid="input-dni-ordenes"
          />
          <Button onClick={buscar} data-testid="button-buscar-ordenes">
            <Search className="w-4 h-4 mr-1.5" />
            Buscar
          </Button>
          {dni && (
            <Button variant="ghost" onClick={() => { setDni(null); setDniInput(""); }} data-testid="button-volver-listado">
              Ver todas las pendientes
            </Button>
          )}
        </CardContent>
      </Card>

      {!dni && cargandoPendientes && <Skeleton className="h-40 w-full" />}

      {!dni && pendientes && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Órdenes pendientes ({pendientes.length})</CardTitle>
          </CardHeader>
          <CardContent>
            {pendientes.length === 0 ? (
              <p className="text-sm text-muted-foreground py-4">No hay órdenes de estudio pendientes.</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Paciente</TableHead>
                    <TableHead>Estudio</TableHead>
                    <TableHead>Derivante</TableHead>
                    <TableHead>Estado</TableHead>
                    <TableHead>Turno</TableHead>
                    <TableHead className="text-right">Acciones</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {pendientes.map((o) => {
                    const est = ESTADO_LABEL[o.status] ?? { label: o.status, className: "" };
                    return (
                      <TableRow key={o.id} data-testid={`row-pendiente-${o.id}`}>
                        <TableCell>
                          <p className="font-medium">{o.paciente.apellido}, {o.paciente.nombre}</p>
                          {o.paciente.dni && <p className="text-xs text-muted-foreground">DNI {o.paciente.dni}</p>}
                        </TableCell>
                        <TableCell>
                          <p className="font-medium">{o.studyName}</p>
                          <p className="text-xs text-muted-foreground capitalize">{fmtFecha(o.createdAt)}</p>
                        </TableCell>
                        <TableCell className="text-sm">{o.derivante ?? "—"}</TableCell>
                        <TableCell><Badge variant="secondary" className={est.className}>{est.label}</Badge></TableCell>
                        <TableCell className="text-sm capitalize">
                          {o.turnoId != null ? `${fmtFecha(o.turnoFecha)} · ${o.turnoHora ?? ""} hs` : "Sin turno"}
                        </TableCell>
                        <TableCell className="text-right whitespace-nowrap">
                          {o.paciente.dni && (
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => { setDniInput(o.paciente.dni ?? ""); setDni(o.paciente.dni ?? null); }}
                              data-testid={`button-ver-paciente-${o.id}`}
                            >
                              <Search className="w-4 h-4 mr-1.5" />
                              Ver paciente
                            </Button>
                          )}
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => void abrirPdfOrdenMedico(o.id, (msg) => toast({ title: "Error", description: msg, variant: "destructive" }))}
                            data-testid={`button-ver-orden-pendiente-${o.id}`}
                          >
                            <FileText className="w-4 h-4 mr-1.5" />
                            Ver orden
                          </Button>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      )}

      {dni && isLoading && <Skeleton className="h-40 w-full" />}

      {dni && error != null && (
        <Card>
          <CardContent className="p-6 text-center text-sm text-muted-foreground">
            <FileSearch className="w-8 h-8 mx-auto mb-2 opacity-50" />
            {(error as { status?: number }).status === 404
              ? `No se encontró un paciente activo con DNI ${dni}.`
              : (error as { status?: number }).status === 403
                ? "No tenés permisos para consultar órdenes de estudio."
                : "No se pudieron cargar las órdenes. Reintentá en unos segundos."}
          </CardContent>
        </Card>
      )}

      {data && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">
              {data.paciente.apellido}, {data.paciente.nombre}
              <span className="text-muted-foreground font-normal text-sm ml-2">DNI {data.paciente.dni}</span>
            </CardTitle>
          </CardHeader>
          <CardContent>
            {data.ordenes.length === 0 ? (
              <p className="text-sm text-muted-foreground py-4">El paciente no tiene órdenes de estudio pendientes.</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Estudio</TableHead>
                    <TableHead>Derivante</TableHead>
                    <TableHead>Estado</TableHead>
                    <TableHead>Turno</TableHead>
                    <TableHead className="text-right">Acciones</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.ordenes.map((o) => {
                    const est = ESTADO_LABEL[o.status] ?? { label: o.status, className: "" };
                    const expandida = ordenExpandida === o.id;
                    return (
                      <Fragment key={o.id}>
                        <TableRow data-testid={`row-orden-${o.id}`}>
                          <TableCell>
                            <p className="font-medium">{o.studyName}</p>
                            {o.contraste && <p className="text-xs text-muted-foreground">Con contraste</p>}
                            {o.preparationRequired && <p className="text-xs text-muted-foreground">Prep.: {o.preparationRequired}</p>}
                          </TableCell>
                          <TableCell className="text-sm">{o.derivante ?? "—"}</TableCell>
                          <TableCell><Badge variant="secondary" className={est.className}>{est.label}</Badge></TableCell>
                          <TableCell className="text-sm capitalize">
                            {o.turnoId != null ? `${fmtFecha(o.turnoFecha)} · ${o.turnoHora ?? ""} hs` : "Sin turno"}
                          </TableCell>
                          <TableCell className="text-right whitespace-nowrap">
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => setOrdenExpandida(expandida ? null : o.id)}
                              data-testid={`button-detalle-${o.id}`}
                            >
                              {expandida ? <ChevronUp className="w-4 h-4 mr-1" /> : <ChevronDown className="w-4 h-4 mr-1" />}
                              Validar
                            </Button>
                            <Button size="sm" variant="outline" onClick={() => void abrirPdfOrdenMedico(o.id, (msg) => toast({ title: "Error", description: msg, variant: "destructive" }))} data-testid={`button-ver-orden-${o.id}`}>
                              <FileText className="w-4 h-4 mr-1.5" />
                              Ver orden
                            </Button>
                            {o.turnoId != null && (
                              <Button size="sm" variant="ghost" onClick={() => quitarTurno(o)} disabled={desvincular.isPending}>
                                <CalendarX2 className="w-4 h-4 mr-1.5" />
                                Quitar turno
                              </Button>
                            )}
                          </TableCell>
                        </TableRow>
                        {expandida && (
                          <TableRow className="bg-muted/30 hover:bg-muted/30">
                            <TableCell colSpan={5} className="py-3">
                              <div className="grid gap-x-8 gap-y-2 sm:grid-cols-2 lg:grid-cols-3 text-sm" data-testid={`detalle-orden-${o.id}`}>
                                <div>
                                  <p className="text-xs text-muted-foreground">Orden N.º</p>
                                  <p className="font-medium">{o.id}</p>
                                </div>
                                <div>
                                  <p className="text-xs text-muted-foreground">Fecha de emisión</p>
                                  <p className="font-medium capitalize">{fmtFecha(o.createdAt)}</p>
                                </div>
                                <div>
                                  <p className="text-xs text-muted-foreground">Prioridad</p>
                                  <p className="font-medium capitalize">{o.priority ?? "Normal"}</p>
                                </div>
                                <div>
                                  <p className="text-xs text-muted-foreground">Tipo de estudio</p>
                                  <p className="font-medium capitalize">{o.studyType ?? "—"}</p>
                                </div>
                                <div>
                                  <p className="text-xs text-muted-foreground">Códigos de facturación (IOMA)</p>
                                  <p className="font-medium">{o.billingCodes ?? "—"}</p>
                                </div>
                                <div>
                                  <p className="text-xs text-muted-foreground">Contraste</p>
                                  <p className="font-medium">{o.contraste ? "Sí" : "No"}</p>
                                </div>
                                <div className="sm:col-span-2 lg:col-span-3">
                                  <p className="text-xs text-muted-foreground">Justificación clínica / diagnóstico</p>
                                  <p className="font-medium">{o.clinicalJustification ?? "—"}</p>
                                </div>
                                {o.preparationRequired && (
                                  <div className="sm:col-span-2 lg:col-span-3">
                                    <p className="text-xs text-muted-foreground">Preparación requerida</p>
                                    <p className="font-medium">{o.preparationRequired}</p>
                                  </div>
                                )}
                              </div>
                            </TableCell>
                          </TableRow>
                        )}
                      </Fragment>
                    );
                  })}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      )}

    </div>
  );
}
