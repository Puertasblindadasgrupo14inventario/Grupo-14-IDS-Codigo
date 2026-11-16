/**
 * F-42b: lo que cambió en una edición, para la auditoría: "estado activo → inactivo; stock mínimo 5 → 10".
 *
 * Se llama con la fila leída antes y después del UPDATE (en la misma transacción), con los
 * valores ya legibles (nombres, no ids). Solo se nombran los campos que cambiaron.
 *
 *   describirCambios(antes, despues, [{ clave: 'estado', etiqueta: 'estado' },
 *                                     { clave: 'descripcion', etiqueta: 'la descripción', largo: true }])
 *
 * largo: textos largos (descripción, notas) solo dicen "cambió la descripción", sin copiarlos.
 * personal: datos personales (correo, RUT, nombre, contacto) igual: "cambió el correo", sin el valor
 *   anterior ni el nuevo (B-36, D94: Ley 21.719, art. 14 quáter).
 */
const VACIO = '—';

/** Un valor como texto legible: vacío → —, booleano → sí/no, número (también el NUMERIC de pg) → 1.234,5. */
function texto(v) {
  if (v == null || v === '') return VACIO;
  if (typeof v === 'boolean') return v ? 'sí' : 'no';
  if (typeof v === 'number' || (typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v.trim()))) {
    return Number(v).toLocaleString('es-CL', { maximumFractionDigits: 4 });
  }
  if (v instanceof Date) return v.toLocaleDateString('es-CL', { timeZone: 'America/Santiago' });
  return String(v).trim() || VACIO;
}

function describirCambios(antes, despues, campos) {
  const partes = [];
  for (const { clave, etiqueta, largo, personal } of campos) {
    const a = texto(antes?.[clave]);
    const d = texto(despues?.[clave]);
    if (a === d) continue;
    partes.push(largo || personal ? `cambió ${etiqueta}` : `${etiqueta} ${a} → ${d}`);
  }
  return partes.length ? partes.join('; ') : 'sin cambios';
}

/** Fecha y hora de Chile para un texto de auditoría, "31/10/2026 00:43" (nunca la ISO en UTC). */
function fechaHoraChile(d) {
  const partes = Object.fromEntries(new Intl.DateTimeFormat('es-CL', {
    timeZone: 'America/Santiago', day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(d)).map(p => [p.type, p.value]));
  return `${partes.day}/${partes.month}/${partes.year} ${partes.hour}:${partes.minute}`;
}

module.exports = { describirCambios, texto, fechaHoraChile };
