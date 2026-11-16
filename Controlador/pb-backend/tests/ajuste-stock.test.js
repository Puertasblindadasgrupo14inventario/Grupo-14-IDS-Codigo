const { test, before, after, beforeEach, describe } = require('node:test');
const assert = require('node:assert/strict');
const { api, bajar, firmaGerencia } = require('./helpers/api');
const db = require('./helpers/db');
const { compra } = require('./helpers/compra');
const { stockAFecha, consumoNeto } = require('../src/db/historico');

/**
 * F-38: ajustar el stock de una bodega desde el producto (cantidad nueva) o desde Entrada (sumar).
 * D92: un ajuste no bloquea las salidas atrasadas; avisa de un posible doble conteo, igual que una
 * compra recibida hasta el día del último conteo o ajuste del producto en la bodega.
 *
 * Lo que protegen:
 *  - El stock se mueve SOLO por la diferencia, con un movimiento 'ajuste_inventario' que no es consumo.
 *  - Un rechazo (validación, 409 o aviso sin confirmar) nunca mueve stock.
 *  - Nunca por debajo de lo reservado: reservas == cantidad reservada.
 *  - stockAFecha reconstruye el stock real y el de antes del ajuste.
 *  - Un ajuste no aparece con la factura del lote al que entró.
 *
 * Semilla: MAT-FIFO con 30 físicas y 5 reservadas en la bodega 1 (lote 1 viejo: 10, lote 2: 20 con 5
 * reservadas) y nada en la bodega 2. Tipos 1 entrada y 2 salida; motivo 4 = ajuste_inventario.
 */

before(async () => { await db.resetear(); });
beforeEach(async () => { await db.resetear(); });
after(async () => { await bajar(); await db.cerrar(); });

const MOTIVO = 'Recuento a mano del bodeguero';
const ajustar = (body, opciones = {}) =>
  api('POST', '/api/movimientos/ajuste', { body: { sku: 'MAT-FIFO', bodega_id: 1, motivo: MOTIVO, ...body }, ...opciones });

/** Fecha local YYYY-MM-DD a `dias` de hoy. */
function dia(dias) {
  const d = new Date();
  d.setDate(d.getDate() + dias);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

async function movimientos() {
  const { rows } = await db.query(
    `SELECT movimiento_inventario_id_movimiento::int AS id, material_sku AS sku, bodega_id_bodega::int AS bodega,
            movimiento_inventario_cantidad::float AS cantidad, movimiento_inventario_estado AS estado,
            movimiento_inventario_tipo_movimiento_id_tipo_movimiento::int AS tipo,
            movimiento_inventario_motivo_movimiento_id_motivo_movimiento::int AS motivo,
            movimiento_inventario_descripcion_motivo AS descripcion, lote_id_lote::int AS lote
     FROM inventario.movimiento_inventario ORDER BY 1`);
  return rows;
}

/** stockAFecha a un minuto en el futuro == stock real, para cada SKU con stock. */
async function reconstruccionCuadra() {
  const hoy = await stockAFecha(db, new Date(Date.now() + 60000));
  for (const sku of ['MAT-FIFO', 'MAT-UNO', 'MAT-CRIT']) {
    assert.equal(hoy.get(sku), (await db.stockDe(sku)).fisica, `stockAFecha de ${sku}`);
  }
  assert.deepEqual(await db.descuadresDeReservas(), []);
}

describe('Ajustar por la diferencia', () => {
  test('desde el producto: 30 → 32 es una entrada de 2 y 32 → 29 una salida de 3', async () => {
    const antes = new Date();
    const sube = await ajustar({ cantidad_actual: 30, cantidad_nueva: 32 });
    assert.equal(sube.status, 201, JSON.stringify(sube.body));
    assert.equal(sube.body.tipo, 'entrada');
    assert.deepEqual(await db.stockDe('MAT-FIFO'), { fisica: 32, reservada: 5 });
    assert.equal(await db.stockDeLote('MAT-FIFO', 1), 12);   // al lote más antiguo

    const baja = await ajustar({ cantidad_actual: 32, cantidad_nueva: 29 });
    assert.equal(baja.status, 201, JSON.stringify(baja.body));
    assert.deepEqual(await db.stockDe('MAT-FIFO'), { fisica: 29, reservada: 5 });

    const movs = await movimientos();
    assert.deepEqual(movs.map(m => [m.tipo, m.motivo, m.cantidad, m.estado]), [[1, 4, 2, 'completado'], [2, 4, 3, 'completado']]);
    assert.ok(movs.every(m => m.descripcion === `Ajuste de stock: ${MOTIVO}`));
    assert.equal((await stockAFecha(db, antes)).get('MAT-FIFO'), 30);
    await reconstruccionCuadra();
    // El ajuste no es consumo
    assert.ok(!(await consumoNeto(db, {})).get('MAT-FIFO'));
  });

  test('desde Entrada: sumar 2', async () => {
    const r = await ajustar({ sumar: 2 });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.deepEqual(await db.stockDe('MAT-FIFO'), { fisica: 32, reservada: 5 });
    assert.deepEqual((await movimientos()).map(m => [m.tipo, m.motivo, m.cantidad]), [[1, 4, 2]]);
    await reconstruccionCuadra();
  });

  test('una bodega sin lotes del producto recibe un lote nuevo', async () => {
    const r = await ajustar({ bodega_id: 2, cantidad_actual: 0, cantidad_nueva: 4 });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const { rows } = await db.query(
      `SELECT ib.lote_id_lote::int AS lote, ib.inventario_bodega_cantidad_fisica::float AS fisica, l.lote_numero_lote AS numero
       FROM inventario.inventario_bodega ib JOIN inventario.lote l ON l.lote_id_lote = ib.lote_id_lote
       WHERE ib.material_sku = 'MAT-FIFO' AND ib.bodega_id_bodega = 2`);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].fisica, 4);
    assert.match(rows[0].numero, /^LOTE-\d{8}-\d+$/);
    assert.equal((await movimientos())[0].lote, rows[0].lote);
    await reconstruccionCuadra();
  });

  test('bajar hasta lo reservado sí se puede', async () => {
    const r = await ajustar({ cantidad_actual: 30, cantidad_nueva: 5 });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.deepEqual(await db.stockDe('MAT-FIFO'), { fisica: 5, reservada: 5 });
    await reconstruccionCuadra();
  });
});

describe('Rechazos: nunca mueven stock', () => {
  test('sin diferencia, bajo lo reservado, negativo, sin motivo o con los dos modos → 400', async () => {
    const stock = await db.stockDe('MAT-FIFO');
    const casos = [
      { cantidad_actual: 30, cantidad_nueva: 30 },
      { cantidad_actual: 30, cantidad_nueva: 4 },            // reservadas: 5
      { cantidad_actual: 30, cantidad_nueva: -1 },
      { cantidad_actual: 30, cantidad_nueva: 31, motivo: '  ' },
      { cantidad_actual: 30, cantidad_nueva: 31, sumar: 1 },
      { cantidad_nueva: 31 },                                 // falta lo que se mostró
      { sumar: 0 },
      {},
    ];
    for (const c of casos) {
      const r = await ajustar(c);
      assert.equal(r.status, 400, `${JSON.stringify(c)} → ${r.status} ${JSON.stringify(r.body)}`);
    }
    assert.deepEqual(await db.stockDe('MAT-FIFO'), stock);
    assert.equal(await db.contar('inventario.movimiento_inventario'), 0);
  });

  test('la cantidad que se mostró ya no es la actual → 409 con el stock de ahora', async () => {
    const r = await ajustar({ cantidad_actual: 25, cantidad_nueva: 28 });
    assert.equal(r.status, 409);
    assert.equal(r.body.codigo, 'STOCK_CAMBIO');
    assert.equal(r.body.cantidad_fisica, 30);
    assert.deepEqual(await db.stockDe('MAT-FIFO'), { fisica: 30, reservada: 5 });
    assert.equal(await db.contar('inventario.movimiento_inventario'), 0);
  });

  test('producto o bodega inactivos → 400; producto o bodega inexistentes → 404', async () => {
    await db.query(`UPDATE inventario.material SET material_estado = 'inactivo' WHERE material_sku = 'MAT-UNO'`);
    await db.query(`UPDATE inventario.bodega SET bodega_estado = 'inactivo' WHERE bodega_id_bodega = 2`);
    assert.equal((await ajustar({ sku: 'MAT-UNO', cantidad_actual: 1, cantidad_nueva: 2 })).status, 400);
    assert.equal((await ajustar({ bodega_id: 2, cantidad_actual: 0, cantidad_nueva: 2 })).status, 400);
    assert.equal((await ajustar({ sku: 'NO-EXISTE', cantidad_actual: 0, cantidad_nueva: 2 })).status, 404);
    assert.equal((await ajustar({ bodega_id: 99, cantidad_actual: 0, cantidad_nueva: 2 })).status, 404);
    assert.equal(await db.contar('inventario.movimiento_inventario'), 0);
  });

  test('solo gerencia, con su propia firma', async () => {
    assert.equal((await ajustar({ sumar: 1 }, { rol: 'jop' })).status, 403);
    const sinFirma = await ajustar({ sumar: 1 }, { sinFirma: true });
    assert.equal(sinFirma.status, 428);
    assert.equal(sinFirma.body.requiere_firma, 'ajuste_stock');
    assert.equal((await ajustar({ sumar: 1 }, { firma: firmaGerencia('movimiento_manual'), sinFirma: true })).status, 428);
    assert.deepEqual(await db.stockDe('MAT-FIFO'), { fisica: 30, reservada: 5 });
  });
});

describe('Aviso de posible doble conteo (D92)', () => {
  const entrada = (extra = {}) => api('POST', '/api/movimientos/entrada', {
    body: { sku: 'MAT-FIFO', bodega_id: 1, cantidad: 4, tipo_movimiento_id: 1, ...compra(), ...extra } });
  const salidaAtrasada = (extra = {}) => api('POST', '/api/movimientos/salida', {
    body: { sku: 'MAT-FIFO', bodega_id: 1, cantidad: 1, tipo_movimiento_id: 2, motivo_id: 2, fecha: `${dia(-2)}T10:00`, ...extra } });

  test('una compra recibida el día de un ajuste avisa sin mover stock; confirmada, entra', async () => {
    assert.equal((await ajustar({ cantidad_actual: 30, cantidad_nueva: 32 })).status, 201);
    const aviso = await entrada();
    assert.equal(aviso.status, 409, JSON.stringify(aviso.body));
    assert.equal(aviso.body.codigo, 'POSIBLE_DOBLE_CONTEO');
    assert.equal(aviso.body.corte.origen, 'ajuste');
    assert.equal((await db.stockDe('MAT-FIFO')).fisica, 32);
    assert.equal(await db.contar('inventario.lote'), 5, 'el aviso no deja un lote creado');

    const ok = await entrada({ confirmar_doble_conteo: true });
    assert.equal(ok.status, 201, JSON.stringify(ok.body));
    assert.equal((await db.stockDe('MAT-FIFO')).fisica, 36);
    await reconstruccionCuadra();
  });

  test('sin ajuste ni conteo, en otra bodega o por devolución de obra no avisa', async () => {
    assert.equal((await entrada()).status, 201);
    assert.equal((await ajustar({ cantidad_actual: 34, cantidad_nueva: 35 })).status, 201);
    assert.equal((await entrada({ bodega_id: 2 })).status, 201);
    const devolucion = await api('POST', '/api/movimientos/entrada', {
      body: { sku: 'MAT-FIFO', bodega_id: 1, cantidad: 1, tipo_movimiento_id: 1, tipo_entrada: 'devolucion', descripcion_motivo: 'Vuelve de la obra' } });
    assert.equal(devolucion.status, 201, JSON.stringify(devolucion.body));
  });

  test('un conteo que contó el producto avisa a la compra recibida antes, no a la recibida después', async () => {
    const { rows } = await db.query(`INSERT INTO inventario.conteo_ciclico (conteo_ciclico_estado, conteo_ciclico_fecha_confirmacion,
                      bodega_id_bodega, usuario_id_usuario) VALUES ('confirmado', now() - interval '3 days', 1, 1)
                      RETURNING conteo_ciclico_id_conteo AS id`);
    await db.query(`INSERT INTO inventario.conteo_ciclico_detalle (conteo_ciclico_id_conteo, material_sku,
                      conteo_ciclico_detalle_cantidad_contada) VALUES ($1, 'MAT-FIFO', 30)`, [rows[0].id]);
    const antes = await entrada({ fecha_pedido: dia(-5), fecha_recepcion: dia(-4) });
    assert.equal(antes.status, 409, JSON.stringify(antes.body));
    assert.equal(antes.body.corte.origen, 'conteo');
    assert.equal(antes.body.corte.id, Number(rows[0].id));
    assert.equal((await entrada({ fecha_pedido: dia(-2), fecha_recepcion: dia(-1) })).status, 201);
  });

  test('una salida atrasada anterior a un ajuste avisa (no bloquea); confirmada, sale', async () => {
    assert.equal((await ajustar({ cantidad_actual: 30, cantidad_nueva: 32 })).status, 201);
    const aviso = await salidaAtrasada();
    assert.equal(aviso.status, 409, JSON.stringify(aviso.body));
    assert.equal(aviso.body.codigo, 'POSIBLE_DOBLE_CONTEO');
    assert.equal((await db.stockDe('MAT-FIFO')).fisica, 32);

    const ok = await salidaAtrasada({ confirmar_doble_conteo: true });
    assert.equal(ok.status, 201, JSON.stringify(ok.body));
    assert.equal((await db.stockDe('MAT-FIFO')).fisica, 31);
    await reconstruccionCuadra();
  });

  test('un ajuste revertido ya no avisa', async () => {
    const r = await ajustar({ cantidad_actual: 30, cantidad_nueva: 32 });
    const rev = await api('POST', `/api/movimientos/${r.body.movimiento_id}/revertir`);
    assert.ok([200, 201].includes(rev.status), JSON.stringify(rev.body));
    assert.equal((await db.stockDe('MAT-FIFO')).fisica, 30);
    assert.equal((await salidaAtrasada()).status, 201);
  });
});

describe('Factura del lote', () => {
  test('una entrada de ajuste no se muestra con la factura del lote al que entró', async () => {
    const c = await api('POST', '/api/movimientos/entrada', {
      body: { sku: 'MAT-UNO', bodega_id: 2, cantidad: 2, tipo_movimiento_id: 1, ...compra({ factura_numero: 'F38-A' }) } });
    assert.equal(c.status, 201, JSON.stringify(c.body));
    const a = await ajustar({ sku: 'MAT-UNO', bodega_id: 2, cantidad_actual: 2, cantidad_nueva: 5 });
    assert.equal(a.status, 201, JSON.stringify(a.body));
    assert.equal((await movimientos()).find(m => m.id === a.body.movimiento_id).lote, Number(c.body.lote_id), 'entró al lote de la compra');

    const hist = (await api('GET', '/api/movimientos?buscar=MAT-UNO')).body;
    assert.equal(hist.find(m => Number(m.id) === Number(c.body.movimiento_id)).documento_tipo, 'factura');
    assert.notEqual(hist.find(m => Number(m.id) === a.body.movimiento_id).documento_tipo, 'factura');

    const rep = await api('GET', '/api/reportes/movimientos?factura=F38-A');
    assert.equal(rep.status, 200);
    assert.deepEqual(rep.body.movimientos.map(m => Number(m.id)), [Number(c.body.movimiento_id)]);
  });
});
