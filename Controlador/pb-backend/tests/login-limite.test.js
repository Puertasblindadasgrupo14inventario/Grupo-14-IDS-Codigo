const { test, before, after, beforeEach, describe } = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcrypt');
const { api, bajar, levantar } = require('./helpers/api');
const db = require('./helpers/db');
const { reiniciarLimitesLogin, adelantarRelojLogin } = require('../src/controllers/authController');

/**
 * Límite de intentos del login y cabeceras de seguridad (F-02: S-03 y S-05; F-36).
 *
 * Lo que se protege: tras 5 fallos seguidos un usuario queda bloqueado aunque luego llegue la
 * contraseña correcta (si no, adivinar contraseñas no tendría freno); F-36: el bloqueo crece
 * (1, 5 y 15 min) si sigue fallando, y se olvida tras 1 hora sin fallos; el bloqueo es de ESE
 * usuario, no de los demás; un éxito antes del quinto fallo limpia la cuenta; gerencia lo puede
 * desbloquear (con firma); y una misma IP con 30 fallos queda bloqueada aunque pruebe usuarios
 * distintos. En los tests todas las peticiones vienen de la misma IP (127.0.0.1).
 */

const MIN = 60 * 1000;

before(async () => { await db.resetear(); });
beforeEach(async () => { await db.resetear(); reiniciarLimitesLogin(); });
after(async () => { await bajar(); await db.cerrar(); reiniciarLimitesLogin(); });

const CLAVE = 'clave-de-prueba';

/** Contraseña conocida para un usuario de la semilla (1 = gerente.test, 2 = jop.test). */
async function conClave(id, clave = CLAVE) {
  await db.query(
    `INSERT INTO inventario.usuario_contrasena (usuario_id_usuario, usuario_contrasena) VALUES ($1, $2)`,
    [id, await bcrypt.hash(clave, 4)]
  );
}

const login = (username, password) =>
  api('POST', '/api/auth/login', { body: { username, password }, sinToken: true });

describe('Límite por usuario (S-03)', () => {
  test('5 fallos bloquean al usuario: el 6.º intento da 429 aunque la contraseña sea correcta', async () => {
    await conClave(1);
    for (let i = 0; i < 5; i++) assert.equal((await login('gerente.test', 'mala')).status, 401);

    const r = await login('gerente.test', CLAVE);
    assert.equal(r.status, 429);
    assert.match(r.body.error, /intentos fallidos/);
    assert.equal(await db.contar('finanzas.evento_auditoria', `accion_realizada = 'login'`), 0);
  });

  test('el bloqueo es de ese usuario: otro usuario sigue entrando', async () => {
    await conClave(1);
    await conClave(2);
    for (let i = 0; i < 5; i++) await login('gerente.test', 'mala');

    assert.equal((await login('jop.test', CLAVE)).status, 200);
  });

  test('no distingue mayúsculas: cambiar el usuario de forma no salta el bloqueo', async () => {
    await conClave(1);
    for (let i = 0; i < 5; i++) await login('gerente.test', 'mala');

    assert.equal((await login('GERENTE.TEST', 'mala')).status, 429);
  });

  test('un éxito antes del 5.º fallo limpia la cuenta del usuario', async () => {
    await conClave(1);
    for (let i = 0; i < 4; i++) await login('gerente.test', 'mala');
    assert.equal((await login('gerente.test', CLAVE)).status, 200);

    for (let i = 0; i < 4; i++) assert.equal((await login('gerente.test', 'mala')).status, 401);
    assert.equal((await login('gerente.test', CLAVE)).status, 200);
  });
});

describe('Bloqueo progresivo (F-36)', () => {
  const fallar = (n, usuario = 'gerente.test') => (async () => {
    for (let i = 0; i < n; i++) assert.equal((await login(usuario, 'mala')).status, 401);
  })();

  test('el 5.º fallo bloquea 1 minuto; al vencer, la contraseña correcta entra', async () => {
    await conClave(1);
    await fallar(5);
    const r = await login('gerente.test', CLAVE);
    assert.equal(r.status, 429);
    assert.match(r.body.error, /1 minuto\b/);

    adelantarRelojLogin(1 * MIN + 1000);
    assert.equal((await login('gerente.test', CLAVE)).status, 200);
  });

  test('si sigue fallando, el bloqueo crece: 5 minutos y después 15 (el tope)', async () => {
    await conClave(1);
    await fallar(5);
    adelantarRelojLogin(1 * MIN + 1000);
    await fallar(1);                                                   // 6.º
    assert.match((await login('gerente.test', CLAVE)).body.error, /5 minutos/);

    adelantarRelojLogin(5 * MIN + 1000);
    await fallar(1);                                                   // 7.º
    assert.match((await login('gerente.test', CLAVE)).body.error, /15 minutos/);

    adelantarRelojLogin(15 * MIN + 1000);
    await fallar(1);                                                   // 8.º: sigue en el tope
    assert.match((await login('gerente.test', CLAVE)).body.error, /15 minutos/);

    const bloqueos = (await db.query(
      `SELECT registro_afectado AS d FROM finanzas.evento_auditoria WHERE accion_realizada = 'bloqueo_login' ORDER BY id_evento`)).rows;
    assert.deepEqual(bloqueos.map(b => b.d.match(/bloqueado (\d+)/)[1]), ['1', '5', '15', '15']);
  });

  test('tras 1 hora sin fallos la cuenta vuelve a cero', async () => {
    await conClave(1);
    await fallar(4);
    adelantarRelojLogin(61 * MIN);
    await fallar(4);                                                   // serían el 5.º a 8.º si no se olvidara
    assert.equal((await login('gerente.test', CLAVE)).status, 200);
  });

  test('gerencia desbloquea el ingreso (con firma); la lista lo muestra bloqueado hasta entonces', async () => {
    await conClave(2);
    await fallar(5, 'jop.test');
    const lista = await api('GET', '/api/usuarios');
    assert.ok(lista.body.find(u => u.username === 'jop.test').ingreso_bloqueado_hasta);
    assert.equal(lista.body.find(u => u.username === 'gerente.test').ingreso_bloqueado_hasta, null);

    assert.equal((await api('POST', '/api/usuarios/2/desbloquear-ingreso', { rol: 'jop' })).status, 403);
    assert.equal((await api('POST', '/api/usuarios/2/desbloquear-ingreso', { sinFirma: true })).status, 428);
    assert.equal((await login('jop.test', CLAVE)).status, 429);

    const r = await api('POST', '/api/usuarios/2/desbloquear-ingreso');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.desbloqueado, true);
    assert.equal((await login('jop.test', CLAVE)).status, 200);
    assert.equal(await db.contar('finanzas.evento_auditoria', `accion_realizada = 'desbloquear_ingreso'`), 1);
  });
});

describe('Límite por IP (S-03)', () => {
  test('30 fallos desde la misma IP la bloquean, también para un usuario sin fallos', async () => {
    await conClave(2);
    for (let i = 0; i < 30; i++) {
      assert.equal((await login(`no.existe.${i}`, 'mala')).status, 401);
    }

    const r = await login('jop.test', CLAVE);
    assert.equal(r.status, 429);
  });
});

describe('Cabeceras de seguridad de la API (S-05)', () => {
  test('nosniff, sin marcos, sin referer, sin caché y sin X-Powered-By', async () => {
    const res = await fetch((await levantar()) + '/api/health');
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(res.headers.get('x-frame-options'), 'DENY');
    assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.equal(res.headers.get('x-powered-by'), null);
  });
});
