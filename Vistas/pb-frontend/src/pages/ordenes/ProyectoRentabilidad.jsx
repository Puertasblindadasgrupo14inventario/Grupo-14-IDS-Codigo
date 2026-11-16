import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { API } from '../../services/api';
import { formatMoney, formatQty } from '../../utils/format';
import { exportarCSV } from '../../utils/csvExport';
import { usePageTitle } from '../../contexts/TitleContext';
import Alert, { useAlert, AvisoCerrable } from '../../components/Alert';
import BotonExportar from '../../components/BotonExportar';
import NotaMontosNetos from '../../components/NotaMontosNetos';

import PageHeader from '../../components/PageHeader';   // F-25d
/**
 * F-32: rentabilidad por proyecto (solo gerencia). Una fila por puerta (las OT por área de F-30 se
 * juntan), con la fórmula de F-10 (D75): costo de producción / (1 − margen) / (1 − reserva). El costo
 * adicional por puerta es la mano de obra estándar de la receta (DDL-10); el de la pantalla se usa
 * solo en las recetas sin estándar. Frente a lo vendido en Finanzas: ¿se vende caro o barato?
 */
export default function ProyectoRentabilidad() {
  usePageTitle('Rentabilidad del proyecto');
  const { id } = useParams();
  const { alert, showAlert } = useAlert();
  const [margen, setMargen] = useState('40');
  const [reserva, setReserva] = useState('0');
  const [adicional, setAdicional] = useState('');
  const [datos, setDatos] = useState(null);
  const [cargando, setCargando] = useState(false);

  const calcular = useCallback(async () => {
    const m = parseFloat(String(margen).replace(',', '.'));
    const res = reserva === '' ? 0 : parseFloat(String(reserva).replace(',', '.'));
    const adi = adicional === '' ? 0 : parseFloat(String(adicional).replace(',', '.'));
    if (!(m > 0 && m < 100)) { showAlert('warning', 'El margen debe ser mayor que 0 y menor que 100 %.'); return; }
    if (!(res >= 0 && res < 100)) { showAlert('warning', 'La reserva de negociación debe estar entre 0 y menos de 100 %.'); return; }
    if (!(adi >= 0)) { showAlert('warning', 'El costo adicional por puerta debe ser 0 o más.'); return; }
    setCargando(true);
    try {
      const r = await API.ordenesTrabajo.rentabilidadProyecto(id, { margen: m, reserva: res, adicional: adi });
      setDatos(r);
    } catch (err) {
      showAlert('danger', err.message);
    } finally {
      setCargando(false);
    }
  }, [id, margen, reserva, adicional, showAlert]);

  // Primer cálculo con los valores por omisión (no se recalcula al escribir: para eso está "Calcular")
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { calcular(); }, [id]);

  const puertas = datos?.puertas || [];
  const t = datos?.totales;
  const v = datos?.venta;
  const nombreReceta = (p) => (p.receta ? `${p.receta.codigo} — ${p.receta.nombre}` : 'Sin receta');
  const titulo = (p) => (p.puerta ? `Puerta #${p.puerta}` : `OT #${p.ots[0]?.id}`);

  const exportar = () => {
    const headers = ['Puerta', 'Receta', { titulo: 'Puertas', formato: 'numero' }, 'OT',
      { titulo: 'Materiales (neto)', formato: 'clp' }, { titulo: 'Mano de obra por puerta (neto)', formato: 'clp' }, 'Origen',
      { titulo: 'Costo de producción (neto)', formato: 'clp' }, { titulo: 'Precio sugerido (neto)', formato: 'clp' }];
    const rows = puertas.map(p => [titulo(p), nombreReceta(p), p.cantidad_puertas, p.ots.map(o => '#' + o.id).join(' '),
      p.costo_materiales, p.costo_adicional_puerta, p.origen_adicional === 'receta' ? 'Estándar de la receta' : 'Pantalla',
      p.costo_produccion, p.precio_sugerido]);
    try { exportarCSV('rentabilidad-proyecto', headers, rows); } catch (e) { showAlert('danger', e.message); }
  };

  const diferencia = v?.diferencia_pct;
  const colorDif = diferencia == null ? 'var(--gray)' : diferencia < 0 ? 'var(--danger)' : 'var(--success)';
  // Ajuste del 27/10: se comparan solo las puertas y por puerta; el resto de la venta se muestra aparte
  const porTipo = datos?.por_tipo || [];
  const otros = v?.otros;
  const pctTexto = (x) => (x == null ? '—' : `${x > 0 ? '+' : ''}${formatQty(x)} %`);
  const colorPct = (x) => (x == null ? 'var(--gray)' : x < 0 ? 'var(--danger)' : 'var(--success)');

  return (
    <>
      <PageHeader contexto="Producción" titulo="Rentabilidad del proyecto" descripcion={<>{datos?.proyecto ? `${datos.proyecto.codigo} — ${datos.proyecto.nombre || ''}` : 'Cargando...'}</>} nota={<NotaMontosNetos />}>
        <BotonExportar id="btn-exportar-rentabilidad" onClick={exportar} filas={datos ? puertas.length : null} />
        <Link to="/ordenes/proyectos" className="btn btn-secondary">← Proyectos</Link>
      </PageHeader>

      <div id="alert-container"><Alert {...alert} /></div>

      <div className="card" style={{ marginBottom: 16 }}>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <div className="form-group" style={{ marginBottom: 0, width: 120 }}>
            <label className="form-label" htmlFor="pr-margen">Margen (%)</label>
            <input className="form-control" id="pr-margen" inputMode="decimal" value={margen} onChange={e => setMargen(e.target.value)} />
          </div>
          <div className="form-group" style={{ marginBottom: 0, width: 170 }}>
            <label className="form-label" htmlFor="pr-reserva">Reserva de negociación (%)</label>
            <input className="form-control" id="pr-reserva" inputMode="decimal" value={reserva} onChange={e => setReserva(e.target.value)} />
          </div>
          <div className="form-group" style={{ marginBottom: 0, flex: 1, minWidth: 240 }}>
            <label className="form-label" htmlFor="pr-adicional">Costo adicional por puerta (neto, $) para recetas sin estándar</label>
            <input className="form-control" id="pr-adicional" inputMode="numeric" placeholder="0" value={adicional} onChange={e => setAdicional(e.target.value)} />
          </div>
          <button className="btn btn-primary" id="btn-calcular-proyecto" onClick={calcular} disabled={cargando}>
            {cargando ? 'Calculando...' : 'Calcular'}
          </button>
        </div>
        <div className="form-hint" style={{ marginTop: 8 }}>
          Precio sugerido = costo de producción / (1 − margen) / (1 − reserva). La mano de obra de cada puerta es el
          estándar de su receta; se cambia en Recetas.
        </div>
      </div>

      {(datos?.advertencias || []).map(a => (
        <AvisoCerrable key={a} className="alert alert-warning" style={{ marginBottom: 8 }}>{a}</AvisoCerrable>
      ))}

      {t && (
        <div className="kpi-grid" style={{ marginBottom: 16 }}>
          <div className="kpi-card"><div className="kpi-label">Costo de producción</div><div className="kpi-value" id="kpi-costo">{formatMoney(t.costo_produccion)}</div>
            <div className="kpi-sub">{formatMoney(t.costo_materiales)} materiales + {formatMoney(t.costo_adicional)} mano de obra</div></div>
          <div className="kpi-card"><div className="kpi-label">Precio sugerido</div><div className="kpi-value" id="kpi-sugerido">{formatMoney(t.precio_sugerido)}</div>
            <div className="kpi-sub">{formatQty(t.puertas)} puerta(s){t.sugerido_por_puerta != null && <> · {formatMoney(t.sugerido_por_puerta)} por puerta</>} · margen {formatMoney(t.margen_monto)}</div></div>
          <div className="kpi-card"><div className="kpi-label">Vendido en puertas (Finanzas)</div>
            <div className="kpi-value" id="kpi-vendido">{v?.ventas?.length ? formatMoney(v.puertas.total) : '—'}</div>
            <div className="kpi-sub">
              {v?.ventas?.length ? <>{formatQty(v.puertas.cantidad)} puerta(s) · {v.ventas.map(x => x.numero).join(', ')}</> : 'Sin ventas vigentes'}
              {otros?.total > 0 && <div>+ {formatMoney(otros.total)} en otros ítems (no se comparan)</div>}
            </div></div>
          <div className="kpi-card"><div className="kpi-label">Venta por puerta frente al sugerido</div>
            <div className="kpi-value" id="kpi-diferencia" style={{ color: colorDif }}>{pctTexto(diferencia)}</div>
            <div className="kpi-sub">{diferencia == null ? 'Sin precio de puerta para comparar'
              : <>{formatMoney(v.puertas.por_puerta)} frente a {formatMoney(t.sugerido_por_puerta)} por puerta: se vende {formatMoney(Math.abs(v.diferencia_monto))} {diferencia < 0 ? 'bajo' : 'sobre'} el sugerido</>}</div></div>
        </div>
      )}

      <div className="card">
        <div className="card-title">Por puerta</div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr><th>Puerta</th><th>Receta</th><th style={{ textAlign: 'right' }}>Puertas</th><th>OT</th>
                <th style={{ textAlign: 'right' }}>Materiales</th><th style={{ textAlign: 'right' }}>Mano de obra</th>
                <th style={{ textAlign: 'right' }}>Costo de producción</th><th style={{ textAlign: 'right' }}>Precio sugerido</th></tr>
            </thead>
            <tbody id="rentabilidad-body">
              {!datos && <tr><td colSpan={8} style={{ textAlign: 'center', padding: 24 }}>{cargando ? 'Calculando…' : '—'}</td></tr>}
              {datos && puertas.length === 0 && <tr><td colSpan={8} style={{ textAlign: 'center', padding: 24, color: 'var(--gray)' }}>El proyecto no tiene órdenes de trabajo vigentes.</td></tr>}
              {puertas.map(p => (
                <tr key={p.clave}>
                  <td style={{ fontWeight: 600 }}>{titulo(p)}</td>
                  <td style={{ fontSize: 12 }}>{nombreReceta(p)}</td>
                  <td style={{ textAlign: 'right' }}>{formatQty(p.cantidad_puertas)}{p.sin_cantidad ? ' *' : ''}</td>
                  <td style={{ fontSize: 12 }}>
                    {p.ots.map((o, i) => (
                      <span key={o.id}>{i > 0 && ', '}<Link to={`/ordenes/${o.id}/costos`} title={o.area || ''}>#{o.id}</Link></span>
                    ))}
                  </td>
                  <td style={{ textAlign: 'right' }}>{formatMoney(p.costo_materiales)}{p.insumos_sin_precio > 0 ? ' *' : ''}</td>
                  <td style={{ textAlign: 'right' }} title={p.origen_adicional === 'receta' ? 'Estándar de la receta' : 'Costo de la pantalla (la receta no tiene estándar)'}>
                    {formatMoney(p.costo_adicional)}
                    <div style={{ fontSize: 11, color: 'var(--text-secondary)' }}>
                      {formatMoney(p.costo_adicional_puerta)} × {formatQty(p.cantidad_puertas)} · {p.origen_adicional === 'receta' ? 'receta' : 'pantalla'}
                    </div>
                  </td>
                  <td style={{ textAlign: 'right' }}>{formatMoney(p.costo_produccion)}</td>
                  <td style={{ textAlign: 'right', fontWeight: 600 }}>{formatMoney(p.precio_sugerido)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {porTipo.length > 0 && (
        <div className="card" style={{ marginTop: 16 }}>
          <div className="card-title">Por tipo de puerta</div>
          <div className="form-hint" style={{ marginBottom: 8 }}>
            Cada receta por separado: lo vendido de ese tipo frente al sugerido de sus OT, por puerta.
          </div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr><th>Tipo de puerta</th><th style={{ textAlign: 'right' }}>Vendidas</th><th style={{ textAlign: 'right' }}>Venta por puerta</th>
                  <th style={{ textAlign: 'right' }}>En OT</th><th style={{ textAlign: 'right' }}>Sugerido por puerta</th><th style={{ textAlign: 'right' }}>Diferencia</th></tr>
              </thead>
              <tbody id="rentabilidad-tipos">
                {porTipo.map(tp => (
                  <tr key={tp.receta?.id ?? 'sin-receta'}>
                    <td style={{ fontSize: 12 }}>{tp.receta ? `${tp.receta.codigo || '—'} — ${tp.receta.nombre || ''}` : 'OT sin receta'}</td>
                    <td style={{ textAlign: 'right' }}>{formatQty(tp.vendidas)}</td>
                    <td style={{ textAlign: 'right' }}>{tp.venta_por_puerta == null ? '—' : formatMoney(tp.venta_por_puerta)}</td>
                    <td style={{ textAlign: 'right' }}>{formatQty(tp.en_ot)}</td>
                    <td style={{ textAlign: 'right' }}>{tp.sugerido_por_puerta == null ? '—' : formatMoney(tp.sugerido_por_puerta)}</td>
                    <td style={{ textAlign: 'right', fontWeight: 600, color: colorPct(tp.diferencia_pct) }}>{pctTexto(tp.diferencia_pct)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {otros?.lineas?.length > 0 && (
        <div className="card" style={{ marginTop: 16 }}>
          <div className="card-title">Otros ítems de la venta</div>
          <div className="form-hint" style={{ marginBottom: 8 }}>
            Instalación, materiales sueltos y otros: no tienen costo en las OT, así que no entran en la comparación.
          </div>
          <div className="table-wrap">
            <table>
              <thead><tr><th>Venta</th><th>Descripción</th><th style={{ textAlign: 'right' }}>Cantidad</th><th style={{ textAlign: 'right' }}>Monto</th></tr></thead>
              <tbody id="rentabilidad-otros">
                {otros.lineas.map((o, i) => (
                  <tr key={i}>
                    <td>{o.venta}</td>
                    <td>{o.descripcion || o.sku || '—'}{o.sku && o.descripcion ? <span className="td-mono" style={{ marginLeft: 6, color: 'var(--gray)' }}>{o.sku}</span> : null}</td>
                    <td style={{ textAlign: 'right' }}>{formatQty(o.cantidad)}</td>
                    <td style={{ textAlign: 'right' }}>{formatMoney(o.total)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </>
  );
}
