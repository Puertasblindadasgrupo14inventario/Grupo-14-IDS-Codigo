const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { api, bajar } = require('./helpers/api');
const db = require('./helpers/db');

/**
 * F-37 (DDL-11): anular una asignación de herramienta hecha por error.
 *
 * Lo que protegen:
 *  - La asignación queda 'anulada' (no se borra), con fecha y motivo, y la unidad vuelve a estar libre.
 *  - No mueve stock.
 *  - Solo gerencia (con firma, ver firmas.test.js), con motivo y sobre una asignación vigente.
 *  - La lista la cuenta como anulada, no como vigente ni como devuelta.
 *
 * Semilla: MAT-HERR (herramienta), 3 unidades en la bodega 1. Empleado 22222222-2.
 */

before(async () => { await db.resetear(); });
beforeEach(async () => { await db.resetear(); });
after(async () => { await bajar(); await db.cerrar(); });

const asignar = (cantidad) => api('POST', '/api/herramientas/MAT-HERR/asignar', { body: { empleado_rut: '22222222-2', cantidad } });
const anular = (id, body, rol) => api('PUT', `/api/herramientas/asignaciones/${id}/anular`, { body, rol });
const asignacion = async (id) => (await db.query(
  `SELECT estado, fecha_devolucion IS NOT NULL AS cerrada, observacion
   FROM inventario.asignacion_herramienta WHERE asignacion_id = $1`, [id])).rows[0];

test('anular deja la asignación anulada con su motivo, libera la unidad y no mueve stock', async () => {
  const a = await asignar(3);
  assert.equal(a.status, 201, JSON.stringify(a.body));
  assert.equal((await asignar(1)).status, 400);                          // las 3 están entregadas
  const movs = await db.contar('inventario.movimiento_inventario');

  const r = await anular(a.body.asignacion.id, { motivo: 'Trabajador equivocado' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const fila = await asignacion(a.body.asignacion.id);
  assert.equal(fila.estado, 'anulada');
  assert.equal(fila.cerrada, true);
  assert.match(fila.observacion, /Anulada: Trabajador equivocado/);
  assert.deepEqual(await db.stockDe('MAT-HERR'), { fisica: 3, reservada: 0 });
  assert.equal(await db.contar('inventario.movimiento_inventario'), movs);
  assert.equal((await asignar(3)).status, 201);                          // vuelven a estar libres
});

test('sin motivo → 400, y una asignación ya cerrada no se anula', async () => {
  const { body } = await asignar(1);
  const id = body.asignacion.id;
  assert.equal((await anular(id, { motivo: '  ' })).status, 400);
  assert.equal((await asignacion(id)).estado, 'asignada');

  assert.equal((await api('PUT', `/api/herramientas/asignaciones/${id}/devolver`, { body: {} })).status, 200);
  assert.equal((await anular(id, { motivo: 'Por error' })).status, 400);
  assert.equal((await asignacion(id)).estado, 'devuelta');
  assert.equal((await anular(999999, { motivo: 'Por error' })).status, 404);
});

test('jop no anula (403) y la asignación sigue vigente', async () => {
  const { body } = await asignar(1);
  const r = await anular(body.asignacion.id, { motivo: 'Por error' }, 'jop');
  assert.equal(r.status, 403);
  assert.equal((await asignacion(body.asignacion.id)).estado, 'asignada');
});

test('la lista la muestra como anulada: no cuenta como vigente ni como devuelta', async () => {
  const { body } = await asignar(2);
  await anular(body.asignacion.id, { motivo: 'Por error' });
  const r = await api('GET', '/api/herramientas/asignaciones?estado=todos&empleado_rut=22222222-2');
  assert.equal(r.status, 200);
  assert.equal(r.body.resumen.vigentes, 0);
  assert.deepEqual(r.body.resumen.por_estado.anulada, { asignaciones: 1, unidades: 2 });
  assert.equal(r.body.resumen.por_estado.devuelta.asignaciones, 0);
});
