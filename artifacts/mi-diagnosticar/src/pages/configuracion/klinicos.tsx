import { useState, useRef, useEffect } from "react";
import {
  useGetKlinicosEstado,
  useListKlinicosTrabajos,
  useUpdateKlinicosTrabajo,
  useRetryKlinicosTrabajo,
  useAprobarKlinicosTrabajo,
  useRechazarKlinicosTrabajo,
  useListKlinicosReglasSector,
  useUpsertKlinicosReglaSector,
  useListKlinicosEqEspecialidades,
  useUpsertKlinicosEqEspecialidad,
  getListKlinicosEqEspecialidadesQueryKey,
  useListEspecialidades,
  useListKlinicosReglasPractica,
  useCreateKlinicosReglaPractica,
  useUpdateKlinicosReglaPractica,
  useDeleteKlinicosReglaPractica,
  useListKlinicosReglasCie10,
  useCreateKlinicosReglaCie10,
  useUpdateKlinicosReglaCie10,
  useDeleteKlinicosReglaCie10,
  getListKlinicosReglasPracticaQueryKey,
  getListKlinicosReglasCie10QueryKey,
  useListKlinicosPracticas,
  useCreateKlinicosPractica,
  useUpdateKlinicosPractica,
  useListKlinicosPrescriptores,
  useCreateKlinicosPrescriptor,
  useCreateKlinicosConsultaEspejo,
  useUpdateKlinicosPrescriptor,
  getListKlinicosTrabajosQueryKey,
  getGetKlinicosEstadoQueryKey,
  getListKlinicosReglasSectorQueryKey,
  getListKlinicosPracticasQueryKey,
  getListKlinicosPrescriptoresQueryKey,
  type KlinicosTrabajo,
  type KlinicosReglaPractica,
  type KlinicosReglaCie10,
  type KlinicosPractica,
  type KlinicosPrescriptor,
  useProbarRobotKlinicos,
  useRegistrarPrestacionCargadaPrueba,
  useGetRobotKlinicosEstado,
  getRobotKlinicosEstado,
  getGetRobotKlinicosEstadoQueryKey,
  useGetRobotKlinicosSolicitud,
  type RobotKlinicosPruebaResultado,
  useProcesarConsultaRobotPrueba,
  useGetConsultaProcesoRobot,
  useReintentarConsultaProcesoRobot,
  useGetSaludConsultasRobot,
  useListProcesosPendientesConfiguracion,
  getListProcesosPendientesConfiguracionQueryKey,
  type RobotConsultaProcesoResultado,
  useGetSupervisorTotp,
  useGenerarSupervisorTotp,
  getGetSupervisorTotpQueryKey,
  useGetKlinicosAutoencolado,
  useSetKlinicosAutoencolado,
  getGetKlinicosAutoencoladoQueryKey,
} from "@workspace/api-client-react";
import { QRCodeSVG } from "qrcode.react";
import { useAuth } from "@/hooks/use-auth";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Switch } from "@/components/ui/switch";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import {
  Bot,
  RefreshCw,
  Loader2,
  CheckCircle2,
  AlertTriangle,
  Clock,
  Pencil,
  Plus,
  XCircle,
  Trash2,
  FileText,
  Download,
  CloudUpload,
  Cloud,
} from "lucide-react";

function authHeaders(extra?: Record<string, string>): Record<string, string> {
  return {
    Authorization: `Bearer ${localStorage.getItem("auth_token") ?? ""}`,
    ...extra,
  };
}

function formatoFecha(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("es-AR", { dateStyle: "short", timeStyle: "short" });
}

const ESTADO_BADGE: Record<string, { label: string; className: string }> = {
  pendiente: { label: "Pendiente", className: "bg-amber-100 text-amber-800 border-amber-200" },
  en_proceso: { label: "En proceso", className: "bg-blue-100 text-blue-800 border-blue-200" },
  completado: { label: "Completado", className: "bg-emerald-100 text-emerald-800 border-emerald-200" },
  esperando_aprobacion: { label: "Esperando aprobación", className: "bg-violet-100 text-violet-800 border-violet-200" },
  error: { label: "Error", className: "bg-red-100 text-red-800 border-red-200" },
  cancelado: { label: "Cancelado", className: "bg-muted text-muted-foreground border-border" },
  anulacion_pendiente: { label: "Anulación pendiente", className: "bg-orange-100 text-orange-800 border-orange-200" },
  anulado: { label: "Anulado", className: "bg-muted text-muted-foreground border-border" },
};

function EstadoBadge({ estado }: { estado: string }) {
  const cfg = ESTADO_BADGE[estado] ?? { label: estado, className: "" };
  return (
    <Badge variant="outline" className={cfg.className} data-testid={`badge-estado-${estado}`}>
      {cfg.label}
    </Badge>
  );
}

function TrabajoEditDialog({
  trabajo,
  onClose,
}: {
  trabajo: KlinicosTrabajo;
  onClose: () => void;
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const update = useUpdateKlinicosTrabajo();
  const [consultaPor, setConsultaPor] = useState(trabajo.consultaPor ?? "");
  const [cie10, setCie10] = useState(trabajo.cie10Codigo ?? "");
  const [cie10Desc, setCie10Desc] = useState(trabajo.cie10Descripcion ?? "");
  const [codigos, setCodigos] = useState((trabajo.practicaCodigos ?? []).join(", "));
  const [efector, setEfector] = useState(trabajo.efectorNombre ?? "");
  const [token, setToken] = useState(trabajo.tokenAutorizacion ?? "");
  const [sector, setSector] = useState(trabajo.sectorServicio);

  const guardar = () => {
    update.mutate(
      {
        id: trabajo.id,
        data: {
          consultaPor: consultaPor || undefined,
          cie10Codigo: cie10 || undefined,
          cie10Descripcion: cie10Desc || undefined,
          practicaCodigos: codigos
            ? codigos.split(",").map((c) => c.trim()).filter(Boolean)
            : undefined,
          efectorNombre: efector || undefined,
          tokenAutorizacion: token.trim() || undefined,
          sectorServicio: sector,
        },
      },
      {
        onSuccess: () => {
          toast({ title: "Trabajo actualizado" });
          queryClient.invalidateQueries({ queryKey: getListKlinicosTrabajosQueryKey() });
          onClose();
        },
        onError: () => toast({ title: "No se pudo actualizar", variant: "destructive" }),
      },
    );
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Revisar trabajo #{trabajo.id}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <Label>Sector / Servicio</Label>
            <Select value={sector} onValueChange={setSector}>
              <SelectTrigger data-testid="select-sector">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="CONSULTORIO">CONSULTORIO</SelectItem>
                <SelectItem value="IMAGENES S/C">IMÁGENES S/C</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label>Consulta por</Label>
            <Textarea
              value={consultaPor}
              onChange={(e) => setConsultaPor(e.target.value)}
              rows={2}
              data-testid="input-consulta-por"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>CIE-10</Label>
              <Input value={cie10} onChange={(e) => setCie10(e.target.value)} data-testid="input-cie10" />
            </div>
            <div>
              <Label>Descripción CIE-10</Label>
              <Input value={cie10Desc} onChange={(e) => setCie10Desc(e.target.value)} />
            </div>
          </div>
          <div>
            <Label>Códigos de práctica (separados por coma)</Label>
            <Input value={codigos} onChange={(e) => setCodigos(e.target.value)} data-testid="input-codigos" />
          </div>
          <div>
            <Label>Efector</Label>
            <Input value={efector} onChange={(e) => setEfector(e.target.value)} data-testid="input-efector" />
          </div>
          {sector === "IMAGENES S/C" && (
            <div>
              <Label>Token de autorización IOMA</Label>
              <Input
                value={token}
                onChange={(e) => setToken(e.target.value)}
                placeholder="Se lo da el paciente en recepción"
                data-testid="input-token-autorizacion"
              />
              <p className="text-xs text-muted-foreground mt-1">
                El paciente lo genera en su app IOMA y se lo da a la recepcionista — es el único paso humano del circuito.
              </p>
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancelar
          </Button>
          <Button onClick={guardar} disabled={update.isPending} data-testid="button-guardar-trabajo">
            {update.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
            Guardar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function PracticaDialog({
  practica,
  onClose,
}: {
  practica: KlinicosPractica | null; // null = nueva
  onClose: () => void;
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const crear = useCreateKlinicosPractica();
  const editar = useUpdateKlinicosPractica();
  const [nombre, setNombre] = useState(practica?.nombre ?? "");
  const [categoria, setCategoria] = useState(practica?.categoria ?? "");
  const [codigos, setCodigos] = useState((practica?.codigos ?? []).join(", "));
  const [codigoEnvio, setCodigoEnvio] = useState(practica?.codigoEnvio ?? "");
  const [efector, setEfector] = useState(practica?.efectorNombre ?? "");

  const pending = crear.isPending || editar.isPending;

  const guardar = () => {
    const data = {
      nombre,
      categoria: categoria || undefined,
      codigos: codigos.split(",").map((c) => c.trim()).filter(Boolean),
      codigoEnvio: codigoEnvio.trim() || undefined,
      efectorNombre: efector || undefined,
    };
    if (!data.nombre || data.codigos.length === 0) {
      toast({ title: "Nombre y al menos un código son obligatorios", variant: "destructive" });
      return;
    }
    const opts = {
      onSuccess: () => {
        toast({ title: "Práctica guardada" });
        queryClient.invalidateQueries({ queryKey: getListKlinicosPracticasQueryKey() });
        onClose();
      },
      onError: () => toast({ title: "No se pudo guardar", variant: "destructive" }),
    };
    if (practica) {
      editar.mutate({ id: practica.id, data }, opts);
    } else {
      crear.mutate({ data }, opts);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{practica ? "Editar práctica" : "Nueva práctica"}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <Label>Nombre</Label>
            <Input value={nombre} onChange={(e) => setNombre(e.target.value)} data-testid="input-practica-nombre" />
          </div>
          <div>
            <Label>Categoría</Label>
            <Input value={categoria} onChange={(e) => setCategoria(e.target.value)} />
          </div>
          <div>
            <Label>Códigos IOMA (separados por coma, hasta 4)</Label>
            <Input value={codigos} onChange={(e) => setCodigos(e.target.value)} data-testid="input-practica-codigos" />
          </div>
          <div>
            <Label>Código de envío a Conectar (tal cual la planilla)</Label>
            <Input
              value={codigoEnvio}
              onChange={(e) => setCodigoEnvio(e.target.value)}
              placeholder='Ej: 290101-290102-420102 o 881841/A+881841/B'
              data-testid="input-practica-codigo-envio"
            />
            <p className="text-xs text-muted-foreground mt-1">
              Es el practice_code exacto que viaja en la validación del token. Si queda vacío, el caso pasa a revisión manual.
            </p>
          </div>
          <div>
            <Label>Efector (profesional en Klinicos)</Label>
            <Input value={efector} onChange={(e) => setEfector(e.target.value)} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancelar
          </Button>
          <Button onClick={guardar} disabled={pending} data-testid="button-guardar-practica">
            {pending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
            Guardar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function PrescriptorDialog({
  prescriptor,
  onClose,
}: {
  prescriptor: KlinicosPrescriptor | null; // null = nuevo
  onClose: () => void;
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const crear = useCreateKlinicosPrescriptor();
  const editar = useUpdateKlinicosPrescriptor();
  const [nombre, setNombre] = useState(prescriptor?.nombre ?? "");
  const [matricula, setMatricula] = useState(prescriptor?.matricula ?? "");
  const [especialidad, setEspecialidad] = useState(prescriptor?.especialidad ?? "");
  const [esGinecologo, setEsGinecologo] = useState(prescriptor?.esGinecologo ?? false);
  const [activo, setActivo] = useState(prescriptor?.activo ?? true);

  const pending = crear.isPending || editar.isPending;

  const guardar = () => {
    if (!nombre.trim()) {
      toast({ title: "El nombre es obligatorio", variant: "destructive" });
      return;
    }
    const data = {
      nombre: nombre.trim(),
      matricula: matricula.trim() || null,
      especialidad: especialidad.trim() || null,
      esGinecologo,
      activo,
    };
    const opts = {
      onSuccess: () => {
        toast({ title: "Prescriptor guardado" });
        queryClient.invalidateQueries({ queryKey: getListKlinicosPrescriptoresQueryKey() });
        onClose();
      },
      onError: () => toast({ title: "No se pudo guardar", variant: "destructive" }),
    };
    if (prescriptor) {
      editar.mutate({ id: prescriptor.id, data }, opts);
    } else {
      crear.mutate({ data }, opts);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{prescriptor ? "Editar prescriptor" : "Nuevo prescriptor"}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <Label>Nombre (tal como figura en Klinicos)</Label>
            <Input value={nombre} onChange={(e) => setNombre(e.target.value)} data-testid="input-prescriptor-nombre" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Matrícula (ej: MP 12345)</Label>
              <Input value={matricula} onChange={(e) => setMatricula(e.target.value)} data-testid="input-prescriptor-matricula" />
            </div>
            <div>
              <Label>Especialidad</Label>
              <Input value={especialidad} onChange={(e) => setEspecialidad(e.target.value)} data-testid="input-prescriptor-especialidad" />
            </div>
          </div>
          <p className="text-xs text-muted-foreground">
            Klinicos exige nombre, especialidad y matrícula para el prescriptor externo al establecimiento.
          </p>
          <label className="flex items-center gap-2 text-sm cursor-pointer">
            <input
              type="checkbox"
              checked={esGinecologo}
              onChange={(e) => setEsGinecologo(e.target.checked)}
              data-testid="check-prescriptor-ginecologo"
            />
            Es ginecólogo/a (no se asigna a pacientes varones)
          </label>
          <label className="flex items-center gap-2 text-sm cursor-pointer">
            <input
              type="checkbox"
              checked={activo}
              onChange={(e) => setActivo(e.target.checked)}
              data-testid="check-prescriptor-activo"
            />
            Activo en la rotación
          </label>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancelar
          </Button>
          <Button onClick={guardar} disabled={pending} data-testid="button-guardar-prescriptor">
            {pending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
            Guardar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

const ESPECIALIDADES_KLINICOS = [
  "ANATOMIA PATOLOGICA",
  "CARDIOLOGIA",
  "CIRUGIA",
  "CLINICA MEDICA",
  "DERMATOLOGIA",
  "ENDOCRINOLOGIA",
  "FLEBOLOGIA",
  "GASTROENTEROLOGIA",
  "GINECOLOGIA",
  "IMAGENES",
  "IMAGENES S/C",
  "MEDICINA GENERAL Y/O DE FAMILIA",
  "OFTALMOLOGIA",
  "ONCOLOGIA",
  "ORTOPEDIA Y TRAUMATOLOGIA",
  "OTORRINOLARINGOLOGIA",
  "PEDIATRIA-LACTANTES",
  "REUMATOLOGIA",
  "UROLOGIA",
];

function AutoencoladoSwitch() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { data } = useGetKlinicosAutoencolado();
  const setAuto = useSetKlinicosAutoencolado({
    mutation: {
      onSuccess: () => {
        void queryClient.invalidateQueries({ queryKey: getGetKlinicosAutoencoladoQueryKey() });
      },
      onError: () => toast({ title: "No se pudo cambiar", variant: "destructive" }),
    },
  });
  const activo = data?.activo ?? true;
  return (
    <Card className={activo ? "" : "border-amber-300 bg-amber-50 dark:bg-amber-950/30"}>
      <CardContent className="pt-4 pb-4 flex items-center justify-between gap-4">
        <div>
          <p className="text-sm font-medium">Envíos automáticos a Klinicos</p>
          <p className="text-xs text-muted-foreground">
            {activo
              ? "Al reservar o recepcionar, los trabajos se encolan solos."
              : "Apagados: no se crean trabajos automáticamente. El botón manual de encolar sigue funcionando."}
          </p>
        </div>
        <Switch
          checked={activo}
          disabled={setAuto.isPending || data === undefined}
          onCheckedChange={(v) => setAuto.mutate({ data: { activo: v } })}
          data-testid="switch-autoencolado"
        />
      </CardContent>
    </Card>
  );
}

function EqEspecialidadesSection() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { data: equivalencias } = useListKlinicosEqEspecialidades();
  const { data: especialidades } = useListEspecialidades();
  const upsert = useUpsertKlinicosEqEspecialidad();
  const [nueva, setNueva] = useState({ especialidadId: "", klinicosEspecialidad: "" });

  const invalidar = () =>
    queryClient.invalidateQueries({ queryKey: getListKlinicosEqEspecialidadesQueryKey() });

  const guardar = () => {
    if (!nueva.especialidadId || !nueva.klinicosEspecialidad.trim()) return;
    upsert.mutate(
      {
        data: {
          especialidadId: Number(nueva.especialidadId),
          klinicosEspecialidad: nueva.klinicosEspecialidad.trim().toUpperCase(),
        },
      },
      {
        onSuccess: () => {
          toast({ title: "Equivalencia guardada" });
          setNueva({ especialidadId: "", klinicosEspecialidad: "" });
          invalidar();
        },
        onError: () => toast({ title: "No se pudo guardar la equivalencia", variant: "destructive" }),
      },
    );
  };

  const toggleActivo = (eq: { especialidadId: number; klinicosEspecialidad: string; activo: boolean }) =>
    upsert.mutate(
      {
        data: {
          especialidadId: eq.especialidadId,
          klinicosEspecialidad: eq.klinicosEspecialidad,
          activo: !eq.activo,
        },
      },
      { onSuccess: invalidar, onError: () => toast({ title: "No se pudo actualizar", variant: "destructive" }) },
    );

  const sinEquivalencia = (especialidades ?? []).filter(
    (e) => !equivalencias?.some((eq) => eq.especialidadId === e.id && eq.activo),
  );

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Especialidad propia → Especialidad Klinicos</CardTitle>
        <CardDescription>
          El nombre EXACTO que Klinicos usa en el desplegable "Especialidad" del ingreso ambulatorio. Sin
          equivalencia activa, el trabajo queda con la alerta "sin equivalencia de especialidad".
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex gap-2 flex-wrap items-end">
          <div className="flex-1 min-w-56">
            <Label>Especialidad nuestra</Label>
            <Select
              value={nueva.especialidadId}
              onValueChange={(v) => setNueva((r) => ({ ...r, especialidadId: v }))}
            >
              <SelectTrigger data-testid="select-eq-especialidad">
                <SelectValue placeholder="Elegir especialidad" />
              </SelectTrigger>
              <SelectContent>
                {(especialidades ?? []).map((e) => (
                  <SelectItem key={e.id} value={String(e.id)}>
                    {e.nombre}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex-1 min-w-56">
            <Label>Nombre en Klinicos</Label>
            <Input
              value={nueva.klinicosEspecialidad}
              onChange={(e) => setNueva((r) => ({ ...r, klinicosEspecialidad: e.target.value }))}
              placeholder="ej: CLINICA MEDICA"
              list="klinicos-especialidades-conocidas"
              data-testid="input-eq-klinicos"
            />
            <datalist id="klinicos-especialidades-conocidas">
              {ESPECIALIDADES_KLINICOS.map((n) => (
                <option key={n} value={n} />
              ))}
            </datalist>
          </div>
          <Button onClick={guardar} disabled={upsert.isPending} data-testid="button-guardar-eq">
            {upsert.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : "Guardar"}
          </Button>
        </div>
        <div className="divide-y border rounded-md">
          {(equivalencias ?? []).map((eq) => (
            <div key={eq.id} className="flex items-center justify-between gap-2 px-3 py-2 text-sm">
              <span className="truncate">{eq.especialidadNombre ?? `Especialidad #${eq.especialidadId}`}</span>
              <div className="flex items-center gap-2">
                <Badge variant={eq.activo ? "secondary" : "outline"}>{eq.klinicosEspecialidad}</Badge>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => toggleActivo(eq)}
                  data-testid={`button-toggle-eq-${eq.especialidadId}`}
                >
                  {eq.activo ? "Desactivar" : "Activar"}
                </Button>
              </div>
            </div>
          ))}
          {(equivalencias ?? []).length === 0 && (
            <div className="px-3 py-4 text-sm text-muted-foreground">Todavía no hay equivalencias cargadas.</div>
          )}
        </div>
        {sinEquivalencia.length > 0 && (
          <p className="text-xs text-muted-foreground">
            Sin equivalencia todavía ({sinEquivalencia.length}):{" "}
            {sinEquivalencia
              .slice(0, 12)
              .map((e) => e.nombre)
              .join(", ")}
            {sinEquivalencia.length > 12 ? "…" : ""}
          </p>
        )}
      </CardContent>
    </Card>
  );
}

function ReglasPracticaSection({ practicas }: { practicas: KlinicosPractica[] | undefined }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { data: reglas } = useListKlinicosReglasPractica();
  const crear = useCreateKlinicosReglaPractica();
  const actualizar = useUpdateKlinicosReglaPractica();
  const eliminar = useDeleteKlinicosReglaPractica();
  const [nueva, setNueva] = useState({ especialidad: "", patronMotivo: "", practicaId: "" });

  const invalidar = () =>
    queryClient.invalidateQueries({ queryKey: getListKlinicosReglasPracticaQueryKey() });

  const nombrePractica = (id: number) =>
    practicas?.find((p) => p.id === id)?.nombre ?? `Práctica #${id}`;

  const agregar = () => {
    if (!nueva.especialidad.trim() || !nueva.practicaId) return;
    crear.mutate(
      {
        data: {
          especialidad: nueva.especialidad.trim(),
          patronMotivo: nueva.patronMotivo.trim() || null,
          practicaId: Number(nueva.practicaId),
        },
      },
      {
        onSuccess: () => {
          toast({ title: "Regla de práctica creada" });
          setNueva({ especialidad: "", patronMotivo: "", practicaId: "" });
          invalidar();
        },
        onError: () => toast({ title: "No se pudo crear la regla", variant: "destructive" }),
      },
    );
  };

  const toggleActivo = (r: KlinicosReglaPractica) =>
    actualizar.mutate(
      {
        id: r.id,
        data: {
          especialidad: r.especialidad,
          patronMotivo: r.patronMotivo ?? null,
          practicaId: r.practicaId,
          prioridad: r.prioridad,
          activo: !r.activo,
        },
      },
      { onSuccess: invalidar, onError: () => toast({ title: "No se pudo actualizar", variant: "destructive" }) },
    );

  const borrar = (id: number) =>
    eliminar.mutate(
      { id },
      { onSuccess: invalidar, onError: () => toast({ title: "No se pudo eliminar", variant: "destructive" }) },
    );

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Especialidad → Práctica</CardTitle>
        <CardDescription>
          Regla fija: cuando el turno recepcionado es de esta especialidad (y opcionalmente el motivo
          contiene el patrón), el robot usa esta práctica directamente sin consultar la IA.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex gap-2 flex-wrap items-end">
          <div className="flex-1 min-w-40">
            <Label>Especialidad</Label>
            <Input
              value={nueva.especialidad}
              onChange={(e) => setNueva((n) => ({ ...n, especialidad: e.target.value }))}
              placeholder="ej: ECOGRAFIA"
              data-testid="input-regla-practica-especialidad"
            />
          </div>
          <div className="flex-1 min-w-40">
            <Label>Patrón en motivo (opcional)</Label>
            <Input
              value={nueva.patronMotivo}
              onChange={(e) => setNueva((n) => ({ ...n, patronMotivo: e.target.value }))}
              placeholder="ej: abdominal"
              data-testid="input-regla-practica-patron"
            />
          </div>
          <div className="w-64">
            <Label>Práctica</Label>
            <Select
              value={nueva.practicaId}
              onValueChange={(v) => setNueva((n) => ({ ...n, practicaId: v }))}
            >
              <SelectTrigger data-testid="select-regla-practica">
                <SelectValue placeholder="Elegir práctica" />
              </SelectTrigger>
              <SelectContent>
                {practicas?.map((p) => (
                  <SelectItem key={p.id} value={String(p.id)}>
                    {p.nombre}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Button onClick={agregar} disabled={crear.isPending} data-testid="button-agregar-regla-practica">
            {crear.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : "Agregar"}
          </Button>
        </div>
        {!reglas?.length ? (
          <div className="py-6 text-center text-sm text-muted-foreground">
            Sin reglas. El robot resuelve la práctica por nombre y, si no matchea, con IA.
          </div>
        ) : (
          <div className="divide-y border rounded-md">
            {reglas.map((r) => (
              <div key={r.id} className="flex items-center justify-between px-3 py-2 text-sm gap-2">
                <div className="min-w-0 flex items-center gap-2 flex-wrap">
                  <span className={`font-medium ${r.activo ? "" : "text-muted-foreground line-through"}`}>
                    {r.especialidad}
                  </span>
                  {r.patronMotivo && (
                    <Badge variant="outline" className="text-xs">motivo: {r.patronMotivo}</Badge>
                  )}
                  <span className="text-muted-foreground">→ {nombrePractica(r.practicaId)}</span>
                  {!r.activo && <Badge variant="secondary">Inactiva</Badge>}
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <Button size="sm" variant="ghost" onClick={() => toggleActivo(r)} data-testid={`button-toggle-regla-practica-${r.id}`}>
                    {r.activo ? "Desactivar" : "Activar"}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => borrar(r.id)} data-testid={`button-borrar-regla-practica-${r.id}`}>
                    <Trash2 className="h-3.5 w-3.5 text-red-600" />
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function ReglasCie10Section() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { data: reglas } = useListKlinicosReglasCie10();
  const crear = useCreateKlinicosReglaCie10();
  const actualizar = useUpdateKlinicosReglaCie10();
  const eliminar = useDeleteKlinicosReglaCie10();
  const [nueva, setNueva] = useState({ patron: "", cie10Codigo: "", cie10Descripcion: "", consultaPor: "" });

  const invalidar = () =>
    queryClient.invalidateQueries({ queryKey: getListKlinicosReglasCie10QueryKey() });

  const agregar = () => {
    if (!nueva.patron.trim() || !nueva.cie10Codigo.trim() || !nueva.cie10Descripcion.trim()) return;
    crear.mutate(
      {
        data: {
          patron: nueva.patron.trim(),
          cie10Codigo: nueva.cie10Codigo.trim().toUpperCase(),
          cie10Descripcion: nueva.cie10Descripcion.trim(),
          consultaPor: nueva.consultaPor.trim() || null,
        },
      },
      {
        onSuccess: () => {
          toast({ title: "Equivalencia CIE-10 creada" });
          setNueva({ patron: "", cie10Codigo: "", cie10Descripcion: "", consultaPor: "" });
          invalidar();
        },
        onError: () => toast({ title: "No se pudo crear la equivalencia", variant: "destructive" }),
      },
    );
  };

  const toggleActivo = (r: KlinicosReglaCie10) =>
    actualizar.mutate(
      {
        id: r.id,
        data: {
          patron: r.patron,
          cie10Codigo: r.cie10Codigo,
          cie10Descripcion: r.cie10Descripcion,
          consultaPor: r.consultaPor ?? null,
          prioridad: r.prioridad,
          activo: !r.activo,
        },
      },
      { onSuccess: invalidar, onError: () => toast({ title: "No se pudo actualizar", variant: "destructive" }) },
    );

  const borrar = (id: number) =>
    eliminar.mutate(
      { id },
      { onSuccess: invalidar, onError: () => toast({ title: "No se pudo eliminar", variant: "destructive" }) },
    );

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Motivo → CIE-10</CardTitle>
        <CardDescription>
          Equivalencia fija: si el motivo del turno contiene el patrón, se usa este diagnóstico CIE-10
          directamente. La IA solo actúa de respaldo cuando ningún patrón matchea.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex gap-2 flex-wrap items-end">
          <div className="flex-1 min-w-40">
            <Label>Patrón en motivo</Label>
            <Input
              value={nueva.patron}
              onChange={(e) => setNueva((n) => ({ ...n, patron: e.target.value }))}
              placeholder="ej: control embarazo"
              data-testid="input-regla-cie10-patron"
            />
          </div>
          <div className="w-28">
            <Label>Código</Label>
            <Input
              value={nueva.cie10Codigo}
              onChange={(e) => setNueva((n) => ({ ...n, cie10Codigo: e.target.value }))}
              placeholder="Z34"
              data-testid="input-regla-cie10-codigo"
            />
          </div>
          <div className="flex-1 min-w-48">
            <Label>Descripción</Label>
            <Input
              value={nueva.cie10Descripcion}
              onChange={(e) => setNueva((n) => ({ ...n, cie10Descripcion: e.target.value }))}
              placeholder="Supervisión de embarazo normal"
              data-testid="input-regla-cie10-descripcion"
            />
          </div>
          <div className="flex-1 min-w-40">
            <Label>Consulta por (opcional)</Label>
            <Input
              value={nueva.consultaPor}
              onChange={(e) => setNueva((n) => ({ ...n, consultaPor: e.target.value }))}
              placeholder="Texto para Klinicos"
              data-testid="input-regla-cie10-consulta"
            />
          </div>
          <Button onClick={agregar} disabled={crear.isPending} data-testid="button-agregar-regla-cie10">
            {crear.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : "Agregar"}
          </Button>
        </div>
        {!reglas?.length ? (
          <div className="py-6 text-center text-sm text-muted-foreground">
            Sin equivalencias. El robot resuelve el CIE-10 con IA.
          </div>
        ) : (
          <div className="divide-y border rounded-md">
            {reglas.map((r) => (
              <div key={r.id} className="flex items-center justify-between px-3 py-2 text-sm gap-2">
                <div className="min-w-0 flex items-center gap-2 flex-wrap">
                  <span className={`font-medium ${r.activo ? "" : "text-muted-foreground line-through"}`}>
                    “{r.patron}”
                  </span>
                  <Badge variant="outline">{r.cie10Codigo}</Badge>
                  <span className="text-muted-foreground truncate">{r.cie10Descripcion}</span>
                  {r.consultaPor && (
                    <span className="text-xs text-muted-foreground">· Consulta por: {r.consultaPor}</span>
                  )}
                  {!r.activo && <Badge variant="secondary">Inactiva</Badge>}
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <Button size="sm" variant="ghost" onClick={() => toggleActivo(r)} data-testid={`button-toggle-regla-cie10-${r.id}`}>
                    {r.activo ? "Desactivar" : "Activar"}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => borrar(r.id)} data-testid={`button-borrar-regla-cie10-${r.id}`}>
                    <Trash2 className="h-3.5 w-3.5 text-red-600" />
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ── Prueba administrativa de validación de token IOMA contra El Robot ────
// Spec jul-2026: pantalla admin de prueba con progreso escalonado, timeout UI
// de 35s, contingencia ámbar MANUAL_PRESTATION_REQUIRED con acciones y
// reintento con el MISMO request_id. No toca turnos ni consultas.

const CAMPOS_FALTANTES_ES: Record<string, string> = {
  practice_code: "Práctica",
  professional_name: "Profesional",
  professional_id: "Profesional",
  diagnosis_code: "Diagnóstico CIE-10",
  affiliate_number: "Número de afiliado",
  "patient.affiliate_number": "Número de afiliado",
  specialty_code: "Especialidad",
  institution_id: "Sede",
};

const TIMEOUT_UI_MS = 35_000;
const POLLING_PROCESSING_MS = 4_000;

function formatoEspera(segundos: number): string {
  if (segundos < 60) return `${segundos} s`;
  const min = Math.round(segundos / 60);
  return `${min} min`;
}

// Descarga autenticada de los catálogos CSV para el mapeo del Robot.
async function descargarCatalogoCsv(recurso: "practicas" | "profesionales"): Promise<void> {
  const base = import.meta.env.BASE_URL.replace(/\/$/, "");
  const res = await fetch(`${base}/api/robot-klinicos/catalogo/${recurso}?formato=csv`, {
    headers: authHeaders(),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `catalogo_${recurso}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function mensajeProgreso(segundos: number): string {
  if (segundos < 5) return "Enviando solicitud a KLINICOS…";
  if (segundos < 15) return "Buscando la prestación del paciente…";
  return "Esperando la respuesta de KLINICOS…";
}

// Textos por estado del flujo consultations/process (contrato definitivo).
// Regla: TOKEN_DENIED es el ÚNICO rechazo real. DATA_REQUIRED, MAPPING_REQUIRED,
// MANUAL_REVIEW y TECHNICAL_ERROR NUNCA se presentan como rechazo.
const PROCESO_ESTADO_UI: Record<
  string,
  { titulo: string; tono: "ok" | "rechazo" | "espera" | "accion" }
> = {
  PROCESSING: { titulo: "En proceso", tono: "espera" },
  TOKEN_ACCEPTED: { titulo: "Token aceptado — consulta habilitada", tono: "ok" },
  TOKEN_DENIED: { titulo: "Token denegado por IOMA", tono: "rechazo" },
  DATA_REQUIRED: { titulo: "Faltan datos (no es un rechazo)", tono: "accion" },
  MAPPING_REQUIRED: { titulo: "Falta equivalencia aprobada (no es un rechazo)", tono: "accion" },
  MANUAL_REVIEW: { titulo: "En revisión técnica (no es un rechazo)", tono: "espera" },
  TOKEN_REENTRY_REQUIRED: {
    titulo: "El token venció — reingresar un token nuevo",
    tono: "accion",
  },
  TECHNICAL_ERROR: { titulo: "Error técnico (no es un rechazo)", tono: "accion" },
  ERROR_COMUNICACION: { titulo: "No se pudo comunicar con el Robot", tono: "accion" },
};

const TONO_CLASES: Record<string, string> = {
  ok: "border-emerald-200 bg-emerald-50 text-emerald-900",
  rechazo: "border-red-200 bg-red-50 text-red-900",
  espera: "border-blue-200 bg-blue-50 text-blue-900",
  accion: "border-amber-200 bg-amber-50 text-amber-900",
};

// Bandeja "Pendiente de configuración": casos productivos frenados por
// MAPPING_REQUIRED. Solo admin. Sin DNI ni afiliado (el backend ya los omite).
function PendientesConfiguracionCard() {
  const queryClient = useQueryClient();
  const { data, isLoading, isFetching } = useListProcesosPendientesConfiguracion();
  const pendientes = data?.pendientes ?? [];
  return (
    <Card data-testid="card-pendientes-configuracion">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="text-base flex items-center gap-2">
              Pendiente de configuración
              {pendientes.length > 0 && (
                <Badge className="bg-amber-100 text-amber-800 border-amber-200" variant="outline">
                  {pendientes.length}
                </Badge>
              )}
            </CardTitle>
            <CardDescription>
              Atenciones productivas frenadas porque falta una equivalencia aprobada en el
              Robot (práctica, sede o profesional). Al aprobar la equivalencia NO se
              reintenta nada automáticamente: el caso queda disponible en la consola del
              operador, que reintenta solo si el paciente sigue presente (mismo request_id;
              si el token venció se pide uno nuevo).
            </CardDescription>
          </div>
          <Button
            size="sm"
            variant="outline"
            disabled={isFetching}
            onClick={() =>
              void queryClient.invalidateQueries({
                queryKey: getListProcesosPendientesConfiguracionQueryKey(),
              })
            }
            data-testid="pendientes-config-refrescar"
          >
            {isFetching ? "Actualizando…" : "Actualizar"}
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <p className="text-sm text-muted-foreground">Cargando…</p>
        ) : pendientes.length === 0 ? (
          <p className="text-sm text-muted-foreground" data-testid="pendientes-config-vacio">
            No hay casos pendientes de configuración.
          </p>
        ) : (
          <div className="space-y-2">
            {pendientes.map((p) => (
              <div
                key={p.requestId}
                className="rounded-md border border-amber-200 bg-amber-50 p-3 text-xs space-y-1"
                data-testid={`pendiente-config-${p.requestId}`}
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium text-amber-900">
                    {p.paciente ?? "Paciente sin identificar"}
                  </span>
                  {p.turnoId != null && <Badge variant="outline">Turno #{p.turnoId}</Badge>}
                  {p.actualizadoEn && (
                    <span className="text-amber-700 ml-auto">
                      {new Date(p.actualizadoEn).toLocaleString("es-AR")}
                    </span>
                  )}
                </div>
                <dl className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-amber-900">
                  <div className="flex gap-1">
                    <dt className="text-amber-700 shrink-0">practice.id:</dt>
                    <dd className="font-mono">{p.practiceId ?? "—"}</dd>
                  </div>
                  <div className="flex gap-1">
                    <dt className="text-amber-700 shrink-0">Código:</dt>
                    <dd className="font-mono">{p.practiceCode ?? "—"}</dd>
                  </div>
                  <div className="flex gap-1 min-w-0">
                    <dt className="text-amber-700 shrink-0">Descripción:</dt>
                    <dd className="truncate">{p.practiceDescripcion ?? "—"}</dd>
                  </div>
                  <div className="flex gap-1 min-w-0">
                    <dt className="text-amber-700 shrink-0">Especialidad requerida:</dt>
                    <dd className="truncate">{p.especialidad ?? "—"}</dd>
                  </div>
                </dl>
                {(p.mapeosPendientes?.length ?? 0) > 0 && (
                  <ul className="list-disc list-inside text-amber-800">
                    {p.mapeosPendientes!.map((m, i) => (
                      <li key={i}>
                        {m.kind}: {m.value} — {m.problem}
                      </li>
                    ))}
                  </ul>
                )}
                {p.motivo && <p className="text-amber-800">{p.motivo}</p>}
                <p className="text-amber-700 font-mono">
                  request_id: {p.requestId} · consultation_id: {p.consultationId}
                </p>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ── Semáforo de credenciales de Klinicos ─────────────────────────────────
// Muestra el resultado de la prueba real de login+contexto (caché ~5 min en
// el backend). El botón "Reprobar ahora" (solo gestión) fuerza ?forzar=true:
// descarta la caché y reprueba al momento, para ver el verde apenas se
// corrige la clave sin esperar los 5 minutos.
function CredencialesKlinicosCard() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { data: robotEstado, isLoading } = useGetRobotKlinicosEstado();
  const [reprobando, setReprobando] = useState(false);
  const [ultimaReprueba, setUltimaReprueba] = useState<string | null>(null);

  const reprobar = async () => {
    if (reprobando) return;
    setReprobando(true);
    try {
      const r = await getRobotKlinicosEstado({ forzar: true });
      // Pisar la caché de react-query para que toda la pantalla vea el
      // resultado fresco (el semáforo, la prueba de token, etc.).
      queryClient.setQueryData(getGetRobotKlinicosEstadoQueryKey(), r);
      queryClient.setQueryData(getGetRobotKlinicosEstadoQueryKey({ forzar: true }), r);
      setUltimaReprueba(new Date().toISOString());
      toast(
        r.disponible
          ? { title: "Credenciales OK", description: "Klinicos aceptó el usuario y la clave." }
          : {
              title: "La prueba falló",
              description: r.motivo ?? "Klinicos no aceptó las credenciales.",
              variant: "destructive",
            },
      );
    } catch {
      toast({ title: "No se pudo reprobar las credenciales", variant: "destructive" });
    } finally {
      setReprobando(false);
    }
  };

  const ok = robotEstado?.disponible === true;

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <CardTitle className="text-base">Credenciales de Klinicos</CardTitle>
          <div className="flex items-center gap-2">
            {isLoading ? (
              <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
            ) : ok ? (
              <Badge
                variant="outline"
                className="bg-emerald-100 text-emerald-800 border-emerald-200"
                data-testid="badge-credenciales-klinicos"
              >
                <CheckCircle2 className="h-3 w-3 mr-1" />
                Conexión OK
                {robotEstado?.latenciaMs != null && ` · ${robotEstado.latenciaMs} ms`}
              </Badge>
            ) : (
              <Badge
                variant="outline"
                className="bg-red-100 text-red-800 border-red-200"
                data-testid="badge-credenciales-klinicos"
              >
                <AlertTriangle className="h-3 w-3 mr-1" />
                Sin conexión
              </Badge>
            )}
            <Button
              size="sm"
              variant="outline"
              onClick={reprobar}
              disabled={reprobando}
              data-testid="button-reprobar-credenciales"
            >
              {reprobando ? (
                <Loader2 className="h-4 w-4 mr-1 animate-spin" />
              ) : (
                <RefreshCw className="h-4 w-4 mr-1" />
              )}
              {reprobando ? "Probando…" : "Reprobar ahora"}
            </Button>
          </div>
        </div>
        <CardDescription>
          Prueba real de usuario y clave contra Klinicos (solo lectura). El resultado se guarda
          unos 5 minutos; si corregiste la clave, usá “Reprobar ahora” para verla al instante.
        </CardDescription>
      </CardHeader>
      {(!ok && robotEstado?.motivo) || ultimaReprueba ? (
        <CardContent className="pt-0 space-y-1">
          {!ok && robotEstado?.motivo && (
            <p className="text-sm text-red-700" data-testid="text-motivo-credenciales">
              {robotEstado.motivo}
            </p>
          )}
          {ultimaReprueba && (
            <p className="text-xs text-muted-foreground">
              Última reprueba: {formatoFecha(ultimaReprueba)}
            </p>
          )}
        </CardContent>
      ) : null}
    </Card>
  );
}

function ConsultationsProcessCard() {
  const { toast } = useToast();
  const { data: robotEstado } = useGetRobotKlinicosEstado();
  const habilitado = robotEstado?.consultasProcessHabilitadas === true;
  const procesar = useProcesarConsultaRobotPrueba();
  const reintentar = useReintentarConsultaProcesoRobot();
  const { data: salud, refetch: refrescarSalud, isFetching: saludCargando } =
    useGetSaludConsultasRobot({ query: { enabled: false } });

  const [form, setForm] = useState({
    dni: "",
    practica: "",
    cie10: "",
    cie10Desc: "",
    sedeId: "",
    hora: "",
    cantidad: "1",
    consultaId: "",
    token: "",
  });
  const [resultado, setResultado] = useState<RobotConsultaProcesoResultado | null>(null);
  // Aislamiento de paciente: la respuesta se aplica solo si el DNI en pantalla
  // sigue siendo el de la solicitud en curso.
  const dniSolicitudRef = useRef<string | null>(null);
  const dniActualRef = useRef("");
  dniActualRef.current = form.dni.trim();

  // Polling SOLO mientras el estado sea PROCESSING; se detiene en estado final.
  const enProceso = resultado?.estado === "PROCESSING";
  const { data: pollData } = useGetConsultaProcesoRobot(resultado?.requestId ?? "", {
    query: { enabled: enProceso && !!resultado?.requestId, refetchInterval: POLLING_PROCESSING_MS },
  });
  useEffect(() => {
    if (!enProceso || !pollData) return;
    if (dniSolicitudRef.current !== null && dniSolicitudRef.current !== dniActualRef.current)
      return;
    // ERROR_COMUNICACION durante el polling: seguir esperando sin pisar PROCESSING.
    if (pollData.estado === "ERROR_COMUNICACION") return;
    setResultado(pollData);
  }, [enProceso, pollData]);

  const aplicarRespuesta = (r: RobotConsultaProcesoResultado) => {
    if (dniSolicitudRef.current !== null && dniSolicitudRef.current !== dniActualRef.current) {
      setResultado(null);
      toast({
        title: "Respuesta descartada",
        description:
          "Cambiaste de paciente mientras se procesaba. El resultado pertenece al paciente anterior y no se aplicó.",
      });
      return;
    }
    setResultado(r);
  };

  const enviar = (reenvio = false) => {
    if (procesar.isPending) return;
    dniSolicitudRef.current = form.dni.trim();
    procesar.mutate(
      {
        data: {
          token: form.token.trim(),
          dni: form.dni.trim(),
          practicaCodigo: form.practica.trim(),
          diagnosisCode: form.cie10.trim(),
          diagnosisDescripcion: form.cie10Desc.trim() || null,
          sedeId: form.sedeId.trim() ? Number(form.sedeId) : null,
          hora: form.hora.trim() || null,
          cantidad: form.cantidad.trim() ? Number(form.cantidad) : null,
          consultationId: form.consultaId.trim() || null,
          // Reenvío del MISMO caso (DATA_REQUIRED / TOKEN_REENTRY_REQUIRED /
          // TECHNICAL_ERROR): conserva el request_id.
          requestId: reenvio ? (resultado?.requestId ?? null) : null,
        },
      },
      {
        onSuccess: aplicarRespuesta,
        onError: (e) => {
          const err = e as { status?: number; message?: string };
          toast({
            title:
              err?.status === 409
                ? "consultation_id ya usado con otro request_id"
                : err?.status === 429
                  ? "Hay un proceso en curso o demasiados intentos"
                  : err?.status === 404
                    ? "Paciente o práctica no encontrados en Conectar"
                    : "No se pudo procesar la consulta",
            variant: "destructive",
          });
        },
      },
    );
  };

  const reintentarProceso = () => {
    if (!resultado?.requestId || reintentar.isPending) return;
    reintentar.mutate(
      { requestId: resultado.requestId },
      {
        onSuccess: aplicarRespuesta,
        onError: () => toast({ title: "No se pudo reintentar", variant: "destructive" }),
      },
    );
  };

  const ui = resultado ? PROCESO_ESTADO_UI[resultado.estado] : null;
  const puedeReenviar =
    resultado != null &&
    ["DATA_REQUIRED", "TOKEN_REENTRY_REQUIRED", "TECHNICAL_ERROR", "MAPPING_REQUIRED", "ERROR_COMUNICACION"].includes(
      resultado.estado,
    );
  const puedeRetry = resultado != null && resultado.reintentoPermitido === true && resultado.estado !== "PROCESSING";

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="text-base">
            Procesar consulta (consultations/process) — prueba solo admins
          </CardTitle>
          <Badge
            variant="outline"
            className={
              habilitado
                ? "bg-emerald-100 text-emerald-800 border-emerald-200"
                : "bg-muted text-muted-foreground"
            }
            data-testid="badge-consultations-process-flag"
          >
            {habilitado ? "Flag encendido" : "Flag apagado (circuito productivo inactivo)"}
          </Badge>
        </div>
        <CardDescription>
          Flujo transaccional único del Robot (contrato definitivo 19/07/2026). Usa un paciente
          REAL de Conectar (por DNI), una práctica del catálogo institucional y la sede real. No
          se envían médico, matrícula ni especialidad: el Robot los deriva desde la práctica. El
          token no se guarda ni se registra.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <div>
            <Label htmlFor="proceso-dni">DNI del paciente *</Label>
            <Input
              id="proceso-dni"
              value={form.dni}
              onChange={(e) => setForm({ ...form, dni: e.target.value.replace(/\D/g, "") })}
              data-testid="input-proceso-dni"
            />
          </div>
          <div>
            <Label htmlFor="proceso-practica">Práctica (código del catálogo) *</Label>
            <Input
              id="proceso-practica"
              value={form.practica}
              onChange={(e) => setForm({ ...form, practica: e.target.value })}
              data-testid="input-proceso-practica"
            />
          </div>
          <div>
            <Label htmlFor="proceso-cie10">CIE-10 *</Label>
            <Input
              id="proceso-cie10"
              value={form.cie10}
              onChange={(e) => setForm({ ...form, cie10: e.target.value })}
              data-testid="input-proceso-cie10"
            />
          </div>
          <div>
            <Label htmlFor="proceso-cie10-desc">Diagnóstico (texto)</Label>
            <Input
              id="proceso-cie10-desc"
              value={form.cie10Desc}
              onChange={(e) => setForm({ ...form, cie10Desc: e.target.value })}
              data-testid="input-proceso-cie10-desc"
            />
          </div>
          <div>
            <Label htmlFor="proceso-sede">Sede (ID)</Label>
            <Input
              id="proceso-sede"
              value={form.sedeId}
              onChange={(e) => setForm({ ...form, sedeId: e.target.value.replace(/\D/g, "") })}
              data-testid="input-proceso-sede"
            />
          </div>
          <div>
            <Label htmlFor="proceso-hora">Hora de la atención (HH:mm, hoy)</Label>
            <Input
              id="proceso-hora"
              value={form.hora}
              placeholder="ahora"
              onChange={(e) => setForm({ ...form, hora: e.target.value })}
              data-testid="input-proceso-hora"
            />
          </div>
          <div>
            <Label htmlFor="proceso-cantidad">Cantidad</Label>
            <Input
              id="proceso-cantidad"
              value={form.cantidad}
              onChange={(e) => setForm({ ...form, cantidad: e.target.value.replace(/\D/g, "") })}
              data-testid="input-proceso-cantidad"
            />
          </div>
          <div>
            <Label htmlFor="proceso-consulta-id">ID consulta (opcional)</Label>
            <Input
              id="proceso-consulta-id"
              value={form.consultaId}
              onChange={(e) => setForm({ ...form, consultaId: e.target.value })}
              data-testid="input-proceso-consulta-id"
            />
          </div>
          <div className="col-span-2">
            <Label htmlFor="proceso-token">Token IOMA * (no se guarda)</Label>
            <Input
              id="proceso-token"
              value={form.token}
              onChange={(e) => setForm({ ...form, token: e.target.value })}
              autoComplete="off"
              data-testid="input-proceso-token"
            />
          </div>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <Button
            onClick={() => enviar(false)}
            disabled={
              procesar.isPending ||
              !form.token.trim() ||
              !form.dni.trim() ||
              !form.practica.trim() ||
              !form.cie10.trim()
            }
            data-testid="button-proceso-enviar"
          >
            {procesar.isPending ? "Procesando…" : "Procesar consulta en KLINICOS"}
          </Button>
          {puedeReenviar && !procesar.isPending && (
            <Button
              variant="outline"
              onClick={() => enviar(true)}
              data-testid="button-proceso-reenviar"
            >
              Re-enviar el mismo caso (mismo request_id)
            </Button>
          )}
          {puedeRetry && !reintentar.isPending && (
            <Button
              variant="outline"
              onClick={reintentarProceso}
              data-testid="button-proceso-retry"
            >
              Reintentar con el token guardado
            </Button>
          )}
          <Button
            variant="ghost"
            size="sm"
            onClick={() => refrescarSalud()}
            disabled={saludCargando}
            data-testid="button-proceso-salud"
          >
            <RefreshCw className="h-4 w-4 mr-1" />
            Salud del flujo
          </Button>
        </div>

        {salud && (
          <div
            className="text-xs rounded-md border p-2 text-muted-foreground"
            data-testid="text-proceso-salud"
          >
            Robot: {salud.disponible ? "disponible" : `sin conexión (${salud.mensaje ?? ""})`}
            {salud.habilitadoEnRobot != null &&
              ` · flujo ${salud.habilitadoEnRobot ? "habilitado" : "deshabilitado"} en el Robot`}
            {salud.sandbox === true && " · SANDBOX (simulación, nunca opera KLINICOS real)"}
            {salud.cola?.operacionesPendientes != null &&
              ` · ${salud.cola.operacionesPendientes} operaciones pendientes`}
            {salud.cola?.sesionKlinicosDisponible != null &&
              ` · sesión KLINICOS ${salud.cola.sesionKlinicosDisponible ? "activa" : "caída"}`}
          </div>
        )}

        {resultado && ui && (
          <div
            className={`text-sm rounded-md border p-3 space-y-1.5 ${TONO_CLASES[ui.tono]}`}
            data-testid="text-proceso-resultado"
          >
            <p className="font-medium flex items-center gap-2">
              {resultado.estado === "PROCESSING" && (
                <span className="inline-block h-3 w-3 rounded-full border-2 border-blue-600 border-t-transparent animate-spin" />
              )}
              {ui.titulo}
            </p>
            <p>{resultado.mensaje}</p>
            {resultado.estado === "PROCESSING" && resultado.cola && (
              <p className="text-xs">
                {resultado.cola.posicionAproximada != null &&
                  `Posición aproximada: ${resultado.cola.posicionAproximada}. `}
                {resultado.cola.esperaEstimadaSegundos != null &&
                  `Espera estimada: ${formatoEspera(resultado.cola.esperaEstimadaSegundos)}. `}
                {resultado.cola.sesionKlinicosDisponible === false &&
                  "La sesión de KLINICOS está caída; el Robot la reintentará."}
              </p>
            )}
            {resultado.estado === "DATA_REQUIRED" && resultado.camposFaltantes && resultado.camposFaltantes.length > 0 && (
              <p className="text-xs">Campos faltantes: {resultado.camposFaltantes.join(", ")}</p>
            )}
            {resultado.estado === "MAPPING_REQUIRED" && resultado.mapeosPendientes && resultado.mapeosPendientes.length > 0 && (
              <ul className="text-xs list-disc pl-4">
                {resultado.mapeosPendientes.map((m, i) => (
                  <li key={i}>
                    {m.kind === "practice" ? "Práctica" : "Especialidad"} {m.value}: {m.problem}
                  </li>
                ))}
              </ul>
            )}
            {resultado.estado === "TOKEN_ACCEPTED" && (
              <p className="text-xs">
                {resultado.numeroAutorizacion && `Autorización: ${resultado.numeroAutorizacion}. `}
                {resultado.referenciaKlinicos && `Referencia: ${resultado.referenciaKlinicos}. `}
                {resultado.validadoEn && `Validado: ${formatoFecha(resultado.validadoEn)}.`}
              </p>
            )}
            <p className="text-xs opacity-70">
              request_id: {resultado.requestId} · consulta: {resultado.consultationId} · intento{" "}
              {resultado.intento}
              {resultado.latenciaMs != null && ` · ${resultado.latenciaMs} ms`}
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function PruebaRobotAdminCard() {
  const { toast } = useToast();
  const probar = useProbarRobotKlinicos();
  const registrarCarga = useRegistrarPrestacionCargadaPrueba();
  const { data: robotEstado } = useGetRobotKlinicosEstado();
  const [form, setForm] = useState({
    paciente: "",
    dni: "",
    tipoDoc: "DNI",
    pacienteId: "",
    afiliado: "",
    practica: "",
    profesional: "",
    profesionalId: "",
    especialidad: "",
    sede: "",
    cie10: "",
    consultaId: "",
    token: "",
  });
  const [resultado, setResultado] = useState<RobotKlinicosPruebaResultado | null>(null);
  const [segundos, setSegundos] = useState(0);
  const [timeoutUi, setTimeoutUi] = useState(false);
  const [cargaManual, setCargaManual] = useState<{ usuario: string; fecha: string } | null>(null);
  const [enviadoARevision, setEnviadoARevision] = useState(false);
  const inicioRef = useRef<number>(0);
  // Aislamiento de paciente: DNI con el que se lanzó la solicitud en curso.
  // Si el usuario cambia de paciente mientras espera, la respuesta se descarta
  // visualmente (queda en auditoría del backend) y no se aplica al paciente nuevo.
  const dniSolicitudRef = useRef<string | null>(null);
  // Ref con el DNI vigente (evita comparar contra un closure viejo del form)
  const dniActualRef = useRef("");
  dniActualRef.current = form.dni.trim();

  // Polling de PROCESSING: mientras el Robot procesa la solicitud, se consulta
  // el estado con el MISMO request_id (nunca se re-envía el token). Endpoint
  // provisional hasta el OpenAPI definitivo del Robot.
  const enProcesamiento = resultado?.estado === "PROCESSING";
  const { data: solicitudActual } = useGetRobotKlinicosSolicitud(resultado?.requestId ?? "", {
    query: {
      enabled: enProcesamiento && !!resultado?.requestId,
      refetchInterval: POLLING_PROCESSING_MS,
    },
  });
  useEffect(() => {
    if (!enProcesamiento || !solicitudActual) return;
    // Aislamiento de paciente: mismo criterio que la validación inicial.
    if (dniSolicitudRef.current !== null && dniSolicitudRef.current !== dniActualRef.current) return;
    // El polling provisional puede devolver TECHNICAL_ERROR mientras el Robot
    // no publique el endpoint: en ese caso se sigue esperando sin pisar el
    // estado PROCESSING (el resultado final llegará cuando esté disponible).
    if (solicitudActual.estado === "TECHNICAL_ERROR") return;
    if (solicitudActual.estado !== "PROCESSING" || solicitudActual.posicionCola != null) {
      setResultado(solicitudActual);
    }
  }, [enProcesamiento, solicitudActual]);

  // Cronómetro de progreso mientras la solicitud está activa
  useEffect(() => {
    if (!probar.isPending) return;
    inicioRef.current = Date.now();
    setSegundos(0);
    setTimeoutUi(false);
    const int = setInterval(() => {
      const s = Math.floor((Date.now() - inicioRef.current) / 1000);
      setSegundos(s);
      if (s * 1000 >= TIMEOUT_UI_MS) setTimeoutUi(true);
    }, 500);
    return () => clearInterval(int);
  }, [probar.isPending]);

  const ejecutar = (reintento = false) => {
    if (probar.isPending) return;
    if (!reintento) {
      setCargaManual(null);
      setEnviadoARevision(false);
    }
    const dniSolicitud = form.dni.trim();
    dniSolicitudRef.current = dniSolicitud;
    probar.mutate(
      {
        data: {
          token: form.token.trim(),
          dni: dniSolicitud,
          documentType: form.tipoDoc.trim() || null,
          patientId: form.pacienteId.trim() || null,
          affiliateNumber: form.afiliado.trim() || null,
          diagnosisCode: form.cie10.trim() || null,
          practiceCode: form.practica.trim() || null,
          professionalId: form.profesionalId.trim() || null,
          professionalName: form.profesional.trim() || null,
          specialtyCode: form.especialidad.trim() || null,
          institutionId: form.sede.trim() || null,
          consultationId: form.consultaId.trim() || null,
          // Reintento controlado: conserva el request_id del intento previo.
          // En timeout de UI también se conserva (no generar otro request_id).
          requestId: reintento ? (resultado?.requestId ?? null) : null,
        },
      },
      {
        onSuccess: (r) => {
          // Aislamiento de paciente: si el DNI cambió durante la espera, no
          // aplicar la respuesta al paciente nuevo (solo se descarta la
          // actualización visual; el backend ya auditó la solicitud original).
          if (dniSolicitudRef.current !== null && dniSolicitudRef.current !== dniActualRef.current) {
            setResultado(null); // limpiar el resultado previo para no mezclar pacientes
            toast({
              title: "Respuesta descartada",
              description:
                "Cambiaste de paciente mientras se validaba. El resultado pertenece al paciente anterior y no se aplicó.",
            });
            return;
          }
          setResultado(r);
        },
        onError: (e) => {
          const err = e as { status?: number };
          toast({
            title:
              err?.status === 429
                ? "Hay una validación en curso o demasiados intentos"
                : "No se pudo ejecutar la prueba",
            variant: "destructive",
          });
        },
      },
    );
  };

  const copiarDatos = async () => {
    const lineas = [
      form.paciente && `Paciente: ${form.paciente}`,
      form.dni && `DNI: ${form.dni}`,
      form.afiliado && `Afiliado: ${form.afiliado}`,
      form.practica && `Práctica: ${form.practica}`,
      form.profesional && `Profesional: ${form.profesional}`,
      form.especialidad && `Especialidad: ${form.especialidad}`,
      form.sede && `Sede: ${form.sede}`,
      form.cie10 && `CIE-10: ${form.cie10}`,
    ].filter(Boolean);
    try {
      await navigator.clipboard.writeText(lineas.join("\n"));
      toast({ title: "Datos copiados al portapapeles" });
    } catch {
      toast({ title: "No se pudo copiar", variant: "destructive" });
    }
  };

  const marcarPrestacionCargada = () => {
    if (!resultado) return;
    registrarCarga.mutate(
      { data: { requestId: resultado.requestId } },
      {
        onSuccess: (r) => {
          setCargaManual({ usuario: r.usuario, fecha: r.fecha });
          toast({ title: "Carga manual registrada", description: "Ya podés reintentar la validación." });
        },
        onError: () => toast({ title: "No se pudo registrar la carga", variant: "destructive" }),
      },
    );
  };

  const esContingencia = resultado?.estado === "MANUAL_PRESTATION_REQUIRED";
  const esAceptado = resultado?.estado === "TOKEN_ACCEPTED";
  const esAuthError = resultado?.noAutenticado === true;
  const esDataRequired = resultado?.estado === "DATA_REQUIRED";
  const esMappingRequired = resultado?.estado === "MAPPING_REQUIRED";
  const esRevisionTecnica = resultado?.estado === "MANUAL_REVIEW";
  const esReintentable =
    resultado != null &&
    !esAuthError &&
    ["TECHNICAL_ERROR", "TIMEOUT", "MANUAL_PRESTATION_REQUIRED", "DATA_REQUIRED"].includes(
      resultado.estado,
    );

  // Obligatorios (*): token y DNI (el request_id se genera automático).
  // Con (†): necesarios para resolver la contingencia de carga manual.
  const campos: Array<{ id: string; label: string; key: keyof typeof form }> = [
    { id: "prueba-paciente", label: "Paciente", key: "paciente" },
    { id: "prueba-dni", label: "DNI * (solo dígitos)", key: "dni" },
    { id: "prueba-tipodoc", label: "Tipo de documento", key: "tipoDoc" },
    { id: "prueba-paciente-id", label: "ID paciente", key: "pacienteId" },
    { id: "prueba-afiliado", label: "N° afiliado †", key: "afiliado" },
    { id: "prueba-practica", label: "Práctica (código) †", key: "practica" },
    { id: "prueba-profesional", label: "Profesional (Apellido, Nombre) †", key: "profesional" },
    { id: "prueba-profesional-id", label: "ID profesional", key: "profesionalId" },
    { id: "prueba-especialidad", label: "Especialidad (código)", key: "especialidad" },
    { id: "prueba-sede", label: "Sede (código)", key: "sede" },
    { id: "prueba-cie10", label: "CIE-10 †", key: "cie10" },
    { id: "prueba-consulta-id", label: "ID consulta (opcional)", key: "consultaId" },
  ];

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Prueba de validación de token (solo admins)</CardTitle>
        <CardDescription>
          Envía una validación real a El Robot sin tocar turnos ni consultas. La recepción
          productiva sigue deshabilitada por el flag KLINICOS_TOKEN_VALIDATION_ENABLED.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {campos.map((c) => (
            <div key={c.id}>
              <Label htmlFor={c.id}>{c.label}</Label>
              <Input
                id={c.id}
                value={form[c.key]}
                onChange={(e) =>
                  setForm({
                    ...form,
                    [c.key]: c.key === "dni" ? e.target.value.replace(/\D/g, "") : e.target.value,
                  })
                }
                data-testid={`input-${c.id}`}
              />
            </div>
          ))}
          <div className="col-span-2">
            <Label htmlFor="prueba-token">Token IOMA *</Label>
            <Input
              id="prueba-token"
              value={form.token}
              onChange={(e) => setForm({ ...form, token: e.target.value })}
              autoComplete="off"
              data-testid="input-prueba-token"
            />
          </div>
        </div>
        <p className="text-xs text-muted-foreground">
          * obligatorio (el request_id se genera automáticamente) · † necesario para resolver la
          contingencia de carga manual en KLINICOS
        </p>
        <div className="flex items-center gap-2 flex-wrap">
          <Button
            onClick={() => ejecutar(false)}
            disabled={probar.isPending || !form.token.trim() || !form.dni.trim()}
            data-testid="button-prueba-validar"
          >
            {probar.isPending ? "Validando…" : "Validar token en KLINICOS"}
          </Button>
          {esReintentable && !probar.isPending && (
            <Button
              variant="outline"
              onClick={() => ejecutar(true)}
              data-testid="button-prueba-reintentar"
            >
              Reintentar validación (mismo request_id)
            </Button>
          )}
        </div>

        {probar.isPending && (
          <div
            className="text-sm rounded-md border border-blue-200 bg-blue-50 text-blue-800 p-3 flex items-center gap-2"
            data-testid="text-prueba-progreso"
          >
            <span className="inline-block h-3 w-3 rounded-full border-2 border-blue-600 border-t-transparent animate-spin" />
            {timeoutUi
              ? "La solicitud está demorando más de lo esperado. Se conserva el request_id; no se generará otro."
              : `${mensajeProgreso(segundos)} (${segundos}s)`}
          </div>
        )}

        {resultado && !probar.isPending && (
          <div
            className={`text-sm space-y-2 rounded-md border p-3 ${
              esContingencia ? "border-amber-300 bg-amber-50" : ""
            }`}
            data-testid="text-prueba-resultado"
          >
            {esAuthError ? (
              <div className="text-red-700" data-testid="text-prueba-auth-error">
                La integración con El Robot no está correctamente autenticada. Contactá al
                administrador.
              </div>
            ) : (
              <>
                <div>
                  <span className="text-muted-foreground">Estado: </span>
                  <Badge
                    variant="outline"
                    className={
                      esAceptado
                        ? "bg-emerald-100 text-emerald-800 border-emerald-200"
                        : enProcesamiento
                          ? "bg-blue-100 text-blue-800 border-blue-200"
                          : esRevisionTecnica || esMappingRequired
                            ? "bg-slate-100 text-slate-800 border-slate-200"
                            : esReintentable
                              ? "bg-amber-100 text-amber-800 border-amber-200"
                              : "bg-red-100 text-red-800 border-red-200"
                    }
                  >
                    {esRevisionTecnica ? "En revisión técnica" : resultado.estado}
                  </Badge>
                </div>
                <div className="text-muted-foreground">{resultado.mensaje}</div>
                <div className="text-xs text-muted-foreground">
                  request_id: {resultado.requestId}
                  {resultado.latenciaMs != null && ` · ${resultado.latenciaMs} ms`}
                  {resultado.referenciaKlinicos && ` · ref KLINICOS: ${resultado.referenciaKlinicos}`}
                  {esAceptado && resultado.numeroAutorizacion && ` · autorización: ${resultado.numeroAutorizacion}`}
                </div>

                {esContingencia && (
                  <div className="space-y-2" data-testid="panel-prueba-contingencia">
                    <div className="text-amber-800 font-medium">
                      La prestación no existe en KLINICOS y debe cargarse manualmente.
                    </div>
                    {(resultado.camposFaltantes?.length ?? 0) > 0 && (
                      <div className="text-amber-800">
                        Campos faltantes:{" "}
                        {resultado.camposFaltantes!
                          .map((f) => CAMPOS_FALTANTES_ES[f] ?? f)
                          .join(", ")}
                      </div>
                    )}
                    <div className="flex items-center gap-2 flex-wrap">
                      <Button size="sm" variant="outline" onClick={copiarDatos} data-testid="button-prueba-copiar">
                        Copiar datos
                      </Button>
                      {robotEstado?.klinicosUrl && (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => window.open(robotEstado.klinicosUrl!, "_blank", "noopener")}
                          data-testid="button-prueba-abrir-klinicos"
                        >
                          Abrir KLINICOS
                        </Button>
                      )}
                      <Button
                        size="sm"
                        onClick={marcarPrestacionCargada}
                        disabled={registrarCarga.isPending || cargaManual != null}
                        data-testid="button-prueba-prestacion-cargada"
                      >
                        Prestación cargada
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => setEnviadoARevision(true)}
                        disabled={enviadoARevision}
                        data-testid="button-prueba-enviar-revision"
                      >
                        Enviar a revisión
                      </Button>
                    </div>
                    {cargaManual && (
                      <div className="text-xs text-amber-800" data-testid="text-prueba-carga-manual">
                        Carga manual registrada por {cargaManual.usuario} el{" "}
                        {new Date(cargaManual.fecha).toLocaleString("es-AR")}. Reintentá la
                        validación con el mismo request_id.
                      </div>
                    )}
                    {enviadoARevision && (
                      <div className="text-xs text-amber-800">
                        Caso marcado para revisión de supervisión.
                      </div>
                    )}
                  </div>
                )}

                {enProcesamiento && (
                  <div
                    className="flex items-center gap-2 text-blue-800"
                    data-testid="panel-prueba-procesando"
                  >
                    <span className="inline-block h-3 w-3 rounded-full border-2 border-blue-600 border-t-transparent animate-spin" />
                    <span>
                      El Robot está procesando la solicitud. Se consulta el estado automáticamente
                      con el mismo request_id.
                      {resultado.posicionCola != null &&
                        ` Posición en la cola: ${resultado.posicionCola}.`}
                      {resultado.esperaEstimadaSegundos != null &&
                        ` Espera estimada: ${formatoEspera(resultado.esperaEstimadaSegundos)}.`}
                    </span>
                  </div>
                )}

                {esDataRequired && (
                  <div className="space-y-2" data-testid="panel-prueba-data-required">
                    <div className="text-amber-800 font-medium">
                      Faltan o hay que corregir datos para completar la validación.
                    </div>
                    {(resultado.camposFaltantes?.length ?? 0) > 0 && (
                      <div className="text-amber-800">
                        Revisá estos campos y reintentá con el mismo request_id:{" "}
                        <span className="font-medium">
                          {resultado.camposFaltantes!
                            .map((f) => CAMPOS_FALTANTES_ES[f] ?? f)
                            .join(", ")}
                        </span>
                      </div>
                    )}
                  </div>
                )}

                {esMappingRequired && (
                  <div className="text-slate-700" data-testid="panel-prueba-mapping-required">
                    Falta configuración institucional: el Robot no tiene el mapeo necesario para
                    esta práctica, profesional o sede. Avisale al administrador para completar el
                    mapeo (catálogos exportables más abajo); no es un problema del token ni del
                    paciente.
                  </div>
                )}

                {esRevisionTecnica && (
                  <div className="text-slate-700" data-testid="panel-prueba-revision-tecnica">
                    El caso quedó en revisión técnica. No se requiere ninguna acción desde
                    recepción: el equipo técnico va a resolverlo y el resultado se registrará con
                    el mismo request_id.
                  </div>
                )}
              </>
            )}
          </div>
        )}

        <div className="pt-2 border-t space-y-2">
          <div className="text-sm font-medium">Catálogos para el mapeo del Robot</div>
          <p className="text-xs text-muted-foreground">
            Exportá los catálogos institucionales que el equipo del Robot necesita para configurar
            el mapeo: prácticas (código y descripción) y profesionales (ID, nombre, matrícula y
            especialidad).
          </p>
          <div className="flex items-center gap-2 flex-wrap">
            <Button
              size="sm"
              variant="outline"
              onClick={() =>
                descargarCatalogoCsv("practicas").catch(() =>
                  toast({ title: "No se pudo descargar el catálogo", variant: "destructive" }),
                )
              }
              data-testid="button-catalogo-practicas"
            >
              <Download className="h-3.5 w-3.5 mr-1" /> Prácticas (CSV)
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() =>
                descargarCatalogoCsv("profesionales").catch(() =>
                  toast({ title: "No se pudo descargar el catálogo", variant: "destructive" }),
                )
              }
              data-testid="button-catalogo-profesionales"
            >
              <Download className="h-3.5 w-3.5 mr-1" /> Profesionales (CSV)
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

// ── Validación espejo de token de consulta (Clínica Médica) ───────────────
// El paciente se presenta en recepción con DNI + token: se encola la consulta
// con un médico rotado del listado y el robot valida el token en Klinicos.
function ConsultaEspejoForm({ onEncolado }: { onEncolado: () => void }) {
  const { toast } = useToast();
  const crear = useCreateKlinicosConsultaEspejo();
  const [dni, setDni] = useState("");
  const [token, setToken] = useState("");

  const enviar = () => {
    crear.mutate(
      { data: { dni: dni.trim(), token: token.trim() } },
      {
        onSuccess: (t) => {
          toast({
            title: `Consulta encolada (#${t.id})`,
            description: `${t.pacienteNombre ?? `DNI ${t.dni}`} — médico: ${t.profesionalKlinicos ?? "a definir"}`,
          });
          setDni("");
          setToken("");
          onEncolado();
        },
        onError: (err: unknown) => {
          const mensaje =
            (err as { data?: { error?: string } })?.data?.error ??
            "No se pudo encolar la consulta";
          toast({ title: "No se encoló", description: mensaje, variant: "destructive" });
        },
      },
    );
  };

  return (
    <Card data-testid="card-consulta-espejo">
      <CardHeader className="pb-2">
        <CardTitle className="text-base">Validar token de consulta (Clínica Médica)</CardTitle>
        <CardDescription>
          El paciente se presenta con DNI y token: se carga la consulta con un médico rotado del
          listado y el robot valida el token en Klinicos.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-wrap items-end gap-2">
        <div className="space-y-1">
          <Label htmlFor="espejo-dni">DNI del paciente</Label>
          <Input
            id="espejo-dni"
            value={dni}
            onChange={(e) => setDni(e.target.value.replace(/\D/g, ""))}
            placeholder="30123456"
            className="w-40"
            data-testid="input-espejo-dni"
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="espejo-token">Token IOMA</Label>
          <Input
            id="espejo-token"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder="123456"
            className="w-36"
            data-testid="input-espejo-token"
          />
        </div>
        <Button
          onClick={enviar}
          disabled={dni.trim().length < 6 || token.trim().length < 4 || crear.isPending}
          data-testid="button-espejo-enviar"
        >
          {crear.isPending ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : null}
          Cargar y validar
        </Button>
      </CardContent>
    </Card>
  );
}

export default function KlinicosIntegracion() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { user } = useAuth();

  const { data: estado } = useGetKlinicosEstado();
  const { data: trabajos, isLoading } = useListKlinicosTrabajos(undefined, {
    query: { refetchInterval: 15000 },
  });
  const { data: reglas } = useListKlinicosReglasSector();
  const { data: practicas } = useListKlinicosPracticas();
  const { data: prescriptores } = useListKlinicosPrescriptores();
  const retry = useRetryKlinicosTrabajo();
  const aprobar = useAprobarKlinicosTrabajo();
  const rechazar = useRechazarKlinicosTrabajo();
  const [confirmandoAprobar, setConfirmandoAprobar] = useState<number | null>(null);
  const cancelar = useUpdateKlinicosTrabajo();
  const upsertRegla = useUpsertKlinicosReglaSector();

  const [editando, setEditando] = useState<KlinicosTrabajo | null>(null);
  const [informeBusyId, setInformeBusyId] = useState<number | null>(null);
  const [practicaDialog, setPracticaDialog] = useState<KlinicosPractica | null | "nueva">(null);
  const [prescriptorDialog, setPrescriptorDialog] = useState<KlinicosPrescriptor | null | "nuevo">(null);
  const [nuevaRegla, setNuevaRegla] = useState({ especialidad: "", sectorServicio: "CONSULTORIO" });

  const invalidarTrabajos = () => {
    queryClient.invalidateQueries({ queryKey: getListKlinicosTrabajosQueryKey() });
    queryClient.invalidateQueries({ queryKey: getGetKlinicosEstadoQueryKey() });
  };

  const reintentar = (id: number) => {
    retry.mutate(
      { id },
      {
        onSuccess: () => {
          toast({ title: "Trabajo reencolado" });
          invalidarTrabajos();
        },
        onError: () => toast({ title: "No se pudo reencolar", variant: "destructive" }),
      },
    );
  };

  const aprobarTrabajo = (id: number) => {
    aprobar.mutate(
      { id },
      {
        onSuccess: () => {
          toast({ title: "Carga real aprobada", description: "El robot está ejecutando la carga en Klinicos; la bandeja se actualiza sola." });
          setConfirmandoAprobar(null);
          invalidarTrabajos();
        },
        onError: (err: unknown) => {
          const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error;
          toast({ title: "No se pudo aprobar", description: msg, variant: "destructive" });
          setConfirmandoAprobar(null);
          invalidarTrabajos();
        },
      },
    );
  };

  const rechazarTrabajo = (id: number) => {
    rechazar.mutate(
      { id, data: {} },
      {
        onSuccess: () => {
          toast({ title: "Carga real rechazada", description: "El trabajo quedó cancelado." });
          invalidarTrabajos();
        },
        onError: () => toast({ title: "No se pudo rechazar", variant: "destructive" }),
      },
    );
  };

  const cancelarTrabajo = (id: number) => {
    cancelar.mutate(
      { id, data: { estado: "cancelado" } },
      {
        onSuccess: () => {
          toast({ title: "Trabajo cancelado" });
          invalidarTrabajos();
        },
        onError: () => toast({ title: "No se pudo cancelar", variant: "destructive" }),
      },
    );
  };

  const generarInforme = async (id: number) => {
    setInformeBusyId(id);
    try {
      const r = await fetch(`/api/integraciones/klinicos/trabajos/${id}/informe/regenerar`, {
        method: "POST",
        headers: authHeaders({ "Content-Type": "application/json" }),
        credentials: "include",
      });
      if (!r.ok) {
        const err = await r.json().catch(() => ({})) as { error?: string };
        toast({
          title: "No se pudo traer el informe del PACS",
          description: err.error ?? "Puede que el estudio todavía no esté informado en el PACS.",
          variant: "destructive",
        });
        return;
      }
      toast({ title: "Informe traído del PACS" });
      invalidarTrabajos();
    } finally {
      setInformeBusyId(null);
    }
  };

  const descargarInformePdf = async (id: number) => {
    setInformeBusyId(id);
    try {
      const r = await fetch(`/api/integraciones/klinicos/trabajos/${id}/informe-pdf`, {
        headers: authHeaders(),
        credentials: "include",
      });
      if (!r.ok) {
        const err = await r.json().catch(() => ({})) as { error?: string };
        toast({ title: "No se pudo descargar el PDF", description: err.error, variant: "destructive" });
        return;
      }
      const blob = await r.blob();
      const url = URL.createObjectURL(blob);
      window.open(url, "_blank");
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } finally {
      setInformeBusyId(null);
    }
  };

  const guardarEnNube = async (id: number) => {
    setInformeBusyId(id);
    try {
      const r = await fetch(`/api/integraciones/klinicos/trabajos/${id}/informe-pdf/guardar`, {
        method: "POST",
        headers: authHeaders({ "Content-Type": "application/json" }),
        credentials: "include",
      });
      if (!r.ok) {
        const err = await r.json().catch(() => ({})) as { error?: string };
        toast({ title: "No se pudo guardar en la nube", description: err.error, variant: "destructive" });
        return;
      }
      toast({ title: "Informe guardado en la nube" });
      invalidarTrabajos();
    } finally {
      setInformeBusyId(null);
    }
  };

  const fileInputRef = useRef<HTMLInputElement>(null);
  const [subirTrabajoId, setSubirTrabajoId] = useState<number | null>(null);

  const elegirArchivo = (id: number) => {
    setSubirTrabajoId(id);
    fileInputRef.current?.click();
  };

  const subirArchivoInforme = async (file: File) => {
    const id = subirTrabajoId;
    if (id == null) return;
    if (!["application/pdf", "image/png", "image/jpeg"].includes(file.type)) {
      toast({ title: "Formato no soportado", description: "Subí un PDF o una imagen PNG/JPG.", variant: "destructive" });
      return;
    }
    if (file.size > 15 * 1024 * 1024) {
      toast({ title: "Archivo muy grande", description: "Máximo 15 MB.", variant: "destructive" });
      return;
    }
    setInformeBusyId(id);
    try {
      const rUrl = await fetch(`/api/storage/uploads/request-url`, {
        method: "POST",
        headers: authHeaders({ "Content-Type": "application/json" }),
        credentials: "include",
        body: JSON.stringify({ name: file.name, size: file.size, contentType: file.type }),
      });
      if (!rUrl.ok) {
        toast({ title: "No se pudo iniciar la subida", variant: "destructive" });
        return;
      }
      const { uploadURL, objectPath } = await rUrl.json() as { uploadURL: string; objectPath: string };
      const rPut = await fetch(uploadURL, {
        method: "PUT",
        headers: { "Content-Type": file.type },
        body: file,
      });
      if (!rPut.ok) {
        toast({ title: "Falló la subida del archivo", variant: "destructive" });
        return;
      }
      const rAttach = await fetch(`/api/integraciones/klinicos/trabajos/${id}/informe-archivo`, {
        method: "PUT",
        headers: authHeaders({ "Content-Type": "application/json" }),
        credentials: "include",
        body: JSON.stringify({ objectPath, contentType: file.type }),
      });
      if (!rAttach.ok) {
        const err = await rAttach.json().catch(() => ({})) as { error?: string };
        toast({ title: "No se pudo adjuntar el informe", description: err.error, variant: "destructive" });
        return;
      }
      toast({ title: "Informe subido a la nube" });
      invalidarTrabajos();
    } finally {
      setInformeBusyId(null);
      setSubirTrabajoId(null);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  const descargarArchivoNube = async (id: number, nombre: string | null | undefined) => {
    setInformeBusyId(id);
    try {
      const r = await fetch(`/api/integraciones/klinicos/trabajos/${id}/informe-archivo`, {
        headers: authHeaders(),
        credentials: "include",
      });
      if (!r.ok) {
        const err = await r.json().catch(() => ({})) as { error?: string };
        toast({ title: "No se pudo descargar el archivo", description: err.error, variant: "destructive" });
        return;
      }
      const blob = await r.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = nombre ?? `informe-${id}.pdf`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } finally {
      setInformeBusyId(null);
    }
  };

  const guardarRegla = () => {
    if (!nuevaRegla.especialidad.trim()) return;
    upsertRegla.mutate(
      { data: nuevaRegla },
      {
        onSuccess: () => {
          toast({ title: "Regla guardada" });
          queryClient.invalidateQueries({ queryKey: getListKlinicosReglasSectorQueryKey() });
          setNuevaRegla({ especialidad: "", sectorServicio: "CONSULTORIO" });
        },
        onError: () => toast({ title: "No se pudo guardar la regla", variant: "destructive" }),
      },
    );
  };

  return (
    <div className="p-6 max-w-6xl mx-auto space-y-6">
      <input
        ref={fileInputRef}
        type="file"
        accept="application/pdf,image/png,image/jpeg"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void subirArchivoInforme(f);
        }}
        data-testid="input-archivo-informe"
      />
      <div className="flex items-center gap-3">
        <div className="h-10 w-10 rounded-lg bg-violet-100 flex items-center justify-center">
          <Bot className="h-5 w-5 text-violet-600" />
        </div>
        <div>
          <h1 className="text-2xl font-semibold" data-testid="text-titulo-klinicos">
            Robot Klinicos
          </h1>
          <p className="text-sm text-muted-foreground">
            Carga automática de ingresos ambulatorios y prestaciones en Klinicos (ACEAPP) al recepcionar pacientes
          </p>
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-6 gap-3">
        <Card>
          <CardContent className="pt-4 pb-3">
            <div className="text-xs text-muted-foreground">Estado del robot</div>
            <div className="flex items-center gap-1.5 mt-1">
              {estado?.habilitado ? (
                <Badge className="bg-emerald-100 text-emerald-800 border-emerald-200" variant="outline">
                  {estado.dryRun ? "Simulación" : "Activo"}
                </Badge>
              ) : (
                <Badge variant="outline" className="bg-muted text-muted-foreground">
                  Sin credenciales
                </Badge>
              )}
            </div>
          </CardContent>
        </Card>
        {(
          [
            ["Pendientes", estado?.pendientes, Clock, "text-amber-600"],
            ["En proceso", estado?.enProceso, Loader2, "text-blue-600"],
            ["Esperando aprobación", estado?.esperandoAprobacion, Clock, "text-violet-600"],
            ["Completados", estado?.completados, CheckCircle2, "text-emerald-600"],
            ["Errores", estado?.errores, AlertTriangle, "text-red-600"],
          ] as const
        ).map(([label, valor, Icon, color]) => (
          <Card key={label}>
            <CardContent className="pt-4 pb-3">
              <div className="text-xs text-muted-foreground">{label}</div>
              <div className="flex items-center gap-2 mt-1">
                <Icon className={`h-4 w-4 ${color}`} />
                <span className="text-xl font-semibold">{valor ?? 0}</span>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      <AutoencoladoSwitch />

      {!estado?.habilitado && (
        <Card className="border-amber-200 bg-amber-50">
          <CardContent className="pt-4 pb-4 text-sm text-amber-800">
            El robot está deshabilitado porque faltan las credenciales de Klinicos. Los trabajos se
            encolan igual al recepcionar y se procesarán cuando se configuren los accesos.
          </CardContent>
        </Card>
      )}

      <Tabs defaultValue="bandeja">
        <TabsList>
          <TabsTrigger value="bandeja" data-testid="tab-bandeja">Bandeja de trabajos</TabsTrigger>
          <TabsTrigger value="reglas" data-testid="tab-reglas">Reglas de sector</TabsTrigger>
          <TabsTrigger value="practicas" data-testid="tab-practicas">Prácticas y códigos</TabsTrigger>
          <TabsTrigger value="prescriptores" data-testid="tab-prescriptores">Prescriptores</TabsTrigger>
        </TabsList>

        <TabsContent value="bandeja" className="space-y-3">
          <ConsultaEspejoForm onEncolado={invalidarTrabajos} />
          {isLoading ? (
            <div className="flex justify-center py-10">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : !trabajos?.length ? (
            <Card>
              <CardContent className="py-10 text-center text-sm text-muted-foreground">
                Todavía no hay trabajos. Se crean automáticamente al recepcionar un paciente.
              </CardContent>
            </Card>
          ) : (
            trabajos.map((t) => (
              <Card key={t.id} data-testid={`card-trabajo-${t.id}`}>
                <CardContent className="pt-4 pb-4">
                  <div className="flex items-start justify-between gap-3 flex-wrap">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-medium">{t.pacienteNombre ?? `Paciente #${t.pacienteId}`}</span>
                        <span className="text-xs text-muted-foreground">DNI {t.dni}</span>
                        <EstadoBadge estado={t.estado} />
                        <Badge variant="secondary">{t.sectorServicio}</Badge>
                      </div>
                      <div className="text-sm text-muted-foreground mt-1">
                        {t.especialidad}
                        {t.motivo ? ` — ${t.motivo}` : ""}
                      </div>
                      {t.consultaPor && (
                        <div className="text-sm mt-1">
                          <span className="text-muted-foreground">Consulta por:</span> {t.consultaPor}
                          {t.cie10Codigo && (
                            <span className="ml-2 text-xs text-muted-foreground">
                              CIE-10 {t.cie10Codigo} {t.cie10Descripcion ?? ""}
                            </span>
                          )}
                        </div>
                      )}
                      {t.practicaCodigos && t.practicaCodigos.length > 0 && (
                        <div className="text-xs text-muted-foreground mt-1">
                          Códigos: {t.practicaCodigos.join(", ")}
                          {t.efectorNombre ? ` — Efector: ${t.efectorNombre}` : ""}
                        </div>
                      )}
                      {t.informeIaTexto && (
                        <div className="text-xs mt-2 border rounded p-2 bg-muted/30 max-w-xl">
                          <div className="flex items-center gap-1 font-medium text-muted-foreground mb-1">
                            <FileText className="h-3 w-3" /> Informe (desde el PACS)
                            {t.informeIaGeneradoEn && <span className="font-normal">· {formatoFecha(t.informeIaGeneradoEn)}</span>}
                          </div>
                          <div className="whitespace-pre-wrap line-clamp-4">{t.informeIaTexto}</div>
                        </div>
                      )}
                      {t.informePdfPath && (
                        <div className="text-xs mt-1 flex items-center gap-1 text-muted-foreground">
                          <Cloud className="h-3 w-3" />
                          <button
                            type="button"
                            className="underline hover:text-foreground"
                            onClick={() => void descargarArchivoNube(t.id, t.informePdfNombre)}
                            data-testid={`link-informe-nube-${t.id}`}
                          >
                            {t.informePdfNombre ?? "informe.pdf"}
                          </button>
                          <span>
                            · {t.informePdfOrigen === "subido" ? "subido a mano" : "generado"}
                            {t.informePdfSubidoEn ? ` · ${formatoFecha(t.informePdfSubidoEn)}` : ""}
                          </span>
                        </div>
                      )}
                      {t.estado === "esperando_aprobacion" && (
                        <div className="text-xs mt-2 border border-violet-200 rounded p-2 bg-violet-50 max-w-xl space-y-1" data-testid={`payload-simulado-${t.id}`}>
                          <div className="font-medium text-violet-800">
                            Simulación lista {t.simulacionEn ? `· ${formatoFecha(t.simulacionEn)}` : ""} — revisá y aprobá la carga REAL en Klinicos
                          </div>
                          {t.simulacionPayload ? (
                            <pre className="whitespace-pre-wrap text-[11px] text-violet-900 max-h-48 overflow-y-auto">
                              {JSON.stringify(t.simulacionPayload, null, 2)}
                            </pre>
                          ) : (
                            <div className="text-violet-800">Sin payload simulado guardado.</div>
                          )}
                        </div>
                      )}
                      {t.practicaCodigos && t.practicaCodigos.length > 0 &&
                        t.klinicosPrestacionCreada && !t.ordenAdjuntada &&
                        ["error", "completado"].includes(t.estado) && (
                        <div
                          className="text-xs mt-2 border border-amber-300 dark:border-amber-700 rounded p-2 bg-amber-50 dark:bg-amber-950/40 text-amber-900 dark:text-amber-200 flex items-start gap-1.5 max-w-xl"
                          data-testid={`aviso-orden-manual-${t.id}`}
                        >
                          <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                          <div>
                            <div className="font-medium">
                              La orden no pudo adjuntarse automáticamente — subila a mano en Klinicos
                            </div>
                            {t.ordenAdjuntoDetalle && (
                              <div className="mt-0.5">{t.ordenAdjuntoDetalle}</div>
                            )}
                          </div>
                        </div>
                      )}
                      {t.aprobadoPor && (
                        <div className="text-xs text-muted-foreground mt-1">
                          Carga real aprobada por {t.aprobadoPor}
                          {t.aprobadoEn ? ` · ${formatoFecha(t.aprobadoEn)}` : ""}
                          {t.klinicosPrestacionNumero ? ` · Prestación ${t.klinicosPrestacionNumero}` : ""}
                          {t.klinicosNroBono ? ` · Bono ${t.klinicosNroBono}` : ""}
                          {t.autorizacionResultado ? ` · Autorización: ${t.autorizacionResultado}` : ""}
                        </div>
                      )}
                      {t.ultimoError && (
                        <div className="text-xs text-red-600 mt-1">{t.ultimoError}</div>
                      )}
                      <div className="text-xs text-muted-foreground mt-1">
                        Encolado {formatoFecha(t.creadoEn)} · {t.intentos} intento(s)
                      </div>
                    </div>
                    <div className="flex items-center gap-1.5 shrink-0 flex-wrap justify-end">
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => void generarInforme(t.id)}
                        disabled={informeBusyId === t.id}
                        data-testid={`button-informe-pacs-${t.id}`}
                      >
                        {informeBusyId === t.id
                          ? <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
                          : <FileText className="h-3.5 w-3.5 mr-1" />}
                        {t.informeIaTexto ? "Actualizar informe" : "Traer informe del PACS"}
                      </Button>
                      {t.informeIaTexto && (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => void descargarInformePdf(t.id)}
                          disabled={informeBusyId === t.id}
                          data-testid={`button-informe-pdf-${t.id}`}
                        >
                          <Download className="h-3.5 w-3.5 mr-1" /> PDF firmado
                        </Button>
                      )}
                      {t.informeIaTexto && (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => void guardarEnNube(t.id)}
                          disabled={informeBusyId === t.id}
                          data-testid={`button-guardar-nube-${t.id}`}
                        >
                          <Cloud className="h-3.5 w-3.5 mr-1" /> Guardar en la nube
                        </Button>
                      )}
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => elegirArchivo(t.id)}
                        disabled={informeBusyId === t.id}
                        data-testid={`button-subir-informe-${t.id}`}
                      >
                        <CloudUpload className="h-3.5 w-3.5 mr-1" /> Subir PDF
                      </Button>
                      {t.estado === "esperando_aprobacion" && (
                        confirmandoAprobar === t.id ? (
                          <>
                            <Button
                              size="sm"
                              className="bg-violet-600 hover:bg-violet-700 text-white"
                              onClick={() => aprobarTrabajo(t.id)}
                              disabled={aprobar.isPending}
                              data-testid={`button-confirmar-aprobar-${t.id}`}
                            >
                              <CheckCircle2 className="h-3.5 w-3.5 mr-1" /> Confirmar carga REAL
                            </Button>
                            <Button size="sm" variant="ghost" onClick={() => setConfirmandoAprobar(null)} data-testid={`button-cancelar-aprobar-${t.id}`}>
                              Volver
                            </Button>
                          </>
                        ) : (
                          <>
                            <Button
                              size="sm"
                              variant="outline"
                              className="border-violet-300 text-violet-700"
                              onClick={() => setConfirmandoAprobar(t.id)}
                              data-testid={`button-aprobar-${t.id}`}
                            >
                              <CheckCircle2 className="h-3.5 w-3.5 mr-1" /> Aprobar carga real
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => rechazarTrabajo(t.id)}
                              disabled={rechazar.isPending}
                              data-testid={`button-rechazar-${t.id}`}
                            >
                              <XCircle className="h-3.5 w-3.5 mr-1" /> Rechazar
                            </Button>
                          </>
                        )
                      )}
                      {["pendiente", "error", "esperando_aprobacion"].includes(t.estado) && (
                        <Button size="sm" variant="outline" onClick={() => setEditando(t)} data-testid={`button-editar-${t.id}`}>
                          <Pencil className="h-3.5 w-3.5 mr-1" /> Revisar
                        </Button>
                      )}
                      {["error", "cancelado"].includes(t.estado) && (
                        <Button size="sm" variant="outline" onClick={() => reintentar(t.id)} data-testid={`button-reintentar-${t.id}`}>
                          <RefreshCw className="h-3.5 w-3.5 mr-1" /> Reintentar
                        </Button>
                      )}
                      {["pendiente", "error"].includes(t.estado) && (
                        <Button size="sm" variant="ghost" onClick={() => cancelarTrabajo(t.id)} data-testid={`button-cancelar-${t.id}`}>
                          <XCircle className="h-3.5 w-3.5" />
                        </Button>
                      )}
                    </div>
                  </div>
                </CardContent>
              </Card>
            ))
          )}
        </TabsContent>

        <TabsContent value="reglas" className="space-y-4">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Especialidad → Sector/Servicio</CardTitle>
              <CardDescription>
                Define a qué sector de Klinicos va el ingreso según la especialidad del turno. Lo que no
                matchea usa la heurística (imágenes → IMÁGENES S/C, resto → CONSULTORIO).
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="flex gap-2 flex-wrap items-end">
                <div className="flex-1 min-w-48">
                  <Label>Especialidad</Label>
                  <Input
                    value={nuevaRegla.especialidad}
                    onChange={(e) => setNuevaRegla((r) => ({ ...r, especialidad: e.target.value }))}
                    placeholder="ej: TRAUMATOLOGIA"
                    data-testid="input-regla-especialidad"
                  />
                </div>
                <div className="w-48">
                  <Label>Sector/Servicio</Label>
                  <Select
                    value={nuevaRegla.sectorServicio}
                    onValueChange={(v) => setNuevaRegla((r) => ({ ...r, sectorServicio: v }))}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="CONSULTORIO">CONSULTORIO</SelectItem>
                      <SelectItem value="IMAGENES S/C">IMÁGENES S/C</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <Button onClick={guardarRegla} disabled={upsertRegla.isPending} data-testid="button-guardar-regla">
                  {upsertRegla.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : "Guardar"}
                </Button>
              </div>
              <div className="divide-y border rounded-md">
                {reglas?.map((r) => (
                  <div key={r.id} className="flex items-center justify-between px-3 py-2 text-sm">
                    <span>{r.especialidad}</span>
                    <Badge variant={r.sectorServicio === "CONSULTORIO" ? "secondary" : "outline"}>
                      {r.sectorServicio}
                    </Badge>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>

          <EqEspecialidadesSection />
          <ReglasPracticaSection practicas={practicas} />
          <ReglasCie10Section />
        </TabsContent>

        <TabsContent value="practicas" className="space-y-3">
          <div className="flex justify-end">
            <Button size="sm" onClick={() => setPracticaDialog("nueva")} data-testid="button-nueva-practica">
              <Plus className="h-4 w-4 mr-1" /> Nueva práctica
            </Button>
          </div>
          <div className="divide-y border rounded-md">
            {practicas?.map((p) => (
              <div key={p.id} className="flex items-center justify-between px-3 py-2 text-sm gap-2">
                <div className="min-w-0">
                  <div className="font-medium truncate">{p.nombre}</div>
                  <div className="text-xs text-muted-foreground">
                    {p.categoria ?? "Sin categoría"} · Códigos: {p.codigos.join(", ")}
                    {p.codigoEnvio ? ` · Envío Conectar: ${p.codigoEnvio}` : " · Sin código de envío (revisión manual)"}
                    {p.efectorNombre ? ` · Efector: ${p.efectorNombre}` : ""}
                  </div>
                </div>
                <Button size="sm" variant="ghost" onClick={() => setPracticaDialog(p)} data-testid={`button-editar-practica-${p.id}`}>
                  <Pencil className="h-3.5 w-3.5" />
                </Button>
              </div>
            ))}
          </div>
        </TabsContent>

        <TabsContent value="prescriptores" className="space-y-3">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Médicos prescriptores</CardTitle>
              <CardDescription>
                El robot rota entre los prescriptores activos al cargar prestaciones de imágenes en
                Klinicos. Los marcados como ginecólogos no se asignan a pacientes varones.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="flex justify-end">
                <Button size="sm" onClick={() => setPrescriptorDialog("nuevo")} data-testid="button-nuevo-prescriptor">
                  <Plus className="h-4 w-4 mr-1" /> Nuevo prescriptor
                </Button>
              </div>
              {!prescriptores?.length ? (
                <div className="py-8 text-center text-sm text-muted-foreground">
                  Todavía no hay prescriptores cargados. Agregá los médicos tal como figuran en Klinicos.
                </div>
              ) : (
                <div className="divide-y border rounded-md">
                  {prescriptores.map((p) => (
                    <div key={p.id} className="flex items-center justify-between px-3 py-2 text-sm gap-2">
                      <div className="min-w-0 flex items-center gap-2 flex-wrap">
                        <span className={`font-medium ${p.activo ? "" : "text-muted-foreground line-through"}`}>
                          {p.nombre}
                        </span>
                        {p.matricula && <Badge variant="outline">{p.matricula}</Badge>}
                        {p.especialidad && <span className="text-xs text-muted-foreground">{p.especialidad}</span>}
                        {p.esGinecologo && <Badge variant="outline">Ginecología</Badge>}
                        {!p.matricula && (
                          <Badge variant="destructive" className="text-xs">Falta matrícula</Badge>
                        )}
                        {!p.activo && <Badge variant="secondary">Inactivo</Badge>}
                        <span className="text-xs text-muted-foreground">
                          Último uso: {formatoFecha(p.ultimoUsoEn)}
                        </span>
                      </div>
                      <Button size="sm" variant="ghost" onClick={() => setPrescriptorDialog(p)} data-testid={`button-editar-prescriptor-${p.id}`}>
                        <Pencil className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      {editando && <TrabajoEditDialog trabajo={editando} onClose={() => setEditando(null)} />}
      {practicaDialog !== null && (
        <PracticaDialog
          practica={practicaDialog === "nueva" ? null : practicaDialog}
          onClose={() => setPracticaDialog(null)}
        />
      )}
      {prescriptorDialog !== null && (
        <PrescriptorDialog
          prescriptor={prescriptorDialog === "nuevo" ? null : prescriptorDialog}
          onClose={() => setPrescriptorDialog(null)}
        />
      )}

      {user?.rol === "admin" && <CredencialesKlinicosCard />}
      {user?.rol === "admin" && <PruebaRobotAdminCard />}
      {user?.rol === "admin" && <PendientesConfiguracionCard />}
      {user?.rol === "admin" && <ConsultationsProcessCard />}
      {user?.rol === "admin" && <SupervisorTotpCard />}
    </div>
  );
}

// ── Código de supervisor (TOTP) ──────────────────────────────────────────
// El admin genera un secreto y lo escanea con una app authenticator (Google
// Authenticator, Authy, etc.). Recepción va a necesitar ese código de 6
// dígitos para recepcionar consultas sin token validado.
function SupervisorTotpCard() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { data: estado } = useGetSupervisorTotp();
  const [generado, setGenerado] = useState<{ secret: string; otpauthUrl: string } | null>(null);
  const generar = useGenerarSupervisorTotp({
    mutation: {
      onSuccess: (data) => {
        setGenerado(data);
        void queryClient.invalidateQueries({ queryKey: getGetSupervisorTotpQueryKey() });
        toast({ title: "Código de supervisor generado" });
      },
      onError: () => toast({ title: "No se pudo generar el código", variant: "destructive" }),
    },
  });

  return (
    <Card data-testid="card-supervisor-totp">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <CheckCircle2 className="w-4 h-4" />
          Código de supervisor (recepción sin token)
        </CardTitle>
        <CardDescription>
          Si está configurado, recepcionar una consulta sin token validado exige un código de 6
          dígitos de la app authenticator del supervisor.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex items-center gap-2">
          <Badge variant={estado?.configurado ? "default" : "secondary"} data-testid="badge-totp-estado">
            {estado?.configurado ? "Configurado" : "No configurado"}
          </Badge>
          <Button
            size="sm"
            variant="outline"
            disabled={generar.isPending}
            onClick={() => {
              if (
                estado?.configurado &&
                !window.confirm(
                  "Ya hay un código configurado. Si generás uno nuevo, el anterior deja de funcionar. ¿Continuar?",
                )
              )
                return;
              generar.mutate();
            }}
            data-testid="boton-generar-totp"
          >
            {generar.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
            {estado?.configurado ? "Regenerar código" : "Generar código"}
          </Button>
        </div>
        {generado && (
          <div className="space-y-2 rounded-md border p-4">
            <p className="text-sm font-medium">
              Escaneá este QR con la app authenticator del supervisor. Se muestra una sola vez.
            </p>
            <div className="bg-white p-3 rounded-md w-fit">
              <QRCodeSVG value={generado.otpauthUrl} size={168} />
            </div>
            <p className="text-xs text-muted-foreground">
              Clave manual: <span className="font-mono select-all" data-testid="texto-totp-secret">{generado.secret}</span>
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
