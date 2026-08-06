import { useState, useEffect } from "react";
import {
  useListUsuarios, useCreateUsuario, useUpdateUsuario,
  getListUsuariosQueryKey, useListProfesionales,
  useListTurneras, useUpdateTurnera, getListTurnerasQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import * as z from "zod";
import { zodResolver } from "@hookform/resolvers/zod";

import { Card, CardContent } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PasswordInput } from "@/components/ui/password-input";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import { Combobox } from "@/components/ui/combobox";
import { Badge } from "@/components/ui/badge";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Plus, Edit, Loader2, UserCircle, KeyRound, Stethoscope, Users, Search, X } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/hooks/use-auth";
import type { Usuario } from "@workspace/api-client-react";

const PERFILES = [
  { value: "administracion", label: "Administración", accesos: "Todas las agendas" },
  { value: "administrador_caja", label: "Administrador Caja", accesos: "Todas las agendas + Caja" },
  { value: "tecnico", label: "Técnico", accesos: "Su agenda, estados de estudios, carga de PDF y órdenes médicas" },
  { value: "medico_consulta", label: "Médico de consulta", accesos: "Agenda, Estudios (PACS), Órdenes y Certificados" },
  { value: "medico_informante", label: "Médico informante", accesos: "Worklist de informes y estudios del PACS" },
  { value: "medico_consulta_informante", label: "Médico de consulta e informante", accesos: "Agenda, HCE, Órdenes + Worklist de informes" },
  { value: "gerente", label: "Gerente", accesos: "Acceso completo" },
  { value: "desarrollador", label: "Desarrollador", accesos: "Acceso completo" },
] as const;

const PERFIL_COLORS: Record<string, string> = {
  administracion: "bg-blue-50 text-blue-700 border-blue-200",
  administrador_caja: "bg-cyan-50 text-cyan-700 border-cyan-200",
  tecnico: "bg-amber-50 text-amber-700 border-amber-200",
  medico: "bg-green-50 text-green-700 border-green-200", // legado
  medico_consulta: "bg-emerald-50 text-emerald-700 border-emerald-200",
  medico_informante: "bg-teal-50 text-teal-700 border-teal-200",
  medico_consulta_informante: "bg-green-50 text-green-700 border-green-200",
  gerente: "bg-purple-50 text-purple-700 border-purple-200",
  desarrollador: "bg-slate-100 text-slate-700 border-slate-300",
};

function perfilLabel(perfil: string | null | undefined): string {
  return PERFILES.find((p) => p.value === perfil)?.label ?? "—";
}

const crearSchema = z.object({
  email: z.string().trim().min(3, "Mínimo 3 caracteres").regex(/^\S+$/, "Sin espacios"),
  nombre: z.string().min(1, "El nombre es requerido"),
  password: z.string().min(4, "Mínimo 4 caracteres"),
  perfil: z.enum(["administracion", "administrador_caja", "tecnico", "medico_consulta", "medico_informante", "medico_consulta_informante", "gerente", "desarrollador"], {
    message: "Elegí un perfil",
  }),
  profesionalId: z.string().optional(),
});
type CrearForm = z.infer<typeof crearSchema>;

function UsuarioDialog({
  open,
  usuario,
  onClose,
}: {
  open: boolean;
  usuario: Usuario | null;
  onClose: () => void;
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const create = useCreateUsuario();
  const update = useUpdateUsuario();
  const { data: profesionales } = useListProfesionales();
  const { data: turneras } = useListTurneras();
  const updateTurnera = useUpdateTurnera();

  const form = useForm<CrearForm>({
    resolver: zodResolver(crearSchema),
    defaultValues: { email: "", nombre: "", password: "", perfil: undefined as unknown as CrearForm["perfil"], profesionalId: "" },
    values: usuario
      ? {
          email: usuario.email,
          nombre: usuario.nombre,
          password: "____", // no se muestra; solo se envía si la cambian
          perfil: (usuario.perfil ?? "administracion") as CrearForm["perfil"],
          profesionalId: usuario.profesionalId != null ? String(usuario.profesionalId) : "",
        }
      : undefined,
  });
  const perfilElegido = form.watch("perfil");
  const esPerfilMedico = ["medico_consulta", "medico_informante", "medico_consulta_informante"].includes(perfilElegido);
  const profesionalSel = esPerfilMedico && form.watch("profesionalId") ? Number(form.watch("profesionalId")) : null;

  // Agendas asignadas: turneras donde el profesional es titular (fijas) o participante (editables)
  const [agendasSel, setAgendasSel] = useState<Set<number>>(new Set());
  useEffect(() => {
    if (!open || !profesionalSel || !turneras) { setAgendasSel(new Set()); return; }
    setAgendasSel(new Set(
      turneras
        .filter((t) => t.activa && (t.participantesIds ?? []).includes(profesionalSel))
        .map((t) => t.id),
    ));
  }, [open, profesionalSel, turneras]);

  const turnerasActivas = (turneras ?? []).filter((t) => t.activa);
  const turnerasPropias = profesionalSel ? turnerasActivas.filter((t) => t.profesionalId === profesionalSel) : [];
  const turnerasAsignables = profesionalSel ? turnerasActivas.filter((t) => t.profesionalId !== profesionalSel) : [];

  async function aplicarAgendas(prof: number | null) {
    if (!prof || !turneras) return;
    const cambios: { id: number; participantesIds: number[] }[] = [];
    for (const t of turneras) {
      if (!t.activa || t.profesionalId === prof) continue;
      const tiene = (t.participantesIds ?? []).includes(prof);
      const quiere = agendasSel.has(t.id);
      if (tiene === quiere) continue;
      const nuevos = quiere
        ? [...(t.participantesIds ?? []), prof]
        : (t.participantesIds ?? []).filter((id) => id !== prof);
      cambios.push({ id: t.id, participantesIds: nuevos });
    }
    for (const c of cambios) {
      await updateTurnera.mutateAsync({ id: c.id, data: { participantesIds: c.participantesIds } });
    }
    if (cambios.length > 0) {
      queryClient.invalidateQueries({ queryKey: getListTurnerasQueryKey() });
    }
  }

  const isPending = create.isPending || update.isPending || updateTurnera.isPending;

  function onSubmit(data: CrearForm) {
    const invalidate = () => {
      queryClient.invalidateQueries({ queryKey: getListUsuariosQueryKey() });
      form.reset();
      onClose();
    };
    const profesionalId =
      ["medico_consulta", "medico_informante", "medico_consulta_informante"].includes(data.perfil) && data.profesionalId ? Number(data.profesionalId) : null;
    if (usuario) {
      const cambios: { email?: string; nombre: string; perfil: CrearForm["perfil"]; password?: string; profesionalId: number | null } = {
        nombre: data.nombre,
        perfil: data.perfil,
        profesionalId,
      };
      if (data.email && data.email !== usuario.email) cambios.email = data.email;
      if (data.password && data.password !== "____") cambios.password = data.password;
      update.mutate({ id: usuario.id, data: cambios }, {
        onSuccess: async () => {
          try {
            await aplicarAgendas(profesionalId);
            toast({ title: "Usuario actualizado" });
          } catch {
            toast({ title: "Usuario actualizado, pero falló la asignación de agendas", variant: "destructive" });
          }
          invalidate();
        },
        onError: (err) => {
          const status = (err as { response?: { status?: number } })?.response?.status;
          toast({
            title: status === 409 ? "Ese nombre de usuario ya está en uso" : "Error al actualizar",
            description: status === 409 ? "Elegí otro nombre de usuario." : undefined,
            variant: "destructive",
          });
        },
      });
    } else {
      create.mutate({ data: { email: data.email, nombre: data.nombre, password: data.password, perfil: data.perfil, profesionalId } }, {
        onSuccess: async () => {
          try {
            await aplicarAgendas(profesionalId);
            toast({ title: "Usuario creado" });
          } catch {
            toast({ title: "Usuario creado, pero falló la asignación de agendas", variant: "destructive" });
          }
          invalidate();
        },
        onError: (err) => {
          const status = (err as { response?: { status?: number } })?.response?.status;
          toast({
            title: status === 409 ? "Ese nombre de usuario ya está en uso" : "Error al crear",
            description: status === 409 ? "Probá con otro nombre de usuario (ej: agregale un número o apellido)." : undefined,
            variant: "destructive",
          });
        },
      });
    }
  }

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="max-w-md max-h-[85vh] flex flex-col overflow-hidden">
        <DialogHeader>
          <DialogTitle>{usuario ? "Editar usuario" : "Nuevo usuario"}</DialogTitle>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="flex flex-col flex-1 min-h-0">
            <div className="space-y-4 flex-1 min-h-0 overflow-y-auto pr-1 -mr-1">
            <FormField control={form.control} name="email" render={({ field }) => (
              <FormItem>
                <FormLabel>Usuario *</FormLabel>
                <FormControl>
                  <Input placeholder="ej: jlopez (no hace falta que sea un email)" {...field} />
                </FormControl>
                <p className="text-xs text-muted-foreground">
                  Es el nombre con el que va a ingresar al sistema. Puede ser un usuario corto (ej: jlopez) o un email.
                </p>
                <FormMessage />
              </FormItem>
            )} />
            <FormField control={form.control} name="nombre" render={({ field }) => (
              <FormItem>
                <FormLabel>Nombre *</FormLabel>
                <FormControl><Input placeholder="Nombre y apellido" {...field} /></FormControl>
                <FormMessage />
              </FormItem>
            )} />
            <FormField control={form.control} name="perfil" render={({ field }) => (
              <FormItem>
                <FormLabel>Perfil *</FormLabel>
                <Select onValueChange={field.onChange} value={field.value}>
                  <FormControl>
                    <SelectTrigger><SelectValue placeholder="Elegir perfil" /></SelectTrigger>
                  </FormControl>
                  <SelectContent>
                    {PERFILES.map((p) => (
                      <SelectItem key={p.value} value={p.value}>
                        <div className="flex flex-col items-start">
                          <span>{p.label}</span>
                          <span className="text-xs text-muted-foreground">{p.accesos}</span>
                        </div>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <FormMessage />
              </FormItem>
            )} />
            {["medico_consulta", "medico_informante", "medico_consulta_informante"].includes(perfilElegido) && (
              <FormField control={form.control} name="profesionalId" render={({ field }) => (
                <FormItem>
                  <FormLabel>¿Qué médico es?</FormLabel>
                  <FormControl>
                    <Combobox
                      options={(profesionales ?? []).filter((p) => p.activo !== false).map((p) => ({
                        value: String(p.id),
                        label: `${p.apellido}, ${p.nombre}`,
                      }))}
                      value={field.value ?? ""}
                      onChange={field.onChange}
                      placeholder="Escribí el apellido del profesional…"
                      testId="perfil-profesional"
                      minChars={2}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )} />
            )}
            {profesionalSel != null && (
              <div className="space-y-1.5">
                <p className="text-sm font-medium">Agendas que va a ver</p>
                <div className="flex flex-wrap gap-1.5">
                  {turnerasPropias.map((t) => (
                    <span key={t.id} className="inline-flex items-center gap-1 rounded-full border bg-muted/50 px-2.5 py-1 text-xs">
                      {t.nombre}
                      <span className="text-muted-foreground">· propia</span>
                    </span>
                  ))}
                  {turnerasAsignables.filter((t) => agendasSel.has(t.id)).map((t) => (
                    <span key={t.id} className="inline-flex items-center gap-1 rounded-full border border-primary/40 bg-primary/10 px-2.5 py-1 text-xs" data-testid={`agenda-chip-${t.id}`}>
                      {t.nombre}
                      <button
                        type="button"
                        className="text-muted-foreground hover:text-foreground"
                        onClick={() => setAgendasSel((prev) => { const next = new Set(prev); next.delete(t.id); return next; })}
                        title="Quitar"
                      >
                        ×
                      </button>
                    </span>
                  ))}
                </div>
                <Combobox
                  options={turnerasAsignables
                    .filter((t) => !agendasSel.has(t.id))
                    .map((t) => ({ value: String(t.id), label: t.nombre + (t.esGuardia ? " (guardia)" : "") }))}
                  value=""
                  onChange={(v) => {
                    const id = Number(v);
                    if (id) setAgendasSel((prev) => new Set(prev).add(id));
                  }}
                  placeholder="Escribí para agregar otra agenda (ej: guardia)…"
                  minChars={2}
                  testId="perfil-agenda-extra"
                />
                <p className="text-xs text-muted-foreground">
                  Sus agendas propias vienen incluidas automáticamente. Agregá otras solo si además atiende ahí (ej: guardia o una agenda compartida).
                </p>
              </div>
            )}
            <FormField control={form.control} name="password" render={({ field }) => (
              <FormItem>
                <FormLabel>{usuario ? "Nueva contraseña (opcional)" : "Contraseña *"}</FormLabel>
                <FormControl>
                  <PasswordInput
                    placeholder={usuario ? "Dejar como está para no cambiarla" : "Mínimo 4 caracteres"}
                    {...field}
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )} />
            </div>
            <DialogFooter className="pt-4 shrink-0">
              <Button type="button" variant="outline" onClick={onClose}>Cancelar</Button>
              <Button type="submit" disabled={isPending}>
                {isPending && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
                {usuario ? "Guardar cambios" : "Crear usuario"}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}

const PERFILES_MEDICOS = ["medico", "medico_consulta", "medico_informante", "medico_consulta_informante"];

export default function PerfilesPage() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const { data: usuarios, isLoading } = useListUsuarios();
  const { data: profesionales } = useListProfesionales();
  const update = useUpdateUsuario();

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editUsuario, setEditUsuario] = useState<Usuario | null>(null);
  const [vista, setVista] = useState<"medicos" | "todos">("medicos");
  const [busqueda, setBusqueda] = useState("");

  // Pantalla exclusiva del administrador y el desarrollador
  if (user && (user.rol !== "admin" || user.perfil === "gerente")) {
    return (
      <Card>
        <CardContent className="py-12 text-center text-sm text-muted-foreground">
          Esta pantalla es exclusiva del administrador y el desarrollador.
        </CardContent>
      </Card>
    );
  }

  const profesionalesMap = new Map((profesionales ?? []).map((p) => [p.id, `${p.apellido}, ${p.nombre}`]));

  const openCreate = () => { setEditUsuario(null); setDialogOpen(true); };
  const openEdit = (u: Usuario) => { setEditUsuario(u); setDialogOpen(true); };
  const closeDialog = () => { setDialogOpen(false); setEditUsuario(null); };

  const toggleActivo = (u: Usuario, activo: boolean) => {
    update.mutate({ id: u.id, data: { activo } }, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListUsuariosQueryKey() });
        toast({ title: activo ? "Usuario habilitado" : "Usuario deshabilitado" });
      },
      onError: () => toast({ title: "No se pudo actualizar", variant: "destructive" }),
    });
  };

  const normalizar = (s: string) =>
    s.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  const staff = usuarios?.filter((u) => u.rol !== "paciente");
  const porVista = vista === "medicos"
    ? staff?.filter((u) => PERFILES_MEDICOS.includes(u.perfil ?? ""))
    : staff;
  const q = normalizar(busqueda.trim());
  const visibles = q
    ? porVista?.filter((u) =>
        normalizar(u.nombre).includes(q) ||
        normalizar(u.email).includes(q) ||
        normalizar(perfilLabel(u.perfil)).includes(q) ||
        (u.profesionalId != null && normalizar(profesionalesMap.get(u.profesionalId) ?? "").includes(q)),
      )
    : porVista;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Perfiles</h1>
          <p className="text-muted-foreground">
            Gestión de usuarios del sistema — pantalla exclusiva del administrador y el desarrollador
          </p>
        </div>
        <Button onClick={openCreate}>
          <Plus className="w-4 h-4 mr-2" />
          Nuevo usuario
        </Button>
      </div>

      <div className="flex items-center gap-2">
        <Button
          variant={vista === "medicos" ? "default" : "outline"}
          size="sm"
          onClick={() => setVista("medicos")}
          data-testid="vista-medicos"
        >
          <Stethoscope className="w-4 h-4 mr-1.5" /> Usuarios médicos
        </Button>
        <Button
          variant={vista === "todos" ? "default" : "outline"}
          size="sm"
          onClick={() => setVista("todos")}
          data-testid="vista-todos"
        >
          <Users className="w-4 h-4 mr-1.5" /> Todos los usuarios
        </Button>
        <div className="relative flex-1 max-w-sm ml-2">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <Input
            value={busqueda}
            onChange={(e) => setBusqueda(e.target.value)}
            placeholder="Buscar por nombre, usuario o perfil…"
            className="pl-8 pr-8 h-9"
            data-testid="buscador-perfiles"
          />
          {busqueda && (
            <button
              type="button"
              onClick={() => setBusqueda("")}
              className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              title="Limpiar búsqueda"
            >
              <X className="w-4 h-4" />
            </button>
          )}
        </div>
      </div>

      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Usuario</TableHead>
                <TableHead>Perfil</TableHead>
                {vista === "medicos" && <TableHead>Profesional vinculado</TableHead>}
                <TableHead className="text-center">Activo</TableHead>
                <TableHead className="text-right">Acciones</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                Array.from({ length: 5 }).map((_, i) => (
                  <TableRow key={i}>
                    {Array.from({ length: vista === "medicos" ? 5 : 4 }).map((__, j) => (
                      <TableCell key={j}><Skeleton className="h-8 w-full" /></TableCell>
                    ))}
                  </TableRow>
                ))
              ) : visibles?.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={vista === "medicos" ? 5 : 4} className="h-32 text-center text-muted-foreground">
                    {q && (porVista?.length ?? 0) > 0
                      ? <>No se encontraron usuarios para "{busqueda.trim()}". <button type="button" className="underline hover:text-foreground" onClick={() => setBusqueda("")}>Limpiar búsqueda</button></>
                      : vista === "medicos" ? "Todavía no hay usuarios médicos. Creá uno con \"Nuevo usuario\" eligiendo un perfil médico." : "No hay usuarios."}
                  </TableCell>
                </TableRow>
              ) : (
                visibles?.map((u) => (
                  <TableRow key={u.id} className={!u.activo ? "opacity-60" : undefined}>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <div className="bg-primary/10 p-1.5 rounded-md">
                          <UserCircle className="w-4 h-4 text-primary" />
                        </div>
                        <div>
                          <div className="font-medium">{u.nombre}</div>
                          <div className="text-xs text-muted-foreground">{u.email}</div>
                        </div>
                      </div>
                    </TableCell>
                    <TableCell>
                      {u.perfil ? (
                        <Badge variant="outline" className={PERFIL_COLORS[u.perfil] ?? ""}>
                          {perfilLabel(u.perfil)}
                        </Badge>
                      ) : (
                        <span className="text-muted-foreground text-sm">—</span>
                      )}
                    </TableCell>
                    {vista === "medicos" && (
                      <TableCell>
                        {u.profesionalId != null ? (
                          <span className="text-sm">{profesionalesMap.get(u.profesionalId) ?? `#${u.profesionalId}`}</span>
                        ) : (
                          <span className="text-xs text-amber-600 dark:text-amber-400 font-medium">Sin vincular — no verá su agenda</span>
                        )}
                      </TableCell>
                    )}
                    <TableCell className="text-center">
                      <Switch
                        checked={u.activo}
                        onCheckedChange={(v) => toggleActivo(u, v)}
                        disabled={update.isPending}
                      />
                    </TableCell>
                    <TableCell className="text-right">
                      <Button variant="ghost" size="sm" onClick={() => openEdit(u)} title="Editar / cambiar contraseña">
                        <Edit className="w-4 h-4 mr-1" />
                        <KeyRound className="w-3.5 h-3.5" />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <UsuarioDialog open={dialogOpen} usuario={editUsuario} onClose={closeDialog} />
    </div>
  );
}
