import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { API } from '../../services/api';
import { useAuth } from '../../hooks/useAuth';
import { useConfirm } from '../../hooks/useDialog';
import { usePageTitle } from '../../contexts/TitleContext';
import Alert, { useAlert } from '../../components/Alert';
import BuscadorProducto from '../../components/BuscadorProducto';
import ModalVincularInsumo from '../../components/ModalVincularInsumo';
import { ERR_BORDER, ERR_FULL } from '../productos/clasificacion';
import { IVA, formatMoney, netoDesdeConIva } from '../../utils/format';   // F-35
import PageHeader from '../../components/PageHeader';   // F-25d

// CU-62: fecha LOCAL. Con toISOString() (UTC) desde las 21:00 en Chile daba el día
// siguiente, y ahora esta fecha se guarda como recepción (el backend rechaza futuras).
const hoy = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const esActiva = (b) => ['activo', 'activa'].includes(b.estado);

/** Registrar Entrada — conversión 1:1 de movimientos/entrada.html */
export default function MovimientoEntrada() {
  usePageTitle('Registrar Entrada');
  const navigate = useNavigate();
  const { user } = useAuth();
  const { alert, showAlert } = useAlert();
  const confirm = useConfirm();

  const [materiales, setMateriales] = useState(null);
  const [bodegas, setBodegas] = useState(null);
  const [proveedores, setProveedores] = useState(null);
  const [tipoEntradaId, setTipoEntradaId] = useState(null);

  const [sku, setSku] = useState('');
  const [bodega, setBodega] = useState('');
  // OPUS-5: anaqueles de la bodega elegida (destino fisico del stock, opcional)
  const [anaqueles, setAnaqueles] = useState([]);
  const [anaquel, setAnaquel] = useState('');
  const [cantidad, setCantidad] = useState('');
  const [fecha, setFecha] = useState(hoy());
  const [proveedor, setProveedor] = useState('');
  const [facturaNumero, setFacturaNumero] = useState('');
  const [facturaFecha, setFacturaFecha] = useState('');
  const [fechaPedido, setFechaPedido] = useState('');
  const [precioUnitario, setPrecioUnitario] = useState('');
  const [precioConIva, setPrecioConIva] = useState('');   // F-35: ayudante para pasar a neto
  // D66: compra (proveedor, precio, pedido y factura obligatorios) o devolución de obra
  const [tipoEntrada, setTipoEntrada] = useState('compra');
  const [descripcion, setDescripcion] = useState('');
  // F-23 (D86): compra por caja chica: el n° del gasto de Finanzas en vez de proveedor, precio y factura
  const [gastoCajaChica, setGastoCajaChica] = useState('');
  // D57: proveedores asociados al SKU (null = aún no se elige producto) y el recurso "mostrar todos"
  const [provsSku, setProvsSku] = useState(null);
  const [mostrarTodos, setMostrarTodos] = useState(false);
  const esCompra = tipoEntrada === 'compra';
  const esCajaChica = tipoEntrada === 'caja_chica';
  // F-38: ajuste de inventario (material que sobra sin una compra): solo gerencia, con su firma
  const esAjuste = tipoEntrada === 'ajuste';
  const puedeAjustar = user?.rol === 'gerencia';
  const [errStyles, setErrStyles] = useState({});
  const [saving, setSaving] = useState(false);
  const [preview, setPreview] = useState(null); // null | 'error' | { total, min, unidad }
  const cantidadRef = useRef(null); // CU-30: tras escanear, el cursor va a la cantidad
  // Sesión 15 (CU-30): Enter en Cantidad no envía el formulario y vuelve al escáner (como en el conteo):
  // así un segundo escaneo no escribe el código en la cantidad ni registra el movimiento por error.
  const volverAlEscaner = (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    // B-39: desde F-41 el lector se usa en el campo Producto (id "sku")
    const el = document.getElementById('sku');
    if (el) { el.focus(); el.select?.(); }
  };
  // CU-124: recepción de un insumo especial pendiente de vincular a sus ventas
  const [recepcion, setRecepcion] = useState(null);
  // F-23b: alta rápida de un material de caja chica que no está en el catálogo
  const [alta, setAlta] = useState(null);   // null = cerrado | { nombre, unidad, descripcion, error, guardando }
  const [unidades, setUnidades] = useState(null);

  // OPUS-5: al elegir bodega se cargan sus anaqueles (GET /api/bodegas/:id ya los trae)
  useEffect(() => {
    let cancelado = false;
    setAnaquel('');
    if (!bodega) { setAnaqueles([]); return; }
    (async () => {
      try {
        const d = await API.bodegas.obtener(bodega);
        if (!cancelado) setAnaqueles(d?.anaqueles || []);
      } catch {
        if (!cancelado) setAnaqueles([]);   // sin anaqueles la entrada igual se puede registrar
      }
    })();
    return () => { cancelado = true; };
  }, [bodega]);

  useEffect(() => {
    let cancelado = false;
    (async () => {
      try {
        const [m, b, p, catalogos] = await Promise.all([
          API.materiales.listar({ estado: 'activo' }),   // CU-30 Exc 3: un inactivo no admite movimientos
          API.bodegas.listar(),
          API.proveedores.listar(),
          API.movimientos.catalogos(),
        ]);
        if (cancelado) return;
        setMateriales(m || []);
        setBodegas((b || []).filter(esActiva));
        setProveedores((p || []).filter(esActiva));   // B-29: un proveedor inactivo no se ofrece (CU-142)
        // Tipo movimiento: solo entradas
        const tipos = (catalogos?.tipos || []).filter(t => t.nombre.toLowerCase().includes('entrada'));
        setTipoEntradaId(tipos[0]?.id ?? null);
      } catch (err) {
        if (!cancelado) showAlert('danger', 'Error cargando catálogos: ' + err.message);
      }
    })();
    return () => { cancelado = true; };
  }, [showAlert]);

  // Preview stock al seleccionar producto
  const onSkuChange = async (val) => {
    setSku(val);
    setMostrarTodos(false);
    if (!val) { setPreview(null); setProvsSku(null); return; }
    try {
      const mat = await API.materiales.obtener(val);
      // D57: solo los proveedores del producto, con el principal preelegido. B-29: y solo los activos (CU-142)
      const provs = (mat.proveedores || []).filter(esActiva);
      setProvsSku(provs);
      setProveedor(provs.length ? String(provs[0].id) : '');
      const total = parseFloat(mat.stock_por_bodega?.reduce((s, b) => s + parseFloat(b.cantidad_fisica || 0), 0) || 0);
      const min = parseFloat(mat.stock_minimo || 0);
      setPreview({ total, min, unidad: mat.unidad_medida || 'unidades' });
    } catch {
      setPreview('error');
    }
  };

  // F-23b: abre el alta rápida; las unidades se cargan la primera vez
  const abrirAlta = async () => {
    setAlta({ nombre: '', unidad: '', descripcion: '', error: '', guardando: false });
    if (unidades) return;
    try { setUnidades(await API.materiales.unidades() || []); }
    catch { setUnidades([]); }
  };

  // F-23c: con `confirmar` se crea aunque haya nombres parecidos ("Es otro producto")
  const crearAlta = async (confirmar = false) => {
    if (!alta.nombre.trim() || !alta.unidad) {
      setAlta(a => ({ ...a, error: 'Ingrese el nombre y la unidad de medida.' }));
      return;
    }
    setAlta(a => ({ ...a, error: '', guardando: true }));
    try {
      const r = await API.materiales.altaRapida({
        nombre: alta.nombre.trim(), unidad_medida_id: Number(alta.unidad), descripcion: alta.descripcion.trim(),
        ...(confirmar && { confirmar_nuevo: true }),
      });
      // F-23c: nombres parecidos → elegir uno de ellos o confirmar que es otro producto
      if (r?.codigo === 'NOMBRES_PARECIDOS') {
        setAlta(a => ({ ...a, parecidos: r.parecidos || [], guardando: false }));
        return;
      }
      // apiFetch devuelve el cuerpo de un 409 (no lanza): ya existe un producto con ese nombre
      if (!r?.sku) {
        setAlta(a => ({ ...a, error: r?.error || 'No se pudo crear el producto.', existente: r?.existente || null, guardando: false }));
        return;
      }
      setMateriales(await API.materiales.listar({ estado: 'activo' }) || []);
      setAlta(null);
      onSkuChange(r.sku);
      showAlert('success', r.message || `Producto ${r.sku} creado.`);
    } catch (err) {
      setAlta(a => ({ ...a, error: err.message, guardando: false }));
    }
  };

  // CU-30: producto leído por escáner → autocompleta producto y bodega, cursor en cantidad.
  // F-41: lo mismo al elegirlo por SKU o nombre en el buscador
  const onProductoEscaneado = (p) => {
    onSkuChange(p.sku);
    const conStock = (p.bodegas || []).filter(b => (bodegas || []).some(x => String(x.id) === String(b.bodega_id)));
    if (conStock.length === 1) setBodega(String(conStock[0].bodega_id));
    requestAnimationFrame(() => cantidadRef.current?.focus());
  };

  // D57: los proveedores del producto (el principal marcado); todos solo si no tiene y se pide
  const listaProveedores = provsSku === null ? []
    : mostrarTodos ? (proveedores || [])
    : provsSku.map(p => ({ id: p.id, nombre: p.nombre + (p.es_principal ? ' (principal)' : '') }));

  // Cálculo tiempo entrega (FR-41)
  let tiempoEntrega = null;
  if (fechaPedido && fecha) {
    const dias = Math.round((new Date(fecha) - new Date(fechaPedido)) / 86400000);
    tiempoEntrega = dias < 0
      ? <span style={{ color: 'var(--danger)' }}>La fecha del pedido no puede ser posterior a la recepción.</span>
      : <>Tiempo de entrega: <strong>{dias} día(s) corridos</strong> <span style={{ color: 'var(--gray)' }}>(el cumplimiento del proveedor se mide en días hábiles)</span></>;
  }

  const onSubmit = async (e) => {
    e.preventDefault();
    const cant = parseFloat(cantidad);
    const lote = null; // el HTML leía #lote opcionalmente; no existe en el formulario
    const errs = {};
    let errE = null;
    if (!sku)                          { errs.sku = ERR_BORDER; errE = 'Selecciona un producto.'; }
    else if (!bodega)                  { errs.bodega = ERR_BORDER; errE = 'Selecciona la bodega de destino.'; }
    else if (isNaN(cant) || cant <= 0) { errs.cantidad = ERR_FULL; errE = 'La cantidad debe ser mayor que 0.'; }
    else if (esCompra && !proveedor)   { errs.proveedor = ERR_BORDER; errE = 'Debes seleccionar un proveedor.'; }
    // D66 (D56): una compra lleva precio, fecha del pedido y factura; una devolución, de dónde vuelve
    else if (esCompra && !(parseFloat(precioUnitario) > 0)) { errs.precio = ERR_BORDER; errE = 'Ingrese el precio unitario de compra (mayor que 0).'; }
    else if (esCompra && !fechaPedido) { errs.fechaPedido = ERR_BORDER; errE = 'Ingrese la fecha del pedido al proveedor.'; }
    else if (esCompra && (!facturaNumero.trim() || !facturaFecha)) { errs.facturaNumero = ERR_BORDER; errs.facturaFecha = ERR_BORDER; errE = 'Ingrese el número y la fecha de emisión de la factura.'; }
    else if (esCajaChica && !/^[1-9]\d{0,9}$/.test(gastoCajaChica.trim())) { errs.gasto = ERR_BORDER; errE = 'Ingrese el n° del gasto de caja chica (lo entrega Finanzas).'; }
    else if (tipoEntrada === 'devolucion' && !descripcion.trim()) { errs.descripcion = ERR_FULL; errE = 'Indique de qué obra o venta vuelve el material.'; }
    else if (esAjuste && !descripcion.trim()) { errs.descripcion = ERR_FULL; errE = 'Indique el motivo del ajuste.'; }
    else if (!tipoEntradaId)           { errE = 'No se encontró tipo de movimiento "entrada". Verifica la BD.'; }
    setErrStyles(errs);
    if (errE) { showAlert('danger', errE); return; }

    // F-38: el ajuste suma a la bodega con la fecha de hoy, sin proveedor, precio, factura ni anaquel
    if (esAjuste) {
      setSaving(true);
      try {
        const r = await API.movimientos.ajustarStock({ sku, bodega_id: parseInt(bodega), sumar: cant, motivo: descripcion.trim() });
        showAlert('success', r.message);
        setTimeout(() => navigate('/movimientos/historial'), 1500);
      } catch (err) {
        showAlert('danger', err.message || 'Error al registrar el ajuste.');
        setSaving(false);
      }
      return;
    }

    // CU-32: Validar datos de factura (ambos o ninguno)
    const fNum = facturaNumero.trim();
    if (fNum && !facturaFecha) { setErrStyles({ facturaFecha: ERR_BORDER }); showAlert('danger', 'Debe ingresar la fecha de emisión de la factura.'); return; }
    if (!fNum && facturaFecha) { setErrStyles({ facturaNumero: ERR_BORDER }); showAlert('danger', 'Debe ingresar el número de la factura.'); return; }
    // CU-32 Exc 2: fecha de factura no puede ser futura
    if (facturaFecha && facturaFecha > hoy()) { setErrStyles({ facturaFecha: ERR_BORDER }); showAlert('danger', 'La fecha de emisión de la factura no puede ser una fecha futura.'); return; }
    // CU-62: la fecha del movimiento es la recepción del lote; el pedido no puede ser posterior
    if (fecha && fecha > hoy()) { showAlert('danger', 'La fecha del movimiento (recepción) no puede ser una fecha futura.'); return; }
    if (fechaPedido && fechaPedido > (fecha || hoy())) { showAlert('danger', 'La fecha del pedido no puede ser posterior a la recepción.'); return; }

    setSaving(true);
    try {
      const datos = {
        sku,
        bodega_id:          parseInt(bodega),
        cantidad:           cant,
        numero_lote:        lote,
        tipo_movimiento_id: tipoEntradaId,
        tipo_entrada:       tipoEntrada,   // D66
        ...(esCompra ? {
          proveedor_id:     parseInt(proveedor),
          // CU-32: factura de compra
          factura_numero:   fNum,
          factura_fecha:    facturaFecha,
          // SONNET-9: precio unitario de compra (alimenta el historial de precios)
          precio_unitario:  parseFloat(precioUnitario),
          // CU-62: fecha del pedido (y recepción, abajo)
          fecha_pedido:     fechaPedido,
        } : esCajaChica ? {
          gasto_caja_chica_id: Number(gastoCajaChica.trim()),
          descripcion_motivo:  descripcion.trim(),   // comercio (opcional): no es un proveedor
        } : { descripcion_motivo: descripcion.trim() }),
        ...(fecha && { fecha_recepcion: fecha }),
        // OPUS-5: anaquel destino dentro de la bodega
        ...(anaquel && { anaquel_id: parseInt(anaquel) }),
      };
      let r;
      try {
        r = await API.movimientos.entrada(datos);
      } catch (err) {
        // F-38 (D92): la recepción es de antes del último conteo o ajuste del producto; no bloquea, se confirma
        if (err.payload?.codigo !== 'POSIBLE_DOBLE_CONTEO') throw err;
        const ok = await confirm(
          <div>
            <div style={{ marginBottom: 8 }}>{err.payload.error}</div>
            <div>Registre la compra solo si el material llegó a la bodega después. Si ya estaba, cancele: el stock ya lo incluye.</div>
          </div>,
          'Posible doble conteo');
        if (!ok) { setSaving(false); return; }
        r = await API.movimientos.entrada({ ...datos, confirmar_doble_conteo: true });
      }
      // Un 409 (factura ya registrada) llega como datos, no como excepción
      if (r?.error) { showAlert('danger', r.error); setSaving(false); return; }
      showAlert('success', esCompra ? 'Entrada registrada correctamente. El stock ha sido actualizado.'
        : esCajaChica ? `Compra por caja chica registrada (gasto CC-${Number(gastoCajaChica.trim())}). El stock ha sido actualizado.`
        : 'Devolución de obra registrada: el stock volvió a la bodega y se descontó del consumo.');
      // CU-124: un insumo especial se vincula a su venta antes de volver al historial
      if (r?.insumo_especial) { setRecepcion(r.insumo_especial); return; }
      setTimeout(() => navigate('/movimientos/historial'), 1500);
    } catch (err) {
      showAlert('danger', err.message || 'Error al registrar la entrada.');
      setSaving(false);
    }
  };

  return (
    <>
      <PageHeader contexto="Stock" titulo="Registrar Entrada" descripcion="Ingreso de stock al inventario">
        <Link to="/movimientos/historial" className="btn btn-secondary">← Volver al historial</Link>
      </PageHeader>

      <div id="alert-container"><Alert {...alert} /></div>

      {/* F-23b: alta rápida de un material de caja chica */}
      {alta && (
        <div className="modal-backdrop" id="modal-alta-rapida" style={{ display: 'flex' }}
          onClick={e => { if (e.target === e.currentTarget && !alta.guardando) setAlta(null); }}>
          <div className="modal" style={{ maxWidth: 460 }}>
            <div className="modal-header">
              <div>
                <div className="modal-title">Nuevo producto (caja chica)</div>
                <div className="modal-subtitle">El SKU lo genera el sistema. Queda sin categoría hasta que gerencia lo clasifique en Productos.</div>
              </div>
              <button className="modal-close" onClick={() => setAlta(null)} disabled={alta.guardando} aria-label="Cerrar">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="18" height="18"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
              </button>
            </div>
            <div className="modal-body">
              {alta.error && (
                <div className="alert alert-danger" style={{ marginBottom: 12 }}>
                  {alta.error}
                  {alta.existente?.estado === 'activo' && (
                    <div style={{ marginTop: 8 }}>
                      <button type="button" className="btn btn-secondary btn-sm" id="usar-existente"
                        onClick={() => { const e = alta.existente; setAlta(null); onSkuChange(e.sku); }}>
                        Seleccionar {alta.existente.sku}
                      </button>
                    </div>
                  )}
                </div>
              )}
              {/* F-23c: productos con un nombre parecido, para no duplicar */}
              {alta.parecidos?.length > 0 && (
                <div className="alert alert-warning" id="alta-parecidos" style={{ marginBottom: 12 }}>
                  <div style={{ marginBottom: 8 }}>
                    {alta.parecidos.length === 1 ? 'Ya existe un producto con un nombre parecido.' : `Ya existen ${alta.parecidos.length} productos con un nombre parecido.`}
                    {' '}Si es el mismo, selecciónelo para no duplicarlo:
                  </div>
                  {alta.parecidos.map(p => (
                    <div key={p.sku} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, padding: '4px 0', borderTop: '1px solid var(--border)' }}>
                      <div style={{ fontSize: 13, minWidth: 0 }}>
                        <strong>{p.nombre}</strong>
                        <div style={{ fontSize: 11, color: 'var(--text-secondary)' }}>
                          {p.sku}{p.unidad ? ` · ${p.unidad}` : ''}{p.estado !== 'activo' ? ` · ${p.estado}` : ''}
                        </div>
                      </div>
                      {p.estado === 'activo'
                        ? <button type="button" className="btn btn-secondary btn-sm" onClick={() => { setAlta(null); onSkuChange(p.sku); }}>Seleccionar</button>
                        : <span style={{ fontSize: 11, color: 'var(--text-secondary)' }}>no se puede usar</span>}
                    </div>
                  ))}
                </div>
              )}
              <div className="form-group">
                <label className="form-label" htmlFor="alta-nombre">Nombre <span className="required">*</span></label>
                <input className="form-control" id="alta-nombre" maxLength={200} autoFocus placeholder="Ej: Guantes de cabritilla talla L"
                  value={alta.nombre} onChange={e => setAlta(a => ({ ...a, nombre: e.target.value, parecidos: null }))} />
              </div>
              <div className="form-group">
                <label className="form-label" htmlFor="alta-unidad">Unidad de medida <span className="required">*</span></label>
                <select className="form-control" id="alta-unidad" value={alta.unidad} disabled={unidades === null}
                  onChange={e => setAlta(a => ({ ...a, unidad: e.target.value }))}>
                  <option value="">{unidades === null ? 'Cargando unidades...' : 'Seleccionar unidad...'}</option>
                  {(unidades || []).map(u => <option key={u.id} value={u.id}>{u.nombre}</option>)}
                </select>
              </div>
              <div className="form-group">
                <label className="form-label" htmlFor="alta-descripcion">Descripción</label>
                <input className="form-control" id="alta-descripcion" placeholder="Opcional: marca, medida, dónde se compró"
                  value={alta.descripcion} onChange={e => setAlta(a => ({ ...a, descripcion: e.target.value }))} />
              </div>
            </div>
            <div className="modal-footer">
              <button type="button" className="btn btn-ghost" onClick={() => setAlta(null)} disabled={alta.guardando}>Cancelar</button>
              {alta.parecidos?.length > 0 ? (
                <button type="button" className="btn btn-primary" id="confirm-alta-otro" onClick={() => crearAlta(true)} disabled={alta.guardando}>
                  {alta.guardando ? 'Creando...' : 'Es otro producto: crearlo'}
                </button>
              ) : (
                <button type="button" className="btn btn-primary" id="confirm-alta-rapida" onClick={() => crearAlta()} disabled={alta.guardando}>
                  {alta.guardando ? 'Creando...' : 'Crear y seleccionar'}
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {recepcion && (
        <ModalVincularInsumo
          recepcion={recepcion}
          unidad={preview && preview !== 'error' ? preview.unidad : ''}
          puedeVincular={['gerencia', 'jop'].includes(user?.rol)}
          onClose={(mensaje) => {
            setRecepcion(null);
            showAlert('success', mensaje || 'Entrada registrada. El insumo especial quedó como stock libre: se puede vincular después desde Alertas → Faltantes → Insumos especiales.');
            setTimeout(() => navigate('/movimientos/historial'), 2500);
          }} />
      )}

      <div className="grid-principal">

        <form id="form-entrada" noValidate onSubmit={onSubmit}>
          <div className="card" style={{ marginBottom: 16 }}>
            <div className="section-label">Datos del producto</div>
            {/* D66: compra al proveedor o devolución de material desde una obra */}
            <div className="form-group">
              <label className="form-label" htmlFor="tipo-entrada">Tipo de entrada <span className="required">*</span></label>
              <select className="form-control" id="tipo-entrada" value={tipoEntrada} onChange={e => setTipoEntrada(e.target.value)}>
                <option value="compra">Compra a proveedor</option>
                <option value="devolucion">Devolución de obra (vuelve material despachado o consumido)</option>
                <option value="caja_chica">Compra por caja chica (gasto registrado en Finanzas)</option>
                {puedeAjustar && <option value="ajuste">Ajuste de inventario (hay más de lo registrado, sin una compra)</option>}
              </select>
            </div>
            <div className="form-row">
              <div className="form-group">
                <label className="form-label" htmlFor="sku">Producto <span className="required">*</span></label>
                {/* F-41: un solo campo para el código de barras (lector), el SKU o el nombre */}
                <BuscadorProducto id="sku" opciones={materiales || []} value={sku} onProducto={onProductoEscaneado} onLimpiar={() => onSkuChange('')}
                  style={errStyles.sku} disabled={materiales === null} placeholder={materiales === null ? 'Cargando productos...' : undefined} />
                {esCajaChica && (
                  <div className="form-hint">
                    ¿No está en el catálogo?{' '}
                    <button type="button" id="btn-alta-rapida" onClick={abrirAlta}
                      style={{ background: 'none', border: 'none', padding: 0, color: 'var(--orange-text)', fontWeight: 600, cursor: 'pointer', fontSize: 'inherit' }}>
                      Crearlo aquí
                    </button>
                  </div>
                )}
              </div>
              <div className="form-group">
                <label className="form-label" htmlFor="bodega">Bodega de destino <span className="required">*</span></label>
                <select className="form-control" id="bodega" required value={bodega} onChange={e => setBodega(e.target.value)} style={errStyles.bodega}>
                  {bodegas === null
                    ? <option value="">Cargando bodegas...</option>
                    : <><option value="">Seleccionar bodega...</option>{bodegas.map(b => <option key={b.id} value={b.id}>{b.nombre}</option>)}</>}
                </select>
              </div>
            </div>
            {/* OPUS-5: anaquel destino — opcional, depende de la bodega elegida */}
            <div className="form-row">
              <div className="form-group">
                <label className="form-label" htmlFor="anaquel">Anaquel de destino</label>
                <select className="form-control" id="anaquel" value={esAjuste ? '' : anaquel} onChange={e => setAnaquel(e.target.value)} disabled={esAjuste || !bodega || anaqueles.length === 0}>
                  <option value="">
                    {esAjuste ? 'El ajuste suma al lote más antiguo de la bodega'
                      : !bodega ? 'Seleccione primero una bodega'
                      : anaqueles.length === 0 ? 'Esta bodega no tiene anaqueles registrados'
                      : 'Sin asignar'}
                  </option>
                  {anaqueles.map(a => <option key={a.id} value={a.id}>{a.descripcion || ('Anaquel #' + a.id)}</option>)}
                </select>
                <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 4 }}>
                  Opcional. Indica en qué anaquel queda físicamente el material.
                </div>
              </div>
              <div className="form-group" />
            </div>
            <div className="form-row">
              <div className="form-group">
                <label className="form-label" htmlFor="cantidad">Cantidad ingresada <span className="required">*</span></label>
                <input ref={cantidadRef} className="form-control" id="cantidad" type="number" min={1} placeholder="0" required value={cantidad} onChange={e => setCantidad(e.target.value)} style={errStyles.cantidad} onKeyDown={volverAlEscaner} />
                <div className="form-hint">Enter vuelve al campo Producto. Para registrar, use el botón.</div>
              </div>
              <div className="form-group">
                <label className="form-label" htmlFor="fecha">Fecha del movimiento <span className="required">*</span></label>
                <input className="form-control" id="fecha" type="date" required value={esAjuste ? hoy() : fecha} onChange={e => setFecha(e.target.value)} disabled={esAjuste} />
                {esAjuste && <div className="form-hint">Un ajuste queda con la fecha y hora de hoy.</div>}
              </div>
            </div>
          </div>

          {esCompra ? (
          <div className="card" style={{ marginBottom: 16 }}>
            <div className="section-label">Proveedor</div>
            <div className="form-row">
              <div className="form-group">
                <label className="form-label" htmlFor="proveedor" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span>Proveedor asociado <span className="required">*</span></span>
                  <a href="/proveedores" target="_blank" rel="noopener" style={{ fontSize: 11, fontWeight: 400, color: 'var(--orange)' }}
                    onClick={e => { e.preventDefault(); window.open('/proveedores', '_blank'); }}>
                    + Crear nuevo proveedor
                  </a>
                </label>
                {/* D57: solo los proveedores asociados al producto; si no tiene, aviso y "mostrar todos" */}
                <select className="form-control" id="proveedor" required value={proveedor} onChange={e => setProveedor(e.target.value)} style={errStyles.proveedor}
                  disabled={proveedores === null || (provsSku !== null && provsSku.length === 0 && !mostrarTodos)}>
                  {proveedores === null
                    ? <option value="">Cargando proveedores...</option>
                    : <><option value="">{provsSku === null ? 'Elija primero el producto' : 'Seleccionar proveedor...'}</option>
                        {listaProveedores.map(p => <option key={p.id} value={p.id}>{p.nombre}</option>)}</>}
                </select>
                {provsSku !== null && provsSku.length === 0 && !mostrarTodos && (
                  <div className="form-hint" id="aviso-sin-proveedor" style={{ color: 'var(--orange)' }}>
                    Este producto no tiene proveedores asociados.{' '}
                    <a href="#" onClick={e => { e.preventDefault(); setMostrarTodos(true); }}>Mostrar todos los proveedores</a>
                  </div>
                )}
                {/* CU-29 Excepción 1: hint si no hay proveedores */}
                {proveedores !== null && proveedores.length === 0 && (
                  <div className="form-hint" id="hint-proveedor-nuevo" style={{ color: 'var(--orange)' }}>
                    ¿No encuentras el proveedor? Créalo y vuelve a esta pantalla — se cargará automáticamente.
                  </div>
                )}
              </div>
              <div className="form-group">
                <label className="form-label" htmlFor="factura-numero">Nº Factura de compra <span className="required">*</span></label>
                <input className="form-control" id="factura-numero" placeholder="FAC-2025-001" value={facturaNumero} onChange={e => setFacturaNumero(e.target.value)} style={errStyles.facturaNumero} />
                <div className="form-hint">Una factura con varios productos se reutiliza en cada entrada (mismo proveedor y fecha)</div>
              </div>
            </div>
            <div className="form-row">
              <div className="form-group">
                <label className="form-label" htmlFor="factura-fecha">Fecha emisión factura <span className="required">*</span></label>
                <input className="form-control" id="factura-fecha" type="date" value={facturaFecha} onChange={e => setFacturaFecha(e.target.value)} style={errStyles.facturaFecha} />
              </div>
              <div className="form-group">
                <label className="form-label" htmlFor="fecha-pedido">Fecha del pedido <span className="required">*</span></label>
                <input className="form-control" id="fecha-pedido" type="date" value={fechaPedido} onChange={e => setFechaPedido(e.target.value)} style={errStyles.fechaPedido} />
              </div>
              <div className="form-group" style={{ display: 'flex', alignItems: 'flex-end' }}>
                <div id="tiempo-entrega-preview" style={{ fontSize: 13, color: 'var(--gray)', paddingBottom: 9 }}>{tiempoEntrega}</div>
              </div>
            </div>
            <div className="form-row">
              <div className="form-group">
                {/* F-35 (D87): el sistema guarda precios netos; la factura trae el total con IVA */}
                <label className="form-label" htmlFor="precio-unitario">Precio unitario neto (sin IVA) <span className="required">*</span></label>
                <input className="form-control" id="precio-unitario" type="number" min={0} step="0.01" placeholder="18500" value={precioUnitario} onChange={e => setPrecioUnitario(e.target.value)} style={errStyles.precio} />
                <div className="form-hint">La factura trae el total con IVA: ingrese el precio sin IVA. Se registra en el historial de precios del producto.</div>
              </div>
              <div className="form-group">
                <label className="form-label" htmlFor="precio-con-iva">¿Tiene el precio con IVA?</label>
                <div style={{ display: 'flex', gap: 8 }}>
                  <input className="form-control" id="precio-con-iva" type="number" min={0} step="0.01" placeholder="22015"
                    value={precioConIva} onChange={e => setPrecioConIva(e.target.value)} />
                  <button type="button" className="btn btn-ghost" id="btn-usar-neto" disabled={netoDesdeConIva(precioConIva) == null}
                    onClick={() => { setPrecioUnitario(String(netoDesdeConIva(precioConIva))); setPrecioConIva(''); }}>
                    Usar neto
                  </button>
                </div>
                <div className="form-hint">
                  {netoDesdeConIva(precioConIva) != null
                    ? `Neto: ${formatMoney(netoDesdeConIva(precioConIva))} (precio con IVA ÷ ${String(1 + IVA).replace('.', ',')})`
                    : 'Opcional: escriba el precio con IVA y se calcula el neto.'}
                </div>
              </div>
            </div>
          </div>

          ) : esCajaChica ? (
          <div className="card" style={{ marginBottom: 16 }} id="card-caja-chica">
            <div className="section-label">Compra por caja chica</div>
            <div className="form-row">
              <div className="form-group">
                <label className="form-label" htmlFor="gasto-caja-chica">N° del gasto de caja chica <span className="required">*</span></label>
                <input className="form-control" id="gasto-caja-chica" inputMode="numeric" placeholder="Ej: 125" value={gastoCajaChica}
                  onChange={e => setGastoCajaChica(e.target.value)} style={errStyles.gasto} />
                <div className="form-hint">El número con que Finanzas registró el gasto. Queda como referencia CC-n°.</div>
              </div>
              <div className="form-group">
                <label className="form-label" htmlFor="descripcion-caja-chica">Comercio o detalle</label>
                <input className="form-control" id="descripcion-caja-chica" maxLength={255} value={descripcion}
                  onChange={e => setDescripcion(e.target.value)} placeholder="Ej: Ferretería San Pedro" />
                <div className="form-hint">Opcional. El comercio no se registra como proveedor.</div>
              </div>
            </div>
            <div className="form-hint">
              No lleva proveedor, precio ni factura: el monto queda en el gasto de Finanzas. Entra como un lote nuevo,
              igual que una compra. Si lo comprado no está en el catálogo, créelo primero en Productos.
            </div>
          </div>
          ) : esAjuste ? (
          <div className="card" style={{ marginBottom: 16 }} id="card-ajuste">
            <div className="section-label">Ajuste de inventario</div>
            <div className="form-group">
              <label className="form-label" htmlFor="motivo-ajuste">Motivo del ajuste <span className="required">*</span></label>
              <textarea className="form-control" id="motivo-ajuste" rows={2} maxLength={255} value={descripcion}
                onChange={e => setDescripcion(e.target.value)} style={errStyles.descripcion}
                placeholder="Ej: al revisar la bodega había 2 rollos más de los registrados" />
              <div className="form-hint">
                Suma la cantidad al stock de la bodega con el motivo "ajuste de inventario": no lleva proveedor, precio ni
                factura y no cuenta como consumo. Si llegó con una compra, regístrela como compra. Pide la autorización de un
                gerente. Para dejar la bodega en una cantidad exacta (también para bajar), use "Ajustar stock" en el producto.
              </div>
            </div>
          </div>
          ) : (
          <div className="card" style={{ marginBottom: 16 }} id="card-devolucion">
            <div className="section-label">Devolución de obra</div>
            <div className="form-group">
              <label className="form-label" htmlFor="descripcion-devolucion">¿De qué obra o venta vuelve? <span className="required">*</span></label>
              <textarea className="form-control" id="descripcion-devolucion" rows={2} maxLength={255} value={descripcion}
                onChange={e => setDescripcion(e.target.value)} style={errStyles.descripcion}
                placeholder="Ej: sobrante de la instalación de la venta NV-2026-015" />
              <div className="form-hint">
                No lleva proveedor, precio ni factura. Se descuenta del consumo (igual que una devolución de OT) y entra como
                un lote nuevo con fecha de hoy.
              </div>
            </div>
          </div>
          )}

          <div className="card">
            <div className="section-label">Responsable</div>
            <div className="form-group">
              <label className="form-label">Usuario responsable</label>
              <input className="form-control" id="usuario" disabled value={user ? (user.username || user.id) : ''} readOnly />
              <div className="form-hint">Se asigna automáticamente con la sesión activa</div>
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 8 }}>
              <Link to="/movimientos/historial" className="btn btn-secondary">Cancelar</Link>
              <button type="submit" className="btn btn-primary" disabled={saving}>
                {saving ? 'Registrando...' : (
                  <>
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" width="15" height="15"><polyline points="20 6 9 17 4 12"/></svg>
                    Registrar entrada
                  </>
                )}
              </button>
            </div>
          </div>
        </form>

        {/* Sidebar informativo */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div className="card">
            <div className="section-label">Método FIFO</div>
            <p style={{ fontSize: 13, color: 'var(--gray)', lineHeight: 1.7 }}>
              Este ingreso creará un nuevo lote con fecha y precio de compra. Al registrar salidas, el sistema descontará primero los lotes más antiguos automáticamente.
            </p>
          </div>
          <div className="card">
            <div className="section-label">Stock actual del producto</div>
            <div id="stock-preview" style={{ textAlign: 'center', padding: '16px 0', color: 'var(--gray)' }}>
              {preview === null && <div style={{ fontSize: 12, color: 'var(--gray)' }}>Selecciona un producto</div>}
              {preview === 'error' && <div style={{ fontSize: 12, color: 'var(--gray)' }}>Error cargando stock</div>}
              {preview && preview !== 'error' && (
                <>
                  <div style={{ fontSize: 36, fontWeight: 700, color: preview.total <= preview.min ? 'var(--danger)' : 'var(--success)' }}>{preview.total}</div>
                  <div style={{ fontSize: 12, color: 'var(--gray)' }}>{preview.unidad} disponibles</div>
                  <div style={{ fontSize: 11, marginTop: 4, color: 'var(--gray)' }}>mínimo: {preview.min}</div>
                </>
              )}
            </div>
          </div>
        </div>

      </div>
    </>
  );
}
