import { useState, useEffect, useRef } from "react";
import { useParams, Link } from "wouter";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/hooks/use-auth";
import {
  ArrowLeft, FlaskConical, Image as ImageIcon, Star, PenLine, CheckCircle2,
  Globe, History, Layers, MonitorPlay, Undo2, Save, GitCompare,
  AlertTriangle, RefreshCw, Loader2, ExternalLink,
} from "lucide-react";
import {
  usePacsOrden,
  usePacsInforme,
  useGuardarBorrador,
  useFirmarInforme,
  usePublicarInforme,
  useCorregirInforme,
  useToggleImagenClave,
  useComentarImagenClave,
  useCambiarEstadoOperativo,
  useSesionVisor,
  ETIQUETAS_ESTADO,
  COLORES_ESTADO,
  PacsIndisponibleError,
  type EstadoOperativo,
  type PacsInforme,
  type ImagenClave,
} from "@/api/pacs-workspace";

// ── Helpers de formato ────────────────────────────────────────────────────────

function edad(fechaNacimiento: string): number {
  const n = new Date(`${fechaNacimiento}T00:00:00.000Z`);
  return Math.floor((Date.now() - n.getTime()) / (365.25 * 24 * 3600 * 1000));
}

function fmtFechaHora(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleString("es-AR", { dateStyle: "short", timeStyle: "short" });
}

// ── Visor contextual real (iframe con sesión de un solo uso) ──────────────────
function VisorReal({
  ordenId,
  tieneAccession,
  informe,
  editable,
  onToggleImagen,
}: {
  ordenId: number;
  tieneAccession: boolean;
  informe: PacsInforme | undefined;
  editable: boolean;
  onToggleImagen: (img: ImagenClave) => void;
}) {
  const sesion = useSesionVisor(ordenId);
  const [visorUrl, setVisorUrl] = useState<string | null>(null);
  const [iframeError, setIframeError] = useState(false);

  const abrirVisor = () => {
    if (!tieneAccession) return;
    sesion.mutate(undefined, {
      onSuccess: (data) => {
        const url = data.viewer_url ?? data.redeem_url ?? null;
        setVisorUrl(url);
        setIframeError(false);
      },
    });
  };

  if (!tieneAccession) {
    return (
      <div className="flex h-full min-h-[320px] flex-col items-center justify-center gap-2 rounded-lg border border-dashed bg-slate-950 p-6 text-center text-slate-400">
        <MonitorPlay className="h-8 w-8" />
        <p className="text-sm">La orden aún no fue enviada al PACS.</p>
        <p className="text-xs">Usá el botón "Enviar al PACS" para asignarle un accession number.</p>
      </div>
    );
  }

  if (!visorUrl) {
    return (
      <div className="flex h-full min-h-[320px] flex-col items-center justify-center gap-3 rounded-lg border border-dashed bg-slate-950 p-6 text-center text-slate-400">
        <MonitorPlay className="h-8 w-8 text-sky-400" />
        <p className="text-sm">El visor DiagnosticPACS está disponible para esta orden.</p>
        <Button
          size="sm"
          variant="outline"
          className="border-slate-700 bg-slate-900 text-slate-200 hover:bg-slate-800"
          onClick={abrirVisor}
          disabled={sesion.isPending}
        >
          {sesion.isPending ? (
            <><Loader2 className="mr-2 h-4 w-4 animate-spin" /> Abriendo sesión…</>
          ) : (
            <><MonitorPlay className="mr-2 h-4 w-4" /> Abrir visor</>
          )}
        </Button>
        {sesion.error && (
          <p className="text-xs text-red-400">{(sesion.error as Error).message}</p>
        )}
        <p className="text-[11px] text-slate-600">Sesión contextual · un solo uso · expira en 5 minutos</p>
      </div>
    );
  }

  if (iframeError) {
    return (
      <div className="flex h-full min-h-[320px] flex-col items-center justify-center gap-3 rounded-lg border border-dashed bg-slate-950 p-6 text-center text-slate-400">
        <AlertTriangle className="h-8 w-8 text-amber-400" />
        <p className="text-sm">No se pudo incrustar el visor en esta ventana.</p>
        <a
          href={visorUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1.5 text-xs text-sky-400 hover:underline"
        >
          <ExternalLink className="h-3.5 w-3.5" /> Abrir en nueva pestaña
        </a>
        <Button size="sm" variant="ghost" className="text-slate-400" onClick={abrirVisor}>
          <RefreshCw className="mr-1.5 h-3.5 w-3.5" /> Nueva sesión
        </Button>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col overflow-hidden rounded-lg border bg-slate-950 text-slate-200">
      <div className="flex items-center justify-between gap-2 border-b border-slate-800 px-3 py-2">
        <div className="flex items-center gap-2 text-xs">
          <MonitorPlay className="h-4 w-4 text-sky-400" />
          <span className="font-medium">Visor DiagnosticPACS</span>
          <Badge variant="outline" className="border-slate-700 bg-slate-900 text-[10px] text-emerald-400">
            SESIÓN ACTIVA
          </Badge>
        </div>
        <div className="flex items-center gap-2">
          <a
            href={visorUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-[11px] text-slate-500 hover:text-slate-300"
          >
            <ExternalLink className="h-3.5 w-3.5" />
          </a>
          <button
            className="text-[11px] text-slate-600 hover:text-slate-300"
            onClick={() => setVisorUrl(null)}
          >
            Cerrar
          </button>
        </div>
      </div>
      <iframe
        src={visorUrl}
        className="flex-1 min-h-[280px] w-full border-0"
        title="Visor DiagnosticPACS"
        onError={() => setIframeError(true)}
        allow="fullscreen"
      />
      {editable && informe && informe.imagenesClaveBorrador.length > 0 && (
        <div className="border-t border-slate-800 px-3 py-2 text-[11px] text-slate-500">
          Marcá imágenes clave desde el panel derecho para congelarlas con la firma.
        </div>
      )}
    </div>
  );
}

// ── Componente principal ──────────────────────────────────────────────────────

export default function EstudioWorkspace() {
  const params = useParams<{ id: string }>();
  const ordenId = parseInt(params.id ?? "");
  const { toast } = useToast();
  const { user } = useAuth();
  const [verVersion, setVerVersion] = useState<number | null>(null);

  const {
    data: orden,
    isLoading: cargandoOrden,
    error: errorOrden,
    pacsIndisponible: indisponibleOrden,
    refetch: refetchOrden,
  } = usePacsOrden(ordenId);

  const {
    data: informe,
    isLoading: cargandoInforme,
    error: errorInforme,
    pacsIndisponible: indisponibleInforme,
    refetch: refetchInforme,
  } = usePacsInforme(ordenId);

  const guardarBorrador = useGuardarBorrador(ordenId);
  const firmar = useFirmarInforme(ordenId);
  const publicar = usePublicarInforme(ordenId);
  const corregir = useCorregirInforme(ordenId);
  const cambiarEstado = useCambiarEstadoOperativo(ordenId);
  const toggleImagen = useToggleImagenClave(ordenId, informe);
  const comentarImagen = useComentarImagenClave(ordenId, informe);

  // Borrador local para evitar guardados en cada tecla
  const [borradorLocal, setBorradorLocal] = useState("");
  const borradorSincronizado = useRef(false);

  useEffect(() => {
    if (informe && !borradorSincronizado.current) {
      setBorradorLocal(informe.borradorActual);
      borradorSincronizado.current = true;
    }
  }, [informe]);

  // Resetear borradorSincronizado cuando cambia el informe (por firmar/corregir)
  useEffect(() => {
    if (informe) {
      setBorradorLocal(informe.borradorActual);
    }
  }, [informe?.informeEstado]);

  const pacsIndisponible = indisponibleOrden || indisponibleInforme;
  const errorGeneral = errorOrden ?? errorInforme;
  const cargando = cargandoOrden || cargandoInforme;

  if (!Number.isInteger(ordenId) || ordenId <= 0) {
    return (
      <div className="space-y-4">
        <Link href="/estudios" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeft className="h-4 w-4" /> Volver a estudios
        </Link>
        <p className="text-sm text-muted-foreground">ID de orden inválido.</p>
      </div>
    );
  }

  // ── Estados de carga / error / indisponible ──────────────────────────────────
  if (cargando) {
    return (
      <div className="space-y-4">
        <Link href="/estudios" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeft className="h-4 w-4" /> Volver a estudios
        </Link>
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Cargando workspace…
        </div>
      </div>
    );
  }

  if (pacsIndisponible) {
    return (
      <div className="space-y-4">
        <Link href="/estudios" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeft className="h-4 w-4" /> Volver a estudios
        </Link>
        <div className="flex items-start gap-2 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          <FlaskConical className="mt-0.5 h-4 w-4 shrink-0" />
          <div>
            <span className="font-semibold">Módulo PACS no disponible.</span>{" "}
            La integración DiagnosticPACS está desactivada. Contactá al área técnica.
          </div>
        </div>
      </div>
    );
  }

  if (errorGeneral || !orden) {
    return (
      <div className="space-y-4">
        <Link href="/estudios" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeft className="h-4 w-4" /> Volver a estudios
        </Link>
        <div className="flex items-center gap-3 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          <span className="flex-1">
            {(errorOrden as Error | null)?.message ?? "Orden no encontrada."}
          </span>
          <Button size="sm" variant="outline" onClick={() => { void refetchOrden(); void refetchInforme(); }}>
            <RefreshCw className="mr-1.5 h-4 w-4" /> Reintentar
          </Button>
        </div>
      </div>
    );
  }

  const esMedico = user?.rol === "medico" || user?.rol === "admin";
  const editable = informe?.informeEstado === "borrador" && esMedico;
  const firmante = user ? user.nombre : "Usuario";
  const versionMostrada = verVersion != null
    ? (informe?.versiones.find((v) => v.version === verVersion) ?? null)
    : null;

  const handleGuardarBorrador = () => {
    guardarBorrador.mutate(borradorLocal, {
      onSuccess: () => toast({ title: "Borrador guardado" }),
      onError: (err) => toast({ title: "Error al guardar", description: (err as Error).message, variant: "destructive" }),
    });
  };

  const handleFirmar = () => {
    if (!borradorLocal.trim()) {
      toast({ title: "El informe está vacío", description: "Redactá el informe antes de firmar.", variant: "destructive" });
      return;
    }
    // Guardar el texto local antes de firmar
    guardarBorrador.mutate(borradorLocal, {
      onSuccess: () => {
        firmar.mutate(undefined, {
          onSuccess: (data) => {
            toast({ title: `Informe firmado — versión ${data.version}`, description: "Las imágenes clave quedaron congeladas." });
            borradorSincronizado.current = false;
          },
          onError: (err) => toast({ title: "Error al firmar", description: (err as Error).message, variant: "destructive" }),
        });
      },
    });
  };

  const handlePublicar = () => {
    publicar.mutate(undefined, {
      onSuccess: () => toast({ title: "Informe publicado", description: "Visible para el paciente." }),
      onError: (err) => toast({ title: "Error al publicar", description: (err as Error).message, variant: "destructive" }),
    });
  };

  const handleCorregir = () => {
    corregir.mutate(undefined, {
      onSuccess: () => {
        toast({ title: "Borrador reabierto", description: "Al firmar de nuevo se creará una nueva versión." });
        borradorSincronizado.current = false;
      },
      onError: (err) => toast({ title: "Error", description: (err as Error).message, variant: "destructive" }),
    });
  };

  const handleCambiarEstado = (estado: EstadoOperativo) => {
    cambiarEstado.mutate(estado, {
      onSuccess: () => toast({ title: `Estado actualizado: ${ETIQUETAS_ESTADO[estado]}` }),
      onError: (err) => toast({ title: "Error", description: (err as Error).message, variant: "destructive" }),
    });
  };

  const estadoActual: EstadoOperativo = (informe?.estadoOperativo ?? orden.estadoOperativo) as EstadoOperativo;

  return (
    <div className="space-y-3">
      {/* Encabezado */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border bg-card px-4 py-3">
        <Link href="/estudios" className="text-muted-foreground hover:text-foreground">
          <ArrowLeft className="h-4 w-4" />
        </Link>
        <div className="min-w-0 flex-1">
          <p className="truncate font-semibold">
            {orden.paciente ? (
              <>
                {orden.paciente.apellido}, {orden.paciente.nombre}
                <span className="ml-2 font-normal text-muted-foreground">
                  {orden.paciente.fechaNacimiento ? `${edad(orden.paciente.fechaNacimiento)} años · ` : ""}
                  DNI {orden.paciente.dni ?? "—"} · {orden.paciente.cobertura ?? "Sin cobertura"}
                  {orden.paciente.nroAfiliado ? ` (${orden.paciente.nroAfiliado})` : ""}
                </span>
              </>
            ) : (
              <span className="text-muted-foreground">Paciente no asignado</span>
            )}
          </p>
          <p className="truncate text-sm text-muted-foreground">
            {orden.studyName}
            {orden.modality && <> · <Badge variant="outline" className="font-mono">{orden.modality}</Badge></>}
            {orden.scheduledAt && <> · {orden.scheduledAt.substring(0, 10)} {orden.scheduledAt.substring(11, 16)} hs</>}
            {orden.accessionNumber && <> · <span className="font-mono text-xs">{orden.accessionNumber}</span></>}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span className={`rounded-full border px-2.5 py-0.5 text-xs font-medium ${COLORES_ESTADO[estadoActual]}`}>
            {ETIQUETAS_ESTADO[estadoActual]}
          </span>
          {estadoActual === "AGENDADO" && (
            <Button size="sm" variant="outline" disabled={cambiarEstado.isPending}
              onClick={() => handleCambiarEstado("RECEPCIONADO")}>
              Recepcionar
            </Button>
          )}
          {estadoActual === "RECEPCIONADO" && (
            <Button size="sm" variant="outline" disabled={cambiarEstado.isPending}
              onClick={() => handleCambiarEstado("PENDIENTE_DE_INFORME")}>
              Marcar realizado
            </Button>
          )}
        </div>
      </div>

      {/* Error de informe (no crítico) */}
      {errorInforme && !(errorInforme instanceof PacsIndisponibleError) && (
        <div className="flex items-center gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
          <span>No se pudo cargar el informe: {(errorInforme as Error).message}</span>
          <button className="ml-auto text-amber-700 underline" onClick={() => void refetchInforme()}>
            Reintentar
          </button>
        </div>
      )}

      {/* 3 columnas */}
      <div className="grid gap-3 xl:grid-cols-[280px,minmax(0,1fr),380px]">
        {/* IZQUIERDA: contexto clínico */}
        <div className="space-y-3">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">Orden y contexto clínico</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
              {orden.motivoEstudio && (
                <div>
                  <p className="text-xs font-medium uppercase text-muted-foreground">Motivo del estudio</p>
                  <p>{orden.motivoEstudio}</p>
                </div>
              )}
              {orden.observacionesTecnico && (
                <div>
                  <p className="text-xs font-medium uppercase text-muted-foreground">Observaciones del técnico</p>
                  <p>{orden.observacionesTecnico}</p>
                </div>
              )}
              <Separator />
              {orden.profesional && (
                <p className="text-xs text-muted-foreground">
                  Solicitado por {orden.profesional.nombre} {orden.profesional.apellido ?? ""}
                  {orden.profesional.matricula ? ` (MP ${orden.profesional.matricula})` : ""}
                </p>
              )}
            </CardContent>
          </Card>

          {/* Estudios previos — placeholder clínico */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center gap-1.5 text-sm">
                <GitCompare className="h-4 w-4" /> Estudios previos
              </CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-xs text-muted-foreground">
                Los estudios previos del paciente se mostrarán aquí cuando esté disponible
                la consulta al historial PACS por paciente.
              </p>
            </CardContent>
          </Card>
        </div>

        {/* CENTRO: visor */}
        <div className="space-y-3">
          <VisorReal
            ordenId={ordenId}
            tieneAccession={Boolean(orden.accessionNumber)}
            informe={informe}
            editable={editable}
            onToggleImagen={toggleImagen}
          />

          {/* Imágenes clave seleccionadas */}
          {informe && (
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="flex items-center gap-1.5 text-sm">
                  <Star className="h-4 w-4 text-amber-500" /> Imágenes clave del informe ({informe.imagenesClaveBorrador.length})
                </CardTitle>
              </CardHeader>
              <CardContent>
                {informe.imagenesClaveBorrador.length === 0 ? (
                  <p className="text-xs text-muted-foreground">
                    Marcá imágenes con la estrella en el visor. Al firmar, se congelará una copia inmutable.
                  </p>
                ) : (
                  <ul className="space-y-2">
                    {informe.imagenesClaveBorrador.map((k) => (
                      <li key={k.keyImageId} className="flex items-start gap-3 rounded-md border px-3 py-2">
                        <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded bg-slate-100">
                          <ImageIcon className="h-5 w-5 text-slate-400" />
                        </div>
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-xs font-medium">{k.orden}. {k.titulo || k.sopInstanceUid}</p>
                          <Textarea
                            placeholder="Comentario médico sobre esta imagen…"
                            value={k.comentarioMedico}
                            disabled={!editable}
                            onChange={(e) => comentarImagen(k.keyImageId, e.target.value)}
                            className="mt-1 min-h-[40px] text-xs"
                          />
                        </div>
                        {editable && (
                          <Button
                            variant="ghost"
                            size="icon"
                            className="shrink-0"
                            onClick={() => toggleImagen(k)}
                            title="Quitar imagen clave"
                          >
                            <Undo2 className="h-4 w-4" />
                          </Button>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </CardContent>
            </Card>
          )}
        </div>

        {/* DERECHA: informe, versionado, firma */}
        <div className="space-y-3">
          {!informe && !cargandoInforme && (
            <Card>
              <CardContent className="py-8 text-center text-sm text-muted-foreground">
                <Loader2 className="mx-auto mb-2 h-5 w-5 animate-spin" />
                Inicializando informe…
              </CardContent>
            </Card>
          )}

          {informe && (
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="flex items-center justify-between text-sm">
                  <span className="flex items-center gap-1.5"><PenLine className="h-4 w-4" /> Informe</span>
                  <Badge
                    variant="outline"
                    className={
                      informe.informeEstado === "publicado"
                        ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                        : informe.informeEstado === "firmado"
                          ? "border-blue-200 bg-blue-50 text-blue-700"
                          : "border-amber-200 bg-amber-50 text-amber-700"
                    }
                  >
                    {informe.informeEstado === "borrador" ? "Borrador" : informe.informeEstado === "firmado" ? "Firmado" : "Publicado"}
                  </Badge>
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                {versionMostrada ? (
                  <div className="space-y-2">
                    <div className="flex items-center justify-between text-xs text-muted-foreground">
                      <span>
                        Versión {versionMostrada.version} — firmada por {versionMostrada.firmadoPorNombre ?? "—"} el{" "}
                        {fmtFechaHora(versionMostrada.firmadoEn)}
                      </span>
                      <button className="text-primary hover:underline" onClick={() => setVerVersion(null)}>
                        Volver al actual
                      </button>
                    </div>
                    <pre className="max-h-[380px] overflow-y-auto whitespace-pre-wrap rounded-md border bg-muted/30 p-3 text-xs">
                      {versionMostrada.texto}
                    </pre>
                  </div>
                ) : (
                  <>
                    <Textarea
                      placeholder={esMedico ? "Redactá el informe del estudio…" : "Solo el médico informante puede redactar."}
                      value={borradorLocal}
                      disabled={!editable}
                      onChange={(e) => setBorradorLocal(e.target.value)}
                      className="min-h-[300px] font-mono text-sm"
                    />
                    <div className="flex flex-wrap gap-2">
                      {editable && (
                        <>
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={handleGuardarBorrador}
                            disabled={guardarBorrador.isPending}
                          >
                            {guardarBorrador.isPending
                              ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
                              : <Save className="mr-1.5 h-4 w-4" />}
                            Guardar borrador
                          </Button>
                          <Button
                            size="sm"
                            disabled={!borradorLocal.trim() || firmar.isPending || guardarBorrador.isPending}
                            onClick={handleFirmar}
                          >
                            {firmar.isPending
                              ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
                              : <CheckCircle2 className="mr-1.5 h-4 w-4" />}
                            Firmar
                          </Button>
                        </>
                      )}
                      {informe.informeEstado === "firmado" && esMedico && (
                        <>
                          <Button size="sm" onClick={handlePublicar} disabled={publicar.isPending}>
                            {publicar.isPending
                              ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
                              : <Globe className="mr-1.5 h-4 w-4" />}
                            Publicar
                          </Button>
                          <Button size="sm" variant="outline" onClick={handleCorregir} disabled={corregir.isPending}>
                            <PenLine className="mr-1.5 h-4 w-4" /> Corregir (nueva versión)
                          </Button>
                        </>
                      )}
                      {informe.informeEstado === "publicado" && esMedico && (
                        <Button size="sm" variant="outline" onClick={handleCorregir} disabled={corregir.isPending}>
                          <PenLine className="mr-1.5 h-4 w-4" /> Corregir (nueva versión)
                        </Button>
                      )}
                    </div>
                  </>
                )}
              </CardContent>
            </Card>
          )}

          {/* Versiones */}
          {informe && (
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="flex items-center gap-1.5 text-sm">
                  <Layers className="h-4 w-4" /> Versiones ({informe.versiones.length})
                </CardTitle>
              </CardHeader>
              <CardContent>
                {informe.versiones.length === 0 ? (
                  <p className="text-xs text-muted-foreground">
                    Sin versiones firmadas todavía. Cada firma crea una versión inmutable.
                  </p>
                ) : (
                  <ul className="space-y-1.5">
                    {informe.versiones.map((v) => (
                      <li key={v.id}>
                        <button
                          onClick={() => setVerVersion(verVersion === v.version ? null : v.version)}
                          className={`block w-full rounded-md border px-3 py-2 text-left text-xs transition ${
                            verVersion === v.version
                              ? "border-primary bg-primary/5"
                              : "hover:bg-muted/50"
                          }`}
                        >
                          <span className="flex items-center justify-between">
                            <span className="flex items-center gap-1.5 font-medium">
                              <History className="h-3.5 w-3.5" /> Versión {v.version}
                              {v.publicadoEn && (
                                <Badge variant="outline" className="border-emerald-200 bg-emerald-50 text-[10px] text-emerald-700">
                                  Publicada
                                </Badge>
                              )}
                            </span>
                            <span className="text-muted-foreground">{fmtFechaHora(v.firmadoEn)}</span>
                          </span>
                          <span className="mt-0.5 block text-muted-foreground">
                            {v.firmadoPorNombre ?? "—"}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </CardContent>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}
