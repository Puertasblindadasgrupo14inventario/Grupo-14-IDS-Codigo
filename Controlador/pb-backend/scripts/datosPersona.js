/**
 * F-46 (Ley 21.719, arts. 5 y 11): todo lo que el sistema tiene de una persona, para responder
 * una solicitud de acceso ("¿qué datos tienen de mí?") dentro de los 30 días que da la ley.
 *
 * No es una ruta web: lo corre quien tiene acceso al servidor y a su .env.
 *
 *   npm run datos-persona -- <RUT, correo o nombre de usuario>
 *
 * Solo lee. Escribe un JSON en la carpeta actual y registra en la auditoría, como usuario
 * sistema, que se exportaron los datos (sin el RUT ni el correo, criterio de B-36 / D94).
 * El archivo trae datos personales: se entrega por un canal privado y se borra después.
 *
 * Busca la persona como usuario, empleado de Finanzas (solo lo que Inventario lee), cliente,
 * cliente de Finanzas (solo la razón social que leemos) y proveedor o contacto de proveedor.
 * Después cuenta sus registros en toda tabla de inventario con una columna de usuario o de RUT
 * de empleado (encontradas desde information_schema, para que una tabla nueva no se escape) y
 * lista su auditoría. Contexto: docs/fase-cierre/ley-21719.md (secciones 3, 6 y 7).
 */
const path = require('path');
// Antes del pool: pool.js lee la conexión de process.env al cargarse.
// dotenv no pisa variables ya definidas (los tests cargan las suyas antes).
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const fs = require('fs');
const { pool, query } = require('../src/db/pool');
const auditoria = require('../src/controllers/auditoriaController');
const { normalizarRut } = require('../src/controllers/ordenesTrabajoController');
const { etiqueta } = require('../src/config/auditoria');
const { fechaHoraChile } = require('../src/db/cambios');

/** RUT sin puntos ni guion, en mayúscula, para comparar los guardados con distinto formato. */
const RUT_SQL = (col) => `regexp_replace(upper(${col}), '[^0-9K]', '', 'g')`;
const soloRut = (r) => r.replace(/[^0-9K]/gi, '').toUpperCase();
const fecha = (v) => (v ? fechaHoraChile(v) : null);

const AVISO = 'Datos que trata el sistema de inventario. Las finalidades, bases legales, destinatarios, plazo de ' +
  'conservación y origen de estos datos están en la política de privacidad de la empresa. Lo que guarda el ' +
  'módulo de Finanzas más allá de lo que lee Inventario (por ejemplo AFP, previsión, sueldo o ventas) lo responde ' +
  'Finanzas. La contraseña no se incluye: se guarda solo cifrada y de forma irreversible.';

/** Tablas de inventario con una columna que apunta a la persona, y su primera columna de fecha. */
async function tablasConColumna(columnas) {
  const { rows } = await query(
    `SELECT c.table_name AS tabla, c.column_name AS columna,
            (SELECT f.column_name FROM information_schema.columns f
             WHERE f.table_schema = c.table_schema AND f.table_name = c.table_name
               AND f.data_type IN ('timestamp with time zone', 'timestamp without time zone', 'date')
             ORDER BY f.ordinal_position LIMIT 1) AS col_fecha
     FROM information_schema.columns c
     JOIN information_schema.tables t
       ON t.table_schema = c.table_schema AND t.table_name = c.table_name AND t.table_type = 'BASE TABLE'
     WHERE c.table_schema = 'inventario' AND c.column_name = ANY($1)
       AND c.table_name NOT IN ('usuario', 'usuario_contrasena')
     ORDER BY c.table_name, c.column_name`,
    [columnas]
  );
  return rows;
}

/** Cuántos registros de cada tabla apuntan a los valores dados, con el primero y el último. */
async function contarRegistros(columnas, valores, por, esRut) {
  if (valores.length === 0) return [];
  const salida = [];
  for (const t of await tablasConColumna(columnas)) {
    const col = esRut ? RUT_SQL(`"${t.columna}"`) : `"${t.columna}"`;
    const fechas = t.col_fecha ? `, min("${t.col_fecha}") AS primero, max("${t.col_fecha}") AS ultimo` : '';
    const { rows: [r] } = await query(
      `SELECT count(*)::int AS cantidad${fechas} FROM inventario."${t.tabla}" WHERE ${col} = ANY($1)`,
      [valores]
    );
    if (r.cantidad > 0) {
      salida.push({ tabla: t.tabla, columna: t.columna, por, cantidad: r.cantidad,
                    primero: fecha(r.primero), ultimo: fecha(r.ultimo) });
    }
  }
  return salida;
}

/**
 * Junta los datos de la persona. Lanza si el identificador está vacío o calza con más de un usuario.
 * Devuelve { encontrado, ... } y registra la consulta en la auditoría.
 */
async function datosPersona(identificador) {
  const buscado = String(identificador || '').trim();
  if (!buscado) throw new Error('Indique un RUT, un correo o un nombre de usuario.');
  const rut = normalizarRut(buscado);
  const esCorreo = buscado.includes('@');

  // 1. Usuario (sin la contraseña)
  const { rows: usuarios } = await query(
    `SELECT usuario_id_usuario::int AS id, usuario_username AS usuario, usuario_correo AS correo,
            usuario_rut_usuario AS rut, usuario_nombre_completo_primer_nombre_usuario AS primer_nombre,
            usuario_nombre_completo_segundo_nombre_usuario AS segundo_nombre,
            usuario_nombre_completo_primer_apellido_usuario AS primer_apellido,
            usuario_nombre_completo_segundo_apellido_usuario AS segundo_apellido,
            usuario_estado_cuenta AS estado, empleado_rut_empleado AS empleado_rut,
            usuario_fecha_de_creacion AS creado, usuario_fecha_de_ultima_edicion AS editado,
            usuario_fecha_ultima_conexion AS ultima_conexion
     FROM usuario
     WHERE usuario_username = $1 OR lower(usuario_correo) = lower($1)
        OR ($2::text IS NOT NULL AND ${RUT_SQL('usuario_rut_usuario')} = $2)
     ORDER BY usuario_id_usuario`,
    [buscado, rut ? soloRut(rut) : null]
  );
  if (usuarios.length > 1) {
    throw new Error(`"${buscado}" coincide con ${usuarios.length} usuarios (ids ${usuarios.map(u => u.id).join(', ')}). ` +
                    'Use el nombre de usuario.');
  }
  const usuario = usuarios[0] || null;

  // Todos los RUT y correos conocidos de la persona, para buscarla en las demás tablas
  const ruts = [...new Set([rut, usuario?.rut, usuario?.empleado_rut].filter(Boolean).map(soloRut))];
  const correos = [...new Set([esCorreo ? buscado : null, usuario?.correo].filter(Boolean).map(c => c.toLowerCase()))];

  // 2. Empleado de Finanzas: solo lo que Inventario lee
  const { rows: empleados } = ruts.length ? await query(
    `SELECT e.empleado_rut_empleado AS rut,
            CONCAT_WS(' ', e.empleado_nombre_empleado_primer_nombre_empleado, e.empleado_nombre_empleado_segundo_nombre_empleado,
                      e.empleado_nombre_empleado_primer_apellido_empleado, e.empleado_nombre_empleado_segundo_apellido_empleado) AS nombre,
            c.empleado_cargo_nombre AS cargo, e.empleado_estado AS estado
     FROM finanzas.empleado e
     LEFT JOIN finanzas.empleado_cargo c ON c.empleado_cargo_id_cargo = e.empleado_cargo_id_cargo
     WHERE ${RUT_SQL('e.empleado_rut_empleado')} = ANY($1)`, [ruts]) : { rows: [] };

  // 3. Cliente de Terreno (lo crea Proyectos, F-29), por RUT o correo
  const { rows: clientes } = (ruts.length || correos.length) ? await query(
    `SELECT * FROM terreno.cliente
     WHERE ${RUT_SQL('rut_cliente')} = ANY($1) OR ${RUT_SQL('cliente_b2c_rut')} = ANY($1)
        OR lower(correo) = ANY($2) OR lower(cliente_b2c_correo) = ANY($2)`, [ruts, correos]) : { rows: [] };

  // 4. Cliente de Finanzas: solo la razón social, que es lo que Inventario lee
  const { rows: clientesFinanzas } = ruts.length ? await query(
    `SELECT rut_cliente AS rut, nombre_razon_social AS razon_social FROM finanzas.cliente_financiero
     WHERE ${RUT_SQL('rut_cliente')} = ANY($1)`, [ruts]) : { rows: [] };

  // 5. Proveedor (persona natural, por su RUT) o contacto de proveedor (por su correo)
  const { rows: proveedores } = (ruts.length || correos.length) ? await query(
    `SELECT p.proveedor_id_proveedor::int AS id, p.proveedor_razon_social AS razon_social,
            p.proveedor_doc_identidad_rut_proveedor_opcional AS rut,
            CONCAT_WS(' ', p.proveedor_contacto_primer_nombre, p.proveedor_contacto_segundo_nombre,
                      p.proveedor_contacto_primer_apellido, p.proveedor_contacto_segundo_apellido) AS contacto,
            (SELECT array_agg(t.proveedor_contacto_telefono ORDER BY t.proveedor_contacto_telefono) FROM proveedor_contacto_telefono t
             WHERE t.proveedor_id_proveedor = p.proveedor_id_proveedor) AS telefonos,
            (SELECT array_agg(c.proveedor_contacto_correo ORDER BY c.proveedor_contacto_correo) FROM proveedor_contacto_correo c
             WHERE c.proveedor_id_proveedor = p.proveedor_id_proveedor) AS correos
     FROM proveedor p
     WHERE ${RUT_SQL('p.proveedor_doc_identidad_rut_proveedor_opcional')} = ANY($1)
        OR EXISTS (SELECT 1 FROM proveedor_contacto_correo c
                   WHERE c.proveedor_id_proveedor = p.proveedor_id_proveedor
                     AND lower(c.proveedor_contacto_correo) = ANY($2))
     ORDER BY p.proveedor_id_proveedor`, [ruts, correos]) : { rows: [] };

  // 6. Dónde aparece: registros hechos por el usuario y registros con su RUT de empleado
  const registros = [
    ...(usuario ? await contarRegistros(['usuario_id_usuario'], [usuario.id], 'usuario', false) : []),
    ...await contarRegistros(['empleado_rut', 'empleado_rut_empleado'], ruts, 'RUT de empleado', true),
  ];

  // 7. Su auditoría: lo que hizo, y cuántos eventos lo mencionan por su nombre de usuario
  let eventos = [], menciones = 0;
  if (usuario) {
    const { rows } = await query(
      `SELECT fecha_hora, accion_realizada AS accion, COALESCE(observacion, registro_afectado) AS detalle, ip_origen AS ip
       FROM finanzas.evento_auditoria WHERE id_usuario = $1 ORDER BY fecha_hora, id_evento`, [usuario.id]);
    eventos = rows.map(e => ({ fecha: fecha(e.fecha_hora), accion: etiqueta(e.accion), detalle: e.detalle, ip: e.ip }));
    const { rows: [m] } = await query(
      `SELECT count(*)::int AS n FROM finanzas.evento_auditoria
       WHERE id_usuario <> $1 AND COALESCE(observacion, registro_afectado) ILIKE '%' || $2 || '%'`,
      [usuario.id, usuario.usuario]);
    menciones = m.n;
  }

  const encontrado = !!(usuario || empleados.length || clientes.length || clientesFinanzas.length ||
                        proveedores.length || registros.length);

  // A quién se exportó, sin el RUT ni el correo (B-36 / D94)
  const quien = [
    usuario && `usuario #${usuario.id}`,
    empleados.length && 'empleado de Finanzas',
    clientes.length && 'cliente',
    clientesFinanzas.length && 'cliente de Finanzas',
    ...proveedores.map(p => `proveedor #${p.id}`),
  ].filter(Boolean);
  await auditoria.registrar(auditoria.USUARIO_SISTEMA, 'exportar_datos_persona',
    `Solicitud de acceso (Ley 21.719, art. 5): ${quien.length ? quien.join(', ') : 'sin datos en el sistema'}`);

  const sinFechasCrudas = (u) => u && { ...u, creado: fecha(u.creado), editado: fecha(u.editado),
                                        ultima_conexion: fecha(u.ultima_conexion) };
  return {
    generado: fechaHoraChile(new Date()),
    buscado: buscado,
    encontrado,
    aviso: AVISO,
    usuario: sinFechasCrudas(usuario),
    empleado_finanzas: empleados,
    clientes,
    clientes_finanzas: clientesFinanzas,
    proveedores,
    registros,
    auditoria: { eventos, menciones_por_otros: menciones },
  };
}

async function main() {
  const identificador = process.argv[2];
  if (!identificador) {
    console.error('Uso: npm run datos-persona -- <RUT, correo o nombre de usuario>');
    process.exitCode = 1;
    await pool.end();
    return;
  }
  try {
    const r = await datosPersona(identificador);
    if (!r.encontrado) {
      console.log(`\nNo hay datos de "${r.buscado}" en el sistema. Igual se puede responder la solicitud con eso.`);
      return;
    }
    const nombre = `datos-persona_${r.buscado.replace(/[^0-9A-Za-z]+/g, '-')}_${r.generado.slice(6, 10)}` +
                   `${r.generado.slice(3, 5)}${r.generado.slice(0, 2)}.json`;
    fs.writeFileSync(nombre, JSON.stringify(r, null, 2), 'utf8');
    console.log(`\nArchivo:      ${path.resolve(nombre)}`);
    console.log(`Encontrado:   ${[r.usuario && 'usuario', r.empleado_finanzas.length && 'empleado',
                                   r.clientes.length && 'cliente', r.clientes_finanzas.length && 'cliente de Finanzas',
                                   r.proveedores.length && 'proveedor'].filter(Boolean).join(', ') || 'solo registros'}`);
    console.log(`Registros:    ${r.registros.reduce((s, x) => s + x.cantidad, 0)} en ${r.registros.length} tabla(s)`);
    console.log(`Auditoría:    ${r.auditoria.eventos.length} evento(s) suyos, ${r.auditoria.menciones_por_otros} que lo mencionan`);
    console.log('\nEl archivo trae datos personales: revíselo, entréguelo por un canal privado y bórrelo después.');
  } catch (err) {
    console.error(`\nNo se pudo consultar: ${err.message}`);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

if (require.main === module) main();

module.exports = { datosPersona };
