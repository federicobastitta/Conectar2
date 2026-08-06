import { useState } from "react";
import { Link, useParams } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import {
  useGetHceHistory,
  useUpsertHceHistory,
  useCreateHceEncounter,
  useCreateHceVitals,
  useCreateHcePrescription,
  getGetHceHistoryQueryKey,
  type EncounterFull,
  type ClinicalRecordInput,
  type EncounterInput,
  type VitalSignsInput,
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
import { useToast } from "@/hooks/use-toast";
import {
  ArrowLeft,
  ClipboardList,
  FileText,
  HeartPulse,
  Pill,
  Plus,
  Save,
  Stethoscope,
  FileImage,
  Activity,
} from "lucide-react";
import { format } from "date-fns";
import { es } from "date-fns/locale";
import { TabResolucion, TabHistorial, SeccionOrdenes } from "./resolucion";
import { PanelDerivacion, ListaSolicitudesPaciente } from "./derivacion-panel";
import { DicomPacsCard } from "@/components/dicom-pacs";
import { EstudiosPreviosHC } from "@/components/estudios-previos/estudios-previos";
import { FilePenLine, History, FlaskConical, Send } from "lucide-react";

function formatFecha(value: string) {
  const d = new Date(value);
  return isNaN(d.getTime()) ? value : format(d, "d 'de' MMMM, yyyy - HH:mm", { locale: es });
}

function formatFechaCorta(value: string) {
  const d = new Date(value);
  return isNaN(d.getTime()) ? value : format(d, "dd/MM/yyyy", { locale: es });
}

// ── Pestaña Resumen ─────────────────────────────────────────────────────────

const FICHA_CAMPOS = [
  { key: "bloodType", label: "Grupo sanguíneo", placeholder: "Ej: 0+" },
  { key: "allergies", label: "Alergias", placeholder: "Ej: penicilina, polen" },
  { key: "chronicDiseases", label: "Enfermedades crónicas", placeholder: "Ej: hipertensión, diabetes tipo 2" },
  { key: "surgeries", label: "Cirugías previas", placeholder: "Ej: apendicectomía (2015)" },
  { key: "familyHistory", label: "Antecedentes familiares", placeholder: "Ej: padre con cardiopatía" },
  { key: "currentMedications", label: "Medicación habitual", placeholder: "Ej: enalapril 10mg/día" },
  { key: "vaccinations", label: "Vacunas", placeholder: "Ej: antigripal 2026, COVID refuerzo" },
  { key: "notes", label: "Observaciones", placeholder: "Notas generales de la ficha" },
] as const;

type FichaKey = (typeof FICHA_CAMPOS)[number]["key"];

function TabResumen({ encounters, alertas, onVerFicha }: {
  encounters: EncounterFull[];
  alertas: { alergias: string | null; cronicas: string | null };
  onVerFicha: () => void;
}) {
  // Consulta seleccionada en el carrusel horizontal (por defecto, la última).
  const [seleccionadaId, setSeleccionadaId] = useState<number | null>(encounters[0]?.id ?? null);
  const seleccionada = encounters.find((e) => e.id === seleccionadaId) ?? encounters[0];

  const totalRx = encounters.reduce((n, e) => n + e.prescriptions.length, 0);
  const totalAdj = encounters.reduce((n, e) => n + e.attachments.length, 0);

  return (
    <div className="space-y-6">
      {/* Alertas clínicas mínimas: alergias y crónicas siempre a la vista,
          el resto de los antecedentes vive en la solapa "Ficha clínica". */}
      {(alertas.alergias || alertas.cronicas) && (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          {alertas.alergias && (
            <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full border bg-red-100 text-red-800 border-red-200 dark:bg-red-900/40 dark:text-red-200 dark:border-red-800 font-medium">
              ⚠ Alergias: {alertas.alergias}
            </span>
          )}
          {alertas.cronicas && (
            <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full border bg-amber-100 text-amber-800 border-amber-200 dark:bg-amber-900/40 dark:text-amber-200 dark:border-amber-800 font-medium">
              Crónicas: {alertas.cronicas}
            </span>
          )}
          <button type="button" onClick={onVerFicha} className="text-xs text-primary underline underline-offset-2">
            Ver ficha completa
          </button>
        </div>
      )}

      {/* Historial de consultas: tira horizontal desplegable */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <History className="w-4 h-4 text-primary" /> Seguimiento de consultas
          </CardTitle>
          <CardDescription>
            {encounters.length
              ? "Tocá una consulta para ver el detalle completo debajo."
              : "No hay consultas registradas en la historia clínica."}
          </CardDescription>
        </CardHeader>
        {encounters.length > 0 && (
          <CardContent className="space-y-4">
            <div className="flex gap-2 overflow-x-auto pb-2 -mx-1 px-1 snap-x" data-testid="carrusel-consultas">
              {encounters.map((e, i) => {
                const activa = seleccionada?.id === e.id;
                return (
                  <button
                    key={e.id}
                    type="button"
                    onClick={() => setSeleccionadaId(e.id)}
                    data-testid={`consulta-chip-${e.id}`}
                    className={`shrink-0 snap-start w-48 text-left rounded-lg border p-3 transition-colors ${
                      activa
                        ? "border-primary bg-primary/10 ring-1 ring-primary"
                        : "bg-card hover:bg-muted/50"
                    }`}
                  >
                    <p className="text-xs font-semibold text-muted-foreground">
                      {formatFechaCorta(e.encounterDate)}{i === 0 ? " · última" : ""}
                    </p>
                    <p className="text-sm font-semibold truncate mt-0.5">{e.specialty || "Consulta"}</p>
                    {e.professional && (
                      <p className="text-xs text-muted-foreground truncate">
                        {e.professional.apellido}, {e.professional.nombre}
                      </p>
                    )}
                    <p className="text-xs mt-1 line-clamp-2">
                      {e.diagnosis || e.chiefComplaint || <span className="text-muted-foreground">Sin diagnóstico</span>}
                    </p>
                  </button>
                );
              })}
            </div>
            {seleccionada && <DetalleConsulta e={seleccionada} />}
          </CardContent>
        )}
      </Card>

      <div className="grid sm:grid-cols-3 gap-4">
        <Card>
          <CardContent className="p-4 flex items-center gap-3">
            <div className="bg-primary/20 p-2 rounded-lg"><Stethoscope className="w-5 h-5 text-primary" /></div>
            <div>
              <p className="text-2xl font-bold">{encounters.length}</p>
              <p className="text-xs text-muted-foreground">Consultas registradas</p>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 flex items-center gap-3">
            <div className="bg-primary/20 p-2 rounded-lg"><Pill className="w-5 h-5 text-primary" /></div>
            <div>
              <p className="text-2xl font-bold">{totalRx}</p>
              <p className="text-xs text-muted-foreground">Prescripciones</p>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 flex items-center gap-3">
            <div className="bg-primary/20 p-2 rounded-lg"><FileImage className="w-5 h-5 text-primary" /></div>
            <div>
              <p className="text-2xl font-bold">{totalAdj}</p>
              <p className="text-xs text-muted-foreground">Estudios / adjuntos</p>
            </div>
          </CardContent>
        </Card>
      </div>

    </div>
  );
}

// ── Pestaña Ficha clínica (alergias y antecedentes) ─────────────────────────

function TabFicha({ pacienteId, record }: {
  pacienteId: number;
  record: Record<string, unknown> | null | undefined;
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [editando, setEditando] = useState(false);
  const [form, setForm] = useState<Record<FichaKey, string>>(() =>
    Object.fromEntries(
      FICHA_CAMPOS.map((c) => [c.key, (record?.[c.key] as string) ?? ""])
    ) as Record<FichaKey, string>
  );

  const upsert = useUpsertHceHistory({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getGetHceHistoryQueryKey(pacienteId) });
        setEditando(false);
        toast({ title: "Ficha clínica guardada" });
      },
      onError: (e) => toast({ title: "Error al guardar la ficha", description: e.message, variant: "destructive" }),
    },
  });

  return (
      <Card>
        <CardHeader className="flex flex-row items-center justify-between pb-4">
          <div>
            <CardTitle className="text-base">Ficha clínica</CardTitle>
            <CardDescription>Antecedentes y datos permanentes del paciente</CardDescription>
          </div>
          {!editando ? (
            <Button variant="outline" size="sm" onClick={() => setEditando(true)}>Editar</Button>
          ) : (
            <div className="flex gap-2">
              <Button variant="ghost" size="sm" onClick={() => setEditando(false)}>Cancelar</Button>
              <Button
                size="sm"
                disabled={upsert.isPending}
                onClick={() => {
                  const extras: Partial<Record<FichaKey, string>> = {};
                  for (const c of FICHA_CAMPOS) {
                    if (form[c.key].trim()) extras[c.key] = form[c.key].trim();
                  }
                  const data: ClinicalRecordInput = { patientId: pacienteId, ...extras };
                  upsert.mutate({ data });
                }}
              >
                <Save className="w-4 h-4 mr-1" /> Guardar
              </Button>
            </div>
          )}
        </CardHeader>
        <CardContent>
          <div className="grid sm:grid-cols-2 gap-4">
            {FICHA_CAMPOS.map((c) => (
              <div key={c.key} className={c.key === "notes" ? "sm:col-span-2 space-y-1" : "space-y-1"}>
                <Label className="text-xs font-semibold uppercase text-muted-foreground">{c.label}</Label>
                {editando ? (
                  c.key === "notes" ? (
                    <Textarea
                      value={form[c.key]}
                      placeholder={c.placeholder}
                      onChange={(e) => setForm({ ...form, [c.key]: e.target.value })}
                    />
                  ) : (
                    <Input
                      value={form[c.key]}
                      placeholder={c.placeholder}
                      onChange={(e) => setForm({ ...form, [c.key]: e.target.value })}
                    />
                  )
                ) : (
                  <p className="text-sm font-medium min-h-5">
                    {(record?.[c.key] as string) || <span className="text-muted-foreground font-normal">Sin datos</span>}
                  </p>
                )}
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
  );
}

// ── Pestaña Imágenes e informes ─────────────────────────────────────────────
// Única fuente de estudios de imágenes: DiagnostiPACS. Las integraciones
// Phir-it y Pulso están desconectadas (jul 2026); sus cards se quitaron de
// esta pestaña. Visible para todo el staff (incluida administración/recepción).

function TabImagenes({ pacienteId }: { pacienteId: number }) {
  return (
    <div className="space-y-6">
      <DicomPacsCard patientId={pacienteId} mostrarVacio />
      <EstudiosPreviosHC pacienteId={pacienteId} />
    </div>
  );
}

// ── Detalle de una consulta (compartido por Resumen y Evolución) ────────────

function DetalleConsulta({ e }: { e: EncounterFull }) {
  return (
          <Card>
            <CardHeader className="pb-3 border-b bg-muted/20">
              <div className="flex justify-between items-center flex-wrap gap-2">
                <div className="flex items-center gap-2">
                  <CardTitle className="text-base text-primary">
                    {e.specialty || "Consulta"}
                  </CardTitle>
                  <Badge variant="outline" className="capitalize">{e.encounterType}</Badge>
                  <Badge variant={e.status === "cerrada" ? "secondary" : "default"} className="capitalize">{e.status}</Badge>
                </div>
                <span className="text-sm font-medium text-muted-foreground">{formatFecha(e.encounterDate)}</span>
              </div>
              {e.professional && (
                <CardDescription>
                  {e.professional.apellido}, {e.professional.nombre}
                </CardDescription>
              )}
            </CardHeader>
            <CardContent className="pt-4 space-y-3 text-sm">
              {e.chiefComplaint && <p><span className="font-semibold">Motivo:</span> {e.chiefComplaint}</p>}
              {e.anamnesis && <p><span className="font-semibold">Anamnesis:</span> {e.anamnesis}</p>}
              {e.physicalExam && <p><span className="font-semibold">Examen físico:</span> {e.physicalExam}</p>}
              {e.diagnosis && (
                <p>
                  <span className="font-semibold">Diagnóstico:</span> {e.diagnosis}
                  {e.cie10 && <Badge variant="outline" className="ml-2 font-mono">{e.cie10}</Badge>}
                </p>
              )}
              {e.assessment && <p><span className="font-semibold">Evaluación:</span> {e.assessment}</p>}
              {e.plan && <p><span className="font-semibold">Conducta:</span> {e.plan}</p>}

              {e.vitals.length > 0 && (
                <div className="bg-muted/40 rounded-lg p-3 space-y-1">
                  <p className="text-xs font-semibold uppercase text-muted-foreground flex items-center gap-1">
                    <HeartPulse className="w-3.5 h-3.5" /> Signos vitales
                  </p>
                  {e.vitals.map((v) => (
                    <p key={v.id} className="text-sm">
                      {[
                        v.bloodPressure && `TA ${v.bloodPressure}`,
                        v.heartRate != null && `FC ${v.heartRate} lpm`,
                        v.respiratoryRate != null && `FR ${v.respiratoryRate} rpm`,
                        v.temperature != null && `T° ${v.temperature}°C`,
                        v.oxygenSaturation != null && `SatO₂ ${v.oxygenSaturation}%`,
                        v.weight != null && `Peso ${v.weight} kg`,
                        v.height != null && `Altura ${v.height}`,
                        v.bmi != null && `IMC ${v.bmi}`,
                      ].filter(Boolean).join(" · ")}
                    </p>
                  ))}
                </div>
              )}

              {e.prescriptions.length > 0 && (
                <div className="bg-muted/40 rounded-lg p-3 space-y-1">
                  <p className="text-xs font-semibold uppercase text-muted-foreground flex items-center gap-1">
                    <Pill className="w-3.5 h-3.5" /> Prescripciones
                  </p>
                  {e.prescriptions.map((p) => (
                    <p key={p.id} className="text-sm">
                      <span className="font-medium">{p.medication}</span>
                      {p.dosage && ` — ${p.dosage}`}
                      {p.frequency && `, ${p.frequency}`}
                      {p.duration && `, ${p.duration}`}
                      {p.instructions && ` (${p.instructions})`}
                    </p>
                  ))}
                </div>
              )}

              {e.attachments.length > 0 && (
                <div className="bg-muted/40 rounded-lg p-3 space-y-1">
                  <p className="text-xs font-semibold uppercase text-muted-foreground flex items-center gap-1">
                    <FileImage className="w-3.5 h-3.5" /> Estudios y adjuntos
                  </p>
                  {e.attachments.map((a) => (
                    <p key={a.id} className="text-sm capitalize">
                      {a.type}{a.description && <span className="normal-case"> — {a.description}</span>}
                    </p>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
  );
}

// ── Pestaña Evolución ───────────────────────────────────────────────────────

function TabEvolucion({ encounters }: { encounters: EncounterFull[] }) {
  if (encounters.length === 0) {
    return <div className="text-muted-foreground py-12 text-center">Sin atenciones médicas anteriores registradas.</div>;
  }
  return (
    <div className="relative pl-8 border-l-2 border-muted ml-4 space-y-8 pb-8">
      {encounters.map((e) => (
        <div key={e.id} className="relative">
          <div className="absolute -left-[41px] bg-background p-1 rounded-full border-2 border-primary text-primary">
            <Stethoscope className="w-4 h-4" />
          </div>
          <DetalleConsulta e={e} />
        </div>
      ))}
    </div>
  );
}

// ── Pestaña Nueva Consulta ──────────────────────────────────────────────────

type RxDraft = { medication: string; dosage: string; frequency: string; duration: string; instructions: string };
const rxVacia: RxDraft = { medication: "", dosage: "", frequency: "", duration: "", instructions: "" };

function TabNuevaConsulta({ pacienteId, onCreada }: { pacienteId: number; onCreada: () => void }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [form, setForm] = useState({
    specialty: "",
    encounterType: "presencial",
    chiefComplaint: "",
    anamnesis: "",
    physicalExam: "",
    diagnosis: "",
    cie10: "",
    assessment: "",
    plan: "",
  });
  const [recetas, setRecetas] = useState<RxDraft[]>([]);

  const crearRx = useCreateHcePrescription();
  const crearConsulta = useCreateHceEncounter({
    mutation: {
      onSuccess: async (encounter) => {
        const validas = recetas.filter((r) => r.medication.trim());
        for (const r of validas) {
          await crearRx.mutateAsync({
            data: {
              encounterId: encounter.id,
              medication: r.medication.trim(),
              ...(r.dosage.trim() && { dosage: r.dosage.trim() }),
              ...(r.frequency.trim() && { frequency: r.frequency.trim() }),
              ...(r.duration.trim() && { duration: r.duration.trim() }),
              ...(r.instructions.trim() && { instructions: r.instructions.trim() }),
            },
          });
        }
        queryClient.invalidateQueries({ queryKey: getGetHceHistoryQueryKey(pacienteId) });
        toast({ title: "Consulta registrada", description: validas.length ? `Con ${validas.length} prescripción(es)` : undefined });
        setForm({ specialty: "", encounterType: "presencial", chiefComplaint: "", anamnesis: "", physicalExam: "", diagnosis: "", cie10: "", assessment: "", plan: "" });
        setRecetas([]);
        onCreada();
      },
      onError: (e) => toast({ title: "Error al registrar la consulta", description: e.message, variant: "destructive" }),
    },
  });

  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
    setForm({ ...form, [k]: e.target.value });

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Nueva consulta</CardTitle>
        <CardDescription>Registrar una nueva atención en la historia clínica del paciente</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid sm:grid-cols-2 gap-4">
          <div className="space-y-1">
            <Label>Especialidad</Label>
            <Input value={form.specialty} onChange={set("specialty")} placeholder="Ej: Clínica médica" />
          </div>
          <div className="space-y-1">
            <Label>Modalidad</Label>
            <Select value={form.encounterType} onValueChange={(v) => setForm({ ...form, encounterType: v })}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="presencial">Presencial</SelectItem>
                <SelectItem value="videoconsulta">Videoconsulta</SelectItem>
                <SelectItem value="guardia">Guardia</SelectItem>
                <SelectItem value="domicilio">Domicilio</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>

        <div className="space-y-1">
          <Label>Motivo de consulta</Label>
          <Input value={form.chiefComplaint} onChange={set("chiefComplaint")} placeholder="Ej: dolor abdominal de 48hs de evolución" />
        </div>
        <div className="space-y-1">
          <Label>Anamnesis</Label>
          <Textarea
            value={form.anamnesis}
            onChange={set("anamnesis")}
            rows={3}
            placeholder="Historia de la enfermedad actual, antecedentes relevantes..."
            data-testid="input-anamnesis"
          />
        </div>
        <div className="space-y-1">
          <Label>Examen físico</Label>
          <Textarea
            value={form.physicalExam}
            onChange={set("physicalExam")}
            rows={3}
            placeholder="Hallazgos del examen físico..."
            data-testid="input-examen-fisico"
          />
        </div>

        <div className="grid sm:grid-cols-[1fr_160px] gap-4">
          <div className="space-y-1">
            <Label>Diagnóstico</Label>
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
            <Label>CIE-10</Label>
            <Input value={form.cie10} onChange={set("cie10")} placeholder="Ej: A09" className="font-mono" />
          </div>
        </div>

        <div className="space-y-1">
          <Label>Evaluación</Label>
          <Textarea
            value={form.assessment}
            onChange={set("assessment")}
            rows={2}
            placeholder="Evaluación e impresión clínica..."
            data-testid="input-evaluacion"
          />
        </div>
        <div className="space-y-1">
          <Label>Conducta / plan</Label>
          <Textarea value={form.plan} onChange={set("plan")} rows={2} placeholder="Tratamiento, estudios solicitados, control..." />
        </div>

        <div className="space-y-3 border-t pt-4">
          <div className="flex items-center justify-between">
            <Label className="flex items-center gap-1"><Pill className="w-4 h-4" /> Prescripciones</Label>
            <Button type="button" variant="outline" size="sm" onClick={() => setRecetas([...recetas, { ...rxVacia }])}>
              <Plus className="w-4 h-4 mr-1" /> Agregar
            </Button>
          </div>
          {recetas.map((r, i) => (
            <div key={i} className="grid sm:grid-cols-5 gap-2 items-end bg-muted/30 rounded-lg p-3">
              <div className="space-y-1 sm:col-span-2">
                <Label className="text-xs">Medicamento *</Label>
                <Input value={r.medication} onChange={(e) => setRecetas(recetas.map((x, j) => j === i ? { ...x, medication: e.target.value } : x))} placeholder="Ej: amoxicilina 500mg" />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Dosis</Label>
                <Input value={r.dosage} onChange={(e) => setRecetas(recetas.map((x, j) => j === i ? { ...x, dosage: e.target.value } : x))} placeholder="1 comp" />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Frecuencia</Label>
                <Input value={r.frequency} onChange={(e) => setRecetas(recetas.map((x, j) => j === i ? { ...x, frequency: e.target.value } : x))} placeholder="cada 8hs" />
              </div>
              <div className="flex gap-2">
                <div className="space-y-1 flex-1">
                  <Label className="text-xs">Duración</Label>
                  <Input value={r.duration} onChange={(e) => setRecetas(recetas.map((x, j) => j === i ? { ...x, duration: e.target.value } : x))} placeholder="7 días" />
                </div>
                <Button type="button" variant="ghost" size="icon" className="shrink-0" onClick={() => setRecetas(recetas.filter((_, j) => j !== i))}>✕</Button>
              </div>
            </div>
          ))}
        </div>

        <div className="flex justify-end pt-2">
          <Button
            disabled={crearConsulta.isPending || crearRx.isPending}
            onClick={() => {
              const extras: Partial<Pick<EncounterInput, "specialty" | "chiefComplaint" | "anamnesis" | "physicalExam" | "diagnosis" | "cie10" | "assessment" | "plan">> = {};
              for (const k of ["specialty", "chiefComplaint", "anamnesis", "physicalExam", "diagnosis", "cie10", "assessment", "plan"] as const) {
                if (form[k].trim()) extras[k] = form[k].trim();
              }
              const data: EncounterInput = { patientId: pacienteId, encounterType: form.encounterType, status: "cerrada", ...extras };
              crearConsulta.mutate({ data });
            }}
          >
            <Save className="w-4 h-4 mr-2" />
            {crearConsulta.isPending ? "Guardando..." : "Registrar consulta"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

// ── Pestaña Signos Vitales ──────────────────────────────────────────────────

function TabSignosVitales({ pacienteId, encounters }: { pacienteId: number; encounters: EncounterFull[] }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [encounterId, setEncounterId] = useState<string>(encounters[0] ? String(encounters[0].id) : "");
  const [form, setForm] = useState({
    bloodPressure: "", heartRate: "", respiratoryRate: "", temperature: "",
    oxygenSaturation: "", weight: "", height: "",
  });

  const crear = useCreateHceVitals({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getGetHceHistoryQueryKey(pacienteId) });
        toast({ title: "Signos vitales registrados" });
        setForm({ bloodPressure: "", heartRate: "", respiratoryRate: "", temperature: "", oxygenSaturation: "", weight: "", height: "" });
      },
      onError: (e) => toast({ title: "Error al registrar signos vitales", description: e.message, variant: "destructive" }),
    },
  });

  const historial = encounters.flatMap((e) =>
    e.vitals.map((v) => ({ ...v, fecha: e.encounterDate, especialidad: e.specialty }))
  );

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2"><HeartPulse className="w-4 h-4" /> Registrar signos vitales</CardTitle>
          <CardDescription>Los valores se asocian a una consulta existente. El IMC se calcula automáticamente.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {encounters.length === 0 ? (
            <p className="text-sm text-muted-foreground">Primero registrá una consulta en la pestaña "Nueva Consulta" para poder cargar signos vitales.</p>
          ) : (
            <>
              <div className="space-y-1">
                <Label>Consulta</Label>
                <Select value={encounterId} onValueChange={setEncounterId}>
                  <SelectTrigger><SelectValue placeholder="Elegí una consulta" /></SelectTrigger>
                  <SelectContent>
                    {encounters.map((e) => (
                      <SelectItem key={e.id} value={String(e.id)}>
                        {formatFecha(e.encounterDate)}{e.specialty ? ` — ${e.specialty}` : ""}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
                {([
                  ["bloodPressure", "Tensión arterial", "120/80"],
                  ["heartRate", "Frec. cardíaca (lpm)", "72"],
                  ["respiratoryRate", "Frec. respiratoria (rpm)", "16"],
                  ["temperature", "Temperatura (°C)", "36.5"],
                  ["oxygenSaturation", "SatO₂ (%)", "98"],
                  ["weight", "Peso (kg)", "70.5"],
                  ["height", "Altura (cm)", "170"],
                ] as const).map(([key, label, placeholder]) => (
                  <div key={key} className="space-y-1">
                    <Label className="text-xs">{label}</Label>
                    <Input
                      value={form[key]}
                      placeholder={placeholder}
                      onChange={(e) => setForm({ ...form, [key]: e.target.value })}
                    />
                  </div>
                ))}
              </div>
              <div className="flex justify-end">
                <Button
                  disabled={crear.isPending || !encounterId}
                  onClick={() => {
                    const data: VitalSignsInput = { encounterId: Number(encounterId) };
                    if (form.bloodPressure.trim()) data.bloodPressure = form.bloodPressure.trim();
                    for (const k of ["heartRate", "respiratoryRate", "temperature", "oxygenSaturation", "weight", "height"] as const) {
                      const v = form[k].trim().replace(",", ".");
                      if (v && !isNaN(Number(v))) data[k] = Number(v);
                    }
                    if (Object.keys(data).length === 1) {
                      toast({ title: "Cargá al menos un valor", variant: "destructive" });
                      return;
                    }
                    crear.mutate({ data });
                  }}
                >
                  <Save className="w-4 h-4 mr-2" />
                  {crear.isPending ? "Guardando..." : "Registrar"}
                </Button>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2"><Activity className="w-4 h-4" /> Historial</CardTitle>
        </CardHeader>
        <CardContent>
          {historial.length === 0 ? (
            <p className="text-sm text-muted-foreground">No hay signos vitales registrados.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-xs uppercase text-muted-foreground">
                    <th className="py-2 pr-4">Fecha</th>
                    <th className="py-2 pr-4">TA</th>
                    <th className="py-2 pr-4">FC</th>
                    <th className="py-2 pr-4">FR</th>
                    <th className="py-2 pr-4">T°</th>
                    <th className="py-2 pr-4">SatO₂</th>
                    <th className="py-2 pr-4">Peso</th>
                    <th className="py-2 pr-4">Altura</th>
                    <th className="py-2">IMC</th>
                  </tr>
                </thead>
                <tbody>
                  {historial.map((v) => (
                    <tr key={v.id} className="border-b last:border-0">
                      <td className="py-2 pr-4 whitespace-nowrap">{formatFecha(v.fecha)}</td>
                      <td className="py-2 pr-4">{v.bloodPressure ?? "—"}</td>
                      <td className="py-2 pr-4">{v.heartRate ?? "—"}</td>
                      <td className="py-2 pr-4">{v.respiratoryRate ?? "—"}</td>
                      <td className="py-2 pr-4">{v.temperature ?? "—"}</td>
                      <td className="py-2 pr-4">{v.oxygenSaturation != null ? `${v.oxygenSaturation}%` : "—"}</td>
                      <td className="py-2 pr-4">{v.weight != null ? `${v.weight} kg` : "—"}</td>
                      <td className="py-2 pr-4">{v.height ?? "—"}</td>
                      <td className="py-2 font-medium">{v.bmi ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

// ── Página principal ────────────────────────────────────────────────────────

export default function HcePage() {
  const { id } = useParams<{ id: string }>();
  const pacienteId = Number(id);
  const [tab, setTab] = useState("resumen");

  const { data, isLoading, error } = useGetHceHistory(pacienteId, {
    query: { enabled: !!pacienteId },
  });

  if (isLoading) {
    return <div className="p-8 space-y-4"><Skeleton className="h-8 w-64" /><Skeleton className="h-96 w-full" /></div>;
  }

  if (error || !data) {
    return (
      <div className="p-8 text-center space-y-4">
        <p className="text-muted-foreground">No se pudo cargar la historia clínica. Verificá tus permisos de acceso.</p>
        <Link href={`/pacientes/${pacienteId}`}><Button variant="outline">Volver a la ficha</Button></Link>
      </div>
    );
  }

  const { paciente, record, encounters } = data;

  return (
    <div className="space-y-6 max-w-5xl mx-auto">
      <div className="flex items-center gap-4">
        <Link href={`/pacientes/${pacienteId}`}>
          <Button variant="outline" size="icon"><ArrowLeft className="w-4 h-4" /></Button>
        </Link>
        <div className="flex-1">
          <h1 className="text-3xl font-bold tracking-tight flex items-center gap-2">
            <ClipboardList className="w-7 h-7 text-primary" /> Historia Clínica Electrónica
          </h1>
          <p className="text-muted-foreground">
            {paciente.apellido}, {paciente.nombre} (DNI: {paciente.dni || "—"})
          </p>
        </div>
        <Link href={`/pacientes/${pacienteId}/consulta`}>
          <Button size="sm"><Stethoscope className="w-4 h-4 mr-2" /> Iniciar consulta</Button>
        </Link>
        <Link href={`/pacientes/${pacienteId}/historia`}>
          <Button variant="outline" size="sm"><FileText className="w-4 h-4 mr-2" /> Registros anteriores</Button>
        </Link>
      </div>

      <Tabs value={tab} onValueChange={setTab}>
        {/* flex-wrap: con 9 pestañas la grilla fija hacía que los textos se pisaran */}
        <TabsList className="flex w-full flex-wrap justify-start gap-1 h-auto">
          <TabsTrigger value="resumen"><ClipboardList className="w-4 h-4 mr-2 hidden sm:block" /> Resumen</TabsTrigger>
          <TabsTrigger value="ficha" data-testid="tab-ficha"><FileText className="w-4 h-4 mr-2 hidden sm:block" /> Ficha clínica</TabsTrigger>
          <TabsTrigger value="imagenes" data-testid="tab-imagenes">
            <FileImage className="w-4 h-4 mr-2 hidden sm:block" /> Imágenes e informes
          </TabsTrigger>
          <TabsTrigger value="evolucion" data-testid="tab-atenciones-anteriores-hce"><FileText className="w-4 h-4 mr-2 hidden sm:block" /> Atenciones anteriores ({encounters.length})</TabsTrigger>
          <TabsTrigger value="nueva"><Plus className="w-4 h-4 mr-2 hidden sm:block" /> Nueva Consulta</TabsTrigger>
          <TabsTrigger value="vitales"><HeartPulse className="w-4 h-4 mr-2 hidden sm:block" /> Signos Vitales</TabsTrigger>
          <TabsTrigger value="ordenes" data-testid="tab-ordenes"><FlaskConical className="w-4 h-4 mr-2 hidden sm:block" /> Órdenes médicas</TabsTrigger>
          <TabsTrigger value="practicas" data-testid="tab-practicas"><Send className="w-4 h-4 mr-2 hidden sm:block" /> Solicitud de prácticas</TabsTrigger>
          <TabsTrigger value="resolucion"><FilePenLine className="w-4 h-4 mr-2 hidden sm:block" /> Resolución</TabsTrigger>
          <TabsTrigger value="historial"><History className="w-4 h-4 mr-2 hidden sm:block" /> Historial</TabsTrigger>
        </TabsList>

        <TabsContent value="resumen" className="pt-4">
          <TabResumen
            encounters={encounters}
            alertas={{
              alergias: ((record as Record<string, unknown> | undefined)?.["allergies"] as string) || null,
              cronicas: ((record as Record<string, unknown> | undefined)?.["chronicDiseases"] as string) || null,
            }}
            onVerFicha={() => setTab("ficha")}
          />
        </TabsContent>
        <TabsContent value="ficha" className="pt-4">
          <TabFicha pacienteId={pacienteId} record={record as Record<string, unknown> | undefined} />
        </TabsContent>
        <TabsContent value="imagenes" className="pt-4">
          <TabImagenes pacienteId={pacienteId} />
        </TabsContent>
        <TabsContent value="evolucion" className="pt-4">
          <TabEvolucion encounters={encounters} />
        </TabsContent>
        <TabsContent value="nueva" className="pt-4">
          <TabNuevaConsulta pacienteId={pacienteId} onCreada={() => setTab("evolucion")} />
        </TabsContent>
        <TabsContent value="vitales" className="pt-4">
          <TabSignosVitales pacienteId={pacienteId} encounters={encounters} />
        </TabsContent>
        <TabsContent value="ordenes" className="pt-4">
          <SeccionOrdenes pacienteId={pacienteId} />
        </TabsContent>
        <TabsContent value="practicas" className="pt-4 space-y-4">
          <PanelDerivacion pacienteId={pacienteId} />
          <ListaSolicitudesPaciente pacienteId={pacienteId} />
        </TabsContent>
        <TabsContent value="resolucion" className="pt-4">
          <TabResolucion pacienteId={pacienteId} />
        </TabsContent>
        <TabsContent value="historial" className="pt-4">
          <TabHistorial pacienteId={pacienteId} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
