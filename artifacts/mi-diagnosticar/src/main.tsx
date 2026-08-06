import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";

// Si tras un deploy el navegador tiene cacheada una versión vieja y un chunk
// diferido ya no existe, recargamos una vez para traer el index.html nuevo en
// vez de dejar la pantalla en blanco.
window.addEventListener("vite:preloadError", (event) => {
  event.preventDefault();
  const KEY = "chunk_reload_at";
  const last = Number(sessionStorage.getItem(KEY) || 0);
  if (Date.now() - last > 30_000) {
    sessionStorage.setItem(KEY, String(Date.now()));
    window.location.reload();
  }
});

createRoot(document.getElementById("root")!).render(<App />);

// PWA: registra el service worker solo en producción (en dev molesta con caché)
if ("serviceWorker" in navigator && import.meta.env.PROD) {
  window.addEventListener("load", () => {
    navigator.serviceWorker
      .register(`${import.meta.env.BASE_URL}sw.js`, { scope: import.meta.env.BASE_URL })
      .catch(() => {
        // sin service worker la app sigue funcionando igual
      });
  });
}
