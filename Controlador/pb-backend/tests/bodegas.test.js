const { test, before, after, beforeEach, describe } = require('node:test');
const assert = require('node:assert/strict');
const { api, bajar } = require('./helpers/api');
const db = require('./helpers/db');

/**
 * B-29: eliminar bodegas (CU-138) y anaqueles (CU-141).
 *
 * Lo que protegen:
 *  - Una bodega que ya se usó (stock registrado aunque esté en 0, movimientos, conteos...) no se elimina:
 *    409 y nada cambia. Antes el DELETE chocaba con la FK y respondía 500.
 *  - Eliminar un anaquel con productos no mueve stock: las filas quedan en la bodega sin anaquel.
 *
 * Semilla: bodega 1 con stock y el anaquel 1; bodega 2 sin nada. MAT-FIFO con 30 físicas y 5 reservadas en la bodega 1.
 */

before(async () => { await db.resetear(); });
beforeEach(async () => { await db.resetear(); });
after(async () => { await bajar(); await db.cerrar(); });

const existe = async (tabla, where) => (await db.contar(tabla, where)) > 0;

describe('Eliminar bodega (CU-138)', () => {
  test('una bodega que nunca se usó se elimina con sus anaqueles', async () => {
    await db.query(`INSERT INTO inventario.anaquel (anaquel_descripcion, bodega_id_bodega) VALUES ('Estante B2', 2)`);
    const r = await api('DELETE', '/api/bodegas/2');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(await existe('inventario.bodega', 'bodega_id_bodega = 2'), false);
    assert.equal(await existe('inventario.anaquel', 'bodega_id_bodega = 2'), false);
    assert.equal((await api('DELETE', '/api/bodegas/2')).status, 404);
  });

  test('Exc 1: con stock físico → 400 sin borrar', async () => {
    const r = await api('DELETE', '/api/bodegas/1');
    assert.equal(r.status, 400);
    assert.ok(await existe('inventario.bodega', 'bodega_id_bodega = 1'));
  });

  test('Exc 2: sin stock pero con historial → 409 sin borrar (antes, 500)', async () => {
    // Una fila de stock que quedó en 0 y la salida que la vació
    await db.query(`INSERT INTO inventario.inventario_bodega (material_sku, lote_id_lote, bodega_id_bodega, inventario_bodega_cantidad_fisica)
                    VALUES ('MAT-UNO', 4, 2, 2)`);
    const s = await api('POST', '/api/movimientos/salida', { body: { sku: 'MAT-UNO', bodega_id: 2, cantidad: 2, tipo_movimiento_id: 2, motivo_id: 2 } });
    assert.equal(s.status, 201, JSON.stringify(s.body));
    await db.query(`INSERT INTO inventario.anaquel (anaquel_descripcion, bodega_id_bodega) VALUES ('Estante B2', 2)`);

    const r = await api('DELETE', '/api/bodegas/2');
    assert.equal(r.status, 409, JSON.stringify(r.body));
    assert.ok(r.body.historial.includes('movimiento_inventario'));
    assert.ok(await existe('inventario.bodega', 'bodega_id_bodega = 2'));
    assert.ok(await existe('inventario.anaquel', 'bodega_id_bodega = 2'), 'los anaqueles tampoco se borran');
  });

  test('Exc 2: un conteo basta para considerarla usada', async () => {
    await db.query(`INSERT INTO inventario.conteo_ciclico (conteo_ciclico_estado, bodega_id_bodega, usuario_id_usuario)
                    VALUES ('borrador', 2, 1)`);
    assert.equal((await api('DELETE', '/api/bodegas/2')).status, 409);
    assert.ok(await existe('inventario.bodega', 'bodega_id_bodega = 2'));
  });
});

describe('B-41: estado de la bodega solo activo / inactivo', () => {
  const estadoDe = async (id) =>
    (await db.query(`SELECT bodega_estado FROM inventario.bodega WHERE bodega_id_bodega = $1`, [id])).rows[0].bodega_estado;

  test('una bodega nueva queda "activo" (antes, "activa")', async () => {
    const r = await api('POST', '/api/bodegas', { body: { nombre: 'Bodega B41', codigo: 'B41' } });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(await estadoDe(r.body.id), 'activo');
  });

  test('desactivar guarda "inactivo" y reactivar vuelve a "activo"', async () => {
    let r = await api('PUT', '/api/bodegas/2', { body: { estado: 'inactivo' } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(await estadoDe(2), 'inactivo');
    r = await api('PUT', '/api/bodegas/2', { body: { estado: 'activo' } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(await estadoDe(2), 'activo');
  });

  test('otro valor de estado → 400 sin cambios, al crear y al editar', async () => {
    for (const estado of ['activa', 'inactiva', 'xyz']) {
      assert.equal((await api('PUT', '/api/bodegas/2', { body: { estado } })).status, 400, estado);
      assert.equal((await api('POST', '/api/bodegas', { body: { nombre: 'B41 ' + estado, codigo: 'X' + estado, estado } })).status, 400, estado);
    }
    assert.equal(await estadoDe(2), 'activo');
    assert.equal(await db.contar('inventario.bodega', `bodega_nombre_bodega LIKE 'B41 %'`), 0);
  });

  test('desactivar una bodega con stock sigue dando 400', async () => {
    const r = await api('PUT', '/api/bodegas/1', { body: { estado: 'inactivo' } });
    assert.equal(r.status, 400);
    assert.equal(await estadoDe(1), 'activo');
  });

  test('una bodega desactivada por la API rechaza movimientos', async () => {
    assert.equal((await api('PUT', '/api/bodegas/2', { body: { estado: 'inactivo' } })).status, 200);
    const t = await api('POST', '/api/movimientos/traslado', { body: { sku: 'MAT-FIFO', bodega_origen_id: 1, bodega_destino_id: 2, cantidad: 1 } });
    assert.equal(t.status, 400, JSON.stringify(t.body));
  });
});

describe('Eliminar anaquel (CU-141)', () => {
  test('Exc 2: con productos ubicados, quedan en la bodega sin anaquel y el stock no cambia (antes, 500)', async () => {
    await db.query(`UPDATE inventario.inventario_bodega SET anaquel_id_anaquel = 1 WHERE material_sku IN ('MAT-FIFO', 'MAT-UNO')`);
    const stock = { fifo: await db.stockDe('MAT-FIFO'), uno: await db.stockDe('MAT-UNO') };

    const r = await api('DELETE', '/api/bodegas/1/anaqueles/1');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.productos_sin_anaquel, 2);
    assert.equal(await existe('inventario.anaquel', 'anaquel_id_anaquel = 1'), false);
    assert.equal(await db.contar('inventario.inventario_bodega', 'anaquel_id_anaquel IS NOT NULL'), 0);
    assert.deepEqual({ fifo: await db.stockDe('MAT-FIFO'), uno: await db.stockDe('MAT-UNO') }, stock);
    assert.deepEqual(await db.descuadresDeReservas(), []);
  });

  test('Exc 1: un anaquel que no es de esa bodega → 404 sin borrar', async () => {
    assert.equal((await api('DELETE', '/api/bodegas/2/anaqueles/1')).status, 404);
    assert.equal((await api('DELETE', '/api/bodegas/1/anaqueles/999')).status, 404);
    assert.ok(await existe('inventario.anaquel', 'anaquel_id_anaquel = 1'));
  });
});
