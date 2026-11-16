/**
 * CU-30: codigos de barras internos (decision D3).
 *
 * Un solo codigo por SKU, solo digitos y con prefijo 2: GS1 reserva los prefijos
 * 20 a 29 para uso interno, asi que no choca con codigos de fabrica reales.
 * Formato: '2' + la secuencia rellenada a 11 digitos = 12 digitos en total.
 *
 * La tabla NO tiene CHECK de formato a proposito (deja la puerta abierta a codigos
 * de proveedor); el formato se garantiza aqui, al generar.
 *
 * Recibe el `client` de una transaccion abierta: se llama junto con el INSERT del
 * material, dentro de conTransaccion().
 */

const FORMATO_INTERNO = /^2\d{11}$/;

/** Genera y guarda el codigo interno del SKU. Devuelve el codigo. */
async function generarCodigoInterno(client, sku) {
  const { rows } = await client.query(
    `INSERT INTO material_codigo_barras (material_sku, material_codigo_barras)
     VALUES ($1, '2' || lpad(nextval('seq_codigo_barras_interno')::text, 11, '0'))
     RETURNING material_codigo_barras AS codigo`,
    [sku]
  );
  const codigo = rows[0].codigo;
  // Con 11 digitos la secuencia no deberia desbordar nunca; si lo hiciera, se
  // aborta la transaccion en vez de guardar un codigo con otro largo.
  if (!FORMATO_INTERNO.test(codigo)) {
    throw new Error(`Codigo interno con formato invalido: ${codigo}`);
  }
  return codigo;
}

/** Minúsculas, sin tildes y con un solo espacio: así se comparan los nombres (igual que el importador). */
function normalizar(texto) {
  return String(texto ?? '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/\s+/g, ' ').trim();
}

/** F-03: prefijo de 3 letras para el SKU: el de la categoría de la clasificación (MAT si no tiene letras). */
function prefijoSku(texto) {
  const letras = normalizar(texto).toUpperCase().replace(/[^A-Z]/g, '');
  return letras.length >= 3 ? letras.slice(0, 3) : 'MAT';
}

/* ── F-34 (DDL-12): cada categoría guarda su prefijo (3 letras, único) ──
   Así no cambia al renombrar la categoría ni choca con otra ("Herrajes" y "Herramientas" daban HER).
   Una categoría sin prefijo guardado sigue con el de su nombre, como antes. */
const FORMATO_PREFIJO = /^[A-Z]{3}$/;
// Prefijos que la derivación automática no asigna: solo gerencia los elige a mano en Catálogos.
// HRM queda para la categoría de herramientas (pedido de Álvaro, 13/10).
const PREFIJOS_RESERVADOS = new Set(['HRM']);

/** Las categorías con su prefijo guardado (tabla chica: se lee entera). */
async function categoriasConPrefijo(client) {
  const { rows } = await client.query(
    `SELECT material_clasificacion_categoria_id::int AS id, material_clasificacion_categoria_nombre_categoria AS nombre,
            material_clasificacion_categoria_prefijo_sku AS prefijo
     FROM material_clasificacion_categoria`);
  return rows;
}

/**
 * Prefijo que se le propone a una categoría NUEVA (o sin prefijo): el de su nombre, si es válido, no está
 * reservado y ninguna otra lo usa; si no, null (lo elige gerencia). `excluirId`: la propia categoría.
 */
async function prefijoPropuesto(client, nombre, excluirId = null) {
  const p = prefijoSku(nombre);
  if (!FORMATO_PREFIJO.test(p) || p === 'MAT' || PREFIJOS_RESERVADOS.has(p)) return null;
  const usado = (await categoriasConPrefijo(client)).some(c => c.prefijo === p && c.id !== Number(excluirId));
  return usado ? null : p;
}

/**
 * Prefijo del SKU para una categoría: { id } o su nombre (el importador la conoce por nombre); null = sin
 * categoría (alta rápida de caja chica → MAT). El guardado manda; sin él, el del nombre.
 */
async function prefijoDeCategoria(client, categoria) {
  if (categoria == null || categoria === '') return prefijoSku(null);
  const todas = await categoriasConPrefijo(client);
  const cat = typeof categoria === 'object'
    ? todas.find(c => c.id === Number(categoria.id))
    : todas.find(c => normalizar(c.nombre) === normalizar(categoria));
  if (cat?.prefijo) return cat.prefijo;
  return prefijoSku(cat ? cat.nombre : (typeof categoria === 'object' ? null : categoria));
}

/**
 * F-03 y F-23b: SKU [CAT]-[NOMBRE]-NNN (máximo 3 + 1 + 6 + 1 + 3 = 14 caracteres; CHECK 4 a 16).
 * El correlativo sigue al mayor que ya exista con la misma raíz. Recibe el `client` de una transacción.
 * F-34: `categoria` es { id }, su nombre o null; el prefijo sale de prefijoDeCategoria().
 */
async function generarSku(client, categoria, nombre) {
  const palabra = normalizar(nombre).toUpperCase().replace(/[^A-Z0-9 ]/g, ' ').trim().split(/\s+/)[0] || 'ITEM';
  const raiz = `${await prefijoDeCategoria(client, categoria)}-${palabra.slice(0, 6)}-`;
  const { rows } = await client.query(
    `SELECT COALESCE(MAX(substring(material_sku FROM $2)::int), 0) AS ultimo
     FROM material WHERE material_sku LIKE $1 AND material_sku ~ $3`,
    [raiz + '%', `^${raiz}(\\d+)$`, `^${raiz}\\d+$`]
  );
  const siguiente = rows[0].ultimo + 1;
  if (siguiente > 999) throw new Error(`Se agotaron los correlativos de ${raiz}`);
  return raiz + String(siguiente).padStart(3, '0');
}

/* ── F-23c: nombres PARECIDOS (no solo idénticos), para no duplicar productos ──
   "Tornillo 8 x 1", "tornillos 8x1" y "TORNILLO 8×1" son el mismo producto escrito distinto.
   Se comparan palabras: sin tildes ni mayúsculas, "8 x 1" = "8x1", sin las palabras de unión, y
   singular = plural (tornillo/tornillos, llave/llaves, motor/motores). Es parecido si comparte al
   menos 2 palabras con el nombre nuevo, o 1 si el nombre nuevo tiene una sola palabra. */
const PALABRAS_DE_UNION = new Set(['de', 'del', 'la', 'el', 'los', 'las', 'un', 'una', 'para', 'con', 'sin', 'y', 'o', 'en', 'a', 'al', 'por']);
const MAX_PARECIDOS = 5;

/** Palabras de un nombre para compararlo (únicas, sin las de unión). */
function palabrasDe(nombre) {
  const t = normalizar(nombre)
    .replace(/×/g, 'x')
    .replace(/(\d)\s*[x*]\s*(?=\d)/g, '$1x')        // 8 x 1 → 8x1
    .replace(/[^a-z0-9.,/x ]/g, ' ');
  return [...new Set(t.split(/\s+/).filter(p => p && !PALABRAS_DE_UNION.has(p)))];
}

/** ¿Misma palabra, en singular o plural? */
function mismaPalabra(a, b) {
  if (a === b) return true;
  const [corta, larga] = a.length <= b.length ? [a, b] : [b, a];
  return corta.length >= 3 && (larga === corta + 's' || larga === corta + 'es');
}

/**
 * Los productos de `materiales` ([{ sku, nombre, ... }]) cuyo nombre se parece a `nombre`, del más al
 * menos parecido (como mucho 5). No incluye los de nombre idéntico: esos se rechazan aparte.
 */
function nombresParecidos(nombre, materiales) {
  const nuevas = palabrasDe(nombre);
  if (nuevas.length === 0) return [];
  const minimo = Math.min(2, nuevas.length);
  const n = normalizar(nombre);
  return materiales
    .filter(m => normalizar(m.nombre) !== n)
    .map(m => {
      const suyas = palabrasDe(m.nombre);
      const comunes = nuevas.filter(p => suyas.some(s => mismaPalabra(p, s))).length;
      return { m, comunes, proporcion: comunes / Math.max(nuevas.length, suyas.length) };
    })
    .filter(x => x.comunes >= minimo)
    .sort((x, y) => y.comunes - x.comunes || y.proporcion - x.proporcion || String(x.m.nombre).localeCompare(String(y.m.nombre)))
    .slice(0, MAX_PARECIDOS)
    .map(x => x.m);
}

module.exports = {
  generarCodigoInterno, FORMATO_INTERNO, generarSku, prefijoSku, normalizar, nombresParecidos,
  FORMATO_PREFIJO, PREFIJOS_RESERVADOS, prefijoPropuesto, prefijoDeCategoria,   // F-34
};
