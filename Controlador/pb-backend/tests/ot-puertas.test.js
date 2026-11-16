const { test, before, after, beforeEach, describe } = require('node:test');
const assert = require('node:assert/strict');
const { api, bajar } = require('./helpers/api');
const db = require('./helpers/db');

/**
 * F-30 (D71 resuelta el 13/10): puertas de un proyecto y sus OT por área, sin DDL.
 *
 * Lo que se protege:
 *  - una línea (receta + medidas + cantidad) crea una OT por cada área con insumos en la receta,
 *    todas con las mismas medidas y la misma clave de puerta; un área sin insumos no tiene OT;
 *  - todo o nada: una línea inválida no crea ninguna OT;
 *  - las medidas son de la puerta: cambiarlas en una OT las cambia en sus hermanas ABIERTAS, no en
 *    las cerradas ni en otra puerta; en una puerta no se pueden quitar;
 *  - el listado y el detalle traen la clave de la puerta;
 *  - F-30 parte 2: la especificación (datos de la OT en papel) también es de la puerta, se conserva al
 *    cambiar las medidas y la nota es por área.
 *
 * Semilla: áreas 1 Corte, 2 Pintura, 3 Instalación; proyecto 1 (PRY-TEST); receta 1 (PB-TEST) con
 * MAT-FIFO y MAT-CRIT del área 1; receta 2 sin insumos; usuarios 1 gerencia y 2 jop. OTs 1 a 3 ya existen.
 */

before(async () => { await db.resetear(); });
beforeEach(async () => {
  await db.resetear();
  // La receta 1 pasa a tener insumos de dos áreas: Corte (semilla) y Pintura
  await db.query(`INSERT INTO inventario.material_producto_terminado (material_sku, producto_terminado_id_producto,
                    material_producto_terminado_cantidad_estimada, material_producto_terminado_merma_estimada, area_trabajo_id_area)
                  VALUES ('PIN-TEST', 1, 1, 0, 2), ('MAT-UNO', 1, 1, 0, 3)`);   // 3 = Instalación: va por el pedido (D44)
});
after(async () => { await bajar(); await db.cerrar(); });

const MEDIDAS = { vano_ancho_mm: 1000, vano_alto_mm: 2100, hojas: 1, mdf: true, perfil_marco_mm: 20 };
const crear = (body, rol) => api('POST', '/api/ordenes-trabajo/puertas', { body, rol });
const linea = (extra = {}) => ({ receta_id: 1, cantidad_puertas: 4, medidas: MEDIDAS, ...extra });

const otsNuevas = async () => (await db.query(
  `SELECT orden_trabajo_id_orden::int AS id, area_trabajo_id_area::int AS area, usuario_id_usuario::int AS responsable,
          orden_trabajo_cantidad_puertas AS puertas, orden_trabajo_estado AS estado, orden_trabajo_medidas AS m
   FROM inventario.orden_trabajo WHERE orden_trabajo_id_orden > 3 ORDER BY 1`)).rows;
const medidasDe = async (id) => (await db.query(
  `SELECT orden_trabajo_medidas AS m FROM inventario.orden_trabajo WHERE orden_trabajo_id_orden = $1`, [id])).rows[0].m;

describe('crear las puertas de un proyecto', () => {
  test('una línea → una OT por área con insumos, mismas medidas, misma clave de puerta', async () => {
    const r = await crear({ proyecto_id: 1, responsables: { 2: 2 }, lineas: [linea()] });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const ots = await otsNuevas();
    assert.deepEqual(ots.map(o => o.area), [1, 2]);                // Corte y Pintura; Instalación no tiene OT (D44)
    assert.deepEqual(ots.map(o => o.responsable), [1, 2]);         // por defecto quien crea; Pintura el indicado
    assert.ok(ots.every(o => o.puertas === 4 && o.estado === 'pendiente'));
    assert.ok(ots.every(o => o.m.puerta === ots[0].id));
    assert.ok(ots.every(o => o.m.vano_ancho_mm === 1000 && o.m.mdf_espesor_mm === 4));
    assert.equal(r.body.puertas[0].puerta, ots[0].id);
    assert.equal(await db.contar('finanzas.evento_auditoria', `accion_realizada = 'crear_puerta_ot'`), 1);
  });

  test('dos líneas → dos puertas distintas', async () => {
    const r = await crear({ proyecto_id: 1, lineas: [linea(), linea({ medidas: { ...MEDIDAS, vano_ancho_mm: 900 } })] });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const ots = await otsNuevas();
    assert.equal(ots.length, 4);
    assert.equal(new Set(ots.map(o => o.m.puerta)).size, 2);
  });

  test('se puede ingresar el marco: el vano se calcula con la holgura del marco', async () => {
    await crear({ proyecto_id: 1, lineas: [linea({ medidas: { ...MEDIDAS, medido: 'marco', vano_ancho_mm: 936, vano_alto_mm: 2017 } })] });
    const m = (await otsNuevas())[0].m;
    assert.equal(m.medido, 'marco');
    assert.equal(m.vano_ancho_mm, 941);
    assert.equal(m.vano_alto_mm, 2022);
  });

  test('todo o nada: una línea inválida, sin proyecto o con una receta sin insumos no crea ninguna OT', async () => {
    let r = await crear({ proyecto_id: 1, lineas: [linea(), linea({ cantidad_puertas: 0 })] });
    assert.equal(r.status, 400);
    assert.deepEqual(r.body.errores.map(e => e.linea), [2]);
    r = await crear({ proyecto_id: 1, lineas: [linea({ medidas: null })] });
    assert.equal(r.status, 400);
    r = await crear({ lineas: [linea()] });
    assert.equal(r.status, 400);
    r = await crear({ proyecto_id: 1, lineas: [linea(), linea({ receta_id: 2 })] });   // la 2 no tiene insumos
    assert.equal(r.status, 400);
    r = await crear({ proyecto_id: 1, responsables: { 1: 999 }, lineas: [linea()] });
    assert.equal(r.status, 400);
    assert.equal((await otsNuevas()).length, 0);
  });

  test('técnico → 403', async () => {
    assert.equal((await crear({ proyecto_id: 1, lineas: [linea()] }, 'tecnico')).status, 403);
    assert.equal((await otsNuevas()).length, 0);
  });
});

describe('las medidas son de la puerta', () => {
  test('cambiarlas en una OT las aplica a sus hermanas abiertas, no a las cerradas ni a otra puerta', async () => {
    await crear({ proyecto_id: 1, lineas: [linea(), linea()] });
    const [a, b, c] = await otsNuevas();                            // a y b: puerta 1; c y d: puerta 2
    await db.query(`UPDATE inventario.orden_trabajo SET orden_trabajo_estado = 'finalizada' WHERE orden_trabajo_id_orden = $1`, [b.id]);

    const r = await api('PUT', `/api/ordenes-trabajo/${a.id}/medidas`, { body: { medidas: { ...MEDIDAS, vano_ancho_mm: 950 } } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.cerradas, [b.id]);
    assert.equal((await medidasDe(a.id)).vano_ancho_mm, 950);
    assert.equal((await medidasDe(a.id)).puerta, a.id);             // la clave se conserva
    assert.equal((await medidasDe(b.id)).vano_ancho_mm, 1000);      // cerrada: conserva las suyas
    assert.equal((await medidasDe(c.id)).vano_ancho_mm, 1000);      // otra puerta: no cambia
  });

  test('en una puerta las medidas no se quitan; en una OT suelta sí', async () => {
    await crear({ proyecto_id: 1, lineas: [linea()] });
    const [a, b] = await otsNuevas();
    const r = await api('PUT', `/api/ordenes-trabajo/${a.id}/medidas`, { body: { medidas: null } });
    assert.equal(r.status, 400);
    assert.equal((await medidasDe(b.id)).vano_ancho_mm, 1000);
    await api('PUT', '/api/ordenes-trabajo/3/medidas', { body: { medidas: MEDIDAS } });
    assert.equal((await api('PUT', '/api/ordenes-trabajo/3/medidas', { body: { medidas: null } })).status, 200);
  });

  test('una OT suelta solo cambia la suya', async () => {
    await crear({ proyecto_id: 1, lineas: [linea()] });
    await api('PUT', '/api/ordenes-trabajo/3/medidas', { body: { medidas: MEDIDAS } });
    const r = await api('PUT', '/api/ordenes-trabajo/3/medidas', { body: { medidas: { ...MEDIDAS, vano_ancho_mm: 990 } } });
    assert.equal(r.status, 200);
    assert.equal(r.body.puerta, undefined);
    assert.ok((await otsNuevas()).every(o => o.m.vano_ancho_mm === 1000));
  });
});

describe('listado y detalle', () => {
  test('el listado trae la clave de puerta, la receta y las puertas; el detalle, sus hermanas', async () => {
    await crear({ proyecto_id: 1, lineas: [linea()] });
    const [a, b] = await otsNuevas();
    const lista = (await api('GET', '/api/ordenes-trabajo')).body;
    const filas = lista.filter(o => Number(o.id) === a.id || Number(o.id) === b.id);
    assert.ok(filas.every(o => Number(o.puerta) === a.id && o.receta_codigo === 'PB-TEST' && o.cantidad_puertas === 4));
    assert.equal(lista.find(o => Number(o.id) === 1).puerta, null);   // OT suelta

    const det = (await api('GET', `/api/ordenes-trabajo/${a.id}/consumos`, { rol: 'jop' })).body.orden;
    assert.equal(det.puerta, a.id);
    assert.deepEqual(det.misma_puerta.map(h => h.id), [b.id]);
    assert.equal(det.misma_puerta[0].medidas_iguales, true);
    assert.equal(det.medidas_puerta, undefined);
  });
});

describe('especificación de la puerta (F-30 parte 2)', () => {
  const especificar = (id, body, rol) => api('PUT', `/api/ordenes-trabajo/${id}/especificacion`, { body, rol });

  test('se aplica a las hermanas abiertas, no a las cerradas; la nota es del área de la OT', async () => {
    await crear({ proyecto_id: 1, lineas: [linea(), linea()] });
    const [a, b, c] = await otsNuevas();                            // a (Corte) y b (Pintura): puerta 1; c: puerta 2
    let r = await especificar(a.id, { especificacion: { cerradura: ' Multilock ', cerrojo: '4 pasadores a 1350' }, nota_area: 'Ojo a 1520' }, 'jop');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const ea = (await medidasDe(a.id)).especificacion;
    assert.deepEqual(ea.campos, { cerradura: 'Multilock', cerrojo: '4 pasadores a 1350' });
    assert.deepEqual(ea.notas_area, { 1: 'Ojo a 1520' });
    assert.deepEqual((await medidasDe(b.id)).especificacion, ea);
    assert.equal((await medidasDe(c.id)).especificacion, undefined);   // otra puerta

    // Presencia: lo omitido se conserva, lo vacío se limpia; la nota de b es la de su área
    await db.query(`UPDATE inventario.orden_trabajo SET orden_trabajo_estado = 'finalizada' WHERE orden_trabajo_id_orden = $1`, [a.id]);
    r = await especificar(b.id, { especificacion: { cerrojo: '', enchape: 'Cedro' }, nota_area: 'Color negro' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.cerradas, [a.id]);
    const eb = (await medidasDe(b.id)).especificacion;
    assert.deepEqual(eb.campos, { cerradura: 'Multilock', enchape: 'Cedro' });
    assert.deepEqual(eb.notas_area, { 1: 'Ojo a 1520', 2: 'Color negro' });
    assert.deepEqual((await medidasDe(a.id)).especificacion, ea);    // cerrada: conserva la suya
    assert.equal(await db.contar('finanzas.evento_auditoria', `accion_realizada = 'especificacion_ot'`), 2);
  });

  test('cambiar las medidas conserva la especificación (en una puerta y en una OT suelta)', async () => {
    await crear({ proyecto_id: 1, lineas: [linea()] });
    const [a, b] = await otsNuevas();
    await especificar(a.id, { especificacion: { abertura: 'Derecha' } });
    await api('PUT', `/api/ordenes-trabajo/${b.id}/medidas`, { body: { medidas: { ...MEDIDAS, vano_ancho_mm: 950 } } });
    for (const id of [a.id, b.id]) {
      const m = await medidasDe(id);
      assert.equal(m.vano_ancho_mm, 950);
      assert.deepEqual(m.especificacion.campos, { abertura: 'Derecha' });
    }
    // el detalle no las ve como medidas distintas por la especificación
    const det = (await api('GET', `/api/ordenes-trabajo/${a.id}/consumos`)).body.orden;
    assert.equal(det.misma_puerta[0].medidas_iguales, true);
    assert.equal(det.tiene_medidas, true);
    assert.deepEqual(det.especificacion.campos, { abertura: 'Derecha' });

    await api('PUT', '/api/ordenes-trabajo/3/medidas', { body: { medidas: MEDIDAS } });
    await especificar(3, { especificacion: { bisagras: 'Distribuir' } });
    await api('PUT', '/api/ordenes-trabajo/3/medidas', { body: { medidas: { ...MEDIDAS, vano_alto_mm: 2000 } } });
    assert.deepEqual((await medidasDe(3)).especificacion.campos, { bisagras: 'Distribuir' });
  });

  test('rechazos: sin medidas, OT cerrada, campo desconocido o largo, cuerpo vacío; no escriben nada', async () => {
    await crear({ proyecto_id: 1, lineas: [linea()] });
    const [a] = await otsNuevas();
    assert.equal((await especificar(3, { especificacion: { cerradura: 'X' } })).status, 400);   // OT 3 sin medidas
    assert.equal((await especificar(a.id, { especificacion: { inventado: 'X' } })).status, 400);
    assert.equal((await especificar(a.id, { especificacion: { cerradura: 'x'.repeat(101) } })).status, 400);
    assert.equal((await especificar(a.id, { nota_area: 'x'.repeat(501) })).status, 400);
    assert.equal((await especificar(a.id, {})).status, 400);
    assert.equal((await especificar(a.id, { especificacion: { cerradura: 'X' } }, 'tecnico')).status, 403);
    assert.equal((await medidasDe(a.id)).especificacion, undefined);
    await db.query(`UPDATE inventario.orden_trabajo SET orden_trabajo_estado = 'finalizada' WHERE orden_trabajo_id_orden = $1`, [a.id]);
    assert.equal((await especificar(a.id, { especificacion: { cerradura: 'X' } })).status, 400);
    assert.equal(await db.contar('finanzas.evento_auditoria', `accion_realizada = 'especificacion_ot'`), 0);
  });

  test('vaciar todo quita la especificación', async () => {
    await crear({ proyecto_id: 1, lineas: [linea()] });
    const [a] = await otsNuevas();
    await especificar(a.id, { especificacion: { ojo: '1520' } });
    assert.equal((await especificar(a.id, { especificacion: { ojo: null } })).status, 200);
    assert.equal((await medidasDe(a.id)).especificacion, undefined);
  });
});

describe('ítems no estándar de la puerta (F-09)', () => {
  const especificar = (id, body, rol) => api('PUT', `/api/ordenes-trabajo/${id}/especificacion`, { body, rol });
  const MOCHETA = { descripcion: ' Mocheta de 15 cm ', cantidad: '2', unidad: 'unidad', area_id: 1, nota: 'Lado bisagra' };

  test('se guardan con la especificación, se comparten con la puerta y no mueven stock', async () => {
    await crear({ proyecto_id: 1, lineas: [linea()] });
    const [a, b] = await otsNuevas();
    const movs = await db.contar('inventario.movimiento_inventario');
    const r = await especificar(a.id, { no_estandar: [MOCHETA, { descripcion: 'Vidrio 40x60', cantidad: 1 }] }, 'jop');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const esperado = [
      { descripcion: 'Mocheta de 15 cm', cantidad: 2, unidad: 'unidad', area_id: 1, nota: 'Lado bisagra' },
      { descripcion: 'Vidrio 40x60', cantidad: 1, unidad: null, area_id: null, nota: null },
    ];
    assert.deepEqual((await medidasDe(a.id)).especificacion.no_estandar, esperado);
    assert.deepEqual((await medidasDe(b.id)).especificacion.no_estandar, esperado);
    assert.equal(await db.contar('inventario.movimiento_inventario'), movs);

    // Omitidos se conservan al guardar otros campos; la lista vacía los quita
    await especificar(a.id, { especificacion: { abertura: 'Derecha' } });
    assert.equal((await medidasDe(b.id)).especificacion.no_estandar.length, 2);
    await especificar(b.id, { no_estandar: [] });
    assert.equal((await medidasDe(a.id)).especificacion.no_estandar, undefined);
  });

  test('rechazos: sin descripción, cantidad 0, área inexistente, más de 30 o sin medidas; no escriben nada', async () => {
    await crear({ proyecto_id: 1, lineas: [linea()] });
    const [a] = await otsNuevas();
    for (const item of [{ cantidad: 1 }, { descripcion: 'X', cantidad: 0 }, { descripcion: 'X', cantidad: 1, area_id: 999 }]) {
      assert.equal((await especificar(a.id, { no_estandar: [item] })).status, 400, JSON.stringify(item));
    }
    const muchos = Array.from({ length: 31 }, (_, i) => ({ descripcion: `Ítem ${i}`, cantidad: 1 }));
    assert.equal((await especificar(a.id, { no_estandar: muchos })).status, 400);
    assert.equal((await especificar(3, { no_estandar: [MOCHETA] })).status, 400);   // OT 3 sin medidas
    assert.equal((await medidasDe(a.id)).especificacion, undefined);
  });

  test('el listado de materiales trae la clasificación (F-09)', async () => {
    const lista = (await api('GET', '/api/materiales')).body;
    assert.ok(lista.every(m => 'clasificacion_categoria' in m && 'clasificacion_subcategoria' in m && 'clasificacion_nivel' in m));
  });
});
