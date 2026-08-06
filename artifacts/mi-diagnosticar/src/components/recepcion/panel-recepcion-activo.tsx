import { useRef, useState, useMemo, useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useGetRecepcionFicha,
  getGetRecepcionFichaQueryKey,
  useGetIngresoConsulta,
  useGetSupervisorTotp,
  getGetIngresoConsultaQueryKey,
  useGuardarIngresoConsulta,
  useValidarTokenTurno,
  useAdmitirTurno,
  useDeclararPrestacionCargada,
  useEnviarTokenARevision,
  useGetRobotKlinicosEstado,
  useGetTokenAuditoria,
  useListKlinicosPracticas,
  useUpdatePaciente,
  useUpsertDocumentacionRecepcion,
  type TokenValidacionResultado,
  type DocumentacionItem,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { getEstadoMacro, ESTADO_MACRO_META, CHECK_IN_META } from "@/lib/episodio";
import {
  CheckCircle2, XCircle, AlertTriangle, KeyRound, Loader2, Upload,
  ShieldCheck, LogIn, User, Clock, ChevronDown, ChevronUp, FileText, ClipboardList,
  Stethoscope, ExternalLink,
} from "lucide-react";
import { evaluarChecklistKlinicos, ChecklistKlinicos, type ResultadoChecklist } from "./checklist-klinicos";
import { SelectorEstudiosTurno } from "@/components/recepcion/selector-estudios-turno";
import { TimelineEstudios } from "@/components/estudios/timeline-estudios";

function archivoABase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const res = String(reader.result ?? "");
      resolve(res.includes(",") ? res.split(",")[1] : res);
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

function SeccionHeader({
  titulo,
  subtitulo,
  expandido,
  onToggle,
  badge,
}: {
  titulo: string;
  subtitulo?: string;
  expandido: boolean;
  onToggle: () => void;
  badge?: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      className="w-full flex items-center justify-between gap-2 py-1.5 text-left hover:text-foreground transition-colors group"
    >
      <div className="flex items-center gap-2 min-w-0">
        <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground group-hover:text-foreground transition-colors">
          {titulo}
        </span>
        {subtitulo && <span className="text-xs text-muted-foreground truncate">{subtitulo}</span>}
        {badge}
      </div>
      {expandido ? (
        <ChevronUp className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
      ) : (
        <ChevronDown className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
      )}
    </button>
  );
}

type DocTipo = "dni" | "credencial" | "orden_medica" | "autorizacion";
const DOCS_CONFIG: { tipo: DocTipo; label: string }[] = [
  { tipo: "orden_medica", label: "Orden médica" },
];

function DocItem({
  pacienteId,
  turnoId,
  tipo,
  label,
  item,
  onChanged,
}: {
  pacienteId: number;
  turnoId: number;
  tipo: DocTipo;
  label: string;
  item?: DocumentacionItem;
  onChanged: () => void;
}) {
  const { toast } = useToast();
  const inputRef = useRef<HTMLInputElement>(null);
  const upsert = useUpsertDocumentacionRecepcion({
    mutation: {
      onSuccess: () => onChanged(),
      onError: () =>
        toast({ title: "Error", description: `No se pudo actualizar ${label}`, variant: "destructive" }),
    },
  });
  const estado = item?.estado ?? "pendiente";
  const validado = estado === "validada";

  const subir = async (file: File) => {
    if (file.size > 5 * 1024 * 1024) {
      toast({ title: "Archivo muy grande", description: "Máximo 5 MB", variant: "destructive" });
      return;
    }
    const data = await archivoABase64(file);
    upsert.mutate({ id: pacienteId, tipo, data: { estado: validado ? "validada" : "pendiente", turnoId, archivoNombre: file.name, archivoMime: file.type || "application/octet-stream", archivoData: data } });
  };

  return (
    <div className="flex items-center gap-2 py-1.5 border-b last:border-0">
      <input ref={inputRef} type="file" className="hidden" accept="image/*,.pdf"
        onChange={(e) => { const f = e.target.files?.[0]; if (f) void subir(f); e.target.value = ""; }} />
      <div className="flex-1 min-w-0">
        <div className="text-sm">{label}</div>
        <div className="text-xs text-muted-foreground">
          {validado ? "Validada" : estado === "no_aplica" ? "No aplica" : "Pendiente"}
          {item?.tieneArchivo && item.archivoNombre ? ` · ${item.archivoNombre}` : ""}
        </div>
      </div>
      {upsert.isPending ? (
        <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />
      ) : validado ? (
        <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" />
      ) : (
        <Button size="sm" variant="outline" className="h-7 text-xs"
          onClick={() => upsert.mutate({ id: pacienteId, tipo, data: { estado: "validada", turnoId } })}>
          <ShieldCheck className="w-3 h-3 mr-1" /> Validar
        </Button>
      )}
      <Button size="sm" variant="ghost" className="h-7 w-7 p-0" title={`Subir ${label}`}
        onClick={() => inputRef.current?.click()} disabled={upsert.isPending}>
        <Upload className="w-3.5 h-3.5" />
      </Button>
    </div>
  );
}

function ResultadoTokenBanner({
  resultado,
  turnoId,
  tokenInput,
  onReintentar,
  onPrestacionCargada,
  onEnviarRevision,
  onCargarAfiliado,
  robot,
}: {
  resultado: TokenValidacionResultado;
  turnoId: number;
  tokenInput: string;
  onReintentar: () => void;
  onPrestacionCargada: () => void;
  onEnviarRevision: () => void;
  onCargarAfiliado?: () => void;
  robot: { klinicosUrl?: string | null } | null | undefined;
}) {
  const [verAuditoria, setVerAuditoria] = useState(false);
  const { data: auditoria } = useGetTokenAuditoria(turnoId, { query: { enabled: verAuditoria } });

  if (resultado.estado === "TOKEN_ACCEPTED") return null;

  const esManual = resultado.estado === "MANUAL_PRESTATION_REQUIRED";
  const faltaAfiliado = (resultado.camposFaltantes ?? []).includes("affiliate_number");
  const esError = resultado.reintentable;

  return (
    <div className={`rounded-lg p-3 space-y-2 border text-sm ${
      esManual ? "bg-amber-50 border-amber-200 text-amber-900 dark:bg-amber-950/30 dark:border-amber-800 dark:text-amber-100" :
      esError ? "bg-amber-50 border-amber-200 text-amber-800 dark:bg-amber-950/30 dark:border-amber-800" :
      "bg-red-50 border-red-200 text-red-800 dark:bg-red-950/30 dark:border-red-800"
    }`}>
      <div className="flex items-start gap-2">
        <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
        <div className="flex-1 min-w-0">
          {faltaAfiliado ? (
            <p className="font-medium" data-testid="banner-afiliado-faltante">
              Falta el número de afiliado: la validación no se envió. Cargalo en los datos del paciente y reintentá.
            </p>
          ) : esManual ? (
            <p className="font-medium">Prestación no disponible en Klinicos</p>
          ) : esError ? (
            <p>Error técnico — la cobertura no rechazó la consulta. Podés reintentar.</p>
          ) : (
            <p className="font-medium">Token rechazado: {resultado.mensaje}</p>
          )}
        </div>
      </div>

      {esManual && (
        <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-xs">
          {([
            ["Paciente", resultado.contexto?.paciente],
            ["DNI", resultado.contexto?.dni],
            ["Afiliado", resultado.contexto?.afiliado],
            ["Práctica", resultado.contexto?.practica],
            ["Profesional", resultado.contexto?.profesional],
            ["Especialidad", resultado.contexto?.especialidad],
          ] as const).map(([label, valor]) => valor ? (
            <div key={label} className="flex gap-1">
              <dt className="text-amber-700 shrink-0">{label}:</dt>
              <dd className="truncate font-medium">{valor}</dd>
            </div>
          ) : null)}
        </div>
      )}

      <div className="flex flex-wrap gap-1.5 pt-1">
        {faltaAfiliado && onCargarAfiliado && (
          <Button size="sm" variant="outline" className="h-7 text-xs" onClick={onCargarAfiliado}
            data-testid="banner-cargar-afiliado">
            Cargar afiliado
          </Button>
        )}
        {esManual && robot?.klinicosUrl && (
          <Button size="sm" variant="outline" className="h-7 text-xs"
            onClick={() => window.open(robot.klinicosUrl!, "_blank", "noopener,noreferrer")}>
            <ExternalLink className="w-3 h-3 mr-1" /> Abrir Klinicos
          </Button>
        )}
        {esManual && (
          <Button size="sm" variant="outline" className="h-7 text-xs" onClick={onPrestacionCargada}>
            Prestación cargada
          </Button>
        )}
        {(esError || esManual) && (
          <Button size="sm" className="h-7 text-xs" disabled={!tokenInput.trim()} onClick={onReintentar}>
            Reintentar validación
          </Button>
        )}
        {esManual && (
          <Button size="sm" variant="outline" className="h-7 text-xs" onClick={onEnviarRevision}>
            Enviar a revisión
          </Button>
        )}
        <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => setVerAuditoria(v => !v)}>
          Auditoría
        </Button>
      </div>

      {verAuditoria && (
        <ul className="space-y-0.5 max-h-32 overflow-y-auto border-t pt-2 text-xs">
          {(auditoria?.entradas ?? []).map((e, i) => (
            <li key={i} className="flex flex-wrap gap-x-2">
              <span className="tabular-nums shrink-0">
                {e.fecha ? new Date(e.fecha).toLocaleString("es-AR") : "—"}
              </span>
              <span className="font-medium">{e.descripcion}</span>
              {e.latenciaMs != null && <span>{e.latenciaMs} ms</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function PanelRecepcionActivo({
  turnoId,
  onCambio,
  onCheckIn,
  onTokenValidado,
}: {
  turnoId: number;
  onCambio?: () => void;
  onCheckIn?: () => void;
  // Se llama cuando el token fue aceptado, para volver a la pantalla anterior.
  onTokenValidado?: () => void;
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const { data: ficha, isLoading: cargandoFicha } = useGetRecepcionFicha(turnoId, {
    query: { enabled: turnoId > 0, refetchInterval: 20_000 },
  });
  const { data: ingreso, isLoading: cargandoIngreso } = useGetIngresoConsulta(turnoId, {
    query: { enabled: turnoId > 0, refetchInterval: 20_000 },
  });
  const { data: robot } = useGetRobotKlinicosEstado(undefined, { query: { refetchInterval: 30_000 } });
  const { data: practicas } = useListKlinicosPracticas();

  const [expandido, setExpandido] = useState<Record<string, boolean>>({
    ingreso: true,
    documentacion: true,
    token: true,
    estudios: false,
  });
  const toggle = (key: string) => setExpandido(e => ({ ...e, [key]: !e[key] }));

  const [formIngreso, setFormIngreso] = useState<{
    especialidad: string;
    profesional: string;
    motivo: string;
    practicaIds: number[];
  } | null>(null);
  const [editandoPaciente, setEditandoPaciente] = useState(false);
  const [formPaciente, setFormPaciente] = useState<{ nroAfiliado: string; cobertura: string }>({ nroAfiliado: "", cobertura: "" });
  const [tokenInput, setTokenInput] = useState("");
  const [ultimoResultado, setUltimoResultado] = useState<TokenValidacionResultado | null>(null);
  // Antes del check-in hay que resolver el token: cargarlo (confirmar) o
  // declinar explícitamente ("continuar sin token"). Se resetea por turno.
  const [tokenDeclinado, setTokenDeclinado] = useState(false);
  const [codigoSupervisor, setCodigoSupervisor] = useState("");
  // Tilde "token por Klinicos": el token ya se cargó directamente en Klinicos.
  // El paciente pasa sin código de supervisor y queda pintado en amarillo clarito.
  const [tokenPorKlinicos, setTokenPorKlinicos] = useState(false);
  useEffect(() => {
    setTokenDeclinado(false);
    setCodigoSupervisor("");
    setTokenPorKlinicos(false);
  }, [turnoId]);

  const invalidar = () => {
    void queryClient.invalidateQueries({ queryKey: getGetRecepcionFichaQueryKey(turnoId) });
    void queryClient.invalidateQueries({ queryKey: getGetIngresoConsultaQueryKey(turnoId) });
    onCambio?.();
  };

  const guardarIngreso = useGuardarIngresoConsulta({
    mutation: {
      onSuccess: (_data, vars) => {
        const conToken = vars.data.token !== undefined;
        toast({ title: conToken ? "Token guardado" : "Ingreso guardado" });
        setFormIngreso(null);
        invalidar();
      },
      onError: () => toast({ title: "Error al guardar ingreso", variant: "destructive" }),
    },
  });

  const validarToken = useValidarTokenTurno({
    mutation: {
      onSuccess: (resultado) => {
        setUltimoResultado(resultado);
        if (resultado.estado === "TOKEN_ACCEPTED") {
          if (resultado.nroBono) {
            toast({ title: "✅ Autorizado en Klinicos", description: `N° de Bono ${resultado.nroBono}. Podés hacer el check-in.` });
          } else {
            toast({
              title: "Token aceptado — SIN bono",
              description: resultado.autorizacionDetalle ?? "No quedó autorizado en Klinicos. Verificá a mano.",
              variant: "destructive",
            });
          }
          setTokenInput("");
          invalidar();
          onTokenValidado?.();
        }
      },
      onError: () => {
        setUltimoResultado({ estado: "TECHNICAL_ERROR", mensaje: "No fue posible contactar al servidor", reintentable: true });
      },
    },
  });

  const admitir = useAdmitirTurno({
    mutation: {
      onSuccess: () => {
        toast({ title: "✅ Paciente en sala de espera" });
        invalidar();
        onCheckIn?.();
      },
      onError: (err: unknown) => {
        const e = (err as { data?: { codigo?: string; error?: string } })?.data ?? {};
        if (e?.codigo === "codigo_supervisor_requerido" || e?.codigo === "codigo_supervisor_invalido") {
          toast({ title: e.error ?? "Código de supervisor requerido", variant: "destructive" });
        } else {
          toast({ title: "Error al hacer el check-in", variant: "destructive" });
        }
      },
    },
  });

  const declararPrestacion = useDeclararPrestacionCargada({
    mutation: { onSuccess: () => toast({ title: "Declaración registrada" }), onError: () => toast({ title: "Error", variant: "destructive" }) },
  });
  const enviarRevision = useEnviarTokenARevision({
    mutation: {
      onSuccess: () => { toast({ title: "Enviado a revisión" }); setUltimoResultado(null); },
      onError: () => toast({ title: "Error", variant: "destructive" }),
    },
  });
  const actualizarPaciente = useUpdatePaciente({
    mutation: {
      onSuccess: () => { toast({ title: "Datos del paciente actualizados" }); setEditandoPaciente(false); invalidar(); },
      onError: () => toast({ title: "Error al actualizar paciente", variant: "destructive" }),
    },
  });

  // Si el admin configuró el código de supervisor (TOTP), recepcionar una
  // consulta sin token validado exige ese código de 6 dígitos.
  const { data: totpEstado } = useGetSupervisorTotp();

  if (cargandoFicha || cargandoIngreso) {
    return (
      <div className="p-5 space-y-3">
        <Skeleton className="h-20 rounded-xl" />
        <Skeleton className="h-40 rounded-xl" />
        <Skeleton className="h-32 rounded-xl" />
      </div>
    );
  }

  if (!ficha) {
    return (
      <div className="flex items-center justify-center h-full text-muted-foreground p-10 text-sm">
        No se pudo cargar la ficha del turno.
      </div>
    );
  }

  const { turno, paciente, documentacion, semaforo } = ficha;
  const estadoMacro = getEstadoMacro(turno.estado);
  const estadoMeta =
    ficha.checkInPrevio && estadoMacro === "agendado" ? CHECK_IN_META : ESTADO_MACRO_META[estadoMacro];
  const practicasActivas = (practicas ?? []).filter(p => p.activo !== false);

  const valoresIngreso = formIngreso ?? {
    especialidad: ingreso?.especialidad ?? ficha.especialidad ?? "",
    profesional: ingreso?.profesional ?? ficha.profesionalNombre ?? "",
    motivo: ingreso?.motivo ?? "",
    // Todos los estudios del turno; fallback al singular legado
    practicaIds:
      ingreso?.practicas && ingreso.practicas.length > 0
        ? ingreso.practicas.map((p) => p.id)
        : ingreso?.practicaId != null
          ? [ingreso.practicaId]
          : [],
  };

  const checklist: ResultadoChecklist = evaluarChecklistKlinicos({
    esConsulta: ingreso?.esConsulta ?? true,
    dni: paciente.dni,
    cobertura: turno.cobertura ?? paciente.cobertura,
    nroAfiliado: turno.nroAfiliado ?? paciente.nroAfiliado,
    especialidad: valoresIngreso.especialidad,
    profesional: valoresIngreso.profesional,
    motivo: valoresIngreso.motivo,
    ingresoGuardado: ingreso?.guardado,
    practicaId: valoresIngreso.practicaIds[0] ?? null,
    practicasNombres: practicasActivas
      .filter(p => valoresIngreso.practicaIds.includes(p.id))
      .map(p => p.nombre),
  });

  const validacionHabilitada = robot?.validacionHabilitada ?? false;
  // Regla única de verdad (2-ago-2026): con validación en vivo, "aceptado"
  // SOLO si el backend persistió TOKEN_ACCEPTED con N° de bono. Un token
  // guardado sin bono NO habilita la consulta (queda pendiente/no confirmado).
  const tokenYaAceptado = validacionHabilitada
    ? Boolean(ingreso?.token && ingreso?.tokenEstado === "ACCEPTED" && ingreso?.nroBono)
    : Boolean(ingreso?.token);
  const tokenNoConfirmado = Boolean(validacionHabilitada && ingreso?.token && !tokenYaAceptado);
  const tokenRechazado = Boolean(validacionHabilitada && ingreso?.token && ingreso?.tokenEstado === "DENIED");
  const requiereCodigoSupervisor = Boolean(
    totpEstado?.configurado && (ingreso?.esConsulta ?? true) && !tokenYaAceptado && tokenDeclinado,
  );
  const puedeCheckIn = ["pendiente", "reservado", "confirmado", "publicado", "ausente"].includes(turno.estado);
  const checkInEnProceso = admitir.isPending;
  const docsOk = semaforo?.color !== "rojo";

  // ¿La selección local difiere de lo guardado en el turno?
  const idsGuardados =
    ingreso?.practicas && ingreso.practicas.length > 0
      ? ingreso.practicas.map((p) => p.id)
      : ingreso?.practicaId != null
        ? [ingreso.practicaId]
        : [];
  const estudiosCambiados =
    valoresIngreso.practicaIds.length !== idsGuardados.length ||
    valoresIngreso.practicaIds.some((id) => !idsGuardados.includes(id));

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* ── Header: identidad del paciente ── */}
      <div className="px-3 py-2 border-b bg-muted/30 shrink-0">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h2 className="text-base font-semibold truncate">
                {paciente.apellido}, {paciente.nombre}
              </h2>
              <span className={`inline-flex items-center gap-1 text-xs font-medium px-2 py-0.5 rounded-full border ${estadoMeta.bg} ${estadoMeta.color} ${estadoMeta.border}`}>
                <span className={`w-1.5 h-1.5 rounded-full ${estadoMeta.dot}`} />
                {estadoMeta.label}
              </span>
            </div>
            <div className="flex items-center gap-3 mt-1 text-sm text-muted-foreground flex-wrap">
              {paciente.dni && <span>DNI {paciente.dni}</span>}
              {ficha.edad != null && <span>{ficha.edad} años</span>}
              {paciente.telefono && <span>{paciente.telefono}</span>}
            </div>
            {/* Cobertura inline */}
            {!editandoPaciente ? (
              <div className="flex items-center gap-2 mt-1.5 flex-wrap">
                {(turno.cobertura ?? paciente.cobertura) ? (
                  <Badge variant="outline" className="text-xs">
                    {turno.cobertura ?? paciente.cobertura}
                    {(turno.nroAfiliado ?? paciente.nroAfiliado) && ` · ${turno.nroAfiliado ?? paciente.nroAfiliado}`}
                  </Badge>
                ) : (
                  <Badge variant="outline" className="text-xs border-red-300 text-red-600">Sin cobertura</Badge>
                )}
                <button
                  type="button"
                  className="text-xs text-muted-foreground underline underline-offset-2"
                  onClick={() => {
                    setFormPaciente({
                      nroAfiliado: paciente.nroAfiliado ?? "",
                      cobertura: paciente.cobertura ?? "",
                    });
                    setEditandoPaciente(true);
                  }}
                >
                  Editar
                </button>
              </div>
            ) : (
              <div className="flex items-center gap-2 mt-1.5 flex-wrap">
                <Input
                  className="h-7 w-32 text-xs px-2"
                  placeholder="Cobertura"
                  value={formPaciente.cobertura}
                  onChange={e => setFormPaciente(f => ({ ...f, cobertura: e.target.value }))}
                />
                <Input
                  className="h-7 w-32 text-xs px-2"
                  placeholder="Nro. afiliado"
                  value={formPaciente.nroAfiliado}
                  onChange={e => setFormPaciente(f => ({ ...f, nroAfiliado: e.target.value }))}
                />
                <Button size="sm" className="h-7 text-xs"
                  disabled={actualizarPaciente.isPending}
                  onClick={() => actualizarPaciente.mutate({ id: paciente.id, data: { nroAfiliado: formPaciente.nroAfiliado, cobertura: formPaciente.cobertura } })}>
                  Guardar
                </Button>
                <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => setEditandoPaciente(false)}>
                  Cancelar
                </Button>
              </div>
            )}
          </div>
        </div>

        {/* Datos del turno */}
        <div className="mt-1.5 grid grid-cols-2 gap-x-4 gap-y-0.5 text-xs">
          <div className="flex gap-1.5">
            <Clock className="w-3.5 h-3.5 text-muted-foreground mt-0.5 shrink-0" />
            <span className="font-medium">{turno.horaInicio}{turno.horaFin ? `–${turno.horaFin}` : ""}</span>
          </div>
          {ficha.profesionalNombre && (
            <div className="flex gap-1.5">
              <Stethoscope className="w-3.5 h-3.5 text-muted-foreground mt-0.5 shrink-0" />
              <span className="truncate">{ficha.profesionalNombre}</span>
            </div>
          )}
          {ficha.especialidad && (
            <div className="text-muted-foreground col-span-2 truncate">{ficha.especialidad}</div>
          )}
          {ficha.sedeNombre && (
            <div className="text-muted-foreground col-span-2 truncate">{ficha.sedeNombre}</div>
          )}
          {ficha.nroBono && (
            <div className="col-span-2">
              <span
                className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0 rounded-full border border-emerald-300 dark:border-emerald-800 bg-emerald-50 dark:bg-emerald-900/30 text-emerald-800 dark:text-emerald-200 font-medium"
                data-testid="ficha-nro-bono"
              >
                <CheckCircle2 className="w-3 h-3" /> N° de Bono {ficha.nroBono}
              </span>
            </div>
          )}
          {turno.sobreturn && (
            <Badge variant="outline" className="text-[10px] border-amber-300 text-amber-700 w-fit">Sobreturno</Badge>
          )}
        </div>
      </div>

      {/* ── Contenido scrollable ── */}
      <div className="flex-1 overflow-y-auto">
        <div className="px-3 py-1 space-y-0 divide-y">

          {/* ── Sección: Checklist Klinicos ── */}
          <div>
            <SeccionHeader
              titulo="Datos mínimos Klinicos"
              subtitulo={checklist.todoOk ? "Completos" : `${checklist.faltantes.length} pendiente${checklist.faltantes.length > 1 ? "s" : ""}`}
              expandido={expandido.checklist ?? true}
              onToggle={() => toggle("checklist")}
              badge={
                <span className={`inline-flex items-center gap-1 text-[10px] px-1.5 py-0 rounded-full border ${
                  checklist.todoOk
                    ? "border-emerald-300 text-emerald-700 bg-emerald-50"
                    : "border-red-300 text-red-700 bg-red-50"
                }`}>
                  {checklist.todoOk ? <CheckCircle2 className="w-3 h-3" /> : <XCircle className="w-3 h-3" />}
                  {checklist.todoOk ? "OK" : "Incompleto"}
                </span>
              }
            />
            {expandido.checklist && (
              <div className="pb-2.5">
                <ChecklistKlinicos resultado={checklist} />
                {!checklist.todoOk && (
                  <p className="text-xs text-muted-foreground mt-2">
                    Completá los datos marcados antes de solicitar la validación del token.
                  </p>
                )}
              </div>
            )}
          </div>

          {/* ── Sección: Estudios del turno ── */}
          <div>
            <SeccionHeader
              titulo="Estudios del turno"
              subtitulo={
                idsGuardados.length > 0
                  ? `${idsGuardados.length} cargado${idsGuardados.length > 1 ? "s" : ""}`
                  : "Sin estudios"
              }
              expandido={expandido.estudiosTurno ?? false}
              onToggle={() => toggle("estudiosTurno")}
              badge={
                idsGuardados.length > 0 ? (
                  <span className="inline-flex items-center text-[10px] px-1.5 py-0 rounded-full border border-sky-300 text-sky-700 bg-sky-50">
                    {idsGuardados.length}
                  </span>
                ) : null
              }
            />
            {expandido.estudiosTurno && (
              <div className="pb-2.5 space-y-2">
                <SelectorEstudiosTurno
                  practicas={practicasActivas}
                  seleccionadas={valoresIngreso.practicaIds}
                  onChange={(ids) => setFormIngreso({ ...valoresIngreso, practicaIds: ids })}
                  disabled={guardarIngreso.isPending}
                />
                {estudiosCambiados && (
                  <Button
                    size="sm"
                    className="h-8"
                    disabled={guardarIngreso.isPending}
                    onClick={() =>
                      guardarIngreso.mutate({
                        id: turnoId,
                        data: { practicaIds: valoresIngreso.practicaIds },
                      })
                    }
                    data-testid="boton-guardar-estudios"
                  >
                    {guardarIngreso.isPending && <Loader2 className="w-3.5 h-3.5 mr-1 animate-spin" />}
                    Guardar estudios
                  </Button>
                )}
              </div>
            )}
          </div>

          {/* ── Sección: Documentación ── */}
          <div>
            <SeccionHeader
              titulo="Documentación"
              subtitulo={docsOk ? "En orden" : "Pendiente"}
              expandido={expandido.documentacion ?? true}
              onToggle={() => toggle("documentacion")}
              badge={
                semaforo ? (
                  <span className={`inline-block w-2.5 h-2.5 rounded-full ${
                    semaforo.color === "verde" ? "bg-emerald-500" :
                    semaforo.color === "amarillo" ? "bg-amber-500" : "bg-red-500"
                  }`} />
                ) : null
              }
            />
            {expandido.documentacion && (
              <div className="pb-2.5">
                {DOCS_CONFIG.map(({ tipo, label }) => {
                  const item = documentacion?.find((d: DocumentacionItem) => d.tipo === tipo);
                  return (
                    <DocItem
                      key={tipo}
                      pacienteId={paciente.id}
                      turnoId={turnoId}
                      tipo={tipo}
                      label={label}
                      item={item}
                      onChanged={invalidar}
                    />
                  );
                })}
              </div>
            )}
          </div>

          {/* ── Sección: Token Klinicos ── */}
          <div>
            <SeccionHeader
              titulo="Token Klinicos"
              subtitulo={
                tokenYaAceptado
                  ? "Aceptado"
                  : tokenRechazado
                    ? "Rechazado"
                    : tokenNoConfirmado
                      ? "No confirmado"
                      : "Pendiente"
              }
              expandido={expandido.token ?? true}
              onToggle={() => toggle("token")}
              badge={
                tokenYaAceptado ? (
                  <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600" />
                ) : null
              }
            />
            {expandido.token && (
              <div className="pb-2.5 space-y-2">
                {tokenYaAceptado ? (
                  <div className="flex items-center gap-2 text-sm text-emerald-700 dark:text-emerald-400">
                    <CheckCircle2 className="w-4 h-4 shrink-0" />
                    <span>
                      {validacionHabilitada
                        ? `Token validado. Consulta habilitada. · N° de Bono ${ingreso?.nroBono}`
                        : "Token registrado."}{" "}
                      <span className="text-muted-foreground">·</span>{" "}
                      {ingreso?.token}
                    </span>
                  </div>
                ) : tokenRechazado ? (
                  <div className="text-sm rounded-md border border-red-300 bg-red-50 dark:bg-red-950/40 text-red-800 dark:text-red-200 p-2" data-testid="token-rechazado-panel">
                    🔴 <span className="font-medium">TOKEN RECHAZADO</span> — IOMA no autorizó la prestación.
                  </div>
                ) : tokenNoConfirmado ? (
                  <div className="text-sm rounded-md border border-amber-300 bg-amber-50 dark:bg-amber-950/40 text-amber-800 dark:text-amber-200 p-2" data-testid="token-no-confirmado-panel">
                    🟡 <span className="font-medium">VALIDACIÓN NO CONFIRMADA</span> — No fue posible confirmar la
                    autorización de IOMA. La consulta todavía no está habilitada.
                  </div>
                ) : !checklist.todoOk ? (
                  <div className="flex items-start gap-2 text-sm text-muted-foreground p-3 rounded-lg bg-muted/50 border border-dashed">
                    <XCircle className="w-4 h-4 mt-0.5 text-red-400 shrink-0" />
                    <span>
                      Completá los datos mínimos Klinicos antes de validar el token.
                      <br />
                      <span className="text-xs">Falta: {checklist.faltantes.join(", ")}</span>
                    </span>
                  </div>
                ) : (
                  <>
                    {validacionHabilitada && (
                      <div className="flex flex-col gap-0.5 text-xs text-muted-foreground">
                        <div className="flex items-center gap-2">
                          <span className={`inline-block w-2 h-2 rounded-full ${robot?.disponible ? "bg-emerald-500" : "bg-red-500"}`} />
                          Robot {robot?.disponible ? "disponible" : "no disponible"}
                          {" · "}Sesión: {robot?.sesionKlinicos ?? "desconocida"}
                        </div>
                        {!robot?.disponible && robot?.motivo && (
                          <span className="text-red-600 dark:text-red-400 pl-4" data-testid="text-robot-motivo">
                            {robot.motivo}
                          </span>
                        )}
                      </div>
                    )}
                    <div className="flex gap-2">
                      <Input
                        className="h-8 text-sm font-mono"
                        placeholder="Token del paciente"
                        value={tokenInput}
                        onChange={e => { setTokenInput(e.target.value); setUltimoResultado(null); }}
                        onKeyDown={e => {
                          if (e.key === "Enter" && tokenInput.trim() && !validarToken.isPending) {
                            if (validacionHabilitada) {
                              validarToken.mutate({ id: turnoId, data: { token: tokenInput.trim() } });
                            } else {
                              guardarIngreso.mutate({ id: turnoId, data: { token: tokenInput.trim() } });
                            }
                          }
                        }}
                        disabled={validarToken.isPending || guardarIngreso.isPending}
                      />
                      <Button
                        size="sm"
                        className="shrink-0 h-8"
                        disabled={!tokenInput.trim() || validarToken.isPending || guardarIngreso.isPending}
                        onClick={() => {
                          if (validacionHabilitada) {
                            validarToken.mutate({ id: turnoId, data: { token: tokenInput.trim() } });
                          } else {
                            guardarIngreso.mutate({ id: turnoId, data: { token: tokenInput.trim() } });
                          }
                        }}
                      >
                        {(validarToken.isPending || guardarIngreso.isPending) ? (
                          <Loader2 className="w-4 h-4 animate-spin" />
                        ) : (
                          <ShieldCheck className="w-4 h-4" />
                        )}
                        <span className="ml-1.5">
                          {validacionHabilitada
                            ? validarToken.isPending ? "Validando…" : "Validar"
                            : "Guardar token"}
                        </span>
                      </Button>
                    </div>
                    {!validacionHabilitada && (
                      <p className="text-xs text-muted-foreground">
                        Validación automática con Klinicos no habilitada. El token se guardará con la orden.
                      </p>
                    )}
                    {ultimoResultado && (
                      <ResultadoTokenBanner
                        resultado={ultimoResultado}
                        turnoId={turnoId}
                        tokenInput={tokenInput}
                        onReintentar={() => validarToken.mutate({ id: turnoId, data: { token: tokenInput.trim() } })}
                        onPrestacionCargada={() => declararPrestacion.mutate({ id: turnoId })}
                        onEnviarRevision={() => enviarRevision.mutate({ id: turnoId })}
                        onCargarAfiliado={() => {
                          setFormPaciente({
                            nroAfiliado: paciente.nroAfiliado ?? "",
                            cobertura: paciente.cobertura ?? "",
                          });
                          setEditandoPaciente(true);
                        }}
                        robot={robot}
                      />
                    )}
                  </>
                )}
                {!tokenYaAceptado && (
                  <label className="flex items-center gap-2 text-sm cursor-pointer select-none">
                    <input
                      type="checkbox"
                      className="h-4 w-4 accent-amber-600"
                      checked={tokenDeclinado}
                      onChange={e => setTokenDeclinado(e.target.checked)}
                      data-testid="check-continuar-sin-token"
                    />
                    <span className={tokenDeclinado ? "text-amber-700 dark:text-amber-400 font-medium" : "text-muted-foreground"}>
                      Continuar sin token (el paciente no lo presenta)
                    </span>
                  </label>
                )}
                {requiereCodigoSupervisor && (
                  <div className="space-y-1 pl-6" data-testid="bloque-codigo-supervisor">
                    <p className="text-xs text-amber-700 dark:text-amber-400">
                      Requiere autorización: pedile el código al supervisor (app authenticator).
                    </p>
                    <Input
                      value={codigoSupervisor}
                      onChange={e => setCodigoSupervisor(e.target.value.replace(/\D/g, "").slice(0, 6))}
                      inputMode="numeric"
                      placeholder="Código de 6 dígitos"
                      className="h-9 w-44 font-mono tracking-widest"
                      data-testid="input-codigo-supervisor"
                    />
                  </div>
                )}
              </div>
            )}
          </div>

          {/* ── Sección: Estudios previos ── */}
          <div>
            <SeccionHeader
              titulo="Estudios previos"
              subtitulo="Historial clínico"
              expandido={expandido.estudios ?? false}
              onToggle={() => toggle("estudios")}
            />
            {expandido.estudios && (
              <div className="pb-2.5">
                <TimelineEstudios pacienteId={paciente.id} limit={6} />
              </div>
            )}
          </div>
        </div>
      </div>

      {/* ── Footer: CHECK-IN ── */}
      <div className="px-3 py-2 border-t bg-background shrink-0">
        {puedeCheckIn ? (
          <div className="space-y-1.5">
            {!tokenYaAceptado && (
              <label className="flex items-center gap-2 text-xs text-muted-foreground justify-center cursor-pointer select-none">
                <input
                  type="checkbox"
                  className="h-3.5 w-3.5 accent-yellow-500"
                  checked={tokenPorKlinicos}
                  onChange={(e) => setTokenPorKlinicos(e.target.checked)}
                  data-testid="tilde-token-klinicos"
                />
                Token cargado por Klinicos (el paciente pasa pintado en amarillo)
              </label>
            )}
            {!tokenYaAceptado && !tokenDeclinado && !tokenPorKlinicos && (
              <p className="text-xs text-amber-700 dark:text-amber-400 text-center" data-testid="aviso-token-pendiente">
                Para pasar a sala, cargá el token o marcá "Continuar sin token".
              </p>
            )}
            <Button
              className="w-full h-9 text-sm gap-2 bg-emerald-600 hover:bg-emerald-700 text-white"
              disabled={
                checkInEnProceso ||
                (!tokenYaAceptado && !tokenDeclinado && !tokenPorKlinicos) ||
                (requiereCodigoSupervisor && !tokenPorKlinicos && codigoSupervisor.length !== 6)
              }
              onClick={() =>
                admitir.mutate({
                  id: turnoId,
                  data: tokenPorKlinicos
                    ? { tokenPorKlinicos: true }
                    : requiereCodigoSupervisor
                      ? { codigoSupervisor }
                      : {},
                })
              }
              data-testid="boton-checkin-sala"
            >
              {checkInEnProceso ? <Loader2 className="w-5 h-5 animate-spin" /> : <LogIn className="w-5 h-5" />}
              {checkInEnProceso ? "Recepcionando…" : "Recepcionar paciente → Sala de espera"}
            </Button>
          </div>
        ) : (
          <div className="flex flex-col items-center gap-0.5 text-sm text-muted-foreground py-1">
            <div className="flex items-center gap-2">
              <CheckCircle2 className="w-4 h-4 text-emerald-600" />
              Paciente en {ESTADO_MACRO_META[estadoMacro]?.label ?? turno.estado}
            </div>
            {turno.admitidoPor && (
              <span className="text-xs" data-testid="texto-recepcionado-por">
                Recepcionado por {turno.admitidoPor}
              </span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
