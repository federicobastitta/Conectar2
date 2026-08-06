---
name: AppLayout hooks antes de los returns
description: Regla para no repetir la pantalla en blanco de prod (ago 2026) al tocar AppLayout u otros componentes con returns tempranos.
---

Regla: en `mi-diagnosticar` los componentes grandes (AppLayout, páginas con guard de loading) tienen **returns tempranos** (spinner mientras `isLoading`, guard de rol). Todo hook nuevo (`useEffect`, `useMemo`, etc.) debe declararse **antes** de esos returns.

**Why:** en ago 2026 un `useEffect` agregado después del return de loading de AppLayout violó las reglas de hooks: al terminar de cargar la sesión cambiaba la cantidad de hooks renderizados y React crasheaba → pantalla en blanco para todos en producción.

**How to apply:** al editar AppLayout o cualquier componente, buscar primero `if (...) return` por encima del punto de inserción; derivar los datos que necesita el hook con optional chaining (`user?.perfil`) en vez de moverlo debajo del guard.
