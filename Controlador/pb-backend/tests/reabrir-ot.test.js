const { test, before, after, beforeEach, describe } = require('node:test');
const assert = require('node:assert/strict');
const { api, bajar } = require('./helpers/api');
const db = require('./helpers/db');

/**
 * Reabrir una OT cerrada (F-47).
 *
 * Lo que se protege: solo gerencia, con firma y motivo; solo una OT finalizada (las canceladas no); reabrir no
 * mueve stock ni reservas y la OT vuelve a admitir consumo (que mueve solo la diferencia); sus desviaciones
 * (CU-103) se borran y se recalculan al volver a finalizar; un rechazo no cambia nada.
 *
 * Semilla: OT 1 abierta con la reserva 1; OT 2 finalizada sin materiales; OT 3 abierta.
 */

before(async () => { await db.resetear(); });
beforeEach(async () => { await db.resetear(); });
after(async () => { await bajar(); await db.cerrar(); });

const reabrir = (id, motivo = 'Corregir las medidas', opciones = {}) =>
  api('PUT', `/api/ordenes-trabajo/${id}/reabrir`, { body: motivo == null ? {} : { motivo }, ...opciones });
const estadoOT = async (id) => (await db.query(
  `SELECT orden_trabajo_estado AS e FROM inventario.orden_trabajo WHERE orden_trabajo_id_orden = $1`, [id])).rows[0]?.e;
const consumo = (ot, lineas) => api('PUT', `/api/ordenes-trabajo/${ot}/consumo`, { body: { lineas } });
const desviaciones = (ot) => db.contar('inventario.diferencial_consumo', `orden_trabajo_id_orden = ${Number(ot)}`);

describe('reabrir', () => {
  test('una OT finalizada vuelve a en curso, sin mover stock, y admite consumo de nuevo', async () => {
    const stock = await db.stockDe('MAT-CRIT');
    assert.equal((await consumo(2, [{ sku: 'MAT-CRIT', estimado: null, real: 1 }])).status, 400, 'cerrada: no admite consumo');

    const r = await reabrir(2);

    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(await estadoOT(2), 'en_curso');
    assert.deepEqual(await db.stockDe('MAT-CRIT'), stock, 'reabrir no mueve stock');
    assert.equal(await db.contar('finanzas.evento_auditoria', `accion_realizada = 'reabrir_ot'`), 1);

    const c = await consumo(2, [{ sku: 'MAT-CRIT', estimado: null, real: 2 }]);
    assert.equal(c.status, 200, JSON.stringify(c.body));
    assert.equal((await db.stockDe('MAT-CRIT')).fisica, stock.fisica - 2);
    assert.deepEqual(await db.descuadresDeReservas(), []);
  });

  test('sus desviaciones se borran al reabrir y se recalculan al finalizar y procesar de nuevo', async () => {
    assert.equal((await consumo(3, [{ sku: 'MAT-CRIT', estimado: 4, real: 3 }])).status, 200);
    assert.equal((await api('PUT', '/api/ordenes-trabajo/3/finalizar')).status, 200);
    assert.equal((await api('POST', '/api/ordenes-trabajo/3/diferenciales')).status, 200);
    assert.equal(await desviaciones(3), 1);

    const r = await reabrir(3);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.desviaciones_borradas, 1);
    assert.equal(await desviaciones(3), 0);

    assert.equal((await api('PUT', '/api/ordenes-trabajo/3/finalizar')).status, 200);
    assert.equal((await api('POST', '/api/ordenes-trabajo/3/diferenciales')).status, 200);
    assert.equal(await desviaciones(3), 1);
  });

  test('en una puerta solo se reabre esta OT y el mensaje nombra las demás que siguen cerradas', async () => {
    await db.query(`UPDATE inventario.orden_trabajo SET orden_trabajo_medidas = '{"puerta": 77}'::jsonb,
                    orden_trabajo_estado = 'finalizada' WHERE orden_trabajo_id_orden IN (2, 3)`);

    const r = await reabrir(2);

    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.misma_puerta_cerradas, [3]);
    assert.match(r.body.message, /#3/);
    assert.equal(await estadoOT(3), 'finalizada');
  });
});

describe('rechazos: nada cambia', () => {
  test('sin motivo → 400', async () => {
    assert.equal((await reabrir(2, null)).status, 400);
    assert.equal((await reabrir(2, '   ')).status, 400);
    assert.equal(await estadoOT(2), 'finalizada');
  });

  test('jop → 403 (solo gerencia)', async () => {
    assert.equal((await reabrir(2, 'Corregir', { rol: 'jop' })).status, 403);
    assert.equal(await estadoOT(2), 'finalizada');
  });

  test('una OT cancelada no se reabre; una abierta tampoco; una inexistente → 404', async () => {
    await db.query(`UPDATE inventario.orden_trabajo SET orden_trabajo_estado = 'cancelada' WHERE orden_trabajo_id_orden = 2`);
    assert.equal((await reabrir(2)).status, 400);
    assert.equal(await estadoOT(2), 'cancelada');

    assert.equal((await reabrir(1)).status, 400);
    assert.equal(await estadoOT(1), 'en_curso');

    assert.equal((await reabrir(999)).status, 404);
    assert.equal(await db.contar('finanzas.evento_auditoria', `accion_realizada = 'reabrir_ot'`), 0);
  });

  test('las desviaciones no se borran si se rechaza', async () => {
    await consumo(3, [{ sku: 'MAT-CRIT', estimado: 4, real: 3 }]);
    await api('PUT', '/api/ordenes-trabajo/3/finalizar');
    await api('POST', '/api/ordenes-trabajo/3/diferenciales');
    assert.equal((await reabrir(3, null)).status, 400);
    assert.equal(await desviaciones(3), 1);
  });
});
