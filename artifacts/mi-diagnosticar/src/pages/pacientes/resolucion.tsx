import { useState } from "react";
import { useQueryClient, useQuery } from "@tanstack/react-query";
import { getPracticasCatalogo, type PracticaCatalogo } from "@/api/ordenes-practicas";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  useGetPaciente,
  useUpdatePaciente,
  getGetPacienteQueryKey,
  useGetPatientPrescriptions,
  useGetPatientReferrals,
  useListEspecialidades,
  useGetPatientCertificates,
  useGetPatientStudyOrders,
  useGetPatientTimeline,
  useCreateConsultorioPrescription,
  useCreateReferral,
  useCreateCertificate,
  useRevocarCertificate,
  useGetCertificateVerificaciones,
  useCreateIndicacion,
  useGetPatientIndicaciones,
  getGetPatientIndicacionesQueryKey,
  useCreateStudyOrder,
  createStudyOrder,
  useGenerarResumenHc,
  generarResumenHc,
  useGetClinicalAiSuggestions,
  useGeneratePdf,
  useListProfesionales,
  getGetPatientPrescriptionsQueryKey,
  getGetPatientReferralsQueryKey,
  getGetPatientCertificatesQueryKey,
  getGetPatientStudyOrdersQueryKey,
  getGetPatientTimelineQueryKey,
  type RecetaConsultorio,
  type Derivacion,
  type Certificado,
  type CertificadoVerificacion,
  type Indicacion,
  type OrdenEstudio,
  type ClinicalAiResponse,
  type PdfGenerateInputSourceType,
} from "@workspace/api-client-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { TextareaAutocompletado, ESTUDIOS_FRECUENTES, JUSTIFICACIONES_FRECUENTES } from "@/components/textarea-autocompletado";
import { Command, CommandEmpty, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { DerivacionEstadoControl, DerivacionEstadoBadge } from "@/pages/pacientes/derivacion-estado";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/hooks/use-auth";
import {
  Pill,
  Send,
  FileDown,
  FileText,
  FlaskConical,
  Award,
  Sparkles,
  Loader2,
  Stethoscope,
  ClipboardList,
  History,
  ChevronsUpDown,
  Check,
  Scan,
} from "lucide-react";
import { format } from "date-fns";
import { es } from "date-fns/locale";
import { OrdenEstadoControl } from "./orden-estado";

function fechaCorta(value?: string | null) {
  if (!value) return "";
  const d = new Date(value);
  return isNaN(d.getTime()) ? value : format(d, "d MMM yyyy HH:mm", { locale: es });
}

function haceRelativo(value?: string | null) {
  if (!value) return "";
  const d = new Date(value);
  if (isNaN(d.getTime())) return "";
  const min = Math.floor((Date.now() - d.getTime()) / 60000);
  if (min < 1) return "recién";
  if (min < 60) return `hace ${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return `hace ${h} h`;
  const dias = Math.floor(h / 24);
  return dias === 1 ? "hace 1 día" : `hace ${dias} días`;
}

const ESTADO_DOC_COLORS: Record<string, string> = {
  emitida: "bg-green-100 text-green-800",
  realizada: "bg-blue-100 text-blue-800",
  anulada: "bg-red-100 text-red-700",
};

function EstadoDocBadge({ estado }: { estado?: string | null }) {
  if (!estado) return null;
  return (
    <Badge variant="secondary" className={`${ESTADO_DOC_COLORS[estado] ?? "bg-muted text-muted-foreground"} border-0 capitalize text-xs`}>
      {estado}
    </Badge>
  );
}

// ── Descarga de PDF con auth ────────────────────────────────────────────────

async function descargarPdf(downloadUrl: string, nombre: string) {
  const token = typeof window !== "undefined" ? localStorage.getItem("auth_token") : null;
  const res = await fetch(downloadUrl, {
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
  });
  if (!res.ok) throw new Error(`No se pudo descargar el PDF (HTTP ${res.status})`);
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${nombre}.pdf`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

function BotonPdf({ sourceType, sourceId, nombre }: {
  sourceType: PdfGenerateInputSourceType;
  sourceId: number;
  nombre: string;
}) {
  const { toast } = useToast();
  const [descargando, setDescargando] = useState(false);
  const generar = useGeneratePdf();

  const onClick = async () => {
    setDescargando(true);
    try {
      const doc = await generar.mutateAsync({ data: { sourceType, sourceId } });
      await descargarPdf(doc.downloadUrl, nombre);
    } catch (e) {
      toast({
        title: "Error al generar el PDF",
        description: e instanceof Error ? e.message : "Error desconocido",
        variant: "destructive",
      });
    } finally {
      setDescargando(false);
    }
  };

  return (
    <Button size="sm" variant="outline" onClick={onClick} disabled={descargando} className="gap-1 shrink-0">
      {descargando ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <FileDown className="w-3.5 h-3.5" />}
      PDF
    </Button>
  );
}

// ── Selector de profesional (solo admin) ────────────────────────────────────

function SelectorProfesional({ value, onChange, etiqueta = "Profesional emisor" }: { value: string; onChange: (v: string) => void; etiqueta?: string }) {
  const { data } = useListProfesionales();
  const profesionales = data ?? [];
  return (
    <div>
      <Label className="text-xs text-muted-foreground">{etiqueta} *</Label>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger><SelectValue placeholder="Seleccionar profesional" /></SelectTrigger>
        <SelectContent>
          {profesionales.map((p) => (
            <SelectItem key={p.id} value={String(p.id)}>
              {p.apellido}, {p.nombre}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

// ¿El médico logueado tiene su firma escaneada cargada? (null = todavía no se sabe)
function useFirmaPropiaFaltante(): boolean {
  const { user } = useAuth();
  const u = user as { rol?: string; profesionalId?: number | null } | undefined;
  const profesionalId = u?.rol === "medico" ? u?.profesionalId : null;
  const { data } = useQuery({
    queryKey: ["firma-propia", profesionalId],
    enabled: profesionalId != null,
    staleTime: 5 * 60_000,
    queryFn: async () => {
      const r = await fetch(`/api/profesionales/${profesionalId}/firma`, {
        headers: { Authorization: `Bearer ${localStorage.getItem("auth_token") ?? ""}` },
        credentials: "include",
      });
      if (!r.ok) return null;
      return (await r.json()) as { firmaImagen: string | null };
    },
  });
  return profesionalId != null && data !== undefined && data !== null && !data.firmaImagen;
}

// Para el médico, el prescriptor es siempre él mismo: se muestra fijo.
function PrescriptorFijo() {
  const { user } = useAuth();
  const { data } = useListProfesionales();
  const sinFirma = useFirmaPropiaFaltante();
  const profesionalId = (user as { profesionalId?: number | null } | undefined)?.profesionalId;
  const prof = (data ?? []).find((p) => p.id === profesionalId);
  if (!prof) return null;
  return (
    <div>
      <Label className="text-xs text-muted-foreground">Profesional prescriptor</Label>
      <p className="text-sm rounded-md border bg-muted/40 px-2 py-1.5 mt-1" data-testid="prescriptor-fijo">
        {prof.apellido}, {prof.nombre}{prof.matricula ? ` — MP ${prof.matricula}` : ""}
      </p>
      {sinFirma && (
        <p className="text-xs rounded-md border border-amber-300 bg-amber-50 dark:border-amber-700 dark:bg-amber-950 text-amber-800 dark:text-amber-200 px-2 py-1.5 mt-1.5" data-testid="aviso-sin-firma">
          No tenés tu firma cargada: la orden va a salir sin firma. Pedí en administración que carguen tu firma escaneada.
        </p>
      )}
    </div>
  );
}

function useEsAdmin() {
  const { user } = useAuth();
  const rol = (user as { rol?: string } | undefined)?.rol;
  return {
    esAdmin: rol === "admin",
    puedeEmitir: rol === "admin" || rol === "medico",
    // Roles de gestión: auditoría de verificaciones públicas de certificados
    esGestion: rol === "admin" || rol === "gerente" || rol === "desarrollador",
  };
}

// ── Recetas ─────────────────────────────────────────────────────────────────

export function SeccionRecetas({ pacienteId }: { pacienteId: number }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { esAdmin, puedeEmitir } = useEsAdmin();
  const { data, isLoading } = useGetPatientPrescriptions(pacienteId);
  const [form, setForm] = useState({ medication: "", dosage: "", frequency: "", duration: "", instructions: "", profesionalId: "" });

  const crear = useCreateConsultorioPrescription({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getGetPatientPrescriptionsQueryKey(pacienteId) });
        queryClient.invalidateQueries({ queryKey: getGetPatientTimelineQueryKey(pacienteId) });
        queryClient.invalidateQueries({ queryKey: getGetPatientIndicacionesQueryKey(pacienteId) });
        setForm({ medication: "", dosage: "", frequency: "", duration: "", instructions: "", profesionalId: "" });
        toast({ title: "Receta emitida" });
      },
      onError: (e) => toast({ title: "Error al emitir la receta", description: e.message, variant: "destructive" }),
    },
  });

  const emitir = () => {
    if (!form.medication.trim()) {
      toast({ title: "Ingresá el medicamento", variant: "destructive" });
      return;
    }
    if (esAdmin && !form.profesionalId) {
      toast({ title: "Seleccioná el profesional emisor", variant: "destructive" });
      return;
    }
    crear.mutate({
      data: {
        patientId: pacienteId,
        ...(esAdmin && form.profesionalId ? { profesionalId: Number(form.profesionalId) } : {}),
        medication: form.medication.trim(),
        ...(form.dosage.trim() ? { dosage: form.dosage.trim() } : {}),
        ...(form.frequency.trim() ? { frequency: form.frequency.trim() } : {}),
        ...(form.duration.trim() ? { duration: form.duration.trim() } : {}),
        ...(form.instructions.trim() ? { instructions: form.instructions.trim() } : {}),
      },
    });
  };

  const recetas: RecetaConsultorio[] = data ?? [];

  return (
    <div className="space-y-4">
      {puedeEmitir && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2"><Pill className="w-4 h-4 text-primary" /> Nueva receta</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {esAdmin && <SelectorProfesional value={form.profesionalId} onChange={(v) => setForm({ ...form, profesionalId: v })} />}
            <div className="grid sm:grid-cols-2 gap-3">
              <div>
                <Label className="text-xs text-muted-foreground">Medicamento *</Label>
                <Input value={form.medication} onChange={(e) => setForm({ ...form, medication: e.target.value })} placeholder="Ej: Ibuprofeno 400mg" />
              </div>
              <div>
                <Label className="text-xs text-muted-foreground">Dosis</Label>
                <Input value={form.dosage} onChange={(e) => setForm({ ...form, dosage: e.target.value })} placeholder="Ej: 1 comprimido" />
              </div>
              <div>
                <Label className="text-xs text-muted-foreground">Frecuencia</Label>
                <Input value={form.frequency} onChange={(e) => setForm({ ...form, frequency: e.target.value })} placeholder="Ej: cada 8 horas" />
              </div>
              <div>
                <Label className="text-xs text-muted-foreground">Duración</Label>
                <Input value={form.duration} onChange={(e) => setForm({ ...form, duration: e.target.value })} placeholder="Ej: 5 días" />
              </div>
            </div>
            <div>
              <Label className="text-xs text-muted-foreground">Indicaciones</Label>
              <Textarea value={form.instructions} onChange={(e) => setForm({ ...form, instructions: e.target.value })} placeholder="Indicaciones para el paciente" rows={2} />
            </div>
            <Button onClick={emitir} disabled={crear.isPending} className="gap-1">
              {crear.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />} Emitir receta
            </Button>
          </CardContent>
        </Card>
      )}

      {isLoading ? (
        <Skeleton className="h-24 w-full" />
      ) : recetas.length === 0 ? (
        <p className="text-sm text-muted-foreground text-center py-4">Sin recetas emitidas.</p>
      ) : (
        <div className="space-y-2">
          {recetas.map((r) => (
            <Card key={r.id}>
              <CardContent className="p-3 flex flex-wrap items-center gap-2">
                <Pill className="w-4 h-4 text-primary shrink-0" />
                <div className="flex-1 min-w-40">
                  <p className="text-sm font-medium">{r.medication}</p>
                  <p className="text-xs text-muted-foreground">
                    {[r.dosage, r.frequency, r.duration].filter(Boolean).join(" · ") || "—"} · {fechaCorta(r.createdAt)}
                  </p>
                </div>
                <EstadoDocBadge estado={r.status} />
                <BotonPdf sourceType="receta" sourceId={r.id} nombre={`receta-${r.id}`} />
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Derivaciones ────────────────────────────────────────────────────────────

export function SeccionDerivaciones({ pacienteId }: { pacienteId: number }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { esAdmin, puedeEmitir } = useEsAdmin();
  const { data, isLoading } = useGetPatientReferrals(pacienteId);
  const { data: especialidades } = useListEspecialidades();
  const { user } = useAuth();
  const [form, setForm] = useState({ targetSpecialty: "", reason: "", priority: "normal", observations: "", profesionalId: "" });

  // El médico solo puede gestionar el estado de sus propias derivaciones
  // (espejo del permiso del backend); admin y recepción, todas.
  const puedeGestionarDerivacion = (d: Derivacion) => {
    const u = user as { rol?: string; profesionalId?: number | null } | undefined;
    if (!u?.rol) return false;
    if (u.rol === "medico") return d.professionalId === u.profesionalId;
    return u.rol === "admin" || u.rol === "recepcionista";
  };

  const crear = useCreateReferral({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getGetPatientReferralsQueryKey(pacienteId) });
        queryClient.invalidateQueries({ queryKey: getGetPatientTimelineQueryKey(pacienteId) });
        queryClient.invalidateQueries({ queryKey: getGetPatientIndicacionesQueryKey(pacienteId) });
        setForm({ targetSpecialty: "", reason: "", priority: "normal", observations: "", profesionalId: "" });
        toast({ title: "Derivación emitida" });
      },
      onError: (e) => toast({ title: "Error al emitir la derivación", description: e.message, variant: "destructive" }),
    },
  });

  const emitir = () => {
    if (!form.targetSpecialty.trim() || !form.reason.trim()) {
      toast({ title: "Completá especialidad y motivo", variant: "destructive" });
      return;
    }
    if (esAdmin && !form.profesionalId) {
      toast({ title: "Seleccioná el profesional emisor", variant: "destructive" });
      return;
    }
    crear.mutate({
      data: {
        patientId: pacienteId,
        ...(esAdmin && form.profesionalId ? { profesionalId: Number(form.profesionalId) } : {}),
        targetSpecialty: form.targetSpecialty.trim(),
        reason: form.reason.trim(),
        priority: form.priority as "normal" | "urgente",
        ...(form.observations.trim() ? { observations: form.observations.trim() } : {}),
      },
    });
  };

  const derivaciones: Derivacion[] = data ?? [];

  return (
    <div className="space-y-4">
      {puedeEmitir && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2"><Send className="w-4 h-4 text-primary" /> Nueva derivación</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {esAdmin && <SelectorProfesional value={form.profesionalId} onChange={(v) => setForm({ ...form, profesionalId: v })} />}
            <div className="grid sm:grid-cols-2 gap-3">
              <div>
                <Label className="text-xs text-muted-foreground">Servicio de la clínica *</Label>
                <Select value={form.targetSpecialty} onValueChange={(v) => setForm({ ...form, targetSpecialty: v })}>
                  <SelectTrigger><SelectValue placeholder="Elegir servicio destino" /></SelectTrigger>
                  <SelectContent>
                    {(especialidades ?? []).map((e) => (
                      <SelectItem key={e.id} value={e.nombre}>{e.nombre}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label className="text-xs text-muted-foreground">Prioridad</Label>
                <Select value={form.priority} onValueChange={(v) => setForm({ ...form, priority: v })}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="normal">Normal</SelectItem>
                    <SelectItem value="urgente">Urgente</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div>
              <Label className="text-xs text-muted-foreground">Motivo *</Label>
              <Textarea value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} placeholder="Motivo de la derivación" rows={2} />
            </div>
            <div>
              <Label className="text-xs text-muted-foreground">Observaciones</Label>
              <Textarea value={form.observations} onChange={(e) => setForm({ ...form, observations: e.target.value })} rows={2} />
            </div>
            <Button onClick={emitir} disabled={crear.isPending} className="gap-1">
              {crear.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />} Emitir derivación
            </Button>
          </CardContent>
        </Card>
      )}

      {isLoading ? (
        <Skeleton className="h-24 w-full" />
      ) : derivaciones.length === 0 ? (
        <p className="text-sm text-muted-foreground text-center py-4">Sin derivaciones emitidas.</p>
      ) : (
        <div className="space-y-2">
          {derivaciones.map((d) => (
            <Card key={d.id}>
              <CardContent className="p-3 flex flex-wrap items-center gap-2">
                <Send className="w-4 h-4 text-primary shrink-0" />
                <div className="flex-1 min-w-40">
                  <p className="text-sm font-medium">Derivación a {d.targetSpecialty}</p>
                  <p className="text-xs text-muted-foreground">{d.reason} · {fechaCorta(d.createdAt)}</p>
                </div>
                {d.priority === "urgente" && <Badge variant="destructive" className="text-xs">Urgente</Badge>}
                {puedeGestionarDerivacion(d) ? (
                  <DerivacionEstadoControl
                    derivacion={d}
                    onChanged={() => queryClient.invalidateQueries({ queryKey: getGetPatientReferralsQueryKey(pacienteId) })}
                  />
                ) : (
                  <DerivacionEstadoBadge estado={d.status} />
                )}
                <BotonPdf sourceType="derivacion" sourceId={d.id} nombre={`derivacion-${d.id}`} />
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Certificados ────────────────────────────────────────────────────────────

const TIPOS_CERTIFICADO = [
  { value: "reposo", label: "Reposo" },
  { value: "aptitud", label: "Aptitud física" },
  { value: "asistencia", label: "Asistencia" },
  { value: "otro", label: "Otro" },
];

// ── Certificados de guardia: protocolo institucional Diagnosticar ──────────
// Cuadros frecuentes con hallazgos que fortalecen el reposo, signos de alarma
// que lo bloquean, y los criterios de decisión (asistencia / 24 h / 48 h).
type CuadroGuardia = {
  value: string;
  label: string;
  hallazgos: string[];
  alarmas: string[];
  criterios: { asistencia: string; h24: string; h48: string };
};

const CUADROS_GUARDIA: CuadroGuardia[] = [
  {
    value: "respiratorio", label: "Respiratorio agudo / fiebre",
    hallazgos: ["Fiebre ≥38°C constatada", "Saturación alterada", "Auscultación patológica", "Test positivo", "Mal estado general", "Odinofagia con fauces congestivas"],
    alarmas: ["Disnea", "Dolor torácico", "SatO₂ baja", "Confusión", "Inmunosupresión", "Embarazo", "Neumonía probable"],
    criterios: { asistencia: "Catarro leve / faringitis leve afebril", h24: "Fiebre documentada o síndrome gripal leve-moderado", h48: "Fiebre persistente, prácticas positivas o contagiosidad" },
  },
  {
    value: "gastro", label: "Gastroenteritis / dolor abdominal leve",
    hallazgos: ["Vómitos o diarrea activos constatados", "Fiebre", "Deshidratación leve", "Dolor a palpación sin defensa", "Intolerancia oral"],
    alarmas: ["Defensa / rebote", "Dolor progresivo", "Melena / hematoquecia", "Deshidratación moderada-severa", "Embarazo", "Anciano frágil"],
    criterios: { asistencia: "Dispepsia o cuadro resuelto, examen normal", h24: "Vómitos/diarrea activos sin alarma, hidratación oral y dieta", h48: "Fiebre, deshidratación leve, síntomas persistentes o práctica positiva" },
  },
  {
    value: "columna", label: "Cervicalgia / dolor de columna",
    hallazgos: ["Contractura palpable + limitación de movilidad", "Radiculalgia con maniobras positivas", "Trauma menor con dolor focal", "Déficit sensitivo leve"],
    alarmas: ["Déficit motor", "Parestesias progresivas", "Fiebre / rigidez meníngea", "Trauma mayor", "Cáncer / inmunosupresión", "Dolor torácico o abdominal asociado"],
    criterios: { asistencia: "Cervicalgia inespecífica leve/crónica, examen normal, movilidad conservada", h24: "Solo con contractura objetiva + limitación moderada y tratamiento indicado", h48: "Excepcional: limitación marcada documentada, trauma menor o radiculalgia/práctica positiva" },
  },
  {
    value: "cefalea", label: "Cefalea / migraña / vértigo",
    hallazgos: ["Migraña típica con fotofobia/vómitos", "Vértigo con nistagmo periférico", "TA elevada sintomática"],
    alarmas: ["Inicio súbito («peor cefalea»)", "Déficit focal", "Confusión", "Fiebre / rigidez nucal", "Trauma", "Embarazo / puerperio"],
    criterios: { asistencia: "Cefalea leve resuelta, examen normal", h24: "Migraña/vértigo que limita actividad pero mejora en guardia", h48: "Síntomas persistentes sin alarma o necesidad de reevaluación" },
  },
  {
    value: "urinario", label: "Urinario / cólico renal",
    hallazgos: ["Sedimento o tira positiva", "Fiebre", "Dolor lumbar / puño-percusión", "Hematuria", "Cólico con requerimiento analgésico"],
    alarmas: ["Fiebre + puño-percusión", "Embarazo", "Monorreno", "Dolor intratable", "Vómitos", "Sepsis / obstrucción probable"],
    criterios: { asistencia: "Cistitis leve o síntomas no confirmados", h24: "Cistitis sintomática o cólico resuelto con tratamiento", h48: "Cólico moderado, fiebre baja controlada o práctica positiva con limitación" },
  },
  {
    value: "orl-piel", label: "ORL / conjuntivitis / piel / alergias",
    hallazgos: ["Conjuntivitis purulenta", "Celulitis localizada", "Otitis aguda dolorosa", "Urticaria extensa", "Fiebre o dolor objetivo"],
    alarmas: ["Anafilaxia", "Edema de glotis", "Celulitis facial / orbitaria", "Pérdida visual", "Fiebre alta", "Inmunosupresión"],
    criterios: { asistencia: "Rinitis/alergia leve o lesión crónica estable", h24: "Conjuntivitis purulenta, otitis dolorosa, urticaria sintomática", h48: "Celulitis localizada, fiebre o contagiosidad con tratamiento iniciado" },
  },
  {
    value: "ansiedad", label: "Ansiedad / crisis de pánico / insomnio agudo",
    hallazgos: ["Crisis observada en guardia", "Taquicardia", "Hiperventilación", "Angustia intensa", "Antecedente compatible"],
    alarmas: ["Ideación suicida", "Psicosis", "Heteroagresividad", "Intoxicación", "Dolor torácico", "Síncope", "Abstinencia"],
    criterios: { asistencia: "Consulta administrativa o síntomas leves resueltos", h24: "Crisis aguda observada, estabilizada, con indicación y contención", h48: "Recurrencia, riesgo psicosocial o necesidad de evaluación especializada" },
  },
  {
    value: "otro", label: "Otro cuadro",
    hallazgos: ["Fiebre constatada", "Taquicardia", "Limitación funcional objetiva", "Práctica positiva relacionada", "Contagiosidad relevante"],
    alarmas: ["Signos vitales alterados graves", "Déficit neurológico", "Hemorragia", "Síncope"],
    criterios: { asistencia: "Síntomas leves, examen normal, sin incapacidad funcional", h24: "Cuadro agudo leve-moderado con hallazgo documentado", h48: "Hallazgos objetivos, contagiosidad o necesidad de reevaluación en 24-48 h" },
  },
];

const REPOSO_OPCIONES = [
  { value: "asistencia", label: "Asistencia (sin reposo)" },
  { value: "24", label: "Reposo 24 h" },
  { value: "48", label: "Reposo 48 h + control" },
] as const;

export function SeccionCertificados({ pacienteId }: { pacienteId: number }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { esAdmin, puedeEmitir, esGestion } = useEsAdmin();
  const { data, isLoading } = useGetPatientCertificates(pacienteId);
  // Historial de verificaciones públicas (solo gestión): certificado expandido
  const [verificacionesDeId, setVerificacionesDeId] = useState<number | null>(null);
  const [form, setForm] = useState({ certificateType: "reposo", diagnosis: "", restDays: "", content: "", observations: "", profesionalId: "" });
  // Corregir y reemplazar: id del certificado anterior que este emite de nuevo
  const [reemplazaA, setReemplazaA] = useState<number | null>(null);
  // Revocación con motivo (inline, por certificado)
  const [revocandoId, setRevocandoId] = useState<number | null>(null);
  const [motivoRevocar, setMotivoRevocar] = useState("");

  // Modo guiado (protocolo de guardia) vs. libre
  const [modo, setModo] = useState<"guardia" | "libre">("guardia");
  const [cuadroSel, setCuadroSel] = useState<string>("");
  const [evolucion, setEvolucion] = useState("");
  const [hallazgosSel, setHallazgosSel] = useState<Record<string, boolean>>({});
  const [alarmasSel, setAlarmasSel] = useState<Record<string, boolean>>({});
  const [reposoSel, setReposoSel] = useState<"" | "asistencia" | "24" | "48">("");
  const [diagGuardia, setDiagGuardia] = useState("");

  const cuadro = CUADROS_GUARDIA.find((c) => c.value === cuadroSel) ?? null;
  const hayAlarma = cuadro ? cuadro.alarmas.some((a) => alarmasSel[a]) : false;
  const hayHallazgo = cuadro ? cuadro.hallazgos.some((h) => hallazgosSel[h]) : false;

  const limpiarGuardia = () => {
    setCuadroSel(""); setEvolucion(""); setHallazgosSel({}); setAlarmasSel({}); setReposoSel(""); setDiagGuardia("");
  };

  const textoGuardia = () => {
    const ahora = new Date();
    const dia = ahora.toLocaleDateString("es-AR");
    const hora = ahora.toLocaleTimeString("es-AR", { hour: "2-digit", minute: "2-digit" });
    const dx = diagGuardia.trim() || cuadro?.label || "cuadro clínico agudo";
    const hall = cuadro ? cuadro.hallazgos.filter((h) => hallazgosSel[h]) : [];
    const partes: string[] = [
      `Se deja constancia que el/la paciente fue evaluado/a en Guardia Clínica Ambulatoria de Diagnosticar Medical Center el día ${dia} a las ${hora} hs, constatándose cuadro compatible con ${dx}${evolucion.trim() ? ` de ${evolucion.trim()} ${evolucion.trim() === "1" ? "día" : "días"} de evolución` : ""}.`,
    ];
    if (hall.length > 0) partes.push(`Hallazgos constatados en el acto médico: ${hall.join(", ").toLowerCase()}.`);
    if (reposoSel === "asistencia") {
      partes.push("Se deja constancia de la asistencia, sin indicación de reposo laboral. Se indican pautas de alarma y control médico si persiste la sintomatología.");
    } else if (reposoSel === "24" || reposoSel === "48") {
      partes.push(`Se indica tratamiento sintomático y reposo laboral por ${reposoSel} horas desde la fecha de atención, con pautas de alarma${reposoSel === "48" ? " y nuevo control médico al finalizar el reposo" : " y control médico si persiste la sintomatología"}.`);
    }
    partes.push("El presente certificado surge del acto médico realizado en la fecha y no acredita períodos previos no evaluados.");
    return partes.join(" ");
  };

  // Valida el formulario de guardia y arma el payload; null si falta algo.
  const armarPayloadGuardia = () => {
    if (!cuadro) { toast({ title: "Elegí el cuadro clínico", variant: "destructive" }); return null; }
    if (!reposoSel) { toast({ title: "Elegí asistencia, 24 h o 48 h", variant: "destructive" }); return null; }
    if (esAdmin && !form.profesionalId) { toast({ title: "Seleccioná el profesional emisor", variant: "destructive" }); return null; }
    if ((reposoSel === "24" || reposoSel === "48") && !hayHallazgo && !diagGuardia.trim()) {
      toast({ title: "El reposo requiere correlato clínico", description: "Marcá al menos un hallazgo constatado o escribí el diagnóstico.", variant: "destructive" });
      return null;
    }
    const alarmas = cuadro.alarmas.filter((a) => alarmasSel[a]);
    return {
      patientId: pacienteId,
      ...(esAdmin && form.profesionalId ? { profesionalId: Number(form.profesionalId) } : {}),
      certificateType: (reposoSel === "asistencia" ? "asistencia" : "reposo") as "asistencia" | "reposo",
      ...(diagGuardia.trim() || cuadro ? { diagnosis: diagGuardia.trim() || cuadro.label } : {}),
      ...(reposoSel === "24" ? { restDays: 1 } : reposoSel === "48" ? { restDays: 2 } : {}),
      content: textoGuardia(),
      ...(alarmas.length > 0 ? { observations: `Signos de alarma presentes (${alarmas.join(", ").toLowerCase()}): se indica derivación / evaluación adicional.` } : {}),
    };
  };

  const emitirGuardia = () => {
    const payload = armarPayloadGuardia();
    if (payload) crear.mutate({ data: payload });
  };

  const [previsualizandoCert, setPrevisualizandoCert] = useState(false);
  // Abre en otra pestaña el PDF tal como va a salir, sin emitir nada.
  const verVistaPreviaCert = async (payload: Record<string, unknown> | null) => {
    if (!payload) return;
    setPrevisualizandoCert(true);
    try {
      const token = typeof window !== "undefined" ? localStorage.getItem("auth_token") : null;
      const res = await fetch("/api/consultorio/certificates/preview-pdf", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const cuerpo = await res.json().catch(() => null);
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
      setPrevisualizandoCert(false);
    }
  };

  const crear = useCreateCertificate({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getGetPatientCertificatesQueryKey(pacienteId) });
        queryClient.invalidateQueries({ queryKey: getGetPatientTimelineQueryKey(pacienteId) });
        setForm({ certificateType: "reposo", diagnosis: "", restDays: "", content: "", observations: "", profesionalId: "" });
        limpiarGuardia();
        setReemplazaA(null);
        toast({ title: "Certificado emitido" });
      },
      onError: (e) => toast({ title: "Error al emitir el certificado", description: e.message, variant: "destructive" }),
    },
  });

  const revocar = useRevocarCertificate({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getGetPatientCertificatesQueryKey(pacienteId) });
        setRevocandoId(null);
        setMotivoRevocar("");
        toast({ title: "Certificado revocado", description: "La página pública ya lo muestra como revocado." });
      },
      onError: (e) => toast({ title: "No se pudo revocar", description: e.message, variant: "destructive" }),
    },
  });

  // Valida el formulario libre y arma el payload; null si falta algo.
  const armarPayloadLibre = () => {
    if (!form.content.trim()) {
      toast({ title: "Ingresá el texto del certificado", variant: "destructive" });
      return null;
    }
    if (esAdmin && !form.profesionalId) {
      toast({ title: "Seleccioná el profesional emisor", variant: "destructive" });
      return null;
    }
    return {
      patientId: pacienteId,
      ...(esAdmin && form.profesionalId ? { profesionalId: Number(form.profesionalId) } : {}),
      certificateType: form.certificateType as "reposo" | "aptitud" | "asistencia" | "otro",
      ...(form.diagnosis.trim() ? { diagnosis: form.diagnosis.trim() } : {}),
      ...(form.restDays.trim() ? { restDays: Number(form.restDays) } : {}),
      content: form.content.trim(),
      ...(form.observations.trim() ? { observations: form.observations.trim() } : {}),
      ...(reemplazaA != null ? { reemplazaAId: reemplazaA } : {}),
    };
  };

  // Pre-carga el formulario libre con los datos de un certificado ya emitido
  // para corregirlo: al emitir, el anterior queda "reemplazado".
  const corregirYReemplazar = (c: Certificado) => {
    setModo("libre");
    setReemplazaA(c.id);
    setForm({
      certificateType: c.certificateType,
      diagnosis: c.diagnosis ?? "",
      restDays: c.restDays != null ? String(c.restDays) : "",
      content: c.content,
      observations: c.observations ?? "",
      profesionalId: "",
    });
    toast({ title: "Corregí el texto y emití", description: "El certificado anterior quedará marcado como reemplazado." });
  };

  const emitir = () => {
    const payload = armarPayloadLibre();
    if (payload) crear.mutate({ data: payload });
  };

  const certificados: Certificado[] = data ?? [];

  return (
    <div className="space-y-4">
      {puedeEmitir && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2"><Award className="w-4 h-4 text-primary" /> Nuevo certificado</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {esAdmin && <SelectorProfesional value={form.profesionalId} onChange={(v) => setForm({ ...form, profesionalId: v })} />}
            <div className="flex gap-2">
              {([["guardia", "Certificado de guardia (protocolo)"], ["libre", "Otro certificado (libre)"]] as const).map(([v, l]) => (
                <button
                  key={v}
                  type="button"
                  onClick={() => setModo(v)}
                  className={`rounded-full border px-3 py-1.5 text-xs ${modo === v ? "bg-primary text-primary-foreground border-primary" : "text-muted-foreground hover:bg-muted"}`}
                  data-testid={`modo-cert-${v}`}
                >
                  {l}
                </button>
              ))}
            </div>

            {modo === "guardia" && (
              <div className="space-y-3" data-testid="form-cert-guardia">
                <div>
                  <Label className="text-xs text-muted-foreground">Cuadro clínico *</Label>
                  <div className="flex flex-wrap gap-1.5 mt-1">
                    {CUADROS_GUARDIA.map((c) => (
                      <button
                        key={c.value}
                        type="button"
                        onClick={() => { setCuadroSel((v) => (v === c.value ? "" : c.value)); setHallazgosSel({}); setAlarmasSel({}); }}
                        className={`rounded-full border px-3 py-1.5 text-xs ${cuadroSel === c.value ? "bg-primary text-primary-foreground border-primary" : "text-muted-foreground hover:bg-muted"}`}
                        data-testid={`cuadro-${c.value}`}
                      >
                        {c.label}
                      </button>
                    ))}
                  </div>
                </div>

                {cuadro && (
                  <>
                    <div>
                      <Label className="text-xs text-muted-foreground">Evolución del cuadro (en días)</Label>
                      <Input
                        type="number"
                        min={0}
                        inputMode="numeric"
                        placeholder="Ej: 3"
                        className="mt-1 max-w-[10rem]"
                        value={evolucion}
                        onChange={(e) => setEvolucion(e.target.value)}
                        data-testid="cert-evolucion-dias"
                      />
                    </div>

                    <div>
                      <Label className="text-xs text-muted-foreground">Hallazgos constatados (fortalecen el reposo)</Label>
                      <div className="flex flex-wrap gap-1.5 mt-1">
                        {cuadro.hallazgos.map((h) => (
                          <button
                            key={h}
                            type="button"
                            onClick={() => setHallazgosSel((s) => ({ ...s, [h]: !s[h] }))}
                            className={`rounded-full border px-3 py-1.5 text-xs ${hallazgosSel[h] ? "bg-emerald-600 text-white border-emerald-600" : "text-muted-foreground hover:bg-muted"}`}
                            data-testid={`hallazgo-${h}`}
                          >
                            {h}
                          </button>
                        ))}
                      </div>
                    </div>

                    <div>
                      <Label className="text-xs text-muted-foreground">Signos de alarma (bloquean el alta simple)</Label>
                      <div className="flex flex-wrap gap-1.5 mt-1">
                        {cuadro.alarmas.map((a) => (
                          <button
                            key={a}
                            type="button"
                            onClick={() => setAlarmasSel((s) => ({ ...s, [a]: !s[a] }))}
                            className={`rounded-full border px-3 py-1.5 text-xs ${alarmasSel[a] ? "bg-red-600 text-white border-red-600" : "text-muted-foreground hover:bg-muted"}`}
                            data-testid={`alarma-${a}`}
                          >
                            {a}
                          </button>
                        ))}
                      </div>
                      {hayAlarma && (
                        <p className="text-xs text-red-700 dark:text-red-300 mt-1.5 font-medium">
                          Con signos de alarma no corresponde alta simple desde guardia: evaluar derivación, internación o control programado. Quedará documentado en el certificado.
                        </p>
                      )}
                    </div>

                    <div>
                      <Label className="text-xs text-muted-foreground">Diagnóstico / síndrome presuntivo</Label>
                      <Input value={diagGuardia} onChange={(e) => setDiagGuardia(e.target.value)} placeholder={`Ej: ${cuadro.criterios.h24.split(",")[0].toLowerCase()}`} data-testid="input-diag-guardia" />
                    </div>

                    <div>
                      <Label className="text-xs text-muted-foreground">Decisión *</Label>
                      <div className="flex flex-wrap gap-1.5 mt-1">
                        {REPOSO_OPCIONES.map((r) => (
                          <button
                            key={r.value}
                            type="button"
                            onClick={() => setReposoSel((v) => (v === r.value ? "" : r.value))}
                            className={`rounded-full border px-3 py-1.5 text-xs ${reposoSel === r.value ? "bg-primary text-primary-foreground border-primary" : "text-muted-foreground hover:bg-muted"}`}
                            data-testid={`reposo-${r.value}`}
                          >
                            {r.label}
                          </button>
                        ))}
                      </div>
                      <div className="text-xs text-muted-foreground mt-1.5 space-y-0.5">
                        <p><span className="font-medium">Asistencia:</span> {cuadro.criterios.asistencia}.</p>
                        <p><span className="font-medium">24 h:</span> {cuadro.criterios.h24}.</p>
                        <p><span className="font-medium">48 h:</span> {cuadro.criterios.h48}. Más de 48 h no se prolonga desde guardia: nuevo control o derivación.</p>
                      </div>
                    </div>

                    {reposoSel && (
                      <div className="rounded-md border bg-muted/40 p-3">
                        <p className="text-xs font-medium mb-1">Vista previa del certificado</p>
                        <p className="text-xs whitespace-pre-wrap" data-testid="preview-cert-guardia">{textoGuardia()}</p>
                      </div>
                    )}

                    <div className="flex flex-wrap gap-2">
                      <Button
                        variant="outline"
                        onClick={() => verVistaPreviaCert(armarPayloadGuardia())}
                        disabled={previsualizandoCert || crear.isPending}
                        className="gap-1"
                        data-testid="btn-vista-previa-cert-guardia"
                      >
                        {previsualizandoCert ? <Loader2 className="w-4 h-4 animate-spin" /> : <FileText className="w-4 h-4" />} Ver vista previa
                      </Button>
                      <Button onClick={emitirGuardia} disabled={crear.isPending} className="gap-1" data-testid="btn-emitir-cert-guardia">
                        {crear.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />} Emitir certificado
                      </Button>
                    </div>
                  </>
                )}
              </div>
            )}

            {modo === "libre" && (<>
            <div className="grid sm:grid-cols-3 gap-3">
              <div>
                <Label className="text-xs text-muted-foreground">Tipo *</Label>
                <Select value={form.certificateType} onValueChange={(v) => setForm({ ...form, certificateType: v })}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {TIPOS_CERTIFICADO.map((t) => <SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label className="text-xs text-muted-foreground">Diagnóstico</Label>
                <Input value={form.diagnosis} onChange={(e) => setForm({ ...form, diagnosis: e.target.value })} placeholder="Ej: Lumbalgia aguda" />
              </div>
              <div>
                <Label className="text-xs text-muted-foreground">Días de reposo</Label>
                <Input type="number" min={0} value={form.restDays} onChange={(e) => setForm({ ...form, restDays: e.target.value })} placeholder="Ej: 3" />
              </div>
            </div>
            <div>
              <Label className="text-xs text-muted-foreground">Texto del certificado *</Label>
              <Textarea value={form.content} onChange={(e) => setForm({ ...form, content: e.target.value })} placeholder="Se certifica que el paciente..." rows={3} />
            </div>
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                onClick={() => verVistaPreviaCert(armarPayloadLibre())}
                disabled={previsualizandoCert || crear.isPending}
                className="gap-1"
                data-testid="btn-vista-previa-cert-libre"
              >
                {previsualizandoCert ? <Loader2 className="w-4 h-4 animate-spin" /> : <FileText className="w-4 h-4" />} Ver vista previa
              </Button>
              <Button onClick={emitir} disabled={crear.isPending} className="gap-1" data-testid="btn-emitir-cert-libre">
                {crear.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />} Emitir certificado
              </Button>
            </div>
            </>)}
          </CardContent>
        </Card>
      )}

      {isLoading ? (
        <Skeleton className="h-24 w-full" />
      ) : certificados.length === 0 ? (
        <p className="text-sm text-muted-foreground text-center py-4">Sin certificados emitidos.</p>
      ) : (
        <div className="space-y-2">
          {certificados.map((c) => {
            const estado = c.estado ?? "valido";
            return (
              <Card key={c.id}>
                <CardContent className="p-3 space-y-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <Award className="w-4 h-4 text-primary shrink-0" />
                    <div className="flex-1 min-w-40">
                      <p className="text-sm font-medium capitalize">Certificado de {c.certificateType}</p>
                      <p className="text-xs text-muted-foreground">
                        {[c.numero, c.diagnosis, c.restDays ? `${c.restDays} días de reposo` : null].filter(Boolean).join(" · ") || "—"} · {fechaCorta(c.createdAt)}
                      </p>
                      {esGestion && c.verificacionesCount != null && (
                        <p
                          className={`text-xs ${c.verificacionesCount === 0 ? "text-amber-700 dark:text-amber-300" : "text-muted-foreground"}`}
                          data-testid={`resumen-verificaciones-${c.id}`}
                        >
                          {c.verificacionesCount === 0
                            ? "Sin verificaciones"
                            : `${c.verificacionesCount} ${c.verificacionesCount === 1 ? "verificación" : "verificaciones"}${c.ultimaVerificacion ? ` · última ${haceRelativo(c.ultimaVerificacion)}` : ""}`}
                        </p>
                      )}
                    </div>
                    {estado === "revocado" && (
                      <span className="text-[11px] font-semibold rounded-full px-2 py-0.5 bg-red-600 text-white" data-testid={`chip-revocado-${c.id}`}>REVOCADO</span>
                    )}
                    {estado === "reemplazado" && (
                      <span className="text-[11px] font-semibold rounded-full px-2 py-0.5 bg-amber-600 text-white" data-testid={`chip-reemplazado-${c.id}`}>REEMPLAZADO</span>
                    )}
                    {estado === "valido" && <BotonPdf sourceType="certificado" sourceId={c.id} nombre={`certificado-${c.id}`} />}
                    {esGestion && (
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-7 text-xs"
                        onClick={() => setVerificacionesDeId(verificacionesDeId === c.id ? null : c.id)}
                        data-testid={`boton-verificaciones-${c.id}`}
                      >
                        Verificaciones
                      </Button>
                    )}
                    {estado === "valido" && puedeEmitir && (
                      <>
                        <Button variant="outline" size="sm" className="h-7 text-xs" onClick={() => corregirYReemplazar(c)} data-testid={`boton-reemplazar-${c.id}`}>
                          Corregir
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-7 text-xs text-red-600 border-red-300 hover:bg-red-50"
                          onClick={() => { setRevocandoId(revocandoId === c.id ? null : c.id); setMotivoRevocar(""); }}
                          data-testid={`boton-revocar-${c.id}`}
                        >
                          Revocar
                        </Button>
                      </>
                    )}
                  </div>
                  {esGestion && verificacionesDeId === c.id && <HistorialVerificaciones certificadoId={c.id} />}
                  {revocandoId === c.id && (
                    <div className="flex flex-wrap items-center gap-2 rounded-md border border-red-200 bg-red-50 dark:bg-red-950/30 p-2">
                      <Input
                        value={motivoRevocar}
                        onChange={(e) => setMotivoRevocar(e.target.value)}
                        placeholder="Motivo (opcional)"
                        className="h-8 text-xs flex-1 min-w-40 bg-background"
                        data-testid={`input-motivo-revocar-${c.id}`}
                      />
                      <Button
                        size="sm"
                        className="h-8 text-xs bg-red-600 hover:bg-red-500 text-white"
                        disabled={revocar.isPending}
                        onClick={() => revocar.mutate({ id: c.id, data: motivoRevocar.trim() ? { motivo: motivoRevocar.trim() } : {} })}
                        data-testid={`boton-confirmar-revocar-${c.id}`}
                      >
                        {revocar.isPending ? <Loader2 className="w-3 h-3 animate-spin" /> : "Confirmar revocación"}
                      </Button>
                    </div>
                  )}
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}

const MEDIO_VERIFICACION: Record<string, string> = {
  qr_link: "QR / link",
  codigo_manual: "Código manual",
  descarga_pdf: "Descarga PDF",
};
export function SeccionIndicaciones({ pacienteId }: { pacienteId: number }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { esAdmin, puedeEmitir } = useEsAdmin();
  const { data, isLoading } = useGetPatientIndicaciones(pacienteId);
  const { data: recetas } = useGetPatientPrescriptions(pacienteId);
  const { data: ordenes } = useGetPatientStudyOrders(pacienteId);

  const [form, setForm] = useState({ estudios: "", medicamentos: "", otrasIndicaciones: "", profesionalId: "" });
  const [previsualizando, setPrevisualizando] = useState(false);

  // Trae lo pedido HOY en la consulta: órdenes de estudio y recetas del día.
  const completarDesdeConsulta = () => {
    const hoy = new Date().toDateString();
    const esDeHoy = (fecha?: string | Date | null) => fecha != null && new Date(fecha).toDateString() === hoy;

    const lineasEstudios = (ordenes ?? [])
      .filter((o: OrdenEstudio) => esDeHoy(o.createdAt))
      .map((o: OrdenEstudio) => `- ${o.studyName}${o.preparationRequired ? ` (preparación: ${o.preparationRequired})` : ""}`);
    const lineasMedicamentos = (recetas ?? [])
      .filter((r: RecetaConsultorio) => esDeHoy(r.createdAt))
      .map((r: RecetaConsultorio) =>
        `- ${r.medication}${r.dosage ? ` ${r.dosage}` : ""}${r.frequency ? ` — ${r.frequency}` : ""}${r.duration ? ` — durante ${r.duration}` : ""}${r.instructions ? ` (${r.instructions})` : ""}`,
      );

    if (lineasEstudios.length === 0 && lineasMedicamentos.length === 0) {
      toast({ title: "No hay órdenes ni recetas emitidas hoy", description: "Podés escribir las indicaciones a mano igual." });
      return;
    }
    setForm((f) => ({
      ...f,
      estudios: lineasEstudios.length > 0 ? lineasEstudios.join("\n") : f.estudios,
      medicamentos: lineasMedicamentos.length > 0 ? lineasMedicamentos.join("\n") : f.medicamentos,
    }));
    toast({ title: "Indicaciones completadas con lo pedido hoy", description: "Revisá y ajustá el texto antes de enviar." });
  };

  const armarPayload = () => {
    if (!form.estudios.trim() && !form.medicamentos.trim() && !form.otrasIndicaciones.trim()) {
      toast({ title: "Completá al menos una sección", variant: "destructive" });
      return null;
    }
    if (esAdmin && !form.profesionalId) {
      toast({ title: "Seleccioná el profesional emisor", variant: "destructive" });
      return null;
    }
    return {
      patientId: pacienteId,
      ...(esAdmin && form.profesionalId ? { profesionalId: Number(form.profesionalId) } : {}),
      ...(form.estudios.trim() ? { estudios: form.estudios.trim() } : {}),
      ...(form.medicamentos.trim() ? { medicamentos: form.medicamentos.trim() } : {}),
      ...(form.otrasIndicaciones.trim() ? { otrasIndicaciones: form.otrasIndicaciones.trim() } : {}),
    };
  };

  // Abre en otra pestaña el PDF tal como va a salir, sin emitir nada.
  const verVistaPrevia = async () => {
    const payload = armarPayload();
    if (!payload) return;
    setPrevisualizando(true);
    try {
      const token = typeof window !== "undefined" ? localStorage.getItem("auth_token") : null;
      const res = await fetch("/api/consultorio/indicaciones/preview-pdf", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const cuerpo = await res.json().catch(() => null);
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
  };

  const crear = useCreateIndicacion({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getGetPatientIndicacionesQueryKey(pacienteId) });
        setForm({ estudios: "", medicamentos: "", otrasIndicaciones: "", profesionalId: "" });
        toast({ title: "Indicaciones emitidas", description: "Se envían automáticamente a la app del paciente." });
      },
      onError: (e) => toast({ title: "Error al emitir las indicaciones", description: e.message, variant: "destructive" }),
    },
  });

  const emitir = () => {
    const payload = armarPayload();
    if (payload) crear.mutate({ data: payload });
  };

  const indicaciones: Indicacion[] = data ?? [];

  return (
    <div className="space-y-4">
      {puedeEmitir && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              <ClipboardList className="w-4 h-4 text-primary" /> Nuevas indicaciones para el paciente
            </CardTitle>
            <CardDescription className="text-xs">
              Se arman solas a medida que cargás recetas, órdenes e interconsultas. Acá podés revisarlas, ajustar el texto o sumar indicaciones propias.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {esAdmin && <SelectorProfesional value={form.profesionalId} onChange={(v) => setForm({ ...form, profesionalId: v })} />}
            <Button variant="outline" size="sm" onClick={completarDesdeConsulta} className="gap-1" data-testid="btn-completar-indicaciones">
              <Sparkles className="w-4 h-4" /> Completar con lo pedido hoy (estudios y recetas)
            </Button>
            <div>
              <Label className="text-xs text-muted-foreground">Estudios a realizar</Label>
              <Textarea
                value={form.estudios}
                onChange={(e) => setForm({ ...form, estudios: e.target.value })}
                placeholder={"- Laboratorio completo en ayunas\n- Radiografía de tórax (pedir turno en recepción)"}
                rows={3}
                data-testid="input-indicaciones-estudios"
              />
            </div>
            <div>
              <Label className="text-xs text-muted-foreground">Medicamentos y cómo tomarlos</Label>
              <Textarea
                value={form.medicamentos}
                onChange={(e) => setForm({ ...form, medicamentos: e.target.value })}
                placeholder={"- Ibuprofeno 400 mg — 1 comprimido cada 8 horas, después de comer, durante 5 días"}
                rows={3}
                data-testid="input-indicaciones-medicamentos"
              />
            </div>
            <div>
              <Label className="text-xs text-muted-foreground">Otras indicaciones</Label>
              <Textarea
                value={form.otrasIndicaciones}
                onChange={(e) => setForm({ ...form, otrasIndicaciones: e.target.value })}
                placeholder={"- Reposo relativo, abundante líquido\n- Volver a control en 7 días o antes si empeora"}
                rows={3}
                data-testid="input-indicaciones-otras"
              />
            </div>
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                onClick={verVistaPrevia}
                disabled={previsualizando || crear.isPending}
                className="gap-1"
                data-testid="btn-vista-previa-indicaciones"
              >
                {previsualizando ? <Loader2 className="w-4 h-4 animate-spin" /> : <FileText className="w-4 h-4" />} Ver vista previa
              </Button>
              <Button onClick={emitir} disabled={crear.isPending} className="gap-1" data-testid="btn-emitir-indicaciones">
                {crear.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />} Emitir y enviar a la app
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {isLoading ? (
        <Skeleton className="h-24 w-full" />
      ) : indicaciones.length === 0 ? (
        <p className="text-sm text-muted-foreground text-center py-4">Sin indicaciones emitidas.</p>
      ) : (
        <div className="space-y-2">
          {indicaciones.map((i) => (
            <Card key={i.id} data-testid={`indicacion-${i.id}`}>
              <CardContent className="p-3 flex flex-wrap items-center gap-2">
                <ClipboardList className="w-4 h-4 text-primary shrink-0" />
                <div className="flex-1 min-w-40">
                  <p className="text-sm font-medium">Indicaciones para el paciente</p>
                  <p className="text-xs text-muted-foreground">
                    {[
                      i.estudios ? "estudios" : null,
                      i.medicamentos ? "medicamentos" : null,
                      i.otrasIndicaciones ? "otras indicaciones" : null,
                    ].filter(Boolean).join(" · ") || "—"} · {fechaCorta(i.createdAt)}
                  </p>
                </div>
                <BotonPdf sourceType="indicacion" sourceId={i.id} nombre={`indicaciones-${i.id}`} />
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Órdenes de estudio ──────────────────────────────────────────────────────

// Orden de aparición en el autocompletado: imágenes → cardiológicos → laboratorio → otros
function prioridadEspecialidad(especialidad: string): number {
  const e = especialidad.toUpperCase();
  if (e.includes("IMAGEN")) return 0;
  if (e.includes("CARDIO")) return 1;
  if (e.includes("LABORATORIO")) return 2;
  return 3;
}

// Asistente de órdenes de alta complejidad: solo Resonancia, Tomografía y Ecodoppler.
// "ecodoppler" no es una categoría del catálogo: agrupa las prácticas Doppler de cardiología.
const CATEGORIAS_ALTA = [
  { value: "resonancia", label: "Resonancia" },
  { value: "tomografia", label: "Tomografía" },
  { value: "ecodoppler", label: "Ecodoppler" },
] as const;

// Orden combinada "Columna completa": emite de una vez 3 órdenes de alta
// complejidad (resonancia de cada región) y 3 de baja (RX de cada región),
// compartiendo las mismas maniobras/datos del cuadro para las tres regiones.
const COLUMNA_COMPLETA_ALTA = [
  "Resonancia de Columna Cervical",
  "Resonancia de Columna Dorsal",
  "Resonancia de Columna Lumbosacra",
];
const COLUMNA_COMPLETA_BAJA = [
  "RX Columna Cervical (frente y perfil)",
  "RX Columna Dorsal (frente y perfil)",
  "RX Columna Lumbar (frente y perfil)",
];

// Filtro de búsqueda insensible a acentos y mayúsculas para el combo de prácticas
function normalizarTexto(s: string) {
  return s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}
function filtroSinAcentos(value: string, search: string) {
  return normalizarTexto(value).includes(normalizarTexto(search)) ? 1 : 0;
}

// Catálogo de maniobras semiológicas sugeridas según la región del estudio.
// La región se detecta por palabras clave en el nombre de la práctica elegida.
// Se muestra la definición (lo que el médico observa en el examen); el nombre
// técnico viaja junto con la definición al asistente de IA.
type Maniobra = { nombre: string; definicion: string };

const MANIOBRAS_POR_REGION: Array<{ claves: string[]; region: string; maniobras: Maniobra[] }> = [
  { claves: ["rodilla"], region: "Rodilla", maniobras: [
    { nombre: "Lachman", definicion: "La tibia se desplaza hacia adelante al traccionar (LCA)" },
    { nombre: "Cajón anterior", definicion: "Desplazamiento hacia adelante de la tibia con rodilla flexionada" },
    { nombre: "Cajón posterior", definicion: "Desplazamiento hacia atrás de la tibia (LCP)" },
    { nombre: "McMurray", definicion: "Chasquido o dolor al rotar la rodilla flexionada (menisco)" },
    { nombre: "Appley", definicion: "Dolor al comprimir y rotar la rodilla boca abajo (menisco)" },
    { nombre: "Bostezo medial", definicion: "La rodilla se abre hacia adentro al forzarla (lig. lateral interno)" },
    { nombre: "Bostezo lateral", definicion: "La rodilla se abre hacia afuera al forzarla (lig. lateral externo)" },
    { nombre: "Cepillo rotuliano", definicion: "Dolor o crujido al mover la rótula contra el fémur" },
  ] },
  { claves: ["hombro"], region: "Hombro", maniobras: [
    { nombre: "Jobe", definicion: "Dolor o debilidad al elevar el brazo con el pulgar hacia abajo (supraespinoso)" },
    { nombre: "Neer", definicion: "Dolor al elevar el brazo estirado (pinzamiento subacromial)" },
    { nombre: "Hawkins-Kennedy", definicion: "Dolor al rotar el hombro hacia adentro con el codo flexionado" },
    { nombre: "Yocum", definicion: "Dolor al levantar el codo con la mano en el hombro opuesto" },
    { nombre: "Speed", definicion: "Dolor anterior al resistir la elevación del brazo (bíceps)" },
    { nombre: "O'Brien", definicion: "Dolor al resistir con el pulgar hacia abajo (labrum)" },
    { nombre: "Aprehensión anterior", definicion: "Sensación de que el hombro se sale al rotarlo hacia afuera" },
  ] },
  { claves: ["columna", "lumbar", "lumbosacra", "cervical", "dorsal"], region: "Columna", maniobras: [
    { nombre: "Lasègue", definicion: "Dolor irradiado a la pierna al elevarla estirada (ciática)" },
    { nombre: "Bragard", definicion: "Dolor al flexionar el pie con la pierna elevada (radicular)" },
    { nombre: "Schober", definicion: "Poca flexibilidad lumbar al inclinarse hacia adelante" },
    { nombre: "Spurling", definicion: "Dolor irradiado al brazo al inclinar y comprimir la cabeza" },
    { nombre: "Valsalva", definicion: "Dolor al pujar o toser (compresión radicular)" },
  ] },
  { claves: ["cadera", "pelvis"], region: "Cadera", maniobras: [
    { nombre: "FABER (Patrick)", definicion: "Dolor al cruzar la pierna en 4 (cadera o sacroilíaca)" },
    { nombre: "FADIR", definicion: "Dolor al flexionar y rotar la cadera hacia adentro (pinzamiento)" },
    { nombre: "Trendelenburg", definicion: "La pelvis cae al pararse en una sola pierna (glúteo medio)" },
    { nombre: "Thomas", definicion: "La cadera queda flexionada al estirar la otra pierna (psoas)" },
  ] },
  { claves: ["tobillo", "pie"], region: "Tobillo y pie", maniobras: [
    { nombre: "Cajón anterior de tobillo", definicion: "El pie se desplaza hacia adelante al traccionar (ligamentos)" },
    { nombre: "Thompson", definicion: "El pie no se flexiona al apretar la pantorrilla (Aquiles)" },
    { nombre: "Squeeze test", definicion: "Dolor al comprimir la pierna (sindesmosis)" },
  ] },
  { claves: ["muñeca", "mano", "carpo"], region: "Muñeca y mano", maniobras: [
    { nombre: "Phalen", definicion: "Hormigueo en los dedos al flexionar las muñecas (túnel carpiano)" },
    { nombre: "Tinel", definicion: "Hormigueo al percutir la muñeca (túnel carpiano)" },
    { nombre: "Finkelstein", definicion: "Dolor en el borde del pulgar al desviar la muñeca (De Quervain)" },
  ] },
  { claves: ["codo"], region: "Codo", maniobras: [
    { nombre: "Cozen", definicion: "Dolor externo al extender la muñeca contra resistencia (epicondilitis)" },
    { nombre: "Mill", definicion: "Dolor externo al estirar la muñeca flexionada (codo de tenista)" },
    { nombre: "Tinel cubital", definicion: "Hormigueo hacia el meñique al percutir el codo" },
  ] },
  { claves: ["abdomen", "abdominal", "vesic", "hepat"], region: "Abdomen", maniobras: [
    { nombre: "Murphy", definicion: "Corte de la inspiración al palpar bajo la costilla derecha (vesícula)" },
    { nombre: "Blumberg", definicion: "Dolor al soltar bruscamente la palpación (peritonitis)" },
    { nombre: "McBurney", definicion: "Dolor en fosa ilíaca derecha (apendicitis)" },
    { nombre: "Rovsing", definicion: "Dolor a la derecha al palpar el lado izquierdo (apendicitis)" },
    { nombre: "Psoas", definicion: "Dolor al extender la cadera derecha (apéndice retrocecal)" },
  ] },
];

// Evolución del cuadro: opciones fijas con tilde (pedido del usuario)
const EVOLUCION_OPCIONES = ["1 semana", "2 semanas", "1 mes", "3 meses", "6 meses", "1 año", "más de 1 año"] as const;

// Signos y síntomas para Ecodoppler según la región del estudio: lo que
// establece (+) o descarta (−) la indicación del estudio.
const SINTOMAS_DOPPLER_POR_REGION: Array<{ claves: string[]; region: string; maniobras: Maniobra[] }> = [
  { claves: ["carotideo", "carotida", "cuello", "vasos de cuello"], region: "Vasos de cuello", maniobras: [
    { nombre: "Soplo carotídeo", definicion: "Soplo audible en el cuello" },
    { nombre: "AIT/ACV previo", definicion: "Episodio de isquemia cerebral transitoria o ACV" },
    { nombre: "Mareos o inestabilidad", definicion: "Mareos, vértigo o inestabilidad" },
    { nombre: "Síncope", definicion: "Pérdida de conocimiento (síncope)" },
    { nombre: "Amaurosis fugaz", definicion: "Pérdida transitoria de visión en un ojo" },
  ]},
  { claves: ["venoso", "vena"], region: "Venoso de miembros", maniobras: [
    { nombre: "Edema unilateral", definicion: "Hinchazón de una sola pierna" },
    { nombre: "Dolor en pantorrilla", definicion: "Dolor espontáneo o a la palpación de la pantorrilla" },
    { nombre: "Signo de Homans", definicion: "Dolor en pantorrilla al flexionar el pie hacia arriba" },
    { nombre: "Várices", definicion: "Venas varicosas visibles" },
    { nombre: "Cambios de coloración", definicion: "Enrojecimiento o cianosis del miembro" },
    { nombre: "Úlcera venosa", definicion: "Úlcera en la pierna de aspecto venoso" },
  ]},
  { claves: ["arterial", "arteria", "aorta"], region: "Arterial de miembros", maniobras: [
    { nombre: "Claudicación intermitente", definicion: "Dolor en las piernas al caminar que cede en reposo" },
    { nombre: "Pulsos disminuidos", definicion: "Pulsos periféricos disminuidos o ausentes" },
    { nombre: "Frialdad del miembro", definicion: "Pie o pierna fríos" },
    { nombre: "Palidez o cianosis", definicion: "Cambio de color del miembro" },
    { nombre: "Úlcera arterial", definicion: "Úlcera o lesión que no cicatriza" },
    { nombre: "Dolor en reposo", definicion: "Dolor del miembro incluso en reposo" },
  ]},
  { claves: ["renal"], region: "Renal", maniobras: [
    { nombre: "HTA refractaria", definicion: "Hipertensión que no responde al tratamiento" },
    { nombre: "Deterioro de función renal", definicion: "Creatinina en aumento" },
    { nombre: "Soplo abdominal", definicion: "Soplo audible en el abdomen" },
    { nombre: "Asimetría renal", definicion: "Diferencia de tamaño renal en estudios previos" },
  ]},
  { claves: ["cardiaco", "corazon", "transtoracico"], region: "Cardíaco", maniobras: [
    { nombre: "Disnea", definicion: "Falta de aire de esfuerzo o reposo" },
    { nombre: "Soplo cardíaco", definicion: "Soplo en la auscultación" },
    { nombre: "Edemas", definicion: "Hinchazón de miembros inferiores" },
    { nombre: "Palpitaciones", definicion: "Palpitaciones o arritmia conocida" },
    { nombre: "Dolor torácico", definicion: "Dolor de pecho" },
  ]},
];

function sintomasDoppler(nombreEstudio: string): { region: string; maniobras: Maniobra[] } | null {
  const n = normalizarTexto(nombreEstudio);
  for (const grupo of SINTOMAS_DOPPLER_POR_REGION) {
    if (grupo.claves.some((c) => n.includes(normalizarTexto(c)))) return { region: grupo.region, maniobras: grupo.maniobras };
  }
  return null;
}

// Mapa nombre → definición para armar el texto que se manda al asistente IA
const DEFINICION_MANIOBRA: Record<string, string> = Object.fromEntries(
  [...MANIOBRAS_POR_REGION, ...SINTOMAS_DOPPLER_POR_REGION].flatMap((g) => g.maniobras.map((m) => [m.nombre, m.definicion])),
);

function maniobrasSugeridas(nombreEstudio: string): { region: string; maniobras: Maniobra[] } | null {
  const n = normalizarTexto(nombreEstudio);
  for (const grupo of MANIOBRAS_POR_REGION) {
    if (grupo.claves.some((c) => n.includes(normalizarTexto(c)))) return { region: grupo.region, maniobras: grupo.maniobras };
  }
  return null;
}

// Regiones articulares donde tiene sentido distinguir lado derecho/izquierdo
const REGIONES_ARTICULARES = ["Rodilla", "Tobillo y pie", "Codo", "Muñeca y mano", "Hombro", "Cadera"];

// Estudio bilateral (ej: "RMN DE AMBAS RODILLAS"): la ficha de síntomas se
// carga por lado y el médico indica cuál es la articulación más dolorosa.
function esEstudioBilateral(nombreEstudio: string): boolean {
  const n = normalizarTexto(nombreEstudio);
  return n.includes("ambas") || n.includes("ambos") || n.includes("bilateral");
}

// Nombre de la región en singular y minúscula para prefijar por lado
// ("Rodilla" → "rodilla derecha: …"; "Tobillo y pie" → "tobillo y pie derecho")
function regionConLado(region: string, lado: "derecha" | "izquierda"): string {
  const r = region.toLowerCase();
  const masculinas = ["tobillo y pie", "codo", "hombro"];
  const l = masculinas.includes(r) ? (lado === "derecha" ? "derecho" : "izquierdo") : lado;
  return `${r} ${l}`;
}

export function SeccionOrdenes({ pacienteId }: { pacienteId: number }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { esAdmin, puedeEmitir } = useEsAdmin();
  const { data, isLoading } = useGetPatientStudyOrders(pacienteId);
  const [form, setForm] = useState({ studyType: "imagenes", studyName: "", clinicalJustification: "", priority: "normal", preparationRequired: "", profesionalId: "" });
  const [complejidad, setComplejidad] = useState<"" | "baja" | "alta">("");
  const [resumenHc, setResumenHc] = useState("");
  const [categoria, setCategoria] = useState<string>("");
  const [practicaSel, setPracticaSel] = useState<PracticaCatalogo | null>(null);
  const [contraste, setContraste] = useState(false);
  const [buscadorAbierto, setBuscadorAbierto] = useState(false);
  // Modo "Columna completa": emite 6 órdenes de una vez (3 alta + 3 baja)
  const [columnaCompleta, setColumnaCompleta] = useState(false);
  const [emitiendoColumna, setEmitiendoColumna] = useState(false);

  // Maniobras semiológicas del examen físico (positiva/negativa) que alimentan
  // al asistente de IA para justificar el estudio pedido.
  const [maniobras, setManiobras] = useState<Record<string, "positiva" | "negativa">>({});
  const [maniobraCustom, setManiobraCustom] = useState("");
  const [maniobrasExtra, setManiobrasExtra] = useState<string[]>([]);
  // Estudio bilateral (AMBAS rodillas/caderas/etc.): una ficha por lado y
  // el dato de cuál es la articulación más dolorosa.
  const [maniobrasDer, setManiobrasDer] = useState<Record<string, "positiva" | "negativa">>({});
  const [maniobrasIzq, setManiobrasIzq] = useState<Record<string, "positiva" | "negativa">>({});
  const [ladoMasDoloroso, setLadoMasDoloroso] = useState<"" | "derecha" | "izquierda">("");
  // El médico marca que el estudio abarca ambos lados aunque la práctica del
  // catálogo no diga "AMBAS" en el nombre.
  const [bilateralManual, setBilateralManual] = useState(false);
  // Datos mínimos que carga el médico: tiempo de evolución del dolor y, en
  // articulaciones (rodilla, tobillo, etc.), el lado interno o externo.
  const [tiempoDolor, setTiempoDolor] = useState("");
  const [ladoDolor, setLadoDolor] = useState<"" | "interno" | "externo">("");
  const [caracteristicasDolor, setCaracteristicasDolor] = useState("");
  // Confirmación de la orden final (alta complejidad) con opción de editar el resumen
  const [ordenFinal, setOrdenFinal] = useState<{ resumen: string } | null>(null);

  const alternarManiobra = (nombre: string, resultado: "positiva" | "negativa") => {
    setManiobras((m) => {
      const nuevo = { ...m };
      if (nuevo[nombre] === resultado) delete nuevo[nombre];
      else nuevo[nombre] = resultado;
      return nuevo;
    });
  };

  const alternarManiobraLado = (lado: "derecha" | "izquierda", nombre: string, resultado: "positiva" | "negativa") => {
    const set = lado === "derecha" ? setManiobrasDer : setManiobrasIzq;
    set((m) => {
      const nuevo = { ...m };
      if (nuevo[nombre] === resultado) delete nuevo[nombre];
      else nuevo[nombre] = resultado;
      return nuevo;
    });
    // El resumen ya generado queda viejo si cambian los hallazgos por lado
    setResumenHc("");
  };

  // Info del protocolo bilateral vigente (o null si el estudio no es bilateral)
  const infoBilateral = (): { region: string; maniobras: Maniobra[] } | null => {
    if (complejidad !== "alta" || columnaCompleta || !practicaSel) return null;
    if (categoria === "tomografia" || categoria === "ecodoppler") return null;
    if (!esEstudioBilateral(practicaSel.nombre) && !bilateralManual) return null;
    const sug = maniobrasSugeridas(practicaSel.nombre);
    if (!sug || !REGIONES_ARTICULARES.includes(sug.region)) return null;
    return sug;
  };

  // Nombre del estudio que va en la orden: si es bilateral y la práctica del
  // catálogo no lo dice, se aclara "AMBAS" para que quede claro en la planilla.
  const nombreEstudioFinal = () => {
    const nombre = form.studyName.trim();
    if (!nombre) return nombre;
    const bilat = infoBilateral();
    if (!bilat || esEstudioBilateral(nombre)) return nombre;
    return `${nombre} (AMBAS)`;
  };

  // Al asistente de IA viaja SOLO el movimiento (la definición), nunca el
  // nombre técnico/epónimo de la maniobra (pedido del médico): ni la orden ni
  // la pantalla deben mencionar "Lachman", "McMurray", etc.
  const listaManiobras = () =>
    Object.entries(maniobras).map(([nombre, resultado]) => ({
      nombre: DEFINICION_MANIOBRA[nombre] ?? nombre,
      resultado,
    }));

  // Variante bilateral: cada hallazgo viaja prefijado con la articulación y
  // el lado ("rodilla derecha: …") para que la IA redacte por lado.
  const listaManiobrasBilateral = (region: string) => {
    const conLado = (m: Record<string, "positiva" | "negativa">, lado: "derecha" | "izquierda") =>
      Object.entries(m).map(([nombre, resultado]) => ({
        nombre: `${regionConLado(region, lado)}: ${DEFINICION_MANIOBRA[nombre] ?? nombre}`,
        resultado,
      }));
    return [...conLado(maniobrasDer, "derecha"), ...conLado(maniobrasIzq, "izquierda")];
  };

  // Datos del paciente para completar lo que falte antes de emitir la orden
  const { data: paciente } = useGetPaciente(pacienteId);
  const [dialogDatosAbierto, setDialogDatosAbierto] = useState(false);
  const [datosFaltantes, setDatosFaltantes] = useState({ dni: "", cobertura: "", nroAfiliado: "" });
  const actualizarPaciente = useUpdatePaciente({
    mutation: {
      onError: (e) => toast({ title: "No se pudieron guardar los datos del paciente", description: (e as Error).message, variant: "destructive" }),
    },
  });

  // El N° de afiliado ya no frena la emisión: el popup solo pide DNI y cobertura.
  const camposFaltantes = () => {
    const faltan: Array<"dni" | "cobertura" | "nroAfiliado"> = [];
    if (!paciente) return faltan;
    if (!paciente.dni?.trim()) faltan.push("dni");
    if (!paciente.cobertura?.trim()) faltan.push("cobertura");
    // La planilla de alta complejidad lleva el N° de afiliado en un campo
    // propio (nunca el DNI): si el paciente no lo tiene cargado, hay que
    // preguntárselo y guardarlo en su ficha antes de emitir.
    if ((complejidad === "alta" || columnaCompleta) && !paciente.nroAfiliado?.trim()) faltan.push("nroAfiliado");
    return faltan;
  };

  // Catálogo de prácticas para autocompletar el nombre del estudio
  const { data: catalogoData } = useQuery({
    queryKey: ["practicas-catalogo"],
    queryFn: () => getPracticasCatalogo(true),
    staleTime: 5 * 60 * 1000,
  });
  const practicasCatalogo = [...(catalogoData?.practicas ?? [])].sort(
    (a, b) =>
      prioridadEspecialidad(a.especialidad) - prioridadEspecialidad(b.especialidad) ||
      a.nombre.localeCompare(b.nombre, "es"),
  );

  // "ecodoppler" no existe como categoría en el catálogo: son las prácticas Doppler de cardiología
  const practicasDeCategoria = practicasCatalogo.filter((p) =>
    categoria === "ecodoppler"
      ? p.categoria === "cardiologia" && normalizarTexto(p.nombre).includes("doppler")
      : p.categoria === categoria,
  );

  // Baja complejidad: todo el nomenclador (RX, ecografías, cardiología,
  // laboratorio, mamografías, etc.) MENOS tomografías, resonancias y
  // ecodoppler, que van por el circuito de alta complejidad.
  const practicasBaja = practicasCatalogo.filter(
    (p) =>
      !["tomografia", "resonancia"].includes(p.categoria ?? "") &&
      !normalizarTexto(p.nombre).includes("doppler"),
  );

  const elegirComplejidad = (c: "baja" | "alta") => {
    setComplejidad(c);
    setColumnaCompleta(false);
    setCategoria("");
    setPracticaSel(null);
    setContraste(false);
    setResumenHc("");
    setManiobras({});
    setManiobrasDer({});
    setManiobrasIzq({});
    setLadoMasDoloroso("");
    setBilateralManual(false);
    setManiobrasExtra([]);
    setManiobraCustom("");
    setTiempoDolor("");
    setLadoDolor("");
    setCaracteristicasDolor("");
    setNroOrdenSesion(1);
    setForm((f) => ({ ...f, studyName: "", preparationRequired: "", studyType: c === "baja" ? "otro" : "imagenes" }));
  };

  const elegirCategoria = (cat: string) => {
    setCategoria(cat);
    setColumnaCompleta(false);
    setPracticaSel(null);
    setContraste(false);
    setManiobras({});
    setManiobrasDer({});
    setManiobrasIzq({});
    setLadoMasDoloroso("");
    setBilateralManual(false);
    setManiobrasExtra([]);
    setManiobraCustom("");
    setTiempoDolor("");
    setLadoDolor("");
    setCaracteristicasDolor("");
    setForm((f) => ({ ...f, studyName: "", preparationRequired: "", studyType: "imagenes" }));
  };

  const elegirColumnaCompleta = () => {
    setColumnaCompleta(true);
    setCategoria("");
    setPracticaSel(null);
    setContraste(false);
    setResumenHc("");
    setManiobras({});
    setManiobrasDer({});
    setManiobrasIzq({});
    setLadoMasDoloroso("");
    setBilateralManual(false);
    setManiobrasExtra([]);
    setManiobraCustom("");
    setTiempoDolor("");
    setLadoDolor("");
    setCaracteristicasDolor("");
    setForm((f) => ({ ...f, studyName: "", preparationRequired: "", studyType: "imagenes" }));
  };

  const elegirPractica = (p: PracticaCatalogo) => {
    setPracticaSel(p);
    setContraste(false);
    setManiobras({});
    setManiobrasDer({});
    setManiobrasIzq({});
    setLadoMasDoloroso("");
    setBilateralManual(false);
    setManiobrasExtra([]);
    setManiobraCustom("");
    setTiempoDolor("");
    setLadoDolor("");
    setCaracteristicasDolor("");
    setForm((f) => ({
      ...f,
      studyName: p.nombre,
      studyType: "imagenes",
      preparationRequired: p.preparacion ?? "",
    }));
  };

  const codigosPractica = practicaSel?.reglasKlinicos?.practiceCode ?? null;
  const sinFirma = useFirmaPropiaFaltante();

  const avisoSinFirma = () => {
    if (sinFirma) {
      toast({
        title: "La orden salió sin firma",
        description: "No tenés tu firma cargada en el sistema. Pedí en administración que carguen tu firma escaneada.",
        variant: "destructive",
      });
    }
  };

  const crear = useCreateStudyOrder({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getGetPatientStudyOrdersQueryKey(pacienteId) });
        queryClient.invalidateQueries({ queryKey: getGetPatientTimelineQueryKey(pacienteId) });
        queryClient.invalidateQueries({ queryKey: getGetPatientIndicacionesQueryKey(pacienteId) });
        if (complejidad === "baja") {
          // Dejar el formulario listo para cargar la siguiente orden del mismo paciente
          setForm((f) => ({ ...f, studyName: "", clinicalJustification: "", preparationRequired: "" }));
          setPracticaSel(null);
          toast({ title: `Orden ${nroOrdenSesion} emitida`, description: `Podés cargar la orden ${nroOrdenSesion + 1} o cerrar el formulario.` });
          avisoSinFirma();
          setNroOrdenSesion((n) => n + 1);
        } else {
          setForm({ studyType: "imagenes", studyName: "", clinicalJustification: "", priority: "normal", preparationRequired: "", profesionalId: "" });
          setComplejidad("");
          setResumenHc("");
          setCategoria("");
          setPracticaSel(null);
          setContraste(false);
          setManiobras({});
          setManiobrasDer({});
          setManiobrasIzq({});
          setLadoMasDoloroso("");
          setBilateralManual(false);
          setManiobrasExtra([]);
          setManiobraCustom("");
          setTiempoDolor("");
          setLadoDolor("");
          setCaracteristicasDolor("");
          toast({ title: "Orden de estudio emitida" });
          avisoSinFirma();
        }
      },
      onError: (e) => toast({ title: "Error al emitir la orden", description: e.message, variant: "destructive" }),
    },
  });

  const generarResumen = useGenerarResumenHc({
    mutation: {
      onSuccess: (r) => {
        setResumenHc(r.resumen);
        if (r.justificacion) setForm((f) => ({ ...f, clinicalJustification: r.justificacion! }));
        toast({
          title: r.justificacion ? "Justificación y resumen generados con IA" : "Resumen generado con IA",
          description: "Redactados a partir de las maniobras marcadas y la historia clínica.",
        });
      },
      onError: (e) => {
        const msg = (e as { data?: { error?: string } })?.data?.error ?? (e as Error).message;
        toast({ title: "No se pudo generar el resumen", description: msg, variant: "destructive" });
      },
    },
  });

  const validarOrden = () => {
    if (!form.studyName.trim()) {
      toast({ title: "Ingresá el nombre del estudio", variant: "destructive" });
      return false;
    }
    if (complejidad === "baja" && contarEstudios(form.studyName) > 4) {
      toast({
        title: "Máximo 4 prácticas por orden",
        description: "Emití esta orden con hasta 4 prácticas y luego cargá otra orden con el resto.",
        variant: "destructive",
      });
      return false;
    }
    if (esAdmin && !form.profesionalId) {
      toast({ title: "Seleccioná el profesional prescriptor", variant: "destructive" });
      return false;
    }
    return true;
  };

  // En alta complejidad el resumen de HC se genera solo con IA (a partir de
  // las maniobras marcadas y las notas) al emitir o previsualizar la orden.
  // Devuelve el resumen listo, o null si la generación falló (ya avisó el toast).
  const asegurarResumenHc = async (): Promise<string | null> => {
    if (complejidad !== "alta") return "";
    const bilat = infoBilateral();
    if (bilat && !ladoMasDoloroso) {
      toast({ title: "Indicá cuál es la más dolorosa", description: "En un estudio de ambas articulaciones hay que marcar cuál presenta más dolor.", variant: "destructive" });
      return null;
    }
    if (resumenHc.trim()) return resumenHc.trim();
    // Notas del médico: tiempo de evolución del dolor, lado (interno/externo)
    // y la justificación clínica si la escribió.
    const notas = [
      tiempoDolor.trim() ? `Tiempo de evolución del dolor: ${tiempoDolor.trim()}` : "",
      ladoDolor ? `Dolor en la cara ${ladoDolor === "interno" ? "interna" : "externa"}` : "",
      caracteristicasDolor.trim() ? `Características del dolor: ${caracteristicasDolor.trim()}` : "",
      form.clinicalJustification.trim(),
    ].filter(Boolean).join(". ");
    try {
      const r = await generarResumen.mutateAsync({
        patientId: pacienteId,
        data: {
          estudio: nombreEstudioFinal() || undefined,
          maniobras: bilat
            ? listaManiobrasBilateral(bilat.region)
            : practicaSel
              ? listaManiobras()
              : [],
          notasMedico: notas || undefined,
          ...(bilat && ladoMasDoloroso ? { bilateral: { region: bilat.region, ladoMasDoloroso } } : {}),
        },
      });
      return r.resumen;
    } catch {
      return null; // el onError del hook ya mostró el aviso
    }
  };

  // Emite las 6 órdenes de "Columna completa": para cada resonancia genera con
  // IA el resumen/justificación (mismas maniobras para las tres regiones) y
  // luego crea las 3 RX de baja complejidad, una por región.
  const emitirColumnaCompleta = async (omitirChequeoDatos = false) => {
    if (emitiendoColumna) return; // evita doble emisión del lote
    if (esAdmin && !form.profesionalId) {
      toast({ title: "Seleccioná el profesional prescriptor", variant: "destructive" });
      return;
    }
    if (!omitirChequeoDatos && camposFaltantes().length > 0) {
      setDatosFaltantes({ dni: "", cobertura: "", nroAfiliado: "" });
      setDialogDatosAbierto(true);
      return;
    }
    // Las 3 resonancias deben salir con su práctica de catálogo (código de
    // facturación); si alguna no matchea, avisar antes de emitir nada.
    const practicasAlta = COLUMNA_COMPLETA_ALTA.map((nombre) => ({
      nombre,
      practica: practicasCatalogo.find((p) => normalizarTexto(p.nombre) === normalizarTexto(nombre)) ?? null,
    }));
    const sinCatalogo = practicasAlta.filter((x) => !x.practica);
    if (sinCatalogo.length > 0) {
      toast({
        title: "Falta una práctica en el catálogo",
        description: `No se encontró en el nomenclador: ${sinCatalogo.map((x) => x.nombre).join(", ")}. No se emitió ninguna orden.`,
        variant: "destructive",
      });
      return;
    }
    setEmitiendoColumna(true);
    const notas = [
      tiempoDolor.trim() ? `Tiempo de evolución del dolor: ${tiempoDolor.trim()}` : "",
      caracteristicasDolor.trim() ? `Características del dolor: ${caracteristicasDolor.trim()}` : "",
      form.clinicalJustification.trim(),
    ].filter(Boolean).join(". ");
    const comun = {
      patientId: pacienteId,
      ...(esAdmin && form.profesionalId ? { profesionalId: Number(form.profesionalId) } : {}),
      priority: form.priority as "normal" | "urgente",
    };
    let emitidas = 0;
    try {
      for (const { practica } of practicasAlta) {
        const r = await generarResumenHc(pacienteId, {
          estudio: practica!.nombre,
          maniobras: listaManiobras(),
          ...(notas ? { notasMedico: notas } : {}),
        });
        await createStudyOrder({
          ...comun,
          studyType: "imagenes",
          studyName: practica!.nombre,
          practicaId: practica!.id,
          ...(r.resumen?.trim() ? { resumenHc: r.resumen.trim() } : {}),
          ...((r.justificacion ?? form.clinicalJustification).trim()
            ? { clinicalJustification: (r.justificacion ?? form.clinicalJustification).trim() }
            : {}),
        });
        emitidas++;
      }
      for (const nombre of COLUMNA_COMPLETA_BAJA) {
        await createStudyOrder({
          ...comun,
          studyType: "otro",
          studyName: nombre,
          ...(form.clinicalJustification.trim() ? { clinicalJustification: form.clinicalJustification.trim() } : {}),
        });
        emitidas++;
      }
      toast({
        title: "6 órdenes de columna emitidas",
        description: "3 resonancias (alta complejidad) y 3 RX (baja), una por región: cervical, dorsal y lumbar.",
      });
      elegirComplejidad("alta");
      setComplejidad("");
    } catch (e) {
      toast({
        title: emitidas > 0 ? `Se emitieron ${emitidas} de 6 órdenes` : "No se pudieron emitir las órdenes",
        description: e instanceof Error ? e.message : "Error desconocido. Revisá el listado antes de reintentar para no duplicar.",
        variant: "destructive",
      });
    } finally {
      setEmitiendoColumna(false);
      if (emitidas > 0) avisoSinFirma();
      queryClient.invalidateQueries({ queryKey: getGetPatientStudyOrdersQueryKey(pacienteId) });
      queryClient.invalidateQueries({ queryKey: getGetPatientTimelineQueryKey(pacienteId) });
      queryClient.invalidateQueries({ queryKey: getGetPatientIndicacionesQueryKey(pacienteId) });
    }
  };

  const emitir = async () => {
    if (!validarOrden()) return;
    const resumen = await asegurarResumenHc();
    if (resumen === null) return;
    // Mostrar la orden final para confirmar o editar antes de emitir
    setOrdenFinal({ resumen });
  };

  // Chequea datos faltantes de la ficha y emite (o abre el popup de datos)
  const continuarEmision = (resumen: string) => {
    if (camposFaltantes().length > 0) {
      setDatosFaltantes({ dni: "", cobertura: "", nroAfiliado: "" });
      setDialogDatosAbierto(true);
      return;
    }
    crear.mutate({ data: armarPayloadOrden(resumen) });
  };

  // Guarda en la ficha del paciente lo que se completó y emite la orden.
  const guardarDatosYEmitir = async (emitirLuego: boolean) => {
    const cambios: Record<string, string> = {};
    for (const campo of camposFaltantes()) {
      const valor = datosFaltantes[campo].trim();
      if (valor) cambios[campo] = valor;
    }
    if (Object.keys(cambios).length > 0) {
      try {
        await actualizarPaciente.mutateAsync({ id: pacienteId, data: cambios });
        queryClient.invalidateQueries({ queryKey: getGetPacienteQueryKey(pacienteId) });
        toast({ title: "Ficha del paciente actualizada" });
      } catch {
        return; // el onError del hook ya mostró el aviso
      }
    }
    setDialogDatosAbierto(false);
    if (emitirLuego) {
      if (columnaCompleta) void emitirColumnaCompleta(true);
      else crear.mutate({ data: armarPayloadOrden() });
    }
  };

  const [previsualizando, setPrevisualizando] = useState(false);
  const [nroOrdenSesion, setNroOrdenSesion] = useState(1);

  const contarEstudios = (texto: string) =>
    texto.split(/[,\n]/).map((s) => s.trim()).filter(Boolean).length;

  const armarPayloadOrden = (resumenOverride?: string) => ({
    patientId: pacienteId,
    ...(esAdmin && form.profesionalId ? { profesionalId: Number(form.profesionalId) } : {}),
    studyType: form.studyType as "laboratorio" | "imagenes" | "procedimiento" | "otro",
    studyName: nombreEstudioFinal(),
    ...(practicaSel ? { practicaId: practicaSel.id } : {}),
    ...(practicaSel?.permiteContraste ? { contraste } : {}),
    ...(form.clinicalJustification.trim() ? { clinicalJustification: form.clinicalJustification.trim() } : {}),
    ...(complejidad === "alta" && (resumenOverride ?? resumenHc).trim()
      ? { resumenHc: (resumenOverride ?? resumenHc).trim() }
      : {}),
    priority: form.priority as "normal" | "urgente",
    ...(form.preparationRequired.trim() ? { preparationRequired: form.preparationRequired.trim() } : {}),
  });

  const verVistaPrevia = async () => {
    if (!form.studyName.trim()) {
      toast({ title: "Ingresá el nombre del estudio", variant: "destructive" });
      return;
    }
    if (esAdmin && !form.profesionalId) {
      toast({ title: "Seleccioná el profesional prescriptor", variant: "destructive" });
      return;
    }
    const resumen = await asegurarResumenHc();
    if (resumen === null) return;
    setPrevisualizando(true);
    try {
      const token = typeof window !== "undefined" ? localStorage.getItem("auth_token") : null;
      const res = await fetch("/api/consultorio/study-orders/preview-pdf", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(armarPayloadOrden(resumen)),
      });
      if (!res.ok) {
        const cuerpo = await res.json().catch(() => null);
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
  };

  const ordenes: OrdenEstudio[] = data ?? [];

  return (
    <div className="space-y-4">
      {puedeEmitir && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2"><FlaskConical className="w-4 h-4 text-primary" /> Nueva orden de estudio</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {esAdmin
              ? <SelectorProfesional etiqueta="Profesional prescriptor" value={form.profesionalId} onChange={(v) => setForm({ ...form, profesionalId: v })} />
              : <PrescriptorFijo />}

            {/* Paso 0: complejidad de la orden */}
            <div>
              <Label className="text-xs text-muted-foreground">Tipo de orden médica *</Label>
              <div className="grid sm:grid-cols-2 gap-2 mt-1">
                <button
                  type="button"
                  onClick={() => elegirComplejidad("baja")}
                  className={`rounded-lg border p-3 text-left transition-colors ${complejidad === "baja" ? "border-primary bg-primary/5" : "hover:bg-muted/50"}`}
                  data-testid="card-baja-complejidad"
                >
                  <p className="font-medium text-sm flex items-center gap-2"><FileText className="w-4 h-4 text-primary" /> Baja complejidad</p>
                  <p className="text-xs text-muted-foreground mt-0.5">RX, ecografías, prácticas cardiológicas, laboratorio, mamografías y demás estudios de rutina.</p>
                </button>
                <button
                  type="button"
                  onClick={() => elegirComplejidad("alta")}
                  className={`rounded-lg border p-3 text-left transition-colors ${complejidad === "alta" ? "border-primary bg-primary/5" : "hover:bg-muted/50"}`}
                  data-testid="card-alta-complejidad"
                >
                  <p className="font-medium text-sm flex items-center gap-2"><Scan className="w-4 h-4 text-primary" /> Alta complejidad</p>
                  <p className="text-xs text-muted-foreground mt-0.5">Resonancia, tomografía, ecodoppler y más — con asistente, contraste y códigos de facturación.</p>
                </button>
              </div>
            </div>

            {/* Baja complejidad: texto libre en un solo paso */}
            {complejidad === "baja" && (
              <div>
                <div className="flex items-center justify-between">
                  <Label className="text-xs text-muted-foreground">Estudios solicitados *</Label>
                  <Badge variant="secondary" className="text-xs" data-testid="badge-nro-orden">Orden {nroOrdenSesion}</Badge>
                </div>
                <p className="text-xs text-muted-foreground mt-0.5">
                  Hasta 4 prácticas por orden. Si necesitás más, emití esta orden y cargá otra: se rotulan como orden 1, orden 2, etc.
                </p>
                <TextareaAutocompletado
                  value={form.studyName}
                  onChange={(v) => { setPracticaSel(null); setForm({ ...form, studyName: v }); }}
                  sugerencias={[...ESTUDIOS_FRECUENTES, ...practicasBaja.map((p) => p.nombre)]}
                  placeholder={"Ej: Ecografía de abdomen\nRx de tórax"}
                  rows={4}
                  className="mt-1 text-base"
                  data-testid="input-baja-complejidad"
                />
              </div>
            )}

            {/* Paso 1 (alta): tipo de estudio (solo Resonancia, Tomografía y Ecodoppler) */}
            {complejidad === "alta" && (
              <div>
                <Label className="text-xs text-muted-foreground">Tipo de estudio *</Label>
                <div className="flex flex-wrap gap-1.5 mt-1">
                  {CATEGORIAS_ALTA.map((c) => (
                    <Button
                      key={c.value}
                      type="button"
                      size="sm"
                      variant={categoria === c.value ? "default" : "outline"}
                      onClick={() => elegirCategoria(c.value)}
                      data-testid={`chip-categoria-${c.value}`}
                    >
                      {c.label}
                    </Button>
                  ))}
                  <Button
                    type="button"
                    size="sm"
                    variant={columnaCompleta ? "default" : "outline"}
                    onClick={elegirColumnaCompleta}
                    data-testid="chip-columna-completa"
                  >
                    Columna completa
                  </Button>
                </div>
                {columnaCompleta && (
                  <div className="mt-2 rounded-md border border-sky-200 bg-sky-50 dark:bg-sky-950/30 dark:border-sky-900 px-3 py-2 text-xs space-y-1">
                    <p className="font-medium text-sm">Se emiten 6 órdenes de una vez (una por región):</p>
                    <p>Alta complejidad: {COLUMNA_COMPLETA_ALTA.join(" · ")}</p>
                    <p>Baja complejidad: {COLUMNA_COMPLETA_BAJA.join(" · ")}</p>
                    <p className="text-muted-foreground">Las maniobras que marques abajo aplican a toda la columna y alimentan la justificación de las tres resonancias.</p>
                  </div>
                )}
              </div>
            )}

            {/* Paso 2 (alta): estudio */}
            {complejidad === "alta" && categoria && (
              <div>
                <Label className="text-xs text-muted-foreground">Estudio solicitado *</Label>
                <Popover open={buscadorAbierto} onOpenChange={setBuscadorAbierto}>
                  <PopoverTrigger asChild>
                    <Button
                      type="button"
                      variant="outline"
                      role="combobox"
                      className="w-full mt-1 h-12 justify-between text-base font-normal whitespace-normal text-left"
                      data-testid="combo-practica"
                    >
                      <span className={practicaSel ? "" : "text-muted-foreground"}>
                        {practicaSel ? practicaSel.nombre : "Buscá y elegí el estudio…"}
                      </span>
                      <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent className="p-0 w-[var(--radix-popover-trigger-width)]" align="start">
                    <Command filter={filtroSinAcentos}>
                      <CommandInput placeholder="Escribí para buscar…" data-testid="input-buscar-practica" />
                      <CommandList className="max-h-72">
                        <CommandEmpty>No se encontraron estudios en esta categoría.</CommandEmpty>
                        {practicasDeCategoria.map((p) => (
                          <CommandItem
                            key={p.id}
                            value={p.nombre}
                            onSelect={() => { elegirPractica(p); setBuscadorAbierto(false); }}
                            className="py-2.5 text-sm"
                            data-testid={`btn-practica-${p.id}`}
                          >
                            <Check className={`mr-2 h-4 w-4 shrink-0 ${practicaSel?.id === p.id ? "opacity-100" : "opacity-0"}`} />
                            {p.nombre}
                          </CommandItem>
                        ))}
                      </CommandList>
                    </Command>
                  </PopoverContent>
                </Popover>
              </div>
            )}

            {/* Paso 3: contraste + códigos */}
            {practicaSel?.permiteContraste && (
              <label className="flex items-center gap-2 text-sm cursor-pointer" data-testid="check-contraste">
                <Checkbox checked={contraste} onCheckedChange={(v) => setContraste(v === true)} />
                Con contraste
              </label>
            )}
            {practicaSel && (
              <p className="text-xs text-muted-foreground">
                {codigosPractica
                  ? <>Código(s) para facturación: <span className="font-medium text-foreground">{codigosPractica}</span></>
                  : "Esta práctica no tiene código de facturación cargado."}
              </p>
            )}

            {/* Características del cuadro (alta complejidad): alimentan al asistente IA.
                Resonancia articular → maniobras; Ecodoppler → signos/síntomas por región;
                Tomografía → texto a mano. */}
            {complejidad === "alta" && (practicaSel || columnaCompleta) && (() => {
              const esTomografia = !columnaCompleta && categoria === "tomografia";
              const esDoppler = !columnaCompleta && categoria === "ecodoppler";
              const sugeridas = columnaCompleta
                ? maniobrasSugeridas("columna")
                : esTomografia
                  ? null
                  : esDoppler
                    ? sintomasDoppler(practicaSel!.nombre)
                    : maniobrasSugeridas(practicaSel!.nombre);
              const items: Maniobra[] = [
                ...(sugeridas?.maniobras ?? []),
                ...maniobrasExtra
                  .filter((m) => !(sugeridas?.maniobras ?? []).some((s) => s.nombre === m))
                  .map((m) => ({ nombre: m, definicion: m })),
              ];
              // Estudio bilateral (AMBAS rodillas/caderas/etc.): ficha por lado
              const bilat = infoBilateral();
              const fichaLado = (lado: "derecha" | "izquierda") => {
                const estadoDe = lado === "derecha" ? maniobrasDer : maniobrasIzq;
                return (
                  <div key={lado} className="rounded-md border p-2 space-y-1.5">
                    <p className="text-xs font-medium capitalize">{bilat ? regionConLado(bilat.region, lado) : lado}</p>
                    <div className="flex flex-wrap gap-1.5">
                      {items.map((m) => {
                        const estado = estadoDe[m.nombre];
                        return (
                          <div key={m.nombre} className="flex items-center rounded-full border overflow-hidden text-sm" title={m.nombre}>
                            <span className="px-2.5 py-1.5">{m.definicion}</span>
                            <button
                              type="button"
                              onClick={() => alternarManiobraLado(lado, m.nombre, "positiva")}
                              className={`px-2.5 py-1.5 text-base leading-none border-l ${estado === "positiva" ? "bg-red-600 text-white" : "text-muted-foreground hover:bg-muted"}`}
                              data-testid={`maniobra-${lado}-pos-${m.nombre}`}
                              title="Positiva"
                            >
                              +
                            </button>
                            <button
                              type="button"
                              onClick={() => alternarManiobraLado(lado, m.nombre, "negativa")}
                              className={`px-2.5 py-1.5 text-base leading-none border-l ${estado === "negativa" ? "bg-emerald-600 text-white" : "text-muted-foreground hover:bg-muted"}`}
                              data-testid={`maniobra-${lado}-neg-${m.nombre}`}
                              title="Negativa"
                            >
                              −
                            </button>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                );
              };
              return (
                <div className="rounded-md border p-3 space-y-2" data-testid="seccion-maniobras">
                  <div className="grid sm:grid-cols-2 gap-3">
                    <div className="sm:col-span-2">
                      <Label className="text-xs text-muted-foreground">Evolución del cuadro</Label>
                      <div className="flex flex-wrap gap-1.5 mt-1">
                        {EVOLUCION_OPCIONES.map((op) => (
                          <button
                            key={op}
                            type="button"
                            onClick={() => setTiempoDolor((t) => (t === op ? "" : op))}
                            className={`rounded-full border px-3 py-1.5 text-xs ${tiempoDolor === op ? "bg-primary text-primary-foreground border-primary" : "text-muted-foreground hover:bg-muted"}`}
                            data-testid={`boton-evolucion-${op.replace(/\s+/g, "-")}`}
                          >
                            {op}
                          </button>
                        ))}
                      </div>
                    </div>
                    {!columnaCompleta && !esTomografia && !esDoppler && practicaSel && REGIONES_ARTICULARES.includes(sugeridas?.region ?? "") && (
                      <div className="sm:col-span-2">
                        <Label className="text-xs text-muted-foreground">¿El estudio es de ambas articulaciones?</Label>
                        <div className="flex gap-2 mt-1">
                          <button
                            type="button"
                            disabled={esEstudioBilateral(practicaSel.nombre)}
                            onClick={() => { setBilateralManual((v) => !v); setResumenHc(""); }}
                            className={`rounded-full border px-3 py-1.5 text-xs ${bilat ? "bg-primary text-primary-foreground border-primary" : "text-muted-foreground hover:bg-muted"}`}
                            data-testid="boton-bilateral"
                          >
                            Sí, ambas (derecha e izquierda)
                          </button>
                        </div>
                      </div>
                    )}
                    {!bilat && ["Rodilla", "Tobillo y pie", "Codo", "Muñeca y mano", "Hombro", "Cadera"].includes(sugeridas?.region ?? "") && (
                      <div>
                        <Label className="text-xs text-muted-foreground">Lado del dolor</Label>
                        <div className="flex gap-2 mt-1">
                          {(["interno", "externo"] as const).map((lado) => (
                            <button
                              key={lado}
                              type="button"
                              onClick={() => setLadoDolor((l) => (l === lado ? "" : lado))}
                              className={`rounded-full border px-3 py-1.5 text-xs capitalize ${ladoDolor === lado ? "bg-primary text-primary-foreground border-primary" : "text-muted-foreground hover:bg-muted"}`}
                              data-testid={`boton-lado-${lado}`}
                            >
                              {lado}
                            </button>
                          ))}
                        </div>
                      </div>
                    )}
                    <div className="sm:col-span-2">
                      <Label className="text-xs text-muted-foreground">
                        {esTomografia ? "Características del cuadro (escribilas a mano)" : "Características específicas del cuadro"}
                      </Label>
                      {esTomografia ? (
                        <Textarea
                          value={caracteristicasDolor}
                          onChange={(e) => setCaracteristicasDolor(e.target.value)}
                          rows={3}
                          placeholder="Describí el cuadro clínico que motiva la tomografía…"
                          data-testid="input-caracteristicas-dolor"
                        />
                      ) : (
                        <Input
                          value={caracteristicasDolor}
                          onChange={(e) => setCaracteristicasDolor(e.target.value)}
                          placeholder="Ej: punzante, aparece al subir escaleras, cede en reposo"
                          data-testid="input-caracteristicas-dolor"
                        />
                      )}
                    </div>
                  </div>
                  {!esTomografia && bilat && (<>
                  <div>
                    <Label className="text-xs font-medium">
                      Estudio de ambas: ficha de síntomas por lado <span className="font-normal text-muted-foreground">· {bilat.region}</span>
                    </Label>
                    <p className="text-xs text-muted-foreground">
                      Marcá las maniobras de cada lado por separado. La orden va a dejar claro cuál es la más dolorosa y que la otra necesita descartar o establecer {["Hombro", "Codo", "Muñeca y mano"].includes(bilat.region) ? "proceso degenerativo articular" : "sobrecarga compensatoria"} o enfermedad bilateral.
                    </p>
                  </div>
                  <div>
                    <Label className="text-xs text-muted-foreground">¿Cuál es la más dolorosa? *</Label>
                    <div className="flex gap-2 mt-1">
                      {(["derecha", "izquierda"] as const).map((lado) => (
                        <button
                          key={lado}
                          type="button"
                          onClick={() => { setLadoMasDoloroso((l) => (l === lado ? "" : lado)); setResumenHc(""); }}
                          className={`rounded-full border px-3 py-1.5 text-xs capitalize ${ladoMasDoloroso === lado ? "bg-primary text-primary-foreground border-primary" : "text-muted-foreground hover:bg-muted"}`}
                          data-testid={`boton-mas-dolorosa-${lado}`}
                        >
                          {regionConLado(bilat.region, lado)}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div className="grid sm:grid-cols-2 gap-2">
                    {fichaLado("derecha")}
                    {fichaLado("izquierda")}
                  </div>
                  </>)}
                  {!esTomografia && !bilat && (<>
                  <div>
                    <Label className="text-xs font-medium">
                      {esDoppler ? "Signos y síntomas" : "Maniobras semiológicas"} {sugeridas ? `· ${sugeridas.region}` : ""} <span className="font-normal text-muted-foreground">(opcional)</span>
                    </Label>
                    <p className="text-xs text-muted-foreground">
                      {esDoppler
                        ? "Marcá con + lo que el paciente presenta (justifica el estudio) y con − lo que descartaste. La IA usa todo esto para redactar la justificación y el resumen."
                        : "Si querés, marcá maniobras del examen físico como positivas o negativas. La IA usa todo esto para redactar la justificación y el resumen."}
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {items.map((m) => {
                      const estado = maniobras[m.nombre];
                      return (
                        <div key={m.nombre} className="flex items-center rounded-full border overflow-hidden text-sm" title={m.nombre}>
                          <span className="px-2.5 py-1.5">{m.definicion}</span>
                          <button
                            type="button"
                            onClick={() => alternarManiobra(m.nombre, "positiva")}
                            className={`px-2.5 py-1.5 text-base leading-none border-l ${estado === "positiva" ? "bg-red-600 text-white" : "text-muted-foreground hover:bg-muted"}`}
                            data-testid={`maniobra-pos-${m.nombre}`}
                            title="Positiva"
                          >
                            +
                          </button>
                          <button
                            type="button"
                            onClick={() => alternarManiobra(m.nombre, "negativa")}
                            className={`px-2.5 py-1.5 text-base leading-none border-l ${estado === "negativa" ? "bg-emerald-600 text-white" : "text-muted-foreground hover:bg-muted"}`}
                            data-testid={`maniobra-neg-${m.nombre}`}
                            title="Negativa"
                          >
                            −
                          </button>
                        </div>
                      );
                    })}
                    {items.length === 0 && (
                      <p className="text-xs text-muted-foreground">No hay maniobras sugeridas para este estudio. Podés agregarlas a mano.</p>
                    )}
                  </div>
                  </>)}
                  {!esTomografia && (
                  <div className="flex gap-2">
                    <Input
                      value={maniobraCustom}
                      onChange={(e) => setManiobraCustom(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          const v = maniobraCustom.trim();
                          if (v && !items.some((i) => i.nombre === v)) setManiobrasExtra((x) => [...x, v]);
                          setManiobraCustom("");
                        }
                      }}
                      placeholder={esDoppler ? "Agregar otro signo o síntoma (Enter)" : "Agregar otra maniobra (Enter)"}
                      className="h-8 text-xs"
                      data-testid="input-maniobra-custom"
                    />
                  </div>
                  )}
                </div>
              );
            })()}

            {(complejidad === "baja" || categoria || columnaCompleta) && (
              <div className="grid sm:grid-cols-3 gap-3">
                <div>
                  <Label className="text-xs text-muted-foreground">Prioridad</Label>
                  <Select value={form.priority} onValueChange={(v) => setForm({ ...form, priority: v })}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="normal">Normal</SelectItem>
                      <SelectItem value="urgente">Urgente</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="sm:col-span-2">
                  <Label className="text-xs text-muted-foreground">Preparación previa</Label>
                  <Input value={form.preparationRequired} onChange={(e) => setForm({ ...form, preparationRequired: e.target.value })} placeholder="Ej: ayuno de 8 horas" />
                </div>
              </div>
            )}
            {(complejidad === "baja" || categoria || columnaCompleta) && (
              <>
                <div>
                  <Label className="text-xs text-muted-foreground">Justificación clínica</Label>
                  <TextareaAutocompletado
                    value={form.clinicalJustification}
                    onChange={(v) => setForm({ ...form, clinicalJustification: v })}
                    sugerencias={JUSTIFICACIONES_FRECUENTES}
                    rows={2}
                    className="field-sizing-content resize-none overflow-hidden"
                    data-testid="input-justificacion-clinica"
                  />
                </div>
                {complejidad === "alta" && !columnaCompleta && (
                  <div>
                    <Label className="text-xs text-muted-foreground mb-1 block">Resumen de historia clínica (sale impreso en la planilla)</Label>
                    <Textarea
                      value={resumenHc}
                      onChange={(e) => setResumenHc(e.target.value)}
                      rows={4}
                      className="field-sizing-content resize-none overflow-hidden"
                      placeholder="Se redacta solo con IA al emitir la orden, a partir de las maniobras marcadas y la justificación. Si escribís algo acá, se respeta tu texto."
                      data-testid="input-resumen-hc"
                    />
                  </div>
                )}
                {columnaCompleta ? (
                  <div className="space-y-1.5">
                    <Button
                      onClick={() => void emitirColumnaCompleta()}
                      disabled={emitiendoColumna}
                      className="gap-1"
                      data-testid="button-emitir-columna-completa"
                    >
                      {emitiendoColumna ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
                      {emitiendoColumna ? "Emitiendo órdenes…" : "Emitir las 6 órdenes"}
                    </Button>
                    {emitiendoColumna && (
                      <p className="text-xs text-muted-foreground">Generando la justificación de cada resonancia con IA; puede demorar unos segundos.</p>
                    )}
                  </div>
                ) : (
                <div className="flex flex-wrap gap-2">
                  <Button onClick={emitir} disabled={crear.isPending || generarResumen.isPending} className="gap-1">
                    {crear.isPending || generarResumen.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />} Emitir orden
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    onClick={verVistaPrevia}
                    disabled={previsualizando || crear.isPending}
                    className="gap-1"
                    data-testid="button-vista-previa-orden"
                  >
                    {previsualizando ? <Loader2 className="w-4 h-4 animate-spin" /> : <FileText className="w-4 h-4" />} Ver vista previa
                  </Button>
                </div>
                )}
              </>
            )}
          </CardContent>
        </Card>
      )}

      {/* Orden final (alta complejidad): confirmar, editar o cancelar antes de emitir */}
      <Dialog open={ordenFinal !== null} onOpenChange={(abierto) => { if (!abierto) setOrdenFinal(null); }}>
        <DialogContent data-testid="dialog-orden-final">
          <DialogHeader>
            <DialogTitle>Orden final</DialogTitle>
            <DialogDescription>
              Revisá la orden antes de emitirla. Podés emitirla así o editarla antes.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2 text-sm">
            <p className="whitespace-pre-wrap"><span className="font-semibold">{complejidad === "baja" ? "Estudios:" : "Estudio:"}</span> {form.studyName}{contraste ? " (con contraste)" : ""}</p>
            {form.clinicalJustification.trim() && (
              <p><span className="font-semibold">Justificación:</span> {form.clinicalJustification}</p>
            )}
            {complejidad === "alta" && (
              <div>
                <p className="font-semibold mb-1">Resumen de historia clínica:</p>
                <p className="rounded-md border bg-muted/40 p-2 whitespace-pre-wrap text-xs" data-testid="texto-resumen-final">{ordenFinal?.resumen || "—"}</p>
              </div>
            )}
          </div>
          <DialogFooter className="gap-2">
            <Button
              variant="outline"
              onClick={() => {
                if (ordenFinal && complejidad === "alta") setResumenHc(ordenFinal.resumen);
                setOrdenFinal(null);
                toast({ title: "Editá la orden en el formulario", description: "Cuando termines, tocá Emitir orden de nuevo." });
              }}
              data-testid="button-editar-orden-final"
            >
              Editar
            </Button>
            <Button
              onClick={() => {
                if (!ordenFinal) return;
                setResumenHc(ordenFinal.resumen);
                const r = ordenFinal.resumen;
                setOrdenFinal(null);
                continuarEmision(r);
              }}
              disabled={crear.isPending}
              className="gap-1"
              data-testid="button-confirmar-orden-final"
            >
              {crear.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />} Emitir orden
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={dialogDatosAbierto} onOpenChange={setDialogDatosAbierto}>
        <DialogContent data-testid="dialog-datos-faltantes">
          <DialogHeader>
            <DialogTitle>Completar datos del paciente</DialogTitle>
            <DialogDescription>
              A la ficha de {paciente ? `${paciente.nombre} ${paciente.apellido}` : "este paciente"} le faltan datos para que la orden salga completa. Lo que cargues acá queda guardado en su historia clínica.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            {camposFaltantes().includes("dni") && (
              <div>
                <Label className="text-xs text-muted-foreground">DNI</Label>
                <Input
                  value={datosFaltantes.dni}
                  onChange={(e) => setDatosFaltantes((d) => ({ ...d, dni: e.target.value }))}
                  placeholder="Ej: 30123456"
                  data-testid="input-faltante-dni"
                />
              </div>
            )}
            {camposFaltantes().includes("cobertura") && (
              <div>
                <Label className="text-xs text-muted-foreground">Obra social / cobertura</Label>
                <Input
                  value={datosFaltantes.cobertura}
                  onChange={(e) => setDatosFaltantes((d) => ({ ...d, cobertura: e.target.value }))}
                  placeholder="Ej: IOMA"
                  data-testid="input-faltante-cobertura"
                />
              </div>
            )}
            {camposFaltantes().includes("nroAfiliado") && (
              <div>
                <Label className="text-xs text-muted-foreground">N° de afiliado</Label>
                <Input
                  value={datosFaltantes.nroAfiliado}
                  onChange={(e) => setDatosFaltantes((d) => ({ ...d, nroAfiliado: e.target.value }))}
                  placeholder="Preguntáselo al paciente (figura en su credencial)"
                  data-testid="input-faltante-nro-afiliado"
                />
              </div>
            )}
          </div>
          <DialogFooter className="gap-2">
            <Button
              variant="outline"
              onClick={() => {
                setDialogDatosAbierto(false);
                if (columnaCompleta) void emitirColumnaCompleta(true);
                else crear.mutate({ data: armarPayloadOrden() });
              }}
              disabled={actualizarPaciente.isPending || crear.isPending || emitiendoColumna}
              data-testid="button-emitir-sin-completar"
            >
              Emitir igual
            </Button>
            <Button
              onClick={() => guardarDatosYEmitir(true)}
              disabled={actualizarPaciente.isPending || crear.isPending || emitiendoColumna}
              className="gap-1"
              data-testid="button-guardar-y-emitir"
            >
              {actualizarPaciente.isPending || crear.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />} Guardar y emitir
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {isLoading ? (
        <Skeleton className="h-24 w-full" />
      ) : ordenes.length === 0 ? (
        <p className="text-sm text-muted-foreground text-center py-4">Sin órdenes de estudio emitidas.</p>
      ) : (
        <div className="space-y-2">
          {ordenes.map((o) => (
            <Card key={o.id}>
              <CardContent className="p-3 flex flex-wrap items-center gap-2">
                <FlaskConical className="w-4 h-4 text-primary shrink-0" />
                <div className="flex-1 min-w-40">
                  <p className="text-sm font-medium">{o.studyName}</p>
                  <p className="text-xs text-muted-foreground capitalize">
                    {o.studyType} · {fechaCorta(o.createdAt)}
                  </p>
                </div>
                {o.priority === "urgente" && <Badge variant="destructive" className="text-xs">Urgente</Badge>}
                <OrdenEstadoControl
                  orden={o}
                  onChanged={() => {
                    queryClient.invalidateQueries({ queryKey: getGetPatientStudyOrdersQueryKey(pacienteId) });
                    queryClient.invalidateQueries({ queryKey: getGetPatientTimelineQueryKey(pacienteId) });
                  }}
                />
                <BotonPdf sourceType="orden_estudio" sourceId={o.id} nombre={`orden-estudio-${o.id}`} />
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

// ── IA clínica ──────────────────────────────────────────────────────────────

function PanelIaClinica({ pacienteId }: { pacienteId: number }) {
  const { toast } = useToast();
  const [contexto, setContexto] = useState("");
  const [respuesta, setRespuesta] = useState<ClinicalAiResponse | null>(null);

  const consultar = useGetClinicalAiSuggestions({
    mutation: {
      onSuccess: (data) => setRespuesta(data),
      onError: (e) => toast({ title: "Error al consultar la IA clínica", description: e.message, variant: "destructive" }),
    },
  });

  return (
    <Card className="border-primary/30">
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <Sparkles className="w-4 h-4 text-primary" /> Asistente clínico (IA)
        </CardTitle>
        <CardDescription>Sugerencias orientativas basadas en la historia clínica del paciente.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <Textarea
          value={contexto}
          onChange={(e) => setContexto(e.target.value)}
          placeholder="Motivo de consulta, hallazgos, contexto clínico actual..."
          rows={2}
        />
        <Button
          variant="outline"
          onClick={() => consultar.mutate({ data: { patientId: pacienteId, ...(contexto.trim() ? { contexto: contexto.trim() } : {}) } })}
          disabled={consultar.isPending}
          className="gap-1"
        >
          {consultar.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />}
          Obtener sugerencias
        </Button>

        {respuesta && (
          <div className="space-y-3 pt-2">
            {respuesta.resumen && (
              <p className="text-sm bg-muted/60 rounded-md p-3">{respuesta.resumen}</p>
            )}
            <ul className="space-y-1.5">
              {respuesta.sugerencias.map((s, i) => (
                <li key={i} className="text-sm flex gap-2">
                  <span className="text-primary shrink-0">•</span> {s}
                </li>
              ))}
            </ul>
            <p className="text-xs text-muted-foreground italic border-t pt-2">{respuesta.disclaimer}</p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ── Pestaña Resolución ──────────────────────────────────────────────────────

export function TabResolucion({ pacienteId }: { pacienteId: number }) {
  return (
    <div className="space-y-4">
      <PanelIaClinica pacienteId={pacienteId} />
      <Tabs defaultValue="recetas">
        <TabsList className="grid w-full grid-cols-5">
          <TabsTrigger value="recetas"><Pill className="w-4 h-4 mr-1 hidden sm:block" /> Recetas</TabsTrigger>
          <TabsTrigger value="derivaciones"><Send className="w-4 h-4 mr-1 hidden sm:block" /> Derivaciones</TabsTrigger>
          <TabsTrigger value="certificados"><Award className="w-4 h-4 mr-1 hidden sm:block" /> Certificados</TabsTrigger>
          <TabsTrigger value="ordenes"><FlaskConical className="w-4 h-4 mr-1 hidden sm:block" /> Órdenes</TabsTrigger>
          <TabsTrigger value="indicaciones" data-testid="tab-indicaciones"><ClipboardList className="w-4 h-4 mr-1 hidden sm:block" /> Indicaciones</TabsTrigger>
        </TabsList>
        <TabsContent value="recetas" className="pt-4"><SeccionRecetas pacienteId={pacienteId} /></TabsContent>
        <TabsContent value="derivaciones" className="pt-4"><SeccionDerivaciones pacienteId={pacienteId} /></TabsContent>
        <TabsContent value="certificados" className="pt-4"><SeccionCertificados pacienteId={pacienteId} /></TabsContent>
        <TabsContent value="ordenes" className="pt-4"><SeccionOrdenes pacienteId={pacienteId} /></TabsContent>
        <TabsContent value="indicaciones" className="pt-4"><SeccionIndicaciones pacienteId={pacienteId} /></TabsContent>
      </Tabs>
    </div>
  );
}

// ── Pestaña Historial (timeline) ────────────────────────────────────────────

const TIMELINE_ICONS: Record<string, typeof FileText> = {
  consulta: Stethoscope,
  practica: ClipboardList,
  receta: Pill,
  derivacion: Send,
  certificado: Award,
  orden_estudio: FlaskConical,
  pdf: FileText,
  estudio_externo: FlaskConical,
};

const TIMELINE_LABELS: Record<string, string> = {
  consulta: "Consulta",
  practica: "Práctica",
  receta: "Receta",
  derivacion: "Derivación",
  certificado: "Certificado",
  orden_estudio: "Orden de estudio",
  pdf: "Documento PDF",
  estudio_externo: "Estudio externo (Phir-it)",
};

export function TabHistorial({ pacienteId }: { pacienteId: number }) {
  const { data, isLoading, error } = useGetPatientTimeline(pacienteId);

  if (isLoading) {
    return <div className="space-y-2">{[1, 2, 3, 4].map((i) => <Skeleton key={i} className="h-16 w-full" />)}</div>;
  }

  if (error) {
    return <p className="text-sm text-muted-foreground text-center py-6">No se pudo cargar el historial del paciente.</p>;
  }

  const items = data ?? [];

  if (items.length === 0) {
    return (
      <div className="text-center py-10">
        <History className="w-8 h-8 mx-auto text-muted-foreground/40 mb-2" />
        <p className="text-sm text-muted-foreground">Sin actividad clínica registrada.</p>
      </div>
    );
  }

  return (
    <div className="relative pl-6 space-y-4 before:absolute before:left-2 before:top-1 before:bottom-1 before:w-px before:bg-border">
      {items.map((item, i) => {
        const Icon = TIMELINE_ICONS[item.tipo] ?? FileText;
        return (
          <div key={`${item.tipo}-${item.refId}-${i}`} className="relative">
            <div className="absolute -left-6 top-1 bg-background border rounded-full p-1">
              <Icon className="w-3 h-3 text-primary" />
            </div>
            <Card>
              <CardContent className="p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant="outline" className="text-xs">{TIMELINE_LABELS[item.tipo] ?? item.tipo}</Badge>
                  <span className="text-xs text-muted-foreground">{fechaCorta(item.fecha)}</span>
                  {item.estado && <EstadoDocBadge estado={item.estado} />}
                </div>
                <p className="text-sm font-medium mt-1">{item.titulo}</p>
                {item.detalle && <p className="text-xs text-muted-foreground mt-0.5">{item.detalle}</p>}
                {item.profesionalNombre && (
                  <p className="text-xs text-muted-foreground mt-0.5">Prof. {item.profesionalNombre}</p>
                )}
              </CardContent>
            </Card>
          </div>
        );
      })}
    </div>
  );
}

function HistorialVerificaciones({ certificadoId }: { certificadoId: number }) {
  const { data, isLoading, error } = useGetCertificateVerificaciones(certificadoId);
  const verificaciones: CertificadoVerificacion[] = data ?? [];

  return (
    <div className="rounded-md border bg-muted/40 p-2" data-testid={`historial-verificaciones-${certificadoId}`}>
      <p className="text-xs font-medium mb-1.5">Verificaciones públicas del certificado</p>
      {isLoading ? (
        <Skeleton className="h-10 w-full" />
      ) : error ? (
        <p className="text-xs text-red-600 dark:text-red-400">No se pudo cargar el historial.</p>
      ) : verificaciones.length === 0 ? (
        <p className="text-xs text-muted-foreground" data-testid={`sin-verificaciones-${certificadoId}`}>
          Nadie verificó este certificado todavía.
        </p>
      ) : (
        <div className="space-y-1">
          {verificaciones.map((v) => (
            <div key={v.id} className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs" data-testid={`verificacion-${v.id}`}>
              <span className="font-medium whitespace-nowrap">
                {new Date(v.fecha).toLocaleString("es-AR", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" })} hs
              </span>
              <Badge variant="secondary" className="text-[10px] px-1.5 py-0">{MEDIO_VERIFICACION[v.via] ?? v.via}</Badge>
              <span className="text-muted-foreground">
                {[v.dispositivo, v.ip ? `IP ${v.ip}` : null].filter(Boolean).join(" · ") || "Dispositivo desconocido"}
              </span>
              {v.estadoAlMomento !== "valido" && (
                <span className="text-amber-700 dark:text-amber-300">(estaba {v.estadoAlMomento})</span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
