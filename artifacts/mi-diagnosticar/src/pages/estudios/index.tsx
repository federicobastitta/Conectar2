import { useMemo, useState } from "react";
import { Link } from "wouter";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { PageHeader } from "@/components/layout/page-header";
import { Search, FlaskConical, MonitorPlay, ChevronRight, AlertTriangle, RefreshCw, Loader2 } from "lucide-react";
import {
  usePacsOrdenes,
  ETIQUETAS_ESTADO,
  COLORES_ESTADO,
  ESTADOS_OPERATIVOS,
  MODALIDADES,
  type EstadoOperativo,
  type PacsOrden,
} from "@/api/pacs-workspace";

function fmtFecha(iso: string | null | undefined): string {
  if (!iso) return "—";
  // scheduledAt es ISO full; createdAt también. Mostrar solo la parte de fecha.
  return iso.substring(0, 10);
}

function fmtHora(iso: string | null | undefined): string {
  if (!iso) return "—";
  return iso.substring(11, 16) + " hs";
}

export default function EstudiosWorkspaceLista() {
  const { data: ordenes, isLoading, error, refetch, pacsIndisponible } = usePacsOrdenes();

  const [busqueda, setBusqueda] = useState("");
  const [estadoFiltro, setEstadoFiltro] = useState<EstadoOperativo | null>(null);
  const [modalidadFiltro, setModalidadFiltro] = useState<string | null>(null);

  const filtrados = useMemo<PacsOrden[]>(() => {
    if (!ordenes) return [];
    const q = busqueda.trim().toLowerCase();
    return ordenes.filter((e) => {
      if (estadoFiltro && e.estadoOperativo !== estadoFiltro) return false;
      if (modalidadFiltro && e.modality !== modalidadFiltro) return false;
      if (!q) return true;
      const apellido = e.paciente?.apellido ?? "";
      const nombre = e.paciente?.nombre ?? "";
      const dni = (e.paciente?.dni ?? "").replace(/\./g, "");
      return (
        `${apellido} ${nombre}`.toLowerCase().includes(q) ||
        dni.includes(q.replace(/\./g, "")) ||
        e.studyName.toLowerCase().includes(q) ||
        (e.accessionNumber ?? "").toLowerCase().includes(q)
      );
    });
  }, [ordenes, busqueda, estadoFiltro, modalidadFiltro]);

  const conteoPorEstado = useMemo(() => {
    const c = {} as Record<EstadoOperativo, number>;
    ESTADOS_OPERATIVOS.forEach((s) => (c[s] = 0));
    (ordenes ?? []).forEach((e) => {
      const est = e.estadoOperativo as EstadoOperativo;
      if (est in c) c[est] += 1;
    });
    return c;
  }, [ordenes]);

  return (
    <div className="space-y-4">
      <PageHeader
        title="Estudios — Workspace de informes"
        breadcrumb={[{ label: "Inicio", href: "/" }, { label: "Estudios" }]}
      />

      {/* ── Estado del módulo ── */}
      {pacsIndisponible && (
        <div className="flex items-start gap-2 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          <FlaskConical className="mt-0.5 h-4 w-4 shrink-0" />
          <div>
            <span className="font-semibold">Módulo PACS desactivado.</span>{" "}
            El workspace de informes requiere que el administrador active la integración DiagnosticPACS.
            Contactá al área técnica.
          </div>
        </div>
      )}
      {!pacsIndisponible && error && (
        <div className="flex items-center gap-3 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          <span className="flex-1">Error al cargar las órdenes: {(error as Error).message}</span>
          <Button size="sm" variant="outline" onClick={() => void refetch()}>
            <RefreshCw className="mr-1.5 h-4 w-4" /> Reintentar
          </Button>
        </div>
      )}

      {/* ── Filtros ── */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative w-full max-w-xs">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Paciente, DNI, práctica o accession…"
            className="pl-8"
            value={busqueda}
            onChange={(e) => setBusqueda(e.target.value)}
            disabled={!!pacsIndisponible || !!error}
          />
        </div>
        <div className="flex flex-wrap gap-1.5">
          {ESTADOS_OPERATIVOS.map((s) => (
            <button
              key={s}
              onClick={() => setEstadoFiltro(estadoFiltro === s ? null : s)}
              disabled={!!pacsIndisponible || !!error}
              className={`rounded-full border px-3 py-1 text-xs font-medium transition disabled:opacity-40 ${
                estadoFiltro === s
                  ? "border-primary bg-primary text-primary-foreground"
                  : COLORES_ESTADO[s]
              }`}
            >
              {ETIQUETAS_ESTADO[s]} ({conteoPorEstado[s]})
            </button>
          ))}
        </div>
        <div className="flex gap-1">
          {MODALIDADES.map((m) => (
            <button
              key={m}
              onClick={() => setModalidadFiltro(modalidadFiltro === m ? null : m)}
              disabled={!!pacsIndisponible || !!error}
              className={`rounded border px-2 py-1 text-xs font-mono transition disabled:opacity-40 ${
                modalidadFiltro === m
                  ? "border-primary bg-primary text-primary-foreground"
                  : "border-border bg-background text-muted-foreground hover:bg-muted"
              }`}
            >
              {m}
            </button>
          ))}
        </div>
      </div>

      {/* ── Lista de órdenes ── */}
      <Card>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="flex items-center justify-center gap-2 px-6 py-12 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              Cargando órdenes…
            </div>
          ) : pacsIndisponible || error ? (
            <div className="px-6 py-12 text-center text-sm text-muted-foreground">
              {pacsIndisponible
                ? "El módulo PACS no está disponible en este momento."
                : "No se pudieron cargar las órdenes."}
            </div>
          ) : filtrados.length === 0 ? (
            <div className="px-6 py-12 text-center text-sm text-muted-foreground">
              {(ordenes?.length ?? 0) === 0
                ? "No hay órdenes de estudio en el sistema."
                : "No hay estudios que coincidan con los filtros."}
            </div>
          ) : (
            <ul className="divide-y">
              {filtrados.map((e) => (
                <li key={e.id}>
                  <Link
                    href={`/estudios/${e.id}/workspace`}
                    className="flex items-center gap-4 px-4 py-3 transition hover:bg-muted/50"
                  >
                    <span className="w-14 shrink-0 text-center">
                      <Badge variant="outline" className="font-mono">
                        {e.modality ?? "—"}
                      </Badge>
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium">
                        {e.paciente ? (
                          <>
                            {e.paciente.apellido}, {e.paciente.nombre}{" "}
                            <span className="font-normal text-muted-foreground">
                              · DNI {e.paciente.dni ?? "—"} · {e.paciente.cobertura ?? "Sin cobertura"}
                            </span>
                          </>
                        ) : (
                          <span className="text-muted-foreground">Paciente no asignado</span>
                        )}
                      </span>
                      <span className="block truncate text-sm text-muted-foreground">
                        {e.studyName}{e.motivoEstudio ? ` — ${e.motivoEstudio}` : ""}
                      </span>
                    </span>
                    <span className="hidden shrink-0 text-right text-xs text-muted-foreground sm:block">
                      {e.accessionNumber && (
                        <span className="block font-mono">{e.accessionNumber}</span>
                      )}
                      <span className="block">
                        {e.scheduledAt ? fmtFecha(e.scheduledAt) + " · " + fmtHora(e.scheduledAt) : fmtFecha(e.createdAt)}
                      </span>
                    </span>
                    <span className={`shrink-0 rounded-full border px-2.5 py-0.5 text-xs font-medium ${COLORES_ESTADO[e.estadoOperativo]}`}>
                      {ETIQUETAS_ESTADO[e.estadoOperativo]}
                    </span>
                    <Button variant="ghost" size="icon" className="shrink-0" tabIndex={-1}>
                      {e.estadoOperativo === "PENDIENTE_DE_INFORME" ? (
                        <MonitorPlay className="h-4 w-4 text-primary" />
                      ) : (
                        <ChevronRight className="h-4 w-4" />
                      )}
                    </Button>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
