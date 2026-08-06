import { QRCodeSVG } from "qrcode.react";

// QR del turno: el paciente lo muestra en recepción y al escanearlo
// se abre su ficha directo, sin buscarlo a mano.
export function TurnoQr({ codigo, size = 168 }: { codigo: string; size?: number }) {
  return (
    <div className="flex flex-col items-center gap-2">
      <div className="bg-white p-3 rounded-xl border shadow-sm">
        <QRCodeSVG value={codigo} size={size} level="M" />
      </div>
      <p className="text-xs text-muted-foreground text-center max-w-[220px]">
        Mostrá este código en recepción para que te identifiquen al instante.
      </p>
    </div>
  );
}
