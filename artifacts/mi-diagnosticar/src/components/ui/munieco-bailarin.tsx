// Versión mini del muñeco bailarín, para usar como ícono (ej. botón del buscador).
// Baila en el lugar con la misma animación del grande.
export function MuniecoBailarinMini({ size = 22 }: { size?: number }) {
  return (
    <span className="inline-flex items-center justify-center" aria-hidden="true">
      <style>{`
        @keyframes mbm-baile {
          0%, 100% { transform: rotate(-8deg) translateY(0); }
          25% { transform: rotate(6deg) translateY(-2px); }
          50% { transform: rotate(-6deg) translateY(0); }
          75% { transform: rotate(8deg) translateY(-2px); }
        }
        .mbm-cuerpo { animation: mbm-baile 1.2s ease-in-out infinite; transform-origin: 60px 70px; }
        @keyframes mbm-bi { 0%, 100% { transform: rotate(20deg); } 50% { transform: rotate(-60deg); } }
        @keyframes mbm-bd { 0%, 100% { transform: rotate(-60deg); } 50% { transform: rotate(20deg); } }
        .mbm-bi { animation: mbm-bi 0.8s ease-in-out infinite; transform-origin: 60px 52px; }
        .mbm-bd { animation: mbm-bd 0.8s ease-in-out infinite; transform-origin: 60px 52px; }
        @media (prefers-reduced-motion: reduce) {
          .mbm-cuerpo, .mbm-bi, .mbm-bd { animation: none; }
        }
      `}</style>
      <svg width={size} height={size} viewBox="8 10 104 112" fill="none" style={{ overflow: "visible" }}>
        <g className="mbm-cuerpo">
          <circle cx="60" cy="30" r="14" fill="#F9C6D8" />
          {/* sombrero de inspector */}
          <ellipse cx="60" cy="19" rx="19" ry="4.5" fill="#D46A9A" />
          <path d="M49 19 Q49 6 60 6 Q71 6 71 19 Z" fill="#E58BB0" />
          <rect x="49" y="15" width="22" height="4" rx="2" fill="#B75585" />
          <circle cx="55" cy="28" r="2.2" fill="#9D5C77" />
          <circle cx="65" cy="28" r="2.2" fill="#9D5C77" />
          <path d="M54 34 Q60 39 66 34" stroke="#9D5C77" strokeWidth="2.4" strokeLinecap="round" />
          <rect x="52" y="44" width="16" height="22" rx="8" fill="#F7B6CE" />
          <rect x="50" y="60" width="20" height="28" rx="9" fill="#F7B6CE" />
          <path d="M55 86 L48 116" stroke="#F7B6CE" strokeWidth="9" strokeLinecap="round" />
          <path d="M65 86 L72 116" stroke="#F7B6CE" strokeWidth="9" strokeLinecap="round" />
          <g className="mbm-bi">
            <path d="M54 52 Q38 66 28 84" stroke="#F7B6CE" strokeWidth="9" strokeLinecap="round" />
            {/* lupa de inspector */}
            <line x1="28" y1="84" x2="21" y2="94" stroke="#9D5C77" strokeWidth="4" strokeLinecap="round" />
            <circle cx="16" cy="102" r="10" fill="#EAF6FF" stroke="#9D5C77" strokeWidth="3.5" />
          </g>
          <g className="mbm-bd">
            <path d="M66 52 Q82 66 92 84" stroke="#F7B6CE" strokeWidth="9" strokeLinecap="round" />
          </g>
        </g>
      </svg>
    </span>
  );
}

// Muñequito bailarín de brazos y pies largos, rosa pastel.
// Aparece en estados vacíos para darle simpatía a la pantalla.
export function MuniecoBailarin({ mensaje }: { mensaje: string }) {
  return (
    <div
      className="flex w-full flex-col items-center justify-center gap-3 py-6 select-none"
      data-testid="munieco-bailarin"
    >
      <style>{`
        @keyframes mb-paseo {
          0% { left: 0; transform: scaleX(1); }
          25% { left: calc(50% - 65px); }
          40% { left: calc(50% - 65px); }
          49.9% { transform: scaleX(1); }
          50% { left: calc(100% - 130px); transform: scaleX(-1); }
          75% { left: calc(50% - 65px); }
          90% { left: calc(50% - 65px); }
          99.9% { transform: scaleX(-1); }
          100% { left: 0; transform: scaleX(1); }
        }
        @keyframes mb-saludo {
          0%, 25%, 42%, 75%, 92%, 100% { transform: rotate(0deg); }
          28%, 34%, 40% { transform: rotate(-110deg); }
          31%, 37% { transform: rotate(-80deg); }
          78%, 84%, 90% { transform: rotate(-110deg); }
          81%, 87% { transform: rotate(-80deg); }
        }
        .mb-paseo {
          position: absolute;
          top: 0;
          animation: mb-paseo 20s linear infinite;
        }
        .mb-saludo { animation: mb-saludo 20s linear infinite; transform-origin: 66px 52px; }
        @keyframes mb-cz1 {
          0%, 27% { opacity: 0; transform: translate(0px, 0px) scale(0.4); }
          29% { opacity: 1; transform: translate(4px, -4px) scale(0.7); }
          38% { opacity: 0; transform: translate(16px, -30px) scale(1.1); }
          38.1%, 77% { opacity: 0; transform: translate(0px, 0px) scale(0.4); }
          79% { opacity: 1; transform: translate(4px, -4px) scale(0.7); }
          88% { opacity: 0; transform: translate(16px, -30px) scale(1.1); }
          88.1%, 100% { opacity: 0; transform: translate(0px, 0px) scale(0.4); }
        }
        @keyframes mb-cz2 {
          0%, 30% { opacity: 0; transform: translate(0px, 0px) scale(0.4); }
          32% { opacity: 1; transform: translate(6px, -2px) scale(0.7); }
          40% { opacity: 0; transform: translate(26px, -22px) scale(1.2); }
          40.1%, 80% { opacity: 0; transform: translate(0px, 0px) scale(0.4); }
          82% { opacity: 1; transform: translate(6px, -2px) scale(0.7); }
          90% { opacity: 0; transform: translate(26px, -22px) scale(1.2); }
          90.1%, 100% { opacity: 0; transform: translate(0px, 0px) scale(0.4); }
        }
        @keyframes mb-cz3 {
          0%, 33% { opacity: 0; transform: translate(0px, 0px) scale(0.4); }
          35% { opacity: 1; transform: translate(3px, -6px) scale(0.7); }
          41% { opacity: 0; transform: translate(10px, -38px) scale(1); }
          41.1%, 83% { opacity: 0; transform: translate(0px, 0px) scale(0.4); }
          85% { opacity: 1; transform: translate(3px, -6px) scale(0.7); }
          91% { opacity: 0; transform: translate(10px, -38px) scale(1); }
          91.1%, 100% { opacity: 0; transform: translate(0px, 0px) scale(0.4); }
        }
        .mb-cz1 { animation: mb-cz1 20s linear infinite; opacity: 0; }
        .mb-cz2 { animation: mb-cz2 20s linear infinite; opacity: 0; }
        .mb-cz3 { animation: mb-cz3 20s linear infinite; opacity: 0; }
        @keyframes mb-besito {
          0%, 26%, 42%, 76%, 92%, 100% { transform: scale(1); }
          29%, 35%, 79%, 85% { transform: scale(1.6); }
          32%, 38%, 82%, 88% { transform: scale(0.8); }
        }
        .mb-boca { animation: mb-besito 20s linear infinite; transform-origin: 60px 35px; }
        @media (prefers-reduced-motion: reduce) {
          .mb-paseo { animation: none; left: calc(50% - 65px); }
        }
        @keyframes mb-baile {
          0%, 100% { transform: rotate(-6deg) translateY(0); }
          25% { transform: rotate(4deg) translateY(-6px); }
          50% { transform: rotate(-4deg) translateY(0); }
          75% { transform: rotate(6deg) translateY(-6px); }
        }
        @keyframes mb-brazo-izq {
          0%, 100% { transform: rotate(20deg); }
          50% { transform: rotate(-60deg); }
        }
        @keyframes mb-brazo-der {
          0%, 100% { transform: rotate(-60deg); }
          50% { transform: rotate(20deg); }
        }
        @keyframes mb-pie-izq {
          0%, 100% { transform: rotate(0deg); }
          50% { transform: rotate(-25deg); }
        }
        @keyframes mb-pie-der {
          0%, 100% { transform: rotate(0deg); }
          50% { transform: rotate(25deg); }
        }
        @keyframes mb-cintura {
          0%, 100% { transform: rotate(-9deg) translateX(-4px); }
          50% { transform: rotate(9deg) translateX(4px); }
        }
        .mb-cuerpo { animation: mb-baile 2.4s ease-in-out infinite; transform-origin: 60px 70px; }
        .mb-cadera { animation: mb-cintura 1.2s ease-in-out infinite; transform-origin: 60px 62px; }
        .mb-bi { animation: mb-brazo-izq 0.8s ease-in-out infinite; transform-origin: 60px 52px; }
        .mb-bd { animation: mb-brazo-der 0.8s ease-in-out infinite; transform-origin: 60px 52px; }
        .mb-pi { animation: mb-pie-izq 0.8s ease-in-out infinite; transform-origin: 52px 108px; }
        .mb-pd { animation: mb-pie-der 0.8s ease-in-out infinite; transform-origin: 68px 108px; }
        @media (prefers-reduced-motion: reduce) {
          .mb-cuerpo, .mb-cadera, .mb-bi, .mb-bd, .mb-pi, .mb-pd, .mb-saludo, .mb-boca { animation: none; }
          .mb-cz1, .mb-cz2, .mb-cz3 { animation: none; opacity: 0; }
        }
      `}</style>
      <div className="relative w-full" style={{ height: 150 }}>
        <div className="mb-paseo">
          <svg width="130" height="150" viewBox="0 0 120 150" fill="none" aria-hidden="true">
        <g className="mb-cuerpo">
          {/* cabeza */}
          <circle cx="60" cy="30" r="14" fill="#F9C6D8" />
          {/* sombrero de inspector */}
          <ellipse cx="60" cy="19" rx="19" ry="4.5" fill="#D46A9A" />
          <path d="M49 19 Q49 6 60 6 Q71 6 71 19 Z" fill="#E58BB0" />
          <rect x="49" y="15" width="22" height="4" rx="2" fill="#B75585" />
          {/* carita */}
          <circle cx="55" cy="28" r="1.8" fill="#9D5C77" />
          <circle cx="65" cy="28" r="1.8" fill="#9D5C77" />
          <g className="mb-boca">
            <path d="M54 34 Q60 39 66 34" stroke="#9D5C77" strokeWidth="1.8" strokeLinecap="round" />
          </g>
          {/* corazones de los besitos */}
          <g transform="translate(72, 30)">
            <path className="mb-cz1" d="M0 2 C -4 -3, -9 1, 0 8 C 9 1, 4 -3, 0 2" fill="#F48FB1" />
          </g>
          <g transform="translate(74, 34)">
            <path className="mb-cz2" d="M0 2 C -3 -2, -7 1, 0 6 C 7 1, 3 -2, 0 2" fill="#F8BBD0" />
          </g>
          <g transform="translate(70, 26)">
            <path className="mb-cz3" d="M0 2 C -3 -2, -7 1, 0 6 C 7 1, 3 -2, 0 2" fill="#EC7FAE" />
          </g>
          {/* torso superior */}
          <rect x="52" y="44" width="16" height="22" rx="8" fill="#F7B6CE" />
          {/* cadera + piernas + pies: mueven la cintura */}
          <g className="mb-cadera">
            {/* cadera */}
            <rect x="50" y="60" width="20" height="28" rx="9" fill="#F7B6CE" />
            {/* piernas */}
            <path d="M55 86 L52 108" stroke="#F7B6CE" strokeWidth="7" strokeLinecap="round" />
            <path d="M65 86 L68 108" stroke="#F7B6CE" strokeWidth="7" strokeLinecap="round" />
            {/* pies LARGOS */}
            <g className="mb-pi">
              <path d="M52 108 Q40 116 20 118" stroke="#F2A0C0" strokeWidth="8" strokeLinecap="round" />
            </g>
            <g className="mb-pd">
              <path d="M68 108 Q80 116 100 118" stroke="#F2A0C0" strokeWidth="8" strokeLinecap="round" />
            </g>
          </g>
          {/* brazos LARGOS */}
          <g className="mb-bi">
            <path d="M54 52 Q36 66 26 84" stroke="#F7B6CE" strokeWidth="7" strokeLinecap="round" />
            <circle cx="26" cy="84" r="5" fill="#F9C6D8" />
            {/* lupa de inspector */}
            <line x1="25" y1="87" x2="20" y2="95" stroke="#9D5C77" strokeWidth="3.5" strokeLinecap="round" />
            <circle cx="16" cy="103" r="9" fill="#EAF6FF" stroke="#9D5C77" strokeWidth="3" />
          </g>
          <g className="mb-saludo">
            <g className="mb-bd">
              <path d="M66 52 Q84 66 94 84" stroke="#F7B6CE" strokeWidth="7" strokeLinecap="round" />
              <circle cx="94" cy="84" r="5" fill="#F9C6D8" />
            </g>
          </g>
        </g>
          </svg>
        </div>
      </div>
      <p className="text-sm text-muted-foreground text-center">{mensaje}</p>
    </div>
  );
}
