const { test, before, after, beforeEach, describe } = require('node:test');
const assert = require('node:assert/strict');
const { api, bajar } = require('./helpers/api');
const db = require('./helpers/db');

/**
 * F-18 (fase 2): gráfico de consumo en el tiempo (GET /api/reportes/consumo-area/grafico?agrupar=mes).
 *
 * Lo que protegen:
 * - agrupar por semana o por día reparte el mismo consumo que el mes (el detalle cuadra con el total);
 * - en unidades no se suman unidades distintas: hay que elegir producto o categoría, y una categoría con
 *   consumos en distintas unidades se rechaza;
 * - jop y técnico siempre reciben unidades, aunque pidan CLP (D50).
 *
 * Consumos de la prueba (junio de 2026), en el área 1:
 *   OT 1 (lun 01/06): MAT-FIFO 12 unidad (cat. 1, $1.000) y MAT-CRIT 4 unidad (cat. 2, $5.000)
 *   OT 3 (mié 10/06): PIN-TEST 2 kilogramo (cat. 1, sin precio)
 */

before(async () => { await db.resetear(); });
beforeEach(async () => {
  await db.resetear();
  await db.query(`UPDATE inventario.material_orden_trabajo SET material_orden_trabajo_consumo_real = 12
                  WHERE orden_trabajo_id_orden = 1 AND material_sku = 'MAT-FIFO'`);
  await db.query(`UPDATE inventario.material_orden_trabajo SET material_orden_trabajo_consumo_real = 4
                  WHERE orden_trabajo_id_orden = 1 AND material_sku = 'MAT-CRIT'`);
  await db.query(`UPDATE inventario.orden_trabajo SET orden_trabajo_fecha_hora = '2026-06-10' WHERE orden_trabajo_id_orden = 3`);
  await db.query(`INSERT INTO inventario.material_orden_trabajo (material_sku, orden_trabajo_id_orden,
                    material_orden_trabajo_consumo_estimado, material_orden_trabajo_consumo_real)
                  VALUES ('PIN-TEST', 3, 2, 2)`);
});
after(async () => { await bajar(); await db.cerrar(); });

const RANGO = 'desde=2026-06-01&hasta=2026-06-30';
const grafico = (extra, opciones) => api('GET', `/api/reportes/consumo-area/grafico?agrupar=mes&${RANGO}&${extra}`, opciones);
const suma = (body) => body.datasets.reduce((s, d) => s + d.data.reduce((a, v) => a + v, 0), 0);

describe('Consumo en el tiempo por mes, semana o día (F-18)', () => {
  test('la semana y el día reparten el mismo total que el mes', async () => {
    const mes = await grafico('periodo=mes');
    const semana = await grafico('periodo=semana');
    const dia = await grafico('periodo=dia');
    for (const r of [mes, semana, dia]) assert.equal(r.status, 200, JSON.stringify(r.body));

    assert.deepEqual(mes.body.labels, ['2026-06']);
    assert.deepEqual(semana.body.labels, ['2026-06-01', '2026-06-08']);   // las semanas parten el lunes
    assert.deepEqual(dia.body.labels, ['2026-06-01', '2026-06-10']);
    assert.equal(semana.body.agrupacion, 'semana');

    const total = 12 * 1000 + 4 * 5000;
    assert.equal(suma(mes.body), total);
    assert.equal(suma(semana.body), total);
    assert.equal(suma(dia.body), total);
    assert.equal(mes.body.total_costo, total);
  });

  test('cada serie trae el id de su área (color fijo por área)', async () => {
    const r = await grafico('periodo=mes');
    assert.deepEqual(r.body.datasets.map(d => String(d.area_id)), ['1']);
  });

  test('en unidades hay que elegir producto o categoría', async () => {
    const r = await grafico('medida=unidades');
    assert.equal(r.status, 400);
    assert.match(r.body.error, /producto o una categoría/);
  });

  test('una categoría con consumos en distintas unidades se rechaza; un producto, no', async () => {
    const cat = await grafico('medida=unidades&categoria=1');   // MAT-FIFO (unidad) y PIN-TEST (kilogramo)
    assert.equal(cat.status, 400);
    assert.match(cat.body.error, /kilogramo, unidad/);

    const prod = await grafico('medida=unidades&sku=MAT-FIFO&periodo=dia');
    assert.equal(prod.status, 200, JSON.stringify(prod.body));
    assert.equal(prod.body.unidad, 'unidad');
    assert.equal(prod.body.medida, 'cantidad');
    assert.equal(prod.body.total_cantidad, 12);
    assert.equal(prod.body.total_costo, undefined);

    const cat2 = await grafico('medida=unidades&categoria=2');   // solo MAT-CRIT
    assert.equal(cat2.status, 200);
    assert.equal(cat2.body.total_cantidad, 4);
  });

  test('una categoría que no es un número da 400', async () => {
    const r = await grafico('categoria=abc');
    assert.equal(r.status, 400);
  });

  test('jop pide CLP y recibe unidades, sin ningún costo', async () => {
    const sinFiltro = await grafico('medida=clp', { rol: 'jop' });
    assert.equal(sinFiltro.status, 400);

    const r = await grafico('medida=clp&sku=MAT-FIFO', { rol: 'jop' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.medida, 'cantidad');
    assert.equal(r.body.total_cantidad, 12);
    assert.equal(r.body.total_costo, undefined);
  });
});
