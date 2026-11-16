const bcrypt   = require('bcrypt');
const crypto   = require('crypto');
const { query } = require('../db/pool');
const { ErrorNegocio, conTransaccion, responderError } = require('../db/tx');
const { SQL_ESTADOS_OT_CERRADA } = require('../db/estadosOT');
const audLog = require('./auditoriaController');
const frasesAud = require('../config/auditoria');   // F-42
const { describirCambios, fechaHoraChile } = require('../db/cambios');   // F-42b
const { validarResponsable, normalizarRut } = require('./ordenesTrabajoController');   // B-03
const { ingresoBloqueadoHasta, desbloquearIngreso: borrarBloqueoIngreso } = require('./authController');   // F-36

// CU-84 CP3: Flag es_temporal en usuario_contrasena (persistido en BD)

// D68: la cuenta solo guarda 'activo' o 'inactivo' (CHECK en el DDL). Se acepta tambien
// la forma femenina, que es la que mandaba la pantalla de Usuarios.
const ESTADOS_CUENTA = ['activo', 'inactivo'];
function normalizarEstado(estado) {
  const e = String(estado).trim().toLowerCase();
  if (e === 'activa') return 'activo';
  if (e === 'inactiva') return 'inactivo';
  return e;
}

/**
 * B-19: los 5 roles. Una cuenta tiene UNA sola marca usuario_es_* en TRUE (jop si ninguna);
 * si hubiera más de una, manda la misma prioridad que rolDe() en middleware/auth.js.
 */
const ROLES = ['gerencia', 'jop', 'tecnico', 'administrador', 'secretaria'];
const ROL_EFECTIVO = `CASE
           WHEN u.usuario_es_gerencia      THEN 'gerencia'
           WHEN u.usuario_es_tecnico       THEN 'tecnico'
           WHEN u.usuario_es_administrador THEN 'administrador'
           WHEN u.usuario_es_secretaria    THEN 'secretaria'
           ELSE 'jop'
         END`;
const ERROR_ROL = { error: 'El rol debe ser gerencia, jop, tecnico, administrador o secretaria.' };

/** F-42b: el usuario con sus datos legibles, para decir en la auditoría qué cambió una edición. */
async function fotoUsuario(id) {
  const { rows } = await query(
    `SELECT u.usuario_username AS username, ${ROL_EFECTIVO} AS rol, u.usuario_estado_cuenta AS estado,
            u.usuario_nombre_completo_primer_nombre_usuario AS nombre,
            u.usuario_nombre_completo_primer_apellido_usuario AS apellido,
            u.usuario_correo AS correo, u.usuario_rut_usuario AS rut,
            COALESCE(NULLIF(TRIM(CONCAT_WS(' ', e.empleado_nombre_empleado_primer_nombre_empleado,
                                                e.empleado_nombre_empleado_primer_apellido_empleado)), ''),
                     u.empleado_rut_empleado) AS empleado
     FROM usuario u
     LEFT JOIN finanzas.empleado e ON e.empleado_rut_empleado = u.empleado_rut_empleado
     WHERE u.usuario_id_usuario = $1`,
    [id]
  );
  return rows[0] || {};
}
const CAMPOS_USUARIO = [
  { clave: 'rol', etiqueta: 'rol' },
  { clave: 'estado', etiqueta: 'estado' },
  // B-36 (D94): los datos personales se nombran sin su valor
  { clave: 'nombre', etiqueta: 'el nombre', personal: true },
  { clave: 'apellido', etiqueta: 'el apellido', personal: true },
  { clave: 'correo', etiqueta: 'el correo', personal: true },
  { clave: 'rut', etiqueta: 'el RUT', personal: true },
  { clave: 'empleado', etiqueta: 'el empleado de Finanzas', personal: true },
];

/** B-04: el estado de la cuenta con las programaciones vencidas ya aplicadas (alias u). */
const ESTADO_EFECTIVO = `CASE
           WHEN u.usuario_desactivacion_programada <= now() THEN 'inactivo'
           WHEN u.usuario_activacion_programada    <= now() THEN 'activo'
           ELSE u.usuario_estado_cuenta
         END`;

/**
 * RUT del usuario (módulo 11) y empleado de Finanzas (activo, FK blanda) del body, con el patrón
 * de presencia: un campo omitido no aparece en el resultado; uno vacío o null queda en null.
 * El empleado es el cruce que usan F-13 (desviación por trabajador) y F-16 (pintor de la OT).
 */
const presente = (body, campo) => Object.prototype.hasOwnProperty.call(body, campo);
const vacio = (v) => v == null || String(v).trim() === '';

async function leerRutYEmpleado(body, ejecutar = query) {
  const datos = {};
  if (presente(body, 'rut')) {
    if (vacio(body.rut)) datos.rut = null;
    else {
      datos.rut = normalizarRut(body.rut);
      if (!datos.rut) throw new ErrorNegocio(400, { error: 'El RUT no es válido (ej: 12345678-5).' });
    }
  }
  if (presente(body, 'empleado_rut')) {
    if (vacio(body.empleado_rut)) datos.empleado = null;
    else {
      const { rows } = await ejecutar(
        `SELECT empleado_rut_empleado AS rut FROM finanzas.empleado
         WHERE empleado_rut_empleado = $1 AND empleado_estado = 'activo'`,
        [String(body.empleado_rut).trim()]
      );
      if (rows.length === 0) throw new ErrorNegocio(400, { error: 'El empleado elegido no es un empleado activo de Finanzas.' });
      datos.empleado = rows[0].rut;
    }
  }
  return datos;
}

/**
 * GET /api/usuarios
 * Lista todos los usuarios — solo gerencia (FR-57)
 */
async function listar(req, res) {
  const { buscar, rol, estado } = req.query;
  try {
    const { rows } = await query(
      `SELECT
         u.usuario_id_usuario                                    AS id,
         u.usuario_username                                      AS username,
         u.usuario_correo                                        AS correo,
         -- B-04: estado EFECTIVO; una programación vencida se ve aplicada aunque el timer no haya pasado
         ${ESTADO_EFECTIVO}                                    AS estado,
         u.usuario_fecha_de_creacion                             AS creado,
         u.usuario_fecha_ultima_conexion                         AS ultima_conexion,
         u.usuario_desactivacion_programada                      AS desactivacion_programada,
         u.usuario_activacion_programada                         AS activacion_programada,
         u.usuario_es_gerencia                                   AS es_gerencia,
         u.usuario_es_jop                                        AS es_jop,
         CONCAT_WS(' ',
           u.usuario_nombre_completo_primer_nombre_usuario,
           u.usuario_nombre_completo_primer_apellido_usuario)    AS nombre_completo,
         u.usuario_rut_usuario                                   AS rut,
         u.empleado_rut_empleado                                 AS empleado_rut,
         NULLIF(TRIM(CONCAT_WS(' ',
           e.empleado_nombre_empleado_primer_nombre_empleado,
           e.empleado_nombre_empleado_primer_apellido_empleado)), '') AS empleado_nombre,
         e.empleado_estado                                       AS empleado_estado,
         ${ROL_EFECTIVO} AS rol
       FROM usuario u
       LEFT JOIN finanzas.empleado e ON e.empleado_rut_empleado = u.empleado_rut_empleado
       WHERE ($1::text IS NULL OR
              u.usuario_username ILIKE '%' || $1 || '%' OR
              u.usuario_correo   ILIKE '%' || $1 || '%' OR
              CONCAT(u.usuario_nombre_completo_primer_nombre_usuario, ' ',
                     u.usuario_nombre_completo_primer_apellido_usuario) ILIKE '%' || $1 || '%')
         AND ($2::text IS NULL OR ${ROL_EFECTIVO} = $2)
         AND ($3::text IS NULL OR ${ESTADO_EFECTIVO} = $3)
       ORDER BY u.usuario_nombre_completo_primer_apellido_usuario`,
      [buscar || null, rol || null, estado ? normalizarEstado(estado) : null]
    );
    // F-36: el bloqueo del ingreso vive en memoria (S-03), no en la tabla
    res.json(rows.map(u => ({ ...u, ingreso_bloqueado_hasta: ingresoBloqueadoHasta(u.username) })));
  } catch (err) {
    console.error('Error listando usuarios:', err);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
}

/**
 * POST /api/usuarios
 * Crear usuario — solo gerencia (CU-72 a CU-75)
 */
async function crear(req, res) {
  const {
    username, correo, password,
    nombre, apellido, rol, estado
  } = req.body;

  if (!username || !password || !rol) {
    return res.status(400).json({ error: 'Username, contraseña y rol son requeridos' });
  }
  if (!ROLES.includes(rol)) return res.status(400).json(ERROR_ROL);
  if (password.length < 8) {
    return res.status(400).json({ error: 'La contraseña debe tener al menos 8 caracteres' });
  }
  const estadoCuenta = estado ? normalizarEstado(estado) : 'activo';
  if (!ESTADOS_CUENTA.includes(estadoCuenta)) {
    return res.status(400).json({ error: 'El estado de la cuenta debe ser activo o inactivo' });
  }

  try {
    const { rut = null, empleado = null } = await leerRutYEmpleado(req.body);

    // El hash se calcula ANTES de abrir la transacción: bcrypt con coste 12 tarda
    // ~100 ms y no tiene sentido mantener una transacción abierta mientras tanto.
    const hash = await bcrypt.hash(password, 12);

    // El usuario y su contraseña se crean juntos o no se crea ninguno. Antes eran
    // dos queries sueltas: si fallaba el INSERT de la contraseña quedaba un usuario
    // SIN credenciales, imposible de usar y ocupando el username (que es UNIQUE).
    const userId = await conTransaccion(async (client) => {
      const { rows: exist } = await client.query(
        `SELECT usuario_id_usuario FROM usuario
         WHERE usuario_username = $1 OR ($2::text IS NOT NULL AND usuario_correo = $2)
            OR ($3::text IS NOT NULL AND usuario_rut_usuario = $3)`,
        [username, correo || null, rut]
      );
      if (exist.length > 0) {
        throw new ErrorNegocio(409, { error: 'El username, correo o RUT ya está en uso' });
      }

      const { rows } = await client.query(
        `INSERT INTO usuario (
           usuario_username, usuario_correo,
           usuario_nombre_completo_primer_nombre_usuario,
           usuario_nombre_completo_primer_apellido_usuario,
           usuario_estado_cuenta,
           usuario_es_gerencia, usuario_es_jop, usuario_es_tecnico,
           usuario_es_administrador, usuario_es_secretaria,
           usuario_rut_usuario, empleado_rut_empleado
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
         RETURNING usuario_id_usuario AS id`,
        [
          username, correo || null,
          nombre || null, apellido || null,
          estadoCuenta,
          rol === 'gerencia', rol === 'jop', rol === 'tecnico',
          rol === 'administrador', rol === 'secretaria',
          rut, empleado
        ]
      );

      // La contraseña inicial es temporal (también para gerencia): el login pide cambiarla,
      // así quien crea la cuenta no conoce la contraseña final. La pantalla ya lo avisaba.
      const id = rows[0].id;
      await client.query(
        `INSERT INTO usuario_contrasena (usuario_id_usuario, usuario_contrasena, es_temporal) VALUES ($1, $2, TRUE)`,
        [id, hash]
      );
      return id;
    });

    await audLog.registrar(req.user?.id, 'crear_usuario', `username: ${username}, rol: ${rol}`);
    res.status(201).json({ message: 'Usuario creado correctamente', id: userId });
  } catch (err) {
    // usuario_username, usuario_correo y usuario_rut_usuario son UNIQUE en la BD: si dos altas
    // simultáneas pasan el chequeo de arriba, la segunda choca acá. Sin esto
    // el usuario veía un 500 en vez del 409 que corresponde.
    if (err.code === '23505') {
      return res.status(409).json({ error: 'El username, correo o RUT ya está en uso' });
    }
    responderError(res, err, 'Error creando usuario:');
  }
}

/**
 * PUT /api/usuarios/:id/permisos
 * Editar rol y estado de un usuario — solo gerencia (FR-61)
 */
/* ── B-03: OT abiertas de un usuario ──────────────────────────────────── */

/** Cuántas OT abiertas tiene como responsable. */
async function otPendientesDe(id, ejecutar = query) {
  const { rows } = await ejecutar(
    `SELECT COUNT(*)::int AS n FROM orden_trabajo
     WHERE usuario_id_usuario = $1 AND orden_trabajo_estado NOT IN (${SQL_ESTADOS_OT_CERRADA})`, [id]);
  return rows[0].n;
}

/** El 400 que bloquea desactivar; `codigo` le permite a la pantalla ofrecer "Reasignar a…". */
const errorOTPendientes = (n) => ({
  error: `El usuario tiene ${n} orden(es) de trabajo pendientes. Reasígnelas antes de desactivar.`,
  codigo: 'OT_PENDIENTES', pendientes: n,
});

/**
 * POST /api/usuarios/:id/reasignar-ot   (solo gerencia) — B-03
 * Body: { responsable_id }. Mueve TODAS las OT abiertas del usuario :id al nuevo responsable,
 * en una transacción. Las OT cerradas no se tocan (conservan quién las llevó).
 */
async function reasignarOT(req, res) {
  const { id } = req.params;
  const destino = req.body?.responsable_id;
  if (!/^\d+$/.test(String(id))) return res.status(400).json({ error: 'El id del usuario debe ser numérico' });
  if (String(destino) === String(id)) {
    return res.status(400).json({ error: 'Elija a otro usuario como responsable.', campo: 'responsable_id' });
  }
  try {
    const r = await conTransaccion(async (client) => {
      const { rows: origen } = await client.query(
        `SELECT usuario_username AS username FROM usuario WHERE usuario_id_usuario = $1`, [id]);
      if (!origen.length) throw new ErrorNegocio(404, { error: 'Usuario no encontrado' });
      const username = await validarResponsable(client, destino);
      const { rows: movidas } = await client.query(
        `UPDATE orden_trabajo SET usuario_id_usuario = $2
         WHERE usuario_id_usuario = $1 AND orden_trabajo_estado NOT IN (${SQL_ESTADOS_OT_CERRADA})
         RETURNING orden_trabajo_id_orden AS id`, [id, destino]);
      return { de: origen[0].username, a: username, ots: movidas.map(m => Number(m.id)).sort((x, y) => x - y) };
    });
    if (r.ots.length) {
      await audLog.registrar(req.user.id, 'reasignar_ot', `${r.ots.length} OT de ${r.de} a ${r.a}: #${r.ots.join(', #')}`);
    }
    res.json({ message: `${r.ots.length} OT reasignada(s) de ${r.de} a ${r.a}.`, reasignadas: r.ots });
  } catch (err) {
    responderError(res, err, 'Error reasignando las OT:');
  }
}

async function editarPermisos(req, res) {
  const { id }    = req.params;
  const { rol } = req.body;
  const estado = req.body.estado ? normalizarEstado(req.body.estado) : null;
  // Datos de la persona (patrón de presencia). Antes la pantalla los dejaba editar, pero solo
  // enviaba rol y estado, y el cambio se perdía sin aviso.
  const CAMPOS_PERSONA = {
    nombre:   'usuario_nombre_completo_primer_nombre_usuario',
    apellido: 'usuario_nombre_completo_primer_apellido_usuario',
    correo:   'usuario_correo',
  };
  const camposPersona = Object.keys(CAMPOS_PERSONA).filter(c => presente(req.body, c));
  const conIdentidad = presente(req.body, 'rut') || presente(req.body, 'empleado_rut');

  if (!rol && !estado && camposPersona.length === 0 && !conIdentidad) {
    return res.status(400).json({ error: 'Debes enviar al menos un dato para cambiar' });
  }
  if (rol && !ROLES.includes(rol)) return res.status(400).json(ERROR_ROL);
  if (estado && !ESTADOS_CUENTA.includes(estado)) {
    return res.status(400).json({ error: 'El estado de la cuenta debe ser activo o inactivo' });
  }

  try {
    const identidad = await leerRutYEmpleado(req.body);

    // CU-83 Exc 1: no puede desactivarse a sí mismo
    if (estado && ['inactivo', 'inactiva'].includes(estado.toLowerCase()) && parseInt(id) === parseInt(req.user.id)) {
      return res.status(400).json({ error: 'No puede desactivar su propia cuenta' });
    }

    // CU-82 Exc: no degradar al último gerencia
    if (rol && rol !== 'gerencia') {
      const { rows: target } = await query(
        `SELECT usuario_es_gerencia FROM usuario WHERE usuario_id_usuario = $1`, [id]
      );
      if (target.length > 0 && target[0].usuario_es_gerencia) {
        const { rows: gerencias } = await query(
          `SELECT COUNT(*) AS total FROM usuario
           WHERE usuario_es_gerencia = TRUE AND usuario_estado_cuenta IN ('activo','activa')`
        );
        if (parseInt(gerencias[0].total) <= 1) {
          return res.status(400).json({ error: 'No se puede degradar al único usuario con rol Gerencia' });
        }
      }
    }

    // CU-83 Exc: verificar OTs pendientes antes de desactivar (B-03: la pantalla ofrece reasignarlas)
    if (estado && ['inactivo', 'inactiva'].includes(estado.toLowerCase())) {
      const pendientes = await otPendientesDe(id);
      if (pendientes > 0) return res.status(400).json(errorOTPendientes(pendientes));
    }

    // CU-82 Exc / CU-89 CP3: verificar cuenta inactiva antes de cambiar rol
    if (rol) {
      const { rows: usr } = await query(
        `SELECT usuario_estado_cuenta AS estado FROM usuario WHERE usuario_id_usuario = $1`, [id]
      );
      if (usr.length > 0 && !['activo', 'activa'].includes(usr[0].estado)
          && (!estado || !['activo', 'activa'].includes(estado.toLowerCase()))) {
        return res.status(400).json({ error: 'No se pueden editar permisos de una cuenta inactiva. Reactive la cuenta primero.' });
      }
    }

    // Sin rol se conserva el que tiene (antes caia en 'jop' y degradaba a un gerente
    // sin pasar por la regla del ultimo gerente de arriba). B-19: con rol, queda UNA sola marca;
    // antes solo se tocaban gerencia y jop, y un técnico pasado a jop seguía siendo técnico.
    const params = [rol || null, estado || null, id];
    const sets = [];
    for (const c of camposPersona) {
      params.push(vacio(req.body[c]) ? null : String(req.body[c]).trim());
      sets.push(`${CAMPOS_PERSONA[c]} = $${params.length}`);
    }
    if ('rut' in identidad)      { params.push(identidad.rut);      sets.push(`usuario_rut_usuario = $${params.length}`); }
    if ('empleado' in identidad) { params.push(identidad.empleado); sets.push(`empleado_rut_empleado = $${params.length}`); }

    const antes = await fotoUsuario(id);   // F-42b
    const { rowCount } = await query(
      `UPDATE usuario SET
         usuario_es_gerencia      = CASE WHEN $1::text IS NULL THEN usuario_es_gerencia      ELSE $1 = 'gerencia'      END,
         usuario_es_jop           = CASE WHEN $1::text IS NULL THEN usuario_es_jop           ELSE $1 = 'jop'           END,
         usuario_es_tecnico       = CASE WHEN $1::text IS NULL THEN usuario_es_tecnico       ELSE $1 = 'tecnico'       END,
         usuario_es_administrador = CASE WHEN $1::text IS NULL THEN usuario_es_administrador ELSE $1 = 'administrador' END,
         usuario_es_secretaria    = CASE WHEN $1::text IS NULL THEN usuario_es_secretaria    ELSE $1 = 'secretaria'    END,
         usuario_estado_cuenta = COALESCE($2, usuario_estado_cuenta),
         ${sets.map(s => s + ',').join('\n         ')}
         usuario_fecha_de_ultima_edicion = now()
       WHERE usuario_id_usuario = $3`,
      params
    );

    if (rowCount === 0) {
      return res.status(404).json({ error: 'Usuario no encontrado' });
    }

    // F-42b: a quién y qué cambió, con el valor anterior y el nuevo (antes: "usuario_id: 7, rol: …")
    const despues = await fotoUsuario(id);
    audLog.registrar(req.user?.id, 'editar_permisos',
      `${despues.username}: ${describirCambios(antes, despues, CAMPOS_USUARIO)}`);
    res.json({ message: 'Usuario actualizado correctamente' });
  } catch (err) {
    // Correo o RUT de otro usuario (UNIQUE en la BD)
    if (err.code === '23505') {
      return res.status(409).json({ error: 'El correo o RUT ya está en uso' });
    }
    responderError(res, err, 'Error editando permisos:');
  }
}

/**
 * POST /api/usuarios/:id/recuperar-password
 * Genera nueva contraseña temporal — solo gerencia (FR-56)
 */
async function recuperarPassword(req, res) {
  const { id } = req.params;

  try {
    // CU-84: No se puede resetear la propia contraseña desde este panel
    if (parseInt(id) === parseInt(req.user.id)) {
      return res.status(403).json({ error: 'No puede resetear su propia contraseña desde este panel. Use la opción de cambio de contraseña.' });
    }

    const { rows } = await query(
      `SELECT usuario_correo, usuario_username, usuario_es_gerencia FROM usuario WHERE usuario_id_usuario = $1`, [id]
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: 'Usuario no encontrado' });
    }

    // CU-84 Exc 1: No se puede resetear la clave de otro usuario con rol de Gerencia
    if (rows[0].usuario_es_gerencia) {
      return res.status(403).json({ error: 'Por políticas de seguridad, no se puede resetear la clave de un usuario con rol de Gerencia' });
    }

    // En producción aquí iría el envío de email con enlace de recuperación.
    // Por ahora generamos una contraseña temporal y la devolvemos.
    const tempPassword = crypto.randomBytes(9).toString('base64url'); // B-02: generador seguro, 12 caracteres
    const hash = await bcrypt.hash(tempPassword, 12);

    await query(
      `UPDATE usuario_contrasena SET usuario_contrasena = $1, es_temporal = TRUE WHERE usuario_id_usuario = $2`,
      [hash, id]
    );

    await audLog.registrar(req.user?.id, 'recuperar_password', `a ${rows[0].usuario_username}`);
    res.json({
      message: `Contraseña temporal generada para ${rows[0].usuario_username}`,
      // En producción NO devolver la contraseña — enviar por email
      password_temporal: tempPassword,
      correo: rows[0].usuario_correo
    });
  } catch (err) {
    console.error('Error recuperando contraseña:', err);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
}

/**
 * GET /api/usuarios/auditoria
 * Historial de acciones de usuarios — solo gerencia (FR-60)
 * Nota: la auditoría real requiere una tabla de logs dedicada.
 * Por ahora devuelve los movimientos registrados por cada usuario.
 * F-42: cada fila trae además `frase` (lo que pasó, en una oración) y `etiqueta` (src/config/auditoria.js);
 * accion, detalle e ip siguen igual, como detalle técnico. Los eventos registrar_entrada, _salida y
 * _traslado repiten un movimiento que ya está en la lista: se ocultan salvo que se filtre por ellos.
 */
async function auditoria(req, res) {
  const { desde, hasta, usuario_id, accion } = req.query;

  // CU-88 CP3: Validar rango de fechas
  if (desde && hasta && desde > hasta) {
    return res.status(400).json({ error: 'La fecha de inicio no puede ser posterior a la fecha de fin' });
  }

  // CU-88 CP4: No permitir fechas futuras.
  // La fecha de "hoy" se arma en LOCAL: con toISOString() (UTC) el límite se
  // corría al día siguiente desde media tarde en Chile, así que la validación
  // aceptaba o rechazaba lo mismo según la hora del día.
  const ahora = new Date();
  const hoy = `${ahora.getFullYear()}-${String(ahora.getMonth() + 1).padStart(2, '0')}-${String(ahora.getDate()).padStart(2, '0')}`;
  if ((desde && desde > hoy) || (hasta && hasta > hoy)) {
    return res.status(400).json({ error: 'No se pueden buscar registros con fechas futuras' });
  }

  try {
    // CU-34: Include movimiento_inventario, reporte AND finanzas.evento_auditoria
    // SONNET-6: filtro de accion se aplica en la consulta externa (combinable con desde/hasta/usuario_id)
    const { rows } = await query(
      `SELECT * FROM (
        (SELECT
           mi.movimiento_inventario_fecha_hora   AS timestamp,
           u.usuario_username                    AS usuario,
           u.usuario_rut_usuario                 AS rut,
           'registrar_movimiento'                AS accion,
           CONCAT(
             tm.movimiento_inventario_tipo_movimiento_nombre, ' — SKU ',
             mi.material_sku, ', cantidad: ', mi.movimiento_inventario_cantidad
           )                                     AS detalle,
           NULL::varchar                         AS ip,
           u.usuario_nombre_completo_primer_nombre_usuario   AS nombre,
           u.usuario_nombre_completo_primer_apellido_usuario AS apellido,
           -- F-42: los datos del movimiento para armar la frase
           json_build_object(
             'tipo',         tm.movimiento_inventario_tipo_movimiento_nombre,
             'cantidad',     mi.movimiento_inventario_cantidad,
             'unidad',       um.material_unidad_medida_nombre,
             'sku',          mi.material_sku,
             'material',     m.material_nombre_material,
             'bodega',       b.bodega_nombre_bodega,
             'ot',           mi.orden_trabajo_id_orden,
             'motivo',       mot.movimiento_inventario_motivo_movimiento_nombre,
             'estado',       mi.movimiento_inventario_estado,
             'id_revertido', mi.movimiento_inventario_id_revertido,
             'modulo',       mi.movimiento_inventario_modulo_origen
           )                                     AS mov
         FROM movimiento_inventario mi
         JOIN usuario u ON u.usuario_id_usuario = mi.usuario_id_usuario
         JOIN movimiento_inventario_tipo_movimiento tm
              ON tm.movimiento_inventario_tipo_movimiento_id_tipo_movimiento
               = mi.movimiento_inventario_tipo_movimiento_id_tipo_movimiento
         LEFT JOIN material m ON m.material_sku = mi.material_sku
         LEFT JOIN material_unidad_medida um
                ON um.material_unidad_medida_id_unidad_medida = m.material_unidad_medida_id_unidad_medida
         LEFT JOIN bodega b ON b.bodega_id_bodega = mi.bodega_id_bodega
         LEFT JOIN movimiento_inventario_motivo_movimiento mot
                ON mot.movimiento_inventario_motivo_movimiento_id_motivo_movimiento
                 = mi.movimiento_inventario_motivo_movimiento_id_motivo_movimiento
         WHERE ($1::text IS NULL OR $1::text = '' OR mi.movimiento_inventario_fecha_hora >= $1::date)
           AND ($2::text IS NULL OR $2::text = '' OR mi.movimiento_inventario_fecha_hora < ($2::date + INTERVAL '1 day'))
           AND ($3::text IS NULL OR $3::text = '' OR mi.usuario_id_usuario = $3::bigint))
        UNION ALL
        (SELECT
           r.reporte_fecha_generacion       AS timestamp,
           COALESCE(u2.usuario_username, 'Sistema') AS usuario,
           u2.usuario_rut_usuario           AS rut,
           split_part(r.reporte_tipo_reporte, ':', 2) AS accion,
           split_part(r.reporte_tipo_reporte, ':', 3) AS detalle,
           NULL::varchar                    AS ip,
           u2.usuario_nombre_completo_primer_nombre_usuario   AS nombre,
           u2.usuario_nombre_completo_primer_apellido_usuario AS apellido,
           NULL::json                       AS mov
         FROM reporte r
         LEFT JOIN usuario u2 ON u2.usuario_id_usuario = r.usuario_id_usuario
         WHERE r.reporte_tipo_reporte LIKE 'auditoria:%'
           AND ($1::text IS NULL OR $1::text = '' OR r.reporte_fecha_generacion >= $1::date)
           AND ($2::text IS NULL OR $2::text = '' OR r.reporte_fecha_generacion < ($2::date + INTERVAL '1 day'))
           AND ($3::text IS NULL OR $3::text = '' OR r.usuario_id_usuario = $3::bigint))
        UNION ALL
        (SELECT
           ea.fecha_hora                    AS timestamp,
           -- D59: id_usuario 0 = acción automática del sistema
           CASE WHEN ea.id_usuario = 0 THEN 'Sistema (automático)'
                ELSE COALESCE(u3.usuario_username, 'Sistema') END AS usuario,
           u3.usuario_rut_usuario           AS rut,
           ea.accion_realizada              AS accion,
           -- D59: el detalle largo de Inventario va completo en observacion
           CASE WHEN ea.entidad_afectada = 'inventario' AND ea.observacion IS NOT NULL
                THEN ea.observacion ELSE ea.registro_afectado END AS detalle,
           ea.ip_origen                     AS ip,     -- B-20: solo los eventos de seguridad la traen
           u3.usuario_nombre_completo_primer_nombre_usuario   AS nombre,
           u3.usuario_nombre_completo_primer_apellido_usuario AS apellido,
           NULL::json                       AS mov
         FROM finanzas.evento_auditoria ea
         LEFT JOIN usuario u3 ON u3.usuario_id_usuario = ea.id_usuario
         WHERE ($1::text IS NULL OR $1::text = '' OR ea.fecha_hora >= $1::date)
           AND ($2::text IS NULL OR $2::text = '' OR ea.fecha_hora < ($2::date + INTERVAL '1 day'))
           AND ($3::text IS NULL OR $3::text = '' OR ea.id_usuario = $3::bigint))
      ) combinado
      WHERE ($4::text IS NULL OR $4::text = '' OR combinado.accion ILIKE '%' || $4 || '%')
        -- F-42: sin filtro de acción, el evento que repite un movimiento no se muestra dos veces
        AND (($4::text IS NOT NULL AND $4::text <> '')
             OR combinado.accion NOT IN ('registrar_entrada', 'registrar_salida', 'registrar_traslado'))
      ORDER BY timestamp DESC
      LIMIT 200`,
      [desde || null, hasta || null, usuario_id || null, accion || null]
    );
    res.json(rows.map(({ nombre, apellido, mov, ...r }) => {
      const sistema = r.usuario === 'Sistema (automático)' || r.usuario === 'Sistema';
      const quien = sistema ? 'El sistema' : frasesAud.nombreVisible({ nombre, apellido, usuario: r.usuario });
      return {
        ...r,
        etiqueta: frasesAud.etiqueta(r.accion),
        frase: mov ? frasesAud.fraseMovimiento(quien, mov) : frasesAud.fraseEvento(quien, r.accion, r.detalle, { sistema }),
      };
    }));
  } catch (err) {
    console.error('Error obteniendo auditoria:', err);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
}

/**
 * POST /api/usuarios/:id/programar-desactivacion
 * CU-83.1: Programa desactivación diferida
 * Body: { fecha }
 */
async function programarDesactivacion(req, res) {
  const { id } = req.params;
  const { fecha } = req.body;

  if (!fecha) {
    return res.status(400).json({ error: 'Debe seleccionar la fecha y hora de desactivación' });
  }

  // CU-83.1 Exc 1: fecha pasada
  if (isNaN(new Date(fecha).getTime()) || new Date(fecha) <= new Date()) {
    return res.status(400).json({ error: 'La fecha programada debe ser posterior a la actual' });
  }

  try {
    // CU-83.1 Exc 2: no programarse a sí mismo
    if (parseInt(id) === parseInt(req.user.id)) {
      return res.status(400).json({ error: 'No puede programar la desactivación de su propia cuenta' });
    }

    // B-03: el mismo control que la desactivación inmediata (antes se saltaba)
    const pendientes = await otPendientesDe(id);
    if (pendientes > 0) return res.status(400).json(errorOTPendientes(pendientes));

    // OPUS-8: la programacion vive en la tabla usuario, no dentro del mensaje de
    // una notificacion. Antes el dato solo existia como JSON en notificacion, no se
    // podia consultar ni cancelar, y nada lo aplicaba si el usuario seguia logueado.
    const { rows } = await query(
      `UPDATE usuario
       SET usuario_desactivacion_programada = $1,
           usuario_fecha_de_ultima_edicion  = now()
       WHERE usuario_id_usuario = $2
       RETURNING usuario_username AS username, usuario_estado_cuenta AS estado`,
      [fecha, id]
    );
    if (rows.length === 0) {
      return res.status(404).json({ error: 'Usuario no encontrado' });
    }

    // Se mantiene la notificacion, ahora solo como aviso
    try {
      const { crearNotificacion } = require('./notificacionesController');
      await crearNotificacion({
        tipo: 'programacion_desactivacion',
        mensaje: `La cuenta de ${rows[0].username} se desactivará el ${new Date(fecha).toLocaleString('es-CL')}`,
        origen: 'usuarios',
        usuarioIds: [req.user.id]
      });
    } catch (e) { console.warn('No se pudo notificar la programación:', e.message); }

    // F-42b: la hora de Chile, no la ISO en UTC
    await audLog.registrar(req.user?.id, 'programar_desactivacion', `${rows[0].username}, para el ${fechaHoraChile(fecha)}`);
    res.json({
      message: `Desactivación de ${rows[0].username} programada para ${new Date(fecha).toLocaleString('es-CL')}`,
      desactivacion_programada: fecha
    });
  } catch (err) {
    console.error('Error programando desactivación:', err);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
}

/**
 * POST /api/usuarios/:id/programar-activacion
 * CU-83.2: Programa activación diferida
 * Body: { fecha }
 */
async function programarActivacion(req, res) {
  const { id } = req.params;
  const { fecha } = req.body;

  if (!fecha) {
    return res.status(400).json({ error: 'Debe seleccionar la fecha y hora de activación' });
  }
  if (isNaN(new Date(fecha).getTime()) || new Date(fecha) <= new Date()) {
    return res.status(400).json({ error: 'La fecha programada debe ser posterior a la actual' });
  }

  try {
    const { rows } = await query(
      `UPDATE usuario
       SET usuario_activacion_programada   = $1,
           usuario_fecha_de_ultima_edicion = now()
       WHERE usuario_id_usuario = $2
       RETURNING usuario_username AS username`,
      [fecha, id]
    );
    if (rows.length === 0) {
      return res.status(404).json({ error: 'Usuario no encontrado' });
    }

    try {
      const { crearNotificacion } = require('./notificacionesController');
      await crearNotificacion({
        tipo: 'programacion_activacion',
        mensaje: `La cuenta de ${rows[0].username} se reactivará el ${new Date(fecha).toLocaleString('es-CL')}`,
        origen: 'usuarios',
        usuarioIds: [req.user.id]
      });
    } catch (e) { console.warn('No se pudo notificar la programación:', e.message); }

    await audLog.registrar(req.user?.id, 'programar_activacion', `${rows[0].username}, para el ${fechaHoraChile(fecha)}`);
    res.json({
      message: `Activación de ${rows[0].username} programada para ${new Date(fecha).toLocaleString('es-CL')}`,
      activacion_programada: fecha
    });
  } catch (err) {
    console.error('Error programando activación:', err);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
}

/**
 * DELETE /api/usuarios/:id/programacion?tipo=desactivacion|activacion
 * OPUS-8: cancelar una programacion pendiente. Antes no habia forma de deshacerla.
 */
async function cancelarProgramacion(req, res) {
  const { id } = req.params;
  const tipo = req.query.tipo === 'activacion' ? 'activacion' : 'desactivacion';
  const columna = tipo === 'activacion'
    ? 'usuario_activacion_programada'
    : 'usuario_desactivacion_programada';

  try {
    const { rows } = await query(
      `UPDATE usuario
       SET ${columna} = NULL, usuario_fecha_de_ultima_edicion = now()
       WHERE usuario_id_usuario = $1
       RETURNING usuario_username AS username`,
      [id]
    );
    if (rows.length === 0) {
      return res.status(404).json({ error: 'Usuario no encontrado' });
    }

    await audLog.registrar(req.user?.id, 'cancelar_programacion',
      `${rows[0].username}: se canceló la ${tipo === 'activacion' ? 'activación' : 'desactivación'} programada`);
    res.json({ message: `Programación de ${tipo} cancelada para ${rows[0].username}` });
  } catch (err) {
    console.error('Error cancelando programación:', err);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
}

/**
 * POST /api/usuarios/:id/desbloquear-ingreso   (gerencia, con firma) — F-36
 * Libera el bloqueo progresivo del login de un usuario sin esperar a que venza, y borra su cuenta
 * de fallos. El límite por IP no cambia.
 */
async function desbloquearIngreso(req, res) {
  const { id } = req.params;
  if (!/^\d+$/.test(String(id))) return res.status(400).json({ error: 'El id del usuario debe ser numérico.' });
  try {
    const { rows } = await query(`SELECT usuario_username AS username FROM usuario WHERE usuario_id_usuario = $1`, [id]);
    if (rows.length === 0) return res.status(404).json({ error: 'Usuario no encontrado' });
    const estaba = borrarBloqueoIngreso(rows[0].username);
    await audLog.registrar(req.user?.id, 'desbloquear_ingreso',
      `${rows[0].username}: ${estaba ? 'ingreso desbloqueado por gerencia' : 'sin bloqueo vigente; se borraron sus fallos'}`, { ip: req.ip });
    res.json({
      message: estaba ? `Ingreso desbloqueado: ${rows[0].username} ya puede entrar.` : `${rows[0].username} no tenía el ingreso bloqueado.`,
      desbloqueado: estaba,
    });
  } catch (err) {
    responderError(res, err, 'Error desbloqueando el ingreso:');
  }
}

/**
 * Aplica las programaciones de activación y desactivación vencidas: notifica a gerencia y audita
 * como el sistema (D59). B-04: la llama un timer del backend cada minuto (index.js); antes solo
 * corría cuando un gerente abría el Dashboard.
 *
 * OPUS-8: lee las columnas de `usuario` en vez de parsear JSON de notificaciones.
 * El middleware de auth aplica la desactivacion al usuario afectado en su proximo
 * request; esto cubre a los usuarios que NO estan conectados.
 */
async function aplicarProgramaciones() {
  const { rows: desactivados } = await query(
    `UPDATE usuario
     SET usuario_estado_cuenta = 'inactivo',
         usuario_desactivacion_programada = NULL,
         usuario_fecha_de_ultima_edicion = now()
     WHERE usuario_desactivacion_programada IS NOT NULL
       AND usuario_desactivacion_programada <= now()
     RETURNING usuario_id_usuario AS id, usuario_username AS username`
  );

  const { rows: activados } = await query(
    `UPDATE usuario
     SET usuario_estado_cuenta = 'activo',
         usuario_activacion_programada = NULL,
         usuario_fecha_de_ultima_edicion = now()
     WHERE usuario_activacion_programada IS NOT NULL
       AND usuario_activacion_programada <= now()
     RETURNING usuario_id_usuario AS id, usuario_username AS username`
  );

  for (const u of [...desactivados, ...activados]) {
    const esDesactivacion = desactivados.some(d => d.id === u.id);
    const accionTexto = esDesactivacion ? 'desactivada' : 'activada';
    try {
      const { notificarPorRol } = require('./notificacionesController');
      await notificarPorRol({
        tipo: 'programacion_ejecutada',
        mensaje: `La cuenta de ${u.username} ha sido ${accionTexto} automáticamente según la programación establecida.`,
        origen: 'usuarios',
        ruta: '/usuarios',
        rol: 'gerencia'
      });
    } catch (e) { console.warn('No se pudo notificar programación ejecutada:', e.message); }

    // D59: la ejecución es automática; la hace el sistema
    await audLog.registrar(audLog.USUARIO_SISTEMA, 'programacion_ejecutada',   // B-38: sin el id
      `${u.username} quedó ${esDesactivacion ? 'inactivo' : 'activo'}, como estaba programado`);
  }

  return {
    procesadas: desactivados.length + activados.length,
    desactivados: desactivados.map(u => u.username),
    activados: activados.map(u => u.username)
  };
}

/**
 * POST /api/usuarios/procesar-programaciones
 * Aplica ahora las programaciones vencidas (lo mismo que hace el timer cada minuto).
 */
async function procesarProgramaciones(req, res) {
  try {
    res.json(await aplicarProgramaciones());
  } catch (err) {
    console.error('Error procesando programaciones:', err);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
}

/** B-38: qué se exportó, en palabras, para la auditoría (antes "Ruta: /programacion-semanal/exportar"). */
const EXPORTACIONES = {
  '/programacion-semanal/exportar':     'la programación semanal, en CSV',
  '/programacion-semanal/exportar-pdf': 'la programación semanal, en PDF',
};
const queSeExporto = (req) => EXPORTACIONES[req.path] || `Ruta: ${req.path}`;

/**
 * Middleware: CU-81.1 — Detectar extracción masiva de información
 * Cuenta exportaciones del usuario en los últimos 5 minutos
 */
async function deteccionExtraccionMasiva(req, res, next) {
  try {
    const userId = req.user?.id;
    if (!userId) return next();

    const { rows } = await query(
      `SELECT COUNT(*) AS total FROM reporte
       WHERE usuario_id_usuario = $1
         AND reporte_tipo_reporte LIKE 'auditoria:exportar_%'
         AND reporte_fecha_generacion >= now() - INTERVAL '5 minutes'`,
      [userId]
    );

    const umbral = 10;
    if (parseInt(rows[0]?.total || 0) >= umbral) {
      // CU-88 Exc 1: Si es gerencia, registrar pero NO bloquear
      if (req.user?.rol === 'gerencia') {
        audLog.registrar(userId, 'exportar_reporte_masivo',
          `${queSeExporto(req)} (${umbral} o más exportaciones en 5 minutos; a gerencia no se la bloquea)`);
        return next();
      }

      const { notificarPorRol } = require('./notificacionesController');
      notificarPorRol({
        tipo: 'extraccion_masiva',
        mensaje: `Alerta de seguridad: el usuario ${req.user?.username || userId} ha realizado ${rows[0].total} exportaciones en los últimos 5 minutos.`,
        origen: 'seguridad',
        ruta: '/usuarios?tab=auditoria',
        rol: 'gerencia'
      });

      return res.status(429).json({
        error: 'Se ha detectado un volumen inusual de exportaciones. La acción ha sido bloqueada temporalmente y se ha notificado a Gerencia.'
      });
    }

    // Registrar la exportación actual
    audLog.registrar(userId, 'exportar_reporte', queSeExporto(req));
    next();
  } catch {
    // Middleware de detección: si falla, nunca debe bloquear la exportación
    next();
  }
}

module.exports = {
  listar, crear, editarPermisos, recuperarPassword, auditoria, reasignarOT,
  programarDesactivacion, cancelarProgramacion, programarActivacion, procesarProgramaciones, aplicarProgramaciones,
  deteccionExtraccionMasiva, desbloquearIngreso
};
