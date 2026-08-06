// Favicon dinámico según el tipo de usuario logueado.
// Toma el ícono original y lo pinta del color del perfil:
//   médico → blanco, recepcionista → verde, desarrollador → rojo.
// Sin usuario (o cualquier otro perfil) se mantiene el favicon original.

const FAVICON_ORIGINAL = `${import.meta.env.BASE_URL}favicon.png`;

function colorSegunUsuario(rol?: string | null, perfil?: string | null): string | null {
  if (perfil === "desarrollador") return "#dc2626"; // rojo
  if (perfil === "tecnico") return "#2563eb"; // azul
  if (rol === "medico" || perfil?.startsWith("medico")) return "#ffffff"; // blanco
  if (rol === "recepcionista") return "#16a34a"; // verde
  return null;
}

function setFaviconHref(href: string) {
  let link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
  if (!link) {
    link = document.createElement("link");
    link.rel = "icon";
    document.head.appendChild(link);
  }
  link.type = "image/png";
  link.href = href;
}

let ultimoColor: string | null | undefined;

export function actualizarFavicon(rol?: string | null, perfil?: string | null) {
  const color = colorSegunUsuario(rol, perfil);
  if (color === ultimoColor) return;
  ultimoColor = color;

  if (!color) {
    setFaviconHref(FAVICON_ORIGINAL);
    return;
  }

  const img = new Image();
  img.onload = () => {
    const canvas = document.createElement("canvas");
    canvas.width = img.naturalWidth || 64;
    canvas.height = img.naturalHeight || 64;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    // Pinta la silueta del ícono con el color del perfil.
    ctx.globalCompositeOperation = "source-in";
    ctx.fillStyle = color;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    // Un borde sutil para que el blanco no desaparezca en pestañas claras.
    if (color.toLowerCase() === "#ffffff") {
      ctx.globalCompositeOperation = "destination-over";
      ctx.fillStyle = "rgba(0,0,0,0.35)";
      const r = Math.min(canvas.width, canvas.height) / 2;
      ctx.beginPath();
      ctx.arc(canvas.width / 2, canvas.height / 2, r, 0, Math.PI * 2);
      ctx.fill();
    }
    setFaviconHref(canvas.toDataURL("image/png"));
  };
  img.src = FAVICON_ORIGINAL;
}
