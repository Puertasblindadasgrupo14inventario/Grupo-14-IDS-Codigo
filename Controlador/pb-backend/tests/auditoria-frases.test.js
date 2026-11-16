const { test, before, after, beforeEach, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { api, bajar } = require('./helpers/api');
const db = require('./helpers/db');
const auditoria = require('../src/controllers/auditoriaController');
const { ETIQUETAS } = require('../src/config/auditoria');

/**
 * F-42: la auditoría en lenguaje natural.
 *
 * Lo que protegen:
 *  - Toda acción que el código registra tiene su etiqueta: una acción nueva sin etiqueta hace
 *    fallar este test (si no, la pantalla mostraría "realizó la acción «x»").
 *  - Un movimiento se lee como una frase con quién, qué, cuánto, de qué producto, dónde y para qué OT.
 *  - El evento que repite un movimiento (registrar_salida) no aparece dos veces en la lista,
 *    pero sigue disponible filtrando por él.
 *  - accion, detalle e ip siguen en la respuesta, como detalle técnico.
 */

before(async () => { await db.resetear(); });
beforeEach(async () => { await db.resetear(); });
after(async () => { await bajar(); await db.cerrar(); });

/** Archivos .js de src/, recursivo. */
function archivos(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e =>
    e.isDirectory() ? archivos(path.join(dir, e.name)) : e.name.endsWith('.js') ? [path.join(dir, e.name)] : []);
}

describe('etiquetas', () => {
  test('toda acción con nombre fijo que el código registra tiene etiqueta', () => {
    // registrar(usuario, 'accion', ...) y registrar(usuario, cond ? 'a' : 'b', ...)
    const re = /registrar\(\s*[^,()]+(?:\([^)]*\))?\s*,\s*(?:[^,]*\?\s*)?['`]([^'`]+)['`](?:\s*:\s*['`]([^'`]+)['`])?/g;
    const vistas = new Set();
    for (const f of archivos(path.join(__dirname, '..', 'src'))) {
      const texto = fs.readFileSync(f, 'utf8');
      for (const m of texto.matchAll(re)) for (const a of [m[1], m[2]]) if (a && !a.includes('${')) vistas.add(a);
    }
    // Las que se arman en una lista antes de registrarse (insumosEspecialesController)
    vistas.add('alerta_insumo_especial');
    vistas.add('descartar_alerta_insumo_especial');
    assert.ok(vistas.size > 100, `se esperaban más de 100 acciones, se encontraron ${vistas.size}`);
    const sinEtiqueta = [...vistas].filter(a => !ETIQUETAS[a]).sort();
    assert.deepEqual(sinEtiqueta, [], 'agregar la etiqueta en src/config/auditoria.js');
  });

  test('GET /auditoria/acciones devuelve el valor para filtrar y la etiqueta para mostrar', async () => {
    await auditoria.registrar(1, 'crear_unidad', 'Unidad #9: caja');
    const r = await api('GET', '/api/auditoria/acciones');
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.find(a => a.valor === 'crear_unidad'), { valor: 'crear_unidad', etiqueta: 'Creó una unidad de medida' });
  });
});

describe('frases', () => {
  test('una salida para una OT se lee como frase, con el nombre de quien la registró', async () => {
    await db.query(`UPDATE usuario SET usuario_nombre_completo_primer_nombre_usuario = 'Ana',
                      usuario_nombre_completo_primer_apellido_usuario = 'Pérez' WHERE usuario_id_usuario = 1`);
    const s = await api('POST', '/api/movimientos/salida', {
      body: { sku: 'MAT-FIFO', bodega_id: 1, cantidad: 3, tipo_movimiento_id: 2, motivo_id: 2 },
    });
    assert.equal(s.status, 201);
    // La salida audita sin esperar (después de responder): se espera a que el evento esté escrito
    for (let i = 0; i < 40; i++) {
      const { rows } = await db.query(`SELECT 1 FROM finanzas.evento_auditoria WHERE accion_realizada = 'registrar_salida'`);
      if (rows.length) break;
      await new Promise(res => setTimeout(res, 50));
    }
    const { rows: [ot] } = await db.query(`SELECT MIN(orden_trabajo_id_orden)::int AS id FROM orden_trabajo`);
    await db.query(`UPDATE movimiento_inventario SET orden_trabajo_id_orden = $1`, [ot.id]);

    const r = await api('GET', '/api/usuarios/auditoria');
    assert.equal(r.status, 200);
    const mov = r.body.find(f => f.accion === 'registrar_movimiento');
    assert.match(mov.frase, new RegExp(
      `^Ana Pérez registró una salida de 3 \\S+ de Material con dos lotes \\(MAT-FIFO\\) desde Bodega Test para la OT #${ot.id}\\. Motivo: consumo produccion\\.$`));
    // El detalle técnico sigue como antes
    assert.match(mov.detalle, /SKU MAT-FIFO/);
    assert.equal(mov.usuario, 'gerente.test');

    // El evento registrar_salida dice lo mismo: no se repite en la lista, pero se puede filtrar
    assert.equal(r.body.filter(f => f.accion === 'registrar_salida').length, 0);
    const filtrada = await api('GET', '/api/usuarios/auditoria?accion=registrar_salida');
    assert.equal(filtrada.body.length, 1);
    assert.match(filtrada.body[0].frase, /^Ana Pérez registró una salida: SKU: MAT-FIFO/);
  });

  test('un evento usa su etiqueta y su detalle; sin nombre, el usuario; sin etiqueta, un respaldo legible', async () => {
    await auditoria.registrar(2, 'crear_unidad', 'Unidad #9: caja');
    await auditoria.registrar(2, 'accion_desconocida_f42', 'algo');
    const r = await api('GET', '/api/usuarios/auditoria');
    const frase = (accion) => r.body.find(f => f.accion === accion)?.frase;
    assert.equal(frase('crear_unidad'), 'jop.test creó una unidad de medida: Unidad #9: caja');
    assert.equal(frase('accion_desconocida_f42'), 'jop.test realizó la acción «accion_desconocida_f42»: algo');
    assert.equal(r.body.find(f => f.accion === 'crear_unidad').etiqueta, 'creó una unidad de medida');
  });

  test('el login no repite su detalle y el intento de un usuario inexistente va sin sujeto (F-42)', async () => {
    await auditoria.registrar(1, 'login', 'Inicio de sesión: gerente.test', { ip: '10.0.0.1' });
    await auditoria.registrar(null, 'login_fallido', 'Usuario inexistente: "nadie"', { ip: '10.0.0.2' });
    const r = await api('GET', '/api/usuarios/auditoria');
    const login = r.body.find(f => f.accion === 'login');
    assert.equal(login.frase, 'gerente.test inició sesión.');
    assert.equal(login.detalle, 'Inicio de sesión: gerente.test');
    assert.equal(login.ip, '10.0.0.1');
    assert.equal(r.body.find(f => f.accion === 'login_fallido').frase,
      'Intento fallido de iniciar sesión: Usuario inexistente: "nadie"');
  });
});

/**
 * F-42b: el texto guardado dice qué cambió, con el valor anterior y el nuevo, y con nombres en vez
 * de ids. Algunas rutas auditan sin esperar (después de responder): se espera a que el evento exista.
 */
async function ultimoDetalle(accion) {
  for (let i = 0; i < 40; i++) {
    const { rows } = await db.query(
      `SELECT COALESCE(observacion, registro_afectado) AS d FROM finanzas.evento_auditoria
       WHERE accion_realizada = $1 ORDER BY id_evento DESC LIMIT 1`, [accion]);
    if (rows.length) return rows[0].d;
    await new Promise(res => setTimeout(res, 50));
  }
  return null;
}

describe('F-42b: qué cambió', () => {
  test('editar un producto: los campos que cambiaron, con antes y después; sin cambios lo dice', async () => {
    const r = await api('PUT', '/api/materiales/MAT-FIFO', { body: { estado: 'inactivo', descripcion: 'otra descripción' } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(await ultimoDetalle('Editar material'),
      'Material con dos lotes (MAT-FIFO): estado activo → inactivo; cambió la descripción');

    await db.query(`DELETE FROM finanzas.evento_auditoria`);
    await api('PUT', '/api/materiales/MAT-FIFO', { body: { estado: 'inactivo' } });
    assert.equal(await ultimoDetalle('Editar material'), 'Material con dos lotes (MAT-FIFO): sin cambios');
  });

  test('editar un proveedor, una bodega, un usuario y una herramienta dice qué cambió', async () => {
    assert.equal((await api('PUT', '/api/proveedores/1', { body: { rubro: 'Ferretería' } })).status, 200);
    assert.equal(await ultimoDetalle('editar_proveedor'), '"Proveedor Test": rubro Aceros → Ferretería');

    assert.equal((await api('PUT', '/api/bodegas/2', { body: { nombre: 'Bodega Norte' } })).status, 200);
    assert.equal(await ultimoDetalle('Editar bodega'), '"Bodega Norte": nombre Bodega Secundaria → Bodega Norte');

    assert.equal((await api('PUT', '/api/usuarios/3/permisos', { body: { rol: 'jop' } })).status, 200);
    assert.equal(await ultimoDetalle('editar_permisos'), 'tecnico.test: rol tecnico → jop');

    assert.equal((await api('PUT', '/api/herramientas/MAT-HERR', { body: { valor_adquisicion: 12500 } })).status, 200);
    assert.equal(await ultimoDetalle('Actualizar herramienta'),
      'Herramienta de prueba (MAT-HERR): valor de adquisición — → 12.500');
  });

  // B-38: la exportación dice qué se exportó, no la ruta de la API
  // (se audita al pedirla, antes de armarla: la semana de la semilla puede no tener datos y responder 400)
  test('exportar la programación semanal dice qué y en qué formato, sin la ruta', async () => {
    await api('GET', '/api/reportes/programacion-semanal/exportar');
    assert.equal(await ultimoDetalle('exportar_reporte'), 'la programación semanal, en CSV');
    await db.query(`DELETE FROM finanzas.evento_auditoria`);
    await api('GET', '/api/reportes/programacion-semanal/exportar-pdf');
    assert.equal(await ultimoDetalle('exportar_reporte'), 'la programación semanal, en PDF');
  });

  // B-36 (D94, Ley 21.719): un dato personal se nombra, pero su valor anterior y el nuevo no se guardan
  test('editar datos personales de un usuario o un proveedor dice qué cambió, sin los valores', async () => {
    const { rows: [u] } = await db.query(
      `SELECT usuario_correo AS correo, usuario_rut_usuario AS rut FROM usuario WHERE usuario_id_usuario = 3`);
    const r = await api('PUT', '/api/usuarios/3/permisos',
      { body: { rol: 'jop', correo: 'nuevo.correo@test.cl', rut: '12345678-5' } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const du = await ultimoDetalle('editar_permisos');
    assert.equal(du, 'tecnico.test: rol tecnico → jop; cambió el correo; cambió el RUT');
    for (const v of [u.correo, u.rut, 'nuevo.correo@test.cl', '12345678']) {
      if (v) assert.ok(!du.includes(v), `la auditoría no debe guardar ${v}`);
    }

    const { rows: [p] } = await db.query(
      `SELECT proveedor_contacto_primer_nombre AS contacto FROM proveedor WHERE proveedor_id_proveedor = 1`);
    const rp = await api('PUT', '/api/proveedores/1', { body: {
      rubro: 'Ferretería', contacto_nombre: 'Rosa', telefonos: ['+56 9 1111 2222'], correos: ['ventas.nuevo@test.cl'] } });
    assert.equal(rp.status, 200, JSON.stringify(rp.body));
    const dp = await ultimoDetalle('editar_proveedor');
    assert.equal(dp,
      '"Proveedor Test": rubro Aceros → Ferretería; cambió el contacto; cambió los teléfonos; cambió los correos');
    for (const v of [p.contacto, 'Rosa', '1111 2222', 'ventas.nuevo@test.cl']) {
      if (v) assert.ok(!dp.includes(v), `la auditoría no debe guardar ${v}`);
    }
  });

  test('editar una receta dice qué insumo cambió de cantidad y cuál se quitó', async () => {
    const r = await api('PUT', '/api/recetas/1', {
      body: { materiales: [{ sku: 'MAT-FIFO', cantidad_base: 3, merma: 0.25, area_id: 1 }] },
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(await ultimoDetalle('editar_receta'),
      'PB-TEST Puerta de prueba: Material con dos lotes (MAT-FIFO): cantidad 2 → 3; quitó Material crítico (MAT-CRIT) (1 insumo(s))');
  });

  test('una desactivación programada se audita con la hora de Chile, no la ISO en UTC', async () => {
    const fecha = new Date(Date.now() + 3 * 86400000);
    const r = await api('POST', '/api/usuarios/3/programar-desactivacion', { body: { fecha: fecha.toISOString() } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const d = await ultimoDetalle('programar_desactivacion');
    assert.match(d, /^tecnico\.test, para el \d{2}\/\d{2}\/\d{4} \d{2}:\d{2}$/);
    assert.ok(!d.includes('T') && !d.includes('usuario_id'));
  });

  test('resolver una alerta dice de qué tipo y de qué producto era', async () => {
    const { rows: [a] } = await db.query(
      `INSERT INTO alerta_inventario (alerta_inventario_mensaje, alerta_inventario_estado, material_sku,
                                      alerta_inventario_tipo_alerta_id_tipo_alerta)
       VALUES ('prueba', 'activa', 'MAT-CRIT', 2) RETURNING alerta_inventario_id_alerta::int AS id`);
    assert.equal((await api('PUT', `/api/alertas/${a.id}/resolver`)).status, 200);
    assert.equal(await ultimoDetalle('resolver_alerta'),
      `Alerta #${a.id} de stock critico: Material crítico (MAT-CRIT) marcada como resuelta`);
  });
});
