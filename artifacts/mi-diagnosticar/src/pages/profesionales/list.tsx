import { useState, useEffect } from "react";
import {
  useListProfesionales, useListEspecialidades, useListConsultorios, useListSedes,
  useCreateProfesional, useUpdateProfesional, useDeleteProfesional,
  getListProfesionalesQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import * as z from "zod";
import { zodResolver } from "@hookform/resolvers/zod";

import { Card, CardContent, CardHeader, CardTitle, CardFooter } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Combobox } from "@/components/ui/combobox";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Search, Plus, UserCircle, Phone, Mail, Edit, Trash2, Loader2, PenLine, CalendarDays } from "lucide-react";
import { Link } from "wouter";
import { useToast } from "@/hooks/use-toast";
import type { Profesional } from "@workspace/api-client-react";

const profSchema = z.object({
  nombre:         z.string().min(1, "El nombre es requerido"),
  apellido:       z.string().optional(),
  matricula:      z.string().optional(),
  email:          z.string().optional(),
  telefono:       z.string().optional(),
  especialidadId: z.coerce.number().optional(),
  sedeId:         z.coerce.number({ invalid_type_error: "Elegí una sede" }).min(1, "Elegí una sede"),
  consultorioId:  z.coerce.number().nullable().optional(),
  activo:         z.boolean(),
  atiendeGuardia: z.boolean(),
  klinicosUsuario:      z.string().optional(),
  klinicosEspecialidad: z.string().optional(),
  klinicosSector:       z.string().optional(),
});
type ProfForm = z.infer<typeof profSchema>;

function FirmaSection({ profesional, onChanged }: { profesional: Profesional; onChanged: () => void }) {
  const { toast } = useToast();
  const [subiendo, setSubiendo] = useState(false);
  const tieneFirma = Boolean((profesional as Profesional & { tieneFirma?: boolean }).tieneFirma);
  const [miniatura, setMiniatura] = useState<string | null>(null);

  // Miniatura de la firma cargada (el endpoint solo la muestra a admin o al propio médico)
  useEffect(() => {
    let cancelado = false;
    if (!tieneFirma) {
      setMiniatura(null);
      return;
    }
    void (async () => {
      try {
        const r = await fetch(`/api/profesionales/${profesional.id}/firma`, {
          headers: { Authorization: `Bearer ${localStorage.getItem("auth_token") ?? ""}` },
        });
        if (!r.ok) return;
        const data = await r.json() as { firmaImagen?: string | null };
        if (!cancelado) setMiniatura(data.firmaImagen ?? null);
      } catch {
        // sin miniatura: no es un error bloqueante
      }
    })();
    return () => { cancelado = true; };
  }, [tieneFirma, profesional.id]);

  const subir = async (file: File) => {
    if (!["image/png", "image/jpeg"].includes(file.type)) {
      toast({ title: "Formato inválido", description: "La firma debe ser PNG o JPG.", variant: "destructive" });
      return;
    }
    if (file.size > 400 * 1024) {
      toast({ title: "Imagen muy pesada", description: "Máximo 400 KB. Recortá o comprimí la imagen.", variant: "destructive" });
      return;
    }
    setSubiendo(true);
    try {
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const fr = new FileReader();
        fr.onload = () => resolve(fr.result as string);
        fr.onerror = () => reject(new Error("read error"));
        fr.readAsDataURL(file);
      });
      const r = await fetch(`/api/profesionales/${profesional.id}/firma`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${localStorage.getItem("auth_token") ?? ""}`,
        },
        body: JSON.stringify({ firmaImagen: dataUrl }),
      });
      if (!r.ok) {
        const err = await r.json().catch(() => ({})) as { error?: string };
        toast({ title: "No se pudo guardar la firma", description: err.error, variant: "destructive" });
        return;
      }
      toast({ title: "Firma guardada", description: "Se va a estampar en los informes PDF." });
      setMiniatura(dataUrl);
      onChanged();
    } finally {
      setSubiendo(false);
    }
  };

  const borrar = async () => {
    setSubiendo(true);
    try {
      const r = await fetch(`/api/profesionales/${profesional.id}/firma`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${localStorage.getItem("auth_token") ?? ""}`,
        },
        body: JSON.stringify({ firmaImagen: null }),
      });
      if (!r.ok) {
        toast({ title: "No se pudo quitar la firma", variant: "destructive" });
        return;
      }
      toast({ title: "Firma eliminada" });
      setMiniatura(null);
      onChanged();
    } finally {
      setSubiendo(false);
    }
  };

  return (
    <div className="space-y-2 rounded-lg border p-3">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm font-medium flex items-center gap-1.5">
            <PenLine className="w-4 h-4" /> Firma escaneada
          </p>
          <p className="text-xs text-muted-foreground">
            {tieneFirma ? "Firma cargada — se estampa en los informes PDF." : "Sin firma cargada. Subí una imagen PNG o JPG (fondo blanco, máx 400 KB)."}
          </p>
        </div>
        {tieneFirma && <Badge variant="outline" className="bg-green-50 text-green-700 border-green-200">Cargada</Badge>}
      </div>
      {miniatura && (
        <div className="rounded-md border bg-white p-2 inline-block" data-testid="miniatura-firma">
          <img src={miniatura} alt="Firma cargada" className="max-h-20 max-w-[240px] object-contain" />
        </div>
      )}
      <div className="flex items-center gap-2">
        <Input
          type="file"
          accept="image/png,image/jpeg"
          disabled={subiendo}
          data-testid="input-firma"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void subir(f);
            e.target.value = "";
          }}
        />
        {tieneFirma && (
          <Button type="button" variant="ghost" size="sm" disabled={subiendo} onClick={() => void borrar()} data-testid="button-borrar-firma">
            Quitar
          </Button>
        )}
        {subiendo && <Loader2 className="w-4 h-4 animate-spin shrink-0" />}
      </div>
    </div>
  );
}

function ProfesionalDialog({
  open,
  profesional,
  onClose,
}: {
  open: boolean;
  profesional: Profesional | null;
  onClose: () => void;
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const create = useCreateProfesional();
  const update = useUpdateProfesional();
  const { data: especialidades } = useListEspecialidades();
  const { data: consultorios } = useListConsultorios();
  const { data: sedes } = useListSedes();

  const form = useForm<ProfForm>({
    resolver: zodResolver(profSchema),
    values: profesional ? {
      nombre:         profesional.nombre,
      apellido:       profesional.apellido ?? "",
      matricula:      profesional.matricula ?? "",
      email:          profesional.email ?? "",
      telefono:       profesional.telefono ?? "",
      especialidadId: profesional.especialidadId ?? undefined,
      sedeId:         profesional.sedeId ?? (undefined as unknown as number),
      consultorioId:  profesional.consultorioId ?? undefined,
      activo:         profesional.activo,
      atiendeGuardia: profesional.atiendeGuardia ?? true,
      klinicosUsuario:      profesional.klinicosUsuario ?? "",
      klinicosEspecialidad: profesional.klinicosEspecialidad ?? "",
      klinicosSector:       profesional.klinicosSector ?? "",
    } : {
      nombre: "", apellido: "", matricula: "", email: "", telefono: "",
      especialidadId: undefined, sedeId: undefined as unknown as number, consultorioId: undefined, activo: true, atiendeGuardia: true,
      klinicosUsuario: "", klinicosEspecialidad: "", klinicosSector: "",
    },
  });

  const isPending = create.isPending || update.isPending;

  function onSubmit(raw: ProfForm) {
    // Campos Klinicos: vacío = sin vincular (null)
    const data = {
      ...raw,
      klinicosUsuario:      raw.klinicosUsuario?.trim() || null,
      klinicosEspecialidad: raw.klinicosEspecialidad?.trim() || null,
      klinicosSector:       raw.klinicosSector?.trim() || null,
    };
    const invalidate = () => {
      queryClient.invalidateQueries({ queryKey: getListProfesionalesQueryKey() });
      onClose();
    };
    if (profesional) {
      update.mutate({ id: profesional.id, data }, {
        onSuccess: () => { toast({ title: "Profesional actualizado" }); invalidate(); },
        onError:   () => toast({ title: "Error al actualizar", variant: "destructive" }),
      });
    } else {
      create.mutate({ data }, {
        onSuccess: () => { toast({ title: "Profesional creado" }); invalidate(); },
        onError:   () => toast({ title: "Error al crear", variant: "destructive" }),
      });
    }
  }

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="max-w-md max-h-[85vh] flex flex-col overflow-hidden">
        <DialogHeader>
          <DialogTitle>{profesional ? "Editar Profesional" : "Nuevo Profesional"}</DialogTitle>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="flex flex-col flex-1 min-h-0">
            <div className="flex-1 min-h-0 overflow-y-auto space-y-4 pr-2 -mr-2">
            <div className="grid grid-cols-2 gap-4">
              <FormField control={form.control} name="nombre" render={({ field }) => (
                <FormItem>
                  <FormLabel>Nombre *</FormLabel>
                  <FormControl><Input placeholder="Juan" {...field} /></FormControl>
                  <FormMessage />
                </FormItem>
              )} />
              <FormField control={form.control} name="apellido" render={({ field }) => (
                <FormItem>
                  <FormLabel>Apellido</FormLabel>
                  <FormControl><Input placeholder="García" {...field} /></FormControl>
                  <FormMessage />
                </FormItem>
              )} />
            </div>
            <FormField control={form.control} name="matricula" render={({ field }) => (
              <FormItem>
                <FormLabel>Matrícula</FormLabel>
                <FormControl><Input placeholder="MN 12345" {...field} /></FormControl>
                <FormMessage />
              </FormItem>
            )} />
            <FormField control={form.control} name="especialidadId" render={({ field }) => (
              <FormItem>
                <FormLabel>Especialidad</FormLabel>
                <FormControl>
                  <Combobox
                    testId="combobox-especialidad-profesional"
                    options={(especialidades ?? []).map(e => ({ value: e.id.toString(), label: e.nombre }))}
                    value={field.value?.toString() ?? ""}
                    onChange={field.onChange}
                    placeholder="Buscar especialidad..."
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )} />
            <FormField control={form.control} name="sedeId" render={({ field }) => (
              <FormItem>
                <FormLabel>Sede *</FormLabel>
                <Select
                  onValueChange={(v) => field.onChange(Number(v))}
                  value={field.value != null ? field.value.toString() : ""}
                >
                  <FormControl><SelectTrigger data-testid="select-sede"><SelectValue placeholder="Seleccionar sede..." /></SelectTrigger></FormControl>
                  <SelectContent>
                    {sedes?.filter(s => s.activa || s.id === field.value).map(s => (
                      <SelectItem key={s.id} value={s.id.toString()}>{s.nombre}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <FormMessage />
              </FormItem>
            )} />
            <FormField control={form.control} name="consultorioId" render={({ field }) => (
              <FormItem>
                <FormLabel>Consultorio</FormLabel>
                <Select
                  onValueChange={(v) => field.onChange(v === "ninguno" ? null : Number(v))}
                  value={field.value == null ? "ninguno" : field.value.toString()}
                >
                  <FormControl><SelectTrigger data-testid="select-consultorio"><SelectValue placeholder="Seleccionar..." /></SelectTrigger></FormControl>
                  <SelectContent>
                    <SelectItem value="ninguno">Sin consultorio</SelectItem>
                    {consultorios?.map(c => (
                      <SelectItem key={c.id} value={c.id.toString()}>{c.nombre}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
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
                  <FormControl><Input type="text" placeholder="dr@clinica.com" {...field} /></FormControl>
                  <FormMessage />
                </FormItem>
              )} />
            </div>
            <div className="space-y-3 rounded-lg border p-3">
              <div>
                <p className="text-sm font-medium">Vínculo con Klinicos</p>
                <p className="text-xs text-muted-foreground">Usuario espejo del profesional en Klinicos — el robot lo usa para machear el ingreso ambulatorio.</p>
              </div>
              <FormField control={form.control} name="klinicosUsuario" render={({ field }) => (
                <FormItem>
                  <FormLabel>Usuario Klinicos</FormLabel>
                  <FormControl><Input placeholder="nombre.apellido" {...field} /></FormControl>
                  <FormMessage />
                </FormItem>
              )} />
              <div className="grid grid-cols-2 gap-4">
                <FormField control={form.control} name="klinicosEspecialidad" render={({ field }) => (
                  <FormItem>
                    <FormLabel>Especialidad en Klinicos</FormLabel>
                    <FormControl><Input placeholder="Tal como figura en Klinicos" {...field} /></FormControl>
                    <FormMessage />
                  </FormItem>
                )} />
                <FormField control={form.control} name="klinicosSector" render={({ field }) => (
                  <FormItem>
                    <FormLabel>Sector en Klinicos</FormLabel>
                    <FormControl><Input placeholder="Ej: CONSULTORIO" {...field} /></FormControl>
                    <FormMessage />
                  </FormItem>
                )} />
              </div>
            </div>
            {profesional && (
              <FirmaSection
                profesional={profesional}
                onChanged={() => queryClient.invalidateQueries({ queryKey: getListProfesionalesQueryKey() })}
              />
            )}
            <FormField control={form.control} name="activo" render={({ field }) => (
              <FormItem className="flex items-center justify-between rounded-lg border p-3 space-y-0">
                <FormLabel>Profesional activo</FormLabel>
                <FormControl><Switch checked={field.value} onCheckedChange={field.onChange} /></FormControl>
              </FormItem>
            )} />
            <FormField control={form.control} name="atiendeGuardia" render={({ field }) => (
              <FormItem className="flex items-center justify-between rounded-lg border p-3 space-y-0">
                <div className="pr-3">
                  <FormLabel>Toma pacientes de agendas grupales</FormLabel>
                  <p className="text-xs text-muted-foreground">Ve y puede tomar los pacientes de las agendas grupales (guardia, ecografía, etc.) de su especialidad</p>
                </div>
                <FormControl><Switch checked={field.value} onCheckedChange={field.onChange} data-testid="switch-atiende-guardia" /></FormControl>
              </FormItem>
            )} />
            </div>
            <DialogFooter className="pt-4 border-t mt-4">
              <Button type="button" variant="outline" onClick={onClose}>Cancelar</Button>
              <Button type="submit" disabled={isPending} data-testid="button-guardar-profesional">
                {isPending && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
                {profesional ? "Guardar" : "Crear Profesional"}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}

export default function ProfesionalesList() {
  const [searchTerm, setSearchTerm] = useState("");
  const [especialidadFilter, setEspecialidadFilter] = useState<string>("all");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editProf, setEditProf] = useState<Profesional | null>(null);
  const [deleteId, setDeleteId] = useState<number | null>(null);

  const { toast } = useToast();
  const queryClient = useQueryClient();

  const { data: profesionales, isLoading } = useListProfesionales({
    q: searchTerm || undefined,
    especialidadId: especialidadFilter !== "all" ? Number(especialidadFilter) : undefined,
  });
  const { data: especialidades } = useListEspecialidades();
  const { data: sedes } = useListSedes();
  const nombreSede = (id: number | null | undefined) =>
    id == null ? null : sedes?.find(s => s.id === id)?.nombre ?? null;
  const deleteProf = useDeleteProfesional();

  const openCreate = () => { setEditProf(null); setDialogOpen(true); };
  const openEdit   = (p: Profesional) => { setEditProf(p); setDialogOpen(true); };
  const closeDialog = () => { setDialogOpen(false); setEditProf(null); };

  const confirmDelete = () => {
    if (!deleteId) return;
    deleteProf.mutate({ id: deleteId }, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListProfesionalesQueryKey() });
        toast({ title: "Profesional eliminado" });
        setDeleteId(null);
      },
      onError: () => toast({ title: "No se pudo eliminar (puede tener turneras o turnos asociados)", variant: "destructive" }),
    });
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Profesionales</h1>
          <p className="text-muted-foreground">Gestión de médicos y especialistas</p>
        </div>
        <Button onClick={openCreate}>
          <Plus className="w-4 h-4 mr-2" />
          Nuevo Profesional
        </Button>
      </div>

      <div className="flex flex-wrap gap-4 items-center bg-card p-4 rounded-lg border">
        <div className="relative max-w-sm flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Buscar profesional..."
            className="pl-9"
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
          />
        </div>
        <div className="w-[220px]">
          <Combobox
            testId="combobox-especialidad-filtro"
            options={[
              { value: "all", label: "Todas las especialidades" },
              ...(especialidades ?? []).map(esp => ({ value: esp.id.toString(), label: esp.nombre })),
            ]}
            value={especialidadFilter}
            onChange={setEspecialidadFilter}
            placeholder="Especialidad"
          />
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {isLoading ? (
          Array.from({ length: 8 }).map((_, i) => (
            <Card key={i}>
              <CardHeader className="pb-2">
                <div className="flex justify-between items-start">
                  <Skeleton className="w-12 h-12 rounded-full" />
                  <Skeleton className="w-16 h-5 rounded-full" />
                </div>
                <div className="mt-4">
                  <Skeleton className="h-5 w-3/4 mb-1" />
                  <Skeleton className="h-4 w-1/2" />
                </div>
              </CardHeader>
              <CardContent className="py-2">
                <Skeleton className="h-4 w-full mb-2" />
                <Skeleton className="h-4 w-4/5" />
              </CardContent>
              <CardFooter className="pt-2">
                <Skeleton className="h-8 w-full" />
              </CardFooter>
            </Card>
          ))
        ) : profesionales?.length === 0 ? (
          <div className="col-span-full py-12 text-center text-muted-foreground bg-card rounded-lg border">
            No se encontraron profesionales con los filtros actuales.
          </div>
        ) : (
          profesionales?.map((prof) => (
            <Card key={prof.id} className="flex flex-col">
              <CardHeader className="pb-2">
                <div className="flex justify-between items-start">
                  <div className="bg-primary/10 p-3 rounded-full text-primary">
                    <UserCircle className="w-6 h-6" />
                  </div>
                  <div className="flex items-center gap-1">
                    {prof.activo
                      ? <Badge variant="outline" className="bg-green-50 text-green-700 border-green-200">Activo</Badge>
                      : <Badge variant="outline" className="bg-muted text-muted-foreground">Inactivo</Badge>
                    }
                  </div>
                </div>
                <div className="mt-2">
                  <CardTitle className="text-lg">{prof.apellido}, {prof.nombre}</CardTitle>
                  {prof.especialidad && (
                    <Badge
                      variant="secondary"
                      className="mt-1 font-normal"
                      style={prof.especialidad.color
                        ? { backgroundColor: `${prof.especialidad.color}15`, color: prof.especialidad.color }
                        : {}
                      }
                    >
                      {prof.especialidad.nombre}
                    </Badge>
                  )}
                </div>
              </CardHeader>
              <CardContent className="flex-1 py-2 text-sm space-y-1.5">
                <div className="flex items-center text-muted-foreground">
                  <span className="font-medium mr-1 text-foreground">MN:</span>
                  {prof.matricula || "N/A"}
                </div>
                <div className="flex items-center text-muted-foreground" data-testid={`sede-prof-${prof.id}`}>
                  <span className="font-medium mr-1 text-foreground">Sede:</span>
                  {nombreSede(prof.sedeId) ?? <span className="text-amber-600 font-medium">Sin asignar</span>}
                </div>
                {prof.telefono && (
                  <div className="flex items-center gap-2 text-muted-foreground">
                    <Phone className="w-3.5 h-3.5" />
                    <span>{prof.telefono}</span>
                  </div>
                )}
                {prof.email && (
                  <div className="flex items-center gap-2 text-muted-foreground">
                    <Mail className="w-3.5 h-3.5" />
                    <span className="truncate">{prof.email}</span>
                  </div>
                )}
              </CardContent>
              <CardFooter className="pt-3 border-t mt-auto flex gap-2">
                <Link
                  href={`/agendas/todas?buscar=${encodeURIComponent(`${prof.apellido ?? ""} ${prof.nombre}`.trim())}`}
                  className="flex-1"
                >
                  <Button variant="outline" className="w-full" data-testid={`boton-agenda-prof-${prof.id}`}>
                    <CalendarDays className="w-4 h-4 mr-1" /> Agenda
                  </Button>
                </Link>
                <Button variant="outline" className="flex-1" onClick={() => openEdit(prof)}>
                  <Edit className="w-4 h-4 mr-1" /> Editar
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => setDeleteId(prof.id)}
                  className="text-destructive hover:text-destructive shrink-0"
                >
                  <Trash2 className="w-4 h-4" />
                </Button>
              </CardFooter>
            </Card>
          ))
        )}
      </div>

      <ProfesionalDialog open={dialogOpen} profesional={editProf} onClose={closeDialog} />

      <AlertDialog open={!!deleteId} onOpenChange={() => setDeleteId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>¿Eliminar profesional?</AlertDialogTitle>
            <AlertDialogDescription>
              Esta acción no se puede deshacer. Asegurate de que no tenga turneras o turnos activos asociados.
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
