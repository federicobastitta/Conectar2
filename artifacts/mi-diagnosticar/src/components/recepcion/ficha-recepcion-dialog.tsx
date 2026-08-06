import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useGetRecepcionFicha,
  getGetRecepcionFichaQueryKey,
  useAdmitirTurno,
  useDescolorearTurno,
  useUpdateTurno,
  useUpdatePaciente,
  useUpsertDocumentacionRecepcion,
  useListSolicitudesPaciente,
  getListSolicitudesPacienteQueryKey,
  useUpdateSolicitudEstado,
  useGetIngresoConsulta,
  getGetIngresoConsultaQueryKey,
  useGuardarIngresoConsulta,
  useDeclararPrestacionCargada,
  useEnviarTokenARevision,
  useGetRobotKlinicosEstado,
  useGetTokenAuditoria,
  useListKlinicosPracticas,
  type TokenValidacionResultado,
  type DocumentacionItem,
  type Turno,
} from "@workspace/api-client-react";
import { MultiCombobox } from "@/components/ui/combobox";

type DocTipo = "dni" | "credencial" | "orden_medica" | "autorizacion";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { useValidacionToken, ESTADOS_DENEGACION } from "@/contexts/validacion-token-provider";
import { SelectorEstudiosTurno } from "@/components/recepcion/selector-estudios-turno";
import { DialogoCodigoSupervisor } from "@/components/recepcion/dialogo-codigo-supervisor";
import { getEstadoMacro, ESTADO_MACRO_META, CHECK_IN_META } from "@/lib/episodio";
import { marcaColorFondo, marcaColorLabel } from "@/lib/marca-color";
import { useAuth } from "@/hooks/use-auth";
import {
  LogIn, CheckCircle2, Upload, ShieldCheck, User, FileText,
  KeyRound, Loader2, AlertTriangle, Stethoscope, XCircle,
} from "lucide-react";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";

// ── Estudios del turno ─────────────────────────────────────────────────────
// Muestra TODAS las prácticas cargadas en el turno y permite corregirlas
// (agregar/quitar) sin salir de la ficha. Guarda vía PATCH /turnos con
// klinicosPracticaIds (el backend sincroniza el conjunto y la principal).
function EstudiosTurnoSection({ turno, onCambio }: { turno: Turno; onCambio: () => void }) {
  const { toast } = useToast();
  const { data: catalogo } = useListKlinicosPracticas();
  const [editando, setEditando] = useState(false);
  const [seleccion, setSeleccion] = useState<string[]>([]);

  const cargadas = turno.practicas ?? [];
  const activas = (catalogo ?? []).filter((p) => p.activo !== false);
  const opciones = activas.map((p) => ({
    value: String(p.id),
    label: p.nombre,
    keywords: (p.codigos ?? []).join(" "),
  }));

  const guardar = useUpdateTurno({
    mutation: {
      onSuccess: () => {
        toast({ title: "Estudios actualizados", description: "El turno quedó con los estudios corregidos." });
        setEditando(false);
        onCambio();
      },
      onError: () =>
        toast({ title: "Error", description: "No se pudieron guardar los estudios", variant: "destructive" }),
    },
  });

  const editable = !["cancelado", "anulado", "atendido"].includes(turno.estado);

  return (
    <section className="space-y-2 border-t pt-4" data-testid="ficha-estudios">
      <h3 className="text-sm font-semibold flex items-center gap-1.5">
        <Stethoscope className="w-4 h-4" /> Estudios del turno
      </h3>
      {!editando ? (
        <div className="space-y-2">
          {cargadas.length > 0 ? (
            <div className="flex flex-wrap gap-1.5">
              {cargadas.map((p) => (
                <span
                  key={p.id}
                  className="inline-flex items-center text-xs font-medium px-2 py-0.5 rounded-full border bg-muted"
                  data-testid={`ficha-estudio-${p.id}`}
                >
                  {p.nombre}
                  {p.codigos?.length ? ` (${p.codigos.join(", ")})` : ""}
                </span>
              ))}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">Sin estudios cargados.</p>
          )}
          {editable && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                setSeleccion(cargadas.map((p) => String(p.id)));
                setEditando(true);
              }}
              data-testid="ficha-boton-editar-estudios"
            >
              {cargadas.length > 0 ? "Corregir estudios" : "Agregar estudios"}
            </Button>
          )}
        </div>
      ) : (
        <div className="space-y-2">
          <MultiCombobox
            options={opciones}
            values={seleccion}
            onChange={setSeleccion}
            placeholder="Tipo de estudio… (podés tildar varios)"
            testId="ficha-multicombobox-estudios"
          />
          <div className="flex gap-2">
            <Button
              size="sm"
              disabled={guardar.isPending}
              onClick={() =>
                guardar.mutate({
                  id: turno.id,
                  data: { klinicosPracticaIds: seleccion.map(Number) },
                })
              }
              data-testid="ficha-boton-guardar-estudios"
            >
              {guardar.isPending && <Loader2 className="w-3.5 h-3.5 mr-1 animate-spin" />}
              Guardar estudios
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setEditando(false)}>
              Cancelar
            </Button>
          </div>
          {seleccion.length === 0 && (
            <p className="text-xs text-amber-700 dark:text-amber-400">
              Vas a dejar el turno sin ningún estudio cargado.
            </p>
          )}
        </div>
      )}
    </section>
  );
}

function TokenAuditoriaPanel({ turnoId }: { turnoId: number }) {
  const { data, isLoading } = useGetTokenAuditoria(turnoId);
  if (isLoading) return <Skeleton className="h-16" />;
  const entradas = data?.entradas ?? [];
  if (entradas.length === 0)
    return <p className="text-amber-700">Sin registros de auditoría para este turno.</p>;
  return (
    <ul className="space-y-1 max-h-40 overflow-y-auto border-t border-amber-200 pt-1.5" data-testid="token-auditoria-lista">
      {entradas.map((e, i) => (
        <li key={i} className="flex flex-wrap gap-x-2 text-amber-800">
          <span className="text-amber-600 tabular-nums shrink-0">
            {e.fecha ? new Date(e.fecha).toLocaleString("es-AR") : "—"}
          </span>
          <span className="font-medium">{e.descripcion}</span>
          {e.usuario && <span>({e.usuario})</span>}
          {e.latenciaMs != null && <span className="text-amber-600">{e.latenciaMs} ms</span>}
        </li>
      ))}
    </ul>
  );
}

const TIPOS_DOC: { tipo: DocTipo; label: string }[] = [
  { tipo: "orden_medica", label: "Orden médica" },
];

const SEMAFORO_COLOR: Record<string, string> = {
  verde: "bg-emerald-500",
  amarillo: "bg-amber-500",
  rojo: "bg-red-500",
};

const RECEPCIONABLES = ["pendiente", "reservado", "confirmado", "publicado", "ausente"];

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

function DocRow({
  pacienteId, turnoId, item, tipo, label, onChanged,
}: {
  pacienteId: number;
  turnoId: number;
  item?: DocumentacionItem;
  tipo: DocTipo;
  label: string;
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

  const subirArchivo = async (file: File) => {
    if (file.size > 5 * 1024 * 1024) {
      toast({ title: "Archivo muy grande", description: "Máximo 5 MB", variant: "destructive" });
      return;
    }
    const data = await archivoABase64(file);
    upsert.mutate({
      id: pacienteId,
      tipo,
      data: {
        estado: estado === "validada" ? "validada" : "pendiente",
        turnoId,
        archivoNombre: file.name,
        archivoMime: file.type || "application/octet-stream",
        archivoData: data,
      },
    });
  };

  return (
    <div className="flex items-center gap-3 px-3 py-2 rounded-md border" data-testid={`doc-${tipo}`}>
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium">{label}</div>
        <div className="text-xs text-muted-foreground truncate">
          {estado === "validada" ? "Validada" : estado === "no_aplica" ? "No aplica" : "Pendiente"}
          {item?.tieneArchivo && item.archivoNombre ? ` · ${item.archivoNombre}` : ""}
        </div>
      </div>
      {estado === "validada" ? (
        <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" />
      ) : (
        <Button
          size="sm"
          variant="outline"
          disabled={upsert.isPending}
          onClick={() => upsert.mutate({ id: pacienteId, tipo, data: { estado: "validada", turnoId } })}
          data-testid={`boton-validar-${tipo}`}
        >
          <ShieldCheck className="w-3.5 h-3.5 mr-1" /> Validar
        </Button>
      )}
      <input
        ref={inputRef}
        type="file"
        className="hidden"
        accept="image/*,.pdf"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void subirArchivo(f);
          e.target.value = "";
        }}
      />
      <Button
        size="sm"
        variant="ghost"
        disabled={upsert.isPending}
        onClick={() => inputRef.current?.click()}
        data-testid={`boton-subir-${tipo}`}
      >
        {upsert.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Upload className="w-3.5 h-3.5" />}
      </Button>
    </div>
  );
}

// ── Ingreso ambulatorio estilo Klinicos (solo consultas) ──────────────────
// Campos que exige Klinicos al recepcionar una consulta: Sector (fijo),
// Consultorio (fijo), Especialidad, Profesional y Motivo de consulta.
// Después de Guardar aparece el campo de token para validar la orden.
function IngresoConsultaTab({ turnoId }: { turnoId: number }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { data: ingreso, isLoading } = useGetIngresoConsulta(turnoId);
  const { data: practicas } = useListKlinicosPracticas();
  const [form, setForm] = useState<{
    especialidad: string;
    profesional: string;
    motivo: string;
    practicaIds: number[];
  } | null>(null);
  const [tokenOrden, setTokenOrden] = useState("");

  const [ultimoResultado, setUltimoResultado] = useState<TokenValidacionResultado | null>(null);
  const [verAuditoria, setVerAuditoria] = useState(false);

  // Afiliado faltante: el backend corta la validación con DATA_REQUIRED y
  // camposFaltantes ["affiliate_number"]; se carga acá mismo y se reintenta.
  const { data: fichaAfiliado } = useGetRecepcionFicha(turnoId);
  const [afiliadoInput, setAfiliadoInput] = useState("");
  const guardarAfiliado = useUpdatePaciente({
    mutation: {
      onSuccess: () => {
        toast({ title: "Número de afiliado guardado" });
        void queryClient.invalidateQueries({ queryKey: getGetRecepcionFichaQueryKey(turnoId) });
      },
      onError: () =>
        toast({ title: "Error", description: "No se pudo guardar el afiliado", variant: "destructive" }),
    },
  });

  const guardar = useGuardarIngresoConsulta({
    mutation: {
      onSuccess: (_data, vars) => {
        toast(
          vars.data.token !== undefined
            ? { title: "Token guardado", description: "El token quedó registrado con la orden." }
            : { title: "Ingreso guardado", description: "Ahora cargá el token de la orden." },
        );
        setForm(null);
        setTokenOrden("");
        void queryClient.invalidateQueries({ queryKey: getGetIngresoConsultaQueryKey(turnoId) });
      },
      onError: (err: unknown) => {
        const data = err && typeof err === "object" && "data" in err ? (err as { data: unknown }).data : null;
        const detalle =
          data && typeof data === "object" && "error" in data && typeof (data as { error: unknown }).error === "string"
            ? (data as { error: string }).error
            : "No se pudo guardar el ingreso";
        toast({ title: "Error", description: detalle, variant: "destructive" });
      },
    },
  });

  // Validación con reintentos automáticos ante TIMEOUT del Robot (la
  // validación puede seguir en curso en IOMA hasta ~60s; NO es un rechazo).
  // El estado vive en el provider global: si la ficha se cierra, la
  // validación sigue y el cartel grande lo muestra el provider igual.
  const tokenVal = useValidacionToken();
  useEffect(() => {
    if (!tokenVal.resultado) return;
    // Ignorar resultados de validaciones de otros turnos (el estado es global).
    if (tokenVal.turnoIdEnCurso !== turnoId) return;
    setUltimoResultado(tokenVal.resultado);
    if (tokenVal.resultado.estado === "TOKEN_ACCEPTED") {
      if (tokenVal.resultado.nroBono) {
        toast({ title: "Autorizado en Klinicos", description: `N° de Bono ${tokenVal.resultado.nroBono}.` });
      } else {
        toast({
          title: "Token aceptado — SIN bono",
          description: tokenVal.resultado.autorizacionDetalle ?? "No quedó autorizado en Klinicos. Verificá a mano.",
          variant: "destructive",
        });
      }
      setTokenOrden("");
      void queryClient.invalidateQueries({ queryKey: getGetIngresoConsultaQueryKey(turnoId) });
      // La invalidación de agenda/recepción por recepción automática y el
      // cartel grande los maneja el ValidacionTokenProvider global.
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tokenVal.resultado]);
  // Adaptador con la misma forma que la mutación original para no tocar
  // todos los call sites de esta sección.
  const validarToken = {
    isPending: tokenVal.validando,
    mutate: (args: { id: number; data: { token: string } }) =>
      tokenVal.validar(args.id, args.data.token),
  };
  const { data: robot } = useGetRobotKlinicosEstado(undefined, {
    query: { refetchInterval: 30_000 },
  });

  const prestacionCargada = useDeclararPrestacionCargada({
    mutation: {
      onSuccess: () =>
        toast({
          title: "Declaración registrada",
          description: "Ahora presioná Reintentar validación para que el Robot verifique la prestación.",
        }),
      onError: () =>
        toast({ title: "Error", description: "No se pudo registrar la declaración", variant: "destructive" }),
    },
  });
  const enviarRevision = useEnviarTokenARevision({
    mutation: {
      onSuccess: () => {
        toast({ title: "Enviado a revisión", description: "El caso quedó en revisión manual." });
        setUltimoResultado(null);
      },
      onError: () =>
        toast({ title: "Error", description: "No se pudo enviar a revisión", variant: "destructive" }),
    },
  });

  if (isLoading || !ingreso) {
    return <Skeleton className="h-40 mt-3" />;
  }

  if (!ingreso.esConsulta) {
    return (
      <p className="text-sm text-muted-foreground mt-3">
        Este turno es una práctica (sector {ingreso.sector}): la orden se genera
        automáticamente al recepcionar, no requiere carga manual de consulta.
      </p>
    );
  }

  const valores = form ?? {
    especialidad: ingreso.especialidad ?? "",
    profesional: ingreso.profesional ?? "",
    motivo: ingreso.motivo ?? "",
    // Todos los estudios del turno; si el API solo trae el singular legado, se usa ese
    practicaIds:
      ingreso.practicas && ingreso.practicas.length > 0
        ? ingreso.practicas.map((p) => p.id)
        : ingreso.practicaId != null
          ? [ingreso.practicaId]
          : [],
  };
  const practicasActivas = (practicas ?? []).filter((p) => p.activo !== false);
  const practicasSeleccionadas = practicasActivas.filter((p) => valores.practicaIds.includes(p.id));

  return (
    <div className="space-y-3 mt-3" data-testid="ingreso-consulta">
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1">
          <Label className="text-xs">Sector</Label>
          <Input value={ingreso.sector} disabled data-testid="ingreso-sector" />
        </div>
        <div className="space-y-1">
          <Label className="text-xs">Consultorio</Label>
          <Input value="Consultorios" disabled data-testid="ingreso-consultorio" />
        </div>
        <div className="space-y-1">
          <Label className="text-xs">Especialidad</Label>
          <Input
            value={valores.especialidad}
            onChange={(e) => setForm({ ...valores, especialidad: e.target.value })}
            data-testid="ingreso-especialidad"
          />
        </div>
        <div className="space-y-1">
          <Label className="text-xs">Profesional</Label>
          <Input
            value={valores.profesional}
            onChange={(e) => setForm({ ...valores, profesional: e.target.value })}
            data-testid="ingreso-profesional"
          />
        </div>
        <div className="space-y-1 col-span-2">
          <Label className="text-xs">Motivo de consulta *</Label>
          <Input
            placeholder="Ej: control clínico"
            value={valores.motivo}
            onChange={(e) => setForm({ ...valores, motivo: e.target.value })}
            data-testid="ingreso-motivo"
          />
        </div>
        <div className="space-y-1 col-span-2">
          <Label className="text-xs">Estudios (nomenclador IOMA)</Label>
          <SelectorEstudiosTurno
            practicas={practicasActivas}
            seleccionadas={valores.practicaIds}
            onChange={(ids) => setForm({ ...valores, practicaIds: ids })}
          />
          {practicasSeleccionadas.length > 0 && (
            <p className="text-xs text-muted-foreground" data-testid="ingreso-practica-codigos">
              Códigos: {practicasSeleccionadas.flatMap((p) => p.codigos ?? []).join(", ")}
            </p>
          )}
        </div>
      </div>
      <Button
        size="sm"
        disabled={!valores.especialidad.trim() || !valores.motivo.trim() || guardar.isPending}
        onClick={() =>
          guardar.mutate({
            id: turnoId,
            data: {
              especialidad: valores.especialidad.trim(),
              profesional: valores.profesional.trim(),
              motivo: valores.motivo.trim(),
              practicaIds: valores.practicaIds,
            },
          })
        }
        data-testid="ingreso-boton-guardar"
      >
        {guardar.isPending && <Loader2 className="w-3.5 h-3.5 mr-1 animate-spin" />}
        Guardar
      </Button>

      {ingreso.guardado && (
        <div className="border rounded-md p-3 space-y-2" data-testid="ingreso-token-box">
          <div className="flex items-center justify-between gap-2">
            <div className="text-sm font-medium flex items-center gap-1.5">
              <KeyRound className="w-3.5 h-3.5" /> Token de la orden
            </div>
            {robot?.validacionHabilitada && (
              <div className="flex items-center gap-2 text-xs text-muted-foreground" data-testid="robot-estado">
                <span
                  className={`inline-block w-2 h-2 rounded-full ${robot?.disponible ? "bg-sky-500" : "bg-red-500"}`}
                />
                Conexión técnica: {robot?.disponible ? "activa (no indica autorización)" : "no disponible"}
                {" · "}Sesión KLINICOS: {robot?.sesionKlinicos ?? "desconocida"}
                {ultimoResultado?.latenciaMs != null && ` · ${(ultimoResultado.latenciaMs / 1000).toFixed(1)}s`}
              </div>
            )}
          </div>
          {/* Regla única de verdad (2-ago-2026): el verde SOLO sale del estado
              PERSISTIDO por el backend — TOKEN_ACCEPTED + N° de bono no vacío.
              "Token guardado" NO implica autorizado: sin bono el cartel es
              amarillo (no confirmado) o rojo (rechazo explícito). */}
          {ingreso.token && !robot?.validacionHabilitada ? (
            <p className="text-sm text-muted-foreground flex items-center gap-1.5" data-testid="token-registrado">
              <KeyRound className="w-4 h-4" /> Token registrado con la orden (sin validación automática) · Token {ingreso.token}
            </p>
          ) : ingreso.token && ingreso.tokenEstado === "ACCEPTED" && ingreso.nroBono ? (
            <p className="text-sm text-emerald-700 flex items-center gap-1.5" data-testid="token-aceptado">
              <CheckCircle2 className="w-4 h-4" /> Token aceptado. Consulta habilitada. · N° de Bono {ingreso.nroBono} · Token {ingreso.token}
            </p>
          ) : ingreso.token && ingreso.tokenEstado === "DENIED" ? (
            <div className="text-sm rounded-md border border-red-300 bg-red-50 dark:bg-red-950/40 text-red-800 dark:text-red-200 p-2" data-testid="token-rechazado">
              🔴 <span className="font-medium">TOKEN RECHAZADO</span> — IOMA no autorizó la prestación.
            </div>
          ) : ingreso.token ? (
            <div className="text-sm rounded-md border border-amber-300 bg-amber-50 dark:bg-amber-950/40 text-amber-800 dark:text-amber-200 p-2" data-testid="token-no-confirmado">
              🟡 <span className="font-medium">VALIDACIÓN NO CONFIRMADA</span> — No fue posible confirmar la
              autorización de IOMA. La consulta todavía no está habilitada. Verifique el caso antes de un nuevo intento.
            </div>
          ) : !robot?.validacionHabilitada ? (
            /* Etapa de preparación: la validación en vivo con KLINICOS está
               deshabilitada (feature flag). El token se guarda como dato,
               igual que en el flujo actual de recepción. */
            <>
              <p className="text-xs text-muted-foreground">
                Ingresá el token que el paciente generó en su app. Se guardará con la orden
                (la validación automática con KLINICOS todavía no está habilitada).
              </p>
              <div className="flex gap-2">
                <Input
                  placeholder="Token de autorización"
                  value={tokenOrden}
                  onChange={(e) => setTokenOrden(e.target.value)}
                  disabled={guardar.isPending}
                  data-testid="ingreso-input-token"
                />
                <Button
                  size="sm"
                  disabled={!tokenOrden.trim() || guardar.isPending}
                  onClick={() => guardar.mutate({ id: turnoId, data: { token: tokenOrden.trim() } })}
                  data-testid="ingreso-boton-guardar-token"
                >
                  {guardar.isPending ? (
                    <Loader2 className="w-3.5 h-3.5 mr-1 animate-spin" />
                  ) : (
                    <KeyRound className="w-3.5 h-3.5 mr-1" />
                  )}
                  Guardar token
                </Button>
              </div>
            </>
          ) : (
            <>
              <p className="text-xs text-muted-foreground">
                Ingresá el token que el paciente generó en su app para validar la orden.
              </p>
              <div className="flex gap-2">
                <Input
                  placeholder="Token de autorización"
                  value={tokenOrden}
                  onChange={(e) => {
                    setTokenOrden(e.target.value);
                    setUltimoResultado(null);
                  }}
                  disabled={validarToken.isPending}
                  data-testid="ingreso-input-token"
                />
                <Button
                  size="sm"
                  disabled={!tokenOrden.trim() || validarToken.isPending}
                  onClick={() =>
                    validarToken.mutate({ id: turnoId, data: { token: tokenOrden.trim() } })
                  }
                  data-testid="ingreso-boton-validar-token"
                >
                  {validarToken.isPending ? (
                    <Loader2 className="w-3.5 h-3.5 mr-1 animate-spin" />
                  ) : (
                    <ShieldCheck className="w-3.5 h-3.5 mr-1" />
                  )}
                  {validarToken.isPending ? "Validando…" : "Validar"}
                </Button>
              </div>
              {validarToken.isPending && (
                <p className="text-xs text-muted-foreground flex items-center gap-1.5" data-testid="token-validando">
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  {tokenVal.esperandoReintento
                    ? "La validación está en curso en IOMA (puede tardar hasta un minuto)…"
                    : "Validando token con KLINICOS…"}
                </p>
              )}
              {!validarToken.isPending && ultimoResultado?.estado === "MANUAL_PRESTATION_REQUIRED" && (
                <div
                  className="text-xs rounded-md p-2.5 space-y-2 bg-amber-50 text-amber-900 border border-amber-200"
                  data-testid="token-contingencia-manual"
                >
                  <p className="flex items-start gap-1.5 font-medium">
                    <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                    <span>
                      La prestación no se encuentra disponible en KLINICOS. Ingresá a KLINICOS,
                      cargala manualmente y luego regresá para reintentar la validación.
                    </span>
                  </p>
                  <dl className="grid grid-cols-2 gap-x-3 gap-y-0.5">
                    {(
                      [
                        ["Paciente", ultimoResultado.contexto?.paciente],
                        ["DNI", ultimoResultado.contexto?.dni],
                        ["Afiliado", ultimoResultado.contexto?.afiliado],
                        ["Fecha", ultimoResultado.contexto?.fecha],
                        ["Práctica", ultimoResultado.contexto?.practica],
                        ["Profesional", ultimoResultado.contexto?.profesional],
                        ["Especialidad", ultimoResultado.contexto?.especialidad],
                        ["Sede", ultimoResultado.contexto?.sede],
                        ["CIE-10", ultimoResultado.contexto?.cie10],
                        ["Motivo", ultimoResultado.contexto?.motivo],
                      ] as const
                    ).map(([label, valor]) => (
                      <div key={label} className="flex gap-1 min-w-0">
                        <dt className="text-amber-700 shrink-0">{label}:</dt>
                        <dd className="truncate font-medium">{valor ?? "—"}</dd>
                      </div>
                    ))}
                  </dl>
                  <p className="text-amber-800">
                    Detalle: {ultimoResultado.contexto?.detalle ?? ultimoResultado.mensaje}
                  </p>
                  <div className="flex flex-wrap gap-2 pt-0.5">
                    {robot?.klinicosUrl && (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => window.open(robot.klinicosUrl!, "_blank", "noopener,noreferrer")}
                        data-testid="contingencia-abrir-klinicos"
                      >
                        Abrir KLINICOS
                      </Button>
                    )}
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={prestacionCargada.isPending}
                      onClick={() => prestacionCargada.mutate({ id: turnoId })}
                      data-testid="contingencia-prestacion-cargada"
                    >
                      {prestacionCargada.isPending && <Loader2 className="w-3.5 h-3.5 mr-1 animate-spin" />}
                      Prestación cargada
                    </Button>
                    <Button
                      size="sm"
                      disabled={!tokenOrden.trim() || validarToken.isPending}
                      onClick={() =>
                        validarToken.mutate({ id: turnoId, data: { token: tokenOrden.trim() } })
                      }
                      data-testid="contingencia-reintentar"
                    >
                      Reintentar validación
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={enviarRevision.isPending}
                      onClick={() => enviarRevision.mutate({ id: turnoId })}
                      data-testid="contingencia-enviar-revision"
                    >
                      {enviarRevision.isPending && <Loader2 className="w-3.5 h-3.5 mr-1 animate-spin" />}
                      Enviar a revisión
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => setVerAuditoria((v) => !v)}
                      data-testid="contingencia-ver-auditoria"
                    >
                      Ver auditoría
                    </Button>
                  </div>
                  {verAuditoria && <TokenAuditoriaPanel turnoId={turnoId} />}
                </div>
              )}
              {!validarToken.isPending &&
                ultimoResultado &&
                (ultimoResultado.camposFaltantes ?? []).includes("affiliate_number") && (
                <div
                  className="text-xs rounded-md p-2.5 space-y-2 bg-amber-50 text-amber-900 border border-amber-200"
                  data-testid="token-afiliado-faltante"
                >
                  <p className="flex items-start gap-1.5 font-medium">
                    <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                    <span>
                      Falta el número de afiliado del paciente: la validación no se envió.
                      Cargalo acá y reintentá.
                    </span>
                  </p>
                  <div className="flex gap-2">
                    <Input
                      placeholder="Número de afiliado"
                      value={afiliadoInput}
                      onChange={(e) => setAfiliadoInput(e.target.value)}
                      disabled={guardarAfiliado.isPending}
                      data-testid="input-afiliado-faltante"
                    />
                    <Button
                      size="sm"
                      disabled={
                        !afiliadoInput.trim() ||
                        !fichaAfiliado?.paciente.id ||
                        guardarAfiliado.isPending ||
                        validarToken.isPending
                      }
                      onClick={() =>
                        guardarAfiliado.mutate(
                          { id: fichaAfiliado!.paciente.id, data: { nroAfiliado: afiliadoInput.trim() } },
                          {
                            onSuccess: () => {
                              if (tokenOrden.trim())
                                validarToken.mutate({ id: turnoId, data: { token: tokenOrden.trim() } });
                            },
                          },
                        )
                      }
                      data-testid="button-guardar-afiliado-reintentar"
                    >
                      {guardarAfiliado.isPending && <Loader2 className="w-3.5 h-3.5 mr-1 animate-spin" />}
                      Guardar y reintentar
                    </Button>
                  </div>
                </div>
              )}
              {!validarToken.isPending &&
                ultimoResultado &&
                ultimoResultado.estado !== "TOKEN_ACCEPTED" &&
                ultimoResultado.estado !== "MANUAL_PRESTATION_REQUIRED" &&
                !(ultimoResultado.camposFaltantes ?? []).includes("affiliate_number") && (
                <div
                  className={`text-xs rounded-md p-2 space-y-1.5 ${
                    ultimoResultado.reintentable
                      ? "bg-amber-50 text-amber-800 border border-amber-200"
                      : "bg-red-50 text-red-800 border border-red-200"
                  }`}
                  data-testid="token-resultado"
                >
                  {ultimoResultado.reintentable ? (
                    <p className="flex items-start gap-1.5">
                      <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                      <span>
                        {tokenVal.agotado
                          ? "La validación sigue en curso en IOMA y está demorando más de lo normal. NO es un rechazo: quedó pendiente — reintentá en unos minutos y avisá al equipo del Robot si persiste."
                          : "No fue posible validar el token. La cobertura no rechazó la consulta. Podés reintentar o aplicar el circuito de contingencia."}
                      </span>
                    </p>
                  ) : (
                    <p className="flex items-start gap-1.5">
                      <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                      <span>Token no aceptado: {ultimoResultado.mensaje}.</span>
                    </p>
                  )}
                  {ultimoResultado.reintentable && (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={!tokenOrden.trim() || validarToken.isPending}
                      onClick={() =>
                        validarToken.mutate({ id: turnoId, data: { token: tokenOrden.trim() } })
                      }
                      data-testid="token-boton-reintentar"
                    >
                      Reintentar validación
                    </Button>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

export function FichaRecepcionDialog({
  turnoId, abierto, onClose, onCambio, tabInicial,
}: {
  turnoId: number | null;
  abierto: boolean;
  onClose: () => void;
  onCambio?: () => void;
  tabInicial?: "documentacion" | "datos" | "consulta" | "token";
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [tokenInput, setTokenInput] = useState("");
  const [editando, setEditando] = useState(false);
  const [confirmandoCancelacion, setConfirmandoCancelacion] = useState(false);
  const [pedirCodigoSupervisor, setPedirCodigoSupervisor] = useState(false);
  const [form, setForm] = useState<Record<string, string>>({});

  const { data: ficha, isLoading } = useGetRecepcionFicha(turnoId ?? 0, {
    query: { enabled: abierto && !!turnoId },
  });

  const pacienteId = ficha?.paciente.id ?? 0;

  const { data: solicitudes } = useListSolicitudesPaciente(pacienteId, {
    query: { enabled: abierto && pacienteId > 0 },
  });

  const invalidarFicha = () => {
    if (turnoId) void queryClient.invalidateQueries({ queryKey: getGetRecepcionFichaQueryKey(turnoId) });
    onCambio?.();
  };

  const admitir = useAdmitirTurno({
    mutation: {
      onSuccess: () => {
        toast({ title: "Paciente recepcionado", description: "Pasó a la sala de espera." });
        setPedirCodigoSupervisor(false);
        invalidarFicha();
        // Volver a la pantalla anterior: cerramos la ficha sin derivar a otra página.
        onClose();
      },
      onError: (err: unknown) => {
        const e = (err as { data?: { codigo?: string; error?: string } })?.data ?? {};
        if (e?.codigo === "codigo_supervisor_requerido") {
          setPedirCodigoSupervisor(true);
        } else if (e?.codigo === "codigo_supervisor_invalido") {
          toast({ title: e.error ?? "Código de supervisor incorrecto", variant: "destructive" });
        } else {
          toast({ title: "Error", description: "No se pudo recepcionar al paciente", variant: "destructive" });
        }
      },
    },
  });

  const { user } = useAuth();
  const esAdmin = user?.rol === "admin";

  const descolorear = useDescolorearTurno({
    mutation: {
      onSuccess: () => {
        toast({ title: "Marca de color quitada" });
        invalidarFicha();
      },
      onError: () =>
        toast({ title: "Error", description: "No se pudo quitar la marca de color", variant: "destructive" }),
    },
  });

  const cancelarTurno = useUpdateTurno({
    mutation: {
      onSuccess: () => {
        toast({
          title: "Turno cancelado",
          description: "Se registró la cancelación y se le avisa al Robot Klinicos.",
        });
        setConfirmandoCancelacion(false);
        invalidarFicha();
      },
      onError: () =>
        toast({ title: "Error", description: "No se pudo cancelar el turno", variant: "destructive" }),
    },
  });

  const updatePaciente = useUpdatePaciente({
    mutation: {
      onSuccess: () => {
        toast({ title: "Datos actualizados" });
        setEditando(false);
        invalidarFicha();
      },
      onError: () =>
        toast({ title: "Error", description: "No se pudieron guardar los datos", variant: "destructive" }),
    },
  });

  const updateSolicitud = useUpdateSolicitudEstado({
    mutation: {
      onSuccess: () => {
        toast({ title: "Token validado", description: "La autorización quedó registrada." });
        setTokenInput("");
        void queryClient.invalidateQueries({ queryKey: getListSolicitudesPacienteQueryKey(pacienteId) });
        invalidarFicha();
      },
      onError: () =>
        toast({ title: "Error", description: "No se pudo validar el token", variant: "destructive" }),
    },
  });

  const solicitudesPendientesToken = (solicitudes ?? []).filter(
    (s) => s.requiereAutorizacion && !s.tokenValidado && !["cancelada", "rechazada", "realizada", "informada"].includes(s.estado),
  );

  const empezarEdicion = () => {
    if (!ficha) return;
    setForm({
      nombre: ficha.paciente.nombre ?? "",
      apellido: ficha.paciente.apellido ?? "",
      dni: ficha.paciente.dni ?? "",
      telefono: ficha.paciente.telefono ?? "",
      email: ficha.paciente.email ?? "",
      cobertura: ficha.paciente.cobertura ?? "",
      nroAfiliado: ficha.paciente.nroAfiliado ?? "",
    });
    setEditando(true);
  };

  const guardarEdicion = () => {
    if (!ficha) return;
    updatePaciente.mutate({
      id: ficha.paciente.id,
      data: {
        nombre: form.nombre || undefined,
        apellido: form.apellido || undefined,
        dni: form.dni || undefined,
        telefono: form.telefono || undefined,
        email: form.email || undefined,
        cobertura: form.cobertura || undefined,
        nroAfiliado: form.nroAfiliado || undefined,
      },
    });
  };

  const macroMeta = ficha
    ? ficha.checkInPrevio && getEstadoMacro(ficha.turno.estado) === "agendado"
      ? CHECK_IN_META
      : ESTADO_MACRO_META[getEstadoMacro(ficha.turno.estado)]
    : null;
  const docPorTipo = new Map((ficha?.documentacion ?? []).map((d) => [d.tipo, d]));

  return (
    <Dialog open={abierto} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
        {isLoading || !ficha ? (
          <div className="space-y-3">
            <Skeleton className="h-7 w-56" />
            <Skeleton className="h-40" />
          </div>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2 flex-wrap">
                {ficha.paciente.apellido}, {ficha.paciente.nombre}
                {ficha.semaforo && (
                  <span
                    className={`inline-block w-2.5 h-2.5 rounded-full ${SEMAFORO_COLOR[ficha.semaforo.color] ?? "bg-muted-foreground"}`}
                    title={ficha.semaforo.faltantes.join(", ") || "Documentación completa"}
                  />
                )}
              </DialogTitle>
              <DialogDescription>
                {ficha.turno.fecha} · {ficha.turno.horaInicio} hs · {ficha.turneraNombre ?? ""}
                {ficha.paciente.dni ? ` · DNI ${ficha.paciente.dni}` : ""}
                {ficha.edad != null ? ` · ${ficha.edad} años` : ""}
              </DialogDescription>
            </DialogHeader>

            <div className="flex items-center gap-2 flex-wrap">
              {macroMeta && (
                <span className={`inline-flex items-center gap-1.5 text-xs font-medium px-2 py-0.5 rounded-full border ${macroMeta.bg} ${macroMeta.color} ${macroMeta.border}`}>
                  <span className={`w-1.5 h-1.5 rounded-full ${macroMeta.dot}`} />
                  {macroMeta.label}
                </span>
              )}
              {ficha.turno.marcaColor && (
                <span
                  className={`inline-flex items-center gap-1.5 text-xs font-medium px-2 py-0.5 rounded-full border ${marcaColorFondo(ficha.turno.marcaColor)} ${ficha.turno.marcaColor === "naranja" ? "border-orange-300 text-orange-800 dark:text-orange-300" : "border-yellow-400 text-yellow-800 dark:text-yellow-300"}`}
                  data-testid="ficha-badge-marca-color"
                >
                  {marcaColorLabel(ficha.turno.marcaColor)}
                </span>
              )}
              {ficha.turno.admitidoPor && (
                <span className="text-xs text-muted-foreground" data-testid="ficha-recepcionado-por">
                  Recepcionado por {ficha.turno.admitidoPor}
                </span>
              )}
              {ficha.turno.marcaColor && esAdmin && (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => descolorear.mutate({ id: ficha.turno.id })}
                  disabled={descolorear.isPending}
                  data-testid="ficha-boton-descolorear"
                >
                  Descolorear paciente
                </Button>
              )}
              {RECEPCIONABLES.includes(ficha.turno.estado) && (
                <Button
                  size="sm"
                  onClick={() => admitir.mutate({ id: ficha.turno.id })}
                  disabled={admitir.isPending}
                  data-testid="ficha-boton-recepcionar"
                >
                  <LogIn className="w-3.5 h-3.5 mr-1" /> Registrar arribo
                </Button>
              )}
              {!["cancelado", "anulado", "atendido"].includes(ficha.turno.estado) && (
                <Button
                  size="sm"
                  variant="outline"
                  className="text-destructive hover:text-destructive"
                  onClick={() => setConfirmandoCancelacion(true)}
                  disabled={cancelarTurno.isPending}
                  data-testid="ficha-boton-cancelar-turno"
                >
                  <XCircle className="w-3.5 h-3.5 mr-1" /> Cancelar turno
                </Button>
              )}
            </div>

            <AlertDialog open={confirmandoCancelacion} onOpenChange={setConfirmandoCancelacion}>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>¿Cancelar este turno?</AlertDialogTitle>
                  <AlertDialogDescription>
                    El turno de {ficha.paciente.apellido}, {ficha.paciente.nombre} del {ficha.turno.fecha} a las {ficha.turno.horaInicio} hs
                    quedará cancelado y se le avisará automáticamente al Robot Klinicos para que dé de baja el ingreso.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Volver</AlertDialogCancel>
                  <AlertDialogAction
                    className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                    onClick={() => cancelarTurno.mutate({ id: ficha.turno.id, data: { estado: "cancelado" } })}
                    data-testid="ficha-confirmar-cancelar-turno"
                  >
                    {cancelarTurno.isPending && <Loader2 className="w-3.5 h-3.5 mr-1 animate-spin" />}
                    Cancelar turno
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>

            <div className="mt-1 space-y-5">
              {/* ── Datos del paciente ─────────────────────────────── */}
              <section className="space-y-2">
                <h3 className="text-sm font-semibold flex items-center gap-1.5">
                  <User className="w-4 h-4" /> Datos del paciente
                </h3>
                {!editando ? (
                  <div className="text-sm space-y-2">
                    <div className="grid grid-cols-2 gap-x-4 gap-y-1">
                      <p><span className="text-muted-foreground">Teléfono:</span> {ficha.paciente.telefono || "—"}</p>
                      <p><span className="text-muted-foreground">Email:</span> {ficha.paciente.email || "—"}</p>
                      <p><span className="text-muted-foreground">Cobertura:</span> {ficha.paciente.cobertura || "—"}</p>
                      <p><span className="text-muted-foreground">N° afiliado:</span> {ficha.paciente.nroAfiliado || "—"}</p>
                    </div>
                    <Button size="sm" variant="outline" onClick={empezarEdicion} data-testid="ficha-boton-editar">
                      Modificar datos
                    </Button>
                  </div>
                ) : (
                  <div className="space-y-3">
                    <div className="grid grid-cols-2 gap-3">
                      {(
                        [
                          ["nombre", "Nombre"], ["apellido", "Apellido"], ["dni", "DNI"],
                          ["telefono", "Teléfono"], ["email", "Email"], ["cobertura", "Cobertura"],
                          ["nroAfiliado", "N° afiliado"],
                        ] as const
                      ).map(([campo, label]) => (
                        <div key={campo} className="space-y-1">
                          <Label className="text-xs">{label}</Label>
                          <Input
                            value={form[campo] ?? ""}
                            onChange={(e) => setForm({ ...form, [campo]: e.target.value })}
                            data-testid={`ficha-input-${campo}`}
                          />
                        </div>
                      ))}
                    </div>
                    <div className="flex gap-2">
                      <Button size="sm" onClick={guardarEdicion} disabled={updatePaciente.isPending} data-testid="ficha-boton-guardar">
                        {updatePaciente.isPending && <Loader2 className="w-3.5 h-3.5 mr-1 animate-spin" />}
                        Guardar
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => setEditando(false)}>
                        Cancelar
                      </Button>
                    </div>
                  </div>
                )}
              </section>

              {/* ── Estudios del turno ─────────────────────────────── */}
              <EstudiosTurnoSection turno={ficha.turno} onCambio={invalidarFicha} />

              {/* ── Ingreso de la consulta (Klinicos) ──────────────── */}
              <section className="space-y-1 border-t pt-4">
                <h3 className="text-sm font-semibold flex items-center gap-1.5">
                  <Stethoscope className="w-4 h-4" /> Ingreso de la consulta
                </h3>
                <IngresoConsultaTab turnoId={ficha.turno.id} />
              </section>

              {/* ── Documentación ──────────────────────────────────── */}
              <section className="space-y-2 border-t pt-4">
                <h3 className="text-sm font-semibold flex items-center gap-1.5">
                  <FileText className="w-4 h-4" /> Documentación
                </h3>
                {ficha.semaforo.faltantes.length > 0 && (
                  <p className="text-xs text-amber-700 flex items-center gap-1.5">
                    <AlertTriangle className="w-3.5 h-3.5" />
                    Falta: {ficha.semaforo.faltantes.join(", ")}
                  </p>
                )}
                {TIPOS_DOC.map(({ tipo, label }) => (
                  <DocRow
                    key={tipo}
                    pacienteId={ficha.paciente.id}
                    turnoId={ficha.turno.id}
                    tipo={tipo}
                    label={label}
                    item={docPorTipo.get(tipo)}
                    onChanged={invalidarFicha}
                  />
                ))}
              </section>

              {/* ── Tokens de solicitudes pendientes ───────────────── */}
              {solicitudesPendientesToken.length > 0 && (
                <section className="space-y-3 border-t pt-4">
                  <h3 className="text-sm font-semibold flex items-center gap-1.5">
                    <KeyRound className="w-4 h-4" /> Autorizaciones pendientes
                  </h3>
                  {solicitudesPendientesToken.map((s) => (
                    <div key={s.id} className="border rounded-md p-3 space-y-2" data-testid={`solicitud-token-${s.id}`}>
                      <div className="text-sm font-medium">{s.servicioNombre ?? s.tipo}</div>
                      <div className="text-xs text-muted-foreground">
                        Estado: {s.estado} · Requiere autorización de cobertura
                      </div>
                      <div className="flex gap-2">
                        <Input
                          placeholder="Token / N° de autorización"
                          value={tokenInput}
                          onChange={(e) => setTokenInput(e.target.value)}
                          data-testid="ficha-input-token"
                        />
                        <Button
                          size="sm"
                          disabled={!tokenInput.trim() || updateSolicitud.isPending}
                          onClick={() =>
                            updateSolicitud.mutate({
                              id: s.id,
                              data: { estado: "validada", token: tokenInput.trim() },
                            })
                          }
                          data-testid="ficha-boton-validar-token"
                        >
                          <ShieldCheck className="w-3.5 h-3.5 mr-1" /> Validar
                        </Button>
                      </div>
                    </div>
                  ))}
                </section>
              )}
            </div>
          </>
        )}
        <DialogoCodigoSupervisor
          abierto={pedirCodigoSupervisor}
          pendiente={admitir.isPending}
          onConfirmar={(codigo) => {
            if (ficha) admitir.mutate({ id: ficha.turno.id, data: { codigoSupervisor: codigo } });
          }}
          onCancelar={() => setPedirCodigoSupervisor(false)}
        />
      </DialogContent>
    </Dialog>
  );
}
