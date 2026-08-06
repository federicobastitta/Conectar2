import { useMemo, useState } from "react";
import {
  useListConsultorios, useCreateConsultorio, useUpdateConsultorio, useDeleteConsultorio,
  getListConsultoriosQueryKey,
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
import { Plus, Pencil, Trash2, Loader2, Search, Save, List, Info } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import type { Consultorio } from "@workspace/api-client-react";

function normalizar(s: string) {
  return s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

type Tab = "listar" | "nuevo";

export default function ConsultoriosPage() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { data: consultorios, isLoading } = useListConsultorios();
  const createC = useCreateConsultorio();
  const updateC = useUpdateConsultorio();
  const deleteC = useDeleteConsultorio();

  const [tab, setTab] = useState<Tab>("listar");
  const [busqueda, setBusqueda] = useState("");
  const [nuevo, setNuevo] = useState({ nombre: "", detalle: "" });
  const [editC, setEditC] = useState<Consultorio | null>(null);
  const [editForm, setEditForm] = useState({ nombre: "", detalle: "" });
  const [deleteId, setDeleteId] = useState<number | null>(null);

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: getListConsultoriosQueryKey() });

  const filtrados = useMemo(() => {
    const lista = consultorios ?? [];
    const q = normalizar(busqueda.trim());
    if (!q) return lista;
    return lista.filter((c) => normalizar(`${c.nombre} ${c.detalle ?? ""}`).includes(q));
  }, [consultorios, busqueda]);

  const guardarNuevo = () => {
    if (!nuevo.nombre.trim()) return;
    createC.mutate(
      {
        data: {
          nombre: nuevo.nombre.trim(),
          ...(nuevo.detalle.trim() && { detalle: nuevo.detalle.trim() }),
        },
      },
      {
        onSuccess: () => {
          toast({ title: "Consultorio creado", description: nuevo.nombre.trim() });
          setNuevo({ nombre: "", detalle: "" });
          invalidate();
          setTab("listar");
        },
        onError: () => toast({ title: "Error al crear", variant: "destructive" }),
      },
    );
  };

  const abrirEdicion = (c: Consultorio) => {
    setEditC(c);
    setEditForm({ nombre: c.nombre, detalle: c.detalle ?? "" });
  };

  const guardarEdicion = () => {
    if (!editC || !editForm.nombre.trim()) return;
    updateC.mutate(
      { id: editC.id, data: { nombre: editForm.nombre.trim(), detalle: editForm.detalle.trim() } },
      {
        onSuccess: () => { toast({ title: "Consultorio actualizado" }); invalidate(); setEditC(null); },
        onError: () => toast({ title: "Error al actualizar", variant: "destructive" }),
      },
    );
  };

  const toggleActivo = (c: Consultorio) => {
    updateC.mutate(
      { id: c.id, data: { activo: !c.activo } },
      {
        onSuccess: () => invalidate(),
        onError: () => toast({ title: "Error al actualizar", variant: "destructive" }),
      },
    );
  };

  const confirmDelete = () => {
    if (!deleteId) return;
    deleteC.mutate({ id: deleteId }, {
      onSuccess: () => { invalidate(); toast({ title: "Consultorio eliminado" }); setDeleteId(null); },
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
        {tabBtn("nuevo", "Nuevo", "tab-nuevo")}
      </div>

      {tab === "listar" ? (
        <Card className="border-l-4 border-l-primary">
          <CardContent className="pt-5 space-y-4">
            <div className="flex items-start gap-2 rounded-md border border-sky-200 bg-sky-50 dark:bg-sky-950/30 dark:border-sky-900 px-3 py-2 text-sm">
              <Info className="w-4 h-4 mt-0.5 text-sky-600 shrink-0" />
              <span>
                El consultorio asignado a cada profesional aparece en la <span className="font-semibold">pantalla de sala de espera</span> al llamar al paciente.
              </span>
            </div>
            <div className="relative">
              <Search className="absolute left-2.5 top-2.5 w-4 h-4 text-muted-foreground" />
              <Input
                className="pl-8"
                placeholder="Buscar consultorio…"
                value={busqueda}
                onChange={(e) => setBusqueda(e.target.value)}
                data-testid="buscar-consultorio"
              />
            </div>
            <div className="border rounded-md overflow-hidden">
              <Table>
                <TableHeader>
                  <TableRow className="bg-slate-800 hover:bg-slate-800">
                    <TableHead className="text-slate-100 text-xs font-semibold uppercase">Consultorio</TableHead>
                    <TableHead className="text-slate-100 text-xs font-semibold uppercase">Detalle</TableHead>
                    <TableHead className="text-slate-100 text-xs font-semibold uppercase">Estado</TableHead>
                    <TableHead className="text-slate-100 text-xs font-semibold uppercase text-right w-28">Acciones</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {isLoading ? (
                    Array.from({ length: 3 }).map((_, i) => (
                      <TableRow key={i}>
                        {Array.from({ length: 4 }).map((__, j) => (
                          <TableCell key={j}><Skeleton className="h-7 w-full" /></TableCell>
                        ))}
                      </TableRow>
                    ))
                  ) : filtrados.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={4} className="h-24 text-center text-muted-foreground">
                        {busqueda ? "Sin resultados para la búsqueda." : "No hay consultorios configurados."}
                      </TableCell>
                    </TableRow>
                  ) : (
                    filtrados.map((c, i) => (
                      <TableRow key={c.id} className={i % 2 === 1 ? "bg-primary/5" : undefined}>
                        <TableCell className="font-medium uppercase">{c.nombre}</TableCell>
                        <TableCell className="text-sm text-muted-foreground uppercase">{c.detalle || ""}</TableCell>
                        <TableCell>
                          <button onClick={() => toggleActivo(c)} data-testid={`estado-${c.id}`} title="Cambiar estado">
                            <Badge className={c.activo ? "bg-emerald-500 hover:bg-emerald-600" : "bg-slate-400 hover:bg-slate-500"}>
                              {c.activo ? "ACTIVO" : "INACTIVO"}
                            </Badge>
                          </button>
                        </TableCell>
                        <TableCell className="text-right">
                          <div className="flex justify-end gap-1">
                            <Button variant="outline" size="icon" className="h-7 w-7" onClick={() => abrirEdicion(c)} title="Editar" data-testid={`editar-${c.id}`}>
                              <Pencil className="w-3.5 h-3.5" />
                            </Button>
                            <Button variant="outline" size="icon" className="h-7 w-7 text-destructive hover:text-destructive" onClick={() => setDeleteId(c.id)} title="Eliminar" data-testid={`eliminar-${c.id}`}>
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
                {filtrados.length} {filtrados.length === 1 ? "consultorio" : "consultorios"}
              </div>
            </div>
          </CardContent>
        </Card>
      ) : (
        <Card className="border-l-4 border-l-primary">
          <CardContent className="pt-5 space-y-4">
            <div className="flex items-center gap-2 font-semibold">
              <Plus className="w-4 h-4" /> Nuevo Consultorio
            </div>
            <div className="flex flex-wrap items-end gap-4">
              <div className="space-y-1.5 w-64">
                <Label className="text-xs uppercase text-muted-foreground">Nombre</Label>
                <Input
                  placeholder="Ej. Consultorio 6"
                  value={nuevo.nombre}
                  onChange={(e) => setNuevo((f) => ({ ...f, nombre: e.target.value }))}
                  data-testid="nuevo-consultorio-nombre"
                />
              </div>
              <div className="space-y-1.5 w-64">
                <Label className="text-xs uppercase text-muted-foreground">Detalle</Label>
                <Input
                  placeholder="Ej. Planta baja"
                  value={nuevo.detalle}
                  onChange={(e) => setNuevo((f) => ({ ...f, detalle: e.target.value }))}
                  data-testid="nuevo-consultorio-detalle"
                />
              </div>
              <Button
                onClick={guardarNuevo}
                disabled={!nuevo.nombre.trim() || createC.isPending}
                data-testid="guardar-consultorio"
              >
                {createC.isPending ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Save className="w-4 h-4 mr-2" />}
                Guardar
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      <Dialog open={!!editC} onOpenChange={(o) => !o && setEditC(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Editar Consultorio</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label className="text-xs uppercase text-muted-foreground">Nombre</Label>
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
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditC(null)}>Cancelar</Button>
            <Button onClick={guardarEdicion} disabled={!editForm.nombre.trim() || updateC.isPending} data-testid="guardar-edicion">
              {updateC.isPending && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
              Guardar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={!!deleteId} onOpenChange={() => setDeleteId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>¿Eliminar consultorio?</AlertDialogTitle>
            <AlertDialogDescription>
              Esta acción no se puede deshacer. Los profesionales que tenían este consultorio asignado quedarán sin consultorio.
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
