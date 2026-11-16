const { query } = require('../db/pool');
const { ErrorNegocio, conTransaccion, responderError } = require('../db/tx');
const auditoria = require('./auditoriaController');
const { FORMATO_PREFIJO, prefijoPropuesto } = require('../db/codigos');   // F-34

/**
 * B-14: mantenedor de la clasificación de materiales (solo gerencia).
 *
 * Un material guarda tres clasificaciones independientes:
 *  - categoría general y categoría funcional: listas simples (nombre UNIQUE en el DDL);
 *  - clasificación específica: árbol categoría → subcategoría → nivel; el material guarda solo el nivel.
 *
 * Sin columna "activo" (DDL-05 no recomendado): se crea, se renombra y se borra solo lo que ningún
 * material usa. Lo que está en uso se puede fusionar con otro valor del mismo tipo (sus materiales
 * pasan al destino y el origen se borra), solo en los tipos que el material guarda directamente:
 * general, funcional y nivel. El código no depende de ningún nombre: son datos del cliente.
 */

const NOMBRE_MAX = 150;
// Nivel que se crea con cada subcategoría nueva, igual que el importador (F-03). Se puede renombrar.
const NIVEL_INICIAL = 'General';

const TIPOS = {
  general: {
    tabla: 'material_categoria_general', id: 'material_categoria_general_id_categoria_general',
    nombre: 'material_categoria_general_nombre', padre: null,
    usoMaterial: 'material_categoria_general_id_categoria_general', titulo: 'categoría general',
  },
  funcional: {
    tabla: 'material_categoria_funcional', id: 'material_categoria_funcional_id_categoria_funcional',
    nombre: 'material_categoria_funcional_nombre', padre: null,
    usoMaterial: 'material_categoria_funcional_id_categoria_funcional', titulo: 'categoría funcional',
  },
  categoria: {
    tabla: 'material_clasificacion_categoria', id: 'material_clasificacion_categoria_id',
    nombre: 'material_clasificacion_categoria_nombre_categoria', padre: null,
    hijo: 'subcategoria', titulo: 'categoría',
  },
  subcategoria: {
    tabla: 'material_clasificacion_subcategoria', id: 'material_clasificacion_subcategoria_id',
    nombre: 'material_clasificacion_subcategoria_nombre_subcategoria', padre: 'categoria',
    hijo: 'nivel', titulo: 'subcategoría',
  },
  nivel: {
    tabla: 'material_clasificacion_nivel_especifico', id: 'material_clasificacion_nivel_especifico_id',
    nombre: 'material_clasificacion_nivel_especifico_nombre_nivel_especifico', padre: 'subcategoria',
    usoMaterial: 'material_clasificacion_nivel_especifico_id', titulo: 'nivel',
  },
};
// Columna del hijo que apunta al padre (subcategoría → categoría, nivel → subcategoría)
const COL_PADRE = {
  subcategoria: 'material_clasificacion_categoria_id',
  nivel:        'material_clasificacion_subcategoria_id',
};

function tipoDe(req) {
  const t = TIPOS[req.params.tipo];
  if (!t) throw new ErrorNegocio(404, { error: 'Tipo de clasificación desconocido.' });
  return t;
}

function idDe(valor, que) {
  const n = Number(valor);
  if (!Number.isInteger(n) || n <= 0) throw new ErrorNegocio(400, { error: `${que} no es válido.` });
  return n;
}

function validarNombre(nombre) {
  const valor = typeof nombre === 'string' ? nombre.trim() : '';
  if (!valor) throw new ErrorNegocio(400, { error: 'Escribe un nombre.' });
  if (valor.length > NOMBRE_MAX) {
    throw new ErrorNegocio(400, { error: `El nombre no puede superar los ${NOMBRE_MAX} caracteres.` });
  }
  return valor;
}

/** 409 si ya hay otro elemento con ese nombre entre sus hermanos (sin distinguir mayúsculas). */
async function verificarNombreLibre(client, tipo, t, nombre, padreId, excluirId) {
  const params = [nombre];
  let sql = `SELECT 1 FROM ${t.tabla} WHERE LOWER(TRIM(${t.nombre})) = LOWER($1)`;
  if (t.padre) { params.push(padreId); sql += ` AND ${COL_PADRE[tipo]} = $${params.length}`; }
  if (excluirId) { params.push(excluirId); sql += ` AND ${t.id} <> $${params.length}`; }
  const { rows } = await client.query(sql, params);
  if (rows.length) {
    throw new ErrorNegocio(409, { error: `Ya existe "${nombre}" en ese lugar. Usa otro nombre.` });
  }
}

/**
 * F-34 (DDL-12): prefijo del SKU de una categoría. Vacío o null = sin prefijo (se deriva del nombre).
 * Se acepta en minúsculas y se guarda en mayúsculas.
 */
function leerPrefijo(valor) {
  if (valor == null || String(valor).trim() === '') return null;
  const p = String(valor).trim().toUpperCase();
  if (!FORMATO_PREFIJO.test(p)) {
    throw new ErrorNegocio(400, { error: 'El prefijo del SKU son 3 letras sin tildes (A a Z), por ejemplo HER.' });
  }
  return p;
}

/** 409 si otra categoría ya usa ese prefijo (la BD también lo impide con su UNIQUE). */
async function verificarPrefijoLibre(client, prefijo, excluirId) {
  if (!prefijo) return;
  const { rows } = await client.query(
    `SELECT material_clasificacion_categoria_nombre_categoria AS nombre FROM material_clasificacion_categoria
     WHERE material_clasificacion_categoria_prefijo_sku = $1 AND ($2::bigint IS NULL OR material_clasificacion_categoria_id <> $2)`,
    [prefijo, excluirId]);
  if (rows.length) {
    throw new ErrorNegocio(409, { error: `El prefijo ${prefijo} ya lo usa la categoría "${rows[0].nombre}". Elige otro.` });
  }
}

/** Fila actual (con bloqueo) o 404. */
async function filaDe(client, tipo, t, id) {
  const cols = [`${t.id} AS id`, `${t.nombre} AS nombre`];
  if (t.padre) cols.push(`${COL_PADRE[tipo]} AS padre_id`);
  const { rows } = await client.query(`SELECT ${cols.join(', ')} FROM ${t.tabla} WHERE ${t.id} = $1 FOR UPDATE`, [id]);
  if (!rows.length) throw new ErrorNegocio(404, { error: `${t.titulo === 'nivel' ? 'El nivel' : `La ${t.titulo}`} no existe (quizás alguien lo borró).` });
  return rows[0];
}

/** Cuántos materiales usan este elemento (para una categoría o subcategoría, cualquier nivel de su rama). */
async function materialesQueUsan(client, tipo, id) {
  const sql = {
    general:      `SELECT COUNT(*)::int AS n FROM material WHERE material_categoria_general_id_categoria_general = $1`,
    funcional:    `SELECT COUNT(*)::int AS n FROM material WHERE material_categoria_funcional_id_categoria_funcional = $1`,
    nivel:        `SELECT COUNT(*)::int AS n FROM material WHERE material_clasificacion_nivel_especifico_id = $1`,
    subcategoria: `SELECT COUNT(*)::int AS n FROM material m
                   JOIN material_clasificacion_nivel_especifico n
                     ON n.material_clasificacion_nivel_especifico_id = m.material_clasificacion_nivel_especifico_id
                   WHERE n.material_clasificacion_subcategoria_id = $1`,
    categoria:    `SELECT COUNT(*)::int AS n FROM material m
                   JOIN material_clasificacion_nivel_especifico n
                     ON n.material_clasificacion_nivel_especifico_id = m.material_clasificacion_nivel_especifico_id
                   JOIN material_clasificacion_subcategoria s
                     ON s.material_clasificacion_subcategoria_id = n.material_clasificacion_subcategoria_id
                   WHERE s.material_clasificacion_categoria_id = $1`,
  }[tipo];
  const { rows } = await client.query(sql, [id]);
  return rows[0].n;
}


/**
 * GET /api/materiales/catalogos/clasificacion
 * Las tres clasificaciones con la cantidad de materiales que usa cada elemento.
 */
async function listar(req, res) {
  try {
    const [generales, funcionales, categorias, subcategorias, niveles] = await Promise.all([
      query(`SELECT g.material_categoria_general_id_categoria_general AS id,
                    g.material_categoria_general_nombre AS nombre,
                    (SELECT COUNT(*)::int FROM material m
                     WHERE m.material_categoria_general_id_categoria_general = g.material_categoria_general_id_categoria_general) AS usos
             FROM material_categoria_general g ORDER BY LOWER(g.material_categoria_general_nombre)`),
      query(`SELECT f.material_categoria_funcional_id_categoria_funcional AS id,
                    f.material_categoria_funcional_nombre AS nombre,
                    (SELECT COUNT(*)::int FROM material m
                     WHERE m.material_categoria_funcional_id_categoria_funcional = f.material_categoria_funcional_id_categoria_funcional) AS usos
             FROM material_categoria_funcional f ORDER BY LOWER(f.material_categoria_funcional_nombre)`),
      query(`SELECT material_clasificacion_categoria_id AS id,
                    material_clasificacion_categoria_nombre_categoria AS nombre,
                    material_clasificacion_categoria_prefijo_sku AS prefijo_sku
             FROM material_clasificacion_categoria ORDER BY LOWER(material_clasificacion_categoria_nombre_categoria)`),
      query(`SELECT material_clasificacion_subcategoria_id AS id,
                    material_clasificacion_subcategoria_nombre_subcategoria AS nombre,
                    material_clasificacion_subcategoria_es_color_custom AS es_color_custom,
                    material_clasificacion_categoria_id AS categoria_id
             FROM material_clasificacion_subcategoria ORDER BY LOWER(material_clasificacion_subcategoria_nombre_subcategoria)`),
      query(`SELECT n.material_clasificacion_nivel_especifico_id AS id,
                    n.material_clasificacion_nivel_especifico_nombre_nivel_especifico AS nombre,
                    n.material_clasificacion_subcategoria_id AS subcategoria_id,
                    (SELECT COUNT(*)::int FROM material m
                     WHERE m.material_clasificacion_nivel_especifico_id = n.material_clasificacion_nivel_especifico_id) AS usos
             FROM material_clasificacion_nivel_especifico n
             ORDER BY LOWER(n.material_clasificacion_nivel_especifico_nombre_nivel_especifico)`),
    ]);

    // Uso de subcategorías y categorías = suma de sus niveles
    const usoSub = new Map();
    for (const n of niveles.rows) usoSub.set(n.subcategoria_id, (usoSub.get(n.subcategoria_id) || 0) + n.usos);
    const subs = subcategorias.rows.map(s => ({ ...s, usos: usoSub.get(s.id) || 0 }));
    const usoCat = new Map();
    for (const s of subs) usoCat.set(s.categoria_id, (usoCat.get(s.categoria_id) || 0) + s.usos);
    const cats = categorias.rows.map(c => ({ ...c, usos: usoCat.get(c.id) || 0 }));

    res.json({
      generales:   generales.rows,
      funcionales: funcionales.rows,
      clasificacion: { categorias: cats, subcategorias: subs, niveles: niveles.rows },
    });
  } catch (err) {
    responderError(res, err, 'Error listando la clasificación:');
  }
}

/**
 * POST /api/materiales/catalogos/clasificacion/:tipo
 * Body: { nombre, padre_id? (subcategoría y nivel), es_color_custom? (subcategoría), prefijo? (categoría) }
 * Una subcategoría nueva se crea con su nivel inicial, para poder usarla de inmediato.
 * F-34: una categoría sin `prefijo` recibe el de su nombre si está libre (y no es reservado).
 */
async function crear(req, res) {
  try {
    const t = tipoDe(req);
    const tipo = req.params.tipo;
    const nombre = validarNombre(req.body?.nombre);
    const padreId = t.padre ? idDe(req.body?.padre_id, `La ${TIPOS[t.padre].titulo}`) : null;
    const conPrefijo = tipo === 'categoria' && 'prefijo' in (req.body || {});
    const prefijoPedido = conPrefijo ? leerPrefijo(req.body.prefijo) : null;

    const creado = await conTransaccion(async (client) => {
      if (t.padre) await filaDe(client, t.padre, TIPOS[t.padre], padreId);
      await verificarNombreLibre(client, tipo, t, nombre, padreId, null);

      const cols = [t.nombre];
      const vals = [nombre];
      if (t.padre) { cols.push(COL_PADRE[tipo]); vals.push(padreId); }
      let prefijo = null;
      if (tipo === 'categoria') {
        prefijo = conPrefijo ? prefijoPedido : await prefijoPropuesto(client, nombre);
        await verificarPrefijoLibre(client, prefijo, null);
        cols.push('material_clasificacion_categoria_prefijo_sku');
        vals.push(prefijo);
      }
      if (tipo === 'subcategoria') {
        cols.push('material_clasificacion_subcategoria_es_color_custom');
        vals.push(req.body?.es_color_custom === true);
      }
      const { rows } = await client.query(
        `INSERT INTO ${t.tabla} (${cols.join(', ')}) VALUES (${vals.map((_, i) => `$${i + 1}`).join(', ')})
         RETURNING ${t.id} AS id`,
        vals
      );
      const id = rows[0].id;
      if (tipo === 'subcategoria') {
        await client.query(
          `INSERT INTO material_clasificacion_nivel_especifico
             (material_clasificacion_nivel_especifico_nombre_nivel_especifico, material_clasificacion_subcategoria_id)
           VALUES ($1, $2)`,
          [NIVEL_INICIAL, id]
        );
      }
      return tipo === 'categoria' ? { id, nombre, prefijo_sku: prefijo } : { id, nombre };
    });

    await auditoria.registrar(req.user?.id, 'crear_clasificacion',
      `${t.titulo} #${creado.id}: ${creado.nombre}` + (creado.prefijo_sku ? ` (prefijo ${creado.prefijo_sku})` : ''));
    res.status(201).json(creado);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Ese prefijo del SKU ya lo usa otra categoría. Elige otro.' });
    responderError(res, err, 'Error creando clasificación:');
  }
}

/**
 * PUT /api/materiales/catalogos/clasificacion/:tipo/:id
 * Body: { nombre?, es_color_custom? (subcategoría), prefijo? (categoría) }. Lo omitido se conserva;
 * F-34: un prefijo vacío o null se limpia (la categoría vuelve a derivarlo del nombre). Cambiarlo
 * afecta solo a los productos nuevos: un SKU ya creado no cambia.
 */
async function actualizar(req, res) {
  try {
    const t = tipoDe(req);
    const tipo = req.params.tipo;
    const id = idDe(req.params.id, 'El identificador');
    const body = req.body || {};
    const cambiaNombre = 'nombre' in body;
    const cambiaColor = tipo === 'subcategoria' && 'es_color_custom' in body;
    const cambiaPrefijo = tipo === 'categoria' && 'prefijo' in body;
    if (!cambiaNombre && !cambiaColor && !cambiaPrefijo) throw new ErrorNegocio(400, { error: 'No hay cambios que guardar.' });
    const nombre = cambiaNombre ? validarNombre(body.nombre) : null;
    const prefijo = cambiaPrefijo ? leerPrefijo(body.prefijo) : null;

    const r = await conTransaccion(async (client) => {
      const actual = await filaDe(client, tipo, t, id);
      if (cambiaNombre) {
        await verificarNombreLibre(client, tipo, t, nombre, actual.padre_id, id);
        await client.query(`UPDATE ${t.tabla} SET ${t.nombre} = $1 WHERE ${t.id} = $2`, [nombre, id]);
      }
      let prefijoAntes;
      if (cambiaPrefijo) {
        const { rows } = await client.query(
          `SELECT material_clasificacion_categoria_prefijo_sku AS p FROM material_clasificacion_categoria
           WHERE material_clasificacion_categoria_id = $1`, [id]);
        prefijoAntes = rows[0]?.p ?? null;
        await verificarPrefijoLibre(client, prefijo, id);
        await client.query(
          `UPDATE material_clasificacion_categoria SET material_clasificacion_categoria_prefijo_sku = $1
           WHERE material_clasificacion_categoria_id = $2`, [prefijo, id]);
      }
      if (cambiaColor) {
        await client.query(
          `UPDATE material_clasificacion_subcategoria SET material_clasificacion_subcategoria_es_color_custom = $1
           WHERE material_clasificacion_subcategoria_id = $2`,
          [body.es_color_custom === true, id]
        );
      }
      return { antes: actual.nombre, despues: cambiaNombre ? nombre : actual.nombre, prefijoAntes };
    });

    let detalle = r.antes === r.despues ? `${t.titulo} #${id}: ${r.despues}` : `${t.titulo} #${id}: ${r.antes} → ${r.despues}`;
    if (cambiaPrefijo && r.prefijoAntes !== prefijo) detalle += ` (prefijo ${r.prefijoAntes || '—'} → ${prefijo || '—'})`;
    await auditoria.registrar(req.user?.id, 'editar_clasificacion', detalle);
    res.json(cambiaPrefijo ? { id, nombre: r.despues, prefijo_sku: prefijo } : { id, nombre: r.despues });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Ese prefijo del SKU ya lo usa otra categoría. Elige otro.' });
    responderError(res, err, 'Error editando clasificación:');
  }
}

/**
 * DELETE /api/materiales/catalogos/clasificacion/:tipo/:id[?mover_a=ID]
 * Sin mover_a: borra solo si ningún material lo usa (una categoría o subcategoría se lleva sus hijos vacíos).
 * Con mover_a (general, funcional y nivel): pasa sus materiales al destino y lo borra.
 */
async function eliminar(req, res) {
  try {
    const t = tipoDe(req);
    const tipo = req.params.tipo;
    const id = idDe(req.params.id, 'El identificador');
    const moverA = req.query.mover_a != null && req.query.mover_a !== ''
      ? idDe(req.query.mover_a, 'El destino') : null;
    if (moverA != null && !t.usoMaterial) {
      throw new ErrorNegocio(400, { error: 'Solo se fusionan categorías generales, funcionales y niveles.' });
    }
    if (moverA === id) throw new ErrorNegocio(400, { error: 'El destino debe ser distinto del que se borra.' });

    const r = await conTransaccion(async (client) => {
      const actual = await filaDe(client, tipo, t, id);
      const usos = await materialesQueUsan(client, tipo, id);
      let destino = null;

      if (moverA != null) {
        destino = await filaDe(client, tipo, t, moverA);
        await client.query(`UPDATE material SET ${t.usoMaterial} = $1 WHERE ${t.usoMaterial} = $2`, [moverA, id]);
      } else if (usos > 0) {
        throw new ErrorNegocio(409, {
          error: `No se puede borrar "${actual.nombre}": la usa${usos === 1 ? '' : 'n'} ${usos} producto${usos === 1 ? '' : 's'}. ` +
                 (t.usoMaterial ? 'Fusiónalo con otro para pasarle sus productos, o cámbiale el nombre.'
                                : 'Fusiona sus niveles con otros para pasarles sus productos, o cámbiale el nombre.'),
          usos,
        });
      }

      // Hijos vacíos de la rama (ya se comprobó que ningún material los usa)
      if (tipo === 'categoria') {
        await client.query(
          `DELETE FROM material_clasificacion_nivel_especifico WHERE material_clasificacion_subcategoria_id IN (
             SELECT material_clasificacion_subcategoria_id FROM material_clasificacion_subcategoria
             WHERE material_clasificacion_categoria_id = $1)`, [id]);
        await client.query(`DELETE FROM material_clasificacion_subcategoria WHERE material_clasificacion_categoria_id = $1`, [id]);
      } else if (tipo === 'subcategoria') {
        await client.query(`DELETE FROM material_clasificacion_nivel_especifico WHERE material_clasificacion_subcategoria_id = $1`, [id]);
      }
      await client.query(`DELETE FROM ${t.tabla} WHERE ${t.id} = $1`, [id]);
      return { nombre: actual.nombre, movidos: moverA != null ? usos : 0, destino: destino?.nombre ?? null };
    });

    const detalle = r.destino != null
      ? `${t.titulo} #${id}: ${r.nombre} → ${r.destino} (${r.movidos} producto(s))`
      : `${t.titulo} #${id}: ${r.nombre}`;
    await auditoria.registrar(req.user?.id, r.destino != null ? 'fusionar_clasificacion' : 'eliminar_clasificacion', detalle);
    res.json({ ok: true, movidos: r.movidos });
  } catch (err) {
    responderError(res, err, 'Error borrando clasificación:');
  }
}

module.exports = { listar, crear, actualizar, eliminar };
