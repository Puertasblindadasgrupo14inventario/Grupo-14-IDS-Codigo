/** Iniciales del usuario, misma lógica que layout.js */
export function getInitials(user) {
  if (!user?.nombre) return '--';
  return user.nombre
    .split(' ')
    .map(n => n[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();
}

/** Etiqueta de rol mostrada en el sidebar (B-15: antes todo lo que no era gerencia salía "JOP") */
const ETIQUETAS_ROL = {
  gerencia: 'Gerencia',
  jop: 'JOP',
  tecnico: 'Técnico',
  administrador: 'Administrador',
  secretaria: 'Secretaría',
};
export function getRoleLabel(user) {
  return ETIQUETAS_ROL[user?.rol] || '—';
}

/**
 * B-45 (D95): al módulo Inventario entran solo Gerencia y JOP. Los demás roles son de otros
 * módulos del sistema; el backend los rechaza con 403 (soloInventario) y aquí no se les deja entrar.
 */
export const ROLES_INVENTARIO = ['gerencia', 'jop'];
export function esRolInventario(user) {
  return ROLES_INVENTARIO.includes(user?.rol);
}

/**
 * B-19: los 5 roles del sistema que se asignan en Usuarios (crear y editar), con lo que puede
 * hacer cada uno. B-45: los tres últimos son de otros módulos y no entran a Inventario.
 */
export const ROLES_USUARIO = [
  { valor: 'gerencia',      ayuda: 'acceso completo; aprueba y autoriza' },
  { valor: 'jop',           ayuda: 'opera inventario y OT, sin ver costos' },
  { valor: 'administrador', ayuda: 'otro módulo; sin acceso a Inventario' },
  { valor: 'tecnico',       ayuda: 'otro módulo; sin acceso a Inventario' },
  { valor: 'secretaria',    ayuda: 'otro módulo; sin acceso a Inventario' },
].map(r => ({ ...r, etiqueta: ETIQUETAS_ROL[r.valor] }));

/**
 * B-05 (D81): el apodo se guarda en el navegador, por usuario, sin tocar el username.
 * Persiste entre sesiones en el mismo equipo. localStorage puede fallar (modo privado):
 * entonces simplemente no hay apodo.
 */
const claveApodo = (id) => `pb_apodo_${id}`;
export function getApodo(id) {
  try { return localStorage.getItem(claveApodo(id)) || null; } catch { return null; }
}
export function setApodo(id, apodo) {
  try {
    if (apodo) localStorage.setItem(claveApodo(id), apodo);
    else localStorage.removeItem(claveApodo(id));
  } catch { /* sin almacenamiento: el apodo dura lo que la pestaña */ }
}

/**
 * D50 (sesión 15): los montos (precios, costos, valores, valorización) se ocultan a jop
 * (B-45: el técnico ya no entra al módulo). Es la misma regla que ocultaMontos() del backend,
 * que es la que manda: aquí solo se evita mostrar columnas o enlaces que llegarían vacíos.
 */
export function ocultaMontos(user) {
  return user?.rol === 'jop';
}
