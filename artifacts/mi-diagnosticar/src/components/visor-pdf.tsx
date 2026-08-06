import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, Minus, Plus, X, Maximize2, Download } from "lucide-react";
import * as pdfjs from "pdfjs-dist";
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";

pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

// Visor de PDF propio (mobile-first): el visor nativo del navegador en el
// celular muchas veces no permite zoom ni volver atrás. Este renderiza las
// páginas con pdfjs, tiene botones de zoom (además del zoom de pantalla por
// pellizco, ya habilitado a nivel página) y un modo pantalla completa con X.

const ZOOM_MIN = 0.6;
const ZOOM_MAX = 4;

function PaginasPdf({ pdf, zoom }: { pdf: pdfjs.PDFDocumentProxy; zoom: number }) {
  const contRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelado = false;
    const cont = contRef.current;
    if (!cont) return;
    (async () => {
      const anchoBase = Math.max(cont.clientWidth - 8, 200);
      const nuevos: HTMLCanvasElement[] = [];
      for (let n = 1; n <= pdf.numPages; n++) {
        const pagina = await pdf.getPage(n);
        if (cancelado) return;
        const vp1 = pagina.getViewport({ scale: 1 });
        const escala = (anchoBase / vp1.width) * zoom;
        const vp = pagina.getViewport({ scale: escala });
        const dpr = Math.min(window.devicePixelRatio || 1, 3);
        const canvas = document.createElement("canvas");
        canvas.width = Math.floor(vp.width * dpr);
        canvas.height = Math.floor(vp.height * dpr);
        canvas.style.width = `${Math.floor(vp.width)}px`;
        canvas.style.height = `${Math.floor(vp.height)}px`;
        canvas.className = "bg-white shadow-md mx-auto block mb-3";
        const ctx = canvas.getContext("2d");
        if (!ctx) continue;
        await pagina.render({ canvasContext: ctx, viewport: vp, transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined }).promise;
        if (cancelado) return;
        nuevos.push(canvas);
      }
      if (cancelado) return;
      cont.replaceChildren(...nuevos);
    })();
    return () => { cancelado = true; };
  }, [pdf, zoom]);

  return <div ref={contRef} className="w-full min-h-[120px]" />;
}

export default function VisorPdf({ url, nombreArchivo }: { url: string; nombreArchivo: string }) {
  const [pdf, setPdf] = useState<pdfjs.PDFDocumentProxy | null>(null);
  const [error, setError] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [completa, setCompleta] = useState(false);

  useEffect(() => {
    let cancelado = false;
    setPdf(null); setError(false);
    const tarea = pdfjs.getDocument({ url });
    tarea.promise
      .then((doc) => { if (!cancelado) setPdf(doc); })
      .catch(() => { if (!cancelado) setError(true); });
    return () => { cancelado = true; void tarea.destroy(); };
  }, [url]);

  // En pantalla completa bloqueamos el scroll del fondo y cerramos con Escape.
  useEffect(() => {
    if (!completa) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setCompleta(false); };
    window.addEventListener("keydown", onKey);
    return () => { document.body.style.overflow = prev; window.removeEventListener("keydown", onKey); };
  }, [completa]);

  const menos = useCallback(() => setZoom((z) => Math.max(ZOOM_MIN, Math.round((z - 0.25) * 100) / 100)), []);
  const mas = useCallback(() => setZoom((z) => Math.min(ZOOM_MAX, Math.round((z + 0.25) * 100) / 100)), []);

  if (error) {
    return (
      <a href={url} target="_blank" rel="noreferrer" className="flex items-center justify-center gap-2 w-full rounded-lg bg-blue-600 hover:bg-blue-500 text-white font-medium py-2.5">
        <Download className="w-4 h-4" /> Ver el certificado original (PDF)
      </a>
    );
  }

  const controles = (enOverlay: boolean) => (
    <div className={`flex items-center gap-1.5 ${enOverlay ? "" : "justify-between"}`}>
      <div className="flex items-center gap-1.5">
        <button type="button" onClick={menos} aria-label="Alejar" data-testid="pdf-zoom-menos"
          className="rounded-md border border-slate-300 bg-white p-2 text-slate-700 hover:bg-slate-100 disabled:opacity-40" disabled={zoom <= ZOOM_MIN}>
          <Minus className="w-4 h-4" />
        </button>
        <span className="text-xs text-slate-600 w-11 text-center tabular-nums">{Math.round(zoom * 100)}%</span>
        <button type="button" onClick={mas} aria-label="Acercar" data-testid="pdf-zoom-mas"
          className="rounded-md border border-slate-300 bg-white p-2 text-slate-700 hover:bg-slate-100 disabled:opacity-40" disabled={zoom >= ZOOM_MAX}>
          <Plus className="w-4 h-4" />
        </button>
      </div>
      <div className="flex items-center gap-1.5 ml-auto">
        <a href={url} download={nombreArchivo} target="_blank" rel="noreferrer" aria-label="Descargar PDF" data-testid="pdf-descargar"
          className="rounded-md border border-slate-300 bg-white p-2 text-slate-700 hover:bg-slate-100">
          <Download className="w-4 h-4" />
        </a>
        {!enOverlay && (
          <button type="button" onClick={() => setCompleta(true)} aria-label="Pantalla completa" data-testid="pdf-pantalla-completa"
            className="rounded-md border border-slate-300 bg-white p-2 text-slate-700 hover:bg-slate-100">
            <Maximize2 className="w-4 h-4" />
          </button>
        )}
      </div>
    </div>
  );

  return (
    <div className="space-y-2" data-testid="visor-pdf">
      {controles(false)}
      <div className="rounded-lg border bg-slate-100 overflow-auto max-h-[70vh] p-2" style={{ touchAction: "pan-x pan-y pinch-zoom" }}>
        {pdf ? <PaginasPdf pdf={pdf} zoom={zoom} /> : (
          <div className="flex items-center justify-center gap-2 text-slate-500 py-10">
            <Loader2 className="w-5 h-5 animate-spin" /> Cargando el documento…
          </div>
        )}
      </div>

      {completa && (
        <div className="fixed inset-0 z-50 bg-slate-900 flex flex-col" data-testid="pdf-overlay">
          <div className="flex items-center gap-2 p-2 bg-slate-800/95 shrink-0">
            <div className="flex-1 min-w-0">{controles(true)}</div>
            <button type="button" onClick={() => setCompleta(false)} aria-label="Cerrar pantalla completa" data-testid="pdf-cerrar"
              className="rounded-md bg-white/10 hover:bg-white/20 text-white p-2.5">
              <X className="w-5 h-5" />
            </button>
          </div>
          <div className="flex-1 overflow-auto p-3" style={{ touchAction: "pan-x pan-y pinch-zoom" }}>
            {pdf ? <PaginasPdf pdf={pdf} zoom={zoom} /> : (
              <div className="flex items-center justify-center gap-2 text-slate-300 py-10">
                <Loader2 className="w-5 h-5 animate-spin" /> Cargando el documento…
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
