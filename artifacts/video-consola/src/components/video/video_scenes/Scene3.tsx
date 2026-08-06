import { motion } from 'framer-motion';
import { useState, useEffect } from 'react';

export function Scene3() {
  const [phase, setPhase] = useState(0);

  useEffect(() => {
    const timers = [
      setTimeout(() => setPhase(1), 500),
      setTimeout(() => setPhase(2), 1500),
      setTimeout(() => setPhase(3), 3000),
    ];
    return () => timers.forEach(t => clearTimeout(t));
  }, []);

  return (
    <motion.div 
      className="absolute inset-0 pt-20 pb-4 px-6"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ x: '-10%', opacity: 0 }}
      transition={{ duration: 0.6 }}
    >
      <div className="w-full h-full rounded-xl border border-gray-200 bg-white shadow-sm overflow-hidden flex">
        {/* Left Column focus */}
        <motion.div 
          className="w-1/3 border-r border-gray-200 bg-gray-50 flex flex-col z-20 shadow-[10px_0_15px_-3px_rgba(0,0,0,0.05)]"
          initial={{ x: -20, opacity: 0 }}
          animate={{ x: 0, opacity: 1 }}
          transition={{ type: 'spring', damping: 20 }}
        >
          <div className="p-4 border-b border-gray-200 bg-white">
            <h3 className="font-semibold text-lg text-[#0f172a]">Turnos del día</h3>
            <div className="text-sm text-gray-500 mt-1">12 en espera</div>
          </div>
          
          <div className="p-3 space-y-2 overflow-hidden">
            {[
              { time: '09:00', name: 'García, María', status: 'En espera', active: false },
              { time: '09:15', name: 'López, Juan', status: 'Llegó', active: true },
              { time: '09:30', name: 'Martínez, Ana', status: 'Confirmado', active: false },
              { time: '09:45', name: 'Rodríguez, C.', status: 'Confirmado', active: false },
            ].map((turno, i) => (
              <motion.div 
                key={i}
                className={`p-3 rounded-lg border ${turno.active && phase >= 2 ? 'border-blue-500 bg-blue-50 shadow-md ring-1 ring-blue-500' : 'border-gray-200 bg-white shadow-sm'}`}
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.1 * i, duration: 0.4 }}
              >
                <div className="flex justify-between items-start mb-2">
                  <div className="font-medium text-[#0f172a]">{turno.name}</div>
                  <div className="text-xs font-mono text-gray-500">{turno.time}</div>
                </div>
                <div className="flex items-center gap-1.5">
                  <span className={`w-2 h-2 rounded-full ${turno.active && phase >= 2 ? 'bg-blue-500' : 'bg-green-500'}`}></span>
                  <span className="text-xs text-gray-600">{turno.status}</span>
                </div>
              </motion.div>
            ))}
          </div>
        </motion.div>
        
        {/* Right side blurred */}
        <div className="w-2/3 p-6 opacity-30 pointer-events-none filter blur-sm">
          <div className="h-8 bg-gray-200 rounded w-1/3 mb-8"></div>
          <div className="space-y-6">
            <div className="h-32 bg-gray-50 border border-gray-100 rounded-lg"></div>
            <div className="h-32 bg-gray-50 border border-gray-100 rounded-lg"></div>
          </div>
        </div>
      </div>

      {/* Floating Callout */}
      {phase >= 1 && (
        <motion.div 
          className="absolute left-1/4 top-1/3 bg-[#0f172a] text-white px-6 py-4 rounded-xl shadow-xl z-50 max-w-sm"
          initial={{ opacity: 0, x: 20, scale: 0.9 }}
          animate={{ opacity: 1, x: 0, scale: 1 }}
          transition={{ type: 'spring', damping: 20 }}
        >
          <div className="font-bold text-lg mb-1">Cola en tiempo real</div>
          <p className="text-sm text-gray-300">Seleccionamos al paciente para iniciar la recepción.</p>
          
          {phase >= 2 && (
            <motion.div 
              className="absolute -left-3 top-1/2 w-6 h-6 bg-[#0f172a] rotate-45"
              style={{ marginTop: '-12px' }}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
            />
          )}
        </motion.div>
      )}
    </motion.div>
  );
}