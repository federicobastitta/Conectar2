import { useRef, useState } from "react";
import {
  useListNomencladorPracticas,
  getListNomencladorPracticasQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";

import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Loader2, Search, Upload, List } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

const pesos = (n: number) =>
  n.toLocaleString("es-AR", { style: "currency", currency: "ARS", minimumFractionDigits: 2 });

function authHeaders(): Record<string, string> {
  const token = typeof window !== "undefined" ? localStorage.getItem("auth_token") : null;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export function NomencladorDialog({
  obraSocialId,
  obraSocialNombre,
  open,
  onOpenChange,
}: {
  obraSocialId: number;
  obraSocialNombre: string;
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [buscar, setBuscar] = useState("");
  const [subiendo, setSubiendo] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const { data, isLoading } = useListNomencladorPracticas(
    { obraSocialId, buscar: buscar.trim() || undefined, limite: 100 },
    { query: { enabled: open } },
  );
  const practicas = data?.practicas ?? [];
  const total = data?.total ?? 0;

  const subirArchivo = async (file: File) => {
    setSubiendo(true);
    try {
      const fd = new FormData();
      fd.append("archivo", file);
      const r = await fetch(`/api/obras-sociales/${obraSocialId}/nomenclador/importar`, {
        method: "POST",
        credentials: "include",
        headers: authHeaders(),
        body: fd,
      });
      const j = (await r.json().catch(() => ({}))) as { importadas?: number; error?: string };
      if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
      toast({
        title: "Nomenclador importado",
        description: `${j.importadas} prácticas cargadas para ${obraSocialNombre}`,
      });
      queryClient.invalidateQueries({ queryKey: getListNomencladorPracticasQueryKey() });
    } catch (e) {
      toast({
        title: "No se pudo importar",
        description: e instanceof Error ? e.message : undefined,
        variant: "destructive",
      });
    } finally {
      setSubiendo(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>Nomenclador — {obraSocialNombre}</DialogTitle>
        </DialogHeader>
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative flex-1 min-w-56">
            <Search className="absolute left-2.5 top-2.5 w-4 h-4 text-muted-foreground" />
            <Input
              className="pl-8"
              placeholder="Buscar por código o descripción…"
              value={buscar}
              onChange={(e) => setBuscar(e.target.value)}
              data-testid="nomenclador-buscar"
            />
          </div>
          <input
            ref={fileRef}
            type="file"
            accept=".xls,.xlsx"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void subirArchivo(f);
            }}
          />
          <Button
            variant="outline"
            onClick={() => fileRef.current?.click()}
            disabled={subiendo}
            data-testid="nomenclador-subir"
          >
            {subiendo ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Upload className="w-4 h-4 mr-2" />}
            Subir Excel
          </Button>
        </div>
        <div className="border rounded-md overflow-hidden">
          <div className="max-h-96 overflow-auto">
            <Table>
              <TableHeader>
                <TableRow className="bg-slate-800 hover:bg-slate-800">
                  <TableHead className="text-slate-100 text-xs font-semibold uppercase w-28">Código</TableHead>
                  <TableHead className="text-slate-100 text-xs font-semibold uppercase">Práctica</TableHead>
                  <TableHead className="text-slate-100 text-xs font-semibold uppercase text-right w-32">Valor</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {isLoading ? (
                  <TableRow>
                    <TableCell colSpan={3} className="h-20 text-center text-muted-foreground">
                      <Loader2 className="w-4 h-4 animate-spin inline" />
                    </TableCell>
                  </TableRow>
                ) : practicas.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={3} className="h-20 text-center text-muted-foreground">
                      {total === 0 && !buscar
                        ? "Esta obra social no tiene nomenclador cargado. Subí un Excel para importarlo."
                        : "Sin resultados."}
                    </TableCell>
                  </TableRow>
                ) : (
                  practicas.map((p, i) => (
                    <TableRow key={p.id} className={i % 2 === 1 ? "bg-primary/5" : undefined}>
                      <TableCell className="text-sm font-mono">{p.codigo}</TableCell>
                      <TableCell className="text-sm">{p.descripcion}</TableCell>
                      <TableCell className="text-right font-medium tabular-nums">{pesos(p.valorTotal)}</TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>
          <div className="border-t bg-muted/40 px-3 py-2 text-xs text-muted-foreground flex items-center gap-1.5">
            <List className="w-3.5 h-3.5" />
            {total} {total === 1 ? "práctica" : "prácticas"}
            {practicas.length < total ? ` (mostrando ${practicas.length})` : ""}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
