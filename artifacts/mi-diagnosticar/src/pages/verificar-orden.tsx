import { useEffect, useState } from "react";
import { useParams, useLocation } from "wouter";
import { XCircle, Ban, CheckCircle2, Search, Database, FileSearch, ShieldCheck, Check, Loader2 } from "lucide-react";

// Página PÚBLICA de verificación de órdenes de estudio: la abre cualquiera
// (laboratorio, centro de imágenes) escaneando el QR impreso en la orden,
// entrando al link o escribiendo el número (OE-AAAAMMDD-XXXXXXXX). Mobile-first.
type Resultado = {
  valido: boolean;
  estado?: "vigente" | "anulada" | "inexistente";
  numero?: string | null;
  fechaEmision?: string;
  estudio?: string | null;
  prioridad?: string | null;
  paciente?: string | null;
  dni?: string | null;
  profesional?: string | null;
  matricula?: string | null;
  especialidad?: string | null;
};

const PASOS_BUSQUEDA = [
  { icono: Database, texto: "Conectando con el registro electrónico…" },
  { icono: FileSearch, texto: "Buscando la orden médica…" },
  { icono: ShieldCheck, texto: "Comprobando autenticidad…" },
];

function BusquedaAnimada() {
  const [paso, setPaso] = useState(0);
  useEffect(() => {
    const timers = [setTimeout(() => setPaso(1), 800), setTimeout(() => setPaso(2), 1600)];
    return () => timers.forEach(clearTimeout);
  }, []);
  return (
    <div className="py-6 space-y-3" data-testid="verificacion-orden-buscando" role="status" aria-live="polite">
      {PASOS_BUSQUEDA.map(({ icono: Icono, texto }, i) => (
        <div
          key={texto}
          className={`flex items-center gap-3 text-sm transition-opacity duration-300 ${
            i < paso ? "text-slate-400" : i === paso ? "text-slate-700" : "text-slate-300 opacity-40"
          }`}
        >
          <span className="w-5 flex justify-center shrink-0">
            {i < paso ? (
              <Check className="w-4 h-4 text-slate-400" />
            ) : i === paso ? (
              <Loader2 className="w-4 h-4 animate-spin text-slate-500" />
            ) : (
              <Icono className="w-4 h-4" />
            )}
          </span>
          {texto}
        </div>
      ))}
      <div className="h-1 rounded-full bg-slate-100 overflow-hidden">
        <div
          className="h-full bg-slate-400 rounded-full transition-all duration-700 ease-out"
          style={{ width: `${((paso + 1) / (PASOS_BUSQUEDA.length + 1)) * 100}%` }}
        />
      </div>
    </div>
  );
}

function Dato({ etiqueta, valor }: { etiqueta: string; valor: string }) {
  return (
    <div className="flex justify-between gap-3 py-1.5 border-b border-slate-100 last:border-0">
      <span className="text-slate-500 shrink-0">{etiqueta}</span>
      <span className="font-medium text-slate-900 text-right">{valor}</span>
    </div>
  );
}

export default function VerificarOrden() {
  const { codigo } = useParams<{ codigo?: string }>();
  const [, navegar] = useLocation();
  const [estado, setEstado] = useState<"inicio" | "cargando" | "resuelto" | "error">(codigo ? "cargando" : "inicio");
  const [res, setRes] = useState<Resultado | null>(null);
  const [manual, setManual] = useState("");
  const [animacionLista, setAnimacionLista] = useState(!codigo);

  useEffect(() => {
    if (!codigo) { setEstado("inicio"); setRes(null); setAnimacionLista(true); return; }
    setEstado("cargando");
    setAnimacionLista(false);
    const timer = setTimeout(() => setAnimacionLista(true), 2400);
    const controlador = new AbortController();
    const timerAbort = setTimeout(() => controlador.abort(), 15000);
    fetch(`${import.meta.env.BASE_URL}api/consultorio/ordenes/verificar/${encodeURIComponent(codigo)}`, { signal: controlador.signal })
      .then(async (r) => {
        if (r.status === 404) { setRes({ valido: false, estado: "inexistente" }); setEstado("resuelto"); return; }
        if (!r.ok) { setEstado("error"); return; }
        setRes((await r.json()) as Resultado);
        setEstado("resuelto");
      })
      .catch(() => setEstado("error"))
      .finally(() => clearTimeout(timerAbort));
    return () => { clearTimeout(timer); clearTimeout(timerAbort); controlador.abort(); };
  }, [codigo]);

  const mostrandoBusqueda = !!codigo && (estado === "cargando" || (estado === "resuelto" && !animacionLista));

  const buscarManual = (e: React.FormEvent) => {
    e.preventDefault();
    const c = manual.trim();
    if (c) navegar(`/verificar-orden/${encodeURIComponent(c)}`);
  };

  const fecha = res?.fechaEmision
    ? new Date(res.fechaEmision).toLocaleDateString("es-AR", { timeZone: "America/Argentina/Buenos_Aires", day: "2-digit", month: "2-digit", year: "numeric" })
    : null;

  return (
    <div className="min-h-screen bg-slate-50 flex items-start sm:items-center justify-center p-4 py-8">
      <div className="w-full max-w-md bg-white rounded-xl shadow-md border p-6 space-y-4">
        <img src={`${import.meta.env.BASE_URL}logo-diagnosticar.png`} alt="Diagnosticar Medical Center" className="mx-auto w-56 max-w-full" />
        <h1 className="text-lg font-semibold text-slate-900 text-center">Validación de veracidad — Orden médica</h1>
        <p className="text-xs text-slate-500 text-center">
          Esta página confirma si la orden fue emitida realmente por Diagnosticar Medical Center o si se trata de una copia editada o adulterada.
        </p>

        {mostrandoBusqueda && <BusquedaAnimada />}

        {!mostrandoBusqueda && estado === "error" && (
          <div className="rounded-lg bg-amber-50 border border-amber-200 p-3 text-sm text-amber-800 text-center" data-testid="verificacion-orden-error">
            No se pudo consultar el registro. Revisá tu conexión e intentá de nuevo.
          </div>
        )}

        {!mostrandoBusqueda && estado === "resuelto" && res && res.estado === "vigente" && (
          <div className="space-y-3" data-testid="verificacion-orden-valida">
            <div className="rounded-lg bg-emerald-50 border border-emerald-200 p-3 flex items-center justify-center gap-2 text-emerald-700 font-semibold">
              <CheckCircle2 className="w-6 h-6" /> Orden médica AUTÉNTICA
            </div>
            <div className="text-sm rounded-lg border bg-slate-50 p-4">
              {res.numero && <Dato etiqueta="Número" valor={res.numero} />}
              {fecha && <Dato etiqueta="Fecha de emisión" valor={fecha} />}
              {res.estudio && <Dato etiqueta="Estudio" valor={res.estudio} />}
              {res.prioridad && res.prioridad !== "Normal" && <Dato etiqueta="Prioridad" valor={res.prioridad} />}
              {res.paciente && <Dato etiqueta="Paciente" valor={res.paciente} />}
              {res.dni && <Dato etiqueta="DNI" valor={res.dni} />}
              {res.profesional && <Dato etiqueta="Médico" valor={res.profesional} />}
              {res.matricula && <Dato etiqueta="Matrícula" valor={`M.P. ${res.matricula.replace(/^\s*M\.?\s*P\.?\s*/i, "")}`} />}
              {res.especialidad && <Dato etiqueta="Especialidad" valor={res.especialidad} />}
            </div>
            <p className="text-xs text-slate-500 text-center">
              Esta orden fue emitida electrónicamente en la plataforma Conectar de Diagnosticar Medical Center.
            </p>
          </div>
        )}

        {!mostrandoBusqueda && estado === "resuelto" && res && res.estado === "anulada" && (
          <div className="space-y-3" data-testid="verificacion-orden-anulada">
            <div className="rounded-lg bg-red-50 border border-red-200 p-3 flex items-center justify-center gap-2 text-red-700 font-semibold">
              <Ban className="w-6 h-6" /> Orden ANULADA
            </div>
            <p className="text-sm text-slate-600 text-center">
              Esta orden existió pero fue anulada{res.numero ? ` (${res.numero})` : ""}. No debe ser aceptada.
            </p>
          </div>
        )}

        {!mostrandoBusqueda && ((estado === "resuelto" && res && res.estado === "inexistente") || estado === "inicio") && (
          <div className="space-y-3">
            {estado === "resuelto" && (
              <div className="rounded-lg bg-red-50 border border-red-200 p-3 flex items-center justify-center gap-2 text-red-700 font-semibold" data-testid="verificacion-orden-inexistente">
                <XCircle className="w-6 h-6" /> Orden NO encontrada
              </div>
            )}
            {estado === "resuelto" && (
              <p className="text-sm text-slate-600 text-center">
                El código no corresponde a ninguna orden emitida por Diagnosticar. Verificá que esté bien escrito.
              </p>
            )}
          </div>
        )}

        {!mostrandoBusqueda && (
          <form onSubmit={buscarManual} className="space-y-2">
            <label className="text-sm text-slate-600" htmlFor="codigo-orden">
              Ingresá el código de verificación impreso en la orden (OE-…)
            </label>
            <div className="flex gap-2">
              <input
                id="codigo-orden"
                value={manual}
                onChange={(e) => setManual(e.target.value)}
                placeholder="OE-20260803-00001234"
                className="flex-1 rounded-lg border px-3 py-2 text-sm"
                data-testid="input-codigo-orden"
              />
              <button type="submit" className="rounded-lg bg-slate-800 hover:bg-slate-700 text-white px-4 py-2" data-testid="boton-verificar-orden">
                <Search className="w-4 h-4" />
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
