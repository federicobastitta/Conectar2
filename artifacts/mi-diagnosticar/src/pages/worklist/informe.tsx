import { useState, useEffect, useCallback } from "react";
import { useParams, useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Badge } from "@/components/ui/badge";
import { StatusBadge } from "@/components/ui/status-badge";
import { useToast } from "@/hooks/use-toast";
import {
  FileText, CheckCircle, Globe, ArrowLeft, Trash2, Plus, ExternalLink, Image as ImageIcon, Loader2, Save,
} from "lucide-react";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { format } from "date-fns";
import { es } from "date-fns/locale";
import { useGetMe } from "@workspace/api-client-react";

/** Sello del médico: firma manuscrita (si la cargó) + nombre y matrícula. */
function SelloMedico({ profesional, firmaTexto, firmadoEn }: {
  profesional?: { nombre: string; apellido: string; matricula?: string | null; firmaImagen?: string | null } | null;
  firmaTexto?: string | null;
  firmadoEn?: string | null;
}) {
  return (
    <div className="flex items-end justify-between gap-4">
      <div>
        <div className="text-xs text-muted-foreground uppercase tracking-wide mb-1">Firmado por</div>
        <div className="font-semibold">{firmaTexto ?? "Profesional"}</div>
        {profesional?.matricula && (
          <div className="text-sm text-muted-foreground">M.P./M.N. {profesional.matricula}</div>
        )}
        {firmadoEn && (
          <div className="text-xs text-muted-foreground">
            {format(new Date(firmadoEn), "d 'de' MMMM yyyy, HH:mm", { locale: es })}
          </div>
        )}
      </div>
      {profesional?.firmaImagen && (
        <img
          src={profesional.firmaImagen}
          alt="Firma del médico"
          className="h-16 max-w-[200px] object-contain bg-white rounded px-2 py-1"
          data-testid="img-firma-medico"
        />
      )}
    </div>
  );
}

type Plantilla = { id: number; nombre: string; texto: string };

/** Plantillas de informe personales del médico (no compartidas). */
function PlantillasPanel({ textoActual, onAplicar, disabled }: {
  textoActual: string;
  onAplicar: (texto: string) => void;
  disabled: boolean;
}) {
  const { toast } = useToast();
  const [plantillas, setPlantillas] = useState<Plantilla[] | null>(null);
  const [nombreNueva, setNombreNueva] = useState("");
  const [guardando, setGuardando] = useState(false);

  useEffect(() => {
    let cancel = false;
    fetch("/api/informe-plantillas", { headers: authHeaders() })
      .then((r) => (r.ok ? r.json() : null))
      .then((d: Plantilla[] | null) => { if (!cancel && d) setPlantillas(d); })
      .catch(() => {});
    return () => { cancel = true; };
  }, []);

  if (plantillas === null) return null; // no es médico o aún carga

  const guardarComoPlantilla = async () => {
    if (!nombreNueva.trim() || !textoActual.trim()) return;
    setGuardando(true);
    try {
      const r = await fetch("/api/informe-plantillas", {
        method: "POST",
        headers: authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({ nombre: nombreNueva.trim(), texto: textoActual }),
      });
      if (!r.ok) {
        const err = await r.json().catch(() => ({})) as { error?: string };
        toast({ title: "No se pudo guardar la plantilla", description: err.error, variant: "destructive" });
        return;
      }
      const nueva = await r.json() as Plantilla;
      setPlantillas((p) => [...(p ?? []), nueva].sort((a, b) => a.nombre.localeCompare(b.nombre)));
      setNombreNueva("");
      toast({ title: "Plantilla guardada", description: "Solo vos podés verla y usarla." });
    } finally {
      setGuardando(false);
    }
  };

  const eliminar = async (id: number) => {
    const r = await fetch(`/api/informe-plantillas/${id}`, { method: "DELETE", headers: authHeaders() });
    if (r.ok) setPlantillas((p) => (p ?? []).filter((x) => x.id !== id));
  };

  return (
    <div className="border rounded-lg p-4 space-y-3" data-testid="panel-plantillas">
      <div className="text-sm font-semibold flex items-center gap-1.5">
        <FileText className="w-4 h-4 text-muted-foreground" />
        Mis plantillas
      </div>
      {plantillas.length === 0 ? (
        <p className="text-xs text-muted-foreground">Todavía no guardaste plantillas.</p>
      ) : (
        <div className="space-y-1.5">
          {plantillas.map((p) => (
            <div key={p.id} className="flex items-center gap-1.5 group">
              <button
                className="flex-1 text-left text-sm border rounded px-2 py-1.5 hover:bg-muted/40 truncate disabled:opacity-50"
                disabled={disabled}
                title={disabled ? "El informe ya está firmado" : "Usar esta plantilla"}
                data-testid={`btn-usar-plantilla-${p.id}`}
                onClick={() => { onAplicar(p.texto); toast({ title: `Plantilla "${p.nombre}" aplicada` }); }}
              >
                {p.nombre}
              </button>
              <button
                className="opacity-0 group-hover:opacity-70 hover:!opacity-100"
                title="Eliminar plantilla"
                onClick={() => void eliminar(p.id)}
              >
                <Trash2 className="w-3.5 h-3.5 text-muted-foreground" />
              </button>
            </div>
          ))}
        </div>
      )}
      {!disabled && (
        <div className="flex gap-2 pt-1">
          <Input
            value={nombreNueva}
            onChange={(e) => setNombreNueva(e.target.value)}
            placeholder="Guardar texto actual como…"
            className="text-xs"
            data-testid="input-nombre-plantilla"
          />
          <Button
            size="sm"
            variant="outline"
            disabled={!nombreNueva.trim() || !textoActual.trim() || guardando}
            onClick={() => void guardarComoPlantilla()}
            data-testid="btn-guardar-plantilla"
          >
            <Save className="w-3 h-3" />
          </Button>
        </div>
      )}
      <p className="text-[11px] text-muted-foreground">Las plantillas son personales: nadie más las ve.</p>
    </div>
  );
}

type Imagen = {
  id: number;
  url: string;
  descripcion?: string | null;
  orden: number;
};

type Informe = {
  id: number;
  texto: string;
  firma?: string | null;
  firmadoEn?: string | null;
  estado: string;
  pacsStudyId?: string | null;
  pacsViewerUrl?: string | null;
  observaciones?: string | null;
  imagenes: Imagen[];
  paciente?: { nombre: string; apellido: string; dni?: string | null } | null;
  profesional?: { nombre: string; apellido: string; matricula?: string | null; firmaImagen?: string | null } | null;
};

type Turno = {
  id: number;
  horaInicio: string;
  fecha: string;
  estado: string;
  motivoConsulta?: string | null;
  paciente?: { id: number; nombre: string; apellido: string; dni?: string | null } | null;
  profesional?: { nombre: string; apellido: string } | null;
  turnera?: { nombre: string; especialidad?: { nombre: string } | null } | null;
  informe?: null;
};

function authHeaders(extra?: Record<string, string>): Record<string, string> {
  return {
    Authorization: `Bearer ${localStorage.getItem("auth_token") ?? ""}`,
    ...extra,
  };
}

export default function InformeEditor() {
  const { turnoId } = useParams<{ turnoId: string }>();
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const { data: me } = useGetMe({ query: { retry: false } });
  const miProfesionalId = me?.profesionalId != null ? Number(me.profesionalId) : null;

  const [turno, setTurno] = useState<Turno | null>(null);
  const [informe, setInforme] = useState<Informe | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [signing, setSigning] = useState(false);
  const [publishing, setPublishing] = useState(false);

  const [texto, setTexto] = useState("");
  const [pacsStudyId, setPacsStudyId] = useState("");
  const [pacsViewerUrl, setPacsViewerUrl] = useState("");
  const [firma, setFirma] = useState("");
  const [newImgUrl, setNewImgUrl] = useState("");
  const [newImgDesc, setNewImgDesc] = useState("");
  const [addingImg, setAddingImg] = useState(false);

  const isReadonly = informe?.estado === "firmado" || informe?.estado === "publicado";

  const cargar = useCallback(async () => {
    setLoading(true);
    try {
      const rTurno = await fetch(`/api/turnos/${turnoId}`, { credentials: "include", headers: authHeaders() });
      if (!rTurno.ok) { navigate("/worklist"); return; }
      const t = await rTurno.json() as Turno;
      setTurno(t);
      setFirma(
        t.profesional
          ? `${t.profesional.apellido}, ${t.profesional.nombre}`
          : "Profesional"
      );

      const rInforme = await fetch(`/api/turnos/${turnoId}/informe`, { credentials: "include", headers: authHeaders() });
      if (rInforme.ok) {
        const inf = await rInforme.json() as Informe;
        setInforme(inf);
        setTexto(inf.texto ?? "");
        setPacsStudyId(inf.pacsStudyId ?? "");
        setPacsViewerUrl(inf.pacsViewerUrl ?? "");
        if (inf.firma) setFirma(inf.firma);
      }
    } finally {
      setLoading(false);
    }
  }, [turnoId, navigate]);

  useEffect(() => { void cargar(); }, [cargar]);

  const crearOGuardar = async () => {
    setSaving(true);
    try {
      if (!informe) {
        const r = await fetch(`/api/turnos/${turnoId}/informe`, {
          method: "POST",
          headers: authHeaders({ "Content-Type": "application/json" }),
          credentials: "include",
          body: JSON.stringify({ texto, pacsStudyId: pacsStudyId || undefined, pacsViewerUrl: pacsViewerUrl || undefined }),
        });
        if (!r.ok) { toast({ title: "Error al crear informe", variant: "destructive" }); return; }
        const inf = await r.json() as Informe;
        setInforme(inf);
        toast({ title: "Informe creado" });
      } else {
        const r = await fetch(`/api/informes/${informe.id}`, {
          method: "PATCH",
          headers: authHeaders({ "Content-Type": "application/json" }),
          credentials: "include",
          body: JSON.stringify({ texto, pacsStudyId: pacsStudyId || undefined, pacsViewerUrl: pacsViewerUrl || undefined }),
        });
        if (!r.ok) { toast({ title: "Error al guardar", variant: "destructive" }); return; }
        const inf = await r.json() as Informe;
        setInforme(inf);
        toast({ title: "Guardado" });
      }
    } finally {
      setSaving(false);
    }
  };

  const firmar = async () => {
    if (!informe) return;
    setSigning(true);
    try {
      await crearOGuardar();
      const r = await fetch(`/api/informes/${informe.id}/firmar`, {
        method: "POST",
        headers: authHeaders({ "Content-Type": "application/json" }),
        credentials: "include",
        body: JSON.stringify({ firma }),
      });
      if (!r.ok) {
        const err = await r.json() as { error?: string };
        toast({ title: "Error", description: err.error, variant: "destructive" });
        return;
      }
      const inf = await r.json() as Informe;
      setInforme(inf);
      if (turno) setTurno({ ...turno, estado: "informado" });
      toast({ title: "Informe firmado y marcado como Informado" });
    } finally {
      setSigning(false);
    }
  };

  const publicar = async () => {
    if (!informe) return;
    setPublishing(true);
    try {
      const r = await fetch(`/api/informes/${informe.id}/publicar`, {
        method: "POST",
        headers: authHeaders({ "Content-Type": "application/json" }),
        credentials: "include",
        body: JSON.stringify({}),
      });
      if (!r.ok) {
        const err = await r.json() as { error?: string };
        toast({ title: "Error", description: err.error, variant: "destructive" });
        return;
      }
      const inf = await r.json() as Informe;
      setInforme(inf);
      if (turno) setTurno({ ...turno, estado: "publicado" });
      toast({ title: "Informe publicado al portal del paciente", description: "El paciente ya puede ver su informe." });
    } finally {
      setPublishing(false);
    }
  };

  const agregarImagen = async () => {
    if (!informe || !newImgUrl.trim()) return;
    setAddingImg(true);
    try {
      const r = await fetch(`/api/informes/${informe.id}/imagenes`, {
        method: "POST",
        headers: authHeaders({ "Content-Type": "application/json" }),
        credentials: "include",
        body: JSON.stringify({ url: newImgUrl.trim(), descripcion: newImgDesc || undefined }),
      });
      if (!r.ok) {
        const err = await r.json() as { error?: string };
        toast({ title: "Error", description: err.error, variant: "destructive" });
        return;
      }
      const img = await r.json() as Imagen;
      setInforme({ ...informe, imagenes: [...informe.imagenes, img] });
      setNewImgUrl("");
      setNewImgDesc("");
    } finally {
      setAddingImg(false);
    }
  };

  const eliminarImagen = async (imgId: number) => {
    if (!informe) return;
    await fetch(`/api/informes/${informe.id}/imagenes/${imgId}`, {
      method: "DELETE",
      credentials: "include",
      headers: authHeaders(),
    });
    setInforme({ ...informe, imagenes: informe.imagenes.filter((i) => i.id !== imgId) });
  };

  if (loading) {
    return (
      <div className="max-w-4xl mx-auto space-y-6">
        <div className="space-y-2">
          <div className="h-8 w-1/3 bg-muted animate-pulse rounded" />
          <div className="h-4 w-1/2 bg-muted animate-pulse rounded" />
        </div>
        <div className="h-64 bg-muted animate-pulse rounded" />
      </div>
    );
  }

  if (!turno) return null;

  return (
    <div className="max-w-4xl mx-auto space-y-6 pb-8">
      {/* Header */}
      <div>
        <Button variant="ghost" size="sm" onClick={() => navigate("/worklist")} className="mb-3 -ml-2">
          <ArrowLeft className="w-4 h-4 mr-1" /> Volver al worklist
        </Button>
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
              <FileText className="w-6 h-6 text-primary" />
              {informe ? "Editor de Informe" : "Nuevo Informe"}
            </h1>
            <div className="flex flex-wrap items-center gap-3 mt-1 text-sm text-muted-foreground">
              <span>
                {turno.fecha} — {turno.horaInicio.substring(0, 5)}
              </span>
              {turno.turnera?.especialidad?.nombre && (
                <span>{turno.turnera.especialidad.nombre}</span>
              )}
              {turno.profesional && (
                <span>{turno.profesional.apellido}, {turno.profesional.nombre}</span>
              )}
              <StatusBadge estado={turno.estado} />
            </div>
          </div>
          <div className="flex gap-2 shrink-0">
            {!isReadonly && (
              <Button variant="outline" onClick={() => void crearOGuardar()} disabled={saving}>
                {saving ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : <Save className="w-4 h-4 mr-1" />}
                Guardar borrador
              </Button>
            )}
            {informe?.estado === "borrador" && (
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button disabled={signing || !texto.trim()}>
                    <CheckCircle className="w-4 h-4 mr-1" />
                    Firmar informe
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>Firmar informe</AlertDialogTitle>
                    <AlertDialogDescription>
                      Al firmar, el informe quedará como <strong>Informado</strong> y no podrá ser editado. ¿Confirmás?
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>Cancelar</AlertDialogCancel>
                    <AlertDialogAction onClick={() => void firmar()}>Firmar</AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            )}
            {informe?.estado === "firmado" && (
              <Button onClick={() => void publicar()} disabled={publishing} className="bg-teal-600 hover:bg-teal-700">
                {publishing ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : <Globe className="w-4 h-4 mr-1" />}
                Publicar al portal
              </Button>
            )}
            {informe?.estado === "publicado" && (
              <Badge className="bg-teal-100 text-teal-700 border-teal-200 px-3 py-1.5">
                <Globe className="w-3.5 h-3.5 mr-1.5" />
                Publicado al portal
              </Badge>
            )}
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        {/* Columna principal — Informe */}
        <div className="md:col-span-2 space-y-5">
          {/* Paciente */}
          <div className="border rounded-lg p-4 bg-muted/20">
            <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1">Paciente</div>
            <div className="font-semibold text-lg">
              {turno.paciente
                ? `${turno.paciente.apellido}, ${turno.paciente.nombre}`
                : "Desconocido"}
            </div>
            {turno.paciente?.dni && (
              <div className="text-sm text-muted-foreground">DNI {turno.paciente.dni}</div>
            )}
            {turno.motivoConsulta && (
              <div className="text-sm mt-1 italic text-muted-foreground">"{turno.motivoConsulta}"</div>
            )}
          </div>

          {/* Texto del informe */}
          <div className="space-y-2">
            <Label htmlFor="texto" className="text-sm font-medium">
              Texto del informe
              {isReadonly && (
                <Badge variant="outline" className="ml-2 text-xs">Solo lectura</Badge>
              )}
            </Label>
            <Textarea
              id="texto"
              value={texto}
              onChange={(e) => setTexto(e.target.value)}
              disabled={isReadonly}
              rows={12}
              placeholder={
                isReadonly
                  ? ""
                  : "Redactá el informe aquí. Incluí los hallazgos, conclusiones y recomendaciones..."
              }
              className="font-mono text-sm leading-relaxed resize-none"
            />
          </div>

          {/* Firma */}
          {!isReadonly ? (
            <div className="space-y-2">
              <Label htmlFor="firma">Firma del informe</Label>
              <Input
                id="firma"
                value={firma}
                onChange={(e) => setFirma(e.target.value)}
                placeholder="Dr/a. Apellido, Nombre — Matrícula"
              />
            </div>
          ) : informe?.firma && (
            <div className="border-t pt-4">
              <SelloMedico profesional={informe.profesional} firmaTexto={informe.firma} firmadoEn={informe.firmadoEn} />
            </div>
          )}
        </div>

        {/* Columna lateral — PACS + Imágenes */}
        <div className="space-y-5">
          {/* PACS */}
          <div className="border rounded-lg p-4 space-y-3">
            <div className="text-sm font-semibold flex items-center gap-1.5">
              <ExternalLink className="w-4 h-4 text-muted-foreground" />
              PACS / Estudio
            </div>
            <div className="space-y-2">
              <Label className="text-xs">ID de estudio externo</Label>
              <Input
                value={pacsStudyId}
                onChange={(e) => setPacsStudyId(e.target.value)}
                disabled={isReadonly}
                placeholder="Ej: 1.2.3.4.5 o StudyUID"
                className="text-sm"
              />
            </div>
            <div className="space-y-2">
              <Label className="text-xs">URL viewer PACS (opcional)</Label>
              <Input
                value={pacsViewerUrl}
                onChange={(e) => setPacsViewerUrl(e.target.value)}
                disabled={isReadonly}
                placeholder="https://pacs.clinica.com/viewer?study=..."
                className="text-sm"
              />
              {pacsViewerUrl && (
                <a
                  href={pacsViewerUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-xs text-primary flex items-center gap-1 hover:underline"
                >
                  <ExternalLink className="w-3 h-3" /> Abrir en PACS
                </a>
              )}
            </div>
          </div>

          {/* Imágenes clave */}
          <div className="border rounded-lg p-4 space-y-3">
            <div className="text-sm font-semibold flex items-center gap-1.5">
              <ImageIcon className="w-4 h-4 text-muted-foreground" />
              Imágenes clave
              <Badge variant="outline" className="ml-auto text-xs">
                {informe?.imagenes.length ?? 0}/4
              </Badge>
            </div>

            {informe?.imagenes.map((img) => (
              <div key={img.id} className="group relative border rounded overflow-hidden">
                <img
                  src={img.url}
                  alt={img.descripcion ?? `Imagen ${img.orden}`}
                  className="w-full h-32 object-cover"
                  onError={(e) => {
                    (e.target as HTMLImageElement).src = "";
                    (e.target as HTMLImageElement).alt = "Error al cargar imagen";
                  }}
                />
                <div className="absolute bottom-0 left-0 right-0 bg-black/60 text-white text-xs px-2 py-1 flex justify-between items-center">
                  <span className="truncate">{img.descripcion ?? `Imagen ${img.orden}`}</span>
                  {!isReadonly && (
                    <button
                      onClick={() => void eliminarImagen(img.id)}
                      className="ml-2 opacity-80 hover:opacity-100"
                    >
                      <Trash2 className="w-3 h-3" />
                    </button>
                  )}
                </div>
              </div>
            ))}

            {!isReadonly && (informe?.imagenes.length ?? 0) < 4 && informe && (
              <div className="space-y-2 pt-1">
                <Input
                  value={newImgUrl}
                  onChange={(e) => setNewImgUrl(e.target.value)}
                  placeholder="URL de imagen clave del PACS"
                  className="text-xs"
                />
                <Input
                  value={newImgDesc}
                  onChange={(e) => setNewImgDesc(e.target.value)}
                  placeholder="Descripción (opcional)"
                  className="text-xs"
                />
                <Button
                  size="sm"
                  variant="outline"
                  className="w-full"
                  disabled={!newImgUrl.trim() || addingImg}
                  onClick={() => void agregarImagen()}
                >
                  {addingImg ? (
                    <Loader2 className="w-3 h-3 mr-1 animate-spin" />
                  ) : (
                    <Plus className="w-3 h-3 mr-1" />
                  )}
                  Agregar imagen
                </Button>
              </div>
            )}

            {!informe && (
              <p className="text-xs text-muted-foreground text-center py-2">
                Guardá el borrador primero para agregar imágenes
              </p>
            )}
          </div>

          {/* Plantillas personales del médico logueado */}
          {miProfesionalId != null && (
            <PlantillasPanel textoActual={texto} onAplicar={setTexto} disabled={isReadonly} />
          )}
        </div>
      </div>

      <Separator />

      {/* Preview modo publicado */}
      {informe?.estado === "publicado" && (
        <div className="border rounded-lg p-6 bg-muted/10">
          <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-4">
            Vista previa — lo que ve el paciente en el portal
          </div>
          <div className="font-semibold text-lg mb-1">
            {turno.paciente ? `${turno.paciente.apellido}, ${turno.paciente.nombre}` : "Paciente"}
          </div>
          <div className="text-sm text-muted-foreground mb-4">
            {turno.fecha} · {turno.turnera?.especialidad?.nombre}
          </div>
          <div className="whitespace-pre-wrap text-sm leading-relaxed border rounded bg-card p-4">
            {informe.texto}
          </div>
          {informe.imagenes.length > 0 && (
            <div className="mt-4 grid grid-cols-2 gap-3">
              {informe.imagenes.map((img) => (
                <div key={img.id} className="border rounded overflow-hidden">
                  <img src={img.url} alt={img.descripcion ?? ""} className="w-full h-32 object-cover" />
                  {img.descripcion && (
                    <div className="text-xs text-center p-1 bg-muted">{img.descripcion}</div>
                  )}
                </div>
              ))}
            </div>
          )}
          {informe.pacsViewerUrl && (
            <div className="mt-4">
              <a
                href={informe.pacsViewerUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 text-sm text-primary hover:underline border px-3 py-2 rounded-md"
              >
                <ExternalLink className="w-4 h-4" />
                Ver estudio completo en PACS
              </a>
            </div>
          )}
          <div className="mt-4 border-t pt-3">
            <SelloMedico profesional={informe.profesional} firmaTexto={informe.firma} firmadoEn={informe.firmadoEn} />
          </div>
        </div>
      )}
    </div>
  );
}
