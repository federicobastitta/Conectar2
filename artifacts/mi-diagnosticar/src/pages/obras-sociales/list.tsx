import { useMemo, useState } from "react";
import {
  useListObrasSociales, useCreateObraSocial, useUpdateObraSocial, useDeleteObraSocial,
  getListObrasSocialesQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";

import { Card, CardContent } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Plus, Pencil, Trash2, Loader2, Search, Save, Landmark, List, Info, Eye, EyeOff, BookOpen } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import type { ObraSocial } from "@workspace/api-client-react";
import { NomencladorDialog } from "./nomenclador-dialog";

function normalizar(s: string) {
  return s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

type Tab = "listar" | "inactivas" | "nuevo";

export default function ObrasSocialesPage() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { data: obras, isLoading } = useListObrasSociales();
  const createOs = useCreateObraSocial();
  const updateOs = useUpdateObraSocial();
  const deleteOs = useDeleteObraSocial();

  const [tab, setTab] = useState<Tab>("listar");
  const [busqueda, setBusqueda] = useState("");
  const [nuevo, setNuevo] = useState({ nombre: "", detalle: "", codigo: "" });
  const [editOs, setEditOs] = useState<ObraSocial | null>(null);
  const [editForm, setEditForm] = useState({ nombre: "", detalle: "", codigo: "" });
  const [deleteId, setDeleteId] = useState<number | null>(null);
  const [nomencladorOs, setNomencladorOs] = useState<ObraSocial | null>(null);

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: getListObrasSocialesQueryKey() });

  const filtradas = useMemo(() => {
    const lista = (obras ?? []).filter((o) => (tab === "inactivas" ? !o.activa : o.activa));
    const q = normalizar(busqueda.trim());
    if (!q) return lista;
    return lista.filter((o) =>
      normalizar(`${o.nombre} ${o.detalle ?? ""} ${o.codigo ?? ""}`).includes(q),
    );
  }, [obras, busqueda, tab]);

  const guardarNueva = () => {
    if (!nuevo.nombre.trim()) return;
    createOs.mutate(
      {
        data: {
          nombre: nuevo.nombre.trim(),
          ...(nuevo.detalle.trim() && { detalle: nuevo.detalle.trim() }),
          ...(nuevo.codigo.trim() && { codigo: nuevo.codigo.trim() }),
        },
      },
      {
        onSuccess: () => {
          toast({ title: "Obra social creada", description: nuevo.nombre.trim() });
          setNuevo({ nombre: "", detalle: "", codigo: "" });
          invalidate();
          setTab("listar");
        },
        onError: () => toast({ title: "Error al crear", variant: "destructive" }),
      },
    );
  };

  const abrirEdicion = (o: ObraSocial) => {
    setEditOs(o);
    setEditForm({ nombre: o.nombre, detalle: o.detalle ?? "", codigo: o.codigo ?? "" });
  };

  const guardarEdicion = () => {
    if (!editOs || !editForm.nombre.trim()) return;
    updateOs.mutate(
      { id: editOs.id, data: { nombre: editForm.nombre.trim(), detalle: editForm.detalle.trim(), codigo: editForm.codigo.trim() } },
      {
        onSuccess: () => { toast({ title: "Obra social actualizada" }); invalidate(); setEditOs(null); },
        onError: () => toast({ title: "Error al actualizar", variant: "destructive" }),
      },
    );
  };

  const toggleCampo = (o: ObraSocial, campo: "activa" | "visible") => {
    updateOs.mutate(
      { id: o.id, data: { [campo]: !o[campo] } },
      {
        onSuccess: () => invalidate(),
        onError: () => toast({ title: "Error al actualizar", variant: "destructive" }),
      },
    );
  };

  const confirmDelete = () => {
    if (!deleteId) return;
    deleteOs.mutate({ id: deleteId }, {
      onSuccess: () => { invalidate(); toast({ title: "Obra social eliminada" }); setDeleteId(null); },
      onError: () => toast({ title: "No se pudo eliminar", variant: "destructive" }),
    });
  };

  const tabBtn = (t: Tab, label: string, testid: string) => (
    <button
      onClick={() => setTab(t)}
      className={`px-5 py-2 text-sm font-medium rounded-t-md transition-colors ${
        tab === t ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"
      }`}
      data-testid={testid}
    >
      {label}
    </button>
  );

  return (
    <div className="space-y-4">
      <div className="flex items-end gap-1 border-b">
        {tabBtn("listar", "Listar", "tab-listar")}
        {tabBtn("inactivas", "Inactivas", "tab-inactivas")}
        {tabBtn("nuevo", "Nuevo", "tab-nuevo")}
      </div>

      {tab !== "nuevo" ? (
        <Card className="border-l-4 border-l-primary">
          <CardContent className="pt-5 space-y-4">
            <div className="flex items-start gap-2 rounded-md border border-sky-200 bg-sky-50 dark:bg-sky-950/30 dark:border-sky-900 px-3 py-2 text-sm">
              <Info className="w-4 h-4 mt-0.5 text-sky-600 shrink-0" />
              <span>
                <span className="font-semibold">Importante:</span> los cambios realizados aquí (estado, visibilidad, alta, edición) afectan a <span className="font-semibold">todas las agendas del centro</span>.
              </span>
            </div>
            <div className="relative">
              <Search className="absolute left-2.5 top-2.5 w-4 h-4 text-muted-foreground" />
              <Input
                className="pl-8"
                placeholder="Buscar obra social…"
                value={busqueda}
                onChange={(e) => setBusqueda(e.target.value)}
                data-testid="buscar-obra-social"
              />
            </div>
            <div className="border rounded-md overflow-hidden">
              <Table>
                <TableHeader>
                  <TableRow className="bg-slate-800 hover:bg-slate-800">
                    <TableHead className="text-slate-100 text-xs font-semibold uppercase">Obra Social</TableHead>
                    <TableHead className="text-slate-100 text-xs font-semibold uppercase">Detalle</TableHead>
                    <TableHead className="text-slate-100 text-xs font-semibold uppercase">Código</TableHead>
                    <TableHead className="text-slate-100 text-xs font-semibold uppercase">Estado</TableHead>
                    <TableHead className="text-slate-100 text-xs font-semibold uppercase text-right w-36">Acciones</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {isLoading ? (
                    Array.from({ length: 3 }).map((_, i) => (
                      <TableRow key={i}>
                        {Array.from({ length: 5 }).map((__, j) => (
                          <TableCell key={j}><Skeleton className="h-7 w-full" /></TableCell>
                        ))}
                      </TableRow>
                    ))
                  ) : filtradas.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={5} className="h-24 text-center text-muted-foreground">
                        {busqueda ? "Sin resultados para la búsqueda." : tab === "inactivas" ? "No hay obras sociales inactivas." : "No hay obras sociales configuradas."}
                      </TableCell>
                    </TableRow>
                  ) : (
                    filtradas.map((o, i) => (
                      <TableRow key={o.id} className={i % 2 === 1 ? "bg-primary/5" : undefined}>
                        <TableCell className="font-medium uppercase">{o.nombre}</TableCell>
                        <TableCell className="text-sm text-muted-foreground uppercase">{o.detalle || ""}</TableCell>
                        <TableCell className="text-sm uppercase">{o.codigo || ""}</TableCell>
                        <TableCell>
                          <button onClick={() => toggleCampo(o, "activa")} data-testid={`estado-${o.id}`} title="Cambiar estado">
                            <Badge className={o.activa ? "bg-emerald-500 hover:bg-emerald-600" : "bg-slate-400 hover:bg-slate-500"}>
                              {o.activa ? "ACTIVA" : "INACTIVA"}
                            </Badge>
                          </button>
                        </TableCell>
                        <TableCell className="text-right">
                          <div className="flex justify-end gap-1">
                            <Button
                              variant={o.visible ? "default" : "outline"}
                              size="sm"
                              className="h-7 px-2 text-xs"
                              onClick={() => toggleCampo(o, "visible")}
                              title={o.visible ? "Visible en portal — clic para ocultar" : "Oculta en portal — clic para mostrar"}
                              data-testid={`visible-${o.id}`}
                            >
                              {o.visible ? <Eye className="w-3.5 h-3.5 mr-1" /> : <EyeOff className="w-3.5 h-3.5 mr-1" />}
                              {o.visible ? "VISIBLE" : "OCULTA"}
                            </Button>
                            <Button variant="outline" size="icon" className="h-7 w-7" onClick={() => setNomencladorOs(o)} title="Nomenclador valorizado" data-testid={`nomenclador-${o.id}`}>
                              <BookOpen className="w-3.5 h-3.5" />
                            </Button>
                            <Button variant="outline" size="icon" className="h-7 w-7" onClick={() => abrirEdicion(o)} title="Editar" data-testid={`editar-${o.id}`}>
                              <Pencil className="w-3.5 h-3.5" />
                            </Button>
                            <Button variant="outline" size="icon" className="h-7 w-7 text-destructive hover:text-destructive" onClick={() => setDeleteId(o.id)} title="Eliminar" data-testid={`eliminar-${o.id}`}>
                              <Trash2 className="w-3.5 h-3.5" />
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
              <div className="border-t bg-muted/40 px-3 py-2 text-xs text-muted-foreground flex items-center gap-1.5">
                <List className="w-3.5 h-3.5" />
                {filtradas.length} {filtradas.length === 1 ? "obra social" : "obras sociales"}
              </div>
            </div>
          </CardContent>
        </Card>
      ) : (
        <Card className="border-l-4 border-l-primary">
          <CardContent className="pt-5 space-y-4">
            <div className="flex items-center gap-2 font-semibold">
              <Plus className="w-4 h-4" /> Nueva Obra Social
            </div>
            <div className="flex flex-wrap items-end gap-4">
              <div className="space-y-1.5 w-64">
                <Label className="text-xs uppercase text-muted-foreground">Obra Social</Label>
                <Input
                  placeholder="Ej. IOMA"
                  value={nuevo.nombre}
                  onChange={(e) => setNuevo((f) => ({ ...f, nombre: e.target.value }))}
                  data-testid="nueva-os-nombre"
                />
              </div>
              <div className="space-y-1.5 w-64">
                <Label className="text-xs uppercase text-muted-foreground">Detalle</Label>
                <Input
                  value={nuevo.detalle}
                  onChange={(e) => setNuevo((f) => ({ ...f, detalle: e.target.value }))}
                  data-testid="nueva-os-detalle"
                />
              </div>
              <div className="space-y-1.5 w-40">
                <Label className="text-xs uppercase text-muted-foreground">Código</Label>
                <Input
                  value={nuevo.codigo}
                  onChange={(e) => setNuevo((f) => ({ ...f, codigo: e.target.value }))}
                  data-testid="nueva-os-codigo"
                />
              </div>
              <Button
                onClick={guardarNueva}
                disabled={!nuevo.nombre.trim() || createOs.isPending}
                data-testid="guardar-obra-social"
              >
                {createOs.isPending ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Save className="w-4 h-4 mr-2" />}
                Guardar
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      <Dialog open={!!editOs} onOpenChange={(o) => !o && setEditOs(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Editar Obra Social</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label className="text-xs uppercase text-muted-foreground">Obra Social</Label>
              <Input
                value={editForm.nombre}
                onChange={(e) => setEditForm((f) => ({ ...f, nombre: e.target.value }))}
                data-testid="editar-nombre"
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs uppercase text-muted-foreground">Detalle</Label>
              <Input
                value={editForm.detalle}
                onChange={(e) => setEditForm((f) => ({ ...f, detalle: e.target.value }))}
                data-testid="editar-detalle"
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs uppercase text-muted-foreground">Código</Label>
              <Input
                value={editForm.codigo}
                onChange={(e) => setEditForm((f) => ({ ...f, codigo: e.target.value }))}
                data-testid="editar-codigo"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditOs(null)}>Cancelar</Button>
            <Button onClick={guardarEdicion} disabled={!editForm.nombre.trim() || updateOs.isPending} data-testid="guardar-edicion">
              {updateOs.isPending && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
              Guardar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {nomencladorOs && (
        <NomencladorDialog
          obraSocialId={nomencladorOs.id}
          obraSocialNombre={nomencladorOs.nombre}
          open={!!nomencladorOs}
          onOpenChange={(o) => !o && setNomencladorOs(null)}
        />
      )}

      <AlertDialog open={!!deleteId} onOpenChange={() => setDeleteId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>¿Eliminar obra social?</AlertDialogTitle>
            <AlertDialogDescription>
              Esta acción no se puede deshacer. Si la obra social tiene pacientes asociados, conviene marcarla como inactiva en lugar de eliminarla.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction onClick={confirmDelete} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">
              Eliminar
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
