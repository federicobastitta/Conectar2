import { AnimatePresence, motion } from 'framer-motion';
import { useState, useEffect } from 'react';

export function Scene2() {
  const [phase, setPhase] = useState(0);

  useEffect(() => {
    const timers = [
      setTimeout(() => setPhase(1), 800),
      setTimeout(() => setPhase(2), 2000),
      setTimeout(() => setPhase(3), 4000),
    ];
    return () => timers.forEach(t => clearTimeout(t));
  }, []);

  return (
    <motion.div 
      className="absolute inset-0 pt-20 pb-4 px-6"
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, filter: 'blur(10px)' }}
      transition={{ duration: 0.6 }}
    >
      <div className="w-full h-full rounded-xl border border-gray-200 bg-white shadow-sm overflow-hidden flex">
        {/* Placeholder columns for UI */}
        <div className="w-1/4 border-r border-gray-100 bg-gray-50/50 p-4 relative">
          <motion.div 
            className="absolute inset-0 bg-[#2563eb]/5 z-10"
            initial={{ opacity: 0 }}
            animate={phase >= 1 ? { opacity: 1 } : { opacity: 0 }}
          />
          <div className="h-8 bg-gray-200 rounded w-1/2 mb-6"></div>
          <div className="space-y-3">
            {[1,2,3,4].map(i => (
              <div key={i} className="h-16 bg-white border border-gray-100 rounded-lg shadow-sm"></div>
            ))}
          </div>
        </div>
        
        <div className="w-1/2 p-6 relative">
          <div className="h-8 bg-gray-200 rounded w-1/3 mb-8"></div>
          <div className="space-y-6">
            <div className="h-32 bg-gray-50 border border-gray-100 rounded-lg"></div>
            <div className="h-32 bg-gray-50 border border-gray-100 rounded-lg"></div>
          </div>
        </div>
        
        <div className="w-1/4 border-l border-gray-100 bg-gray-50/50 p-4">
           <div className="h-8 bg-gray-200 rounded w-2/3 mb-6"></div>
           <div className="h-48 bg-white border border-gray-100 rounded-lg shadow-sm"></div>
        </div>
      </div>

      {/* Overlay text */}
      <AnimatePresence>
        {phase >= 1 && phase < 3 && (
          <motion.div 
            className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 bg-white/90 backdrop-blur-sm px-8 py-6 rounded-2xl shadow-xl border border-gray-100 text-center z-50"
            initial={{ opacity: 0, scale: 0.9, y: '-40%', x: '-50%' }}
            animate={{ opacity: 1, scale: 1, y: '-50%', x: '-50%' }}
            exit={{ opacity: 0, scale: 1.1, y: '-50%', x: '-50%' }}
            transition={{ type: 'spring', damping: 25, stiffness: 300 }}
          >
            <h2 className="text-2xl font-bold text-[#0f172a] mb-2">Consola de Recepción</h2>
            <p className="text-[#475569]">El centro de comando unificado.</p>
            
            <motion.div 
              className="mt-6 flex justify-center gap-4"
              initial={{ opacity: 0 }}
              animate={phase >= 2 ? { opacity: 1 } : { opacity: 0 }}
            >
              <div className="bg-blue-50 text-blue-700 px-3 py-1.5 rounded text-sm font-medium">Búsqueda rápida</div>
              <div className="bg-green-50 text-green-700 px-3 py-1.5 rounded text-sm font-medium">Estado en vivo</div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}