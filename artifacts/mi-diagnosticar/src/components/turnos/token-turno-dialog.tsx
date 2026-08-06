import { useGetRobotKlinicosEstado } from "@workspace/api-client-react";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { KeyRound, Loader2, ShieldCheck, CheckCircle2, AlertTriangle, Clock } from "lucide-react";

// Ventana emergente para cargar y validar el token IOMA apenas se carga un
// turno del día. El token lo genera el paciente en su app y vale solo para el
// día de atención, por eso para turnos programados a futuro esta ventana no
// se muestra. Siempre se puede cerrar con "Cargar después": el token queda
// pendiente y se puede validar desde la ficha de recepción — pero si hay una
// validación en curso, sigue en segundo plano y el cartel grande salta igual
// (lo maneja el ValidacionTokenProvider global).
import { useState } from "react";
import { useValidacionToken, ESTADOS_DENEGACION } from "@/contexts/validacion-token-provider";

// Reexportado para los call sites existentes; la lista canónica de
// denegaciones reales de IOMA/Klinicos vive en el provider global.
export { ESTADOS_DENEGACION };

export function TokenTurnoDialog({
  turnoId,
  paciente,
  abierto,
  onClose,
}: {
  turnoId: number | null;
  paciente?: string;
  abierto: boolean;
  onClose: () => void;
}) {
  const [token, setToken] = useState("");
  const {
    resultado: resultadoGlobal,
    turnoIdEnCurso,
    validando: validandoGlobal,
    esperandoReintento,
    agotado,
    validar,
    cancelar,
  } = useValidacionToken();
  // El estado es global: mostrar solo lo que corresponde a ESTE turno para
  // no arrastrar resultados/spinners de una validación de otro turno.
  const esPropio = turnoIdEnCurso != null && turnoIdEnCurso === turnoId;
  const resultado = esPropio ? resultadoGlobal : null;
  const validando = esPropio && validandoGlobal;

  const { data: robot } = useGetRobotKlinicosEstado(undefined, { query: { enabled: abierto } });

  const cerrar = () => {
    setToken("");
    // Si hay una validación en curso, NO cancelarla: sigue en segundo plano
    // y el cartel grande salta donde sea que esté el operador. Solo se limpia
    // el estado global cuando la validación de ESTE turno ya terminó.
    if (esPropio && !validando) cancelar();
    onClose();
  };

  const validarAhora = () => {
    if (!turnoId || !token.trim()) return;
    validar(turnoId, token.trim(), paciente ?? null);
  };

  const aceptado = resultado?.estado === "TOKEN_ACCEPTED";
  const rechazado = ESTADOS_DENEGACION.includes(resultado?.estado ?? "");

  // El cartel grande a pantalla completa lo renderiza el
  // ValidacionTokenProvider global (salta aunque este dialog esté cerrado).
  return (
    <Dialog open={abierto} onOpenChange={(v) => { if (!v) cerrar(); }}>
      <DialogContent className="sm:max-w-md" data-testid="dialog-token-turno">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <KeyRound className="w-5 h-5 text-primary" /> Cargue token
          </DialogTitle>
          <DialogDescription>
            {paciente ? `${paciente} — ` : ""}
            Ingresá el token que el paciente generó en su app para validar la consulta con IOMA.
          </DialogDescription>
        </DialogHeader>

        {robot?.validacionHabilitada && (
          <p className="text-xs text-muted-foreground flex items-center gap-2" data-testid="dialog-token-robot">
            <span className={`inline-block w-2 h-2 rounded-full ${robot?.disponible ? "bg-emerald-500" : "bg-red-500"}`} />
            Robot {robot?.disponible ? "disponible" : "no disponible"}
          </p>
        )}

        {aceptado && resultado?.nroBono ? (
          <div className="rounded-md border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-800 flex items-start gap-2" data-testid="dialog-token-aceptado">
            <CheckCircle2 className="w-4 h-4 mt-0.5 shrink-0" />
            <span>Autorizado en Klinicos. N° de Bono {resultado.nroBono}.</span>
          </div>
        ) : aceptado ? (
          <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 flex items-start gap-2" data-testid="dialog-token-sin-bono">
            <CheckCircle2 className="w-4 h-4 mt-0.5 shrink-0" />
            <span>
              NO autorizado en Klinicos — sin bono.
              {resultado?.autorizacionDetalle ? ` ${resultado.autorizacionDetalle}` : ""}
            </span>
          </div>
        ) : (
          <>
            <div className="flex gap-2">
              <Input
                autoFocus
                placeholder="Token de autorización"
                value={token}
                onChange={(e) => { setToken(e.target.value); if (esPropio && !validando) cancelar(); }}
                onKeyDown={(e) => { if (e.key === "Enter" && !validando) validarAhora(); }}
                disabled={validando}
                data-testid="dialog-token-input"
              />
              <Button
                disabled={!token.trim() || validando}
                onClick={validarAhora}
                data-testid="dialog-token-validar"
              >
                {validando
                  ? <Loader2 className="w-4 h-4 mr-1 animate-spin" />
                  : <ShieldCheck className="w-4 h-4 mr-1" />}
                {validando ? "Validando…" : "Validar"}
              </Button>
            </div>

            {validando && esperandoReintento && (
              <p className="text-xs text-muted-foreground flex items-center gap-1.5" data-testid="dialog-token-validando">
                <Clock className="w-3.5 h-3.5 shrink-0" />
                La validación está en curso en IOMA (puede tardar hasta un minuto)…
              </p>
            )}

            {!validando && resultado && (
              <div
                className={`text-xs rounded-md p-2.5 space-y-1.5 border ${
                  agotado || resultado.reintentable || resultado.estado === "MANUAL_PRESTATION_REQUIRED"
                    ? "bg-amber-50 text-amber-900 border-amber-200"
                    : "bg-red-50 text-red-800 border-red-200"
                }`}
                data-testid="dialog-token-resultado"
              >
                <p className="flex items-start gap-1.5">
                  <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                  <span>
                    {agotado
                      ? "La validación sigue en curso en IOMA y está demorando más de lo normal. NO es un rechazo: quedó pendiente — reintentá en unos minutos desde acá o desde la ficha del paciente."
                      : resultado.estado === "MANUAL_PRESTATION_REQUIRED"
                        ? "La prestación no está disponible en KLINICOS. Podés resolverlo desde la ficha del paciente (Recepción) o reintentar."
                        : resultado.reintentable
                          ? "No fue posible validar el token. Podés reintentar o cargarlo después desde la ficha."
                          : `Token no aceptado: ${resultado.mensaje}.`}
                  </span>
                </p>
              </div>
            )}
          </>
        )}

        <div className="flex justify-end gap-2 pt-1">
          {aceptado ? (
            <Button onClick={cerrar} data-testid="dialog-token-cerrar">Listo</Button>
          ) : (
            <Button variant="outline" onClick={cerrar} data-testid="dialog-token-despues">
              Cargar después
            </Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
