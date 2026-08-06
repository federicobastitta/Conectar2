import { useState, useEffect } from "react";
import { useLocation } from "wouter";
import { useQuery, useMutation } from "@tanstack/react-query";
import {
  getPracticasCatalogo,
  crearOrdenPractica,
  type PracticaCatalogo,
  type CrearOrdenBody,
} from "@/api/ordenes-practicas";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PasswordInput } from "@/components/ui/password-input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { ArrowLeft, Loader2, ClipboardPlus, AlertCircle, FileText } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";

// Campos del formulario
interface FormState {
  practicaId: string;
  patientId: string;
  professionalId: string;
  sedeId: string;
  motivoClinico: string;
  diagnosticoCie10: string;
  region: string;
  lateralidad: string;
  observaciones: string;
  fechaOrden: string;
  fechaRealizacionEstimada: string;
  coberturaObra: string;
  coberturaPlan: string;
  coberturaNumeroAfiliado: string;
  prioridad: "normal" | "urgente" | "programada";
  token: string;
}

const INIT_FORM: FormState = {
  practicaId: "",
  patientId: "",
  professionalId: "",
  sedeId: "",
  motivoClinico: "",
  diagnosticoCie10: "",
  region: "",
  lateralidad: "",
  observaciones: "",
  fechaOrden: new Date().toISOString().split("T")[0],
  fechaRealizacionEstimada: "",
  coberturaObra: "",
  coberturaPlan: "",
  coberturaNumeroAfiliado: "",
  prioridad: "normal",
  token: "",
};

export default function NuevaOrden() {
  const [, nav] = useLocation();
  const [form, setForm] = useState<FormState>(INIT_FORM);
  const [errors, setErrors] = useState<Partial<Record<keyof FormState, string>>>({});

  // Datos auxiliares
  const [pacienteNombre, setPacienteNombre] = useState("");
  // ID interno del paciente encontrado por DNI (el campo del form es el DNI).
  const [pacienteIdEncontrado, setPacienteIdEncontrado] = useState<number | null>(null);
  const [profesionalNombre, setProfesionalNombre] = useState("");

  const { toast } = useToast();
  const { data: practicasData, isLoading: cargandoPracticas } = useQuery({
    queryKey: ["practicas-catalogo"],
    queryFn: () => getPracticasCatalogo(true),
  });

  const practicaSeleccionada: PracticaCatalogo | undefined = practicasData?.practicas.find(
    (p) => String(p.id) === form.practicaId,
  );

  // Buscar paciente por DNI al cambiar el campo
  useEffect(() => {
    const dni = form.patientId.trim();
    setPacienteIdEncontrado(null);
    if (!dni || dni.length < 6) { setPacienteNombre(""); return; }
    const token = localStorage.getItem("auth_token") ?? "";
    fetch(`/api/pacientes?dni=${encodeURIComponent(dni)}&limit=1`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then((r) => r.ok ? r.json() : null)
      .then((d: { data?: { id: number; nombre?: string; apellido?: string; cobertura?: string; planCobertura?: string; nroAfiliado?: string }[] } | null) => {
        const p = d?.data?.[0];
        if (p) {
          setPacienteIdEncontrado(p.id);
          setPacienteNombre(`${p.apellido ?? ""}, ${p.nombre ?? ""}`.trim());
          if (!form.coberturaObra && p.cobertura) {
            setForm((f) => ({
              ...f,
              coberturaObra: p.cobertura ?? "",
              coberturaPlan: p.planCobertura ?? "",
              coberturaNumeroAfiliado: p.nroAfiliado ?? "",
            }));
          }
        } else {
          setPacienteNombre("Paciente no encontrado");
        }
      })
      .catch(() => setPacienteNombre(""));
  }, [form.patientId]);

  // Buscar profesional por ID
  useEffect(() => {
    const id = parseInt(form.professionalId);
    if (!id) { setProfesionalNombre(""); return; }
    const token = localStorage.getItem("auth_token") ?? "";
    fetch(`/api/profesionales/${id}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then((r) => r.ok ? r.json() : null)
      .then((d: { profesional?: { nombre?: string; apellido?: string; matricula?: string } } | null) => {
        if (d?.profesional) {
          const p = d.profesional;
          setProfesionalNombre(
            `Dr/a. ${p.apellido ?? ""}, ${p.nombre ?? ""} — Mat. ${p.matricula ?? "(sin matrícula)"}`.trim(),
          );
        } else {
          setProfesionalNombre("Profesional no encontrado");
        }
      })
      .catch(() => setProfesionalNombre(""));
  }, [form.professionalId]);

  function set(field: keyof FormState, value: string) {
    setForm((f) => ({ ...f, [field]: value }));
    setErrors((e) => ({ ...e, [field]: undefined }));
  }

  function validate(): boolean {
    const e: Partial<Record<keyof FormState, string>> = {};
    if (!form.practicaId) e.practicaId = "Seleccioná una práctica";
    if (!form.patientId.trim()) e.patientId = "DNI del paciente requerido";
    else if (pacienteIdEncontrado == null) e.patientId = "No se encontró un paciente con ese DNI";
    if (!form.professionalId || isNaN(parseInt(form.professionalId))) e.professionalId = "ID de profesional requerido";
    if (!form.motivoClinico || form.motivoClinico.trim().length < 5) e.motivoClinico = "Motivo clínico requerido (mín. 5 caracteres)";
    if (!form.fechaOrden || !/^\d{4}-\d{2}-\d{2}$/.test(form.fechaOrden)) e.fechaOrden = "Fecha requerida (YYYY-MM-DD)";
    if (practicaSeleccionada?.requiereRegion && !form.region) e.region = "Región requerida para esta práctica";
    if (practicaSeleccionada?.requiereLateralidad && !form.lateralidad) e.lateralidad = "Lateralidad requerida";
    if (practicaSeleccionada?.requiereTokenKlinicos && !form.token.trim()) e.token = "TOKEN Klinicos requerido para esta práctica";
    setErrors(e);
    return Object.keys(e).length === 0;
  }

  const [previsualizando, setPrevisualizando] = useState(false);

  function armarBody(): CrearOrdenBody {
    return {
      practicaId: parseInt(form.practicaId),
      patientId: pacienteIdEncontrado!,
      professionalId: parseInt(form.professionalId),
      sedeId: form.sedeId ? parseInt(form.sedeId) : undefined,
      motivoClinico: form.motivoClinico.trim(),
      diagnosticoCie10: form.diagnosticoCie10.trim() || undefined,
      region: form.region.trim() || undefined,
      lateralidad: form.lateralidad.trim() || undefined,
      observaciones: form.observaciones.trim() || undefined,
      fechaOrden: form.fechaOrden,
      fechaRealizacionEstimada: form.fechaRealizacionEstimada || undefined,
      coberturaObra: form.coberturaObra.trim() || undefined,
      coberturaPlan: form.coberturaPlan.trim() || undefined,
      coberturaNumeroAfiliado: form.coberturaNumeroAfiliado.trim() || undefined,
      prioridad: form.prioridad,
      token: form.token.trim() || undefined,
    };
  }

  async function verVistaPrevia() {
    if (!validate()) return;
    setPrevisualizando(true);
    try {
      const token = localStorage.getItem("auth_token") ?? "";
      const res = await fetch("/api/ordenes-practicas/preview-pdf", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify(armarBody()),
      });
      if (!res.ok) {
        const cuerpo = await res.json().catch(() => null) as { error?: string } | null;
        throw new Error(cuerpo?.error ?? `No se pudo generar la vista previa (HTTP ${res.status})`);
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      window.open(url, "_blank", "noopener");
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (e) {
      toast({
        title: "Error en la vista previa",
        description: e instanceof Error ? e.message : "Error desconocido",
        variant: "destructive",
      });
    } finally {
      setPrevisualizando(false);
    }
  }

  const mutation = useMutation({
    mutationFn: (body: CrearOrdenBody) => crearOrdenPractica(body),
    onSuccess: (data) => {
      toast({ title: "Orden creada", description: `Nº ${data.orden.numeroOrden}` });
      nav(`/ordenes/${data.orden.id}`);
    },
    onError: (e: Error) =>
      toast({ title: "Error al crear la orden", description: e.message, variant: "destructive" }),
  });

  function handleSubmit(ev: React.FormEvent) {
    ev.preventDefault();
    if (!validate()) return;
    mutation.mutate(armarBody());
  }

  return (
    <div className="p-6 max-w-3xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="icon" onClick={() => nav("/ordenes")}>
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <div>
          <h1 className="text-2xl font-bold text-foreground flex items-center gap-2">
            <ClipboardPlus className="h-6 w-6 text-blue-600" />
            Nueva orden de práctica
          </h1>
          <p className="text-sm text-muted-foreground">El informe es redactado y firmado por DiagnosticPACS</p>
        </div>
      </div>

      <form onSubmit={handleSubmit} className="space-y-5">

        {/* ── Práctica ────────────────────────────────────────── */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Práctica a realizar</CardTitle>
            <CardDescription>Seleccioná el estudio del catálogo de cardiología</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <Label>Práctica *</Label>
              {cargandoPracticas ? (
                <div className="flex items-center gap-2 text-sm text-muted-foreground/70 mt-1">
                  <Loader2 className="h-4 w-4 animate-spin" /> Cargando...
                </div>
              ) : (
                <Select value={form.practicaId} onValueChange={(v) => set("practicaId", v)}>
                  <SelectTrigger className={errors.practicaId ? "border-red-500" : ""}>
                    <SelectValue placeholder="Seleccioná la práctica..." />
                  </SelectTrigger>
                  <SelectContent>
                    {practicasData?.practicas.map((p) => (
                      <SelectItem key={p.id} value={String(p.id)}>
                        <div className="flex items-center gap-2">
                          <span>{p.nombre}</span>
                          {p.modalidadDicom && (
                            <Badge variant="outline" className="text-xs font-mono">
                              {p.modalidadDicom}
                            </Badge>
                          )}
                        </div>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
              {errors.practicaId && <p className="text-xs text-red-500 mt-1">{errors.practicaId}</p>}
            </div>

            {practicaSeleccionada?.preparacion && (
              <Alert className="bg-blue-50 border-blue-200">
                <AlertCircle className="h-4 w-4 text-blue-600" />
                <AlertDescription className="text-blue-800 text-sm">
                  <strong>Preparación:</strong> {practicaSeleccionada.preparacion}
                </AlertDescription>
              </Alert>
            )}

            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label>Prioridad</Label>
                <Select value={form.prioridad} onValueChange={(v) => set("prioridad", v as FormState["prioridad"])}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="normal">Normal</SelectItem>
                    <SelectItem value="urgente">Urgente</SelectItem>
                    <SelectItem value="programada">Programada</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label>Fecha de orden *</Label>
                <Input
                  type="date"
                  value={form.fechaOrden}
                  onChange={(e) => set("fechaOrden", e.target.value)}
                  className={errors.fechaOrden ? "border-red-500" : ""}
                />
                {errors.fechaOrden && <p className="text-xs text-red-500 mt-1">{errors.fechaOrden}</p>}
              </div>
            </div>

            {(practicaSeleccionada?.requiereRegion || practicaSeleccionada?.requiereLateralidad) && (
              <div className="grid grid-cols-2 gap-4">
                {practicaSeleccionada.requiereRegion && (
                  <div>
                    <Label>Región *</Label>
                    <Input
                      placeholder="Ej: Miembro superior izquierdo"
                      value={form.region}
                      onChange={(e) => set("region", e.target.value)}
                      className={errors.region ? "border-red-500" : ""}
                    />
                    {errors.region && <p className="text-xs text-red-500 mt-1">{errors.region}</p>}
                  </div>
                )}
                {practicaSeleccionada.requiereLateralidad && (
                  <div>
                    <Label>Lateralidad *</Label>
                    <Select value={form.lateralidad} onValueChange={(v) => set("lateralidad", v)}>
                      <SelectTrigger className={errors.lateralidad ? "border-red-500" : ""}>
                        <SelectValue placeholder="Seleccioná..." />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="derecho">Derecho</SelectItem>
                        <SelectItem value="izquierdo">Izquierdo</SelectItem>
                        <SelectItem value="bilateral">Bilateral</SelectItem>
                      </SelectContent>
                    </Select>
                    {errors.lateralidad && <p className="text-xs text-red-500 mt-1">{errors.lateralidad}</p>}
                  </div>
                )}
              </div>
            )}
          </CardContent>
        </Card>

        {/* ── Paciente ─────────────────────────────────────────── */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Paciente</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div>
              <Label>DNI del paciente *</Label>
              <Input
                inputMode="numeric"
                placeholder="Ej: 29077477"
                value={form.patientId}
                onChange={(e) => set("patientId", e.target.value.replace(/\D/g, ""))}
                className={errors.patientId ? "border-red-500" : ""}
              />
              {pacienteNombre && (
                <p className={`text-xs mt-1 font-medium ${pacienteIdEncontrado != null ? "text-green-700" : "text-red-600"}`}>
                  {pacienteNombre}
                </p>
              )}
              {errors.patientId && <p className="text-xs text-red-500 mt-1">{errors.patientId}</p>}
            </div>
            <div className="grid grid-cols-3 gap-3">
              <div>
                <Label>Obra social</Label>
                <Input
                  placeholder="OSDE, PAMI..."
                  value={form.coberturaObra}
                  onChange={(e) => set("coberturaObra", e.target.value)}
                />
              </div>
              <div>
                <Label>Plan</Label>
                <Input
                  placeholder="210, 310..."
                  value={form.coberturaPlan}
                  onChange={(e) => set("coberturaPlan", e.target.value)}
                />
              </div>
              <div>
                <Label>Nº afiliado</Label>
                <Input
                  placeholder="123456"
                  value={form.coberturaNumeroAfiliado}
                  onChange={(e) => set("coberturaNumeroAfiliado", e.target.value)}
                />
              </div>
            </div>
          </CardContent>
        </Card>

        {/* ── Profesional solicitante ──────────────────────────── */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Profesional solicitante</CardTitle>
            <CardDescription>El médico que indica la práctica (debe tener matrícula registrada)</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div>
              <Label>ID de profesional *</Label>
              <Input
                type="number"
                placeholder="Ej: 3"
                value={form.professionalId}
                onChange={(e) => set("professionalId", e.target.value)}
                className={errors.professionalId ? "border-red-500" : ""}
              />
              {profesionalNombre && (
                <p className="text-xs text-green-700 mt-1 font-medium">{profesionalNombre}</p>
              )}
              {errors.professionalId && <p className="text-xs text-red-500 mt-1">{errors.professionalId}</p>}
            </div>
          </CardContent>
        </Card>

        {/* ── Clínica ───────────────────────────────────────────── */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Datos clínicos</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <Label>Motivo clínico *</Label>
              <Textarea
                placeholder="Describí el motivo del estudio..."
                rows={3}
                value={form.motivoClinico}
                onChange={(e) => set("motivoClinico", e.target.value)}
                className={errors.motivoClinico ? "border-red-500" : ""}
              />
              {errors.motivoClinico && <p className="text-xs text-red-500 mt-1">{errors.motivoClinico}</p>}
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label>Diagnóstico CIE-10</Label>
                <Input
                  placeholder="Ej: I10"
                  value={form.diagnosticoCie10}
                  onChange={(e) => set("diagnosticoCie10", e.target.value)}
                />
              </div>
              <div>
                <Label>Fecha estimada de realización</Label>
                <Input
                  type="date"
                  value={form.fechaRealizacionEstimada}
                  onChange={(e) => set("fechaRealizacionEstimada", e.target.value)}
                />
              </div>
            </div>
            <div>
              <Label>Observaciones</Label>
              <Textarea
                placeholder="Notas adicionales para el técnico..."
                rows={2}
                value={form.observaciones}
                onChange={(e) => set("observaciones", e.target.value)}
              />
            </div>
          </CardContent>
        </Card>

        {/* ── TOKEN Klinicos (solo si la práctica lo requiere) ─── */}
        {practicaSeleccionada?.requiereTokenKlinicos && (
          <Card className="border-amber-200 bg-amber-50">
            <CardHeader className="pb-3">
              <CardTitle className="text-base text-amber-900">Validación Klinicos</CardTitle>
              <CardDescription className="text-amber-700">
                Esta práctica requiere TOKEN de autorización Klinicos antes de emitir la orden.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div>
                <Label>TOKEN Klinicos *</Label>
                <PasswordInput
                  placeholder="TOKEN entregado por la obra social..."
                  value={form.token}
                  onChange={(e) => set("token", e.target.value)}
                  className={errors.token ? "border-red-500" : ""}
                  autoComplete="off"
                />
                {errors.token && <p className="text-xs text-red-500 mt-1">{errors.token}</p>}
                <p className="text-xs text-amber-600 mt-1.5">
                  El TOKEN no se almacena en claro. Se envía al Robot de validación y se persiste solo enmascarado.
                </p>
              </div>
            </CardContent>
          </Card>
        )}

        {/* ── Acciones ──────────────────────────────────────────── */}
        <div className="flex justify-end gap-3 pt-2">
          <Button type="button" variant="outline" onClick={() => nav("/ordenes")}>
            Cancelar
          </Button>
          <Button
            type="button"
            variant="outline"
            onClick={verVistaPrevia}
            disabled={previsualizando || mutation.isPending}
            className="gap-2"
            data-testid="button-vista-previa-orden"
          >
            {previsualizando ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileText className="h-4 w-4" />}
            Ver vista previa
          </Button>
          <Button type="submit" disabled={mutation.isPending} className="gap-2 min-w-40">
            {mutation.isPending ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                Emitiendo...
              </>
            ) : (
              <>
                <ClipboardPlus className="h-4 w-4" />
                Emitir orden
              </>
            )}
          </Button>
        </div>
      </form>
    </div>
  );
}
