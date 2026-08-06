import { useMemo, useState } from "react";
import {
  useListEspecialidades, useCreateEspecialidad, useUpdateEspecialidad, useDeleteEspecialidad,
  getListEspecialidadesQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";

import { Card, CardContent } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Plus, Pencil, Trash2, Loader2, Search, Save, Stethoscope, List } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import type { Especialidad } from "@workspace/api-client-react";

function normalizar(s: string) {
  return s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

export default function EspecialidadesPage() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { data: especialidades, isLoading } = useListEspecialidades();
  const createEsp = useCreateEspecialidad();
  const updateEsp = useUpdateEspecialidad();
  const deleteEsp = useDeleteEspecialidad();

  const [tab, setTab] = useState<"listar" | "nuevo">("listar");
  const [busqueda, setBusqueda] = useState("");
  const [nuevo, setNuevo] = useState({ nombre: "", codigo: "", descripcion: "", enviaAlPacs: false, modalidadDicom: "" });
  const [editEsp, setEditEsp] = useState<Especialidad | null>(null);
  const [editForm, setEditForm] = useState({ nombre: "", codigo: "", descripcion: "", enviaAlPacs: false, modalidadDicom: "" });
  const [deleteId, setDeleteId] = useState<number | null>(null);

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: getListEspecialidadesQueryKey() });

  const filtradas = useMemo(() => {
    const lista = especialidades ?? [];
    const q = normalizar(busqueda.trim());
    if (!q) return lista;
    return lista.filter((e) =>
      normalizar(`${e.nombre} ${e.codigo ?? ""} ${e.descripcion ?? ""}`).includes(q),
    );
  }, [especialidades, busqueda]);

  const guardarNueva = () => {
    if (!nuevo.nombre.trim()) return;
    createEsp.mutate(
      { data: { nombre: nuevo.nombre.trim(), ...(nuevo.codigo.trim() && { codigo: nuevo.codigo.trim() }), ...(nuevo.descripcion.trim() && { descripcion: nuevo.descripcion.trim() }), enviaAlPacs: nuevo.enviaAlPacs, ...(nuevo.enviaAlPacs && nuevo.modalidadDicom.trim() && { modalidadDicom: nuevo.modalidadDicom.trim().toUpperCase() }) } },
      {
        onSuccess: () => {
          toast({ title: "Especialidad creada", description: nuevo.nombre.trim() });
          setNuevo({ nombre: "", codigo: "", descripcion: "", enviaAlPacs: false, modalidadDicom: "" });
          invalidate();
          setTab("listar");
        },
        onError: () => toast({ title: "Error al crear", variant: "destructive" }),
      },
    );
  };

  const abrirEdicion = (e: Especialidad) => {
    setEditEsp(e);
    setEditForm({ nombre: e.nombre, codigo: e.codigo ?? "", descripcion: e.descripcion ?? "", enviaAlPacs: e.enviaAlPacs ?? false, modalidadDicom: e.modalidadDicom ?? "" });
  };

  const guardarEdicion = () => {
    if (!editEsp || !editForm.nombre.trim()) return;
    updateEsp.mutate(
      { id: editEsp.id, data: { nombre: editForm.nombre.trim(), codigo: editForm.codigo.trim(), descripcion: editForm.descripcion.trim(), enviaAlPacs: editForm.enviaAlPacs, modalidadDicom: editForm.enviaAlPacs ? editForm.modalidadDicom.trim().toUpperCase() : "" } },
      {
        onSuccess: () => { toast({ title: "Especialidad actualizada" }); invalidate(); setEditEsp(null); },
        onError: () => toast({ title: "Error al actualizar", variant: "destructive" }),
      },
    );
  };

  const confirmDelete = () => {
    if (!deleteId) return;
    deleteEsp.mutate({ id: deleteId }, {
      onSuccess: () => { invalidate(); toast({ title: "Especialidad eliminada" }); setDeleteId(null); },
      onError: () => toast({ title: "No se pudo eliminar (puede tener profesionales o turneras asociadas)", variant: "destructive" }),
    });
  };

  return (
    <div className="space-y-4">
      {/* Pestañas estilo gestionsalud */}
      <div className="flex items-end gap-1 border-b">
        <button
          onClick={() => setTab("listar")}
          className={`px-5 py-2 text-sm font-medium rounded-t-md transition-colors ${
            tab === "listar"
              ? "bg-primary text-primary-foreground"
              : "text-muted-foreground hover:text-foreground"
          }`}
          data-testid="tab-listar"
        >
          Listar
        </button>
        <button
          onClick={() => setTab("nuevo")}
          className={`px-5 py-2 text-sm font-medium rounded-t-md transition-colors ${
            tab === "nuevo"
              ? "bg-primary text-primary-foreground"
              : "text-muted-foreground hover:text-foreground"
          }`}
          data-testid="tab-nuevo"
        >
          Nuevo
        </button>
      </div>

      {tab === "listar" ? (
        <Card className="border-l-4 border-l-primary">
          <CardContent className="pt-5 space-y-4">
            <div className="flex items-center gap-2 font-semibold">
              <Stethoscope className="w-4 h-4" /> Especialidades
            </div>
            <div className="relative">
              <Search className="absolute left-2.5 top-2.5 w-4 h-4 text-muted-foreground" />
              <Input
                className="pl-8"
                placeholder="Buscar especialidad…"
                value={busqueda}
                onChange={(e) => setBusqueda(e.target.value)}
                data-testid="buscar-especialidad"
              />
            </div>
            <div className="border rounded-md overflow-hidden">
              <Table>
                <TableHeader>
                  <TableRow className="bg-slate-800 hover:bg-slate-800">
                    <TableHead className="text-slate-100 text-xs font-semibold uppercase w-24">Código</TableHead>
                    <TableHead className="text-slate-100 text-xs font-semibold uppercase">Especialidad</TableHead>
                    <TableHead className="text-slate-100 text-xs font-semibold uppercase">Detalle</TableHead>
                    <TableHead className="text-slate-100 text-xs font-semibold uppercase w-28">PACS</TableHead>
                    <TableHead className="text-slate-100 text-xs font-semibold uppercase text-right w-28">Acciones</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {isLoading ? (
                    Array.from({ length: 4 }).map((_, i) => (
                      <TableRow key={i}>
                        {Array.from({ length: 5 }).map((__, j) => (
                          <TableCell key={j}><Skeleton className="h-7 w-full" /></TableCell>
                        ))}
                      </TableRow>
                    ))
                  ) : filtradas.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={5} className="h-24 text-center text-muted-foreground">
                        {busqueda ? "Sin resultados para la búsqueda." : "No hay especialidades configuradas."}
                      </TableCell>
                    </TableRow>
                  ) : (
                    filtradas.map((esp, i) => (
                      <TableRow key={esp.id} className={i % 2 === 1 ? "bg-primary/5" : undefined}>
                        <TableCell className="font-mono text-sm">{esp.codigo || "—"}</TableCell>
                        <TableCell className="font-medium uppercase">{esp.nombre}</TableCell>
                        <TableCell className="text-sm text-muted-foreground uppercase">{esp.descripcion || ""}</TableCell>
                        <TableCell>
                          {esp.enviaAlPacs ? (
                            <Badge variant="secondary" className="text-xs" data-testid={`pacs-badge-${esp.id}`}>
                              PACS{esp.modalidadDicom ? ` · ${esp.modalidadDicom}` : ""}
                            </Badge>
                          ) : (
                            <span className="text-xs text-muted-foreground">—</span>
                          )}
                        </TableCell>
                        <TableCell className="text-right">
                          <div className="flex justify-end gap-1">
                            <Button variant="outline" size="icon" className="h-7 w-7" onClick={() => abrirEdicion(esp)} title="Editar" data-testid={`editar-${esp.id}`}>
                              <Pencil className="w-3.5 h-3.5" />
                            </Button>
                            <Button variant="outline" size="icon" className="h-7 w-7 text-destructive hover:text-destructive" onClick={() => setDeleteId(esp.id)} title="Eliminar" data-testid={`eliminar-${esp.id}`}>
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
                {filtradas.length} {filtradas.length === 1 ? "especialidad" : "especialidades"}
              </div>
            </div>
          </CardContent>
        </Card>
      ) : (
        <Card className="border-l-4 border-l-primary">
          <CardContent className="pt-5 space-y-4">
            <div className="flex items-center gap-2 font-semibold">
              <Plus className="w-4 h-4" /> Nueva Especialidad
            </div>
            <div className="flex flex-wrap items-end gap-4">
              <div className="space-y-1.5 w-28">
                <Label className="text-xs uppercase text-muted-foreground">Código</Label>
                <Input
                  placeholder="Ej. 101"
                  value={nuevo.codigo}
                  onChange={(e) => setNuevo((f) => ({ ...f, codigo: e.target.value }))}
                  data-testid="nueva-especialidad-codigo"
                />
              </div>
              <div className="space-y-1.5 w-64">
                <Label className="text-xs uppercase text-muted-foreground">Especialidad</Label>
                <Input
                  placeholder="Ej. Cardiología"
                  value={nuevo.nombre}
                  onChange={(e) => setNuevo((f) => ({ ...f, nombre: e.target.value }))}
                  data-testid="nueva-especialidad-nombre"
                />
              </div>
              <div className="space-y-1.5 w-64">
                <Label className="text-xs uppercase text-muted-foreground">Detalle</Label>
                <Input
                  value={nuevo.descripcion}
                  onChange={(e) => setNuevo((f) => ({ ...f, descripcion: e.target.value }))}
                  data-testid="nueva-especialidad-detalle"
                />
              </div>
              <div className="flex items-center gap-2 pb-2.5">
                <Switch
                  checked={nuevo.enviaAlPacs}
                  onCheckedChange={(v) => setNuevo((f) => ({ ...f, enviaAlPacs: v }))}
                  data-testid="nueva-envia-pacs"
                />
                <Label className="text-xs uppercase text-muted-foreground">Envía al PACS</Label>
              </div>
              {nuevo.enviaAlPacs && (
                <div className="space-y-1.5 w-40">
                  <Label className="text-xs uppercase text-muted-foreground">Modalidad DICOM</Label>
                  <Input
                    placeholder="Ej. CT, MR, US"
                    value={nuevo.modalidadDicom}
                    onChange={(e) => setNuevo((f) => ({ ...f, modalidadDicom: e.target.value }))}
                    data-testid="nueva-modalidad-dicom"
                  />
                </div>
              )}
              <Button
                onClick={guardarNueva}
                disabled={!nuevo.nombre.trim() || createEsp.isPending}
                data-testid="guardar-especialidad"
              >
                {createEsp.isPending ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Save className="w-4 h-4 mr-2" />}
                Guardar
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Edición */}
      <Dialog open={!!editEsp} onOpenChange={(o) => !o && setEditEsp(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Editar Especialidad</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label className="text-xs uppercase text-muted-foreground">Código</Label>
              <Input
                value={editForm.codigo}
                onChange={(e) => setEditForm((f) => ({ ...f, codigo: e.target.value }))}
                data-testid="editar-codigo"
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs uppercase text-muted-foreground">Especialidad</Label>
              <Input
                value={editForm.nombre}
                onChange={(e) => setEditForm((f) => ({ ...f, nombre: e.target.value }))}
                data-testid="editar-nombre"
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs uppercase text-muted-foreground">Detalle</Label>
              <Input
                value={editForm.descripcion}
                onChange={(e) => setEditForm((f) => ({ ...f, descripcion: e.target.value }))}
                data-testid="editar-detalle"
              />
            </div>
            <div className="flex items-center justify-between rounded-md border p-3">
              <div className="space-y-0.5">
                <Label className="text-xs uppercase text-muted-foreground">Envía al PACS</Label>
                <p className="text-xs text-muted-foreground">Los turnos de esta especialidad se publican en la worklist del PACS.</p>
              </div>
              <Switch
                checked={editForm.enviaAlPacs}
                onCheckedChange={(v) => setEditForm((f) => ({ ...f, enviaAlPacs: v }))}
                data-testid="editar-envia-pacs"
              />
            </div>
            {editForm.enviaAlPacs && (
              <div className="space-y-1.5">
                <Label className="text-xs uppercase text-muted-foreground">Modalidad DICOM</Label>
                <Input
                  placeholder="Ej. CT, MR, US"
                  value={editForm.modalidadDicom}
                  onChange={(e) => setEditForm((f) => ({ ...f, modalidadDicom: e.target.value }))}
                  data-testid="editar-modalidad-dicom"
                />
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditEsp(null)}>Cancelar</Button>
            <Button onClick={guardarEdicion} disabled={!editForm.nombre.trim() || updateEsp.isPending} data-testid="guardar-edicion">
              {updateEsp.isPending && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
              Guardar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={!!deleteId} onOpenChange={() => setDeleteId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>¿Eliminar especialidad?</AlertDialogTitle>
            <AlertDialogDescription>
              Esta acción no se puede deshacer. Asegurate de que no tenga profesionales o turneras asociadas.
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
