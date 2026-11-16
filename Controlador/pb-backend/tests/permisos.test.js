const { test, before, after, beforeEach, describe } = require('node:test');
const assert = require('node:assert/strict');
const { api, bajar, levantar, token: tokenDe } = require('./helpers/api');
const db = require('./helpers/db');

/**
 * D62: toda ruta que escribe exige un rol, no solo sesión iniciada.
 * B-45 (D95): al módulo entran solo Gerencia y JOP.
 *
 * Lo que protegen:
 *  - Técnico, secretaria y administrador son roles de otros módulos: no escriben nada
 *    (403 y la BD queda igual) ni leen nada del módulo.
 *  - Siguen usando la integración: consultan stock (CU-106) y registran movimientos
 *    según la regla de CU-108 (CU-107).
 *  - Nadie que hoy trabaja pierde acceso: jop sigue registrando movimientos y bodegas.
 *  - Lo que la pantalla limita a gerencia (editar, activar/desactivar y eliminar proveedores,
 *    borrar bodegas y anaqueles) también lo limita el backend.
 *
 * Se agrega aquí toda ruta nueva que escriba.
 */

before(async () => { await db.resetear(); });
beforeEach(async () => { await db.resetear(); });
after(async () => { await bajar(); await db.cerrar(); });

/** Llama con un rol cualquiera (un usuario de la semilla por rol). */
async function comoRol(rol, metodo, ruta, body = {}) {
  const url = await levantar();
  const token = tokenDe(rol); // B-01: cada rol es un usuario de la semilla
  const opciones = { method: metodo, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } };
  if (metodo !== 'GET') opciones.body = JSON.stringify(body);
  const r = await fetch(url + ruta, opciones);
  return { status: r.status, body: await r.json().catch(() => null) };
}

// Las 28 rutas que escriben y antes solo pedían sesión, más las nuevas
const RUTAS = [
  ['POST', '/api/materiales'], ['PUT', '/api/materiales/MAT-FIFO'],
  ['POST', '/api/bodegas'], ['PUT', '/api/bodegas/1'], ['DELETE', '/api/bodegas/2'],
  ['POST', '/api/bodegas/1/anaqueles'], ['PUT', '/api/bodegas/1/anaqueles/1'], ['DELETE', '/api/bodegas/1/anaqueles/1'],
  ['POST', '/api/proveedores'], ['PUT', '/api/proveedores/1'], ['PUT', '/api/proveedores/1/estado'], ['DELETE', '/api/proveedores/1'],
  ['POST', '/api/movimientos/entrada'], ['POST', '/api/movimientos/salida'], ['POST', '/api/movimientos/traslado'],
  ['POST', '/api/movimientos/verificar-mermas-pendientes'],
  ['POST', '/api/ordenes-trabajo/1/consumos'], ['PUT', '/api/ordenes-trabajo/1/consumos/MAT-FIFO'],
  ['PUT', '/api/ordenes-trabajo/1/estimados'], ['PUT', '/api/ordenes-trabajo/1/consumo'],
  ['DELETE', '/api/ordenes-trabajo/1/materiales/MAT-FIFO'],
  ['PUT', '/api/herramientas/asignaciones/1/devolver'], ['POST', '/api/herramientas/MAT-FIFO/asignar'],
  ['PUT', '/api/herramientas/asignaciones/1/anular'],   // F-37 (solo gerencia)
  ['POST', '/api/usuarios/2/desbloquear-ingreso'],      // F-36 (solo gerencia)
  ['POST', '/api/herramientas/MAT-FIFO/mantenimiento'],
  ['POST', '/api/seguimiento-pinturas'], ['PUT', '/api/seguimiento-pinturas/1/devolver'],
  ['PUT', '/api/seguimiento-pinturas/1/anular'], ['PUT', '/api/seguimiento-pinturas/1'],
  // D51 (pedidos de instalación)
  ['PUT', '/api/pedidos-venta/1/devolucion/MAT-FIFO'], ['PUT', '/api/pedidos-venta/1/deshacer-preparado'],
  ['PUT', '/api/pedidos-venta/1/cancelar'],
  // D53 (ajuste por conteo) y D54 (corrección de una OT cerrada)
  ['POST', '/api/conteos/1/ajustes'], ['PUT', '/api/ordenes-trabajo/2/correccion'],
  // F-06: crear OT; F-28: anular OT
  ['POST', '/api/ordenes-trabajo'], ['PUT', '/api/ordenes-trabajo/1/anular'],
  // F-47: reabrir una OT cerrada (solo gerencia)
  ['PUT', '/api/ordenes-trabajo/2/reabrir'],
  // F-30: puertas de un proyecto (una OT por área)
  ['POST', '/api/ordenes-trabajo/puertas'],
  // B-03: responsable de una OT y reasignación en bloque (solo gerencia)
  ['PUT', '/api/ordenes-trabajo/1/responsable'], ['POST', '/api/usuarios/2/reasignar-ot'],
  // F-08: medidas de la puerta de la OT
  ['PUT', '/api/ordenes-trabajo/1/medidas'],
  // F-30 parte 2: especificación de la puerta
  ['PUT', '/api/ordenes-trabajo/1/especificacion'],
  // B-14: mantenedor de la clasificación (solo gerencia)
  ['POST', '/api/materiales/catalogos/clasificacion/general'], ['PUT', '/api/materiales/catalogos/clasificacion/general/1'],
  ['DELETE', '/api/materiales/catalogos/clasificacion/general/1?mover_a=2'],
  // F-29: crear proyectos en terreno (solo gerencia)
  ['POST', '/api/ordenes-trabajo/proyectos'],
  // F-04: mantenedor de áreas, unidades y motivos (solo gerencia)
  ['POST', '/api/catalogos/areas'], ['PUT', '/api/catalogos/areas/1'],
  ['POST', '/api/catalogos/unidades'], ['PUT', '/api/catalogos/unidades/2'], ['DELETE', '/api/catalogos/unidades/2'],
  ['POST', '/api/catalogos/motivos'], ['PUT', '/api/catalogos/motivos/3'], ['DELETE', '/api/catalogos/motivos/3'],
  ['POST', '/api/catalogos/motivos/restaurar'],
  // F-23b: alta rápida de un material de caja chica
  ['POST', '/api/materiales/alta-rapida'],
  // F-38: ajuste de stock (solo gerencia)
  ['POST', '/api/movimientos/ajuste'],
  // B-45: las 8 que solo pedían sesión (hallazgo del 04/11)
  ['POST', '/api/facturas'], ['POST', '/api/alertas/generar'], ['PUT', '/api/alertas/1/resolver'],
  ['POST', '/api/alertas-faltantes/generar'], ['PUT', '/api/alertas-faltantes/1/solicitud'],
  ['PUT', '/api/alertas-faltantes/1/resolver'], ['POST', '/api/pedidos/1/reservar'], ['POST', '/api/pedidos/1/discrepancia'],
];

// B-45: cada router del módulo (la barrera va antes de la ruta, así que basta el prefijo)
const LECTURAS = [
  '/api/materiales', '/api/herramientas', '/api/seguimiento-pinturas', '/api/recetas', '/api/bodegas',
  '/api/movimientos/historial', '/api/proveedores', '/api/reportes/resumen', '/api/usuarios', '/api/pedidos',
  '/api/alertas', '/api/auditoria', '/api/facturas', '/api/notificaciones', '/api/reservas',
  '/api/alertas-faltantes', '/api/ordenes-trabajo', '/api/codigos', '/api/conteos', '/api/pedidos-venta',
  '/api/catalogos/areas', '/api/integracion/reglas',
];
const OTROS_ROLES = ['tecnico', 'secretaria', 'administrador'];

/** Una foto de las tablas que estas rutas tocan. */
async function foto() {
  const tablas = ['inventario.material', 'inventario.bodega', 'inventario.anaquel', 'inventario.proveedor', 'inventario.orden_trabajo',
                  'inventario.movimiento_inventario', 'inventario.inventario_bodega', 'inventario.seguimiento_pintura',
                  'inventario.material_categoria_general', 'terreno.proyecto', 'terreno.cliente',
                  'inventario.area_trabajo', 'inventario.material_unidad_medida', 'inventario.movimiento_inventario_motivo_movimiento'];
  const r = {};
  for (const t of tablas) r[t] = await db.contar(t);
  r.stock = await db.stockDe('MAT-FIFO');
  const { rows } = await db.query(`SELECT proveedor_estado AS e FROM inventario.proveedor ORDER BY proveedor_id_proveedor`);
  r.proveedores = rows.map(x => x.e);
  // F-28 y B-03: anular o reasignar cambian el estado o el responsable, no la cantidad de filas
  const { rows: ots } = await db.query(
    `SELECT orden_trabajo_estado AS e, usuario_id_usuario AS u, orden_trabajo_medidas::text AS m
     FROM inventario.orden_trabajo ORDER BY orden_trabajo_id_orden`);
  r.estadosOT = ots.map(x => `${x.e}:${x.u}:${x.m}`);
  return r;
}

describe('B-45: los roles de otros módulos no entran a Inventario', () => {
  for (const rol of OTROS_ROLES) {
    test(`${rol}: 403 en todas las rutas que escriben y la BD queda igual`, async () => {
      const antes = await foto();
      for (const [metodo, ruta] of RUTAS) {
        const r = await comoRol(rol, metodo, ruta, { sku: 'MAT-FIFO', bodega_id: 1, cantidad: 1, nombre: 'X' });
        assert.equal(r.status, 403, `${metodo} ${ruta} → ${r.status}`);
      }
      assert.deepEqual(await foto(), antes);
    });

    test(`${rol}: 403 al leer cualquier parte del módulo`, async () => {
      for (const ruta of LECTURAS) {
        const r = await comoRol(rol, 'GET', ruta);
        assert.equal(r.status, 403, `GET ${ruta} → ${r.status}`);
      }
      assert.equal((await comoRol(rol, 'GET', '/api/materiales')).body.codigo, 'SIN_ACCESO_INVENTARIO');
    });
  }

  test('gerencia y jop sí entran', async () => {
    for (const rol of ['gerencia', 'jop']) {
      for (const ruta of ['/api/materiales', '/api/bodegas', '/api/notificaciones']) {
        assert.equal((await comoRol(rol, 'GET', ruta)).status, 200, `${rol} GET ${ruta}`);
      }
    }
  });

  test('siguen con su sesión y con la consulta de stock de CU-106', async () => {
    for (const rol of OTROS_ROLES) {
      assert.equal((await comoRol(rol, 'GET', '/api/auth/me')).status, 200, `${rol} /auth/me`);
      assert.equal((await comoRol(rol, 'GET', '/api/integracion/stock?sku=MAT-FIFO')).status, 200, `${rol} CU-106`);
    }
  });

  test('CU-107: registran movimientos desde su módulo si la regla de CU-108 lo permite', async () => {
    const envio = { modulo: 'terreno', tipo: 'salida', sku: 'MAT-FIFO', cantidad: 1, bodega_id: 1, referencia: 'OBRA-B45' };
    // sin regla: lo rechaza la regla, no la barrera del módulo
    let r = await comoRol('tecnico', 'POST', '/api/integracion/movimientos', { ...envio, clave_envio: 'b45-1' });
    assert.equal(r.status, 403);
    assert.equal(r.body.codigo, 'SIN_PERMISO');
    // con regla para el perfil 'tecnico' (como la configuraría Gerencia)
    await db.query(`INSERT INTO inventario.perfil (perfil_id_perfil, perfil_nombre_perfil)
                    OVERRIDING SYSTEM VALUE VALUES (4, 'tecnico')`);
    const regla = await api('POST', '/api/integracion/reglas', { body: { modulo: 'terreno', perfil_id: 4, tipos: ['salida'] } });
    assert.equal(regla.status, 200, JSON.stringify(regla.body));
    r = await comoRol('tecnico', 'POST', '/api/integracion/movimientos', { ...envio, clave_envio: 'b45-2' });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.deepEqual(await db.stockDe('MAT-FIFO'), { fisica: 29, reservada: 5 });
  });
});

describe('Lo que cada rol conserva', () => {
  test('jop sigue registrando movimientos', async () => {
    const r = await api('POST', '/api/movimientos/salida', {
      rol: 'jop', body: { sku: 'MAT-FIFO', bodega_id: 1, cantidad: 1, tipo_movimiento_id: 2, motivo_id: 2 },
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));
  });

  test('editar, activar/desactivar y eliminar proveedores: solo gerencia (como la pantalla)', async () => {
    for (const [metodo, ruta] of [['PUT', '/api/proveedores/1'], ['PUT', '/api/proveedores/1/estado'], ['DELETE', '/api/proveedores/1']]) {
      assert.equal((await comoRol('jop', metodo, ruta)).status, 403, `jop ${metodo} ${ruta}`);
    }
    const r = await api('PUT', '/api/proveedores/1/estado', { body: { estado: 'inactivo' } });
    assert.notEqual(r.status, 403, 'gerencia sí');
  });

  test('D51 y D54: deshacer o cancelar un pedido y corregir una OT cerrada, solo gerencia', async () => {
    for (const ruta of ['/api/pedidos-venta/1/deshacer-preparado', '/api/pedidos-venta/1/cancelar', '/api/ordenes-trabajo/2/correccion']) {
      assert.equal((await comoRol('jop', 'PUT', ruta, { motivo: 'x' })).status, 403, `jop PUT ${ruta}`);
    }
  });

  test('borrar bodegas y anaqueles: solo gerencia (D95), no jop', async () => {
    assert.equal((await comoRol('jop', 'DELETE', '/api/bodegas/2')).status, 403);
    assert.equal((await comoRol('jop', 'DELETE', '/api/bodegas/1/anaqueles/1')).status, 403);
    // F-11: el rol pasa y pide la firma de un gerente (eliminar_maestro); api() firma y repite
    const r = await api('DELETE', '/api/bodegas/2', { rol: 'gerencia' });   // la bodega 2 está vacía
    assert.equal(r.status, 200, JSON.stringify(r.body));
  });
});
