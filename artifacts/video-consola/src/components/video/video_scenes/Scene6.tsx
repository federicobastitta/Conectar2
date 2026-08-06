import { AnimatePresence, motion } from 'framer-motion';
import { useState, useEffect } from 'react';

export function Scene6() {
  const [phase, setPhase] = useState(0);

  useEffect(() => {
    const timers = [
      setTimeout(() => setPhase(1), 800),
      setTimeout(() => setPhase(2), 2000),
      setTimeout(() => setPhase(3), 3200),
    ];
    return () => timers.forEach(t => clearTimeout(t));
  }, []);

  return (
    <motion.div 
      className="absolute inset-0 pt-20 pb-4 px-6 flex items-end justify-center"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0, y: -20 }}
      transition={{ duration: 0.6 }}
    >
      <div className="absolute inset-0 bg-white/50 backdrop-blur-sm z-0" />

      <motion.div 
        className="relative z-10 w-full max-w-4xl bg-white rounded-2xl shadow-2xl border border-gray-200 overflow-hidden mb-12 flex flex-col items-center"
        initial={{ y: 50, scale: 0.95 }}
        animate={{ y: 0, scale: 1 }}
        transition={{ type: 'spring', damping: 25 }}
      >
        <div className="p-8 w-full flex flex-col items-center text-center">
          <h2 className="text-2xl font-bold text-[#0f172a] mb-2">Todo listo para la atención</h2>
          <p className="text-gray-500 mb-8">Los datos fueron validados con éxito.</p>

          <motion.button 
            className="bg-[#2563eb] text-white text-xl font-bold px-12 py-4 rounded-xl shadow-lg relative overflow-hidden"
            whileHover={{ scale: 1.05 }}
            animate={phase === 1 ? { scale: 0.95, backgroundColor: '#1d4ed8' } : { scale: 1, backgroundColor: '#2563eb' }}
          >
            Recepcionar Paciente
            {phase >= 1 && (
              <motion.div 
                className="absolute inset-0 bg-white/20"
                initial={{ x: '-100%' }}
                animate={{ x: '100%' }}
                transition={{ duration: 0.5 }}
              />
            )}
          </motion.button>
        </div>

        <AnimatePresence>
          {phase >= 2 && (
            <motion.div 
              className="w-full bg-slate-50 border-t border-slate-200 p-8"
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: 'auto', opacity: 1 }}
              transition={{ duration: 0.5, ease: 'easeOut' }}
            >
              <div className="flex justify-center gap-12">
                <motion.div 
                  className="flex flex-col items-center text-center max-w-[200px]"
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: 0.2 }}
                >
                  <div className="w-12 h-12 rounded-full bg-blue-100 text-blue-600 flex items-center justify-center mb-3">
                    <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z" /></svg>
                  </div>
                  <h4 className="font-semibold text-slate-800">Sala de Espera</h4>
                  <p className="text-sm text-slate-500 mt-1">El paciente aparece en la pantalla de espera.</p>
                </motion.div>

                <motion.div 
                  className="flex items-center text-slate-300"
                  initial={{ opacity: 0, x: -20 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ delay: 0.4 }}
                >
                  <svg className="w-8 h-8" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M14 5l7 7m0 0l-7 7m7-7H3" /></svg>
                </motion.div>

                <motion.div 
                  className="flex flex-col items-center text-center max-w-[200px]"
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: 0.6 }}
                >
                  <div className="w-12 h-12 rounded-full bg-green-100 text-green-600 flex items-center justify-center mb-3">
                    <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
                  </div>
                  <h4 className="font-semibold text-slate-800">Escritorio Médico</h4>
                  <p className="text-sm text-slate-500 mt-1">El médico ya lo ve en su consultorio digital.</p>
                </motion.div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

      </motion.div>
    </motion.div>
  );
}