import { useEffect, useRef, useState } from "react";
import { Html5Qrcode } from "html5-qrcode";
import { getTurnoPorQr, type TurnoPorQr } from "@workspace/api-client-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Loader2, QrCode, Camera, CameraOff } from "lucide-react";

// Escáner de QR de turnos en recepción: cámara (webcam / celular) + entrada
// manual (sirve también para pistolas lectoras, que "tipean" el código).
export function EscanearQrDialog({
  open,
  onOpenChange,
  onTurnoEncontrado,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onTurnoEncontrado: (turno: TurnoPorQr) => void;
}) {
  const [codigoManual, setCodigoManual] = useState("");
  const [buscando, setBuscando] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [camaraError, setCamaraError] = useState(false);
  const scannerRef = useRef<Html5Qrcode | null>(null);
  const buscandoRef = useRef(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const buscar = async (codigo: string) => {
    const limpio = codigo.trim();
    if (!limpio || buscandoRef.current) return;
    buscandoRef.current = true;
    setBuscando(true);
    setError(null);
    try {
      const turno = await getTurnoPorQr(limpio);
      onTurnoEncontrado(turno);
      onOpenChange(false);
    } catch {
      setError("No se encontró ningún turno con ese código. Verificá el QR o buscá al paciente por nombre.");
    } finally {
      buscandoRef.current = false;
      setBuscando(false);
    }
  };

  useEffect(() => {
    if (!open) {
      setCodigoManual("");
      setError(null);
      setCamaraError(false);
      return;
    }
    let cancelado = false;
    const scanner = new Html5Qrcode("qr-scanner-region");
    scannerRef.current = scanner;
    scanner
      .start(
        { facingMode: "environment" },
        { fps: 10, qrbox: { width: 220, height: 220 } },
        (texto) => { void buscar(texto); },
        () => {},
      )
      .catch(() => { if (!cancelado) setCamaraError(true); });

    return () => {
      cancelado = true;
      scannerRef.current = null;
      if (scanner.isScanning) {
        scanner.stop().then(() => scanner.clear()).catch(() => {});
      } else {
        try { scanner.clear(); } catch { /* región ya desmontada */ }
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <QrCode className="w-5 h-5" /> Escanear QR del turno
          </DialogTitle>
          <DialogDescription>
            Pedile al paciente que muestre el QR de su turno. También podés tipear el código o usar la pistola lectora.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="relative rounded-lg overflow-hidden bg-black/90 min-h-[240px] flex items-center justify-center">
            <div id="qr-scanner-region" className="w-full" />
            {camaraError && (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-white/80 text-sm p-6 text-center">
                <CameraOff className="w-8 h-8 opacity-60" />
                <p>No se pudo acceder a la cámara. Usá el código manual o la pistola lectora.</p>
              </div>
            )}
            {!camaraError && (
              <div className="absolute top-2 left-2 flex items-center gap-1.5 text-[11px] text-white/80 bg-black/40 px-2 py-0.5 rounded-full">
                <Camera className="w-3 h-3" /> Apuntá al QR del paciente
              </div>
            )}
          </div>

          <form
            className="flex gap-2"
            onSubmit={(e) => { e.preventDefault(); void buscar(codigoManual); }}
          >
            <Input
              ref={inputRef}
              autoFocus
              placeholder="O ingresá el código a mano…"
              value={codigoManual}
              onChange={(e) => setCodigoManual(e.target.value)}
              data-testid="input-qr-manual"
            />
            <Button type="submit" disabled={buscando || !codigoManual.trim()} data-testid="button-buscar-qr">
              {buscando ? <Loader2 className="w-4 h-4 animate-spin" /> : "Buscar"}
            </Button>
          </form>

          {error && <p className="text-sm text-red-600">{error}</p>}
        </div>
      </DialogContent>
    </Dialog>
  );
}
