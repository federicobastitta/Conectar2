/**
 * Estudios previos aportados por el paciente.
 *
 * - <MisEstudiosPrevios />: card del portal del paciente con el botón
 *   "Subir estudios previos" (PDF o foto), listado y eliminación.
 * - <EstudiosPreviosHC />: vista de solo lectura para el equipo clínico en la
 *   historia clínica, marcada como "Aportado por el paciente".
 */

import { useRef, useState } from "react";
import { format } from "date-fns";
import { useQueryClient } from "@tanstack/react-query";
import {
  useGetEstudiosPreviosPaciente,
  useCreateEstudioPrevio,
  useDeleteEstudioPrevio,
  getGetEstudiosPreviosPacienteQueryKey,
  type EstudioPrevio,
} from "@workspace/api-client-react";
import { useToast } from "@/hooks/use-toast";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { FlaskConical, ImageIcon, FileText, FileUp, Trash2, Eye, Loader2, UploadCloud } from "lucide-react";

const TIPOS: { value: string; label: string }[] = [
  { value: "laboratorio", label: "Laboratorio" },
  { value: "imagen", label: "Imagen (radiografía, ecografía, mamografía...)" },
  { value: "informe", label: "Informe médico" },
  { value: "otro", label: "Otro" },
];

const TIPO_LABEL: Record<string, string> = {
  laboratorio: "Laboratorio",
  imagen: "Imagen",
  informe: "Informe",
  otro: "Otro",
};

function IconoTipo({ tipo }: { tipo: string }) {
  const cls = "w-5 h-5";
  if (tipo === "laboratorio") return <FlaskConical className={cls} />;
  if (tipo === "imagen") return <ImageIcon className={cls} />;
  return <FileText className={cls} />;
}

function authHeaders(extra: Record<string, string> = {}): Record<string, string> {
  const token = localStorage.getItem("auth_token");
  return token ? { ...extra, Authorization: `Bearer ${token}` } : extra;
}

async function verArchivo(estudio: EstudioPrevio, onError: (msg: string) => void) {
  try {
    const r = await fetch(`/api/pacientes/${estudio.pacienteId}/estudios-previos/${estudio.id}/archivo`, {
      headers: authHeaders(),
      credentials: "include",
    });
    if (!r.ok) {
      onError("No pudimos abrir el archivo. Intentá de nuevo.");
      return;
    }
    const blob = await r.blob();
    const url = URL.createObjectURL(blob);
    window.open(url, "_blank", "noopener");
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  } catch {
    onError("No pudimos abrir el archivo. Revisá tu conexión.");
  }
}

// ── Item de la lista (compartido) ──────────────────────────────────────────
function EstudioPrevioItem({
  estudio,
  onVer,
  accionesExtra,
}: {
  estudio: EstudioPrevio;
  onVer: () => void;
  accionesExtra?: React.ReactNode;
}) {
  return (
    <Card data-testid={`card-estudio-previo-${estudio.id}`}>
      <CardContent className="p-4 flex items-start gap-3">
        <div className="bg-violet-100 text-violet-700 dark:bg-violet-900/40 dark:text-violet-300 rounded-lg p-2 shrink-0">
          <IconoTipo tipo={estudio.tipo} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-semibold truncate">{estudio.titulo}</span>
            <Badge variant="secondary" className="text-xs">{TIPO_LABEL[estudio.tipo] ?? estudio.tipo}</Badge>
          </div>
          <p className="text-xs text-muted-foreground mt-0.5">
            {estudio.fechaEstudio ? `Realizado: ${estudio.fechaEstudio} · ` : ""}
            Subido el {format(new Date(estudio.createdAt), "dd/MM/yyyy")}
          </p>
          {estudio.descripcion && <p className="text-sm mt-1">{estudio.descripcion}</p>}
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <Button variant="ghost" size="icon" onClick={onVer} title="Ver archivo" data-testid={`button-ver-estudio-previo-${estudio.id}`}>
            <Eye className="w-4 h-4" />
          </Button>
          {accionesExtra}
        </div>
      </CardContent>
    </Card>
  );
}

// ── Diálogo de subida ──────────────────────────────────────────────────────
function SubirEstudioDialog({
  pacienteId,
  open,
  onOpenChange,
}: {
  pacienteId: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const fileRef = useRef<HTMLInputElement>(null);
  const [tipo, setTipo] = useState("laboratorio");
  const [titulo, setTitulo] = useState("");
  const [descripcion, setDescripcion] = useState("");
  const [fechaEstudio, setFechaEstudio] = useState("");
  const [archivo, setArchivo] = useState<File | null>(null);
  const [subiendo, setSubiendo] = useState(false);

  const crear = useCreateEstudioPrevio();

  const limpiar = () => {
    setTipo("laboratorio");
    setTitulo("");
    setDescripcion("");
    setFechaEstudio("");
    setArchivo(null);
    if (fileRef.current) fileRef.current.value = "";
  };

  const elegirArchivo = (file: File | null) => {
    if (!file) { setArchivo(null); return; }
    if (!["application/pdf", "image/png", "image/jpeg", "image/webp"].includes(file.type)) {
      toast({ title: "Formato no soportado", description: "Subí un PDF o una foto (JPG/PNG).", variant: "destructive" });
      return;
    }
    if (file.size > 20 * 1024 * 1024) {
      toast({ title: "Archivo muy grande", description: "Máximo 20 MB.", variant: "destructive" });
      return;
    }
    setArchivo(file);
    if (!titulo.trim()) setTitulo(file.name.replace(/\.[^.]+$/, ""));
  };

  const subir = async () => {
    if (!archivo || !titulo.trim()) return;
    setSubiendo(true);
    try {
      const rUrl = await fetch(`/api/pacientes/${pacienteId}/estudios-previos/upload-url`, {
        method: "POST",
        headers: authHeaders({ "Content-Type": "application/json" }),
        credentials: "include",
        body: JSON.stringify({ name: archivo.name, size: archivo.size, contentType: archivo.type }),
      });
      if (!rUrl.ok) {
        const err = (await rUrl.json().catch(() => ({}))) as { error?: string };
        toast({ title: "No se pudo iniciar la subida", description: err.error, variant: "destructive" });
        return;
      }
      const { uploadURL, objectPath } = (await rUrl.json()) as { uploadURL: string; objectPath: string };

      const rPut = await fetch(uploadURL, {
        method: "PUT",
        headers: { "Content-Type": archivo.type },
        body: archivo,
      });
      if (!rPut.ok) {
        toast({ title: "Falló la subida del archivo", description: "Intentá de nuevo.", variant: "destructive" });
        return;
      }

      await crear.mutateAsync({
        id: pacienteId,
        data: {
          tipo: tipo as "laboratorio" | "imagen" | "informe" | "otro",
          titulo: titulo.trim(),
          descripcion: descripcion.trim() || undefined,
          fechaEstudio: fechaEstudio.trim() || undefined,
          objectPath,
          nombreArchivo: archivo.name,
          contentType: archivo.type,
          tamanoBytes: archivo.size,
        },
      });

      queryClient.invalidateQueries({ queryKey: getGetEstudiosPreviosPacienteQueryKey(pacienteId) });
      toast({ title: "Estudio subido", description: "Tu médico ya lo puede ver en tu historia clínica." });
      limpiar();
      onOpenChange(false);
    } catch {
      toast({ title: "No se pudo guardar el estudio", description: "Intentá de nuevo.", variant: "destructive" });
    } finally {
      setSubiendo(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!subiendo) onOpenChange(o); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Subir estudio previo</DialogTitle>
          <DialogDescription>
            Cargá un estudio hecho en otro lugar (análisis, radiografía, informe) para que tu médico lo tenga a mano.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-2">
            <label className="text-sm font-medium">Tipo de estudio</label>
            <Select value={tipo} onValueChange={setTipo}>
              <SelectTrigger data-testid="select-tipo-estudio-previo">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {TIPOS.map((t) => (
                  <SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium">Archivo (PDF o foto, máx. 20 MB)</label>
            <input
              ref={fileRef}
              type="file"
              accept="application/pdf,image/png,image/jpeg,image/webp"
              className="hidden"
              onChange={(e) => elegirArchivo(e.target.files?.[0] ?? null)}
              data-testid="input-archivo-estudio-previo"
            />
            <Button
              type="button"
              variant="outline"
              className="w-full justify-start"
              onClick={() => fileRef.current?.click()}
              data-testid="button-elegir-archivo"
            >
              <FileUp className="w-4 h-4 mr-2" />
              <span className="truncate">{archivo ? archivo.name : "Elegir archivo..."}</span>
            </Button>
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium">Título</label>
            <Input
              value={titulo}
              onChange={(e) => setTitulo(e.target.value)}
              placeholder="Ej: Análisis de sangre completo"
              data-testid="input-titulo-estudio-previo"
            />
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium">¿Cuándo te lo hiciste? (opcional)</label>
            <Input
              value={fechaEstudio}
              onChange={(e) => setFechaEstudio(e.target.value)}
              placeholder="Ej: marzo 2026"
              data-testid="input-fecha-estudio-previo"
            />
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium">Comentario (opcional)</label>
            <Textarea
              value={descripcion}
              onChange={(e) => setDescripcion(e.target.value)}
              placeholder="Algo que quieras aclararle a tu médico"
              rows={2}
              data-testid="input-descripcion-estudio-previo"
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={subiendo}>
            Cancelar
          </Button>
          <Button onClick={subir} disabled={!archivo || !titulo.trim() || subiendo} data-testid="button-confirmar-subida">
            {subiendo ? (
              <><Loader2 className="w-4 h-4 mr-2 animate-spin" /> Subiendo...</>
            ) : (
              <><UploadCloud className="w-4 h-4 mr-2" /> Subir estudio</>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Card del portal del paciente ───────────────────────────────────────────
export function MisEstudiosPrevios({ pacienteId }: { pacienteId: number }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [dialogAbierto, setDialogAbierto] = useState(false);
  const { data: estudios, isLoading } = useGetEstudiosPreviosPaciente(pacienteId);

  const eliminar = useDeleteEstudioPrevio({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getGetEstudiosPreviosPacienteQueryKey(pacienteId) });
        toast({ title: "Estudio eliminado" });
      },
      onError: () => {
        toast({ title: "No se pudo eliminar", description: "Intentá de nuevo.", variant: "destructive" });
      },
    },
  });

  return (
    <div className="space-y-4 animate-in fade-in duration-500" data-testid="seccion-estudios-previos">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-xl font-bold">Mis estudios previos</h2>
          <p className="text-sm text-muted-foreground">
            Subí estudios y laboratorios hechos en otra institución para que tu médico los vea.
          </p>
        </div>
        <Button onClick={() => setDialogAbierto(true)} data-testid="button-subir-estudios-previos">
          <UploadCloud className="w-4 h-4 mr-2" /> Subir mis estudios de otra institución y laboratorios
        </Button>
      </div>

      {isLoading ? null : (estudios?.length ?? 0) === 0 ? (
        <Card className="bg-muted/20 border-dashed">
          <CardContent className="py-6 text-center text-sm text-muted-foreground">
            Todavía no subiste ningún estudio. Podés cargar análisis, radiografías o informes en PDF o foto.
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-3">
          {(estudios ?? []).map((e) => (
            <EstudioPrevioItem
              key={e.id}
              estudio={e}
              onVer={() => verArchivo(e, (msg) => toast({ title: "Error", description: msg, variant: "destructive" }))}
              accionesExtra={
                <AlertDialog>
                  <AlertDialogTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="text-destructive hover:text-destructive"
                      title="Eliminar"
                      data-testid={`button-eliminar-estudio-previo-${e.id}`}
                    >
                      <Trash2 className="w-4 h-4" />
                    </Button>
                  </AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>¿Eliminar este estudio?</AlertDialogTitle>
                      <AlertDialogDescription>
                        Se va a quitar "{e.titulo}" de tu historia clínica. Esta acción no se puede deshacer.
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel>Cancelar</AlertDialogCancel>
                      <AlertDialogAction
                        className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                        onClick={() => eliminar.mutate({ id: pacienteId, estudioPrevioId: e.id })}
                      >
                        Eliminar
                      </AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              }
            />
          ))}
        </div>
      )}

      <SubirEstudioDialog pacienteId={pacienteId} open={dialogAbierto} onOpenChange={setDialogAbierto} />
    </div>
  );
}

// ── Vista de solo lectura para la historia clínica (staff) ─────────────────
export function EstudiosPreviosHC({ pacienteId }: { pacienteId: number }) {
  const { toast } = useToast();
  const { data: estudios, isLoading } = useGetEstudiosPreviosPaciente(pacienteId);

  if (isLoading) return null;
  if ((estudios?.length ?? 0) === 0) return null;

  return (
    <Card data-testid="card-estudios-previos-hc">
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <UploadCloud className="w-4 h-4 text-violet-600 dark:text-violet-400" />
          Estudios aportados por el paciente
        </CardTitle>
        <CardDescription>
          Archivos que el paciente subió desde su app. No fueron validados por la institución.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3">
        {(estudios ?? []).map((e) => (
          <EstudioPrevioItem
            key={e.id}
            estudio={e}
            onVer={() => verArchivo(e, (msg) => toast({ title: "Error", description: msg, variant: "destructive" }))}
          />
        ))}
      </CardContent>
    </Card>
  );
}
