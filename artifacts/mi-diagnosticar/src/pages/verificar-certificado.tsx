import { useEffect, useState } from "react";
import { useParams, useLocation } from "wouter";
import { XCircle, Ban, RefreshCcw, Search, Share2, Download, Database, FileSearch, ShieldCheck, Check, Loader2 } from "lucide-react";
import VisorPdf from "@/components/visor-pdf";

// Página PÚBLICA de verificación de certificados: la abre cualquiera
// (empleador, escuela) escaneando el QR, entrando al link o escribiendo el
// número del certificado (CT-AAAAMMDD-XXXXXXXX). Mobile-first.
type Resultado = {
  valido: boolean;
  estado?: "valido" | "revocado" | "reemplazado" | "inexistente";
  numero?: string | null;
  tipo?: string;
  fechaEmision?: string;
  diagnostico?: string | null;
  diasReposo?: number | null;
  reposo?: { dias: number; desde: string; hasta: string } | null;
  paciente?: string | null;
  dni?: string | null;
  profesional?: string | null;
  matricula?: string | null;
  atencion?: { fecha: string; hora?: string | null; sede?: string | null } | null;
  horaEmision?: string | null;
  especialidad?: string | null;
  motivoRevocacion?: string | null;
  revocadoEn?: string | null;
  reemplazadoPor?: string | null;
  reemplazadoPorNumero?: string | null;
  pdfDisponible?: boolean;
};

const TIPOS: Record<string, string> = {
  reposo: "Certificado de reposo",
  asistencia: "Certificado de asistencia",
  aptitud: "Certificado de aptitud",
  otro: "Certificado médico",
};

// Pasos de la animación de búsqueda: simulan la consulta al registro para
// que la verificación se sienta real (pedido ago 2026). Duración total ~2.4 s.
const PASOS_BUSQUEDA = [
  { icono: Database, texto: "Conectando con el registro electrónico…" },
  { icono: FileSearch, texto: "Buscando el certificado…" },
  { icono: ShieldCheck, texto: "Comprobando autenticidad y vigencia…" },
];

function BusquedaAnimada() {
  const [paso, setPaso] = useState(0);
  useEffect(() => {
    const timers = [
      setTimeout(() => setPaso(1), 800),
      setTimeout(() => setPaso(2), 1600),
    ];
    return () => timers.forEach(clearTimeout);
  }, []);
  return (
    <div className="py-6 space-y-3" data-testid="verificacion-buscando" role="status" aria-live="polite">
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

export default function VerificarCertificado() {
  const { codigo } = useParams<{ codigo?: string }>();
  const [, navegar] = useLocation();
  const [estado, setEstado] = useState<"inicio" | "cargando" | "resuelto" | "error">(codigo ? "cargando" : "inicio");
  const [res, setRes] = useState<Resultado | null>(null);
  const [manual, setManual] = useState("");
  const [fechaConsulta] = useState(() => new Date());
  // La animación de búsqueda dura al menos ~2.4 s aunque la API responda antes,
  // para que se vea que "se consultó el registro" antes de mostrar el veredicto.
  const [animacionLista, setAnimacionLista] = useState(!codigo);

  useEffect(() => {
    if (!codigo) { setEstado("inicio"); setRes(null); setAnimacionLista(true); return; }
    setEstado("cargando");
    setAnimacionLista(false);
    const timer = setTimeout(() => setAnimacionLista(true), 2400);
    // Si la red falla en silencio, abortamos a los 15 s para no dejar la búsqueda infinita.
    const controlador = new AbortController();
    const timerAbort = setTimeout(() => controlador.abort(), 15000);
    fetch(`${import.meta.env.BASE_URL}api/consultorio/certificados/verificar/${encodeURIComponent(codigo)}`, { signal: controlador.signal })
      .then(async (r) => {
        if (r.status === 404) { setRes({ valido: false, estado: "inexistente" }); setEstado("resuelto"); return; }
        if (!r.ok) { setEstado("error"); return; }
        const data = (await r.json()) as Resultado;
        setRes(data);
        setEstado("resuelto");
      })
      .catch(() => setEstado("error"))
      .finally(() => clearTimeout(timerAbort));
    return () => {
      clearTimeout(timer);
      clearTimeout(timerAbort);
      controlador.abort();
    };
  }, [codigo]);

  // Mientras corre la animación de búsqueda, el veredicto queda en espera.
  const mostrandoBusqueda = !!codigo && (estado === "cargando" || (estado === "resuelto" && !animacionLista));

  const buscarManual = (e: React.FormEvent) => {
    e.preventDefault();
    const c = manual.trim();
    if (c) navegar(`/verificar/${encodeURIComponent(c)}`);
  };

  const est = res?.estado ?? (res?.valido ? "valido" : "inexistente");
  const urlPdf = codigo ? `${import.meta.env.BASE_URL}api/consultorio/certificados/verificar/${encodeURIComponent(codigo)}/pdf` : null;

  return (
    <div className="min-h-screen bg-slate-50 flex items-start sm:items-center justify-center p-4 py-8">
      <div className="w-full max-w-md bg-white rounded-xl shadow-md border p-6 space-y-4">
        <img src={`${import.meta.env.BASE_URL}logo-diagnosticar.png`} alt="Diagnosticar Medical Center" className="mx-auto w-56 max-w-full" />
        <h1 className="text-lg font-semibold text-slate-900 text-center">Validación de veracidad — Certificado médico</h1>
        <p className="text-xs text-slate-500 text-center">
          Esta página confirma si el certificado fue emitido realmente por Diagnosticar Medical Center o si se trata de una copia editada o adulterada.
        </p>

        {mostrandoBusqueda && <BusquedaAnimada />}

        {!mostrandoBusqueda && estado === "resuelto" && res && est === "valido" && (
          <div className="space-y-3" data-testid="verificacion-ok">
            <div className="rounded-lg border border-slate-300 bg-white overflow-hidden">
              <div className="h-1 bg-emerald-700" />
              <div className="px-4 py-3 flex items-center gap-3">
                <span className="w-9 h-9 rounded-full border border-emerald-700/30 bg-emerald-50 flex items-center justify-center shrink-0">
                  <ShieldCheck className="w-5 h-5 text-emerald-800" />
                </span>
                <div className="text-left">
                  <p className="text-sm font-semibold tracking-wide text-slate-900 uppercase">Documento válido</p>
                  <p className="text-xs text-slate-500">
                    Verificado en el registro oficial · {fechaConsulta.toLocaleDateString("es-AR")}, {fechaConsulta.toLocaleTimeString("es-AR", { hour: "2-digit", minute: "2-digit" })} hs
                  </p>
                </div>
              </div>
            </div>
            <div className="text-sm rounded-lg border bg-slate-50 p-4">
              {res.numero && <Dato etiqueta="N° de certificado" valor={res.numero} />}
              <Dato etiqueta="Documento" valor={TIPOS[res.tipo ?? ""] ?? "Certificado médico"} />
              {res.paciente && <Dato etiqueta="Paciente" valor={res.paciente} />}
              {res.dni && <Dato etiqueta="DNI" valor={res.dni} />}
              {res.atencion && (
                <Dato etiqueta="Atendido" valor={`${res.atencion.fecha}${res.atencion.hora ? ` · ${res.atencion.hora} hs` : ""}`} />
              )}
              {res.atencion?.sede && <Dato etiqueta="Sede" valor={res.atencion.sede} />}
              {res.fechaEmision && (
                <Dato
                  etiqueta="Emitido"
                  valor={`${new Date(res.fechaEmision).toLocaleDateString("es-AR", { day: "2-digit", month: "2-digit", year: "numeric" })}${res.horaEmision ? ` · ${res.horaEmision} hs` : ""}`}
                />
              )}
              {res.diagnostico && <Dato etiqueta="Diagnóstico" valor={res.diagnostico} />}
              {res.reposo && (
                <Dato
                  etiqueta="Reposo indicado"
                  valor={`${res.reposo.dias} ${res.reposo.dias === 1 ? "día" : "días"} (${res.reposo.desde} al ${res.reposo.hasta})`}
                />
              )}
              {res.profesional && (
                <Dato etiqueta="Profesional" valor={`${res.profesional}${res.matricula ? ` · M.P. ${res.matricula}` : ""}`} />
              )}
              {res.especialidad && <Dato etiqueta="Especialidad" valor={res.especialidad} />}
            </div>
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => {
                  const texto =
                    `Certificado médico ${res.numero ?? ""} emitido por Diagnosticar Medical Center.\n` +
                    `Podés verificar su autenticidad y vigencia en este enlace oficial:\n${window.location.href}`;
                  window.open(`https://wa.me/?text=${encodeURIComponent(texto)}`, "_blank", "noopener");
                }}
                className="flex items-center justify-center gap-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white font-medium py-2.5"
                data-testid="boton-compartir-whatsapp"
              >
                <Share2 className="w-4 h-4" /> Compartir
              </button>
              {res.pdfDisponible && urlPdf ? (
                <a
                  href={urlPdf}
                  download={`certificado-${res.numero ?? codigo}.pdf`}
                  target="_blank"
                  rel="noreferrer"
                  className="flex items-center justify-center gap-2 rounded-lg bg-blue-600 hover:bg-blue-500 text-white font-medium py-2.5"
                  data-testid="boton-descargar"
                >
                  <Download className="w-4 h-4" /> Descargar
                </a>
              ) : <span />}
            </div>
            <p className="text-xs text-slate-500 text-center">
              "Compartir" envía por WhatsApp el enlace de esta página de verificación —igual a la que se abre
              escaneando el QR—, ideal para presentar ante un empleador sin mandar el archivo del certificado.
            </p>
            {res.pdfDisponible && urlPdf && (
              <div data-testid="boton-descargar-pdf">
                <p className="text-sm font-medium text-slate-700 mb-1.5">Certificado original</p>
                <VisorPdf url={urlPdf} nombreArchivo={`certificado-${res.numero ?? codigo}.pdf`} />
              </div>
            )}
          </div>
        )}

        {!mostrandoBusqueda && estado === "resuelto" && res && est === "revocado" && (
          <div className="space-y-3" data-testid="verificacion-revocado">
            <div className="rounded-lg bg-red-50 border border-red-200 p-3 flex items-center justify-center gap-2 text-red-700 font-semibold">
              <Ban className="w-6 h-6" /> Documento REVOCADO
            </div>
            <div className="text-sm rounded-lg border bg-slate-50 p-4">
              {res.numero && <Dato etiqueta="N° de certificado" valor={res.numero} />}
              {res.revocadoEn && (
                <Dato etiqueta="Revocado el" valor={new Date(res.revocadoEn).toLocaleDateString("es-AR")} />
              )}
            </div>
            <p className="text-sm text-slate-600">
              Este certificado existió pero fue anulado por la institución y ya no tiene validez.
            </p>
          </div>
        )}

        {!mostrandoBusqueda && estado === "resuelto" && res && est === "reemplazado" && (
          <div className="space-y-3" data-testid="verificacion-reemplazado">
            <div className="rounded-lg bg-amber-50 border border-amber-200 p-3 flex items-center justify-center gap-2 text-amber-700 font-semibold">
              <RefreshCcw className="w-6 h-6" /> Documento REEMPLAZADO
            </div>
            <div className="text-sm rounded-lg border bg-slate-50 p-4">
              {res.numero && <Dato etiqueta="N° de certificado" valor={res.numero} />}
              {res.reemplazadoPorNumero && <Dato etiqueta="Reemplazado por" valor={res.reemplazadoPorNumero} />}
            </div>
            <p className="text-sm text-slate-600">
              Este certificado fue corregido y reemplazado por una versión nueva. La versión vigente es la que vale.
            </p>
            {res.reemplazadoPor && (
              <button
                onClick={() => navegar(`/verificar/${encodeURIComponent(res.reemplazadoPor!)}`)}
                className="w-full rounded-lg bg-blue-600 hover:bg-blue-500 text-white font-medium py-2.5"
                data-testid="boton-ver-vigente"
              >
                Ver el certificado vigente
              </button>
            )}
          </div>
        )}

        {!mostrandoBusqueda && estado === "resuelto" && (!res || est === "inexistente") && (
          <div className="space-y-2" data-testid="verificacion-invalida">
            <div className="rounded-lg bg-red-50 border border-red-200 p-3 flex items-center justify-center gap-2 text-red-700 font-semibold">
              <XCircle className="w-6 h-6" /> Documento INEXISTENTE
            </div>
            <p className="text-sm text-slate-600">
              No encontramos ningún certificado con este código. El documento podría no ser auténtico o el código estar mal escrito.
            </p>
          </div>
        )}

        {estado === "error" && (
          <p className="text-sm text-slate-600 text-center">No pudimos verificar en este momento. Probá de nuevo en unos minutos.</p>
        )}

        {/* Verificación manual por número de certificado */}
        <form onSubmit={buscarManual} className="space-y-2 pt-2 border-t">
          <label className="text-sm font-medium text-slate-700 block">
            {estado === "inicio" ? "Ingresá el código del certificado" : "Verificar otro certificado"}
          </label>
          <div className="flex gap-2">
            <input
              value={manual}
              onChange={(e) => setManual(e.target.value)}
              placeholder="Ej: CT-20260801-00015487"
              className="flex-1 rounded-lg border border-slate-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              data-testid="input-codigo-manual"
            />
            <button
              type="submit"
              className="rounded-lg bg-slate-800 hover:bg-slate-700 text-white px-4 py-2 flex items-center gap-1.5 text-sm font-medium"
              data-testid="boton-verificar-manual"
            >
              <Search className="w-4 h-4" /> Verificar
            </button>
          </div>
        </form>

        <div className="text-[11px] leading-relaxed text-slate-500 border-t pt-3 space-y-1.5">
          <p>
            Documento emitido por Diagnosticar Medical Center y registrado electrónicamente en la plataforma Conectar.
            Esta página confirma su autenticidad, vigencia e integridad al momento de la consulta.
          </p>
          <p>
            Cuando el certificado se utilice para justificar una inasistencia laboral, queda sujeto al artículo 210 de la
            Ley de Contrato de Trabajo N.º 20.744, conforme sus modificaciones y reglamentación vigente.
          </p>
          <p>
            Consulta realizada el {fechaConsulta.toLocaleDateString("es-AR")} a las {fechaConsulta.toLocaleTimeString("es-AR", { hour: "2-digit", minute: "2-digit" })} hs.
          </p>
        </div>
      </div>
    </div>
  );
}
