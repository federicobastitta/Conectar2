import { motion } from 'framer-motion';
import { useState, useEffect } from 'react';

export function Scene4() {
  const [phase, setPhase] = useState(0);

  useEffect(() => {
    const timers = [
      setTimeout(() => setPhase(1), 500),
      setTimeout(() => setPhase(2), 1500),
      setTimeout(() => setPhase(3), 2500),
      setTimeout(() => setPhase(4), 3500),
    ];
    return () => timers.forEach(t => clearTimeout(t));
  }, []);

  return (
    <motion.div 
      className="absolute inset-0 pt-20 pb-4 px-6"
      initial={{ opacity: 0, scale: 0.95 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 1.05 }}
      transition={{ duration: 0.6 }}
    >
      <div className="w-full h-full rounded-xl border border-gray-200 bg-white shadow-sm overflow-hidden flex">
        {/* Left col faded */}
        <div className="w-1/4 border-r border-gray-200 bg-gray-50 opacity-40 p-4">
          <div className="h-8 bg-gray-300 rounded mb-4"></div>
          <div className="h-16 bg-white border border-gray-300 rounded mb-2"></div>
          <div className="h-16 bg-blue-100 border border-blue-300 rounded"></div>
        </div>

        {/* Center: Patient Record Focus */}
        <div className="w-1/2 p-6 bg-white z-10 shadow-2xl relative overflow-y-auto">
          <motion.div 
            className="flex items-center gap-4 mb-8"
            initial={{ opacity: 0, y: -10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.2 }}
          >
            <div className="w-14 h-14 rounded-full bg-blue-100 text-blue-700 flex items-center justify-center text-xl font-bold">JL</div>
            <div>
              <h2 className="text-2xl font-bold text-[#0f172a]">López, Juan</h2>
              <p className="text-gray-500">DNI: 30.123.456 • 34 años</p>
            </div>
          </motion.div>

          <div className="space-y-6">
            {/* Attention Data */}
            <motion.div 
              className="border border-gray-200 rounded-xl p-4 bg-gray-50/50"
              initial={{ opacity: 0, x: -20 }}
              animate={phase >= 1 ? { opacity: 1, x: 0 } : { opacity: 0, x: -20 }}
              transition={{ type: 'spring', damping: 20 }}
            >
              <h3 className="font-semibold text-[#0f172a] mb-3 flex items-center gap-2">
                <svg className="w-4 h-4 text-blue-500" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" /></svg>
                Datos de la atención
              </h3>
              <div className="grid grid-cols-2 gap-4 text-sm">
                <div><span className="text-gray-500 block text-xs">Profesional</span><span className="font-medium">Dr. Gómez, Roberto</span></div>
                <div><span className="text-gray-500 block text-xs">Práctica</span><span className="font-medium">Consulta Cardiología</span></div>
              </div>
            </motion.div>

            {/* Coverage */}
            <motion.div 
              className="border border-gray-200 rounded-xl p-4 bg-gray-50/50"
              initial={{ opacity: 0, x: -20 }}
              animate={phase >= 2 ? { opacity: 1, x: 0 } : { opacity: 0, x: -20 }}
              transition={{ type: 'spring', damping: 20 }}
            >
              <h3 className="font-semibold text-[#0f172a] mb-3 flex items-center gap-2">
                <svg className="w-4 h-4 text-blue-500" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" /></svg>
                Cobertura
              </h3>
              <div className="grid grid-cols-2 gap-4 text-sm">
                <div><span className="text-gray-500 block text-xs">Obra Social</span><span className="font-medium text-blue-700 bg-blue-50 px-2 py-0.5 rounded">IOMA</span></div>
                <div><span className="text-gray-500 block text-xs">Nº Afiliado</span><span className="font-mono">123456789/00</span></div>
              </div>
            </motion.div>

            {/* Documentation */}
            <motion.div 
              className="border border-blue-200 rounded-xl p-4 bg-blue-50/30 relative overflow-hidden"
              initial={{ opacity: 0, x: -20 }}
              animate={phase >= 3 ? { opacity: 1, x: 0 } : { opacity: 0, x: -20 }}
              transition={{ type: 'spring', damping: 20 }}
            >
              <h3 className="font-semibold text-[#0f172a] mb-3 flex items-center gap-2">
                <svg className="w-4 h-4 text-blue-500" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" /></svg>
                Documentación
              </h3>
              <div className="space-y-2">
                <div className="flex items-center justify-between p-2 bg-white rounded border border-gray-200">
                  <span className="text-sm font-medium text-gray-700">DNI (Frente y Dorso)</span>
                  <span className="text-xs text-green-600 bg-green-50 px-2 py-1 rounded font-medium flex items-center gap-1"><svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M5 13l4 4L19 7"/></svg> Validado</span>
                </div>
                <div className="flex items-center justify-between p-2 bg-white rounded border border-blue-300 ring-1 ring-blue-100 shadow-sm relative">
                  <span className="text-sm font-medium text-[#0f172a]">Orden Médica</span>
                  <motion.div 
                    className="flex items-center gap-2"
                    initial={{ opacity: 0 }}
                    animate={phase >= 4 ? { opacity: 1 } : { opacity: 0 }}
                  >
                    <span className="text-xs text-blue-600 bg-blue-50 px-2 py-1 rounded font-medium">Subiendo...</span>
                    <motion.div 
                      className="w-16 h-1.5 bg-gray-100 rounded-full overflow-hidden"
                    >
                      <motion.div 
                        className="h-full bg-blue-500"
                        initial={{ width: 0 }}
                        animate={{ width: '100%' }}
                        transition={{ duration: 1, delay: 3.6 }}
                      />
                    </motion.div>
                  </motion.div>
                </div>
              </div>
            </motion.div>
          </div>
        </div>

        {/* Right col faded */}
        <div className="w-1/4 border-l border-gray-200 bg-gray-50 opacity-40 p-4">
          <div className="h-48 bg-white border border-gray-300 rounded shadow-sm"></div>
        </div>
      </div>
    </motion.div>
  );
}