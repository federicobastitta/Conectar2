import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  getPracticasCatalogo,
  crearPracticaCatalogo,
  actualizarPracticaCatalogo,
  desactivarPracticaCatalogo,
  type PracticaCatalogo,
} from "@/api/ordenes-practicas";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/hooks/use-toast";
import { Plus, Pencil, Power, Loader2, FlaskConical } from "lucide-react";
import { Link } from "wouter";
import { ArrowLeft } from "lucide-react";

type FormData = {
  codigo: string;
  nombre: string;
  especialidad: string;
  modalidadDicom: string;
  generaDicom: boolean;
  usaWorkspacePacs: boolean;
  requiereTokenKlinicos: boolean;
  requiereRegion: boolean;
  requiereLateralidad: boolean;
  preparacion: string;
  requisitosDocumentacion: string;
  activo: boolean;
  sortOrder: string;
};

const EMPTY_FORM: FormData = {
  codigo: "",
  nombre: "",
  especialidad: "CARDIOLOGIA",
  modalidadDicom: "",
  generaDicom: true,
  usaWorkspacePacs: true,
  requiereTokenKlinicos: false,
  requiereRegion: false,
  requiereLateralidad: false,
  preparacion: "",
  requisitosDocumentacion: "",
  activo: true,
  sortOrder: "0",
};

function fromPractica(p: PracticaCatalogo): FormData {
  return {
    codigo: p.codigo,
    nombre: p.nombre,
    especialidad: p.especialidad,
    modalidadDicom: p.modalidadDicom ?? "",
    generaDicom: p.generaDicom,
    usaWorkspacePacs: p.usaWorkspacePacs,
    requiereTokenKlinicos: p.requiereTokenKlinicos,
    requiereRegion: p.requiereRegion,
    requiereLateralidad: p.requiereLateralidad,
    preparacion: p.preparacion ?? "",
    requisitosDocumentacion: p.requisitosDocumentacion ?? "",
    activo: p.activo,
    sortOrder: String(p.sortOrder),
  };
}

export default function PracticasCatalogoConfig() {
  const qc = useQueryClient();
  const [dialog, setDialog] = useState<{ mode: "crear" | "editar"; practica?: PracticaCatalogo } | null>(null);
  const [form, setForm] = useState<FormData>(EMPTY_FORM);
  const [mostrarTodas, setMostrarTodas] = useState(false);

  const { toast } = useToast();
  const { data, isLoading } = useQuery({
    queryKey: ["practicas-catalogo", mostrarTodas],
    queryFn: () => getPracticasCatalogo(!mostrarTodas),
  });

  const crearMutation = useMutation({
    mutationFn: (f: FormData) =>
      crearPracticaCatalogo({
        ...f,
        modalidadDicom: f.modalidadDicom || null,
        sortOrder: parseInt(f.sortOrder) || 0,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["practicas-catalogo"] });
      setDialog(null);
      toast({ title: "Práctica creada" });
    },
    onError: (e: Error) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  const editarMutation = useMutation({
    mutationFn: ({ id, f }: { id: number; f: FormData }) =>
      actualizarPracticaCatalogo(id, {
        ...f,
        modalidadDicom: f.modalidadDicom || null,
        sortOrder: parseInt(f.sortOrder) || 0,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["practicas-catalogo"] });
      setDialog(null);
      toast({ title: "Práctica actualizada" });
    },
    onError: (e: Error) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  const desactivarMutation = useMutation({
    mutationFn: (id: number) => desactivarPracticaCatalogo(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["practicas-catalogo"] });
      toast({ title: "Práctica desactivada" });
    },
    onError: (e: Error) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  function abrirCrear() {
    setForm(EMPTY_FORM);
    setDialog({ mode: "crear" });
  }

  function abrirEditar(p: PracticaCatalogo) {
    setForm(fromPractica(p));
    setDialog({ mode: "editar", practica: p });
  }

  function handleSubmit() {
    if (!form.codigo || !form.nombre) {
      toast({ title: "Código y nombre son obligatorios", variant: "destructive" });
      return;
    }
    if (dialog?.mode === "crear") {
      crearMutation.mutate(form);
    } else if (dialog?.practica) {
      editarMutation.mutate({ id: dialog.practica.id, f: form });
    }
  }

  function set<K extends keyof FormData>(k: K, v: FormData[K]) {
    setForm((f) => ({ ...f, [k]: v }));
  }

  const practicas = data?.practicas ?? [];
  const isPending = crearMutation.isPending || editarMutation.isPending;

  return (
    <div className="p-6 space-y-5">
      {/* Header */}
      <div className="flex items-center gap-3">
        <Link href="/configuracion">
          <Button variant="ghost" size="icon">
            <ArrowLeft className="h-4 w-4" />
          </Button>
        </Link>
        <div className="flex-1">
          <h1 className="text-2xl font-bold text-foreground flex items-center gap-2">
            <FlaskConical className="h-6 w-6 text-blue-600" />
            Catálogo de prácticas
          </h1>
          <p className="text-sm text-muted-foreground">
            Administrá los estudios disponibles para generar órdenes. Las prácticas con DICOM van a DiagnosticPACS.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-2 text-sm text-muted-foreground cursor-pointer">
            <Switch checked={mostrarTodas} onCheckedChange={setMostrarTodas} />
            Mostrar inactivas
          </label>
          <Button className="gap-2" onClick={abrirCrear}>
            <Plus className="h-4 w-4" />
            Nueva práctica
          </Button>
        </div>
      </div>

      {/* Tabla */}
      <div className="border rounded-lg overflow-hidden bg-card">
        <Table>
          <TableHeader>
            <TableRow className="bg-muted">
              <TableHead className="w-10">#</TableHead>
              <TableHead className="w-32">Código</TableHead>
              <TableHead>Nombre</TableHead>
              <TableHead className="w-32">Especialidad</TableHead>
              <TableHead className="w-20">Modalidad</TableHead>
              <TableHead className="w-20 text-center">DICOM</TableHead>
              <TableHead className="w-20 text-center">PACS</TableHead>
              <TableHead className="w-20 text-center">Estado</TableHead>
              <TableHead className="w-20" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow>
                <TableCell colSpan={9} className="text-center py-10 text-muted-foreground/70">
                  <Loader2 className="h-5 w-5 animate-spin mx-auto" />
                </TableCell>
              </TableRow>
            ) : practicas.length === 0 ? (
              <TableRow>
                <TableCell colSpan={9} className="text-center py-10 text-muted-foreground/70">
                  No hay prácticas cargadas
                </TableCell>
              </TableRow>
            ) : (
              practicas.map((p) => (
                <TableRow key={p.id} className={p.activo ? "" : "opacity-50"}>
                  <TableCell className="text-xs text-muted-foreground/70">{p.sortOrder}</TableCell>
                  <TableCell className="font-mono text-xs text-muted-foreground">{p.codigo}</TableCell>
                  <TableCell>
                    <div className="font-medium text-sm">{p.nombre}</div>
                    {p.preparacion && (
                      <div className="text-xs text-muted-foreground/70 truncate max-w-xs">{p.preparacion}</div>
                    )}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">{p.especialidad}</TableCell>
                  <TableCell>
                    {p.modalidadDicom ? (
                      <Badge variant="outline" className="font-mono text-xs">{p.modalidadDicom}</Badge>
                    ) : <span className="text-muted-foreground/70">—</span>}
                  </TableCell>
                  <TableCell className="text-center">
                    {p.generaDicom ? (
                      <span className="text-green-600 text-xs font-medium">Sí</span>
                    ) : (
                      <span className="text-muted-foreground/70 text-xs">No</span>
                    )}
                  </TableCell>
                  <TableCell className="text-center">
                    {p.usaWorkspacePacs ? (
                      <span className="text-blue-600 text-xs font-medium">Sí</span>
                    ) : (
                      <span className="text-muted-foreground/70 text-xs">No</span>
                    )}
                  </TableCell>
                  <TableCell className="text-center">
                    <Badge variant={p.activo ? "default" : "secondary"} className="text-xs">
                      {p.activo ? "Activa" : "Inactiva"}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <div className="flex gap-1">
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7"
                        onClick={() => abrirEditar(p)}
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </Button>
                      {p.activo && (
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7 text-red-400 hover:text-red-600"
                          onClick={() => desactivarMutation.mutate(p.id)}
                          disabled={desactivarMutation.isPending}
                        >
                          <Power className="h-3.5 w-3.5" />
                        </Button>
                      )}
                    </div>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      {/* Dialog crear/editar */}
      <Dialog open={dialog !== null} onOpenChange={(open) => { if (!open) setDialog(null); }}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>
              {dialog?.mode === "crear" ? "Nueva práctica" : "Editar práctica"}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4 max-h-[70vh] overflow-y-auto pr-1">
            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label>Código único *</Label>
                <Input
                  placeholder="ECG-REPOSO"
                  value={form.codigo}
                  onChange={(e) => set("codigo", e.target.value.toUpperCase())}
                  disabled={dialog?.mode === "editar"}
                />
              </div>
              <div>
                <Label>Especialidad *</Label>
                <Input
                  placeholder="CARDIOLOGIA"
                  value={form.especialidad}
                  onChange={(e) => set("especialidad", e.target.value.toUpperCase())}
                />
              </div>
            </div>
            <div>
              <Label>Nombre *</Label>
              <Input
                placeholder="ECG de reposo"
                value={form.nombre}
                onChange={(e) => set("nombre", e.target.value)}
              />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label>Modalidad DICOM</Label>
                <Input
                  placeholder="ECG, US, OT..."
                  value={form.modalidadDicom}
                  onChange={(e) => set("modalidadDicom", e.target.value.toUpperCase())}
                />
              </div>
              <div>
                <Label>Orden de aparición</Label>
                <Input
                  type="number"
                  value={form.sortOrder}
                  onChange={(e) => set("sortOrder", e.target.value)}
                />
              </div>
            </div>

            <div className="space-y-2">
              <div className="flex items-center justify-between py-1">
                <Label className="cursor-pointer">Genera DICOM → enviar a DiagnosticPACS</Label>
                <Switch checked={form.generaDicom} onCheckedChange={(v) => set("generaDicom", v)} />
              </div>
              <div className="flex items-center justify-between py-1">
                <Label className="cursor-pointer">Usa workspace PACS para el informe</Label>
                <Switch checked={form.usaWorkspacePacs} onCheckedChange={(v) => set("usaWorkspacePacs", v)} />
              </div>
              <div className="flex items-center justify-between py-1">
                <Label className="cursor-pointer">Requiere TOKEN Klinicos</Label>
                <Switch checked={form.requiereTokenKlinicos} onCheckedChange={(v) => set("requiereTokenKlinicos", v)} />
              </div>
              <div className="flex items-center justify-between py-1">
                <Label className="cursor-pointer">Requiere región</Label>
                <Switch checked={form.requiereRegion} onCheckedChange={(v) => set("requiereRegion", v)} />
              </div>
              <div className="flex items-center justify-between py-1">
                <Label className="cursor-pointer">Requiere lateralidad</Label>
                <Switch checked={form.requiereLateralidad} onCheckedChange={(v) => set("requiereLateralidad", v)} />
              </div>
            </div>

            <div>
              <Label>Preparación del paciente</Label>
              <Textarea
                placeholder="Instrucciones de preparación..."
                rows={2}
                value={form.preparacion}
                onChange={(e) => set("preparacion", e.target.value)}
              />
            </div>
            <div>
              <Label>Requisitos de documentación</Label>
              <Textarea
                placeholder="Documentos o estudios previos necesarios..."
                rows={2}
                value={form.requisitosDocumentacion}
                onChange={(e) => set("requisitosDocumentacion", e.target.value)}
              />
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setDialog(null)}>Cancelar</Button>
            <Button onClick={handleSubmit} disabled={isPending}>
              {isPending ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : null}
              {dialog?.mode === "crear" ? "Crear práctica" : "Guardar cambios"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
