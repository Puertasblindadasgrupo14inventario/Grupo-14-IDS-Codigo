/**
 * F-42: la auditoría en lenguaje natural.
 *
 * Cada acción que el código registra (auditoriaController.registrar) tiene aquí lo que hizo
 * quien la registró, en pasado y en minúscula: "<quién> <etiqueta>: <detalle guardado>".
 * El texto guardado no cambia (los registros son inmutables); la frase se arma al leer, así
 * que sirve también para los eventos antiguos. tests/auditoria-frases.test.js recorre src/ y
 * falla si una acción nueva no tiene etiqueta.
 *
 * Los movimientos de stock no pasan por aquí con su texto: vienen de movimiento_inventario
 * con sus datos (producto, cantidad, bodega, OT, motivo) y fraseMovimiento() arma la oración.
 */
const ETIQUETAS = {
  // Sesión y cuentas
  login: 'inició sesión',
  login_fallido: 'intentó iniciar sesión sin éxito',
  bloqueo_login: 'quedó con el ingreso bloqueado por intentos fallidos',
  bloqueo_reautenticacion: 'quedó bloqueado al confirmar con su contraseña',
  desbloquear_ingreso: 'desbloqueó el ingreso de un usuario',
  cambiar_password: 'cambió su contraseña',
  resetear_password: 'restableció su contraseña',            // con el enlace de recuperación
  recuperar_password: 'dejó una contraseña temporal a un usuario',   // gerencia, desde Usuarios
  solicitar_recuperacion: 'pidió recuperar una contraseña',
  firma_gerencia: 'autorizó una operación con su firma de gerencia',
  crear_usuario: 'creó un usuario',
  editar_permisos: 'cambió el rol o los datos de un usuario',
  programar_activacion: 'programó la activación de un usuario',
  programar_desactivacion: 'programó la desactivación de un usuario',
  cancelar_programacion: 'canceló una activación o desactivación programada',
  programacion_ejecutada: 'aplicó una activación o desactivación programada',
  exportar_datos_persona: 'exportó los datos de una persona para una solicitud de acceso',   // F-46, desde el servidor
  marcar_todas_leidas: 'marcó todas sus notificaciones como leídas',

  // Productos y códigos
  'Crear material': 'creó un producto',
  'Editar material': 'editó un producto',
  'Duplicar material': 'duplicó un producto',
  'Desactivar material': 'desactivó un producto',
  'Reactivar material': 'reactivó un producto',
  'Eliminar material': 'eliminó un producto',
  'Generar código de barras': 'generó el código de barras de un producto',
  'Vincular proveedor': 'vinculó un proveedor a un producto',
  'Actualizar proveedor': 'actualizó el proveedor de un producto',

  // Catálogos
  crear_area: 'creó un área de trabajo',
  editar_area: 'editó un área de trabajo',
  crear_unidad: 'creó una unidad de medida',
  editar_unidad: 'editó una unidad de medida',
  eliminar_unidad: 'eliminó una unidad de medida',
  crear_motivo: 'creó un motivo de movimiento',
  editar_motivo: 'editó un motivo de movimiento',
  eliminar_motivo: 'eliminó un motivo de movimiento',
  eliminar_motivo_sistema: 'eliminó un motivo de movimiento del sistema',
  restaurar_motivo: 'restauró un motivo de movimiento del sistema',
  crear_clasificacion: 'creó una categoría de productos',
  editar_clasificacion: 'editó una categoría de productos',
  eliminar_clasificacion: 'eliminó una categoría de productos',
  fusionar_clasificacion: 'juntó dos categorías de productos',
  'Tolerancias de conteo': 'cambió las tolerancias del conteo',

  // Bodegas
  'Crear bodega': 'creó una bodega',
  'Editar bodega': 'editó una bodega',
  'Eliminar bodega': 'eliminó una bodega',
  'Crear anaquel': 'creó un anaquel',
  'Editar anaquel': 'editó un anaquel',
  'Eliminar anaquel': 'eliminó un anaquel',

  // Proveedores y compras
  crear_proveedor: 'creó un proveedor',
  editar_proveedor: 'editó un proveedor',
  activar_proveedor: 'reactivó un proveedor',
  desactivar_proveedor: 'desactivó un proveedor',
  eliminar_proveedor: 'eliminó un proveedor',
  crear_factura: 'registró una factura de compra',
  emitir_solicitud_compra: 'emitió una solicitud de compra',
  evaluar_reposicion: 'revisó la reposición de un producto',

  // Movimientos (los eventos registrar_entrada, _salida y _traslado repiten un movimiento:
  // la lista los oculta salvo que se filtre por ellos, ver usuariosController.auditoria)
  registrar_movimiento: 'registró un movimiento de stock',   // filas de movimiento_inventario
  registrar_entrada: 'registró una entrada',
  registrar_salida: 'registró una salida',
  registrar_traslado: 'registró un traslado entre bodegas',
  registrar_movimiento_externo: 'recibió un movimiento desde otro módulo',
  revertir_movimiento: 'revirtió un movimiento',
  aprobar_merma: 'aprobó una merma',
  rechazar_merma: 'rechazó una merma',
  'Ajuste de stock': 'ajustó el stock de un producto',
  'Integración entre módulos': 'cambió las reglas de integración entre módulos',
  'Backfill vínculo OT-movimientos': 'vinculó movimientos antiguos con sus OT',
  'Exportar reporte': 'exportó un reporte',
  exportar_reporte: 'exportó un reporte',
  exportar_reporte_masivo: 'exportó un reporte grande',

  // Conteo cíclico
  'Conteo cíclico': 'registró un conteo cíclico',
  'Diferencias de conteo': 'registró diferencias de un conteo',
  'Ajuste por conteo': 'ajustó el stock por un conteo',
  'Alertas por diferencia': 'generó alertas por diferencias de conteo',
  procesar_diferenciales: 'procesó las diferencias de un conteo',
  reportar_discrepancia: 'reportó una discrepancia de stock',

  // Órdenes de trabajo y proyectos
  crear_orden_trabajo: 'creó una OT',
  crear_puerta_ot: 'creó puertas con sus OT',
  crear_proyecto: 'creó un proyecto',
  medidas_ot: 'guardó las medidas de una puerta',
  especificacion_ot: 'guardó la especificación de una puerta',
  anular_ot: 'anuló una OT',
  reabrir_ot: 'reabrió una OT',
  finalizar_ot: 'finalizó una OT',
  cambiar_responsable_ot: 'cambió el responsable de una OT',
  reasignar_ot: 'reasignó las OT de un usuario',
  'Asignar empleado tentativo': 'cambió el empleado tentativo de una OT',
  cargar_receta_en_ot: 'cargó una receta en una OT',
  'Registrar estimados OT': 'registró los estimados de una OT',
  'Registrar consumo OT': 'registró el consumo de una OT',
  'Guardar consumo OT': 'guardó el consumo de una OT',
  'Editar consumo OT': 'editó el consumo de una OT',
  'Eliminar material de OT': 'quitó un material de una OT',
  'Corrección OT cerrada': 'corrigió el consumo de una OT cerrada',
  reservar_materiales: 'reservó materiales para una OT',

  // Recetas
  crear_receta: 'creó una receta',
  editar_receta: 'editó una receta',
  duplicar_receta: 'duplicó una receta',
  desactivar_receta: 'desactivó una receta',
  reactivar_receta: 'reactivó una receta',

  // Reservas, alertas y faltantes
  'Reservar stock para venta': 'reservó stock para una venta',
  anular_reserva: 'anuló una reserva',
  liberar_reserva: 'liberó una reserva',
  generar_alertas: 'generó alertas de stock',
  resolver_alerta: 'resolvió una alerta de stock',
  'Generar alertas faltantes': 'generó alertas de faltantes',
  actualizar_faltante: 'actualizó una alerta de faltante',
  auto_resolver_faltante: 'dio por resuelta una alerta de faltante (ya hay stock)',
  resolver_alerta_faltante: 'resolvió una alerta de faltante',
  alerta_insumo_especial: 'creó una alerta de insumo especial',
  descartar_alerta_insumo_especial: 'descartó una alerta de insumo especial (venta cancelada)',
  vincular_insumo_especial: 'vinculó un insumo especial a una venta',
  reemplazar_insumo_especial: 'reemplazó un insumo especial',

  // Pedidos de instalación
  'Vincular insumos a pedido': 'vinculó insumos a un pedido de instalación',
  'Inicio de carga': 'empezó la carga de un pedido',
  'Responsable de carga sumado': 'se sumó a la carga de un pedido',
  'Retiro de insumo (picking)': 'retiró un insumo para un pedido',
  'Devolución a bodega (picking)': 'devolvió a bodega un insumo de un pedido',
  'Ubicación incorrecta (picking)': 'avisó una ubicación incorrecta al preparar un pedido',
  'Pedido preparado para despacho': 'dejó un pedido listo para despacho',
  'Salida de pedido de instalación': 'despachó un pedido de instalación',
  'Pedido cancelado': 'canceló un pedido de instalación',
  'Pedido vuelto a vinculado': 'devolvió un pedido al estado vinculado',

  // Herramientas
  'Asignar herramienta': 'asignó una herramienta',
  'Cerrar asignación de herramienta': 'cerró la asignación de una herramienta',
  'Anular asignación de herramienta': 'anuló la asignación de una herramienta',
  'Actualizar herramienta': 'actualizó una herramienta',
  'Configurar depreciación de herramienta': 'configuró la depreciación de una herramienta',
  'Registrar mantenimiento de herramienta': 'registró una mantención de herramienta',

  // Pinturas
  'Registrar uso de pintura': 'registró el uso de una pintura',
  'Corregir seguimiento de pintura': 'corrigió un registro de pintura',
  'Anular seguimiento de pintura': 'anuló un registro de pintura',
  'Devolver envase de pintura': 'devolvió un envase de pintura',
};

/** Lo que hizo, o un respaldo legible para una acción sin etiqueta. */
function etiqueta(accion) {
  if (accion == null || accion === '') return 'realizó una acción';
  return ETIQUETAS[accion] ?? `realizó la acción «${accion}»`;
}

/** Primer nombre + primer apellido si los tiene; si no, el usuario. */
function nombreVisible({ nombre, apellido, usuario }) {
  const completo = [nombre, apellido].filter(s => s && String(s).trim()).join(' ').trim();
  return completo || usuario || 'Alguien';
}

const cantidadTexto = (n) => Number(n).toLocaleString('es-CL', { maximumFractionDigits: 3 });
// Los motivos se guardan como claves del catálogo (consumo_produccion): se muestran sin guiones bajos
const motivoTexto = (m) => String(m).replace(/_/g, ' ');

/**
 * La oración de un movimiento de stock. m: { tipo, cantidad, unidad, sku, material, bodega,
 * ot, motivo, estado, id_revertido, modulo }. Sin punto final en lo que falte.
 */
function fraseMovimiento(quien, m) {
  const tipo = String(m.tipo || '').toLowerCase();
  const esEntrada = tipo.includes('entrada');
  const verbo = m.id_revertido ? `revirtió el movimiento #${m.id_revertido} con una` : 'registró una';
  const producto = m.material ? `${m.material} (${m.sku})` : m.sku;
  let s = `${quien} ${verbo} ${esEntrada ? 'entrada' : 'salida'} de ${cantidadTexto(m.cantidad)}`
    + (m.unidad ? ` ${m.unidad}` : '') + ` de ${producto}`;
  if (m.bodega) s += esEntrada ? ` en ${m.bodega}` : ` desde ${m.bodega}`;
  if (m.ot) s += ` para la OT #${m.ot}`;
  if (m.modulo && m.modulo !== 'inventario') s += `, enviada por ${m.modulo === 'terreno' ? 'Terreno' : 'Finanzas'}`;
  s += '.';
  if (m.motivo) s += ` Motivo: ${motivoTexto(m.motivo)}.`;
  if (m.estado === 'revertido') s += ' Después fue revertido.';
  else if (m.estado === 'pendiente_aprobacion') s += ' Pendiente de aprobación.';
  return s;
}

// El detalle solo repite la frase ("Inicio de sesión: gerente.prueba"): queda en el detalle técnico
const SIN_DETALLE_EN_FRASE = new Set(['login']);
// Sin usuario conocido (id 0): la frase va sin sujeto, no "El sistema intentó iniciar sesión"
const SIN_SUJETO = {
  login_fallido: 'Intento fallido de iniciar sesión',
  bloqueo_login: 'Ingreso bloqueado por intentos fallidos',
};

/** La oración de un evento con texto guardado: "<quién> <etiqueta>: <detalle>". */
function fraseEvento(quien, accion, detalle, { sistema = false } = {}) {
  const d = detalle == null || SIN_DETALLE_EN_FRASE.has(accion) ? '' : String(detalle).trim();
  const inicio = sistema && SIN_SUJETO[accion] ? SIN_SUJETO[accion] : `${quien} ${etiqueta(accion)}`;
  return `${inicio}${d ? `: ${d}` : '.'}`;
}

module.exports = { ETIQUETAS, etiqueta, nombreVisible, fraseMovimiento, fraseEvento };
