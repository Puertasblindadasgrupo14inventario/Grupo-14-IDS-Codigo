const { test, before, after, beforeEach, describe } = require('node:test');
const assert = require('node:assert/strict');
const { api, bajar } = require('./helpers/api');
const db = require('./helpers/db');
const { compra } = require('./helpers/compra');

/**
 * F-31: filtros del reporte de movimientos (GET /api/reportes/movimientos).
 *
 * Lo que protegen:
 *  - Con OT, proyecto o n° de factura las fechas son opcionales; con proveedor (o sin filtros) no.
 *  - Cada filtro trae solo lo suyo: proyecto = sus OT; proveedor = los lotes que trajo; factura = la
 *    entrada que trajo el lote (misma regla del historial, CU-31).
 *  - El precio de compra (neto) va en la entrada y solo a gerencia (montos-jop.test.js recorre la ruta).
 *
 * Semilla: OT 1 abierta del proyecto 1 (con MAT-FIFO y MAT-CRIT en su consumo); proveedores 1 y 2.
 */

before(async () => { await db.resetear(); });
beforeEach(async () => {
  await db.resetear();
  const a = await api('POST', '/api/movimientos/entrada', {
    body: { sku: 'MAT-FIFO', bodega_id: 1, cantidad: 5, tipo_movimiento_id: 1, ...compra({ precio_unitario: 1200, factura_numero: 'F31-A' }) } });
  assert.equal(a.status, 201, JSON.stringify(a.body));
  const b = await api('POST', '/api/movimientos/entrada', {
    body: { sku: 'MAT-UNO', bodega_id: 1, cantidad: 2, tipo_movimiento_id: 1, ...compra({ proveedor_id: 2, precio_unitario: 800, factura_numero: 'F31-B' }) } });
  assert.equal(b.status, 201, JSON.stringify(b.body));
  const c = await api('PUT', '/api/ordenes-trabajo/1/consumo', {
    body: { lineas: [{ sku: 'MAT-FIFO', estimado: 12, real: 0 }, { sku: 'MAT-CRIT', estimado: 4, real: 1 }] } });
  assert.equal(c.status, 200, JSON.stringify(c.body));
});
after(async () => { await bajar(); await db.cerrar(); });

const reporte = (qs, rol) => api('GET', '/api/reportes/movimientos?' + qs, { rol });
const RANGO = 'desde=2020-01-01&hasta=2099-12-31';

describe('Fechas opcionales (F-31)', () => {
  test('con una OT no hacen falta: trae solo los movimientos de esa OT', async () => {
    const r = await reporte('orden_trabajo_id=1');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.ok(r.body.movimientos.length > 0);
    assert.ok(r.body.movimientos.every(m => String(m.orden_trabajo_id) === '1'));
  });

  test('sin filtros, o solo con proveedor, siguen siendo obligatorias', async () => {
    assert.equal((await reporte('')).status, 400);
    const r = await reporte('proveedor_id=2');
    assert.equal(r.status, 400);
    assert.match(r.body.error, /proveedor/i);
    assert.equal((await reporte('proyecto_id=abc')).status, 400);
  });
});

describe('Filtros (F-31)', () => {
  test('proyecto: los movimientos de sus OT, sin fechas', async () => {
    const r = await reporte('proyecto_id=1');
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.movimientos.map(m => m.sku), ['MAT-CRIT']);
    assert.equal(r.body.movimientos[0].proyecto_codigo, 'PRY-TEST');
    assert.deepEqual((await reporte('proyecto_id=999')).body.movimientos, []);
  });

  test('factura (sin mayúsculas): la entrada que trajo el lote, con su precio de compra neto', async () => {
    const r = await reporte('factura=f31-a');
    assert.equal(r.status, 200);
    assert.equal(r.body.movimientos.length, 1);
    const [m] = r.body.movimientos;
    assert.deepEqual([m.sku, m.factura_numero, parseFloat(m.precio_compra)], ['MAT-FIFO', 'F31-A', 1200]);
    assert.ok(m.proveedor);
  });

  test('proveedor: los movimientos de los lotes que trajo, dentro del rango', async () => {
    const r = await reporte(`proveedor_id=2&${RANGO}`);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.movimientos.map(m => [m.sku, m.factura_numero]), [['MAT-UNO', 'F31-B']]);
  });

  test('un consumo de OT no hereda la factura ni el precio de compra del lote', async () => {
    const [m] = (await reporte('orden_trabajo_id=1')).body.movimientos;
    assert.equal(m.factura_numero, null);
    assert.equal(m.precio_compra, null);
  });

  test('jop no recibe el precio de compra ni el referencial', async () => {
    const r = await reporte('factura=F31-A', 'jop');
    assert.equal(r.status, 200);
    assert.equal(r.body.movimientos[0].factura_numero, 'F31-A');
    assert.ok(!('precio_compra' in r.body.movimientos[0]) && !('precio_unitario' in r.body.movimientos[0]));
  });
});
