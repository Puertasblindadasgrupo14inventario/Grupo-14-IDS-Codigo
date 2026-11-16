import { useEffect, useState } from 'react';
import { API } from '../services/api';
import Alert from './Alert';
import SelectorProducto from './SelectorProducto';

/**
 * F-41: un solo buscador de productos para los movimientos (Entrada, Salida y Traslado).
 * Reemplaza al par EscanerCodigo + SelectorProducto: el mismo campo acepta el código de
 * barras (el lector funciona como teclado y manda Enter, CU-30), el SKU o parte del nombre.
 *
 *   <BuscadorProducto id="sku" opciones={materiales} value={sku} onProducto={p => ...} onLimpiar={() => ...} />
 *
 * opciones: productos ACTIVOS de GET /materiales (traen codigo_barras), así que un código
 * que coincide se elige sin ir al backend. Al elegir, de cualquier forma, se pide
 * GET /codigos/:sku para tener el stock por bodega y se llama a onProducto con la misma
 * forma que el escáner: { sku, nombre, estado, unidad_medida, codigo_barras, bodegas }.
 * Enter sin coincidencias pregunta al backend para dar el aviso que corresponde: producto
 * inactivo (CU-30 Exc 3, se bloquea) o código desconocido (Exc 1).
 */
export default function BuscadorProducto({
  id, opciones, value, onProducto, onLimpiar, disabled = false, placeholder, style, autoFocus = true,
}) {
  const [aviso, setAviso] = useState(null); // { type, message }
  const [pendiente, setPendiente] = useState(null); // SKU elegido mientras se consulta su stock

  // autoFocus de un input deshabilitado no sirve: el campo se habilita cuando llegan los productos
  useEffect(() => {
    if (autoFocus && !disabled) document.getElementById(id)?.focus();
  }, [autoFocus, disabled, id]);

  const reintentar = () => requestAnimationFrame(() => document.getElementById(id)?.select());

  const identificado = (p) => {
    setAviso({
      type: 'success', sku: p.sku,
      message: <>Producto identificado: <strong>{p.sku} — {p.nombre}</strong> ({p.unidad_medida || 'sin unidad'})</>,
    });
    onProducto(p);
  };

  const elegir = async (sku) => {
    if (!sku) { setAviso(null); onLimpiar?.(); return; }
    setPendiente(sku);
    try {
      const p = await API.codigos.resolver(sku);
      if (!p) return; // 401: el handler global ya redirige al login
      identificado(p);
    } catch {
      // Sin el stock por bodega igual se puede seguir: la bodega se elige a mano
      setAviso({ type: 'warning', message: 'No se pudo consultar el stock por bodega del producto. Elige la bodega a mano.' });
      onProducto({ sku, bodegas: [] });
    } finally {
      setPendiente(null);
    }
  };

  const sinCoincidencia = async (texto) => {
    // El campo es uno solo: lo que no se encontró no puede dejar elegido el producto anterior
    onLimpiar?.();
    try {
      const p = await API.codigos.resolver(texto);
      if (!p) return;
      if (p.estado !== 'activo') {
        // Exc 3: se bloquea antes de pedir la cantidad
        setAviso({
          type: 'danger',
          message: <>El producto <strong>{p.sku} — {p.nombre}</strong> está inactivo o dado de baja. No se pueden registrar movimientos.</>,
        });
        reintentar();
        return;
      }
      identificado(p);
    } catch (err) {
      if (err.status === 404) {
        // Exc 1: código desconocido → se corrige aquí mismo
        setAviso({
          type: 'warning',
          message: <>No hay ningún producto con el código, SKU o nombre <strong>{texto}</strong>. Revise lo escrito o busque por otra parte del nombre.</>,
        });
      } else {
        setAviso({ type: 'danger', message: err.message || 'No se pudo buscar el código.' });
      }
      reintentar();
    }
  };

  return (
    <>
      <SelectorProducto id={id} opciones={opciones} value={pendiente ?? value} onChange={elegir}
        buscarCodigo onEnterSinCoincidencia={sinCoincidencia} disabled={disabled} style={style}
        placeholder={placeholder ?? 'Escanee el código, o escriba el SKU o el nombre'} />
      <div className="form-hint">
        Con el cursor en este campo se puede usar el lector de códigos. También acepta el SKU o parte del nombre.
      </div>
      {/* El "identificado" se va solo si el formulario cambia o limpia el producto (tras registrar) */}
      {aviso && (aviso.type !== 'success' || aviso.sku === value) && (
        <Alert type={aviso.type} message={aviso.message} style={{ marginTop: 8, marginBottom: 0 }} />
      )}
    </>
  );
}
