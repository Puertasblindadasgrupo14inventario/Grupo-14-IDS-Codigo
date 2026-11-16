import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { API } from '../../services/api';
import { formatQty, etiqueta, fechaLocal } from '../../utils/format';
import { usePageTitle } from '../../contexts/TitleContext';
import Alert, { useAlert } from '../../components/Alert';

import PageHeader from '../../components/PageHeader';   // F-25d
/**
 * F-30 parte 2: hoja de trabajo imprimible de una OT, con el formato de la OT en papel.
 * Lleva la ficha de la OT, las medidas (marco, bastidor y medida final de la hoja calculados con
 * config/medidas.js), la especificación de la puerta, la nota de esta área y los insumos de su área
 * según la receta. Sin montos. Cada área imprime la suya desde su OT.
 */
export default function HojaOT() {
  usePageTitle('Hoja de trabajo');
  const { id: otId } = useParams();
  const { alert, showAlert } = useAlert();
  const [det, setDet] = useState(null);       // consumos(): orden y campos de la especificación
  const [prec, setPrec] = useState(null);     // recetas.porOrden(): medidas, derivadas e insumos del área

  useEffect(() => {
    let cancelado = false;
    Promise.all([API.ordenesTrabajo.consumos(otId), API.recetas.porOrden(otId)])
      .then(([d, p]) => { if (!cancelado) { setDet(d); setPrec(p); } })
      .catch(err => { if (!cancelado) showAlert('danger', 'Error: ' + err.message); });
    return () => { cancelado = true; };
  }, [otId, showAlert]);

  const orden = det?.orden;
  const medidas = prec?.orden?.medidas ?? null;
  const der = prec?.orden?.derivadas ?? null;
  const esp = orden?.especificacion || {};
  const nota = orden ? esp.notas_area?.[String(orden.area_id)] ?? '' : '';
  const campos = det?.campos_especificacion || [];
  // F-09: ítems no estándar sin área (todas) o del área de esta OT
  const noEstandar = orden ? (esp.no_estandar || []).filter(i => i.area_id == null || String(i.area_id) === String(orden.area_id)) : [];
  const mm =(a, b) => `${formatQty(a)} × ${formatQty(b)} mm`;

  const ficha = orden ? [
    ['Área', orden.area || '—'],
    ['Proyecto', orden.proyecto_codigo ? `${orden.proyecto_codigo}${orden.proyecto_nombre ? ' — ' + orden.proyecto_nombre : ''}` : '—'],
    ...(orden.ventas?.length ? [[orden.ventas.length === 1 ? 'Venta' : 'Ventas', orden.ventas.map(v => v.numero).join(', ')]] : []),
    ['Modelo (receta)', orden.receta_codigo ? `${orden.receta_codigo}${orden.receta_nombre ? ' — ' + orden.receta_nombre : ''}` : '—'],
    ['Puertas', orden.cantidad_puertas ?? '—'],
    ['Responsable', orden.responsable || '—'],
    ...(orden.empleado_tentativo && !orden.empleado_tentativo_heredado ? [['Empleado tentativo', orden.empleado_tentativo]] : []),
    ['Estado', etiqueta(orden.estado)],
  ] : [];

  const filasMedidas = medidas && der ? [
    [medidas.medido === 'marco' ? 'Marco (ingresado)' : 'Vano', medidas.medido === 'marco' ? mm(der.marco_ancho, der.marco_alto) : mm(der.vano_ancho, der.vano_alto)],
    ...(medidas.medido === 'marco' ? [] : [['Marco', mm(der.marco_ancho, der.marco_alto)]]),
    ['Perfil del marco', `${formatQty(medidas.perfil_marco_mm)} mm`],
    ['Hojas', medidas.hojas],
    ['MDF', medidas.mdf ? `${formatQty(medidas.mdf_espesor_mm ?? 4)} mm por lado` : 'Sin MDF'],
    ['Bastidor', mm(der.bastidor_ancho, der.bastidor_alto) + (medidas.hojas > 1 ? ' (cada hoja)' : '')],
    ['Medida final de la hoja', mm(der.hoja_ancho, der.hoja_alto) + (medidas.hojas > 1 ? ' (cada hoja)' : '')],
  ] : [];

  return (
    <>
      {/* Solo se imprime la hoja, sin menú ni barra superior */}
      <style>{`
        .hoja-ot { background: var(--white); color: var(--black); font-family: Arial, Helvetica, sans-serif; font-size: 10.5pt;
                   max-width: 190mm; margin: 0 auto; padding: 10mm; border: 1px solid var(--border); }
        .hoja-ot h1 { font-size: 15pt; margin: 0; }
        .hoja-ot h2 { font-size: 11pt; margin: 14px 0 6px; border-bottom: 1.5px solid var(--black); padding-bottom: 2px; }
        .hoja-ot table { width: 100%; border-collapse: collapse; }
        .hoja-ot td, .hoja-ot th { border: 1px solid var(--gray); padding: 4px 6px; vertical-align: top; text-align: left; }
        .hoja-ot th { background: var(--gray-mid); font-weight: 700; }
        .hoja-ot .hoja-campos { display: grid; grid-template-columns: 1fr 1fr; column-gap: 16px; }
        .hoja-ot .hoja-campo { display: flex; gap: 6px; border-bottom: 1px solid var(--gray); padding: 5px 0 2px; min-height: 18px; }
        .hoja-ot .hoja-campo span:first-child { font-weight: 700; white-space: nowrap; }
        .hoja-ot .hoja-caja { border: 1px solid var(--gray); min-height: 40px; padding: 4px 6px; white-space: pre-wrap; }
        @media print {
          @page { size: A4; margin: 10mm; }
          .sidebar, .topbar, .sidebar-overlay, #inactivity-warning, .no-print { display: none !important; }
          .main-content { margin: 0 !important; }
          .page-body { padding: 0 !important; }
          body { background: var(--white) !important; }
          .hoja-ot { border: none; padding: 0; max-width: none; }
        }
      `}</style>

      <div className="no-print">
        <PageHeader contexto="Producción" titulo="Hoja de trabajo" descripcion={<>OT #{otId}{orden?.area ? ` · ${orden.area}` : ''}</>}>
          <Link to={`/ordenes/${otId}`} className="btn btn-ghost">← Volver a la OT</Link>
          <button className="btn btn-primary" id="btn-imprimir-hoja" disabled={!orden} onClick={() => window.print()}>Imprimir</button>
        </PageHeader>
        <Alert {...alert} />
      </div>

      {!orden ? (
        !alert?.message && <div className="no-print" style={{ color: 'var(--gray)', fontSize: 13 }}>Cargando la hoja...</div>
      ) : (
        <div className="hoja-ot" id="hoja-ot">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
            <h1>ORDEN DE TRABAJO N° {otId}</h1>
            <div>Fecha: <strong>{orden.fecha_creacion ? fechaLocal(orden.fecha_creacion) : '—'}</strong></div>
          </div>

          <h2>Datos de la OT</h2>
          <table><tbody>
            {ficha.map(([k, v]) => <tr key={k}><th style={{ width: '30%' }}>{k}</th><td>{v}</td></tr>)}
          </tbody></table>

          <h2>Medidas</h2>
          {filasMedidas.length ? (
            <table><tbody>
              {filasMedidas.map(([k, v]) => <tr key={k}><th style={{ width: '30%' }}>{k}</th><td>{v}</td></tr>)}
            </tbody></table>
          ) : <div className="hoja-caja">Sin medidas cargadas.</div>}

          <h2>Especificación</h2>
          <div className="hoja-campos">
            {campos.filter(c => c.clave !== 'otros').map(c => (
              <div className="hoja-campo" key={c.clave}><span>{c.etiqueta}:</span><span>{esp.campos?.[c.clave] ?? ''}</span></div>
            ))}
          </div>
          <div style={{ marginTop: 8, fontWeight: 700 }}>Otros</div>
          <div className="hoja-caja">{esp.campos?.otros ?? ''}</div>

          <h2>Nota para {orden.area || 'el área'}</h2>
          <div className="hoja-caja">{nota}</div>

          {noEstandar.length > 0 && (
            <>
              <h2>Ítems no estándar</h2>
              <table id="hoja-no-estandar">
                <thead><tr><th>Descripción</th><th style={{ textAlign: 'right' }}>Cantidad</th><th>Unidad</th><th>Nota</th></tr></thead>
                <tbody>
                  {noEstandar.map((i, n) => (
                    <tr key={n}><td>{i.descripcion}</td><td style={{ textAlign: 'right' }}>{formatQty(i.cantidad)}</td>
                      <td>{i.unidad || ''}</td><td>{i.nota || ''}</td></tr>
                  ))}
                </tbody>
              </table>
            </>
          )}

          <h2>Insumos del área según la receta</h2>
          {prec?.materiales?.length ? (
            <table>
              <thead><tr><th>SKU</th><th>Insumo</th><th style={{ textAlign: 'right' }}>Cantidad</th><th>Unidad</th></tr></thead>
              <tbody>
                {prec.materiales.map(m => (
                  <tr key={m.sku}>
                    <td>{m.sku}</td><td>{m.nombre}</td>
                    <td style={{ textAlign: 'right' }}>{m.cantidad_total == null ? 'falta medida' : formatQty(m.cantidad_total)}</td>
                    <td>{m.unidad || ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : <div className="hoja-caja">{prec?.motivo_sin_receta || 'Sin insumos de receta para esta área.'}</div>}
        </div>
      )}
    </>
  );
}
