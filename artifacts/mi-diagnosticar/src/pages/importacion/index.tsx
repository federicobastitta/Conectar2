import { useState, useRef, useCallback, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import {
  Upload, CheckCircle2, Play, FileJson, FileSpreadsheet, AlertCircle,
  ArrowRight, ArrowLeft, RotateCcw, History, Eye, Loader2,
  Users, Stethoscope, FileText, Pill, Paperclip, ClipboardList, X,
  Sparkles, Database, Info,
} from "lucide-react";
import { format } from "date-fns";
import { es } from "date-fns/locale";

// ── Tipos ─────────────────────────────────────────────────────────────────

type EntidadDef = {
  key: string;
  label: string;
  claveDedup: string;
  totalCampos: number;
};

type CampoTarget = {
  key: string;
  label: string;
  requerido?: boolean;
  descripcion?: string;
};

type PerfilDetectado = {
  id: string;
  label: string;
  sistema: string;
  descripcion: string;
};

type UploadResult = {
  jobId: number;
  nombre: string;
  tipoEntidad: string;
  formato: string;
  totalRegistros: number;
  columnas: string[];
  mapeoAutoDetectado: Record<string, string>;
  camposTarget: CampoTarget[];
  preview: Record<string, unknown>[];
  perfilDetectado: PerfilDetectado | null;
};

type RegistroSample = {
  fila: number;
  accion: string;
  datos: Record<string, unknown>;
  datosOriginales: Record<string, unknown>;
  errores?: string[];
  pacienteId?: number;
};

type ValidacionResult = {
  jobId: number;
  stats: {
    nuevos: number;
    actualizar: number;
    omitir: number;
    errores: number;
    total: number;
    pacientesNuevos: number;
    pacientesActualizar: number;
  };
  sample: {
    nuevos: RegistroSample[];
    actualizar: RegistroSample[];
    errores: RegistroSample[];
  };
  truncado: boolean;
};

type EjecucionResult = {
  jobId: number;
  dryRun: boolean;
  creados: number;
  actualizados: number;
  omitidos: number;
  errores: number;
  total: number;
};

type JobHistorial = {
  id: number;
  nombre: string;
  tipoEntidad: string;
  formato: string;
  estado: string;
  totalRegistros: number;
  creados: number;
  actualizados: number;
  omitidos: number;
  errores: number;
  createdAt: string;
  completadoAt: string | null;
};

type AuditoriaRow = {
  id: number;
  fila: number;
  accion: string;
  entidadTipo: string;
  entidadId: number | null;
  mensajeError: string | null;
  datosOriginales: Record<string, unknown>;
  createdAt: string;
};

// ── Helpers ───────────────────────────────────────────────────────────────

const ENTIDAD_ICON: Record<string, React.ElementType> = {
  pacientes: Users,
  profesionales: Stethoscope,
  evoluciones: FileText,
  diagnosticos: ClipboardList,
  medicacion: Pill,
  adjuntos: Paperclip,
  turnos_hc: Database,
};

const ENTIDADES_GRID = [
  {
    key: "turnos_hc",
    label: "Export completo HIS",
    icon: Database,
    desc: "Turnos + nota clínica + diagnóstico CIE-10 + signos vitales",
    badge: "Recomendado",
  },
  {
    key: "pacientes",
    label: "Solo pacientes",
    icon: Users,
    desc: "Datos demográficos, obra social, contacto",
  },
  {
    key: "evoluciones",
    label: "Historia Clínica",
    icon: FileText,
    desc: "Evoluciones y notas de consulta",
  },
  {
    key: "diagnosticos",
    label: "Diagnósticos",
    icon: ClipboardList,
    desc: "Diagnósticos CIE-10",
  },
  {
    key: "medicacion",
    label: "Medicación",
    icon: Pill,
    desc: "Recetas y medicación crónica",
  },
  {
    key: "adjuntos",
    label: "Estudios / Docs",
    icon: Paperclip,
    desc: "Laboratorio, imágenes, informes",
  },
  {
    key: "profesionales",
    label: "Profesionales",
    icon: Stethoscope,
    desc: "Staff médico y de salud",
  },
] as const;

const ACCION_BADGE: Record<string, { label: string; cls: string }> = {
  crear: { label: "Nuevo", cls: "bg-green-100 text-green-700 border-green-200" },
  actualizar: { label: "Actualizar", cls: "bg-blue-100 text-blue-700 border-blue-200" },
  omitir: { label: "Omitir", cls: "bg-slate-100 text-slate-600 border-slate-200" },
  error: { label: "Error", cls: "bg-red-100 text-red-700 border-red-200" },
};

const ESTADO_JOB: Record<string, { label: string; cls: string }> = {
  pendiente: { label: "Pendiente", cls: "bg-slate-100 text-slate-600" },
  validando: { label: "Validando", cls: "bg-amber-100 text-amber-700" },
  listo_para_ejecutar: { label: "Listo", cls: "bg-blue-100 text-blue-700" },
  ejecutando: { label: "Ejecutando", cls: "bg-violet-100 text-violet-700" },
  completado: { label: "Completado", cls: "bg-green-100 text-green-700" },
  error: { label: "Con errores", cls: "bg-red-100 text-red-700" },
};

function authHeaders(): Record<string, string> {
  const token = typeof window !== "undefined" ? localStorage.getItem("auth_token") : null;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function apiPost(url: string, body?: unknown, isFormData = false) {
  const opts: RequestInit = {
    method: "POST",
    credentials: "include",
    body: isFormData ? (body as FormData) : JSON.stringify(body),
  };
  opts.headers = isFormData
    ? authHeaders()
    : { "Content-Type": "application/json", ...authHeaders() };
  const r = await fetch(url, opts);
  if (!r.ok) {
    const err = await r.json().catch(() => ({ error: "Error desconocido" })) as { error?: string };
    throw new Error(err.error ?? `HTTP ${r.status}`);
  }
  return r.json();
}

async function apiGet(url: string) {
  const r = await fetch(url, { credentials: "include", headers: authHeaders() });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

// ── Steps ─────────────────────────────────────────────────────────────────

const STEPS = [
  { id: 1, label: "Origen", icon: Upload },
  { id: 2, label: "Mapeo de columnas", icon: ArrowRight },
  { id: 3, label: "Vista previa", icon: Eye },
  { id: 4, label: "Resultado", icon: CheckCircle2 },
];

// ── Componente principal ─────────────────────────────────────────────────

export default function Importacion() {
  const { toast } = useToast();
  const [step, setStep] = useState(1);
  const [showHistory, setShowHistory] = useState(false);
  const [entidades, setEntidades] = useState<EntidadDef[]>([]);
  const [entidadesLoaded, setEntidadesLoaded] = useState(false);
  const [historial, setHistorial] = useState<JobHistorial[]>([]);
  const [historialLoaded, setHistorialLoaded] = useState(false);
  const [auditoria, setAuditoria] = useState<AuditoriaRow[]>([]);
  const [auditoriaJobId, setAuditoriaJobId] = useState<number | null>(null);

  // Step 1
  const [tipoEntidad, setTipoEntidad] = useState("turnos_hc");
  const [archivo, setArchivo] = useState<File | null>(null);
  const [jsonInput, setJsonInput] = useState("");
  const [modoEntrada, setModoEntrada] = useState<"archivo" | "json">("archivo");
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Step 2
  const [uploadResult, setUploadResult] = useState<UploadResult | null>(null);
  const [mapeo, setMapeo] = useState<Record<string, string>>({});

  // Step 3
  const [validando, setValidando] = useState(false);
  const [validacion, setValidacion] = useState<ValidacionResult | null>(null);
  const [resolucionGlobal, setResolucionGlobal] = useState<"actualizar" | "omitir" | null>(null);

  // Step 4
  const [ejecutando, setEjecutando] = useState(false);
  const [resultado, setResultado] = useState<EjecucionResult | null>(null);
  const [progreso, setProgreso] = useState<JobHistorial | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopPoll = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  // Limpiar el polling al desmontar
  useEffect(() => stopPoll, [stopPoll]);

  const loadEntidades = useCallback(async () => {
    if (entidadesLoaded) return;
    try {
      const data = await apiGet("/api/importacion/entidades") as EntidadDef[];
      setEntidades(data);
      setEntidadesLoaded(true);
    } catch {
      toast({ title: "Error cargando entidades", variant: "destructive" });
    }
  }, [entidadesLoaded, toast]);

  const loadHistorial = useCallback(async () => {
    try {
      const data = await apiGet("/api/importacion/jobs") as JobHistorial[];
      setHistorial(data);
      setHistorialLoaded(true);
    } catch {
      toast({ title: "Error cargando historial", variant: "destructive" });
    }
  }, [toast]);

  const handleShowHistory = async () => {
    setShowHistory(true);
    await loadHistorial();
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (f) setArchivo(f);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    const f = e.dataTransfer.files[0];
    if (f) setArchivo(f);
  };

  // ── Step 1: Upload ─────────────────────────────────────────────────────

  const handleUpload = async () => {
    setUploading(true);
    try {
      let result: UploadResult;
      if (modoEntrada === "archivo" && archivo) {
        const fd = new FormData();
        fd.append("file", archivo);
        fd.append("tipoEntidad", tipoEntidad);
        result = await apiPost("/api/importacion/jobs/upload", fd, true) as UploadResult;
      } else {
        if (!jsonInput.trim()) { toast({ title: "Pegue datos JSON", variant: "destructive" }); return; }
        try { JSON.parse(jsonInput); } catch { toast({ title: "JSON inválido", variant: "destructive" }); return; }
        result = await apiPost("/api/importacion/jobs/upload", { tipoEntidad, datosJson: jsonInput }) as UploadResult;
      }
      setUploadResult(result);
      setMapeo(result.mapeoAutoDetectado);
      // Si el servidor detectó un perfil y sugirió una entidad diferente, actualizar
      if (result.tipoEntidad !== tipoEntidad) setTipoEntidad(result.tipoEntidad);
      await loadEntidades();
      setStep(2);
    } catch (err) {
      toast({ title: "Error al cargar archivo", description: err instanceof Error ? err.message : "Error desconocido", variant: "destructive" });
    } finally {
      setUploading(false);
    }
  };

  // ── Step 2 → 3: Validar ────────────────────────────────────────────────

  const handleValidar = async () => {
    if (!uploadResult) return;
    setValidando(true);
    try {
      const result = await apiPost(
        `/api/importacion/jobs/${uploadResult.jobId}/validar`,
        { mapeoColumnas: mapeo }
      ) as ValidacionResult;
      setValidacion(result);
      setResolucionGlobal(null);
      setStep(3);
    } catch (err) {
      toast({ title: "Error en validación", description: err instanceof Error ? err.message : "", variant: "destructive" });
    } finally {
      setValidando(false);
    }
  };

  // ── Step 3 → 4: Ejecutar ──────────────────────────────────────────────

  const iniciarPolling = useCallback((jobId: number) => {
    stopPoll();
    pollRef.current = setInterval(() => {
      void (async () => {
        try {
          const job = await apiGet(`/api/importacion/jobs/${jobId}`) as JobHistorial;
          setProgreso(job);
          if (job.estado === "completado" || job.estado === "error") {
            stopPoll();
            setResultado({
              jobId,
              dryRun: false,
              creados: job.creados,
              actualizados: job.actualizados,
              omitidos: job.omitidos,
              errores: job.errores,
              total: job.totalRegistros,
            });
            toast({
              title: job.estado === "completado" ? "Importación completada" : "Importación finalizó con errores",
              description: `${job.creados} creados · ${job.actualizados} actualizados · ${job.errores} errores`,
              variant: job.estado === "error" ? "destructive" : undefined,
            });
          }
        } catch {
          // Error transitorio de red: el próximo tick reintenta
        }
      })();
    }, 1500);
  }, [stopPoll, toast]);

  const handleEjecutar = async (dryRun = false) => {
    if (!uploadResult || !validacion) return;
    setEjecutando(true);
    try {
      const result = await apiPost(
        `/api/importacion/jobs/${uploadResult.jobId}/ejecutar`,
        {
          dryRun,
          mapeoColumnas: mapeo,
          // Resolución global de duplicados: "actualizar" importa evoluciones de
          // pacientes existentes, "omitir" solo crea los DNI nuevos.
          resolucionGlobal,
        }
      ) as EjecucionResult & { estado?: string };

      if (dryRun) {
        setResultado(result);
        toast({ title: "Simulación completada", description: `${result.creados} nuevos · ${result.actualizados} existentes · ${result.errores} errores` });
        return;
      }

      // Ejecución real: el backend procesa en background. Pasamos a la vista de
      // progreso y hacemos polling hasta que el job termine.
      setResultado(result.estado === "completado" ? result : null);
      setProgreso({
        id: uploadResult.jobId,
        nombre: uploadResult.nombre,
        tipoEntidad: uploadResult.tipoEntidad,
        formato: uploadResult.formato,
        estado: result.estado ?? "ejecutando",
        totalRegistros: result.total,
        creados: result.creados,
        actualizados: result.actualizados,
        omitidos: result.omitidos,
        errores: result.errores,
        createdAt: new Date().toISOString(),
        completadoAt: null,
      });
      setStep(4);
      if (result.estado !== "completado") {
        iniciarPolling(uploadResult.jobId);
      }
    } catch (err) {
      toast({ title: "Error al ejecutar", description: err instanceof Error ? err.message : "", variant: "destructive" });
    } finally {
      setEjecutando(false);
    }
  };

  const handleVerAuditoria = async (jobId: number) => {
    try {
      const data = await apiGet(`/api/importacion/jobs/${jobId}/auditoria?limit=200`) as { data: AuditoriaRow[] };
      setAuditoria(data.data);
      setAuditoriaJobId(jobId);
    } catch {
      toast({ title: "Error cargando auditoría", variant: "destructive" });
    }
  };

  const resetWizard = () => {
    stopPoll();
    setStep(1);
    setArchivo(null);
    setJsonInput("");
    setUploadResult(null);
    setMapeo({});
    setValidacion(null);
    setResultado(null);
    setProgreso(null);
    setResolucionGlobal(null);
    setAuditoria([]);
    setAuditoriaJobId(null);
  };

  // ── Render ────────────────────────────────────────────────────────────

  if (showHistory) {
    return (
      <HistorialView
        historial={historial}
        loaded={historialLoaded}
        auditoria={auditoria}
        auditoriaJobId={auditoriaJobId}
        onBack={() => setShowHistory(false)}
        onVerAuditoria={handleVerAuditoria}
      />
    );
  }

  return (
    <div className="max-w-5xl mx-auto space-y-6 pb-10">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
            <Upload className="w-6 h-6 text-primary" />
            Motor de Importación — Historias Clínicas
          </h1>
          <p className="text-muted-foreground text-sm mt-0.5">
            Migre pacientes, HC y datos desde cualquier sistema en 4 pasos · Auditoría completa
          </p>
        </div>
        <Button variant="outline" onClick={() => void handleShowHistory()}>
          <History className="w-4 h-4 mr-1.5" /> Historial
        </Button>
      </div>

      {/* Stepper */}
      <div className="flex items-center gap-0">
        {STEPS.map((s, i) => {
          const Icon = s.icon;
          const active = step === s.id;
          const done = step > s.id;
          return (
            <div key={s.id} className="flex items-center flex-1 last:flex-none">
              <div className={`flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
                active ? "bg-primary text-primary-foreground" :
                done ? "text-primary" : "text-muted-foreground"
              }`}>
                <div className={`w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold ${
                  active ? "bg-primary-foreground text-primary" :
                  done ? "bg-primary text-primary-foreground" : "bg-muted"
                }`}>
                  {done ? <CheckCircle2 className="w-4 h-4" /> : s.id}
                </div>
                <span className="hidden sm:block">{s.label}</span>
              </div>
              {i < STEPS.length - 1 && (
                <div className={`flex-1 h-px mx-2 ${step > s.id ? "bg-primary" : "bg-border"}`} />
              )}
            </div>
          );
        })}
      </div>

      <Separator />

      {/* ── Step 1: Origen ─────────────────────────────────────────────── */}
      {step === 1 && (
        <div className="space-y-6">
          <div className="grid md:grid-cols-2 gap-6">
            {/* Tipo de entidad */}
            <div className="space-y-3">
              <h2 className="font-semibold text-base">¿Qué datos vas a importar?</h2>
              <div className="grid grid-cols-2 gap-2">
                {ENTIDADES_GRID.map((ent) => {
                  const Icon = ent.icon;
                  const selected = tipoEntidad === ent.key;
                  return (
                    <button
                      key={ent.key}
                      onClick={() => setTipoEntidad(ent.key)}
                      className={`p-3 rounded-lg border text-left transition-all relative ${
                        selected
                          ? "border-primary bg-primary/5 ring-1 ring-primary"
                          : "border-border hover:border-muted-foreground/40 bg-card"
                      }`}
                    >
                      {"badge" in ent && ent.badge && (
                        <span className="absolute top-2 right-2 text-[10px] font-semibold bg-primary text-primary-foreground px-1.5 py-0.5 rounded-full">
                          {ent.badge}
                        </span>
                      )}
                      <div className="flex items-center gap-2 mb-1">
                        <Icon className={`w-4 h-4 ${selected ? "text-primary" : "text-muted-foreground"}`} />
                        <span className="text-sm font-medium">{ent.label}</span>
                      </div>
                      <p className="text-xs text-muted-foreground leading-tight pr-4">{ent.desc}</p>
                    </button>
                  );
                })}
              </div>

              {tipoEntidad === "turnos_hc" && (
                <div className="text-xs bg-primary/5 border border-primary/20 rounded-lg p-3 text-primary space-y-1">
                  <p className="font-semibold flex items-center gap-1.5"><Sparkles className="w-3.5 h-3.5" /> Formato recomendado</p>
                  <p className="text-muted-foreground">Soporta exports de Alephoo, Phir-it, Pulso y sistemas legacy (XLS/HTML). Genera automáticamente pacientes, evoluciones y diagnósticos.</p>
                </div>
              )}
            </div>

            {/* Archivo o JSON */}
            <div className="space-y-3">
              <h2 className="font-semibold text-base">Origen de los datos</h2>
              <div className="flex gap-2">
                <Button
                  size="sm"
                  variant={modoEntrada === "archivo" ? "default" : "outline"}
                  onClick={() => setModoEntrada("archivo")}
                >
                  <FileSpreadsheet className="w-4 h-4 mr-1.5" /> Archivo
                </Button>
                <Button
                  size="sm"
                  variant={modoEntrada === "json" ? "default" : "outline"}
                  onClick={() => setModoEntrada("json")}
                >
                  <FileJson className="w-4 h-4 mr-1.5" /> JSON / Pegar
                </Button>
              </div>

              {modoEntrada === "archivo" ? (
                <div
                  className={`border-2 border-dashed rounded-lg p-8 text-center cursor-pointer transition-colors ${
                    archivo ? "border-primary bg-primary/5" : "border-border hover:border-muted-foreground/50 bg-muted/20"
                  }`}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={handleDrop}
                  onClick={() => fileInputRef.current?.click()}
                >
                  <input
                    ref={fileInputRef}
                    type="file"
                    className="hidden"
                    accept=".csv,.xlsx,.xls,.json,.html"
                    onChange={handleFileChange}
                  />
                  {archivo ? (
                    <div className="space-y-2">
                      <FileSpreadsheet className="w-8 h-8 text-primary mx-auto" />
                      <p className="font-medium text-sm">{archivo.name}</p>
                      <p className="text-xs text-muted-foreground">{(archivo.size / 1024 / 1024).toFixed(1)} MB</p>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={(e) => { e.stopPropagation(); setArchivo(null); }}
                      >
                        <X className="w-3 h-3 mr-1" /> Quitar
                      </Button>
                    </div>
                  ) : (
                    <div className="space-y-2">
                      <Upload className="w-8 h-8 text-muted-foreground/50 mx-auto" />
                      <p className="text-sm text-muted-foreground">
                        Arrastrá aquí o hacé clic para seleccionar
                      </p>
                      <p className="text-xs text-muted-foreground">CSV · Excel (.xlsx) · JSON · XLS (HTML)</p>
                    </div>
                  )}
                </div>
              ) : (
                <div className="space-y-2">
                  <Textarea
                    className="font-mono text-xs min-h-[200px] resize-none"
                    placeholder={`Pegá un JSON array:\n[\n  {"nombre": "Juan", "apellido": "Pérez", "dni": "12345678"},\n  ...\n]`}
                    value={jsonInput}
                    onChange={(e) => setJsonInput(e.target.value)}
                  />
                </div>
              )}

              <div className="text-xs text-muted-foreground bg-muted/40 rounded p-3 space-y-1">
                <p className="font-medium text-foreground">Formatos aceptados</p>
                <p>• <strong>XLS / HTML-XLS</strong>: exports legacy de Alephoo, Phir-it, Pulso, otros HIS</p>
                <p>• <strong>XLSX / CSV</strong>: primera fila = encabezados, delimitador coma o punto y coma</p>
                <p>• <strong>JSON</strong>: array de objetos con clave-valor</p>
              </div>
            </div>
          </div>

          <div className="flex justify-end">
            <Button
              size="lg"
              onClick={() => void handleUpload()}
              disabled={uploading || (modoEntrada === "archivo" && !archivo) || (modoEntrada === "json" && !jsonInput.trim())}
            >
              {uploading ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <ArrowRight className="w-4 h-4 mr-2" />}
              {uploading ? "Procesando archivo…" : "Continuar al mapeo de columnas"}
            </Button>
          </div>
        </div>
      )}

      {/* ── Step 2: Mapeo ─────────────────────────────────────────────────── */}
      {step === 2 && uploadResult && (
        <div className="space-y-5">
          {/* Banner de perfil detectado */}
          {uploadResult.perfilDetectado && (
            <div className="flex items-start gap-3 p-4 bg-green-50 border border-green-200 rounded-lg">
              <Sparkles className="w-5 h-5 text-green-600 shrink-0 mt-0.5" />
              <div className="flex-1">
                <p className="font-semibold text-green-800 text-sm">
                  Perfil canónico detectado: {uploadResult.perfilDetectado.label}
                </p>
                <p className="text-green-700 text-xs mt-0.5">
                  Sistema: {uploadResult.perfilDetectado.sistema} · {uploadResult.perfilDetectado.descripcion}
                </p>
                <p className="text-green-600 text-xs mt-1">
                  El mapeo de columnas fue aplicado automáticamente. Podés ajustarlo abajo si es necesario.
                </p>
              </div>
              <Badge className="bg-green-600 text-white text-xs shrink-0">Auto-mapeado</Badge>
            </div>
          )}

          <div className="flex items-center justify-between">
            <div>
              <h2 className="font-semibold text-base">Mapeo de columnas</h2>
              <p className="text-sm text-muted-foreground">
                {uploadResult.totalRegistros.toLocaleString("es-AR")} registros · {uploadResult.columnas.length} columnas
                {uploadResult.formato !== "json" && ` · ${uploadResult.formato.toUpperCase()}`}
              </p>
            </div>
            <Badge variant="outline" className="text-xs">
              {Object.values(mapeo).filter(Boolean).length} de {uploadResult.columnas.length} columnas mapeadas
            </Badge>
          </div>

          {/* Preview tabla */}
          <div className="border rounded-lg overflow-hidden">
            <div className="bg-muted/50 px-4 py-2 border-b text-xs font-medium text-muted-foreground flex items-center gap-2">
              <Eye className="w-3.5 h-3.5" /> Vista previa — primeras {Math.min(5, uploadResult.preview.length)} filas
            </div>
            <div className="overflow-x-auto max-h-48">
              <table className="w-full text-xs">
                <thead className="bg-muted/20 border-b sticky top-0">
                  <tr>
                    {uploadResult.columnas.slice(0, 12).map((col) => (
                      <th key={col} className="px-3 py-2 text-left font-medium whitespace-nowrap">
                        <div className="flex items-center gap-1">
                          {col}
                          {mapeo[col] && (
                            <span className="text-primary text-[10px] font-normal">→ {mapeo[col]}</span>
                          )}
                        </div>
                      </th>
                    ))}
                    {uploadResult.columnas.length > 12 && (
                      <th className="px-3 py-2 text-muted-foreground">
                        +{uploadResult.columnas.length - 12} más
                      </th>
                    )}
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {uploadResult.preview.map((row, i) => (
                    <tr key={i} className="hover:bg-muted/20">
                      {uploadResult.columnas.slice(0, 12).map((col) => (
                        <td key={col} className="px-3 py-1.5 whitespace-nowrap text-muted-foreground max-w-[180px] truncate">
                          {String(row[col] ?? "")}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* Mapeo de campos — agrupar en dos columnas */}
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold">Asignar columnas a campos del sistema</h3>
              <p className="text-xs text-muted-foreground">
                Los campos marcados con * son requeridos
              </p>
            </div>

            {/* Campos requeridos con alerta visual */}
            {uploadResult.camposTarget.filter((c) => c.requerido).some((c) => !Object.values(mapeo).includes(c.key)) && (
              <div className="flex items-start gap-2 p-3 bg-amber-50 border border-amber-200 rounded-lg text-xs text-amber-700">
                <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
                <span>
                  Faltan mapear campos requeridos:&nbsp;
                  {uploadResult.camposTarget
                    .filter((c) => c.requerido && !Object.values(mapeo).includes(c.key))
                    .map((c) => c.label)
                    .join(", ")}
                </span>
              </div>
            )}

            <div className="grid md:grid-cols-2 gap-2">
              {uploadResult.columnas.map((col) => (
                <div key={col} className={`flex items-center gap-3 p-2.5 border rounded-lg bg-card ${
                  mapeo[col] ? "border-primary/30" : "border-border"
                }`}>
                  <div className="flex-1 min-w-0">
                    <div className="text-xs font-medium truncate" title={col}>{col}</div>
                    <div className="text-xs text-muted-foreground truncate">
                      {uploadResult.preview[0]?.[col] != null
                        ? `"${String(uploadResult.preview[0][col]).substring(0, 28)}"`
                        : "—"}
                    </div>
                  </div>
                  <ArrowRight className="w-3 h-3 text-muted-foreground shrink-0" />
                  <div className="w-44 shrink-0">
                    <Select
                      value={mapeo[col] ?? "__omitir"}
                      onValueChange={(v) => setMapeo({ ...mapeo, [col]: v === "__omitir" ? "" : v })}
                    >
                      <SelectTrigger className="h-7 text-xs">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="__omitir">— No importar —</SelectItem>
                        {uploadResult.camposTarget.map((campo) => (
                          <SelectItem key={campo.key} value={campo.key}>
                            {campo.label}{campo.requerido ? " *" : ""}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="flex justify-between">
            <Button variant="outline" onClick={() => setStep(1)}>
              <ArrowLeft className="w-4 h-4 mr-1" /> Volver
            </Button>
            <Button onClick={() => void handleValidar()} disabled={validando}>
              {validando ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Eye className="w-4 h-4 mr-2" />}
              {validando ? "Analizando registros…" : "Validar y ver preview"}
            </Button>
          </div>
        </div>
      )}

      {/* ── Step 3: Vista previa validada ───────────────────────────────── */}
      {step === 3 && validacion && (
        <div className="space-y-5">
          <div>
            <h2 className="font-semibold text-base">Vista previa de la importación</h2>
            <p className="text-sm text-muted-foreground">
              {validacion.stats.total.toLocaleString("es-AR")} registros analizados
              {validacion.truncado && " · mostrando muestra representativa de cada categoría"}
            </p>
          </div>

          {/* Stats cards */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            {[
              { label: "Turnos nuevos", value: validacion.stats.nuevos, sub: `${validacion.stats.pacientesNuevos} pacientes únicos`, cls: "text-green-700 bg-green-50 border-green-200" },
              { label: "Pacientes existentes", value: validacion.stats.actualizar, sub: `${validacion.stats.pacientesActualizar} únicos`, cls: "text-blue-700 bg-blue-50 border-blue-200" },
              { label: "Omitir", value: validacion.stats.omitir, sub: "sin datos válidos", cls: "text-slate-600 bg-slate-50 border-slate-200" },
              { label: "Errores", value: validacion.stats.errores, sub: "no se importarán", cls: "text-red-700 bg-red-50 border-red-200" },
            ].map((k) => (
              <div key={k.label} className={`border rounded-lg p-4 text-center ${k.cls}`}>
                <div className="text-3xl font-bold">{k.value.toLocaleString("es-AR")}</div>
                <div className="text-xs font-medium mt-1 opacity-80">{k.label}</div>
                <div className="text-xs opacity-60 mt-0.5">{k.sub}</div>
              </div>
            ))}
          </div>

          {/* Información sobre el proceso */}
          <div className="flex items-start gap-3 p-4 bg-muted/40 border rounded-lg text-sm">
            <Info className="w-4 h-4 text-muted-foreground shrink-0 mt-0.5" />
            <div className="space-y-1 text-muted-foreground text-xs">
              <p>
                <span className="font-medium text-foreground">¿Qué va a hacer el importador?</span>
              </p>
              <p>
                • Por cada turno con un DNI <span className="font-medium text-green-700">nuevo</span>: crea el paciente + evolución clínica con la nota + diagnóstico CIE-10.
              </p>
              <p>
                • Por cada turno con un DNI <span className="font-medium text-blue-700">ya existente</span>: agrega la evolución y diagnóstico al historial del paciente sin pisar sus datos demográficos.
              </p>
              {validacion.stats.actualizar > 0 && (
                <p>
                  • Elegí abajo cómo tratar los <span className="font-medium">{validacion.stats.actualizar.toLocaleString("es-AR")} turnos de pacientes ya registrados</span>.
                </p>
              )}
            </div>
          </div>

          {/* Acciones globales para duplicados */}
          {validacion.stats.actualizar > 0 && (
            <div className="space-y-2">
              <h3 className="text-sm font-medium">Pacientes ya registrados en el sistema</h3>
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  size="sm"
                  variant={resolucionGlobal === "actualizar" ? "default" : "outline"}
                  onClick={() => setResolucionGlobal("actualizar")}
                >
                  <CheckCircle2 className="w-3.5 h-3.5 mr-1.5" />
                  Importar evoluciones de todos
                </Button>
                <Button
                  size="sm"
                  variant={resolucionGlobal === "omitir" ? "default" : "outline"}
                  onClick={() => setResolucionGlobal("omitir")}
                >
                  <X className="w-3.5 h-3.5 mr-1.5" />
                  Omitir todos (solo nuevos)
                </Button>
                {resolucionGlobal && (
                  <span className="text-xs text-muted-foreground">
                    Seleccionado: <span className="font-medium text-foreground">
                      {resolucionGlobal === "actualizar" ? "importar evoluciones de pacientes existentes" : "omitir pacientes ya registrados"}
                    </span>
                  </span>
                )}
              </div>
            </div>
          )}

          {/* Muestra de errores */}
          {validacion.sample.errores.length > 0 && (
            <div className="space-y-2">
              <h3 className="text-sm font-medium text-red-700 flex items-center gap-1.5">
                <AlertCircle className="w-4 h-4" /> Errores detectados
                {validacion.stats.errores > validacion.sample.errores.length && (
                  <span className="text-xs font-normal text-muted-foreground">
                    (mostrando {validacion.sample.errores.length} de {validacion.stats.errores})
                  </span>
                )}
              </h3>
              <div className="border border-red-200 rounded-lg overflow-hidden">
                <table className="w-full text-xs">
                  <thead className="bg-red-50 border-b border-red-200">
                    <tr>
                      <th className="px-3 py-2 text-left font-medium text-red-700 w-16">Fila</th>
                      <th className="px-3 py-2 text-left font-medium text-red-700">Paciente</th>
                      <th className="px-3 py-2 text-left font-medium text-red-700">Error</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-red-100">
                    {validacion.sample.errores.map((reg) => (
                      <tr key={reg.fila} className="bg-red-50/30">
                        <td className="px-3 py-2 font-mono text-red-500">{reg.fila}</td>
                        <td className="px-3 py-2">
                          {[reg.datos.apellido, reg.datos.nombre].filter(Boolean).join(", ") || "—"}
                          {Boolean(reg.datos.dni) && <span className="ml-1 text-muted-foreground">DNI {String(reg.datos.dni)}</span>}
                        </td>
                        <td className="px-3 py-2 text-red-600">{reg.errores?.join("; ")}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Muestra de nuevos */}
          {validacion.sample.nuevos.length > 0 && (
            <div className="space-y-2">
              <h3 className="text-sm font-medium text-green-700 flex items-center gap-1.5">
                <CheckCircle2 className="w-4 h-4" /> Muestra — pacientes nuevos
                <span className="text-xs font-normal text-muted-foreground">
                  ({validacion.stats.nuevos.toLocaleString("es-AR")} total, mostrando {validacion.sample.nuevos.length})
                </span>
              </h3>
              <SampleTable registros={validacion.sample.nuevos} />
            </div>
          )}

          {/* Muestra de duplicados */}
          {validacion.sample.actualizar.length > 0 && (
            <div className="space-y-2">
              <h3 className="text-sm font-medium text-blue-700 flex items-center gap-1.5">
                <Users className="w-4 h-4" /> Muestra — pacientes ya registrados
                <span className="text-xs font-normal text-muted-foreground">
                  ({validacion.stats.actualizar.toLocaleString("es-AR")} total, mostrando {validacion.sample.actualizar.length})
                </span>
              </h3>
              <SampleTable registros={validacion.sample.actualizar} />
            </div>
          )}

          {validacion.stats.errores > 0 && (
            <div className="flex items-start gap-2 p-3 bg-amber-50 border border-amber-200 rounded-lg text-xs text-amber-700">
              <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
              <span>Los {validacion.stats.errores} registros con error no se importarán. El resto se procesará normalmente.</span>
            </div>
          )}

          <div className="flex justify-between">
            <Button variant="outline" onClick={() => setStep(2)}>
              <ArrowLeft className="w-4 h-4 mr-1" /> Volver al mapeo
            </Button>
            <div className="flex gap-2">
              <Button
                variant="outline"
                onClick={() => void handleEjecutar(true)}
                disabled={ejecutando}
              >
                <Eye className="w-4 h-4 mr-1.5" /> Simulación
              </Button>
              <Button
                onClick={() => void handleEjecutar(false)}
                disabled={ejecutando || validacion.stats.total === validacion.stats.errores}
                className="min-w-[160px]"
              >
                {ejecutando ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Play className="w-4 h-4 mr-2" />}
                {ejecutando ? "Importando…" : "Ejecutar importación"}
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* ── Step 4: Progreso (importación en curso) ──────────────────────── */}
      {step === 4 && !resultado && progreso && (
        (() => {
          const procesadas = progreso.creados + progreso.actualizados + progreso.omitidos + progreso.errores;
          const total = progreso.totalRegistros || 1;
          const pct = Math.min(100, Math.round((procesadas / total) * 100));
          return (
            <div className="space-y-6">
              <div className="text-center py-6">
                <Loader2 className="w-16 h-16 text-primary mx-auto mb-3 animate-spin" />
                <h2 className="text-xl font-bold">Importando historia clínica…</h2>
                <p className="text-muted-foreground text-sm mt-1">
                  {procesadas.toLocaleString("es-AR")} de {progreso.totalRegistros.toLocaleString("es-AR")} registros procesados
                </p>
                <p className="text-muted-foreground text-xs mt-1">
                  Podés cerrar esta pestaña: la importación continúa en el servidor.
                </p>
              </div>

              <div className="max-w-2xl mx-auto space-y-2">
                <div className="h-3 w-full rounded-full bg-muted overflow-hidden">
                  <div
                    className="h-full bg-primary transition-all duration-500"
                    style={{ width: `${pct}%` }}
                  />
                </div>
                <div className="text-right text-xs font-medium text-muted-foreground">{pct}%</div>
              </div>

              <div className="grid grid-cols-2 md:grid-cols-4 gap-3 max-w-2xl mx-auto">
                {[
                  { label: "Creados", value: progreso.creados, cls: "text-green-700 bg-green-50 border-green-200" },
                  { label: "Actualizados", value: progreso.actualizados, cls: "text-blue-700 bg-blue-50 border-blue-200" },
                  { label: "Omitidos", value: progreso.omitidos, cls: "text-slate-600 bg-slate-50 border-slate-200" },
                  { label: "Errores", value: progreso.errores, cls: "text-red-700 bg-red-50 border-red-200" },
                ].map((k) => (
                  <div key={k.label} className={`border rounded-lg p-4 text-center ${k.cls}`}>
                    <div className="text-3xl font-bold">{k.value.toLocaleString("es-AR")}</div>
                    <div className="text-xs font-medium uppercase tracking-wide mt-1 opacity-80">{k.label}</div>
                  </div>
                ))}
              </div>
            </div>
          );
        })()
      )}

      {/* ── Step 4: Resultado ─────────────────────────────────────────────── */}
      {step === 4 && resultado && (
        <div className="space-y-6">
          <div className="text-center py-6">
            {resultado.errores === resultado.total ? (
              <AlertCircle className="w-16 h-16 text-red-500 mx-auto mb-3" />
            ) : (
              <CheckCircle2 className="w-16 h-16 text-green-500 mx-auto mb-3" />
            )}
            <h2 className="text-xl font-bold">
              {resultado.errores === resultado.total ? "Importación con errores" : "¡Importación completada!"}
            </h2>
            <p className="text-muted-foreground text-sm mt-1">
              {resultado.dryRun
                ? "Esto fue una simulación — no se escribió ningún dato"
                : `${resultado.creados + resultado.actualizados} registros procesados exitosamente`}
            </p>
          </div>

          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 max-w-2xl mx-auto">
            {[
              { label: "Creados", value: resultado.creados, cls: "text-green-700 bg-green-50 border-green-200" },
              { label: "Actualizados", value: resultado.actualizados, cls: "text-blue-700 bg-blue-50 border-blue-200" },
              { label: "Omitidos", value: resultado.omitidos, cls: "text-slate-600 bg-slate-50 border-slate-200" },
              { label: "Errores", value: resultado.errores, cls: "text-red-700 bg-red-50 border-red-200" },
            ].map((k) => (
              <div key={k.label} className={`border rounded-lg p-4 text-center ${k.cls}`}>
                <div className="text-3xl font-bold">{k.value.toLocaleString("es-AR")}</div>
                <div className="text-xs font-medium uppercase tracking-wide mt-1 opacity-80">{k.label}</div>
              </div>
            ))}
          </div>

          {auditoria.length > 0 && auditoriaJobId === uploadResult?.jobId && (
            <AuditoriaTable rows={auditoria} />
          )}

          <div className="flex justify-center gap-3">
            {!auditoria.length && uploadResult && (
              <Button variant="outline" onClick={() => void handleVerAuditoria(uploadResult.jobId)}>
                <History className="w-4 h-4 mr-1.5" /> Ver log de auditoría
              </Button>
            )}
            <Button variant="outline" onClick={resetWizard}>
              <RotateCcw className="w-4 h-4 mr-1.5" /> Nueva importación
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Sample table ──────────────────────────────────────────────────────────

function SampleTable({ registros }: { registros: RegistroSample[] }) {
  return (
    <div className="border rounded-lg overflow-hidden max-h-64 overflow-y-auto">
      <table className="w-full text-xs">
        <thead className="sticky top-0 bg-muted/80 backdrop-blur border-b">
          <tr>
            <th className="px-3 py-2 text-left font-medium text-muted-foreground w-14">Fila</th>
            <th className="px-3 py-2 text-left font-medium text-muted-foreground">Paciente</th>
            <th className="px-3 py-2 text-left font-medium text-muted-foreground w-28">DNI</th>
            <th className="px-3 py-2 text-left font-medium text-muted-foreground">Especialidad / Fecha</th>
            <th className="px-3 py-2 text-left font-medium text-muted-foreground w-24">Acción</th>
          </tr>
        </thead>
        <tbody className="divide-y">
          {registros.map((reg) => {
            const badge = ACCION_BADGE[reg.accion] ?? ACCION_BADGE.crear;
            return (
              <tr key={reg.fila} className="hover:bg-muted/20">
                <td className="px-3 py-2 font-mono text-muted-foreground">{reg.fila}</td>
                <td className="px-3 py-2 font-medium">
                  {[reg.datos.apellido, reg.datos.nombre].filter(Boolean).join(", ") || "—"}
                </td>
                <td className="px-3 py-2 text-muted-foreground font-mono">
                  {reg.datos.dni ? String(reg.datos.dni) : "—"}
                </td>
                <td className="px-3 py-2 text-muted-foreground">
                  {[reg.datos.especialidad, reg.datos.fechaTurno].filter(Boolean).join(" · ") || "—"}
                </td>
                <td className="px-3 py-2">
                  <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium border ${badge.cls}`}>
                    {badge.label}
                  </span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ── Auditoria table ───────────────────────────────────────────────────────

function AuditoriaTable({ rows }: { rows: AuditoriaRow[] }) {
  const accionStyle: Record<string, string> = {
    crear: "bg-green-100 text-green-700",
    actualizar: "bg-blue-100 text-blue-700",
    omitir: "bg-slate-100 text-slate-600",
    error: "bg-red-100 text-red-700",
  };

  return (
    <div className="border rounded-lg overflow-hidden">
      <div className="bg-muted/50 px-4 py-2 border-b text-xs font-medium text-muted-foreground flex items-center gap-2">
        <History className="w-4 h-4" /> Log de auditoría ({rows.length} registros)
      </div>
      <div className="max-h-[300px] overflow-y-auto">
        <table className="w-full text-xs">
          <thead className="sticky top-0 bg-muted/80 border-b">
            <tr>
              <th className="px-3 py-2 text-left font-medium text-muted-foreground w-12">Fila</th>
              <th className="px-3 py-2 text-left font-medium text-muted-foreground w-24">Acción</th>
              <th className="px-3 py-2 text-left font-medium text-muted-foreground w-16">ID</th>
              <th className="px-3 py-2 text-left font-medium text-muted-foreground">Detalle / Error</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {rows.map((row) => (
              <tr key={row.id} className={row.accion === "error" ? "bg-red-50/50" : ""}>
                <td className="px-3 py-1.5 font-mono text-muted-foreground">{row.fila}</td>
                <td className="px-3 py-1.5">
                  <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${accionStyle[row.accion] ?? ""}`}>
                    {row.accion}
                  </span>
                </td>
                <td className="px-3 py-1.5 text-muted-foreground">{row.entidadId ?? "—"}</td>
                <td className="px-3 py-1.5">
                  {row.mensajeError ? (
                    <span className="text-red-600">{row.mensajeError}</span>
                  ) : (
                    <span className="text-muted-foreground truncate block max-w-xs">
                      {Object.entries(row.datosOriginales ?? {}).slice(0, 3).map(([k, v]) => `${k}: ${String(v ?? "")}`).join(" · ")}
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── Historial view ────────────────────────────────────────────────────────

function HistorialView({
  historial, loaded, auditoria, auditoriaJobId,
  onBack, onVerAuditoria,
}: {
  historial: JobHistorial[];
  loaded: boolean;
  auditoria: AuditoriaRow[];
  auditoriaJobId: number | null;
  onBack: () => void;
  onVerAuditoria: (jobId: number) => Promise<void>;
}) {
  return (
    <div className="space-y-5 max-w-5xl mx-auto pb-10">
      <div className="flex items-center gap-3">
        <Button variant="ghost" onClick={onBack}>
          <ArrowLeft className="w-4 h-4 mr-1" /> Volver
        </Button>
        <h1 className="text-xl font-bold flex items-center gap-2">
          <History className="w-5 h-5 text-primary" /> Historial de importaciones
        </h1>
      </div>

      {!loaded ? (
        <div className="text-muted-foreground text-center py-12">Cargando...</div>
      ) : historial.length === 0 ? (
        <div className="text-muted-foreground text-center py-12">
          <History className="w-12 h-12 mx-auto mb-3 opacity-20" />
          <p>No hay importaciones anteriores</p>
        </div>
      ) : (
        <div className="space-y-3">
          {historial.map((job) => {
            const Icon = ENTIDAD_ICON[job.tipoEntidad] ?? Upload;
            const estado = ESTADO_JOB[job.estado] ?? { label: job.estado, cls: "bg-muted text-muted-foreground" };
            return (
              <div key={job.id} className="border rounded-lg p-4 bg-card space-y-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex items-start gap-3">
                    <div className="w-9 h-9 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
                      <Icon className="w-5 h-5 text-primary" />
                    </div>
                    <div>
                      <div className="font-medium text-sm leading-tight">{job.nombre}</div>
                      <div className="text-xs text-muted-foreground mt-0.5 flex items-center gap-2">
                        <span>{job.tipoEntidad}</span>
                        <span>·</span>
                        <span>{job.formato.toUpperCase()}</span>
                        <span>·</span>
                        <span>{format(new Date(job.createdAt), "d MMM yyyy, HH:mm", { locale: es })}</span>
                        <span>·</span>
                        <span>{job.totalRegistros.toLocaleString("es-AR")} registros</span>
                      </div>
                    </div>
                  </div>
                  <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${estado.cls}`}>
                    {estado.label}
                  </span>
                </div>

                {job.estado === "completado" && (
                  <div className="flex gap-4 text-sm">
                    <span className="text-green-700 font-medium">{job.creados.toLocaleString("es-AR")} creados</span>
                    <span className="text-blue-700 font-medium">{job.actualizados.toLocaleString("es-AR")} actualizados</span>
                    <span className="text-slate-500">{job.omitidos.toLocaleString("es-AR")} omitidos</span>
                    {job.errores > 0 && <span className="text-red-600 font-medium">{job.errores.toLocaleString("es-AR")} errores</span>}
                  </div>
                )}

                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => void onVerAuditoria(job.id)}
                >
                  <History className="w-3.5 h-3.5 mr-1.5" /> Ver auditoría
                </Button>

                {auditoriaJobId === job.id && auditoria.length > 0 && (
                  <AuditoriaTable rows={auditoria} />
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
