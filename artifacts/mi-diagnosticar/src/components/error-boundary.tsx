import { Component, type ErrorInfo, type ReactNode } from "react";

// Red de contención global: si cualquier página crashea al renderizar,
// mostramos un cartel amigable con botón de recarga en vez de pantalla
// en blanco (incidente del 1/8/2026). Además reporta el error al backend
// de forma best-effort para diagnóstico.

function reportarError(error: Error, info?: ErrorInfo) {
  try {
    const base = import.meta.env.BASE_URL as string; // termina en "/"
    fetch(`${base}api/errores-frontend`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        mensaje: String(error?.message ?? error),
        stack: String(error?.stack ?? "").slice(0, 4000),
        componentStack: String(info?.componentStack ?? "").slice(0, 4000),
        url: window.location.href,
        userAgent: navigator.userAgent,
      }),
    }).catch(() => {
      // el reporte es best-effort: nunca debe romper el cartel
    });
  } catch {
    // idem
  }
}

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false };

  static getDerivedStateFromError(): State {
    return { hasError: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Error de render capturado por ErrorBoundary:", error, info);
    reportarError(error, info);
  }

  handleReload = () => {
    window.location.reload();
  };

  render() {
    if (!this.state.hasError) return this.props.children;

    return (
      <div
        className="flex min-h-[60vh] w-full flex-col items-center justify-center gap-4 p-6 text-center"
        data-testid="error-boundary"
      >
        <div className="flex h-14 w-14 items-center justify-center rounded-full bg-red-100 dark:bg-red-900/40">
          <svg
            className="h-7 w-7 text-red-600 dark:text-red-300"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={2}
            aria-hidden="true"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M12 9v4m0 4h.01M10.29 3.86l-8.02 13.9A2 2 0 004 21h16a2 2 0 001.73-3.24l-8.02-13.9a2 2 0 00-3.42 0z"
            />
          </svg>
        </div>
        <div className="space-y-1">
          <h1 className="text-lg font-semibold text-foreground">
            Ocurrió un error
          </h1>
          <p className="max-w-sm text-sm text-muted-foreground">
            Algo salió mal al mostrar esta pantalla. Tocá el botón para
            recargar y seguir trabajando.
          </p>
        </div>
        <button
          type="button"
          onClick={this.handleReload}
          className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground shadow hover:opacity-90"
          data-testid="button-recargar"
        >
          Recargar la página
        </button>
      </div>
    );
  }
}

export default ErrorBoundary;
