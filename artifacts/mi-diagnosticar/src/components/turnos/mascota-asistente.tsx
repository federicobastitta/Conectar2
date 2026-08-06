// Muñeco propio del asistente de turnos, dibujado en SVG y animado por CSS.
// En reposo saluda con el brazo; cuando está buscando, pone la mano como
// visera sobre los ojos y "escanea" moviendo las pupilas de lado a lado.
export function MascotaAsistente({ buscando }: { buscando: boolean }) {
  return (
    <svg
      viewBox="0 0 100 100"
      className={`w-full h-full ${buscando ? "mascota-buscando" : "mascota-reposo"}`}
      role="img"
      aria-label="Mascota del asistente"
      data-testid="img-mascota-asistente"
    >
      <g className="mascota-cuerpo">
        {/* Pelos despeinados */}
        <path
          d="M28 30 L24 14 L34 24 L38 8 L45 22 L52 6 L58 22 L66 10 L68 25 L78 16 L73 32 Z"
          fill="#f97316"
        />
        {/* Cabeza peluda */}
        <circle cx="50" cy="52" r="31" fill="#fb923c" />
        <circle cx="50" cy="52" r="31" fill="none" stroke="#f97316" strokeWidth="3" strokeDasharray="2 3" />
        {/* Ojos */}
        <ellipse cx="39" cy="42" rx="9" ry="10" fill="white" />
        <ellipse cx="61" cy="42" rx="9" ry="10" fill="white" />
        <path d="M30 36 Q39 28 48 36" fill="none" stroke="#16a34a" strokeWidth="3.5" strokeLinecap="round" />
        <path d="M52 36 Q61 28 70 36" fill="none" stroke="#16a34a" strokeWidth="3.5" strokeLinecap="round" />
        <g className="mascota-pupilas">
          <circle cx="40" cy="44" r="3.4" fill="#1c1917" />
          <circle cx="62" cy="44" r="3.4" fill="#1c1917" />
        </g>
        {/* Nariz */}
        <circle cx="50" cy="53" r="6" fill="#f472b6" />
        {/* Boca grande abierta */}
        <path d="M32 63 Q50 84 68 63 Q50 72 32 63 Z" fill="#1c1917" />
        <ellipse cx="50" cy="69" rx="8" ry="4" fill="#ec4899" />
      </g>
      {/* Brazo articulado: saluda en reposo, hace visera cuando busca */}
      <g className="mascota-brazo">
        <path
          d="M84 78 Q88 55 70 34"
          fill="none"
          stroke="#fb923c"
          strokeWidth="9"
          strokeLinecap="round"
        />
        <ellipse cx="68" cy="32" rx="9" ry="7" fill="#f97316" transform="rotate(-30 68 32)" />
      </g>
    </svg>
  );
}
