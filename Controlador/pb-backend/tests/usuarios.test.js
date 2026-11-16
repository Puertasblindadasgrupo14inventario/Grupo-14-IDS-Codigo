const { test, before, after, beforeEach, describe } = require('node:test');
const assert = require('node:assert/strict');
const { api, bajar } = require('./helpers/api');
const db = require('./helpers/db');
const { aplicarProgramaciones } = require('../src/controllers/usuariosController');

/**
 * Gestion de usuarios (pantalla Usuarios, solo gerencia).
 *
 * Lo que protegen:
 *  - D68: la cuenta solo guarda 'activo' o 'inactivo'. La pantalla mandaba 'activa' y el
 *    filtro "Activos" escondia a los usuarios guardados como 'activo'. Se acepta la forma
 *    femenina en la entrada, pero se guarda la masculina, y el CHECK del DDL rechaza otra.
 *
 * Semilla: gerente.test (id 1) y jop.test (id 2), los dos 'activo'.
 */

before(async () => { await db.resetear(); });
beforeEach(async () => { await db.resetear(); });
after(async () => { await bajar(); await db.cerrar(); });

const estadoDe = async (username) => {
  const { rows } = await db.query(
    `SELECT usuario_estado_cuenta AS estado FROM inventario.usuario WHERE usuario_username = $1`, [username]
  );
  return rows[0]?.estado;
};

const crear = (extra = {}) => api('POST', '/api/usuarios', {
  body: { username: 'nuevo.test', password: 'Clave12345', nombre: 'Nuevo', apellido: 'Test', rol: 'jop', ...extra },
});

describe('D68: estado de la cuenta', () => {
  test('crear sin estado guarda activo', async () => {
    const r = await crear();
    assert.equal(r.status, 201);
    assert.equal(await estadoDe('nuevo.test'), 'activo');
  });

  test('crear con "activa" guarda activo', async () => {
    const r = await crear({ estado: 'activa' });
    assert.equal(r.status, 201);
    assert.equal(await estadoDe('nuevo.test'), 'activo');
  });

  test('crear con un estado desconocido → 400 y no crea el usuario', async () => {
    const r = await crear({ estado: 'suspendido' });
    assert.equal(r.status, 400);
    assert.equal(await estadoDe('nuevo.test'), undefined);
  });

  test('editar con "inactiva" y luego "activa" guarda inactivo y activo', async () => {
    const { body } = await crear();
    let r = await api('PUT', `/api/usuarios/${body.id}/permisos`, { body: { rol: 'jop', estado: 'inactiva' } });
    assert.equal(r.status, 200);
    assert.equal(await estadoDe('nuevo.test'), 'inactivo');

    r = await api('PUT', `/api/usuarios/${body.id}/permisos`, { body: { rol: 'jop', estado: 'activa' } });
    assert.equal(r.status, 200);
    assert.equal(await estadoDe('nuevo.test'), 'activo');
  });

  test('editar con un estado desconocido → 400 y no cambia nada', async () => {
    const r = await api('PUT', '/api/usuarios/2/permisos', { body: { rol: 'jop', estado: 'suspendido' } });
    assert.equal(r.status, 400);
    assert.equal(await estadoDe('jop.test'), 'activo');
  });

  test('el filtro de activos trae a todos los activos, se pida "activo" o "activa"', async () => {
    await db.query(`UPDATE inventario.usuario SET usuario_estado_cuenta = 'inactivo' WHERE usuario_id_usuario = 2`);
    for (const estado of ['activo', 'activa']) {
      const r = await api('GET', `/api/usuarios?estado=${estado}`);
      assert.equal(r.status, 200);
      // B-01: la semilla tiene un usuario por rol; todos activos salvo el jop desactivado arriba
      assert.deepEqual(r.body.map(u => u.username).sort(),
        ['admin.test', 'gerente.test', 'secretaria.test', 'tecnico.test']);
    }
    const r = await api('GET', '/api/usuarios?estado=inactivo');
    assert.deepEqual(r.body.map(u => u.username), ['jop.test']);
  });

  test('la BD rechaza un estado fuera de activo / inactivo', async () => {
    await assert.rejects(
      db.query(`UPDATE inventario.usuario SET usuario_estado_cuenta = 'activa' WHERE usuario_id_usuario = 2`),
      /ck_usuario_estado_cuenta/
    );
  });
});

describe('editar permisos sin rol', () => {
  const rolesDe = async (id) => {
    const { rows } = await db.query(
      `SELECT usuario_es_gerencia AS gerencia, usuario_es_jop AS jop FROM inventario.usuario WHERE usuario_id_usuario = $1`, [id]
    );
    return rows[0];
  };

  test('solo con estado conserva el rol del unico gerente', async () => {
    const r = await api('PUT', '/api/usuarios/1/permisos', { body: { estado: 'activo' } });
    assert.equal(r.status, 200);
    assert.deepEqual(await rolesDe(1), { gerencia: true, jop: false });
  });

  test('solo con estado conserva el rol de un gerente que se desactiva', async () => {
    // Usuario nuevo: jop.test tiene OT abiertas en la semilla y no se puede desactivar
    const { body } = await crear({ rol: 'gerencia' });
    const r = await api('PUT', `/api/usuarios/${body.id}/permisos`, { body: { estado: 'inactivo' } });
    assert.equal(r.status, 200);
    assert.deepEqual(await rolesDe(body.id), { gerencia: true, jop: false });
    assert.equal(await estadoDe('nuevo.test'), 'inactivo');
  });
});

/**
 * B-04: las programaciones de cuentas las aplica el backend (timer de 1 minuto en index.js, que
 * en los tests no corre: aquí se llama a aplicarProgramaciones directamente), y la lista muestra
 * el estado efectivo aunque el timer todavía no haya pasado.
 */
describe('Programaciones de cuentas (B-04)', () => {
  const programar = (username, columna, intervalo) => db.query(
    `UPDATE inventario.usuario SET ${columna} = now() + $2::interval WHERE usuario_username = $1`, [username, intervalo]);

  test('la lista muestra inactiva una cuenta con la desactivación vencida, también al filtrar', async () => {
    await programar('jop.test', 'usuario_desactivacion_programada', '-1 minute');
    const r = await api('GET', '/api/usuarios');
    assert.equal(r.body.find(u => u.username === 'jop.test').estado, 'inactivo');
    const inactivos = await api('GET', '/api/usuarios?estado=inactivo');
    assert.ok(inactivos.body.some(u => u.username === 'jop.test'));
    assert.equal(await estadoDe('jop.test'), 'activo', 'la lista no escribe: eso lo hace el timer');
  });

  test('aplicarProgramaciones desactiva y activa las vencidas, limpia la programación, notifica y audita', async () => {
    await programar('jop.test', 'usuario_desactivacion_programada', '-1 minute');
    await db.query(`UPDATE inventario.usuario SET usuario_estado_cuenta = 'inactivo' WHERE usuario_username = 'tecnico.test'`);
    await programar('tecnico.test', 'usuario_activacion_programada', '-1 minute');

    const r = await aplicarProgramaciones();
    assert.deepEqual([r.desactivados, r.activados], [['jop.test'], ['tecnico.test']]);
    assert.equal(await estadoDe('jop.test'), 'inactivo');
    assert.equal(await estadoDe('tecnico.test'), 'activo');
    assert.equal(await db.contar('inventario.usuario',
      `usuario_desactivacion_programada IS NOT NULL OR usuario_activacion_programada IS NOT NULL`), 0);
    assert.ok(await db.contar('inventario.notificacion', `notificacion_tipo_notificacion = 'programacion_ejecutada'`) >= 2);
    assert.equal(await db.contar('finanzas.evento_auditoria', `accion_realizada = 'programacion_ejecutada'`), 2);
  });

  test('una programación futura no se aplica ni cambia la lista', async () => {
    await programar('jop.test', 'usuario_desactivacion_programada', '1 hour');
    assert.equal((await aplicarProgramaciones()).procesadas, 0);
    assert.equal(await estadoDe('jop.test'), 'activo');
    const r = await api('GET', '/api/usuarios');
    assert.equal(r.body.find(u => u.username === 'jop.test').estado, 'activo');
  });
});

/**
 * B-19: los 5 roles. La lista mostraba "otro" (y el modal, "Gerencia") para técnico, administrador y
 * secretaria, y cambiar un técnico a jop no tenía efecto: solo se tocaban las marcas de gerencia y jop.
 * Semilla: un usuario por rol (1 gerente.test, 2 jop.test, 3 tecnico.test, 4 secretaria.test, 5 admin.test).
 */
describe('Los 5 roles (B-19)', () => {
  const marcas = async (id) => {
    const { rows } = await db.query(
      `SELECT usuario_es_gerencia AS gerencia, usuario_es_jop AS jop, usuario_es_tecnico AS tecnico,
              usuario_es_administrador AS administrador, usuario_es_secretaria AS secretaria
       FROM inventario.usuario WHERE usuario_id_usuario = $1`, [id]);
    return Object.entries(rows[0]).filter(([, v]) => v).map(([k]) => k);
  };
  const rolEnLista = async (username) => (await api('GET', '/api/usuarios')).body.find(u => u.username === username)?.rol;

  test('la lista muestra el rol real de cada uno y filtra por cualquiera de los 5', async () => {
    const r = await api('GET', '/api/usuarios');
    const porUsuario = Object.fromEntries(r.body.map(u => [u.username, u.rol]));
    assert.deepEqual(
      ['gerente.test', 'jop.test', 'tecnico.test', 'secretaria.test', 'admin.test'].map(u => porUsuario[u]),
      ['gerencia', 'jop', 'tecnico', 'secretaria', 'administrador']);
    const tecnicos = await api('GET', '/api/usuarios?rol=tecnico');
    assert.deepEqual(tecnicos.body.map(u => u.username), ['tecnico.test']);
  });

  test('cambiar un técnico a jop deja una sola marca y su rol pasa a jop; y de vuelta', async () => {
    assert.equal((await api('PUT', '/api/usuarios/3/permisos', { body: { rol: 'jop' } })).status, 200);
    assert.deepEqual(await marcas(3), ['jop']);
    assert.equal(await rolEnLista('tecnico.test'), 'jop');

    assert.equal((await api('PUT', '/api/usuarios/3/permisos', { body: { rol: 'tecnico' } })).status, 200);
    assert.deepEqual(await marcas(3), ['tecnico']);
  });

  test('un rol desconocido → 400 al editar y al crear, sin cambiar nada', async () => {
    const r = await api('PUT', '/api/usuarios/3/permisos', { body: { rol: 'otro' } });
    assert.equal(r.status, 400);
    assert.deepEqual(await marcas(3), ['tecnico']);
    assert.equal((await crear({ rol: 'otro' })).status, 400);
    assert.equal(await db.contar('inventario.usuario', `usuario_username = 'nuevo.test'`), 0);
  });

  test('crear con un rol que no es gerencia ni jop lo asigna', async () => {
    const r = await crear({ rol: 'secretaria' });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.deepEqual(await marcas(r.body.id), ['secretaria']);
  });

  test('la regla del último gerente sigue: no se le puede pasar a otro rol', async () => {
    const r = await api('PUT', '/api/usuarios/1/permisos', { body: { rol: 'administrador' } });
    assert.equal(r.status, 400);
    assert.deepEqual(await marcas(1), ['gerencia']);
  });
});

/**
 * Hallazgo 27/10 (pantalla Usuarios): el alta avisaba "deberá cambiar su contraseña en el primer
 * inicio de sesión" pero la guardaba como definitiva; no había dónde poner el RUT ni el empleado de
 * Finanzas (el cruce de F-13 y F-16), y al editar, el nombre y el correo se perdían sin aviso.
 * Semilla: empleado activo 22222222-2 en finanzas.empleado.
 */
describe('RUT, empleado y contraseña temporal', () => {
  const datosDe = async (username) => {
    const { rows } = await db.query(
      `SELECT u.usuario_rut_usuario AS rut, u.empleado_rut_empleado AS empleado, u.usuario_correo AS correo,
              u.usuario_nombre_completo_primer_nombre_usuario AS nombre,
              u.usuario_nombre_completo_primer_apellido_usuario AS apellido, c.es_temporal AS temporal
       FROM inventario.usuario u JOIN inventario.usuario_contrasena c USING (usuario_id_usuario)
       WHERE u.usuario_username = $1`, [username]);
    return rows[0];
  };
  const editar = (id, body) => api('PUT', `/api/usuarios/${id}/permisos`, { body });

  test('el alta deja la contraseña temporal (también para gerencia) y el login pide cambiarla', async () => {
    const r = await crear({ rol: 'gerencia', correo: 'nuevo@test.cl', rut: '12.345.678-5', empleado_rut: '22222222-2' });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.deepEqual(await datosDe('nuevo.test'), {
      rut: '12345678-5', empleado: '22222222-2', correo: 'nuevo@test.cl', nombre: 'Nuevo', apellido: 'Test', temporal: true,
    });
    const login = await api('POST', '/api/auth/login', { body: { username: 'nuevo.test', password: 'Clave12345' }, sinToken: true });
    assert.equal(login.status, 200);
    assert.equal(login.body.requiere_cambio_password, true);

    const lista = await api('GET', '/api/usuarios');
    const u = lista.body.find(x => x.username === 'nuevo.test');
    assert.deepEqual([u.rut, u.empleado_rut, u.empleado_nombre], ['12345678-5', '22222222-2', 'Empleado Test']);
  });

  test('RUT inválido o empleado que no es activo en Finanzas → 400 y no crea el usuario', async () => {
    await db.query(`INSERT INTO finanzas.empleado (empleado_rut_empleado, empleado_nombre_empleado_primer_nombre_empleado,
                      empleado_nombre_empleado_primer_apellido_empleado, empleado_estado, empleado_cargo_id_cargo,
                      empleado_tipo_vinculo_laboral_id_tipo_vinculo)
                    VALUES ('44444444-4', 'Ex', 'Empleado', 'inactivo', 1, 1)`);
    for (const extra of [{ rut: '12345678-9' }, { rut: 'abc' }, { empleado_rut: '99999999-9' }, { empleado_rut: '44444444-4' }]) {
      assert.equal((await crear(extra)).status, 400, JSON.stringify(extra));
    }
    assert.equal(await db.contar('inventario.usuario', `usuario_username = 'nuevo.test'`), 0);
  });

  test('un RUT de otro usuario → 409 al crear y al editar', async () => {
    assert.equal((await crear({ rut: '12345678-5' })).status, 201);
    const otro = await crear({ username: 'otro.test', rut: '11111111-1' });
    assert.equal(otro.status, 201);
    assert.equal((await crear({ username: 'tercero.test', rut: '12345678-5' })).status, 409);
    assert.equal((await editar(otro.body.id, { rut: '12345678-5' })).status, 409);
    assert.equal((await datosDe('otro.test')).rut, '11111111-1');
  });

  test('editar guarda nombre, correo, RUT y empleado; lo omitido se conserva y lo vacío se limpia', async () => {
    const { body } = await crear({ correo: 'nuevo@test.cl', rut: '12345678-5' });
    let r = await editar(body.id, { nombre: 'Renombrado', correo: 'otro@test.cl', empleado_rut: '22222222-2' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(await datosDe('nuevo.test'), {
      rut: '12345678-5', empleado: '22222222-2', correo: 'otro@test.cl', nombre: 'Renombrado', apellido: 'Test', temporal: true,
    });

    r = await editar(body.id, { rut: '', empleado_rut: null });
    assert.equal(r.status, 200);
    const d = await datosDe('nuevo.test');
    assert.deepEqual([d.rut, d.empleado, d.correo, d.nombre], [null, null, 'otro@test.cl', 'Renombrado']);
  });

  test('editar sin ningún dato → 400; con un RUT inválido → 400 y no cambia el rol ni el estado', async () => {
    assert.equal((await editar(2, {})).status, 400);
    const r = await editar(3, { rol: 'jop', rut: '12345678-9' });
    assert.equal(r.status, 400);
    const { rows } = await db.query(`SELECT usuario_es_tecnico AS tecnico FROM inventario.usuario WHERE usuario_id_usuario = 3`);
    assert.equal(rows[0].tecnico, true);
  });
});
