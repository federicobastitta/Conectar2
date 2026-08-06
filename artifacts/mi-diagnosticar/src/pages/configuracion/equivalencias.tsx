import { useState } from "react";
import {
  useListObrasSociales,
  useListEquivalencias,
  useCreateEquivalencia,
  useUpdateEquivalencia,
  useDeleteEquivalencia,
  useListNomencladorPracticas,
  getListEquivalenciasQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { ArrowLeftRight, Plus, Pencil, Trash2, Loader2, Search } from "lucide-react";

const pesos = (v: number | null | undefined) =>
  v == null
    ? "—"
    : v.toLocaleString("es-AR", { style: "currency", currency: "ARS", minimumFractionDigits: 2 });

type EquivalenciaRow = {
  id: number;
  codigo: string;
  descripcion?: string | null;
  cobroObraSocial?: number | null;
  pagoTipo: string;
  pagoValor: number;
  valorNomenclador?: number | null;
  cobroEfectivo?: number | null;
  pagoCalculado?: number | null;
};

export default function EquivalenciasPage() {
  const { data: obras } = useListObrasSociales();
  const [obraSocialId, setObraSocialId] = useState<number | null>(null);
  const [buscar, setBuscar] = useState("");
  const [dialogo, setDialogo] = useState<{ modo: "crear" } | { modo: "editar"; fila: EquivalenciaRow } | null>(null);
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const { data, isLoading } = useListEquivalencias(
    { obraSocialId: obraSocialId ?? 0, buscar: buscar || undefined, limite: 200 },
    { query: { enabled: obraSocialId != null } },
  );
  const deleteMutation = useDeleteEquivalencia();

  const invalidar = () =>
    queryClient.invalidateQueries({ queryKey: getListEquivalenciasQueryKey() });

  const eliminar = (fila: EquivalenciaRow) => {
    if (!window.confirm(`¿Eliminar la equivalencia del código ${fila.codigo}?`)) return;
    deleteMutation.mutate(
      { id: fila.id },
      {
        onSuccess: () => {
          invalidar();
          toast({ title: "Equivalencia eliminada" });
        },
        onError: () => toast({ title: "No se pudo eliminar", variant: "destructive" }),
      },
    );
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight flex items-center gap-2">
          <ArrowLeftRight className="w-7 h-7 text-primary" /> Equivalencias
        </h1>
        <p className="text-muted-foreground">
          Por cada código: cuánto nos paga la obra social y cuánto le pagamos al profesional
        </p>
      </div>

      <Card>
        <CardHeader className="flex flex-col sm:flex-row sm:items-center gap-4 justify-between pb-4">
          <div>
            <CardTitle>Valores por obra social</CardTitle>
            <CardDescription>
              Si no cargás un cobro propio, se usa el valor del nomenclador de la obra social.
            </CardDescription>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Select
              value={obraSocialId != null ? String(obraSocialId) : ""}
              onValueChange={(v) => setObraSocialId(Number(v))}
            >
              <SelectTrigger className="w-56" data-testid="select-obra-social">
                <SelectValue placeholder="Elegí una obra social" />
              </SelectTrigger>
              <SelectContent>
                {(obras ?? []).map((o) => (
                  <SelectItem key={o.id} value={String(o.id)}>
                    {o.nombre}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <div className="relative">
              <Search className="w-4 h-4 absolute left-2.5 top-2.5 text-muted-foreground" />
              <Input
                className="pl-8 w-52"
                placeholder="Buscar código o práctica…"
                value={buscar}
                onChange={(e) => setBuscar(e.target.value)}
                disabled={obraSocialId == null}
              />
            </div>
            <Button
              onClick={() => setDialogo({ modo: "crear" })}
              disabled={obraSocialId == null}
              data-testid="nueva-equivalencia"
            >
              <Plus className="w-4 h-4 mr-1" /> Nueva
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {obraSocialId == null ? (
            <p className="text-sm text-muted-foreground py-8 text-center">
              Elegí una obra social para ver o cargar sus equivalencias.
            </p>
          ) : isLoading ? (
            <div className="flex justify-center py-8">
              <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
            </div>
          ) : (data?.equivalencias?.length ?? 0) === 0 ? (
            <p className="text-sm text-muted-foreground py-8 text-center">
              Todavía no hay equivalencias cargadas para esta obra social.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Código</TableHead>
                  <TableHead>Práctica</TableHead>
                  <TableHead className="text-right">Nomenclador</TableHead>
                  <TableHead className="text-right">Cobro OS</TableHead>
                  <TableHead className="text-right">Pago profesional</TableHead>
                  <TableHead className="text-right">Pago calculado</TableHead>
                  <TableHead className="w-24"></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data!.equivalencias.map((f) => (
                  <TableRow key={f.id}>
                    <TableCell className="font-mono font-medium">{f.codigo}</TableCell>
                    <TableCell className="max-w-[280px] truncate">{f.descripcion || "—"}</TableCell>
                    <TableCell className="text-right text-muted-foreground">
                      {pesos(f.valorNomenclador)}
                    </TableCell>
                    <TableCell className="text-right font-medium">
                      {f.cobroObraSocial != null ? (
                        pesos(f.cobroObraSocial)
                      ) : (
                        <span className="text-muted-foreground" title="Usa el valor del nomenclador">
                          {pesos(f.cobroEfectivo)}
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="text-right">
                      {f.pagoTipo === "porcentaje" ? (
                        <Badge variant="secondary">{f.pagoValor}%</Badge>
                      ) : (
                        pesos(f.pagoValor)
                      )}
                    </TableCell>
                    <TableCell className="text-right font-medium">{pesos(f.pagoCalculado)}</TableCell>
                    <TableCell>
                      <div className="flex justify-end gap-1">
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => setDialogo({ modo: "editar", fila: f })}
                          data-testid={`editar-${f.codigo}`}
                        >
                          <Pencil className="w-4 h-4" />
                        </Button>
                        <Button variant="ghost" size="icon" onClick={() => eliminar(f)}>
                          <Trash2 className="w-4 h-4 text-destructive" />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
          {data && data.total > (data.equivalencias?.length ?? 0) && (
            <p className="text-xs text-muted-foreground mt-2">
              Mostrando {data.equivalencias.length} de {data.total}. Refiná la búsqueda para ver el resto.
            </p>
          )}
        </CardContent>
      </Card>

      {dialogo && obraSocialId != null && (
        <EquivalenciaDialog
          obraSocialId={obraSocialId}
          fila={dialogo.modo === "editar" ? dialogo.fila : null}
          onClose={() => setDialogo(null)}
          onSaved={() => {
            setDialogo(null);
            invalidar();
          }}
        />
      )}
    </div>
  );
}

function EquivalenciaDialog({
  obraSocialId,
  fila,
  onClose,
  onSaved,
}: {
  obraSocialId: number;
  fila: EquivalenciaRow | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { toast } = useToast();
  const [codigo, setCodigo] = useState(fila?.codigo ?? "");
  const [descripcion, setDescripcion] = useState(fila?.descripcion ?? "");
  const [cobro, setCobro] = useState(fila?.cobroObraSocial != null ? String(fila.cobroObraSocial) : "");
  const [pagoTipo, setPagoTipo] = useState<"fijo" | "porcentaje">(
    fila?.pagoTipo === "porcentaje" ? "porcentaje" : "fijo",
  );
  const [pagoValor, setPagoValor] = useState(fila != null ? String(fila.pagoValor) : "");
  const [busquedaNom, setBusquedaNom] = useState("");

  const createMutation = useCreateEquivalencia();
  const updateMutation = useUpdateEquivalencia();
  const guardando = createMutation.isPending || updateMutation.isPending;

  const { data: sugerencias } = useListNomencladorPracticas(
    { obraSocialId, buscar: busquedaNom, limite: 8 },
    { query: { enabled: !fila && busquedaNom.length >= 2 } },
  );

  const valorNum = (s: string) => {
    const n = Number(s.replace(",", "."));
    return Number.isFinite(n) ? n : null;
  };

  const guardar = () => {
    const pv = valorNum(pagoValor);
    if (!codigo.trim() || pv == null) {
      toast({ title: "Completá código y valor de pago", variant: "destructive" });
      return;
    }
    if (pagoTipo === "porcentaje" && (pv <= 0 || pv > 100)) {
      toast({ title: "El porcentaje debe estar entre 0 y 100", variant: "destructive" });
      return;
    }
    const cobroNum = cobro.trim() === "" ? null : valorNum(cobro);
    const comun = {
      descripcion: descripcion.trim() || undefined,
      cobroObraSocial: cobroNum ?? undefined,
      pagoTipo,
      pagoValor: pv,
    };
    const opts = {
      onSuccess: () => {
        toast({ title: fila ? "Equivalencia actualizada" : "Equivalencia guardada" });
        onSaved();
      },
      onError: () => toast({ title: "No se pudo guardar", variant: "destructive" }),
    };
    if (fila) {
      updateMutation.mutate(
        {
          id: fila.id,
          data: {
            descripcion: descripcion.trim() || null,
            cobroObraSocial: cobroNum,
            pagoTipo,
            pagoValor: pv,
          },
        },
        opts,
      );
    } else {
      createMutation.mutate({ data: { obraSocialId, codigo: codigo.trim(), ...comun } }, opts);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{fila ? `Editar ${fila.codigo}` : "Nueva equivalencia"}</DialogTitle>
          <DialogDescription>
            Definí cuánto cobra la clínica y cuánto se le paga al profesional por este código.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          {!fila && (
            <div className="space-y-1.5">
              <Label>Código</Label>
              <Input
                value={codigo}
                onChange={(e) => {
                  setCodigo(e.target.value);
                  setBusquedaNom(e.target.value);
                }}
                placeholder="Ej: 420101 (buscá en el nomenclador)"
                data-testid="input-codigo"
              />
              {sugerencias && sugerencias.practicas.length > 0 && (
                <div className="border rounded-md divide-y max-h-44 overflow-auto">
                  {sugerencias.practicas.map((p) => (
                    <button
                      key={p.id}
                      type="button"
                      className="w-full text-left px-3 py-1.5 text-sm hover:bg-accent"
                      onClick={() => {
                        setCodigo(p.codigo);
                        setDescripcion(p.descripcion);
                        setBusquedaNom("");
                      }}
                    >
                      <span className="font-mono mr-2">{p.codigo}</span>
                      <span className="text-muted-foreground">{p.descripcion}</span>
                      <span className="float-right">{pesos(p.valorTotal)}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
          <div className="space-y-1.5">
            <Label>Práctica (descripción)</Label>
            <Input
              value={descripcion}
              onChange={(e) => setDescripcion(e.target.value)}
              placeholder="Nombre de la práctica"
            />
          </div>
          <div className="space-y-1.5">
            <Label>Cobro a la obra social ($)</Label>
            <Input
              value={cobro}
              onChange={(e) => setCobro(e.target.value)}
              placeholder="Vacío = usa el valor del nomenclador"
              inputMode="decimal"
              data-testid="input-cobro"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>Pago al profesional</Label>
              <Select value={pagoTipo} onValueChange={(v) => setPagoTipo(v as "fijo" | "porcentaje")}>
                <SelectTrigger data-testid="select-pago-tipo">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="fijo">Monto fijo ($)</SelectItem>
                  <SelectItem value="porcentaje">Porcentaje (%)</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>{pagoTipo === "porcentaje" ? "Porcentaje (%)" : "Monto ($)"}</Label>
              <Input
                value={pagoValor}
                onChange={(e) => setPagoValor(e.target.value)}
                placeholder={pagoTipo === "porcentaje" ? "Ej: 40" : "Ej: 15000"}
                inputMode="decimal"
                data-testid="input-pago-valor"
              />
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={guardando}>
            Cancelar
          </Button>
          <Button onClick={guardar} disabled={guardando} data-testid="guardar-equivalencia">
            {guardando && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
            Guardar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
