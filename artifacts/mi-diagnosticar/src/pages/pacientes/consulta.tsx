import { useEffect, useRef, useState } from "react";
import { Link, useLocation, useParams, useSearch } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import {
  useGetMe,
  useGetProfesional,
  useGetConsultorioWorkspace,
  getGetConsultorioWorkspaceQueryKey,
  useFinalizarConsulta,
  useEditarConsulta,
  useUpsertHceHistory,
  getGetHceHistoryQueryKey,
  getGetPatientStudyOrdersQueryKey,
  getGetPatientTimelineQueryKey,
  type FinalizarConsultaInput,
  type EncounterFull,
} from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { useToast } from "@/hooks/use-toast";
import { DicomPacsCard } from "@/components/dicom-pacs";
import {
  ArrowLeft,
  AlertTriangle,
  CalendarClock,
  CheckCircle2,
  ClipboardList,
  FileImage,
  FileText,
  FlaskConical,
  HeartPulse,
  Image as ImageIcon,
  Loader2,
  Pencil,
  Pill,
  Plus,
  Send,
  Stethoscope,
  Syringe,
  User,
} from "lucide-react";
import { format } from "date-fns";
import { es } from "date-fns/locale";
import { OrdenEstadoControl, OrdenEstadoBadge } from "./orden-estado";
import { SeccionRecetas, SeccionDerivaciones, SeccionCertificados, SeccionOrdenes } from "./resolucion";
import { PanelDerivacion, ListaSolicitudesPaciente } from "./derivacion-panel";

function fechaCorta(value?: string | null) {
  if (!value) return "";
  const d = new Date(value);
  return isNaN(d.getTime()) ? String(value) : format(d, "d MMM yyyy HH:mm", { locale: es });
}

function edad(fechaNacimiento?: string | null) {
  if (!fechaNacimiento) return null;
  const nac = new Date(`${fechaNacimiento}T12:00:00`);
  if (isNaN(nac.getTime())) return null;
  const hoy = new Date();
  let a = hoy.getFullYear() - nac.getFullYear();
  const m = hoy.getMonth() - nac.getMonth();
  if (m < 0 || (m === 0 && hoy.getDate() < nac.getDate())) a--;
  return a;
}

// ── Panel de contexto (izquierda) ───────────────────────────────────────────

function FichaItem({ label, valor, alerta }: { label: string; valor?: string | null; alerta?: boolean }) {
  return (
    <div>
      <p className="text-xs text-muted-foreground">{label}</p>
      {valor ? (
        <p className={`text-sm ${alerta ? "text-red-700 font-medium" : ""}`}>{valor}</p>
      ) : (
        <p className="text-sm text-muted-foreground/60">—</p>
      )}
    </div>
  );
}

// ── Ficha clínica editable ──────────────────────────────────────────────────
// El médico puede cargar/corregir los antecedentes del paciente acá mismo.

const FICHA_CAMPOS = [
  ["allergies", "Alergias"],
  ["chronicDiseases", "Problemas activos / enf. crónicas"],
  ["currentMedications", "Medicación habitual"],
  ["surgeries", "Cirugías previas"],
  ["familyHistory", "Antecedentes familiares"],
  ["vaccinations", "Vacunas"],
  ["notes", "Observaciones"],
] as const;

type FichaRecord = Partial<Record<(typeof FICHA_CAMPOS)[number][0], string | null>> | null | undefined;

function FichaClinicaCard({ pacienteId, record, onSaved }: {
  pacienteId: number;
  record: FichaRecord;
  onSaved: () => void;
}) {
  const { toast } = useToast();
  const [editando, setEditando] = useState(false);
  const [valores, setValores] = useState<Record<string, string>>({});
  const guardar = useUpsertHceHistory();

  const empezar = () => {
    const v: Record<string, string> = {};
    for (const [k] of FICHA_CAMPOS) v[k] = record?.[k] ?? "";
    setValores(v);
    setEditando(true);
  };

  const confirmar = async () => {
    try {
      const data: Record<string, unknown> = { patientId: pacienteId };
      for (const [k] of FICHA_CAMPOS) data[k] = valores[k]?.trim() ?? "";
      await guardar.mutateAsync({ data: data as never });
      toast({ title: "Ficha clínica guardada" });
      setEditando(false);
      onSaved();
    } catch (e) {
      toast({
        title: "No se pudo guardar la ficha",
        description: e instanceof Error ? e.message : "Error desconocido",
        variant: "destructive",
      });
    }
  };

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center gap-2">
          <FileText className="w-4 h-4 text-primary" /> Ficha clínica
          {!editando && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="ml-auto h-7 px-2"
              onClick={empezar}
              data-testid="btn-editar-ficha"
            >
              <Pencil className="w-3.5 h-3.5 mr-1" /> Editar
            </Button>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {editando ? (
          <>
            {FICHA_CAMPOS.map(([k, label]) => (
              <div key={k} className="space-y-1">
                <Label className="text-xs">{label}</Label>
                <Textarea
                  rows={2}
                  value={valores[k] ?? ""}
                  onChange={(e) => setValores((v) => ({ ...v, [k]: e.target.value }))}
                  data-testid={`input-ficha-${k}`}
                />
              </div>
            ))}
            <div className="flex gap-2 pt-1">
              <Button size="sm" onClick={confirmar} disabled={guardar.isPending} data-testid="btn-guardar-ficha">
                {guardar.isPending && <Loader2 className="w-3.5 h-3.5 mr-1 animate-spin" />} Guardar
              </Button>
              <Button size="sm" variant="outline" onClick={() => setEditando(false)} disabled={guardar.isPending}>
                Cancelar
              </Button>
            </div>
          </>
        ) : (
          <>
            <FichaItem label="Alergias" valor={record?.allergies} alerta />
            <FichaItem label="Problemas activos / enf. crónicas" valor={record?.chronicDiseases} />
            <FichaItem label="Medicación habitual" valor={record?.currentMedications} />
            <FichaItem label="Cirugías previas" valor={record?.surgeries} />
            <FichaItem label="Antecedentes familiares" valor={record?.familyHistory} />
            <div className="flex items-start gap-1.5">
              <Syringe className="w-3.5 h-3.5 text-muted-foreground mt-0.5 shrink-0" />
              <FichaItem label="Vacunas" valor={record?.vaccinations} />
            </div>
            {record?.notes && <FichaItem label="Observaciones" valor={record.notes} />}
          </>
        )}
      </CardContent>
    </Card>
  );
}

// ── Consulta actual (centro) ────────────────────────────────────────────────

type RxDraft = { medication: string; dosage: string; frequency: string; duration: string };
const rxVacia: RxDraft = { medication: "", dosage: "", frequency: "", duration: "" };

const VITALES_CAMPOS = [
  ["bloodPressure", "TA", "120/80"],
  ["heartRate", "FC (lpm)", "72"],
  ["respiratoryRate", "FR (rpm)", "16"],
  ["temperature", "T° (°C)", "36.5"],
  ["oxygenSaturation", "SatO₂ (%)", "98"],
  ["weight", "Peso (kg)", "70.5"],
  ["height", "Altura (cm)", "170"],
] as const;

const FORM_VACIO = {
  specialty: "",
  encounterType: "presencial",
  chiefComplaint: "",
  anamnesis: "",
  physicalExam: "",
  diagnosis: "",
  cie10: "",
  assessment: "",
  plan: "",
};
const VITALES_VACIOS: Record<(typeof VITALES_CAMPOS)[number][0], string> = {
  bloodPressure: "", heartRate: "", respiratoryRate: "", temperature: "",
  oxygenSaturation: "", weight: "", height: "",
};

type BorradorConsulta = { form: typeof FORM_VACIO; vitales: typeof VITALES_VACIOS; recetas: RxDraft[] };

function leerBorrador(clave: string): BorradorConsulta | null {
  try {
    const raw = sessionStorage.getItem(clave);
    if (!raw) return null;
    const d = JSON.parse(raw) as Partial<BorradorConsulta>;
    return {
      form: { ...FORM_VACIO, ...(d.form ?? {}) },
      vitales: { ...VITALES_VACIOS, ...(d.vitales ?? {}) },
      recetas: Array.isArray(d.recetas) ? d.recetas : [],
    };
  } catch {
    return null;
  }
}

export function ConsultaActual({ pacienteId, turnoId, onFinalizada, onIrAOrdenes }: {
  pacienteId: number;
  turnoId: number | null;
  onFinalizada: () => void;
  /** Acceso rápido a la sección de órdenes de estudio (si el contenedor la tiene). */
  onIrAOrdenes?: () => void;
}) {
  const { toast } = useToast();
  // Autoguardado: el borrador se persiste en sessionStorage por paciente/turno
  const claveBorrador = `consulta-borrador-${pacienteId}-${turnoId ?? "st"}`;
  const inicial = leerBorrador(claveBorrador);
  const [form, setForm] = useState(inicial?.form ?? { ...FORM_VACIO });
  const [vitales, setVitales] = useState(inicial?.vitales ?? { ...VITALES_VACIOS });
  const [recetas, setRecetas] = useState<RxDraft[]>(inicial?.recetas ?? []);
  const [finalizando, setFinalizando] = useState(false);
  const [guardado, setGuardado] = useState(false);

  // Especialidad precargada con la del médico logueado (si no la escribió ya).
  const { data: me } = useGetMe({ query: { retry: false } });
  const profesionalId = me?.rol === "medico" && me?.profesionalId != null ? Number(me.profesionalId) : null;
  const { data: profesional } = useGetProfesional(profesionalId ?? 0, {
    query: { enabled: profesionalId != null },
  });
  const especialidadMedico = profesional?.especialidad?.nombre ?? null;
  useEffect(() => {
    if (!especialidadMedico) return;
    setForm((f) => (f.specialty.trim() === "" ? { ...f, specialty: especialidadMedico } : f));
  }, [especialidadMedico, claveBorrador]);

  // Si cambia el paciente/turno, recargar el borrador correspondiente para
  // no arrastrar texto de un paciente a otro.
  const [claveActiva, setClaveActiva] = useState(claveBorrador);
  useEffect(() => {
    if (claveActiva === claveBorrador) return;
    setClaveActiva(claveBorrador);
    const d = leerBorrador(claveBorrador);
    setForm(d?.form ?? { ...FORM_VACIO });
    setVitales(d?.vitales ?? { ...VITALES_VACIOS });
    setRecetas(d?.recetas ?? []);
    setGuardado(d != null);
  }, [claveBorrador, claveActiva]);

  useEffect(() => {
    if (claveActiva !== claveBorrador) return;
    const hayContenido =
      Object.entries(form).some(([k, v]) => k !== "encounterType" && v.trim() !== "") ||
      Object.values(vitales).some((v) => v.trim() !== "") ||
      recetas.length > 0;
    const t = setTimeout(() => {
      try {
        if (hayContenido) {
          sessionStorage.setItem(claveBorrador, JSON.stringify({ form, vitales, recetas }));
          setGuardado(true);
        } else {
          sessionStorage.removeItem(claveBorrador);
          setGuardado(false);
        }
      } catch {
        // sessionStorage lleno o inaccesible: el autoguardado es best-effort
      }
    }, 600);
    return () => clearTimeout(t);
  }, [form, vitales, recetas, claveBorrador]);

  const finalizarMutation = useFinalizarConsulta();

  const queryClient = useQueryClient();

  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
    setForm({ ...form, [k]: e.target.value });

  const finalizar = async () => {
    if (!form.chiefComplaint.trim()) {
      toast({ title: "Ingresá el motivo de consulta", variant: "destructive" });
      return;
    }
    setFinalizando(true);
    try {
      const payload: FinalizarConsultaInput = {
        patientId: pacienteId,
        encounterType: form.encounterType,
        ...(turnoId != null && { turnoId }),
      };
      for (const k of ["specialty", "chiefComplaint", "anamnesis", "physicalExam", "diagnosis", "cie10", "assessment", "plan"] as const) {
        if (form[k].trim()) payload[k] = form[k].trim();
      }

      // Signos vitales de la consulta
      const dataVitales: NonNullable<FinalizarConsultaInput["vitales"]> = {};
      if (vitales.bloodPressure.trim()) dataVitales.bloodPressure = vitales.bloodPressure.trim();
      for (const k of ["heartRate", "respiratoryRate", "temperature", "oxygenSaturation", "weight", "height"] as const) {
        const v = vitales[k].trim().replace(",", ".");
        if (v && !isNaN(Number(v))) dataVitales[k] = Number(v);
      }
      if (Object.keys(dataVitales).length > 0) payload.vitales = dataVitales;

      // Recetas asociadas
      const validas = recetas.filter((r) => r.medication.trim());
      if (validas.length > 0) {
        payload.recetas = validas.map((r) => ({
          medication: r.medication.trim(),
          ...(r.dosage.trim() && { dosage: r.dosage.trim() }),
          ...(r.frequency.trim() && { frequency: r.frequency.trim() }),
          ...(r.duration.trim() && { duration: r.duration.trim() }),
        }));
      }

      // Todo en una sola transacción del lado del servidor
      const resultado = await finalizarMutation.mutateAsync({ data: payload });

      if (turnoId && !resultado.turnoActualizado) {
        toast({
          title: "Consulta registrada, pero el turno no cambió de estado",
          description: `El turno #${turnoId} no estaba en atención.`,
        });
      }

      toast({
        title: "Consulta finalizada",
        description: `Registrada en la HC${validas.length ? ` con ${validas.length} receta(s)` : ""}${resultado.turnoActualizado ? " y turno cerrado" : ""}.`,
      });
      try { sessionStorage.removeItem(claveBorrador); } catch { /* best-effort */ }
      setForm({ ...FORM_VACIO });
      setVitales({ ...VITALES_VACIOS });
      setRecetas([]);
      setGuardado(false);
      onFinalizada();
    } catch (e) {
      toast({
        title: "Error al finalizar la consulta",
        description: e instanceof Error ? e.message : "Error desconocido",
        variant: "destructive",
      });
    } finally {
      setFinalizando(false);
    }
  };

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <Stethoscope className="w-4 h-4 text-primary" /> Consulta actual
          {guardado && (
            <span className="ml-auto text-xs font-normal text-muted-foreground flex items-center gap-1">
              <CheckCircle2 className="w-3.5 h-3.5 text-green-600" /> Borrador guardado
            </span>
          )}
          {onIrAOrdenes && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className={guardado ? "" : "ml-auto"}
              onClick={onIrAOrdenes}
              data-testid="btn-ir-a-ordenes"
            >
              <FlaskConical className="w-3.5 h-3.5 mr-1" /> Generar órdenes
            </Button>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Especialidad y modalidad ya no se cargan a mano: la especialidad
            se completa sola con la del médico y la modalidad queda "presencial". */}
        <div className="space-y-1">
          <Label className="text-xs">Motivo de consulta *</Label>
          <Input value={form.chiefComplaint} onChange={set("chiefComplaint")} placeholder="Ej: dolor abdominal de 48hs de evolución" />
        </div>
        <div className="space-y-1">
          <Label className="text-xs">Anamnesis</Label>
          <Textarea
            value={form.anamnesis}
            onChange={set("anamnesis")}
            rows={3}
            placeholder="Historia de la enfermedad actual..."
            data-testid="input-anamnesis"
          />
        </div>
        <div className="space-y-1">
          <Label className="text-xs">Examen físico</Label>
          <Textarea
            value={form.physicalExam}
            onChange={set("physicalExam")}
            rows={3}
            placeholder="Hallazgos del examen físico..."
            data-testid="input-examen-fisico"
          />
        </div>

        <div className="grid sm:grid-cols-[1fr_140px] gap-3">
          <div className="space-y-1">
            <Label className="text-xs">Diagnóstico</Label>
            <Textarea
              value={form.diagnosis}
              onChange={set("diagnosis")}
              rows={1}
              className="min-h-9 resize-none"
              placeholder="Ej: gastroenteritis aguda"
              data-testid="input-diagnostico"
            />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">CIE-10</Label>
            <Input value={form.cie10} onChange={set("cie10")} placeholder="A09" className="font-mono" />
          </div>
        </div>
        <div className="space-y-1">
          <Label className="text-xs">Evaluación</Label>
          <Textarea
            value={form.assessment}
            onChange={set("assessment")}
            rows={2}
            placeholder="Impresión clínica..."
            data-testid="input-evaluacion"
          />
        </div>
        <div className="space-y-1">
          <Label className="text-xs">Conducta / plan</Label>
          <Textarea value={form.plan} onChange={set("plan")} rows={2} placeholder="Tratamiento, estudios, control..." />
        </div>

        <div className="border-t pt-3 space-y-2">
          <Label className="text-xs flex items-center gap-1"><HeartPulse className="w-3.5 h-3.5" /> Signos vitales (opcional)</Label>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            {VITALES_CAMPOS.map(([key, label, placeholder]) => (
              <div key={key} className="space-y-0.5">
                <Label className="text-[11px] text-muted-foreground">{label}</Label>
                <Input
                  className="h-8"
                  value={vitales[key]}
                  placeholder={placeholder}
                  onChange={(e) => setVitales({ ...vitales, [key]: e.target.value })}
                />
              </div>
            ))}
          </div>
        </div>

        <div className="border-t pt-3 space-y-2">
          <div className="flex items-center justify-between">
            <Label className="text-xs flex items-center gap-1"><Pill className="w-3.5 h-3.5" /> Recetas de esta consulta</Label>
            <Button type="button" variant="outline" size="sm" onClick={() => setRecetas([...recetas, { ...rxVacia }])}>
              <Plus className="w-3.5 h-3.5 mr-1" /> Agregar
            </Button>
          </div>
          {recetas.map((r, i) => (
            <div key={i} className="grid sm:grid-cols-4 gap-2 items-end bg-muted/30 rounded-lg p-2">
              <div className="space-y-0.5 sm:col-span-2">
                <Label className="text-[11px]">Medicamento *</Label>
                <Input className="h-8" value={r.medication} onChange={(e) => setRecetas(recetas.map((x, j) => j === i ? { ...x, medication: e.target.value } : x))} placeholder="amoxicilina 500mg" />
              </div>
              <div className="space-y-0.5">
                <Label className="text-[11px]">Dosis / frecuencia</Label>
                <Input className="h-8" value={r.frequency} onChange={(e) => setRecetas(recetas.map((x, j) => j === i ? { ...x, frequency: e.target.value } : x))} placeholder="1 comp c/8hs" />
              </div>
              <div className="flex gap-1">
                <div className="space-y-0.5 flex-1">
                  <Label className="text-[11px]">Duración</Label>
                  <Input className="h-8" value={r.duration} onChange={(e) => setRecetas(recetas.map((x, j) => j === i ? { ...x, duration: e.target.value } : x))} placeholder="7 días" />
                </div>
                <Button type="button" variant="ghost" size="icon" className="shrink-0 h-8 w-8" onClick={() => setRecetas(recetas.filter((_, j) => j !== i))}>✕</Button>
              </div>
            </div>
          ))}
        </div>

        <div className="flex justify-end pt-1">
          <Button size="lg" onClick={finalizar} disabled={finalizando} className="gap-2">
            {finalizando ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle2 className="w-4 h-4" />}
            {finalizando ? "Finalizando..." : "Finalizar Consulta"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

// ── Evoluciones anteriores (derecha) ────────────────────────────────────────

// El médico que atendió puede corregir su propia evolución aunque la consulta
// ya esté finalizada. Solo ve el botón el autor (o admin).
const EVOLUCION_CAMPOS = [
  ["chiefComplaint", "Motivo de consulta"],
  ["anamnesis", "Anamnesis"],
  ["physicalExam", "Examen físico"],
  ["diagnosis", "Diagnóstico"],
  ["cie10", "CIE-10"],
  ["assessment", "Evaluación"],
  ["plan", "Plan"],
] as const;

function EvolucionEditor({ encounter, onListo }: { encounter: EncounterFull; onListo: () => void }) {
  const { toast } = useToast();
  const [valores, setValores] = useState<Record<string, string>>(() => {
    const v: Record<string, string> = {};
    for (const [k] of EVOLUCION_CAMPOS) v[k] = (encounter[k] as string | null) ?? "";
    return v;
  });
  const editar = useEditarConsulta({
    mutation: {
      onSuccess: () => {
        toast({ title: "Evolución corregida", description: "Los cambios quedaron registrados en la historia clínica." });
        onListo();
      },
      onError: (err: unknown) => {
        const e = (err as { data?: { error?: string } })?.data;
        toast({ title: "Error", description: e?.error ?? "No se pudo corregir la evolución", variant: "destructive" });
      },
    },
  });

  return (
    <div className="space-y-2 pt-1" data-testid={`editor-evolucion-${encounter.id}`}>
      {EVOLUCION_CAMPOS.map(([k, label]) => (
        <div key={k} className="space-y-1">
          <Label className="text-xs">{label}</Label>
          {["cie10", "chiefComplaint", "diagnosis"].includes(k) ? (
            <Input
              value={valores[k] ?? ""}
              onChange={(e) => setValores({ ...valores, [k]: e.target.value })}
              data-testid={`evolucion-input-${k}`}
            />
          ) : (
            <Textarea
              rows={2}
              value={valores[k] ?? ""}
              onChange={(e) => setValores({ ...valores, [k]: e.target.value })}
              data-testid={`evolucion-input-${k}`}
            />
          )}
        </div>
      ))}
      <div className="flex gap-2">
        <Button
          size="sm"
          disabled={editar.isPending}
          onClick={() => editar.mutate({ encounterId: encounter.id, data: { ...valores } })}
          data-testid="evolucion-boton-guardar"
        >
          {editar.isPending && <Loader2 className="w-3.5 h-3.5 mr-1 animate-spin" />}
          Guardar corrección
        </Button>
        <Button size="sm" variant="ghost" onClick={onListo}>Cancelar</Button>
      </div>
    </div>
  );
}

export function EvolucionesPrevias({ encounters, onCambio }: { encounters: EncounterFull[]; onCambio?: () => void }) {
  const { data: me } = useGetMe({ query: { retry: false } });
  const [editandoId, setEditandoId] = useState<number | null>(null);
  if (encounters.length === 0) {
    return <p className="text-sm text-muted-foreground text-center py-6">Sin atenciones médicas anteriores registradas.</p>;
  }
  const miProfesionalId = me?.profesionalId != null ? Number(me.profesionalId) : null;
  const puedeEditar = (e: EncounterFull) =>
    me?.rol === "admin" || (me?.rol === "medico" && miProfesionalId != null && e.professionalId === miProfesionalId);
  return (
    <Accordion type="single" collapsible className="w-full">
      {encounters.map((e) => (
        <AccordionItem key={e.id} value={String(e.id)}>
          <AccordionTrigger className="text-sm py-2.5 hover:no-underline">
            <div className="flex flex-col items-start text-left gap-0.5">
              <span className="font-medium">{e.chiefComplaint || e.specialty || "Consulta"}</span>
              <span className="text-xs text-muted-foreground font-normal">
                {fechaCorta(e.encounterDate)}
                {e.professional ? ` · ${e.professional.apellido}, ${e.professional.nombre}` : ""}
                {e.updatedAt ? " · corregida" : ""}
              </span>
            </div>
          </AccordionTrigger>
          <AccordionContent className="text-sm space-y-1.5">
            {editandoId === e.id ? (
              <EvolucionEditor
                encounter={e}
                onListo={() => {
                  setEditandoId(null);
                  onCambio?.();
                }}
              />
            ) : (
              <>
                {e.diagnosis && <p><span className="text-muted-foreground">Dx:</span> {e.diagnosis}{e.cie10 ? ` (${e.cie10})` : ""}</p>}
                {e.anamnesis && <p className="text-xs text-muted-foreground line-clamp-3">{e.anamnesis}</p>}
                {e.plan && <p><span className="text-muted-foreground">Plan:</span> {e.plan}</p>}
                {e.prescriptions.length > 0 && (
                  <p className="text-xs flex items-center gap-1"><Pill className="w-3 h-3" /> {e.prescriptions.map((p) => p.medication).join(", ")}</p>
                )}
                {e.vitals.length > 0 && (
                  <p className="text-xs text-muted-foreground flex items-center gap-1">
                    <HeartPulse className="w-3 h-3" />
                    {e.vitals.map((v) => [v.bloodPressure && `TA ${v.bloodPressure}`, v.heartRate && `FC ${v.heartRate}`, v.temperature && `T° ${v.temperature}`].filter(Boolean).join(" · ")).join(" | ")}
                  </p>
                )}
                {e.updatedAt && (
                  <p className="text-xs text-muted-foreground">Última corrección: {fechaCorta(e.updatedAt)}</p>
                )}
                {puedeEditar(e) && (
                  <Button
                    size="sm"
                    variant="outline"
                    className="mt-1"
                    onClick={() => setEditandoId(e.id)}
                    data-testid={`boton-editar-evolucion-${e.id}`}
                  >
                    <Pencil className="w-3.5 h-3.5 mr-1" /> Corregir evolución
                  </Button>
                )}
              </>
            )}
          </AccordionContent>
        </AccordionItem>
      ))}
    </Accordion>
  );
}

// ── Página principal ────────────────────────────────────────────────────────

export default function ConsultaUnificada() {
  const { id } = useParams<{ id: string }>();
  const pacienteId = Number(id);
  const [, navigate] = useLocation();
  const search = useSearch();
  const turnoParam = new URLSearchParams(search).get("turno");
  const turnoId = turnoParam && !isNaN(Number(turnoParam)) ? Number(turnoParam) : null;
  const queryClient = useQueryClient();
  // El médico vuelve a "Mi agenda" al terminar; el resto conserva su retorno.
  const { data: yo } = useGetMe({ query: { retry: false } });
  const esMedico = yo?.rol === "medico";
  const destinoRetorno = esMedico ? "/recepcion/agenda-medico" : "/consultorio";
  const [mostrarEvolucion, setMostrarEvolucion] = useState(true);
  // Pestaña de la fila inferior, controlada para el atajo "Generar órdenes".
  const [tabInferior, setTabInferior] = useState("evoluciones");
  const tabsInferioresRef = useRef<HTMLDivElement>(null);
  const irAOrdenes = () => {
    setTabInferior("estudios");
    setTimeout(() => tabsInferioresRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 50);
  };

  const { data, isLoading, error } = useGetConsultorioWorkspace(pacienteId, {
    query: { enabled: !!pacienteId },
  });

  const refrescar = () => {
    queryClient.invalidateQueries({ queryKey: getGetConsultorioWorkspaceQueryKey(pacienteId) });
    queryClient.invalidateQueries({ queryKey: getGetHceHistoryQueryKey(pacienteId) });
    queryClient.invalidateQueries({ queryKey: getGetPatientStudyOrdersQueryKey(pacienteId) });
    queryClient.invalidateQueries({ queryKey: getGetPatientTimelineQueryKey(pacienteId) });
  };

  if (isLoading) {
    return (
      <div className="p-6 space-y-4">
        <Skeleton className="h-10 w-80" />
        <div className="grid lg:grid-cols-3 gap-4">
          <Skeleton className="h-96" /><Skeleton className="h-96" /><Skeleton className="h-96" />
        </div>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="p-8 text-center space-y-4">
        <p className="text-muted-foreground">No se pudo cargar el consultorio. Verificá tus permisos de acceso.</p>
        <Link href="/consultorio"><Button variant="outline">Volver al consultorio</Button></Link>
      </div>
    );
  }

  const { paciente, record, encounters, ordenes, adjuntos, turnosHoy } = data;
  const anios = edad(paciente.fechaNacimiento);
  const ultimosVitales = encounters.flatMap((e) => e.vitals)[0];

  return (
    <div className="space-y-4 max-w-[1400px] mx-auto">
      {/* Encabezado */}
      <div className="flex flex-wrap items-center gap-3">
        <Link href={esMedico ? "/recepcion/agenda-medico" : turnoId ? "/sala-espera" : "/consultorio"}>
          <Button variant="outline" size="icon"><ArrowLeft className="w-4 h-4" /></Button>
        </Link>
        <div className="flex-1 min-w-60">
          <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
            <User className="w-6 h-6 text-primary" />
            {paciente.apellido}, {paciente.nombre}
          </h1>
          <p className="text-sm text-muted-foreground">
            {[
              anios != null ? `${anios} años` : null,
              paciente.dni ? `DNI ${paciente.dni}` : null,
              paciente.numeroHc ? `HC ${paciente.numeroHc}` : null,
              paciente.grupoSanguineo ? `Grupo ${paciente.grupoSanguineo}` : null,
            ].filter(Boolean).join(" · ") || "—"}
          </p>
        </div>
        {turnosHoy.length > 0 && (
          <div className="flex items-center gap-2 text-sm bg-muted/60 rounded-lg px-3 py-1.5">
            <CalendarClock className="w-4 h-4 text-primary" />
            {turnosHoy[0].hora?.slice(0, 5)} hs · {turnosHoy[0].turneraNombre ?? "Turno"}
            <Badge variant="outline" className="text-xs capitalize">{turnosHoy[0].estado.replace(/_/g, " ")}</Badge>
          </div>
        )}
        <Button
          variant={mostrarEvolucion ? "secondary" : "default"}
          size="sm"
          onClick={() => setMostrarEvolucion((v) => !v)}
          data-testid="toggle-evolucion"
        >
          <FileText className="w-4 h-4 mr-2" />
          {mostrarEvolucion ? "Ocultar evolución" : "Mostrar evolución"}
        </Button>
        <Link href={`/pacientes/${pacienteId}/hce`}>
          <Button variant="outline" size="sm"><ClipboardList className="w-4 h-4 mr-2" /> HCE completa</Button>
        </Link>
      </div>

      {/* Alerta de alergias siempre visible */}
      {record?.allergies && (
        <div className="flex items-center gap-2 bg-red-50 border border-red-200 text-red-800 rounded-lg px-3 py-2 text-sm">
          <AlertTriangle className="w-4 h-4 shrink-0" />
          <span className="font-medium">Alergias:</span> {record.allergies}
        </div>
      )}

      <div className="space-y-4">
        {/* Fila 1: consulta actual, lo primero que ve el médico al entrar. */}
        {mostrarEvolucion && (
          <ConsultaActual
            pacienteId={pacienteId}
            turnoId={turnoId}
            onFinalizada={() => {
              refrescar();
              // Aviso visible en la pantalla de llegada: "Mi agenda" lo lee
              // al montar y muestra un banner de confirmación (solo médicos).
              if (esMedico) {
                try {
                  sessionStorage.setItem(
                    "consulta-registrada",
                    JSON.stringify({
                      paciente: `${paciente.apellido}, ${paciente.nombre}`,
                      ts: Date.now(),
                    }),
                  );
                } catch { /* best-effort */ }
              }
              // La agenda debe mostrar el turno recién atendido como "Atendido".
              void queryClient.invalidateQueries({
                predicate: (qy) => String(qy.queryKey[0] ?? "").includes("/recepcion/"),
              });
              // Al finalizar, el médico vuelve a "Mi agenda" (con el turno ya
              // actualizado); los demás roles vuelven a Mi Consultorio.
              navigate(destinoRetorno);
            }}
            onIrAOrdenes={irAOrdenes}
          />
        )}

        {/* Fila 2: contexto del paciente (ficha, vitales, estudios) */}
        <div className="grid md:grid-cols-3 gap-4 items-start">
          <FichaClinicaCard pacienteId={pacienteId} record={record} onSaved={refrescar} />

          {ultimosVitales && (
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm flex items-center gap-2"><HeartPulse className="w-4 h-4 text-primary" /> Últimos signos vitales</CardTitle>
              </CardHeader>
              <CardContent className="grid grid-cols-2 gap-2 text-sm">
                {ultimosVitales.bloodPressure && <div><p className="text-xs text-muted-foreground">TA</p><p>{ultimosVitales.bloodPressure}</p></div>}
                {ultimosVitales.heartRate != null && <div><p className="text-xs text-muted-foreground">FC</p><p>{ultimosVitales.heartRate} lpm</p></div>}
                {ultimosVitales.temperature != null && <div><p className="text-xs text-muted-foreground">T°</p><p>{ultimosVitales.temperature} °C</p></div>}
                {ultimosVitales.oxygenSaturation != null && <div><p className="text-xs text-muted-foreground">SatO₂</p><p>{ultimosVitales.oxygenSaturation}%</p></div>}
                {ultimosVitales.weight != null && <div><p className="text-xs text-muted-foreground">Peso</p><p>{ultimosVitales.weight} kg</p></div>}
                {ultimosVitales.bmi != null && <div><p className="text-xs text-muted-foreground">IMC</p><p>{ultimosVitales.bmi}</p></div>}
              </CardContent>
            </Card>
          )}

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm flex items-center gap-2"><FlaskConical className="w-4 h-4 text-primary" /> Estudios en curso</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              {ordenes.filter((o) => !["entregado", "anulada"].includes(o.status ?? "")).length === 0 ? (
                <p className="text-sm text-muted-foreground">Sin estudios en curso.</p>
              ) : (
                ordenes
                  .filter((o) => !["entregado", "anulada"].includes(o.status ?? ""))
                  .slice(0, 6)
                  .map((o) => (
                    <div key={o.id} className="flex items-start justify-between gap-2 text-sm">
                      <span className="min-w-0 break-words">{o.studyName}</span>
                      <OrdenEstadoControl orden={o} onChanged={refrescar} />
                    </div>
                  ))
              )}
            </CardContent>
          </Card>
        </div>

        {/* Fila 3: evoluciones + resolución */}
        <div ref={tabsInferioresRef}>
          <Tabs value={tabInferior} onValueChange={setTabInferior}>
            <TabsList className="grid w-full grid-cols-6 h-auto border-2 border-primary/40 rounded-lg p-1">
              <TabsTrigger value="evoluciones" className="text-sm font-semibold data-[state=active]:border data-[state=active]:border-primary" data-testid="tab-atenciones-anteriores"><FileText className="w-4 h-4 mr-1.5 hidden xl:block" /> Atenciones anteriores{encounters.length > 0 ? ` (${encounters.length})` : ""}</TabsTrigger>
              <TabsTrigger value="estudios" className="text-sm font-semibold data-[state=active]:border data-[state=active]:border-primary"><FlaskConical className="w-4 h-4 mr-1.5 hidden xl:block" /> Estudios</TabsTrigger>
              <TabsTrigger value="imagenes" className="text-sm font-semibold data-[state=active]:border data-[state=active]:border-primary" data-testid="tab-imagenes"><ImageIcon className="w-4 h-4 mr-1.5 hidden xl:block" /> Imágenes</TabsTrigger>
              <TabsTrigger value="certificados" className="text-sm font-semibold data-[state=active]:border data-[state=active]:border-primary" data-testid="tab-certificados"><ClipboardList className="w-4 h-4 mr-1.5 hidden xl:block" /> Certificados</TabsTrigger>
              <TabsTrigger value="derivar" className="text-sm font-semibold data-[state=active]:border data-[state=active]:border-primary"><Send className="w-4 h-4 mr-1.5 hidden xl:block" /> Derivar</TabsTrigger>
              <TabsTrigger value="documentos" className="text-sm font-semibold data-[state=active]:border data-[state=active]:border-primary"><FileImage className="w-4 h-4 mr-1.5 hidden xl:block" /> Documentos</TabsTrigger>
            </TabsList>

            <TabsContent value="evoluciones" className="pt-3">
              <Card>
                <CardContent className="p-3">
                  <EvolucionesPrevias encounters={encounters} onCambio={refrescar} />
                </CardContent>
              </Card>
            </TabsContent>

            <TabsContent value="estudios" className="pt-3 space-y-3">
              <SeccionOrdenes pacienteId={pacienteId} />
            </TabsContent>

            <TabsContent value="imagenes" className="pt-3">
              <DicomPacsCard patientId={pacienteId} mostrarVacio />
            </TabsContent>

            <TabsContent value="certificados" className="pt-3">
              <SeccionCertificados pacienteId={pacienteId} />
            </TabsContent>

            <TabsContent value="derivar" className="pt-3 space-y-3">
              <PanelDerivacion pacienteId={pacienteId} />
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm">Solicitudes del paciente</CardTitle>
                </CardHeader>
                <CardContent className="p-3 pt-0">
                  <ListaSolicitudesPaciente pacienteId={pacienteId} />
                </CardContent>
              </Card>
            </TabsContent>

            <TabsContent value="documentos" className="pt-3">
              <Tabs defaultValue="recetas">
                <TabsList className="grid w-full grid-cols-3 h-auto">
                  <TabsTrigger value="recetas" className="text-xs">Recetas</TabsTrigger>
                  <TabsTrigger value="derivaciones" className="text-xs">Derivaciones</TabsTrigger>
                  <TabsTrigger value="certificados" className="text-xs">Certificados</TabsTrigger>
                </TabsList>
                <TabsContent value="recetas" className="pt-3"><SeccionRecetas pacienteId={pacienteId} /></TabsContent>
                <TabsContent value="derivaciones" className="pt-3"><SeccionDerivaciones pacienteId={pacienteId} /></TabsContent>
                <TabsContent value="certificados" className="pt-3"><SeccionCertificados pacienteId={pacienteId} /></TabsContent>
              </Tabs>
              {adjuntos.length > 0 && (
                <Card className="mt-3">
                  <CardHeader className="pb-2">
                    <CardTitle className="text-sm flex items-center gap-2"><FileImage className="w-4 h-4 text-primary" /> Adjuntos</CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-1.5">
                    {adjuntos.slice(0, 8).map((a) => (
                      <div key={a.id} className="text-sm flex items-center gap-2">
                        <FileImage className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
                        <span className="truncate flex-1">{a.description || a.type}</span>
                        <span className="text-xs text-muted-foreground">{fechaCorta(a.createdAt)}</span>
                      </div>
                    ))}
                  </CardContent>
                </Card>
              )}
            </TabsContent>
          </Tabs>
        </div>
      </div>
    </div>
  );
}
