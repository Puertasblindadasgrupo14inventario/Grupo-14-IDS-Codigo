/**
 * F-25c (lineamientos de composición, sección 7): estado embebido en el registro. Usa las clases .badge
 * de global.css. Los tonos de los estados que se repiten entre pantallas están en utils/estados.js.
 * Tonos: exito, peligro, aviso, info, neutro, naranja, anulado (solo borde) y critico (relleno rojo).
 */
const CLASE = {
  exito:   'badge-success',
  peligro: 'badge-danger',
  aviso:   'badge-warning',
  info:    'badge-info',
  neutro:  'badge-gray',
  naranja: 'badge-orange',
  anulado: 'badge-ghost',
  critico: 'badge-critico',
};

export default function StatusPill({ tono = 'neutro', title, style, children }) {
  return <span className={`badge ${CLASE[tono] || CLASE.neutro}`} title={title} style={style}>{children}</span>;
}
