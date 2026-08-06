import { useMemo, useState } from "react";
import {
  useListDicomPacsEstudios,
  type DicomPacsEstudio,
} from "@workspace/api-client-react";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Search, Eye, Filter, RefreshCw, ExternalLink } from "lucide-react";
import { PageHeader } from "@/components/layout/page-header";

// Estados de DiagnostiPACS → etiqueta y color.
const ESTADO_META: Record<string, { label: string; clase: string }> = {
  pending: { label: "Pendiente", clase: "bg-amber-100 text-amber-700" },
  processing: { label: "Procesando", clase: "bg-sky-100 text-sky-700" },
  analyzed: { label: "Analizado", clase: "bg-violet-100 text-violet-700" },
  signed: { label: "Informado", clase: "bg-emerald-100 text-emerald-700" },
  final: { label: "Informado", clase: "bg-emerald-100 text-emerald-700" },
};

const MODALIDAD_LABELS: Record<string, string> = {
  US: "Ecografía",
  DX: "Radiografía",
  CR: "Radiografía",
  CT: "Tomografía",
  MR: "Resonancia",
  MG: "Mamografía",
  NM: "Medicina Nuclear",
  OT: "Otro",
};

function normalizar(s: string): string {
  return s.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

function fechaLegible(e: DicomPacsEstudio): string {
  const f = e.studyDate ?? e.createdAt;
  if (!f) return "—";
  const d = new Date(f.includes("T") ? f : `${f}T00:00:00`);
  return Number.isNaN(d.getTime()) ? f : d.toLocaleDateString("es-AR");
}

export default function Informes() {
  const [busqueda, setBusqueda] = useState("");
  const [modalidadFiltro, setModalidadFiltro] = useState("todas");
  const [estadoFiltro, setEstadoFiltro] = useState("todos");

  const { data, isLoading, isError, refetch, isFetching } = useListDicomPacsEstudios({
    query: { refetchInterval: 60000 },
  });

  const estudios = useMemo(() => {
    const lista = data?.estudios ?? [];
    return [...lista].sort((a, b) =>
      (b.studyDate ?? b.createdAt ?? "").localeCompare(a.studyDate ?? a.createdAt ?? ""),
    );
  }, [data]);

  const modalidades = useMemo(
    () => [...new Set(estudios.map((e) => e.modality).filter(Boolean))] as string[],
    [estudios],
  );

  const esInformado = (e: DicomPacsEstudio) =>
    e.status === "signed" || e.status === "final" || Boolean(e.impression);

  const filtrados = useMemo(() => {
    const q = normalizar(busqueda.trim());
    return estudios.filter((e) => {
      if (modalidadFiltro !== "todas" && e.modality !== modalidadFiltro) return false;
      if (estadoFiltro === "informados" && !esInformado(e)) return false;
      if (estadoFiltro === "pendientes" && esInformado(e)) return false;
      if (!q) return true;
      return [e.patientName, e.patientDni, e.modality, e.impression].some(
        (c) => c && normalizar(String(c)).includes(q),
      );
    });
  }, [estudios, busqueda, modalidadFiltro, estadoFiltro]);

  const informados = estudios.filter(esInformado).length;

  return (
    <>
      <PageHeader 
        title="Informes Médicos"
        breadcrumb={[{ label: "Inicio", href: "/" }, { label: "Informes Médicos" }]}
        action={
          <Button
            variant="secondary"
            onClick={() => refetch()}
            disabled={isFetching}
            data-testid="boton-actualizar-informes"
            className="bg-white/20 hover:bg-white/30 text-white border-0"
          >
            <RefreshCw className={`w-4 h-4 mr-2 ${isFetching ? "animate-spin" : ""}`} />
            Actualizar
          </Button>
        }
      />
      <div className="p-6 space-y-6">
        <div className="grid gap-4 md:grid-cols-3">
          <Card>
            <CardContent className="pt-6">
              <div className="text-2xl font-bold text-emerald-600">{informados}</div>
              <p className="text-sm text-muted-foreground mt-1">Informados</p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-6">
              <div className="text-2xl font-bold text-amber-600">{estudios.length - informados}</div>
              <p className="text-sm text-muted-foreground mt-1">Pendientes de informe</p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-6">
              <div className="text-2xl font-bold">{estudios.length}</div>
              <p className="text-sm text-muted-foreground mt-1">Total de estudios</p>
            </CardContent>
          </Card>
        </div>

        <Card>
          <CardHeader>
            <div className="flex flex-col sm:flex-row gap-3">
              <div className="relative flex-1">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input
                  placeholder="Buscar por paciente, DNI o texto del informe..."
                  className="pl-9"
                  value={busqueda}
                  onChange={(e) => setBusqueda(e.target.value)}
                  data-testid="input-busqueda-informes"
                />
              </div>
              <Select value={modalidadFiltro} onValueChange={setModalidadFiltro}>
                <SelectTrigger className="w-[200px]" data-testid="select-modalidad">
                  <Filter className="w-4 h-4 mr-2 text-muted-foreground" />
                  <SelectValue placeholder="Modalidad" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="todas">Todas las modalidades</SelectItem>
                  {modalidades.map((m) => (
                    <SelectItem key={m} value={m}>
                      {MODALIDAD_LABELS[m] ?? m}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select value={estadoFiltro} onValueChange={setEstadoFiltro}>
                <SelectTrigger className="w-[170px]" data-testid="select-estado-informe">
                  <SelectValue placeholder="Estado" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="todos">Todos</SelectItem>
                  <SelectItem value="informados">Informados</SelectItem>
                  <SelectItem value="pendientes">Pendientes</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <div className="space-y-2">
                {[...Array(6)].map((_, i) => (
                  <Skeleton key={i} className="h-12 rounded" />
                ))}
              </div>
            ) : isError ? (
              <div className="py-12 text-center text-muted-foreground">
                No se pudo consultar DiagnostiPACS. Probá de nuevo con "Actualizar".
              </div>
            ) : data && !data.configurado ? (
              <div className="py-12 text-center text-muted-foreground">
                La integración con DiagnostiPACS no está configurada.
              </div>
            ) : filtrados.length === 0 ? (
              <div className="py-12 text-center text-muted-foreground">
                {estudios.length === 0
                  ? "Todavía no hay estudios en DiagnostiPACS."
                  : "No se encontraron estudios que coincidan con los filtros."}
              </div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Paciente</TableHead>
                    <TableHead>Modalidad</TableHead>
                    <TableHead className="hidden md:table-cell">Informe</TableHead>
                    <TableHead>Fecha</TableHead>
                    <TableHead>Estado</TableHead>
                    <TableHead className="text-right">Acciones</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filtrados.map((e) => {
                    const meta = e.status ? ESTADO_META[e.status] : undefined;
                    return (
                      <TableRow key={e.id} data-testid={`fila-informe-${e.id}`}>
                        <TableCell>
                          <div className="font-medium">{e.patientName ?? "Sin nombre"}</div>
                          <div className="text-xs text-muted-foreground">
                            {e.patientDni ? `DNI ${e.patientDni}` : ""}
                          </div>
                        </TableCell>
                        <TableCell>
                          <span className="text-xs font-medium px-2 py-0.5 rounded-full bg-purple-100 text-purple-700">
                            {e.modality ? (MODALIDAD_LABELS[e.modality] ?? e.modality) : "—"}
                          </span>
                        </TableCell>
                        <TableCell className="hidden md:table-cell text-sm text-muted-foreground max-w-[320px] truncate">
                          {e.impression ?? "Sin informe todavía"}
                        </TableCell>
                        <TableCell className="text-sm whitespace-nowrap">{fechaLegible(e)}</TableCell>
                        <TableCell>
                          <span
                            className={`text-xs font-medium px-2 py-0.5 rounded-full ${
                              meta?.clase ??
                              (esInformado(e)
                                ? "bg-emerald-100 text-emerald-700"
                                : "bg-amber-100 text-amber-700")
                            }`}
                          >
                            {meta?.label ?? (esInformado(e) ? "Informado" : "Pendiente")}
                          </span>
                        </TableCell>
                        <TableCell className="text-right">
                          <div className="flex items-center justify-end gap-1">
                            {e.viewerUrl ? (
                              <Button
                                variant="ghost"
                                size="icon"
                                className="h-8 w-8"
                                title="Abrir en DiagnostiPACS"
                                asChild
                                data-testid={`boton-ver-informe-${e.id}`}
                              >
                                <a href={e.viewerUrl} target="_blank" rel="noopener noreferrer">
                                  <ExternalLink className="h-4 w-4" />
                                </a>
                              </Button>
                            ) : (
                              <Button variant="ghost" size="icon" className="h-8 w-8" disabled title="Sin visor">
                                <Eye className="h-4 w-4" />
                              </Button>
                            )}
                          </div>
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
    </>
  );
}
