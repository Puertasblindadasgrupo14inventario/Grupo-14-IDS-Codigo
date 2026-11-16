const { test, before, after, beforeEach, describe } = require('node:test');
const assert = require('node:assert/strict');
const { api, bajar } = require('./helpers/api');
const db = require('./helpers/db');

/**
 * B-13: la búsqueda de Alertas → Faltantes de OT encuentra también por proyecto (código o nombre) y
 * por número de una OT afectada. Antes solo por SKU o nombre del material, aunque la lista mostraba
 * el proyecto y las OT.
 *
 * Lo que protegen:
 *  - por número de OT trae solo las alertas de ESA OT, en cualquiera de sus formas ("12", "#12", "OT 12");
 *  - una OT cerrada no es "afectada" (la columna muestra solo las abiertas), así que no la encuentra;
 *  - las búsquedas de antes siguen igual.
 *
 * Semilla: proyecto 1 (PRY-TEST, "Proyecto de prueba") con la OT 1 abierta (MAT-FIFO y MAT-CRIT) y la
 * OT 2 finalizada. Aquí se agrega el proyecto 2 (PRY-NORTE, "Edificio Norte") con la OT 10 abierta (MAT-UNO).
 */

before(async () => { await db.resetear(); });
beforeEach(async () => {
  await db.resetear();
  await db.query(`INSERT INTO terreno.proyecto (id_proyecto, codigo_proyecto, nombre_referencia, fecha_instalacion,
                    fecha_ingreso, estado_operacional, estado_produccion, rut_cliente)
                  OVERRIDING SYSTEM VALUE VALUES (2, 'PRY-NORTE', 'Edificio Norte', '2026-12-15', '2026-02-01',
                    'en_curso', 'en_proceso', '11111111-1')`);
  await db.query(`INSERT INTO inventario.orden_trabajo (orden_trabajo_id_orden, orden_trabajo_fecha_hora, orden_trabajo_estado,
                    area_trabajo_id_area, usuario_id_usuario, proyecto_id_proyecto)
                  OVERRIDING SYSTEM VALUE VALUES (10, '2026-06-10', 'en_curso', 1, 2, 2)`);
  await db.query(`INSERT INTO inventario.material_orden_trabajo (material_sku, orden_trabajo_id_orden, material_orden_trabajo_consumo_estimado)
                  VALUES ('MAT-UNO', 10, 5), ('MAT-HERR', 2, 1)`);
  // Una alerta por caso: OT 1 (proyecto 1), OT 10 (proyecto 2) y una cuya única OT (la 2) está finalizada
  await db.query(`INSERT INTO inventario.alerta_faltante_pedido
                    (alerta_faltante_pedido_estado, material_sku, proyecto_id_proyecto, alerta_faltante_pedido_cantidad_requerida)
                  VALUES ('activa', 'MAT-FIFO', 1, 12), ('activa', 'MAT-UNO', 2, 5), ('activa', 'MAT-HERR', 1, 1)`);
});
after(async () => { await bajar(); await db.cerrar(); });

const buscar = async (texto) => {
  const r = await api('GET', `/api/alertas-faltantes?buscar=${encodeURIComponent(texto)}`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body.map(a => a.sku).sort();
};

describe('Búsqueda de faltantes de OT (B-13)', () => {
  test('por SKU y por nombre del material, como antes; sin texto trae todas', async () => {
    assert.deepEqual(await buscar('mat-fifo'), ['MAT-FIFO']);
    const { rows } = await db.query(`SELECT material_nombre_material AS n FROM inventario.material WHERE material_sku = 'MAT-UNO'`);
    assert.ok((await buscar(rows[0].n)).includes('MAT-UNO'));
    assert.deepEqual(await buscar(''), ['MAT-FIFO', 'MAT-HERR', 'MAT-UNO']);
  });

  test('por código o nombre del proyecto, sin importar mayúsculas', async () => {
    assert.deepEqual(await buscar('pry-norte'), ['MAT-UNO']);
    assert.deepEqual(await buscar('edificio'), ['MAT-UNO']);
    assert.deepEqual(await buscar('PRY-TEST'), ['MAT-FIFO', 'MAT-HERR']);
  });

  test('por número de OT, en sus formas, trae solo las alertas de esa OT', async () => {
    for (const t of ['#10', 'OT 10', 'ot-10', 'OT#10']) assert.deepEqual(await buscar(t), ['MAT-UNO'], t);
    assert.ok((await buscar('10')).includes('MAT-UNO'));      // "10" a secas también busca como texto
    assert.deepEqual(await buscar('#1'), ['MAT-FIFO']);
  });

  test('una OT cerrada no es afectada: buscarla no trae su alerta', async () => {
    assert.deepEqual(await buscar('#2'), []);
  });
});

/**
 * B-37: una alerta activa cuyo stock subió pasa sola a "en gestión" al listar (CU-114 CP2) y salía del
 * filtro "Activas", que era el que traía la pantalla al abrir. "Abiertas" la sigue mostrando.
 */
describe('Filtro Abiertas (B-37)', () => {
  test('la alerta que pasó sola a en gestión sigue en Abiertas; resueltas y descartadas no', async () => {
    await db.query(`INSERT INTO inventario.alerta_faltante_pedido
                      (alerta_faltante_pedido_estado, material_sku, proyecto_id_proyecto, alerta_faltante_pedido_cantidad_requerida)
                    VALUES ('resuelta', 'MAT-UNO', 2, 5), ('descartada', 'MAT-HERR', 1, 1)`);
    const lista = async (estado) => {
      const r = await api('GET', `/api/alertas-faltantes?estado=${estado}`);
      assert.equal(r.status, 200, JSON.stringify(r.body));
      return r.body;
    };

    // MAT-FIFO tiene stock: la primera carga de "Activas" la pasa a en gestión y la siguiente ya no la trae
    assert.ok((await lista('activa')).some(a => a.sku === 'MAT-FIFO'));
    assert.ok(!(await lista('activa')).some(a => a.sku === 'MAT-FIFO'));

    const abiertas = await lista('abiertas');
    assert.equal(abiertas.find(a => a.sku === 'MAT-FIFO')?.estado, 'en_gestion');
    assert.ok(abiertas.every(a => ['activa', 'en_gestion', 'solicitud_emitida'].includes(a.estado)),
      JSON.stringify(abiertas.map(a => a.estado)));
    assert.equal((await lista('resuelta')).length, 1);
  });
});
