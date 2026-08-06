import { AnimatePresence, motion } from 'framer-motion';
import { useState, useEffect } from 'react';

export function Scene5() {
  const [phase, setPhase] = useState(0);

  useEffect(() => {
    const timers = [
      setTimeout(() => setPhase(1), 500),
      setTimeout(() => setPhase(2), 1500),
      setTimeout(() => setPhase(3), 2800),
    ];
    return () => timers.forEach(t => clearTimeout(t));
  }, []);

  return (
    <motion.div 
      className="absolute inset-0 pt-20 pb-4 px-6"
      initial={{ opacity: 0, x: 20 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.6 }}
    >
      <div className="w-full h-full rounded-xl border border-gray-200 bg-white shadow-sm overflow-hidden flex">
        {/* Left and Center faded out */}
        <div className="w-3/4 flex opacity-30 filter blur-[2px] pointer-events-none">
          <div className="w-1/3 border-r border-gray-200 bg-gray-50 p-4">
            <div className="h-full bg-gray-200 rounded"></div>
          </div>
          <div className="w-2/3 p-6 bg-white">
            <div className="h-full bg-gray-100 rounded-lg"></div>
          </div>
        </div>

        {/* Right Column Focus: Token KLINICOS */}
        <motion.div 
          className="w-1/4 border-l border-gray-200 bg-slate-50 flex flex-col z-20 shadow-[-10px_0_15px_-3px_rgba(0,0,0,0.05)] relative"
          initial={{ x: 20, opacity: 0 }}
          animate={{ x: 0, opacity: 1 }}
          transition={{ type: 'spring', damping: 20 }}
        >
          <div className="p-4 border-b border-gray-200 bg-white flex justify-between items-center">
            <h3 className="font-semibold text-[#0f172a]">Token</h3>
            <span className="text-xs font-mono bg-slate-100 px-2 py-0.5 rounded text-slate-500">KLINICOS</span>
          </div>
          
          <div className="p-4 flex flex-col gap-4">
            {/* Status Panel */}
            <motion.div 
              className="bg-white rounded-lg border border-gray-200 shadow-sm p-4 relative overflow-hidden"
            >
              {phase < 2 && (
                <motion.div 
                  className="absolute inset-0 bg-blue-50/50 flex flex-col items-center justify-center z-10"
                  exit={{ opacity: 0 }}
                >
                  <motion.div 
                    className="w-8 h-8 border-2 border-blue-500 border-t-transparent rounded-full mb-2"
                    animate={{ rotate: 360 }}
                    transition={{ repeat: Infinity, duration: 1, ease: 'linear' }}
                  />
                  <span className="text-sm font-medium text-blue-700">Validando en KLINICOS...</span>
                </motion.div>
              )}

              {phase >= 2 && (
                <motion.div 
                  className="flex flex-col items-center text-center"
                  initial={{ opacity: 0, scale: 0.9 }}
                  animate={{ opacity: 1, scale: 1 }}
                  transition={{ type: 'spring' }}
                >
                  <div className="w-12 h-12 bg-green-100 text-green-600 rounded-full flex items-center justify-center mb-3">
                    <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M5 13l4 4L19 7"/></svg>
                  </div>
                  <h4 className="font-bold text-green-700 text-lg">Token Validado</h4>
                  <p className="text-xs text-gray-500 mt-1">Autorización exitosa</p>
                </motion.div>
              )}
            </motion.div>

            {/* Data Sent visual */}
            <motion.div 
              className="bg-slate-800 rounded-lg p-3 text-slate-300 font-mono text-[10px] overflow-hidden relative shadow-inner"
              initial={{ opacity: 0 }}
              animate={phase >= 1 ? { opacity: 1 } : { opacity: 0 }}
            >
              <div className="text-slate-500 mb-1">// Datos enviados a KLINICOS</div>
              <motion.div
                initial={{ y: 20, opacity: 0 }}
                animate={{ y: 0, opacity: 1 }}
                transition={{ duration: 0.5 }}
              >
                <div className="text-blue-400">{"{"}</div>
                <div className="pl-4">"paciente": "30123456",</div>
                <div className="pl-4">"cobertura": "IOMA",</div>
                <div className="pl-4">"practica": "420101",</div>
                <div className="pl-4">"token": <span className="text-yellow-400">"TKN-8492"</span></div>
                <div className="text-blue-400">{"}"}</div>
              </motion.div>

              {phase >= 2 && (
                <motion.div
                  className="mt-2 pt-2 border-t border-slate-700"
                  initial={{ y: 10, opacity: 0 }}
                  animate={{ y: 0, opacity: 1 }}
                >
                  <div className="text-green-400">{"// Resultado: 200 OK"}</div>
                </motion.div>
              )}
            </motion.div>

            {/* Callout Info */}
            <AnimatePresence>
              {phase >= 3 && (
                <motion.div 
                  className="bg-amber-50 border border-amber-200 rounded p-3 mt-auto"
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                >
                  <div className="flex gap-2">
                    <svg className="w-4 h-4 text-amber-500 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>
                    <p className="text-xs text-amber-800">
                      <strong>Si falla:</strong> Se envía a revisión manual. No hay reintentos automáticos.
                    </p>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </motion.div>
      </div>
    </motion.div>
  );
}