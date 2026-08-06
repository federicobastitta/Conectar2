import { useEffect, useMemo, useState } from "react";
import { useListReportes, useGetReporte } from "@workspace/api-client-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { BarChart3, ChevronRight, ArrowLeft, Download, ArrowUp, ArrowDown, ArrowUpDown } from "lucide-react";
import { format, subDays } from "date-fns";

function exportarCsv(titulo: string, columnas: string[], filas: string[][]) {
  const esc = (v: string) => `"${v.replaceAll('"', '""')}"`;
  const csv = [columnas.map(esc).join(";"), ...filas.map((f) => f.map(esc).join(";"))].join("\n");
  const blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `${titulo.replaceAll(" ", "_").toLowerCase()}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
}

// Lee un parámetro de la URL (query string) al cargar la página.
function paramUrl(nombre: string): string | null {
  return new URLSearchParams(window.location.search).get(nombre);
}

// Actualiza la URL sin recargar, para poder compartir/recargar el reporte
// con el mismo período y orden.
function actualizarUrl(params: Record<string, string | null>) {
  const sp = new URLSearchParams(window.location.search);
  for (const [k, v] of Object.entries(params)) {
    if (v === null || v === "") sp.delete(k);
    else sp.set(k, v);
  }
  const qs = sp.toString();
  window.history.replaceState(null, "", window.location.pathname + (qs ? `?${qs}` : ""));
}

// ¿La celda es numérica? (para ordenar como número y alinear a la derecha)
function valorNumerico(celda: string): number | null {
  const limpio = celda.replaceAll(".", "").replace(",", ".").replace("%", "").trim();
  if (limpio === "" || limpio === "—" || limpio === "-") return null;
  const n = Number(limpio);
  return Number.isFinite(n) ? n : null;
}

const FECHA_RE = /^\d{4}-\d{2}-\d{2}$/;

function DetalleReporte({ clave, titulo, onVolver }: { clave: string; titulo: string; onVolver: () => void }) {
  const [desde, setDesde] = useState(() => {
    const d = paramUrl("desde");
    return d && FECHA_RE.test(d) ? d : format(subDays(new Date(), 30), "yyyy-MM-dd");
  });
  const [hasta, setHasta] = useState(() => {
    const h = paramUrl("hasta");
    return h && FECHA_RE.test(h) ? h : format(new Date(), "yyyy-MM-dd");
  });
  // Orden elegido: índice de columna y dirección. Se guarda en la URL como
  // "orden=2.asc" para que al recargar/compartir se conserve.
  const [orden, setOrden] = useState<{ col: number; dir: "asc" | "desc" } | null>(() => {
    const o = paramUrl("orden");
    const m = o?.match(/^(\d+)\.(asc|desc)$/);
    return m ? { col: Number(m[1]), dir: m[2] as "asc" | "desc" } : null;
  });
  const { data, isLoading, isError } = useGetReporte({ clave, desde, hasta });

  useEffect(() => {
    actualizarUrl({ reporte: clave, desde, hasta, orden: orden ? `${orden.col}.${orden.dir}` : null });
  }, [clave, desde, hasta, orden]);

  const filasOrdenadas = useMemo(() => {
    if (!data || !orden || orden.col >= data.columnas.length) return data?.filas ?? [];
    const mult = orden.dir === "asc" ? 1 : -1;
    return [...data.filas].sort((a, b) => {
      const va = a[orden.col] ?? "";
      const vb = b[orden.col] ?? "";
      const na = valorNumerico(va);
      const nb = valorNumerico(vb);
      if (na !== null && nb !== null) return (na - nb) * mult;
      if (na !== null) return -1 * mult; // números antes que texto/—
      if (nb !== null) return 1 * mult;
      return va.localeCompare(vb, "es", { sensitivity: "base" }) * mult;
    });
  }, [data, orden]);

  const clicOrden = (col: number) => {
    setOrden((o) => (o?.col !== col ? { col, dir: "asc" } : o.dir === "asc" ? { col, dir: "desc" } : null));
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <Button variant="ghost" size="sm" onClick={onVolver} data-testid="button-volver-reportes">
          <ArrowLeft className="h-4 w-4 mr-1" /> Volver
        </Button>
        <h2 className="text-lg font-semibold flex-1 min-w-48">{titulo}</h2>
        <div className="flex items-center gap-2">
          <Input type="date" value={desde} onChange={(e) => setDesde(e.target.value)} className="w-40" data-testid="input-desde" />
          <span className="text-muted-foreground text-sm">a</span>
          <Input type="date" value={hasta} onChange={(e) => setHasta(e.target.value)} className="w-40" data-testid="input-hasta" />
          <Button
            variant="outline"
            size="sm"
            disabled={!data || data.filas.length === 0}
            onClick={() => data && exportarCsv(data.titulo, data.columnas, filasOrdenadas)}
            data-testid="button-exportar-csv"
          >
            <Download className="h-4 w-4 mr-1" /> CSV
          </Button>
        </div>
      </div>

      <Card>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="p-6 space-y-2">
              <Skeleton className="h-6 w-full" />
              <Skeleton className="h-6 w-full" />
              <Skeleton className="h-6 w-2/3" />
            </div>
          ) : isError ? (
            <p className="p-6 text-sm text-destructive">No se pudo cargar el reporte.</p>
          ) : !data || data.filas.length === 0 ? (
            <p className="p-6 text-sm text-muted-foreground">Sin datos en el período seleccionado.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  {data.columnas.map((c, i) => (
                    <TableHead key={c} className="p-0">
                      <button
                        type="button"
                        onClick={() => clicOrden(i)}
                        className="flex w-full items-center gap-1 px-4 py-3 text-left font-medium hover:bg-accent transition-colors"
                        title="Ordenar por esta columna"
                        data-testid={`ordenar-col-${i}`}
                      >
                        <span>{c}</span>
                        {orden?.col === i ? (
                          orden.dir === "asc" ? (
                            <ArrowUp className="h-3.5 w-3.5 shrink-0" />
                          ) : (
                            <ArrowDown className="h-3.5 w-3.5 shrink-0" />
                          )
                        ) : (
                          <ArrowUpDown className="h-3.5 w-3.5 shrink-0 opacity-30" />
                        )}
                      </button>
                    </TableHead>
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                {filasOrdenadas.map((fila, i) => (
                  <TableRow key={i} data-testid={`row-reporte-${i}`}>
                    {fila.map((celda, j) => (
                      <TableCell key={j} className={j > 0 && /^[\d.,%—-]+$/.test(celda) ? "text-right tabular-nums" : ""}>
                        {celda}
                      </TableCell>
                    ))}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
      {data && data.filas.length > 0 && (
        <p className="text-xs text-muted-foreground">
          {data.filas.length} filas · período {data.desde} a {data.hasta}
          {orden && ` · ordenado por ${data.columnas[orden.col] ?? ""} (${orden.dir === "asc" ? "ascendente" : "descendente"})`}
        </p>
      )}
    </div>
  );
}

export default function ReportesEstadisticos() {
  const { data: reportes, isLoading } = useListReportes();
  const [claveSel, setClaveSel] = useState<string | null>(() => paramUrl("reporte"));

  const seleccionado = useMemo(
    () => (claveSel ? (reportes?.find((r) => r.clave === claveSel) ?? null) : null),
    [claveSel, reportes],
  );

  const volver = () => {
    setClaveSel(null);
    actualizarUrl({ reporte: null, desde: null, hasta: null, orden: null });
  };

  if (seleccionado) {
    return (
      <div className="p-6">
        <DetalleReporte clave={seleccionado.clave} titulo={seleccionado.titulo} onVolver={volver} />
      </div>
    );
  }

  return (
    <div className="p-6 space-y-4">
      <div>
        <h1 className="text-2xl font-bold">Reportes estadísticos</h1>
        <p className="text-sm text-muted-foreground">Elegí un reporte y consultalo entre fechas. Exportable a CSV.</p>
      </div>
      {isLoading ? (
        <div className="space-y-2">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </div>
      ) : (
        <div className="space-y-2">
          {reportes?.map((r) => (
            <button
              key={r.clave}
              onClick={() => setClaveSel(r.clave)}
              className="w-full flex items-center gap-3 rounded-md border bg-card px-4 py-3 text-left text-sm hover:bg-accent transition-colors"
              data-testid={`button-reporte-${r.clave}`}
            >
              <BarChart3 className="h-4 w-4 text-emerald-500 shrink-0" />
              <span className="flex-1">{r.titulo}</span>
              <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
