import { useState } from "react";
import {
  useListSedes, useCreateSede, useUpdateSede, useDeleteSede,
  getListSedesQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import * as z from "zod";
import { zodResolver } from "@hookform/resolvers/zod";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Plus, Edit, Trash2, Loader2, MapPin } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import type { Sede } from "@workspace/api-client-react";

const sedeSchema = z.object({
  nombre:    z.string().min(1, "El nombre es requerido"),
  direccion: z.string().optional(),
  telefono:  z.string().optional(),
  email:     z.string().optional(),
  activa:    z.boolean(),
});
type SedeForm = z.infer<typeof sedeSchema>;

function SedeDialog({
  open,
  sede,
  onClose,
}: {
  open: boolean;
  sede: Sede | null;
  onClose: () => void;
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const create = useCreateSede();
  const update = useUpdateSede();

  const form = useForm<SedeForm>({
    resolver: zodResolver(sedeSchema),
    defaultValues: {
      nombre:    sede?.nombre ?? "",
      direccion: sede?.direccion ?? "",
      telefono:  sede?.telefono ?? "",
      email:     sede?.email ?? "",
      activa:    sede?.activa ?? true,
    },
    values: sede ? {
      nombre:    sede.nombre,
      direccion: sede.direccion ?? "",
      telefono:  sede.telefono ?? "",
      email:     sede.email ?? "",
      activa:    sede.activa,
    } : undefined,
  });

  const isPending = create.isPending || update.isPending;

  function onSubmit(data: SedeForm) {
    const invalidate = () => {
      queryClient.invalidateQueries({ queryKey: getListSedesQueryKey() });
      onClose();
    };
    if (sede) {
      update.mutate({ id: sede.id, data }, {
        onSuccess: () => { toast({ title: "Sede actualizada" }); invalidate(); },
        onError:   () => toast({ title: "Error al actualizar", variant: "destructive" }),
      });
    } else {
      create.mutate({ data }, {
        onSuccess: () => { toast({ title: "Sede creada" }); invalidate(); },
        onError:   () => toast({ title: "Error al crear", variant: "destructive" }),
      });
    }
  }

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{sede ? "Editar Sede" : "Nueva Sede"}</DialogTitle>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
            <FormField control={form.control} name="nombre" render={({ field }) => (
              <FormItem>
                <FormLabel>Nombre *</FormLabel>
                <FormControl><Input placeholder="Ej: Sede Central" {...field} /></FormControl>
                <FormMessage />
              </FormItem>
            )} />
            <FormField control={form.control} name="direccion" render={({ field }) => (
              <FormItem>
                <FormLabel>Dirección</FormLabel>
                <FormControl><Input placeholder="Av. Ejemplo 1234, CABA" {...field} /></FormControl>
                <FormMessage />
              </FormItem>
            )} />
            <div className="grid grid-cols-2 gap-4">
              <FormField control={form.control} name="telefono" render={({ field }) => (
                <FormItem>
                  <FormLabel>Teléfono</FormLabel>
                  <FormControl><Input placeholder="11-1234-5678" {...field} /></FormControl>
                  <FormMessage />
                </FormItem>
              )} />
              <FormField control={form.control} name="email" render={({ field }) => (
                <FormItem>
                  <FormLabel>Email</FormLabel>
                  <FormControl><Input type="text" placeholder="sede@clinica.com" {...field} /></FormControl>
                  <FormMessage />
                </FormItem>
              )} />
            </div>
            <FormField control={form.control} name="activa" render={({ field }) => (
              <FormItem className="flex items-center justify-between rounded-lg border p-3 space-y-0">
                <FormLabel>Sede activa</FormLabel>
                <FormControl><Switch checked={field.value} onCheckedChange={field.onChange} /></FormControl>
              </FormItem>
            )} />
            <DialogFooter>
              <Button type="button" variant="outline" onClick={onClose}>Cancelar</Button>
              <Button type="submit" disabled={isPending}>
                {isPending && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
                {sede ? "Guardar Cambios" : "Crear Sede"}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}

export default function SedesPage() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { data: sedes, isLoading } = useListSedes();
  const deleteSede = useDeleteSede();

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editSede, setEditSede] = useState<Sede | null>(null);
  const [deleteId, setDeleteId] = useState<number | null>(null);

  const openCreate = () => { setEditSede(null); setDialogOpen(true); };
  const openEdit   = (s: Sede) => { setEditSede(s); setDialogOpen(true); };
  const closeDialog = () => { setDialogOpen(false); setEditSede(null); };

  const confirmDelete = () => {
    if (!deleteId) return;
    deleteSede.mutate({ id: deleteId }, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListSedesQueryKey() });
        toast({ title: "Sede eliminada" });
        setDeleteId(null);
      },
      onError: () => toast({ title: "No se pudo eliminar (puede tener turneras asociadas)", variant: "destructive" }),
    });
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Sedes</h1>
          <p className="text-muted-foreground">Gestión de sucursales y centros de atención</p>
        </div>
        <Button onClick={openCreate}>
          <Plus className="w-4 h-4 mr-2" />
          Nueva Sede
        </Button>
      </div>

      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Nombre</TableHead>
                <TableHead>Dirección</TableHead>
                <TableHead>Contacto</TableHead>
                <TableHead className="text-center">Estado</TableHead>
                <TableHead className="text-right">Acciones</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                Array.from({ length: 4 }).map((_, i) => (
                  <TableRow key={i}>
                    {Array.from({ length: 5 }).map((__, j) => (
                      <TableCell key={j}><Skeleton className="h-8 w-full" /></TableCell>
                    ))}
                  </TableRow>
                ))
              ) : sedes?.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={5} className="h-32 text-center text-muted-foreground">
                    No hay sedes configuradas.
                  </TableCell>
                </TableRow>
              ) : (
                sedes?.map((sede) => (
                  <TableRow key={sede.id}>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <div className="bg-primary/10 p-1.5 rounded-md">
                          <MapPin className="w-4 h-4 text-primary" />
                        </div>
                        <span className="font-medium">{sede.nombre}</span>
                      </div>
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {sede.direccion ?? "—"}
                    </TableCell>
                    <TableCell className="text-sm">
                      {sede.telefono && <div>{sede.telefono}</div>}
                      {sede.email && <div className="text-muted-foreground">{sede.email}</div>}
                      {!sede.telefono && !sede.email && <span className="text-muted-foreground">—</span>}
                    </TableCell>
                    <TableCell className="text-center">
                      {sede.activa
                        ? <Badge variant="outline" className="bg-green-50 text-green-700 border-green-200">Activa</Badge>
                        : <Badge variant="outline" className="bg-muted text-muted-foreground">Inactiva</Badge>
                      }
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-1">
                        <Button variant="ghost" size="sm" onClick={() => openEdit(sede)}>
                          <Edit className="w-4 h-4" />
                        </Button>
                        <Button variant="ghost" size="sm" onClick={() => setDeleteId(sede.id)}
                          className="text-destructive hover:text-destructive">
                          <Trash2 className="w-4 h-4" />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <SedeDialog open={dialogOpen} sede={editSede} onClose={closeDialog} />

      <AlertDialog open={!!deleteId} onOpenChange={() => setDeleteId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>¿Eliminar sede?</AlertDialogTitle>
            <AlertDialogDescription>
              Esta acción no se puede deshacer. La sede será eliminada permanentemente.
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
