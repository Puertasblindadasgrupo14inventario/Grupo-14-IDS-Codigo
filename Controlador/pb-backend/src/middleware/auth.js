const jwt = require('jsonwebtoken');
const { query } = require('../db/pool');
const auditoria = require('../controllers/auditoriaController');

/**
 * B-01: rol a partir de los booleanos usuario_es_* (el modelo no tiene columna de rol).
 * Lo comparten login, /auth/me y el middleware, para que el orden sea uno solo.
 */
function rolDe(fila) {
  if (fila.es_gerencia) return 'gerencia';
  if (fila.es_tecnico)  return 'tecnico';
  if (fila.es_admin)    return 'administrador';
  if (fila.es_sec)      return 'secretaria';
  return 'jop';
}

/**
 * Verifica el token JWT en el header Authorization.
 * Si es válido, verifica que la cuenta siga activa en la BD y adjunta en req.user
 * el usuario LEÍDO DE LA BD (B-01): el rol del token es el del momento del login y
 * no se usa, así un cambio de rol corre desde el request siguiente.
 */
async function authMiddleware(req, res, next) {
  // B-45: index.js ya la corre antes de la barrera del módulo; el router no repite la consulta
  if (req.user) return next();
  const header = req.headers['authorization'];
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Token requerido' });
  }

  const token = header.split(' ')[1];
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    // B-02: los tokens con `tipo` (recuperación, autorización de CU-42) no son sesiones
    if (payload.tipo) return res.status(401).json({ error: 'Token inválido o expirado' });

    // Verificar que la cuenta sigue activa en la base de datos
    const { rows } = await query(
      `SELECT usuario_estado_cuenta            AS estado,
              usuario_username                 AS username,
              usuario_nombre_completo_primer_nombre_usuario   AS primer_nombre,
              usuario_nombre_completo_primer_apellido_usuario AS primer_apellido,
              usuario_es_gerencia              AS es_gerencia,
              usuario_es_tecnico               AS es_tecnico,
              usuario_es_administrador         AS es_admin,
              usuario_es_secretaria            AS es_sec,
              usuario_desactivacion_programada AS desactivacion_programada,
              usuario_activacion_programada    AS activacion_programada
       FROM inventario.usuario WHERE usuario_id_usuario = $1`,
      [payload.id]
    );

    if (!rows.length) {
      return res.status(401).json({ error: 'Cuenta desactivada. Contacte al administrador.' });
    }

    let estado = rows[0].estado;

    /* OPUS-8: aplicar aqui las programaciones vencidas del propio usuario.
       Asi la desactivacion surte efecto en su PROXIMO request, sin depender de un
       cron ni de que alguien abra el dashboard. */
    if (rows[0].activacion_programada && new Date(rows[0].activacion_programada) <= new Date()) {
      await query(
        `UPDATE inventario.usuario
         SET usuario_estado_cuenta = 'activo', usuario_activacion_programada = NULL
         WHERE usuario_id_usuario = $1`,
        [payload.id]
      );
      estado = 'activo';
      await auditoria.registrar(auditoria.USUARIO_SISTEMA, 'programacion_ejecutada',
        `${rows[0].username} quedó activo, como estaba programado`);   // B-38: sin el id
    }

    if (rows[0].desactivacion_programada && new Date(rows[0].desactivacion_programada) <= new Date()) {
      await query(
        `UPDATE inventario.usuario
         SET usuario_estado_cuenta = 'inactivo', usuario_desactivacion_programada = NULL
         WHERE usuario_id_usuario = $1`,
        [payload.id]
      );
      await auditoria.registrar(auditoria.USUARIO_SISTEMA, 'programacion_ejecutada',
        `${rows[0].username} quedó inactivo, como estaba programado`);
      return res.status(401).json({
        error: 'Su cuenta ha sido desactivada según la programación establecida. Contacte al administrador.',
        codigo: 'CUENTA_DESACTIVADA'
      });
    }

    if (!['activo','activa'].includes(estado)) {
      return res.status(401).json({
        error: 'Cuenta desactivada. Contacte al administrador.',
        codigo: 'CUENTA_DESACTIVADA'
      });
    }

    const fila = rows[0];
    req.user = {
      id: payload.id,
      username: fila.username,
      nombre: `${fila.primer_nombre || ''} ${fila.primer_apellido || ''}`.trim(),
      rol: rolDe(fila),
    };
    next();
  } catch (err) {
    if (err.name === 'JsonWebTokenError' || err.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Token inválido o expirado' });
    }
    return res.status(500).json({ error: 'Error interno de autenticación' });
  }
}

/**
 * Solo permite acceso a usuarios con rol gerencia.
 * Usar después de authMiddleware.
 */
function soloGerencia(req, res, next) {
  if (req.user?.rol !== 'gerencia') {
    return res.status(403).json({ error: 'Acceso restringido a gerencia' });
  }
  next();
}

/**
 * B-45 (D95): Inventario trabaja solo con Gerencia y JOP. Los demás roles del sistema
 * (técnico, administrador, secretaria) son de otros módulos: no entran al módulo, pero
 * sí usan las rutas de integración (CU-106 y CU-107), que index.js deja fuera de esta barrera.
 */
const ROLES_INVENTARIO = ['gerencia', 'jop'];

function soloInventario(req, res, next) {
  if (!ROLES_INVENTARIO.includes(req.user?.rol)) {
    return res.status(403).json({
      error: 'Su usuario no tiene acceso al módulo Inventario. Solo pueden entrar Gerencia y JOP.',
      codigo: 'SIN_ACCESO_INVENTARIO',
    });
  }
  next();
}

/**
 * D62: toda ruta que escribe exige rol, no solo sesión. Con D95 son los mismos dos
 * roles del módulo; se mantiene explícito en cada ruta que escribe.
 */
function soloOperativo(req, res, next) {
  if (!ROLES_INVENTARIO.includes(req.user?.rol)) {
    return res.status(403).json({ error: 'Acceso restringido a personal operativo' });
  }
  next();
}

/**
 * Invariante: los montos (precios, costos, valores) se ocultan al rol jop EN EL
 * BACKEND, no solo en la vista. Los controllers que devuelven montos a roles que
 * incluyen jop lo consultan y quitan esos campos. tests/montos-jop.test.js recorre
 * los endpoints como jop y falla si alguno los envía.
 */
function ocultaMontos(req) {
  // D50; con D95 el técnico ya no entra al módulo, así que queda solo jop
  return req.user?.rol === 'jop';
}

/** Quita `campos` de cada objeto de `filas` (en el lugar). Devuelve `filas`. */
function quitarCampos(filas, campos) {
  for (const f of filas) for (const c of campos) delete f[c];
  return filas;
}

module.exports = { rolDe, ROLES_INVENTARIO, authMiddleware, soloInventario, soloGerencia, soloOperativo, ocultaMontos, quitarCampos };
