import { useEffect, useState } from "react";
import { Link } from "wouter";
import {
  useListPacientes,
  useCreatePaciente,
  useBuscarDuplicadosPaciente,
  useInactivarPaciente,
  useListObrasSociales,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import {
  Search,
  Plus,
  UserCircle,
  AlertTriangle,
  Ban,
} from "lucide-react";
import { format } from "date-fns";
import { useToast } from "@/hooks/use-toast";
import { PageHeader } from "@/components/layout/page-header";
import { LinkIngresoGenerador } from "@/components/pacientes/link-ingreso-generador";
import { useAuth } from "@/hooks/use-auth";

function useDebounce<T>(value: T, delay: number): T {
  const [debouncedValue, setDebouncedValue] = useState<T>(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedValue(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return debouncedValue;
}

const EMPTY_FORM = {
  nombre: "",
  apellido: "",
  dni: "",
  fechaNacimiento: "",
  sexo: "" as "" | "M" | "F" | "otro",
  telefono: "",
  email: "",
  cobertura: "",
  nroAfiliado: "",
};

export default function PacientesList() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { user } = useAuth();
  // El generador de links de ingreso es solo para gestión (mismo criterio que
  // ver/anular links en la ficha: rol admin).
  const esGestion = user?.rol === "admin";

  const [searchTerm, setSearchTerm] = useState("");
  const [mostrarInactivos, setMostrarInactivos] = useState(false);
  const deferredSearch = useDebounce(searchTerm, 300);

  const [dialogOpen, setDialogOpen] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);

  // Abrir el alta directamente cuando se llega con ?nuevo=1 (ej. desde Agenda por médico)
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("nuevo") === "1") {
      setForm(EMPTY_FORM);
      setDuplicadosPendientes(null);
      setDialogOpen(true);
      window.history.replaceState(null, "", window.location.pathname);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [duplicadosPendientes, setDuplicadosPendientes] = useState<unknown[] | null>(null);
  const [confirmandoInactivar, setConfirmandoInactivar] = useState<number | null>(null);

  const { data: pacientesResponse, isLoading } = useListPacientes({
    q: deferredSearch || undefined,
    soloActivos: mostrarInactivos ? false : true,
    limit: 50,
  });

  const { data: duplicadosData } = useBuscarDuplicadosPaciente(
    {
      nombre: useDebounce(form.nombre, 400),
      apellido: useDebounce(form.apellido, 400),
      fechaNacimiento: useDebounce(form.fechaNacimiento, 400),
    },
    {
      query: {
        enabled: dialogOpen && !!form.nombre && !!form.apellido,
      },
    }
  );

  const { data: obrasSociales } = useListObrasSociales();
  const createMutation = useCreatePaciente();
  const inactivarMutation = useInactivarPaciente();

  function abrirDialog() {
    setForm(EMPTY_FORM);
    setDuplicadosPendientes(null);
    setDialogOpen(true);
  }

  const faltanObligatorios =
    !form.nombre.trim() || !form.apellido.trim() || !form.dni.trim() ||
    !form.telefono.trim() || !form.cobertura.trim();

  async function handleCrear(forzar = false) {
    if (faltanObligatorios) return;

    if (!forzar && duplicadosData?.hayDuplicados) {
      setDuplicadosPendientes(duplicadosData.duplicados);
      return;
    }

    createMutation.mutate(
      {
        data: {
          nombre: form.nombre.trim(),
          apellido: form.apellido.trim(),
          ...(form.dni && { dni: form.dni }),
          ...(form.fechaNacimiento && { fechaNacimiento: form.fechaNacimiento }),
          ...(form.sexo && { sexo: form.sexo as "M" | "F" | "otro" }),
          ...(form.telefono && { telefono: form.telefono }),
          ...(form.email && { email: form.email }),
          ...(form.cobertura && { cobertura: form.cobertura }),
          ...(form.nroAfiliado && { nroAfiliado: form.nroAfiliado }),
          ...(forzar && { forzarCreacion: true }),
        },
      },
      {
        onSuccess: () => {
          toast({ title: "Paciente creado correctamente" });
          setDialogOpen(false);
          setDuplicadosPendientes(null);
          void queryClient.invalidateQueries({ queryKey: ["/pacientes"] });
        },
        onError: (e: unknown) => {
          const msg =
            e instanceof Error ? e.message : "Error al crear paciente";
          toast({ title: "Error", description: msg, variant: "destructive" });
        },
      }
    );
  }

  function handleInactivar(id: number) {
    inactivarMutation.mutate(
      { id },
      {
        onSuccess: () => {
          toast({ title: "Paciente dado de baja" });
          setConfirmandoInactivar(null);
          void queryClient.invalidateQueries({ queryKey: ["/pacientes"] });
        },
      }
    );
  }

  const hayDuplicados =
    dialogOpen && duplicadosData?.hayDuplicados && !duplicadosPendientes;

  return (
    <>
      <PageHeader 
        title="Pacientes"
        breadcrumb={[{ label: "Inicio", href: "/" }, { label: "Pacientes" }]}
        action={
          <div className="flex items-center gap-2">
            {esGestion && <LinkIngresoGenerador />}
            <Button onClick={abrirDialog} variant="secondary" className="gap-2 bg-white/20 hover:bg-white/30 text-white border-0">
              <Plus className="w-4 h-4" />
              Nuevo Paciente
            </Button>
          </div>
        }
      />
      
      <div className="p-6 space-y-6">
        <Card>
          <CardHeader className="py-4">
            <div className="flex items-center gap-4 flex-wrap">
              <div className="relative flex-1 min-w-[200px] max-w-md">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input
                  placeholder="Buscar por nombre, apellido, DNI o Nro HC..."
                  className="pl-9"
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                />
              </div>
              <div className="flex items-center gap-2 text-sm">
                <Switch
                  id="mostrar-inactivos"
                  checked={mostrarInactivos}
                  onCheckedChange={setMostrarInactivos}
                />
                <Label htmlFor="mostrar-inactivos" className="cursor-pointer">
                  Mostrar inactivos
                </Label>
              </div>
            </div>
          </CardHeader>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Paciente</TableHead>
                  <TableHead>Nro HC / DNI</TableHead>
                  <TableHead>Contacto</TableHead>
                  <TableHead>Cobertura</TableHead>
                  <TableHead>Estado</TableHead>
                  <TableHead className="text-right">Acciones</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {isLoading ? (
                  Array.from({ length: 5 }).map((_, i) => (
                    <TableRow key={i}>
                      <TableCell>
                        <Skeleton className="h-10 w-48" />
                      </TableCell>
                      <TableCell>
                        <Skeleton className="h-4 w-28" />
                      </TableCell>
                      <TableCell>
                        <Skeleton className="h-8 w-32" />
                      </TableCell>
                      <TableCell>
                        <Skeleton className="h-4 w-32" />
                      </TableCell>
                      <TableCell>
                        <Skeleton className="h-5 w-16" />
                      </TableCell>
                      <TableCell>
                        <Skeleton className="h-8 w-20 ml-auto" />
                      </TableCell>
                    </TableRow>
                  ))
                ) : pacientesResponse?.data && pacientesResponse.data.length > 0 ? (
                  pacientesResponse.data.map((paciente) => (
                    <TableRow
                      key={paciente.id}
                      className={!paciente.activo ? "opacity-60" : ""}
                    >
                      <TableCell>
                        <div className="flex items-center gap-3">
                          <div className="bg-primary/10 p-2 rounded-full text-primary shrink-0">
                            <UserCircle className="w-5 h-5" />
                          </div>
                          <div>
                            <div className="font-medium text-base">
                              {paciente.apellido}, {paciente.nombre}
                            </div>
                            <div className="text-xs text-muted-foreground">
                              {paciente.fechaNacimiento
                                ? `Nac: ${format(
                                    new Date(paciente.fechaNacimiento + "T12:00:00"),
                                    "dd/MM/yyyy"
                                  )}`
                                : "Sin fecha nac."}
                            </div>
                          </div>
                        </div>
                      </TableCell>
                      <TableCell>
                        <div className="font-mono text-xs text-primary font-semibold">
                          {paciente.numeroHc ?? "-"}
                        </div>
                        <div className="text-sm text-muted-foreground">
                          {paciente.dni ?? "-"}
                        </div>
                      </TableCell>
                      <TableCell>
                        <div className="text-sm">{paciente.telefono || "-"}</div>
                        <div className="text-xs text-muted-foreground">
                          {paciente.email}
                        </div>
                      </TableCell>
                      <TableCell>
                        <div className="text-sm">
                          {paciente.cobertura || "Particular"}
                        </div>
                        {paciente.nroAfiliado && (
                          <div className="text-xs text-muted-foreground">
                            {paciente.nroAfiliado}
                          </div>
                        )}
                      </TableCell>
                      <TableCell>
                        {paciente.activo ? (
                          <Badge variant="outline" className="text-green-700 border-green-300 bg-green-50">
                            Activo
                          </Badge>
                        ) : (
                          <Badge variant="outline" className="text-red-700 border-red-300 bg-red-50">
                            Inactivo
                          </Badge>
                        )}
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex items-center justify-end gap-2">
                          <Link href={`/pacientes/${paciente.id}`}>
                            <Button variant="outline" size="sm">
                              Ficha
                            </Button>
                          </Link>
                          {paciente.activo && (
                            <Button
                              variant="ghost"
                              size="icon"
                              className="text-muted-foreground hover:text-destructive"
                              title="Dar de baja"
                              onClick={() => setConfirmandoInactivar(paciente.id)}
                            >
                              <Ban className="w-4 h-4" />
                            </Button>
                          )}
                        </div>
                      </TableCell>
                    </TableRow>
                  ))
                ) : (
                  <TableRow>
                    <TableCell
                      colSpan={6}
                      className="h-32 text-center text-muted-foreground"
                    >
                      {searchTerm
                        ? "No se encontraron pacientes que coincidan."
                        : "No hay pacientes registrados."}
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </CardContent>
        </Card>

        {pacientesResponse && (
          <p className="text-xs text-muted-foreground text-right">
            {pacientesResponse.total} paciente
            {pacientesResponse.total !== 1 ? "s" : ""} encontrado
            {pacientesResponse.total !== 1 ? "s" : ""}
          </p>
        )}

        {/* ── Dialog Nuevo Paciente ── */}
        <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
          <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle>Nuevo Paciente</DialogTitle>
              <DialogDescription>
                Completá los datos del nuevo paciente. El número de HC se asigna
                automáticamente.
              </DialogDescription>
            </DialogHeader>

            {hayDuplicados && (
              <div className="rounded-lg border border-yellow-300 bg-yellow-50 p-3 flex gap-2 text-sm text-yellow-800">
                <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5 text-yellow-600" />
                <span>
                  Hay pacientes similares ya registrados. Verificá antes de
                  continuar.
                </span>
              </div>
            )}

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <Label>Nombre *</Label>
                <Input
                  value={form.nombre}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, nombre: e.target.value }))
                  }
                  placeholder="Nombre"
                />
              </div>
              <div className="space-y-1.5">
                <Label>Apellido *</Label>
                <Input
                  value={form.apellido}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, apellido: e.target.value }))
                  }
                  placeholder="Apellido"
                />
              </div>
              <div className="space-y-1.5">
                <Label>DNI *</Label>
                <Input
                  value={form.dni}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, dni: e.target.value }))
                  }
                  placeholder="Nro de documento"
                />
              </div>
              <div className="space-y-1.5">
                <Label>Fecha de nacimiento</Label>
                <Input
                  type="date"
                  value={form.fechaNacimiento}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, fechaNacimiento: e.target.value }))
                  }
                />
              </div>
              <div className="space-y-1.5">
                <Label>Sexo</Label>
                <Select
                  value={form.sexo}
                  onValueChange={(v) =>
                    setForm((f) => ({ ...f, sexo: v as "M" | "F" | "otro" }))
                  }
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Seleccionar" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="M">Masculino</SelectItem>
                    <SelectItem value="F">Femenino</SelectItem>
                    <SelectItem value="otro">Otro</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label>Celular *</Label>
                <Input
                  value={form.telefono}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, telefono: e.target.value }))
                  }
                  placeholder="Número de celular"
                />
              </div>
              <div className="col-span-2 space-y-1.5">
                <Label>Email</Label>
                <Input
                  type="email"
                  value={form.email}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, email: e.target.value }))
                  }
                  placeholder="correo@ejemplo.com"
                />
              </div>
              <div className="space-y-1.5">
                <Label>Obra Social *</Label>
                <Select
                  value={form.cobertura}
                  onValueChange={(v) =>
                    setForm((f) => ({ ...f, cobertura: v }))
                  }
                >
                  <SelectTrigger data-testid="select-obra-social">
                    <SelectValue placeholder="Seleccionar obra social" />
                  </SelectTrigger>
                  <SelectContent>
                    {(obrasSociales ?? [])
                      .filter((o) => o.activa)
                      .map((o) => (
                        <SelectItem key={o.id} value={o.nombre}>
                          {o.nombre}
                        </SelectItem>
                      ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label>Nro afiliado</Label>
                <Input
                  value={form.nroAfiliado}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, nroAfiliado: e.target.value }))
                  }
                  placeholder="Número de afiliado"
                />
              </div>
            </div>

            <DialogFooter className="gap-2">
              <Button
                variant="outline"
                onClick={() => setDialogOpen(false)}
              >
                Cancelar
              </Button>
              {hayDuplicados && (
                <Button
                  variant="secondary"
                  onClick={() => void handleCrear(true)}
                  disabled={createMutation.isPending}
                >
                  Crear de todas formas
                </Button>
              )}
              <Button
                onClick={() => void handleCrear(false)}
                disabled={createMutation.isPending || faltanObligatorios}
                data-testid="crear-paciente"
              >
                {createMutation.isPending ? "Guardando..." : "Crear Paciente"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* ── Dialog duplicados pendientes ── */}
        {duplicadosPendientes && (
          <Dialog
            open
            onOpenChange={() => setDuplicadosPendientes(null)}
          >
            <DialogContent className="max-w-lg">
              <DialogHeader>
                <DialogTitle className="flex items-center gap-2 text-yellow-700">
                  <AlertTriangle className="w-5 h-5" />
                  Posibles duplicados detectados
                </DialogTitle>
                <DialogDescription>
                  Encontramos pacientes que podrían ya estar registrados.
                </DialogDescription>
              </DialogHeader>
              <div className="space-y-2 max-h-60 overflow-y-auto">
                {(duplicadosPendientes as Array<{ id: number; apellido: string; nombre: string; dni?: string; fechaNacimiento?: string; cobertura?: string }>).map((p) => (
                  <div
                    key={p.id}
                    className="flex items-center justify-between p-3 border rounded-lg bg-muted/40"
                  >
                    <div>
                      <div className="font-medium">
                        {p.apellido}, {p.nombre}
                      </div>
                      <div className="text-xs text-muted-foreground">
                        DNI: {p.dni ?? "-"} ·{" "}
                        {p.fechaNacimiento
                          ? format(
                              new Date(p.fechaNacimiento + "T12:00:00"),
                              "dd/MM/yyyy"
                            )
                          : "-"}
                      </div>
                    </div>
                    <Link href={`/pacientes/${p.id}`}>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setDuplicadosPendientes(null)}
                      >
                        Ver ficha
                      </Button>
                    </Link>
                  </div>
                ))}
              </div>
              <DialogFooter className="gap-2">
                <Button
                  variant="outline"
                  onClick={() => setDuplicadosPendientes(null)}
                >
                  Cancelar
                </Button>
                <Button
                  variant="destructive"
                  onClick={() => {
                    setDuplicadosPendientes(null);
                    void handleCrear(true);
                  }}
                  disabled={createMutation.isPending}
                >
                  Crear igualmente
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        )}

        {/* ── Confirm inactivar ── */}
        <AlertDialog
          open={confirmandoInactivar !== null}
          onOpenChange={(open) => !open && setConfirmandoInactivar(null)}
        >
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>¿Dar de baja al paciente?</AlertDialogTitle>
              <AlertDialogDescription>
                El paciente quedará inactivo. Podrás reactivarlo desde su ficha en
                cualquier momento.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancelar</AlertDialogCancel>
              <AlertDialogAction
                className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                onClick={() =>
                  confirmandoInactivar !== null &&
                  handleInactivar(confirmandoInactivar)
                }
              >
                Dar de baja
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
    </>
  );
}
