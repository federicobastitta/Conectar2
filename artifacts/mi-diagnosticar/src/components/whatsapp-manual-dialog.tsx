import { useState } from "react";
import {
  useEnviarWhatsappManual,
  useGetWhatsappConfig,
  useUpdateWhatsappConfig,
  type Paciente,
} from "@workspace/api-client-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { PacienteBuscador } from "@/components/pacientes/paciente-buscador";
import { useToast } from "@/hooks/use-toast";
import { AlertTriangle, Link2, Loader2, MessageCircle, Phone, Send } from "lucide-react";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const MENSAJE_PLANTILLA_DEFAULT = "Hola, nos comunicamos de Diagnosticar";

/**
 * Envío manual de WhatsApp (Whaticket) a un paciente.
 * Se busca al paciente, se muestra su teléfono y se escribe el mensaje.
 * Para iniciar una conversación (canal WABA) se usa la plantilla aprobada por Meta.
 * El link mágico de ingreso puede ir de dos maneras:
 * - dentro del PRIMER mensaje, con la plantilla aprobada "con link" ({{1}}), o
 * - anexado a un mensaje de texto libre (ventana de 24 h, sin plantilla).
 */
export function WhatsappManualDialog({ open, onOpenChange }: Props) {
  const [paciente, setPaciente] = useState<Paciente | null>(null);
  const [mensaje, setMensaje] = useState("");
  const [telefonoManual, setTelefonoManual] = useState("");
  // WABA (canal oficial de Meta): iniciar una conversación SIEMPRE exige la
  // plantilla aprobada, por eso la casilla arranca marcada.
  const [usarPlantilla, setUsarPlantilla] = useState(true);
  // Plantilla aprobada CON variable {{1}}: manda el link de ingreso en el primer mensaje.
  const [conLinkIngreso, setConLinkIngreso] = useState(false);
  // Texto libre (ventana de 24 h): anexa el link mágico al final del mensaje.
  const [incluirLinkIngreso, setIncluirLinkIngreso] = useState(false);
  const [confirmando, setConfirmando] = useState(false);
  const [templateIdNuevo, setTemplateIdNuevo] = useState("");
  const [templateLinkIdNuevo, setTemplateLinkIdNuevo] = useState("");
  const { toast } = useToast();

  const config = useGetWhatsappConfig({ query: { enabled: open } });

  const guardarPlantilla = useUpdateWhatsappConfig({
    mutation: {
      onSuccess: () => {
        toast({ title: "Plantilla guardada", description: "El ID de la plantilla aprobada quedó configurado." });
        setTemplateIdNuevo("");
        setTemplateLinkIdNuevo("");
        void config.refetch();
      },
      onError: (e: unknown) => {
        const msg =
          e && typeof e === "object" && "error" in e
            ? String((e as { error: unknown }).error)
            : "No se pudo guardar la plantilla";
        toast({ title: "No se pudo guardar", description: msg, variant: "destructive" });
      },
    },
  });

  const enviar = useEnviarWhatsappManual({
    mutation: {
      onSuccess: (r) => {
        setConfirmando(false);
        if (r.estado === "fallida") {
          toast({
            title: "Whaticket no pudo enviar el mensaje",
            description: r.error ?? "Error desconocido",
            variant: "destructive",
          });
          return;
        }
        toast({
          title: r.estado === "enviada" ? "Mensaje enviado" : "Mensaje registrado",
          description:
            r.estado === "enviada"
              ? `WhatsApp enviado al ${r.destinatario}`
              : "Whaticket no está conectado todavía: el mensaje quedó registrado como simulado.",
        });
        setMensaje("");
        onOpenChange(false);
      },
      onError: (e: unknown) => {
        setConfirmando(false);
        const msg =
          e && typeof e === "object" && "error" in e
            ? String((e as { error: unknown }).error)
            : "Error al enviar el mensaje";
        toast({ title: "No se pudo enviar", description: msg, variant: "destructive" });
      },
    },
  });

  const cerrar = (abierto: boolean) => {
    if (!abierto) {
      setPaciente(null);
      setMensaje("");
      setTelefonoManual("");
      setUsarPlantilla(false);
      setConLinkIngreso(false);
      setIncluirLinkIngreso(false);
      setConfirmando(false);
    }
    onOpenChange(abierto);
  };

  const telefonoDestino = telefonoManual.trim() || paciente?.telefono || "";
  const plantillaFalta =
    !conLinkIngreso && usarPlantilla && config.data !== undefined && !config.data.plantillaConfigurada;
  const plantillaLinkFalta = conLinkIngreso && config.data !== undefined && !config.data.plantillaLinkConfigurada;
  const puedeEnviar =
    Boolean(paciente && telefonoDestino && mensaje.trim()) && !plantillaFalta && !plantillaLinkFalta && !enviar.isPending;

  const activarPlantilla = (activa: boolean) => {
    setUsarPlantilla(activa);
    if (activa) {
      setConLinkIngreso(false);
      // El link anexado solo va en texto libre (segundo mensaje, ventana de 24 h).
      setIncluirLinkIngreso(false);
    }
    if (activa && !mensaje.trim()) setMensaje(MENSAJE_PLANTILLA_DEFAULT);
  };

  const activarConLink = (activa: boolean) => {
    setConLinkIngreso(activa);
    if (activa) {
      setUsarPlantilla(false);
      setIncluirLinkIngreso(false);
    }
    if (activa && !mensaje.trim()) setMensaje(MENSAJE_PLANTILLA_DEFAULT);
  };

  const enviarAhora = () => {
    if (!paciente) return;
    enviar.mutate({
      data: {
        pacienteId: paciente.id,
        mensaje: mensaje.trim(),
        ...(telefonoManual.trim() ? { telefono: telefonoManual.trim() } : {}),
        ...(conLinkIngreso
          ? { conLinkIngreso: true }
          : usarPlantilla
            ? { usarPlantilla: true }
            : incluirLinkIngreso
              ? { incluirLinkIngreso: true }
              : {}),
      },
    });
  };

  return (
    <Dialog open={open} onOpenChange={cerrar}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <MessageCircle className="w-5 h-5 text-emerald-500" />
            Enviar WhatsApp
          </DialogTitle>
          <DialogDescription>
            Buscá al paciente y escribí el mensaje. Se envía por Whaticket a su número cargado.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <PacienteBuscador
            onSelect={setPaciente}
            autoFocus
            placeholder="Buscar paciente por nombre o DNI..."
            data-testid="whatsapp-buscar-paciente"
          />

          {paciente && (
            <div className="text-sm rounded-md border px-3 py-2 bg-muted/30 space-y-1">
              <div className="flex items-center gap-2">
                <span className="text-muted-foreground shrink-0">DNI</span>
                <span data-testid="whatsapp-dni">{paciente.dni ?? "—"}</span>
              </div>
              <div className="flex items-center gap-2">
                <Phone className="w-4 h-4 text-muted-foreground shrink-0" />
                {paciente.telefono ? (
                  <span data-testid="whatsapp-telefono">{paciente.telefono}</span>
                ) : (
                  <span className="text-amber-700 dark:text-amber-300">
                    Este paciente no tiene teléfono cargado — cargá un número abajo o editalo desde su ficha.
                  </span>
                )}
              </div>
            </div>
          )}

          {paciente && (
            <Input
              value={telefonoManual}
              onChange={(e) => setTelefonoManual(e.target.value)}
              placeholder={
                paciente.telefono ? "Otro número (opcional, ej: 3511234567)" : "Número de WhatsApp (ej: 3511234567)"
              }
              inputMode="tel"
              data-testid="whatsapp-telefono-manual"
            />
          )}

          <Textarea
            value={mensaje}
            onChange={(e) => setMensaje(e.target.value)}
            placeholder="Escribí el mensaje para el paciente..."
            rows={4}
            data-testid="whatsapp-mensaje"
          />

          <label className="flex items-start gap-2 text-sm cursor-pointer">
            <Checkbox
              checked={usarPlantilla}
              onCheckedChange={(v) => activarPlantilla(v === true)}
              className="mt-0.5"
              data-testid="whatsapp-usar-plantilla"
            />
            <span>
              Iniciar conversación con la plantilla aprobada
              <span className="block text-xs text-muted-foreground">
                Obligatorio para escribirle primero al paciente (canal oficial de Meta).
              </span>
            </span>
          </label>

          <label className="flex items-start gap-2 text-sm cursor-pointer">
            <Checkbox
              checked={conLinkIngreso}
              onCheckedChange={(v) => activarConLink(v === true)}
              className="mt-0.5"
              data-testid="whatsapp-con-link-ingreso"
            />
            <span>
              <span className="flex items-center gap-1">
                <Link2 className="w-3.5 h-3.5 text-emerald-600" />
                Iniciar conversación con la plantilla CON link de ingreso
              </span>
              <span className="block text-xs text-muted-foreground">
                El paciente recibe el acceso a Mi Diagnosticar en el primer mensaje, sin necesidad de responder
                (link único, sin clave).
              </span>
            </span>
          </label>

          {!usarPlantilla && !conLinkIngreso && (
            <label className="flex items-start gap-2 text-sm cursor-pointer">
              <Checkbox
                checked={incluirLinkIngreso}
                onCheckedChange={(v) => setIncluirLinkIngreso(v === true)}
                className="mt-0.5"
                data-testid="whatsapp-incluir-link-ingreso"
              />
              <span>
                Incluir link de ingreso a la app
                <span className="block text-xs text-muted-foreground">
                  Agrega al final un link mágico que loguea al paciente sin clave (un solo uso, vence en 72 h).
                </span>
              </span>
            </label>
          )}

          {plantillaLinkFalta && (
            <div className="space-y-2 rounded-md border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-950/40 px-3 py-2 text-sm">
              <div className="flex items-center gap-2 text-amber-800 dark:text-amber-200">
                <AlertTriangle className="w-4 h-4 shrink-0" />
                Todavía no hay una plantilla con link de ingreso configurada.
              </div>
              <div className="flex gap-2">
                <Input
                  value={templateLinkIdNuevo}
                  onChange={(e) => setTemplateLinkIdNuevo(e.target.value)}
                  placeholder="ID de plantilla con variable {{1}} (Meta)"
                  data-testid="whatsapp-template-link-id"
                />
                <Button
                  variant="secondary"
                  disabled={!templateLinkIdNuevo.trim() || guardarPlantilla.isPending}
                  onClick={() => guardarPlantilla.mutate({ data: { templateLinkId: templateLinkIdNuevo.trim() } })}
                  data-testid="whatsapp-guardar-plantilla-link"
                >
                  {guardarPlantilla.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : "Guardar"}
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">Solo un administrador puede guardarla.</p>
            </div>
          )}

          {plantillaFalta && (
            <div className="space-y-2 rounded-md border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-950/40 px-3 py-2 text-sm">
              <div className="flex items-center gap-2 text-amber-800 dark:text-amber-200">
                <AlertTriangle className="w-4 h-4 shrink-0" />
                Todavía no hay una plantilla aprobada configurada.
              </div>
              <div className="flex gap-2">
                <Input
                  value={templateIdNuevo}
                  onChange={(e) => setTemplateIdNuevo(e.target.value)}
                  placeholder="ID de plantilla aprobada por Meta"
                  data-testid="whatsapp-template-id"
                />
                <Button
                  variant="secondary"
                  disabled={!templateIdNuevo.trim() || guardarPlantilla.isPending}
                  onClick={() => guardarPlantilla.mutate({ data: { templateId: templateIdNuevo.trim() } })}
                  data-testid="whatsapp-guardar-plantilla"
                >
                  {guardarPlantilla.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : "Guardar"}
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">Solo un administrador puede guardarla.</p>
            </div>
          )}

          {!confirmando ? (
            <Button
              className="w-full"
              disabled={!puedeEnviar}
              onClick={() => setConfirmando(true)}
              data-testid="whatsapp-enviar"
            >
              <Send className="w-4 h-4 mr-2" />
              Enviar mensaje
            </Button>
          ) : (
            <div className="space-y-2 rounded-md border px-3 py-2">
              <p className="text-sm" data-testid="whatsapp-confirmacion">
                Se envía por Whaticket al <span className="font-medium">{telefonoDestino}</span>
                {conLinkIngreso
                  ? " usando la plantilla con link de ingreso (se genera un acceso único del paciente)"
                  : usarPlantilla
                    ? " usando la plantilla aprobada"
                    : incluirLinkIngreso
                      ? " con el link de ingreso anexado al mensaje"
                      : ""}
                . ¿Confirmás?
              </p>
              <div className="flex gap-2">
                <Button
                  className="flex-1"
                  disabled={enviar.isPending}
                  onClick={enviarAhora}
                  data-testid="whatsapp-confirmar"
                >
                  {enviar.isPending ? (
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  ) : (
                    <Send className="w-4 h-4 mr-2" />
                  )}
                  Confirmar envío
                </Button>
                <Button
                  variant="outline"
                  disabled={enviar.isPending}
                  onClick={() => setConfirmando(false)}
                  data-testid="whatsapp-cancelar-confirmacion"
                >
                  Volver
                </Button>
              </div>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
