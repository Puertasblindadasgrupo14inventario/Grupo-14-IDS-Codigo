const { test, before, after, beforeEach, describe } = require('node:test');
const assert = require('node:assert/strict');
const { bajar } = require('./helpers/api');
const db = require('./helpers/db');
const { datosPersona } = require('../scripts/datosPersona');

/**
 * F-46 (Ley 21.719, art. 5): la consulta "datos de una persona" para responder una solicitud de acceso.
 *
 * Lo que protegen:
 *  - Se encuentra a la persona por su usuario, su correo (sin importar mayúsculas) o su RUT (con o sin
 *    puntos), y se juntan sus datos de usuario, de empleado, de cliente y de proveedor.
 *  - Nunca sale la contraseña, y del empleado solo lo que Inventario lee de Finanzas.
 *  - Sus registros se cuentan en las tablas que apuntan a ella, encontradas solas.
 *  - Un identificador que calza con dos usuarios se rechaza, en vez de mezclar personas.
 *  - La consulta solo lee: lo único que escribe es un evento de auditoría, sin el RUT ni el correo.
 */

before(async () => { await db.resetear(); });
beforeEach(async () => {
  await db.resetear();
  // jop.test (id 2, responsable de las OT 1 y 3 de la semilla) con correo, RUT, empleado y contraseña
  await db.query(`UPDATE usuario SET usuario_correo = 'jop@test.cl', usuario_rut_usuario = '12345678-5',
                    usuario_nombre_completo_primer_nombre_usuario = 'Juan', empleado_rut_empleado = '22222222-2'
                  WHERE usuario_id_usuario = 2`);
  await db.query(`INSERT INTO usuario_contrasena (usuario_id_usuario, usuario_contrasena)
                  VALUES (2, '$2b$04$hashquenodebesalir')`);
});
after(async () => { await bajar(); await db.cerrar(); });

const ultimoDetalle = async () => (await db.query(
  `SELECT COALESCE(observacion, registro_afectado) AS d FROM finanzas.evento_auditoria
   WHERE accion_realizada = 'exportar_datos_persona' ORDER BY id_evento DESC LIMIT 1`)).rows[0]?.d;

describe('F-46: datos de una persona', () => {
  test('por usuario: sus datos, su empleado, sus registros y su auditoría, sin la contraseña', async () => {
    await db.query(`INSERT INTO finanzas.evento_auditoria (id_usuario, accion_realizada, entidad_afectada, registro_afectado, ip_origen)
                    VALUES (2, 'login', 'inventario', 'Inicio de sesión: jop.test', '10.0.0.7'),
                           (1, 'editar_permisos', 'inventario', 'jop.test: rol tecnico → jop', NULL)`);
    const r = await datosPersona('jop.test');

    assert.equal(r.encontrado, true);
    assert.equal(r.usuario.id, 2);
    assert.equal(r.usuario.correo, 'jop@test.cl');
    assert.ok(!JSON.stringify(r).includes('hashquenodebesalir'), 'la contraseña no debe salir');

    assert.equal(r.empleado_finanzas.length, 1);
    assert.deepEqual(Object.keys(r.empleado_finanzas[0]).sort(), ['cargo', 'estado', 'nombre', 'rut']);

    const ot = r.registros.find(x => x.tabla === 'orden_trabajo' && x.por === 'usuario');
    assert.ok(ot && ot.cantidad >= 2, JSON.stringify(r.registros));
    assert.ok(!r.registros.some(x => x.tabla === 'usuario_contrasena'));

    assert.equal(r.auditoria.eventos.length, 1);
    assert.equal(r.auditoria.eventos[0].ip, '10.0.0.7');
    assert.equal(r.auditoria.eventos[0].accion, 'inició sesión');
    assert.equal(r.auditoria.menciones_por_otros, 1);
  });

  test('por correo (otra mayúscula) o por RUT con puntos se encuentra a la misma persona', async () => {
    assert.equal((await datosPersona('JOP@test.cl')).usuario.id, 2);
    assert.equal((await datosPersona('12.345.678-5')).usuario.id, 2);
  });

  test('un cliente por su RUT y un contacto de proveedor por su correo', async () => {
    const c = await datosPersona('11.111.111-1');
    assert.equal(c.usuario, null);
    assert.equal(c.clientes.length, 1);
    assert.equal(c.clientes[0].razon_social, 'Cliente Test');

    await db.query(`INSERT INTO proveedor_contacto_correo VALUES (1, 'ana@proveedor.cl')`);
    const p = await datosPersona('ana@proveedor.cl');
    assert.equal(p.proveedores.length, 1);
    assert.equal(p.proveedores[0].id, 1);
    assert.equal(p.proveedores[0].contacto, 'Ana Rojas');
    assert.deepEqual(p.proveedores[0].correos, ['ana@proveedor.cl']);
  });

  test('sin datos lo dice; un identificador que calza con dos usuarios se rechaza', async () => {
    const n = await datosPersona('nadie@test.cl');
    assert.equal(n.encontrado, false);
    assert.equal(await ultimoDetalle(), 'Solicitud de acceso (Ley 21.719, art. 5): sin datos en el sistema');

    // el correo de tecnico.test es igual al nombre de usuario de jop.test
    await db.query(`UPDATE usuario SET usuario_correo = 'jop.test' WHERE usuario_id_usuario = 3`);
    await assert.rejects(datosPersona('jop.test'), /coincide con 2 usuarios/);
    await assert.rejects(datosPersona('  '), /Indique/);
  });

  test('solo lee: el usuario queda igual y la auditoría guarda a quién, sin el RUT ni el correo', async () => {
    const foto = async () => JSON.stringify((await db.query(`SELECT * FROM usuario ORDER BY 1`)).rows);
    const antes = await foto();
    const { rows: [{ n: n0 }] } = await db.query(`SELECT count(*)::int AS n FROM finanzas.evento_auditoria`);

    await datosPersona('12345678-5');

    assert.equal(await foto(), antes);
    const { rows: [{ n: n1 }] } = await db.query(`SELECT count(*)::int AS n FROM finanzas.evento_auditoria`);
    assert.equal(n1, n0 + 1);
    const d = await ultimoDetalle();
    assert.equal(d, 'Solicitud de acceso (Ley 21.719, art. 5): usuario #2, empleado de Finanzas');
    for (const v of ['12345678', 'jop@test.cl', '22222222']) assert.ok(!d.includes(v), `no debe guardar ${v}`);
  });
});
