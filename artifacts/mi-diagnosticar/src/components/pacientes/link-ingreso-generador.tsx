import { useState } from "react";
import { Link2, Loader2, Copy, Check, Search, QrCode } from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { FaWhatsapp } from "react-icons/fa";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";

// ── Generador de links de ingreso al portal del paciente ────────────────────
// Flujo elegido por el usuario: cargar el DNI, generar el link y mandarlo "por
// afuera" (WhatsApp propio del operador), sin depender de plantillas de Meta.

function authHeaders(extra: Record<string, string> = {}): Record<string, string> {
  const token = localStorage.getItem("auth_token") ?? "";
  return { Authorization: `Bearer ${token}`, ...extra };
}

type PacienteBusqueda = {
  id: number;
  nombre: string;
  apellido: string;
  dni?: string | null;
  telefono?: string | null;
};

type LinkGenerado = { link: string; pacienteNombre: string; telefono: string | null };

export function LinkIngresoGenerador({ variante = "boton" }: { variante?: "boton" | "header" }) {
  const { toast } = useToast();
  const [abierto, setAbierto] = useState(false);
  const [dni, setDni] = useState("");
  const [buscando, setBuscando] = useState(false);
  const [paciente, setPaciente] = useState<PacienteBusqueda | null>(null);
  const [generando, setGenerando] = useState(false);
  const [resultado, setResultado] = useState<LinkGenerado | null>(null);
  const [copiado, setCopiado] = useState(false);

  const reiniciar = () => {
    setDni("");
    setPaciente(null);
    setResultado(null);
    setCopiado(false);
  };

  async function buscar() {
    const limpio = dni.replace(/\D/g, "");
    if (limpio.length < 6) {
      toast({ title: "Escribí el DNI completo (solo números)", variant: "destructive" });
      return;
    }
    setBuscando(true);
    setPaciente(null);
    setResultado(null);
    try {
      const r = await fetch(`/api/pacientes?q=${limpio}&soloActivos=true&limit=5`, { headers: authHeaders() });
      if (!r.ok) throw new Error("No se pudo buscar el paciente");
      // La respuesta real de GET /pacientes es { data, total, page, limit }.
      const data = (await r.json()) as { data?: PacienteBusqueda[] } | PacienteBusqueda[];
      const lista = Array.isArray(data) ? data : (data.data ?? []);
      const exacto = lista.find((p) => (p.dni ?? "").replace(/\D/g, "") === limpio);
      if (!exacto) {
        toast({ title: "No hay ningún paciente activo con ese DNI", variant: "destructive" });
        return;
      }
      setPaciente(exacto);
    } catch (e) {
      toast({ title: e instanceof Error ? e.message : "Error buscando el paciente", variant: "destructive" });
    } finally {
      setBuscando(false);
    }
  }

  async function generar() {
    if (!paciente) return;
    setGenerando(true);
    try {
      const r = await fetch(`/api/pacientes/${paciente.id}/links-ingreso`, {
        method: "POST",
        headers: authHeaders(),
      });
      const body = (await r.json().catch(() => ({}))) as LinkGenerado & { error?: string };
      if (!r.ok) throw new Error(body.error ?? "No se pudo generar el link");
      setResultado(body);
    } catch (e) {
      toast({ title: e instanceof Error ? e.message : "Error generando el link", variant: "destructive" });
    } finally {
      setGenerando(false);
    }
  }

  async function copiar() {
    if (!resultado) return;
    await navigator.clipboard.writeText(resultado.link);
    setCopiado(true);
    setTimeout(() => setCopiado(false), 2500);
  }

  const mensajeWhatsapp = resultado
    ? `Hola! Te escribimos de Diagnosticar. Este es tu link personal de ingreso a la app Mi Diagnosticar (guardalo, es tuyo y podés usarlo siempre): ${resultado.link}`
    : "";
  const telefonoDigitos = (resultado?.telefono ?? "").replace(/\D/g, "");
  const urlWhatsapp = telefonoDigitos
    ? `https://wa.me/${telefonoDigitos.startsWith("54") ? telefonoDigitos : `54${telefonoDigitos}`}?text=${encodeURIComponent(mensajeWhatsapp)}`
    : `https://wa.me/?text=${encodeURIComponent(mensajeWhatsapp)}`;

  return (
    <>
      {variante === "header" ? (
        <button
          type="button"
          onClick={() => {
            reiniciar();
            setAbierto(true);
          }}
          title="Generar link de ingreso del paciente"
          data-testid="boton-header-generador-link"
          className="relative h-9 w-9 rounded-lg bg-yellow-500 text-white hover:bg-yellow-400 ring-1 ring-yellow-300/60 inline-flex items-center justify-center"
        >
          <Link2 className="w-4 h-4" />
        </button>
      ) : (
        <Button
          variant="outline"
          onClick={() => {
            reiniciar();
            setAbierto(true);
          }}
          data-testid="button-abrir-generador-link"
        >
          <Link2 className="w-4 h-4 mr-1.5" />
          Link de ingreso
        </Button>
      )}
      <Dialog open={abierto} onOpenChange={setAbierto}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Generar link de ingreso al portal</DialogTitle>
            <DialogDescription>
              Cargá el DNI del paciente y el sistema genera su link personal de acceso a la app
              Mi Diagnosticar. Después lo mandás vos por WhatsApp.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="flex gap-2">
              <Input
                value={dni}
                onChange={(e) => setDni(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && buscar()}
                placeholder="DNI del paciente (solo números)"
                inputMode="numeric"
                data-testid="input-generador-dni"
              />
              <Button onClick={buscar} disabled={buscando} data-testid="button-generador-buscar">
                {buscando ? <Loader2 className="w-4 h-4 animate-spin" /> : <Search className="w-4 h-4" />}
              </Button>
            </div>

            {paciente && (
              <div className="rounded-md border p-3 text-sm space-y-2">
                <div>
                  <span className="font-semibold">
                    {paciente.apellido}, {paciente.nombre}
                  </span>{" "}
                  <span className="text-muted-foreground">· DNI {paciente.dni}</span>
                  {paciente.telefono && <span className="text-muted-foreground"> · Tel {paciente.telefono}</span>}
                </div>
                {!resultado && (
                  <Button onClick={generar} disabled={generando} className="w-full" data-testid="button-generador-generar">
                    {generando ? <Loader2 className="w-4 h-4 animate-spin mr-1.5" /> : <Link2 className="w-4 h-4 mr-1.5" />}
                    Generar link de ingreso
                  </Button>
                )}
              </div>
            )}

            {resultado && (
              <div className="rounded-md border border-emerald-300 bg-emerald-50 dark:bg-emerald-950/30 p-3 space-y-2">
                <p className="text-xs text-emerald-800 dark:text-emerald-200 font-medium">
                  Link generado (es permanente: el paciente lo puede usar siempre)
                </p>
                <p className="text-xs break-all bg-background rounded border p-2 select-all" data-testid="texto-link-generado">
                  {resultado.link}
                </p>
                {/* QR para que el paciente lo escanee en el mostrador */}
                <div className="flex justify-center py-1">
                  <div className="bg-white p-3 rounded-lg" data-testid="qr-link-generado">
                    <QRCodeSVG value={resultado.link} size={168} level="M" />
                  </div>
                </div>
                <p className="text-[11px] text-center text-muted-foreground">
                  El paciente puede escanear este QR con la cámara del celular y entra directo.
                </p>
                <div className="flex gap-2">
                  <Button variant="outline" size="sm" className="flex-1" onClick={copiar} data-testid="button-generador-copiar">
                    {copiado ? <Check className="w-4 h-4 mr-1.5 text-emerald-600" /> : <Copy className="w-4 h-4 mr-1.5" />}
                    {copiado ? "Copiado" : "Copiar"}
                  </Button>
                  <Button
                    size="sm"
                    className="flex-1 bg-emerald-600 hover:bg-emerald-700 text-white"
                    onClick={() => window.open(urlWhatsapp, "_blank", "noopener")}
                    data-testid="button-generador-whatsapp"
                  >
                    <FaWhatsapp className="w-4 h-4 mr-1.5" />
                    Mandar por WhatsApp
                  </Button>
                </div>
                <p className="text-[11px] text-muted-foreground">
                  Se abre tu WhatsApp con el mensaje listo; solo tocás enviar. Si generás otro link, los anteriores siguen
                  funcionando (se anulan desde la ficha del paciente).
                </p>
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
