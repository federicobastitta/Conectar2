import { useEffect, useState } from "react";
import { Link } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import { format } from "date-fns";
import { AlertTriangle } from "lucide-react";
import {
  useCreatePaciente,
  useBuscarDuplicadosPaciente,
  useListObrasSociales,
  type Paciente,
} from "@workspace/api-client-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";

function useDebounce<T>(value: T, delay: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(t);
  }, [value, delay]);
  return debounced;
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

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated?: (paciente: Paciente) => void;
}

export function NuevoPacienteDialog({ open, onOpenChange, onCreated }: Props) {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const [form, setForm] = useState(EMPTY_FORM);
  const [duplicadosPendientes, setDuplicadosPendientes] = useState<unknown[] | null>(null);

  const { data: duplicadosData } = useBuscarDuplicadosPaciente(
    {
      nombre: useDebounce(form.nombre, 400),
      apellido: useDebounce(form.apellido, 400),
      fechaNacimiento: useDebounce(form.fechaNacimiento, 400),
    },
    {
      query: {
        enabled: open && !!form.nombre && !!form.apellido,
      },
    }
  );

  const { data: obrasSociales } = useListObrasSociales();
  const createMutation = useCreatePaciente();

  function cambiarOpen(next: boolean) {
    if (next) {
      setForm(EMPTY_FORM);
      setDuplicadosPendientes(null);
    }
    onOpenChange(next);
  }

  const faltanObligatorios =
    !form.nombre.trim() || !form.apellido.trim() || !form.dni.trim() ||
    !form.telefono.trim() || !form.cobertura.trim();

  function handleCrear(forzar = false) {
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
        onSuccess: (paciente) => {
          toast({ title: "Paciente creado correctamente" });
          setDuplicadosPendientes(null);
          onOpenChange(false);
          void queryClient.invalidateQueries({ queryKey: ["/pacientes"] });
          onCreated?.(paciente);
        },
        onError: (e: unknown) => {
          const msg = e instanceof Error ? e.message : "Error al crear paciente";
          toast({ title: "Error", description: msg, variant: "destructive" });
        },
      }
    );
  }

  const hayDuplicados = open && duplicadosData?.hayDuplicados && !duplicadosPendientes;

  return (
    <>
      <Dialog open={open} onOpenChange={cambiarOpen}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Nuevo Paciente</DialogTitle>
            <DialogDescription>
              Cargá los datos del paciente. Los campos con * son obligatorios.
            </DialogDescription>
          </DialogHeader>

          {hayDuplicados && (
            <div className="flex items-center gap-2 p-3 rounded-lg bg-yellow-50 border border-yellow-200 text-yellow-800 text-sm">
              <AlertTriangle className="w-4 h-4 shrink-0" />
              <span>
                Hay pacientes similares ya registrados. Verificá antes de continuar.
              </span>
            </div>
          )}

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label>Nombre *</Label>
              <Input
                value={form.nombre}
                onChange={(e) => setForm((f) => ({ ...f, nombre: e.target.value }))}
                placeholder="Nombre"
                data-testid="input-nuevo-paciente-nombre"
              />
            </div>
            <div className="space-y-1.5">
              <Label>Apellido *</Label>
              <Input
                value={form.apellido}
                onChange={(e) => setForm((f) => ({ ...f, apellido: e.target.value }))}
                placeholder="Apellido"
                data-testid="input-nuevo-paciente-apellido"
              />
            </div>
            <div className="space-y-1.5">
              <Label>DNI *</Label>
              <Input
                value={form.dni}
                onChange={(e) => setForm((f) => ({ ...f, dni: e.target.value }))}
                placeholder="Nro de documento"
                data-testid="input-nuevo-paciente-dni"
              />
            </div>
            <div className="space-y-1.5">
              <Label>Fecha de nacimiento</Label>
              <Input
                type="date"
                value={form.fechaNacimiento}
                onChange={(e) => setForm((f) => ({ ...f, fechaNacimiento: e.target.value }))}
              />
            </div>
            <div className="space-y-1.5">
              <Label>Sexo</Label>
              <Select
                value={form.sexo}
                onValueChange={(v) => setForm((f) => ({ ...f, sexo: v as "M" | "F" | "otro" }))}
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
                onChange={(e) => setForm((f) => ({ ...f, telefono: e.target.value }))}
                placeholder="Número de celular"
                data-testid="input-nuevo-paciente-telefono"
              />
            </div>
            <div className="col-span-2 space-y-1.5">
              <Label>Email</Label>
              <Input
                type="email"
                value={form.email}
                onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))}
                placeholder="correo@ejemplo.com"
              />
            </div>
            <div className="space-y-1.5">
              <Label>Obra Social *</Label>
              <Select
                value={form.cobertura}
                onValueChange={(v) => setForm((f) => ({ ...f, cobertura: v }))}
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
                onChange={(e) => setForm((f) => ({ ...f, nroAfiliado: e.target.value }))}
                placeholder="Número de afiliado"
              />
            </div>
          </div>

          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              Cancelar
            </Button>
            {hayDuplicados && (
              <Button
                variant="secondary"
                onClick={() => handleCrear(true)}
                disabled={createMutation.isPending}
              >
                Crear de todas formas
              </Button>
            )}
            <Button
              onClick={() => handleCrear(false)}
              disabled={createMutation.isPending || faltanObligatorios}
              data-testid="crear-paciente"
            >
              {createMutation.isPending ? "Guardando..." : "Crear Paciente"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {duplicadosPendientes && (
        <Dialog open onOpenChange={() => setDuplicadosPendientes(null)}>
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
                        ? format(new Date(p.fechaNacimiento + "T12:00:00"), "dd/MM/yyyy")
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
              <Button variant="outline" onClick={() => setDuplicadosPendientes(null)}>
                Cancelar
              </Button>
              <Button
                variant="destructive"
                onClick={() => {
                  setDuplicadosPendientes(null);
                  handleCrear(true);
                }}
                disabled={createMutation.isPending}
              >
                Crear igualmente
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </>
  );
}
