import { useRef, useState } from "react";
import {
  useGuardarIngresoConsulta,
  useValidarTokenTurno,
  useUpsertDocumentacionRecepcion,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { CheckCircle2, KeyRound, Loader2, Upload, FileText, ClipboardList, Send } from "lucide-react";

type DocTipoRapido = "orden_medica" | "informe";

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

function TokenRapido({
  turnoId,
  token,
  tokenEstado,
  nroBono,
  validacionHabilitada,
  onAbrirFicha,
  onChanged,
}: {
  turnoId: number;
  token: string | null;
  tokenEstado: string | null;
  nroBono: string | null;
  validacionHabilitada: boolean;
  onAbrirFicha: () => void;
  onChanged: () => void;
}) {
  const { toast } = useToast();
  const [valor, setValor] = useState("");

  const guardar = useGuardarIngresoConsulta({
    mutation: {
      onSuccess: () => {
        toast({
          title: "Enviado a Klinicos",
          description: "El token quedó registrado y el Robot lo va a procesar con el ingreso.",
        });
        setValor("");
        onChanged();
      },
      onError: () =>
        toast({ title: "Error", description: "No se pudo guardar el token", variant: "destructive" }),
    },
  });

  const validar = useValidarTokenTurno({
    mutation: {
      onSuccess: (resultado) => {
        if (resultado.estado === "TOKEN_ACCEPTED") {
          if (resultado.nroBono) {
            toast({ title: "Autorizado en Klinicos", description: `N° de Bono ${resultado.nroBono}.` });
          } else {
            toast({
              title: "Token aceptado — SIN bono",
              description: resultado.autorizacionDetalle ?? "No quedó autorizado en Klinicos. Verificá a mano.",
              variant: "destructive",
            });
          }
          setValor("");
          onChanged();
        } else {
          toast({
            title: "Token no aceptado",
            description: `${resultado.mensaje ?? resultado.estado}. Abrí la ficha para el circuito de contingencia.`,
            variant: "destructive",
          });
          onAbrirFicha();
        }
      },
      onError: () => {
        toast({
          title: "Error de validación",
          description: "No fue posible contactar al servidor. Abrí la ficha para reintentar.",
          variant: "destructive",
        });
        onAbrirFicha();
      },
    },
  });

  if (token) {
    // Regla única de verdad (2-ago-2026): el verde SOLO con estado persistido
    // ACCEPTED + bono. Un token guardado sin bono no es una consulta habilitada.
    const aceptadoConBono = !validacionHabilitada || (tokenEstado === "ACCEPTED" && Boolean(nroBono));
    if (aceptadoConBono) {
      return (
        <span
          className="inline-flex items-center gap-1 text-xs text-emerald-700 dark:text-emerald-400 whitespace-nowrap"
          data-testid={`token-ok-${turnoId}`}
        >
          <CheckCircle2 className="w-3.5 h-3.5 shrink-0" /> Token {token}
          {nroBono ? ` · Bono ${nroBono}` : ""}
        </span>
      );
    }
    return (
      <span
        className={`inline-flex items-center gap-1 text-xs whitespace-nowrap ${
          tokenEstado === "DENIED"
            ? "text-red-700 dark:text-red-400"
            : "text-amber-700 dark:text-amber-400"
        }`}
        data-testid={`token-no-confirmado-${turnoId}`}
      >
        <KeyRound className="w-3.5 h-3.5 shrink-0" />{" "}
        {tokenEstado === "DENIED" ? "Token rechazado" : "Token sin confirmar"}
      </span>
    );
  }

  const pendiente = guardar.isPending || validar.isPending;
  const enviar = () => {
    const t = valor.trim();
    if (!t) return;
    if (validacionHabilitada) {
      validar.mutate({ id: turnoId, data: { token: t } });
    } else {
      guardar.mutate({ id: turnoId, data: { token: t } });
    }
  };

  return (
    <div className="flex items-center gap-1">
      <KeyRound className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
      <Input
        className="h-7 w-28 text-xs px-2"
        placeholder="Token"
        value={valor}
        onChange={(e) => setValor(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") enviar();
        }}
        disabled={pendiente}
        data-testid={`input-token-${turnoId}`}
      />
      <Button
        size="sm"
        variant="outline"
        className="h-7 px-2 text-xs gap-1 whitespace-nowrap"
        disabled={!valor.trim() || pendiente}
        onClick={enviar}
        title={
          validacionHabilitada
            ? `POST /api/turnos/${turnoId}/validar-token → Robot Klinicos (/api/v1/klinicos/token/validate)`
            : `POST /api/turnos/${turnoId}/ingreso-consulta (guarda el token; el Robot lo procesa con el ingreso)`
        }
        data-testid={`boton-token-${turnoId}`}
      >
        {pendiente ? <Loader2 className="w-3 h-3 animate-spin" /> : <Send className="w-3 h-3" />}
        Enviar a Klinicos
      </Button>
    </div>
  );
}

function DocRapido({
  turnoId,
  pacienteId,
  tipo,
  label,
  icono,
  cargado,
  onChanged,
}: {
  turnoId: number;
  pacienteId: number;
  tipo: DocTipoRapido;
  label: string;
  icono: React.ReactNode;
  cargado: boolean;
  onChanged: () => void;
}) {
  const { toast } = useToast();
  const inputRef = useRef<HTMLInputElement>(null);
  const upsert = useUpsertDocumentacionRecepcion({
    mutation: {
      onSuccess: () => {
        toast({ title: `${label} cargada` });
        onChanged();
      },
      onError: () =>
        toast({ title: "Error", description: `No se pudo subir ${label}`, variant: "destructive" }),
    },
  });

  const subir = async (file: File) => {
    if (file.size > 5 * 1024 * 1024) {
      toast({ title: "Archivo muy grande", description: "Máximo 5 MB", variant: "destructive" });
      return;
    }
    const data = await archivoABase64(file);
    upsert.mutate({
      id: pacienteId,
      tipo,
      data: {
        estado: "pendiente",
        turnoId,
        archivoNombre: file.name,
        archivoMime: file.type || "application/octet-stream",
        archivoData: data,
      },
    });
  };

  return (
    <>
      <input
        ref={inputRef}
        type="file"
        className="hidden"
        accept="image/*,.pdf"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void subir(f);
          e.target.value = "";
        }}
      />
      <Button
        size="sm"
        variant={cargado ? "ghost" : "outline"}
        className={`h-7 px-2 text-xs gap-1 ${cargado ? "text-emerald-700 dark:text-emerald-400" : ""}`}
        disabled={upsert.isPending}
        onClick={() => inputRef.current?.click()}
        title={cargado ? `${label} cargada — subir de nuevo` : `Cargar ${label.toLowerCase()}`}
        data-testid={`boton-${tipo}-${turnoId}`}
      >
        {upsert.isPending ? (
          <Loader2 className="w-3 h-3 animate-spin" />
        ) : cargado ? (
          <CheckCircle2 className="w-3.5 h-3.5" />
        ) : (
          icono
        )}
        {label}
        {!cargado && !upsert.isPending && <Upload className="w-3 h-3 opacity-60" />}
      </Button>
    </>
  );
}

export function CargaRapidaTurno({
  turnoId,
  pacienteId,
  esConsulta,
  token,
  tokenEstado = null,
  nroBono = null,
  ordenCargada,
  informeCargado,
  validacionHabilitada,
  onAbrirFicha,
  onChanged,
}: {
  turnoId: number;
  pacienteId: number;
  esConsulta: boolean;
  token: string | null;
  tokenEstado?: string | null;
  nroBono?: string | null;
  ordenCargada: boolean;
  informeCargado: boolean;
  validacionHabilitada: boolean;
  onAbrirFicha: () => void;
  onChanged: () => void;
}) {
  return (
    <div
      className="flex items-center gap-1.5 flex-wrap"
      onClick={(e) => e.stopPropagation()}
      data-testid={`carga-rapida-${turnoId}`}
    >
      <TokenRapido
        turnoId={turnoId}
        token={token}
        tokenEstado={tokenEstado}
        nroBono={nroBono}
        validacionHabilitada={validacionHabilitada}
        onAbrirFicha={onAbrirFicha}
        onChanged={onChanged}
      />
      {!esConsulta && (
        <>
          <DocRapido
            turnoId={turnoId}
            pacienteId={pacienteId}
            tipo="orden_medica"
            label="Orden"
            icono={<ClipboardList className="w-3.5 h-3.5" />}
            cargado={ordenCargada}
            onChanged={onChanged}
          />
          <DocRapido
            turnoId={turnoId}
            pacienteId={pacienteId}
            tipo="informe"
            label="Informe"
            icono={<FileText className="w-3.5 h-3.5" />}
            cargado={informeCargado}
            onChanged={onChanged}
          />
        </>
      )}
    </div>
  );
}
