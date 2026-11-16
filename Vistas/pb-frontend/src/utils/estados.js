/**
 * F-25c: tono de StatusPill para los estados que se muestran en más de una pantalla.
 * Así una prioridad o un tipo de movimiento tiene el mismo color en todo el sistema.
 */

/** Prioridad de una alerta: urgente, alta o media. */
export const tonoPrioridad = (p) => p === 'urgente' ? 'peligro' : p === 'alta' ? 'aviso' : 'neutro';

/** Tipo de movimiento ('Entrada', 'salida', 'Traslado entrada'...): entrada verde, salida roja, traslado naranja. */
export const tonoMovimiento = (tipo = '') => {
  const t = String(tipo).toLowerCase();
  if (t.includes('traslado')) return 'naranja';
  if (t.includes('entrada')) return 'exito';
  if (t.includes('salida')) return 'peligro';
  return 'neutro';
};
