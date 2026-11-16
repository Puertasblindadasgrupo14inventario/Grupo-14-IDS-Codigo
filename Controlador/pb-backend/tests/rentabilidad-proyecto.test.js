const { test, before, after, beforeEach, describe } = require('node:test');
const assert = require('node:assert/strict');
const { api, bajar } = require('./helpers/api');
const db = require('./helpers/db');

/**
 * F-32: rentabilidad por proyecto y mano de obra estándar por receta (DDL-10).
 *
 * Lo que protegen:
 *  - Una fila por puerta: las OT por área de la misma puerta suman sus materiales, pero el costo
 *    adicional (mano de obra) cuenta UNA vez por puerta, no una vez por OT.
 *  - Misma fórmula que la rentabilidad de la OT (F-10): costo / (1 − margen) / (1 − reserva).
 *  - El costo adicional es el estándar de la receta; el de la pantalla, solo para recetas sin estándar.
 *  - El precio de venta suma las ventas no canceladas del proyecto; las OT anuladas no cuentan.
 *  - La mano de obra estándar es un monto: jop no la ve ni la cambia (D50). Solo gerencia ve la rentabilidad.
 *
 * Semilla: proyecto 1 con la OT 1 (abierta), la 2 (finalizada) y la 3 (abierta); receta 1.
 * Precio de MAT-FIFO 1.200 (última compra) y de MAT-CRIT 5.000 (referencial).
 */

before(async () => { await db.resetear(); });
beforeEach(async () => {
  await db.resetear();
  // OT 1 y OT 3: la misma puerta (#77, F-30) de la receta 1, 2 puertas. Consumo solo en la OT 1: 22.000.
  await db.query(`UPDATE inventario.orden_trabajo SET orden_trabajo_medidas = '{"puerta": 77}', orden_trabajo_cantidad_puertas = 2,
                    producto_terminado_id_producto = 1 WHERE orden_trabajo_id_orden IN (1, 3)`);
  await db.query(`UPDATE inventario.material_orden_trabajo SET material_orden_trabajo_consumo_real = 10
                  WHERE orden_trabajo_id_orden = 1 AND material_sku = 'MAT-FIFO'`);
  await db.query(`UPDATE inventario.material_orden_trabajo SET material_orden_trabajo_consumo_real = 2
                  WHERE orden_trabajo_id_orden = 1 AND material_sku = 'MAT-CRIT'`);
  await db.query(`INSERT INTO inventario.historial_precio_material
                    (material_sku, proveedor_id_proveedor, precio_unitario, fecha_vigencia_desde, fuente)
                  VALUES ('MAT-FIFO', 1, 1200, CURRENT_DATE - 1, 'factura')`);
  await db.query(`UPDATE inventario.producto_terminado SET producto_terminado_costo_adicional_puerta = 100000
                  WHERE producto_terminado_id_producto = 1`);
});
after(async () => { await bajar(); await db.cerrar(); });

const rent = (qs, rol) => api('GET', `/api/ordenes-trabajo/proyectos/1/rentabilidad?${qs}`, { rol });
const MATERIALES = 10 * 1200 + 2 * 5000;   // 22.000

/**
 * Venta del proyecto 1 con sus ítems ([cantidad, precio, descuento, receta?, sku?, descripción?]).
 * Una línea con receta es una puerta vendida; sin receta (material suelto o instalación), un "otro ítem".
 */
async function venta(id, estado, items) {
  await db.query(`INSERT INTO finanzas.tipo_cliente (id_tipo_cliente, nombre_tipo_cliente)
                  OVERRIDING SYSTEM VALUE VALUES (1, 'empresa') ON CONFLICT DO NOTHING`);
  await db.query(`INSERT INTO finanzas.cliente_financiero (id_cliente_financiero, rut_cliente, id_tipo_cliente, nombre_razon_social)
                  OVERRIDING SYSTEM VALUE VALUES (1, '11111111-1', 1, 'Cliente de prueba') ON CONFLICT DO NOTHING`);
  await db.query(`INSERT INTO finanzas.proyecto_financiero (id_proyecto_financiero, id_cliente_financiero, id_proyecto_terreno,
                    codigo_proyecto, fecha_ingreso) OVERRIDING SYSTEM VALUE VALUES ($1, 1, 1, $2, CURRENT_DATE)`, [id, 'PF-' + id]);
  await db.query(`INSERT INTO finanzas.nota_venta (id_nota_venta, numero_nota_venta, id_cliente_financiero,
                    id_proyecto_financiero, fecha_emision, estado_pedido)
                  OVERRIDING SYSTEM VALUE VALUES ($1, $2, 1, $1, CURRENT_DATE, $3)`, [id, 'NV-' + id, estado]);
  for (const [cantidad, precio, descuento, receta = null, sku = null, descripcion = 'Puerta'] of items) {
    await db.query(`INSERT INTO finanzas.item_nota_venta (id_nota_venta, descripcion_item, cantidad, precio_unitario, descuento,
                      id_producto_terminado, sku_material)
                    VALUES ($1, $2, $3, $4, $5, $6, $7)`, [id, descripcion, cantidad, precio, descuento, receta, sku]);
  }
}

describe('Por puerta (F-32)', () => {
  test('las OT de la misma puerta suman materiales y la mano de obra cuenta una vez por puerta', async () => {
    const r = await rent('margen=40&adicional=5000');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const p77 = r.body.puertas.find(p => p.puerta === 77);
    assert.deepEqual(p77.ots.map(o => o.id), [1, 3]);
    assert.equal(p77.costo_materiales, MATERIALES);
    assert.equal(p77.cantidad_puertas, 2);
    assert.deepEqual([p77.costo_adicional_puerta, p77.origen_adicional, p77.costo_adicional], [100000, 'receta', 200000]);
    assert.equal(p77.precio_sugerido, Math.round((MATERIALES + 200000) / 0.6));

    // La OT 2 no tiene puerta ni receta con estándar: va sola, con el adicional de la pantalla
    const ot2 = r.body.puertas.find(p => p.clave === 'ot-2');
    assert.deepEqual([ot2.origen_adicional, ot2.costo_adicional], ['pantalla', 5000]);
    assert.equal(r.body.totales.costo_produccion, MATERIALES + 200000 + 5000);
  });

  test('misma fórmula que la rentabilidad de la OT', async () => {
    const ot = await api('GET', '/api/ordenes-trabajo/1/rentabilidad?margen=40&reserva=15&adicional=100000');
    const r = await rent('margen=40&reserva=15');
    const p77 = r.body.puertas.find(p => p.puerta === 77);
    assert.equal(p77.costo_produccion, ot.body.costo_produccion);
    assert.equal(p77.precio_sugerido, ot.body.precio_sugerido);
  });

  test('una OT anulada no cuenta', async () => {
    await db.query(`UPDATE inventario.orden_trabajo SET orden_trabajo_estado = 'cancelada' WHERE orden_trabajo_id_orden = 2`);
    const r = await rent('margen=40');
    assert.equal(r.body.puertas.some(p => p.clave === 'ot-2'), false);
  });
});

/**
 * Ajuste del 27/10: solo las puertas (líneas con receta) entran en la comparación, y por puerta. Antes
 * se comparaba toda la venta (con instalación y materiales sueltos) contra las puertas que tenían OT.
 * En la semilla, las OT cubren 3 puertas: 2 de la #77 (receta 1) y 1 de la OT 2 (sin receta ni cantidad).
 */
describe('Frente a lo vendido (F-32)', () => {
  const pct = (venta, sugerido) => Math.round(((venta - sugerido) / sugerido) * 1000) / 10;

  test('solo las puertas de las ventas no canceladas entran, por puerta; instalación y materiales van aparte', async () => {
    await venta(501, 'aprobada', [
      [2, 200000, 10000, 1],                                   // 2 puertas de la receta 1: 390.000
      [1, 50000, 0, null, null, 'Instalación'],                // otro ítem
      [3, 1000, 0, null, 'MAT-FIFO', 'Material suelto'],       // otro ítem
    ]);
    await venta(502, 'cancelada', [[1, 999999, 0, 1]]);
    const r = await rent('margen=40');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.venta.ventas.map(v => v.numero), ['NV-501']);
    assert.equal(r.body.venta.total_neto, 390000 + 50000 + 3000);
    assert.deepEqual(r.body.venta.puertas, { cantidad: 2, total: 390000, por_puerta: 195000 });
    assert.equal(r.body.venta.otros.total, 53000);
    assert.deepEqual(r.body.venta.otros.lineas.map(o => o.descripcion), ['Instalación', 'Material suelto']);

    const sugeridoPorPuerta = Math.round(r.body.totales.precio_sugerido / 3);
    assert.equal(r.body.totales.sugerido_por_puerta, sugeridoPorPuerta);
    assert.equal(r.body.venta.diferencia_monto, 195000 - sugeridoPorPuerta);
    assert.equal(r.body.venta.diferencia_pct, pct(195000, sugeridoPorPuerta));
  });

  test('si la venta no tiene las mismas puertas que las OT, lo avisa (y se sigue comparando por puerta)', async () => {
    await venta(501, 'aprobada', [[12, 200000, 0, 1]]);
    let r = await rent('margen=40');
    assert.ok(r.body.advertencias.some(a => a.includes('12 puerta(s)') && a.includes('cubren 3')), JSON.stringify(r.body.advertencias));
    assert.equal(r.body.venta.puertas.por_puerta, 200000);

    // Con las mismas puertas no hay aviso: la OT 2 (1 puerta) se anula y quedan 2 en OT; se venden 2
    await db.query(`UPDATE inventario.orden_trabajo SET orden_trabajo_estado = 'cancelada' WHERE orden_trabajo_id_orden = 2`);
    await db.query(`UPDATE finanzas.item_nota_venta SET cantidad = 2 WHERE id_nota_venta = 501`);
    r = await rent('margen=40');
    assert.equal(r.body.advertencias.some(a => a.includes('cubren')), false);
  });

  test('por tipo de puerta: cada receta con su venta y su sugerido; sin OT o sin venta, sin diferencia', async () => {
    await venta(501, 'aprobada', [[2, 200000, 0, 1], [1, 300000, 0, 2]]);
    const r = await rent('margen=40');
    const tipo = (id) => r.body.por_tipo.find(t => (t.receta?.id ?? null) === id);
    const p77 = r.body.puertas.find(p => p.puerta === 77);

    const t1 = tipo(1);
    assert.deepEqual([t1.vendidas, t1.venta_por_puerta, t1.en_ot], [2, 200000, 2]);
    assert.equal(t1.sugerido_por_puerta, Math.round(p77.precio_sugerido / 2));
    assert.equal(t1.diferencia_pct, pct(200000, t1.sugerido_por_puerta));

    const t2 = tipo(2);                     // vendida, sin OT
    assert.deepEqual([t2.vendidas, t2.en_ot, t2.sugerido_por_puerta, t2.diferencia_pct], [1, 0, null, null]);
    const sinReceta = tipo(null);           // la OT 2: en OT, sin venta
    assert.deepEqual([sinReceta.vendidas, sinReceta.en_ot, sinReceta.venta_por_puerta, sinReceta.diferencia_pct], [0, 1, null, null]);
  });

  test('ventas sin líneas de puertas: sin diferencia y lo avisa', async () => {
    await venta(501, 'aprobada', [[1, 50000, 0, null, null, 'Instalación']]);
    const r = await rent('margen=40');
    assert.deepEqual([r.body.venta.puertas.cantidad, r.body.venta.diferencia_pct], [0, null]);
    assert.ok(r.body.advertencias.some(a => a.includes('líneas de puertas')));
  });

  test('sin ventas no hay diferencia y lo avisa', async () => {
    const r = await rent('margen=40');
    assert.equal(r.body.venta.diferencia_pct, null);
    assert.ok(r.body.advertencias.some(a => a.includes('ventas')));
  });
});

describe('Permisos y validaciones (F-32)', () => {
  test('solo gerencia; margen fuera de rango → 400; proyecto inexistente → 404', async () => {
    assert.equal((await rent('margen=40', 'jop')).status, 403);
    assert.equal((await rent('margen=0')).status, 400);
    assert.equal((await api('GET', '/api/ordenes-trabajo/proyectos/999/rentabilidad?margen=40')).status, 404);
  });
});

describe('Mano de obra estándar en la receta (DDL-10)', () => {
  const materialesDe = async () => (await api('GET', '/api/recetas/1')).body.materiales.map(m => ({
    sku: m.sku, cantidad_base: parseFloat(m.cantidad_base), merma: parseFloat(m.merma), area_id: m.area_id, formula: m.formula,
  }));

  test('gerencia la ve y la cambia; omitirla la conserva; la copia la hereda', async () => {
    assert.equal((await api('GET', '/api/recetas/1')).body.producto.costo_adicional_puerta, 100000);
    const materiales = await materialesDe();
    let r = await api('PUT', '/api/recetas/1', { body: { materiales, costo_adicional_puerta: 150000, motivo: 'Ajuste' } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    r = await api('PUT', '/api/recetas/1', { body: { materiales, motivo: 'Sin tocar la mano de obra' } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal((await api('GET', '/api/recetas/1')).body.producto.costo_adicional_puerta, 150000);

    const copia = await api('POST', '/api/recetas/1/duplicar', { body: { codigo: 'PB-TEST-V9' } });
    assert.equal(copia.status < 300, true, JSON.stringify(copia.body));
    const { rows } = await db.query(`SELECT producto_terminado_costo_adicional_puerta::float AS v FROM inventario.producto_terminado
                                     WHERE producto_terminado_codigo_producto = 'PB-TEST-V9'`);
    assert.equal(rows[0].v, 150000);
  });

  test('jop no la recibe ni la puede cambiar; un valor negativo → 400', async () => {
    const jop = await api('GET', '/api/recetas/1', { rol: 'jop' });
    assert.equal('costo_adicional_puerta' in jop.body.producto, false);
    const materiales = await materialesDe();
    assert.equal((await api('PUT', '/api/recetas/1', { rol: 'jop', body: { materiales, costo_adicional_puerta: 1 } })).status, 403);
    assert.equal((await api('PUT', '/api/recetas/1', { body: { materiales, costo_adicional_puerta: -5, motivo: 'x' } })).status, 400);
  });

  test('los costos de la OT sugieren el estándar de su receta', async () => {
    const c = await api('GET', '/api/ordenes-trabajo/1/costos');
    assert.equal(c.body.orden.costo_adicional_estandar, 100000);
  });
});
