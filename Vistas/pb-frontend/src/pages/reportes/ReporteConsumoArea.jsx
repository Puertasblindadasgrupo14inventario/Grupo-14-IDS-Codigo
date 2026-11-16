import { useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { API } from '../../services/api';
import { formatQty, formatMoney } from '../../utils/format';
import { exportarCSV } from '../../utils/csvExport';
import { useAuth } from '../../hooks/useAuth';
import { usePageTitle } from '../../contexts/TitleContext';
import Alert, { useAlert } from '../../components/Alert';
import BotonExportar from '../../components/BotonExportar';
import { BarrasAgrupadas, BarrasHorizontales, descargarGrafico, etiquetaPeriodo } from '../../components/Charts';
import SelectorProducto from '../../components/SelectorProducto';
import { ocultaMontos } from '../../utils/user';
import ReportesNav from '../../components/ReportesNav';
import NotaMontosNetos from '../../components/NotaMontosNetos';   // F-35
import PageHeader from '../../components/PageHeader';   // F-25d
import Pagination from '../../components/Pagination';   // B-10b
import { usePagination } from '../../hooks/usePagination';

const MSG_INICIAL = 'Seleccione fechas y presione "Generar reporte"';

/** Presets de período (OPUS-12). 'personalizado' deja las fechas como estén. */
// toISOString() devuelve la fecha en UTC: de tarde en Chile (UTC-4/-3) ya es el
// día siguiente, así que "hasta" salía un día adelantado. Se arma en local.
const aISO = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const hoyISO = () => aISO(new Date());
const primerDiaMes = (d = new Date()) => aISO(new Date(d.getFullYear(), d.getMonth(), 1));
const restarMeses = (n) => {
  const d = new Date();
  return aISO(new Date(d.getFullYear(), d.getMonth() - n, d.getDate()));
};
const PERIODOS = {
  mes:          { etiqueta: 'Mes actual',    rango: () => ({ desde: primerDiaMes(), hasta: hoyISO() }) },
  trimestre:    { etiqueta: 'Últimos 3 meses', rango: () => ({ desde: restarMeses(3), hasta: hoyISO() }) },
  semestre:     { etiqueta: 'Últimos 6 meses', rango: () => ({ desde: restarMeses(6), hasta: hoyISO() }) },
  anio:         { etiqueta: 'Último año',    rango: () => ({ desde: restarMeses(12), hasta: hoyISO() }) },
  personalizado:{ etiqueta: 'Personalizado', rango: null },
};

/** Montos abreviados para los ejes: 1.181.600 no cabe repetido 5 veces. */
const montoEje = (v) => {
  const n = Math.round(v);
  if (Math.abs(n) >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
  if (Math.abs(n) >= 1e3) return '$' + Math.round(n / 1e3) + 'k';
  return '$' + n;
};

/** Consumo por Área — conversión 1:1 de reportes/consumo-area.html. data-rol="gerencia": enlace Valorización. */
export default function ReporteConsumoArea() {
  usePageTitle('Consumo por Área');
  const { user } = useAuth();
  const { alert, showAlert } = useAlert();
  const [params] = useSearchParams();
  // Montos ocultos a jop: el backend no le envía precios ni costos y mide en cantidad
  const verCostos = !ocultaMontos(user);

  const [areas, setAreas] = useState([]);
  const [areaId, setAreaId] = useState('');
  // B-32: sin fechas en la URL, el mes en curso (antes la tabla partía sin período y vacía)
  const [desde, setDesde] = useState(params.get('desde') || primerDiaMes());
  const [hasta, setHasta] = useState(params.get('hasta') || hoyISO());
  const [resumen, setResumen] = useState(null);     // resumen_por_area o null (oculto)
  const [consumos, setConsumos] = useState(null);   // null = mensaje de tabla
  const pag = usePagination(consumos, 20);   // B-10b: el CSV exporta todo, no solo la página
  const [msgTabla, setMsgTabla] = useState(MSG_INICIAL);

  // OPUS-12 (Req #4): vista de gráficos. F-18: el Dashboard abre un mes con ?vista=graficos&desde=&hasta=
  const [vista, setVista] = useState(params.get('vista') === 'graficos' ? 'graficos' : 'tabla');      // 'tabla' | 'graficos'
  const [periodo, setPeriodo] = useState('personalizado');
  const [gArea, setGArea] = useState(null);
  const [gMaterial, setGMaterial] = useState(null);
  const refArea = useRef(null);
  const refMaterial = useRef(null);

  // CU-69: Cargar áreas al iniciar
  useEffect(() => { API.reportes.listarAreas().then(a => setAreas(a || [])).catch(() => {}); }, []);

  const aplicarPeriodo = (clave) => {
    setPeriodo(clave);
    const p = PERIODOS[clave];
    if (p?.rango) {
      const { desde: d, hasta: h } = p.rango();
      setDesde(d);
      setHasta(h);
    }
  };

  // Los tres gráficos se piden juntos: son tres agrupaciones del mismo período
  const cargarGraficos = useCallback(async () => {
    try {
      const [a, m] = await Promise.all([
        API.reportes.consumoAreaGrafico({ desde, hasta, agrupar: 'area' }),
        API.reportes.consumoAreaGrafico({ desde, hasta, agrupar: 'material' }),
      ]);
      setGArea(a); setGMaterial(m);
    } catch (err) {
      showAlert('danger', 'Error cargando los gráficos: ' + err.message);
    }
  }, [desde, hasta, showAlert]);

  useEffect(() => { if (vista === 'graficos') cargarGraficos(); }, [vista, cargarGraficos]);

  const generarReporte = async () => {
    try {
      const data = await API.reportes.consumoArea({ area_id: areaId, desde, hasta });
      if (data?.error) { setResumen(null); setConsumos(null); setMsgTabla('Sin resultados'); showAlert('danger', data.error); return; }
      if (data?.mensaje) { setResumen(null); setConsumos(null); setMsgTabla('Sin resultados para los filtros aplicados'); showAlert('info', data.mensaje); return; }
      const { consumos: c, resumen_por_area } = data;
      const hayResumen = resumen_por_area && resumen_por_area.length > 0;
      setResumen(hayResumen ? resumen_por_area : null);
      if (!c || c.length === 0) {
        setConsumos(null);
        setMsgTabla('No hay datos de consumo para mostrar con los filtros aplicados');
        return;
      }
      setConsumos(c);
    } catch (err) {
      showAlert('danger', 'Error: ' + err.message);
    }
  };

  // B-32: la tabla se carga sola al abrir (los gráficos ya lo hacían)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { if (vista === 'tabla') generarReporte(); }, []);

  const limpiar = () => {
    setAreaId(''); setDesde(''); setHasta(''); setResumen(null); setConsumos(null);
    setMsgTabla(MSG_INICIAL); setPeriodo('personalizado');
  };

  // OPUS-12: exportar la tabla resumen de los gráficos (área, %, variación)
  const exportarResumenGrafico = () => {
    const headers = verCostos
      ? ['Área', { titulo: 'Costo', formato: 'clp' }, { titulo: '% del total', formato: 'numero' },
         { titulo: 'Cantidad consumida', formato: 'numero' }, 'Materiales',
         { titulo: 'Costo período anterior', formato: 'clp' }, { titulo: 'Variación %', formato: 'numero' }]
      : ['Área', { titulo: '% del total (cantidad)', formato: 'numero' }, { titulo: 'Cantidad consumida', formato: 'numero' },
         'Materiales', { titulo: 'Cantidad período anterior', formato: 'numero' }, { titulo: 'Variación %', formato: 'numero' }];
    const rows = (gArea?.areas || []).map(a => (verCostos
      ? [a.area, a.costo, a.porcentaje, a.cantidad, a.materiales, a.costo_periodo_anterior ?? '', a.variacion_pct ?? '']
      : [a.area, a.porcentaje, a.cantidad, a.materiales, a.cantidad_periodo_anterior ?? '', a.variacion_pct ?? '']));
    try { exportarCSV('consumo-area-grafico', headers, rows); } catch (e) { showAlert('danger', e.message); }
  };

  // SONNET-7: exportar CSV con los datos ya cargados
  const exportar = () => {
    const headers = ['Área', 'SKU', 'Material', 'Unidad', { titulo: 'Total consumido', formato: 'numero' },
                     ...(verCostos ? [{ titulo: 'Precio unitario', formato: 'clp' }, { titulo: 'Costo total', formato: 'clp' }] : []),
                     'OTs'];
    const rows = (consumos || []).map(c => [
      c.area_nombre || '',
      c.sku || '',
      c.material_nombre || '',
      c.unidad || '',
      c.total_consumido ?? 0,
      ...(verCostos ? [c.precio_unitario, parseFloat(c.total_consumido || 0) * parseFloat(c.precio_unitario || 0)] : []),
      c.ordenes_involucradas ?? '',
    ]);
    try { exportarCSV('consumo-area', headers, rows); } catch (e) { showAlert('danger', e.message); }
  };

  return (
    <>
      <PageHeader contexto="Reportes" titulo="Consumo por Área de Trabajo" descripcion="Análisis de materiales consumidos por área y período" nota={<NotaMontosNetos />} />
      <ReportesNav />

      <div id="alert-container"><Alert {...alert} /></div>

      {/* Filtros */}
      <div className="card" style={{ marginBottom: 20 }}>
        <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 12 }}>Filtros</div>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <div className="form-group" style={{ marginBottom: 0, flex: 1, minWidth: 180 }}>
            <label className="form-label">Área</label>
            <select className="form-control" id="filter-area" value={areaId} onChange={e => setAreaId(e.target.value)}>
              <option value="">Todas las áreas</option>
              {areas.map(a => <option key={a.id} value={a.id}>{a.nombre}</option>)}
            </select>
          </div>
          <div className="form-group" style={{ marginBottom: 0, flex: 1, minWidth: 160 }}><label className="form-label">Desde</label><input className="form-control" type="date" id="filter-desde" value={desde} onChange={e => setDesde(e.target.value)} /></div>
          <div className="form-group" style={{ marginBottom: 0, flex: 1, minWidth: 160 }}><label className="form-label">Hasta</label><input className="form-control" type="date" id="filter-hasta" value={hasta} onChange={e => setHasta(e.target.value)} /></div>
          <div className="form-group" style={{ marginBottom: 0, minWidth: 150 }}>
            <label className="form-label">Período</label>
            <select className="form-control" id="filter-periodo" value={periodo} onChange={e => aplicarPeriodo(e.target.value)}>
              {Object.entries(PERIODOS).map(([k, p]) => <option key={k} value={k}>{p.etiqueta}</option>)}
            </select>
          </div>
          <button className="btn btn-primary" id="btn-generar" onClick={generarReporte}>Generar reporte</button>
          <button className="btn btn-ghost" id="btn-limpiar-filtros" type="button" onClick={limpiar}>Limpiar filtros</button>
          <BotonExportar id="btn-exportar" onClick={exportar} filas={consumos == null ? null : consumos.length} />
        </div>
      </div>

      {/* OPUS-12 (Req #4): alternar entre el detalle tabular y los gráficos */}
      <div style={{ display: 'flex', gap: 0, marginBottom: 20, borderBottom: '2px solid var(--border)', flexWrap: 'wrap' }}>   {/* B-27: en el teléfono las pestañas pasan a otra línea */}
        {[['tabla', 'Detalle'], ['graficos', 'Gráficos']].map(([k, label]) => (
          <button key={k} className={'btn btn-ghost tab-btn' + (vista === k ? ' active' : '')}
            id={'vista-' + k}
            style={{ borderRadius: 0, marginBottom: -2, borderBottom: vista === k ? '2px solid var(--primary)' : 'none' }}
            onClick={() => setVista(k)}>{label}</button>
        ))}
      </div>

      {/* Resumen por área */}
      {resumen && (
        <div id="resumen-areas" style={{ marginBottom: 20 }}>
          <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 8 }}>Resumen por área</div>
          <div id="areas-cards" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(220px,1fr))', gap: 12 }}>
            {resumen.map((a, i) => (
              <div key={a.area ?? i} className="card" style={{ padding: 14, ...(a.alerta_anomalia ? { borderLeft: '4px solid var(--danger)' } : {}) }}>
                <div style={{ fontWeight: 600, fontSize: 13 }}>{a.area}</div>
                <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 4 }}>{a.materiales} material(es)</div>
                {a.costo_total != null && <div style={{ fontSize: 18, fontWeight: 700, marginTop: 6, color: 'var(--primary)' }}>{formatMoney(a.costo_total)}</div>}
                {a.promedio_historico != null && <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 4 }}>Promedio histórico: {formatMoney(a.promedio_historico)}</div>}
                {a.alerta_anomalia && <div style={{ marginTop: 6, padding: '6px 8px', background: 'var(--warning-light)', borderRadius: 4, fontSize: 11, color: 'var(--warning-text)', fontWeight: 600 }}>⚠ {a.mensaje_anomalia} (+{a.desviacion_pct}%)</div>}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── OPUS-12 (Req #4): gráficos ── */}
      {vista === 'graficos' && (
        <div id="bloque-graficos">
          {/* 1. Costo por área */}
          <div className="card" style={{ marginBottom: 16, padding: 18 }} id="grafico-areas">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
              <div style={{ fontWeight: 600, fontSize: 13 }}>
                {verCostos ? 'Costo de consumo por área' : 'Cantidad consumida por área'}
                {verCostos && gArea?.total_costo > 0 && (
                  <span style={{ fontWeight: 400, fontSize: 12, color: 'var(--text-secondary)' }}>
                    {' · '}total {formatMoney(gArea.total_costo)}
                  </span>
                )}
              </div>
              <button className="btn btn-ghost btn-sm" id="btn-img-area" disabled={!gArea?.areas?.length}
                onClick={() => descargarGrafico(refArea.current, 'consumo-por-area')}>Descargar imagen</button>
            </div>
            {!gArea && <div style={{ textAlign: 'center', padding: 24, color: 'var(--text-secondary)', fontSize: 12 }}>Cargando…</div>}
            {gArea && gArea.areas.length === 0 && (
              <div style={{ textAlign: 'center', padding: 24, color: 'var(--text-secondary)', fontSize: 12 }}>
                No hay consumos registrados en este período.
              </div>
            )}
            {gArea && gArea.areas.length > 0 && (
              <BarrasHorizontales svgRef={refArea} formato={verCostos ? formatMoney : formatQty}
                datos={gArea.areas.map(a => ({ label: a.area, valor: verCostos ? a.costo : a.cantidad, area_id: a.area_id }))} />
            )}
          </div>

          {/* 2. Top materiales, desglosado por área */}
          <div className="card" style={{ marginBottom: 16, padding: 18 }} id="grafico-materiales">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
              <div style={{ fontWeight: 600, fontSize: 13 }}>
                Materiales más consumidos
                <span style={{ fontWeight: 400, fontSize: 12, color: 'var(--text-secondary)' }}> · top 10, por área</span>
              </div>
              <button className="btn btn-ghost btn-sm" id="btn-img-material" disabled={!gMaterial?.labels?.length}
                onClick={() => descargarGrafico(refMaterial.current, 'materiales-por-area')}>Descargar imagen</button>
            </div>
            {!gMaterial && <div style={{ textAlign: 'center', padding: 24, color: 'var(--text-secondary)', fontSize: 12 }}>Cargando…</div>}
            {gMaterial && gMaterial.labels.length === 0 && (
              <div style={{ textAlign: 'center', padding: 24, color: 'var(--text-secondary)', fontSize: 12 }}>Sin datos en este período.</div>
            )}
            {gMaterial && gMaterial.labels.length > 0 && (
              <BarrasAgrupadas svgRef={refMaterial} labels={gMaterial.labels} series={gMaterial.datasets} formato={verCostos ? montoEje : formatQty} formatoDetalle={verCostos ? formatMoney : formatQty} />
            )}
          </div>

          {/* 3. F-18: consumo en el tiempo (mes → semana → día), en CLP o en unidades */}
          <ConsumoEnElTiempo desde={desde} hasta={hasta} verCostos={verCostos} onError={m => showAlert('danger', m)} />

          {/* 4. Tabla resumen con % y variación */}
          <div className="card" id="tabla-resumen-grafico">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '4px 0 10px' }}>
              <div style={{ fontWeight: 600, fontSize: 13 }}>Resumen comparativo</div>
              <BotonExportar id="btn-exportar-resumen" className="btn btn-secondary btn-sm" onClick={exportarResumenGrafico}
                filas={gArea == null ? null : (gArea.areas?.length || 0)} />
            </div>
            {gArea?.periodo?.anterior && (
              <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginBottom: 8 }}>
                Comparado contra {gArea.periodo.anterior.desde} → {gArea.periodo.anterior.hasta}
              </div>
            )}
            <div style={{ overflowX: 'auto' }}>
              <table className="table">
                <thead>
                  <tr>
                    <th>Área</th>
                    {verCostos && <th style={{ textAlign: 'right' }}>Costo</th>}
                    <th style={{ textAlign: 'right' }}>% del total</th>
                    <th style={{ textAlign: 'right' }}>Cantidad</th>
                    <th style={{ textAlign: 'right' }}>Materiales</th>
                    <th style={{ textAlign: 'right' }}>{verCostos ? 'Período anterior' : 'Cantidad período anterior'}</th>
                    <th style={{ textAlign: 'right' }}>Variación</th>
                  </tr>
                </thead>
                <tbody id="resumen-grafico-body">
                  {(!gArea || gArea.areas.length === 0) && (
                    <tr><td colSpan={verCostos ? 7 : 6} style={{ textAlign: 'center', padding: 24, color: 'var(--text-secondary)' }}>Sin datos.</td></tr>
                  )}
                  {gArea?.areas.map(a => {
                    const anterior = verCostos ? a.costo_periodo_anterior : a.cantidad_periodo_anterior;
                    const actual = verCostos ? a.costo : a.cantidad;
                    return (
                    <tr key={a.area_id}>
                      <td style={{ fontWeight: 500 }}>{a.area}</td>
                      {verCostos && <td style={{ textAlign: 'right', fontWeight: 600 }}>{formatMoney(a.costo)}</td>}
                      <td style={{ textAlign: 'right' }}>{a.porcentaje}%</td>
                      <td style={{ textAlign: 'right' }}>{formatQty(a.cantidad)}</td>
                      <td style={{ textAlign: 'right' }}>{a.materiales}</td>
                      <td style={{ textAlign: 'right', fontSize: 12, color: 'var(--gray)' }}>
                        {anterior != null ? (verCostos ? formatMoney(anterior) : formatQty(anterior)) : '—'}
                      </td>
                      <td style={{ textAlign: 'right', fontWeight: 600,
                        color: a.variacion_pct > 0 ? 'var(--danger)' : a.variacion_pct < 0 ? 'var(--success)' : undefined }}>
                        {a.variacion_pct != null
                          ? (a.variacion_pct > 0 ? '+' : '') + a.variacion_pct + '%'
                          : anterior === 0 && actual > 0
                            ? <span title="No hubo consumo en el período anterior" style={{ fontWeight: 400, color: 'var(--gray)' }}>sin base</span>
                            : '—'}
                      </td>
                    </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* Tabla detalle */}
      {vista === 'tabla' && (
      <div className="card">
        <div style={{ overflowX: 'auto' }}>
          <table className="table">
            <thead>
              <tr>
                <th>Área</th><th>SKU</th><th>Material</th><th>Unidad</th>
                <th style={{ textAlign: 'right' }}>Total consumido</th>
                {verCostos && <th style={{ textAlign: 'right' }}>Precio unit.</th>}
                {verCostos && <th style={{ textAlign: 'right' }}>Costo total</th>}
                <th style={{ textAlign: 'right' }}>OTs</th>
              </tr>
            </thead>
            <tbody id="tabla-body">
              {!consumos && <tr><td colSpan={verCostos ? 8 : 6} style={{ textAlign: 'center', padding: 32, color: 'var(--text-secondary)' }}>{msgTabla}</td></tr>}
              {pag.items.map((c, i) => {
                const consumido = parseFloat(c.total_consumido || 0);
                const precio = parseFloat(c.precio_unitario || 0);
                return (
                  <tr key={`${c.area_nombre}-${c.sku}-${i}`}>
                    <td>{c.area_nombre}</td>
                    <td><code>{c.sku}</code></td>
                    <td>{c.material_nombre}</td>
                    <td>{c.unidad || '—'}</td>
                    <td style={{ textAlign: 'right' }}>{formatQty(consumido)}</td>
                    {verCostos && <td style={{ textAlign: 'right' }}>{precio ? formatMoney(precio) : '—'}</td>}
                    {verCostos && <td style={{ textAlign: 'right', fontWeight: 600 }}>{formatMoney(consumido * precio)}</td>}
                    <td style={{ textAlign: 'right' }}>{c.ordenes_involucradas}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <Pagination {...pag} />
      </div>
      )}
    </>
  );
}

/* ══════════════════════════ F-18: consumo en el tiempo ══════════════════════════ */

const finDeMes = (iso) => { const [y, m] = iso.split('-').map(Number); return aISO(new Date(y, m, 0)); };
const sumarDias = (iso, n) => { const [y, m, d] = iso.split('-').map(Number); return aISO(new Date(y, m - 1, d + n)); };
const mayor = (a, b) => (!b ? a : a > b ? a : b);
const menor = (a, b) => (!b ? a : a < b ? a : b);

/**
 * Consumo por área en el tiempo: barras apiladas por área, por mes. Un clic en un mes muestra sus semanas, y en
 * una semana, sus días. En unidades hay que elegir un producto o una categoría (no se suman planchas con kilos);
 * jop solo ve unidades (D50). "Descargar datos" baja en CSV lo que se ve.
 */
function ConsumoEnElTiempo({ desde, hasta, verCostos, onError }) {
  const [medida, setMedida] = useState(verCostos ? 'clp' : 'unidades');
  const [sku, setSku] = useState('');
  const [categoria, setCategoria] = useState('');
  const [materiales, setMateriales] = useState([]);
  const [categorias, setCategorias] = useState([]);
  // Niveles bajados [{ etiqueta, desde, hasta, periodo }], válidos para un período y filtros: si cambian, se vuelve
  // al primer nivel (se compara la clave en vez de limpiar con un efecto)
  const base = [desde, hasta, medida, sku, categoria].join('|');
  const [bajados, setBajados] = useState({ base, niveles: [] });
  const ruta = bajados.base === base ? bajados.niveles : [];
  const setRuta = (niveles) => setBajados({ base, niveles });
  const [respuesta, setRespuesta] = useState({ clave: null, datos: null, aviso: '' });
  const ref = useRef(null);

  useEffect(() => {
    API.materiales.listar().then(m => setMateriales((Array.isArray(m) ? m : []).map(x => ({ sku: x.sku, nombre: x.nombre })))).catch(() => {});
    API.materiales.categorias().then(c => setCategorias(c?.generales || [])).catch(() => {});
  }, []);

  const nivel = ruta[ruta.length - 1];
  const cDesde = nivel ? nivel.desde : desde;
  const cHasta = nivel ? nivel.hasta : hasta;
  const cPeriodo = nivel ? nivel.periodo : 'mes';
  const faltaFiltro = medida === 'unidades' && !sku && !categoria;
  const clave = [cDesde, cHasta, cPeriodo, medida, sku, categoria].join('|');

  useEffect(() => {
    if (faltaFiltro) return undefined;
    let vigente = true;
    API.reportes.consumoAreaGrafico({ agrupar: 'mes', desde: cDesde, hasta: cHasta, periodo: cPeriodo, medida, sku, categoria })
      .then(r => { if (vigente) setRespuesta(r?.error ? { clave, datos: null, aviso: r.error } : { clave, datos: r, aviso: '' }); })
      .catch(e => { if (vigente) setRespuesta({ clave, datos: null, aviso: e.message }); });
    return () => { vigente = false; };
  }, [clave, cDesde, cHasta, cPeriodo, medida, sku, categoria, faltaFiltro]);

  // Mientras llega la respuesta de la consulta actual, datos = null ("Cargando…")
  const vigenteR = respuesta.clave === clave;
  const datos = vigenteR ? respuesta.datos : null;
  const aviso = faltaFiltro ? 'Elige un producto o una categoría para ver el consumo en unidades.' : (vigenteR ? respuesta.aviso : '');

  const enClp = datos?.medida === 'costo';
  const formato = enClp ? montoEje : formatQty;
  const formatoDetalle = enClp ? formatMoney : formatQty;
  const etiquetas = (datos?.labels || []).map(l => etiquetaPeriodo(l, datos.agrupacion));

  const bajar = (_, i) => {
    const iso = datos.labels[i];
    if (datos.agrupacion === 'mes') {
      setRuta([...ruta, { etiqueta: etiquetaPeriodo(iso, 'mes'), desde: mayor(`${iso}-01`, cDesde), hasta: menor(finDeMes(iso), cHasta), periodo: 'semana' }]);
    } else if (datos.agrupacion === 'semana') {
      setRuta([...ruta, { etiqueta: `Semana del ${etiquetaPeriodo(iso, 'dia')}`, desde: mayor(iso, cDesde), hasta: menor(sumarDias(iso, 6), cHasta), periodo: 'dia' }]);
    }
  };

  const descargarDatos = () => {
    const unidad = enClp ? 'CLP neto' : (datos.unidad || 'unidades');
    const col = (titulo) => ({ titulo: `${titulo} (${unidad})`, formato: enClp ? 'clp' : 'numero' });
    const headers = ['Período', ...datos.datasets.map(d => col(d.label)), col('Total')];
    const rows = datos.labels.map((l, i) => {
      const valores = datos.datasets.map(d => d.data[i] || 0);
      return [etiquetas[i], ...valores, valores.reduce((a, v) => a + v, 0)];
    });
    try { exportarCSV('consumo-en-el-tiempo', headers, rows); } catch (e) { onError(e.message); }
  };

  const vacio = (texto) => <div style={{ textAlign: 'center', padding: 24, color: 'var(--text-secondary)', fontSize: 12 }}>{texto}</div>;

  return (
    <div className="card" style={{ marginBottom: 16, padding: 18 }} id="grafico-mensual">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
        <div>
          <div style={{ fontWeight: 600, fontSize: 13 }}>
            Consumo en el tiempo por área
            <span style={{ fontWeight: 400, fontSize: 12, color: 'var(--text-secondary)' }}>
              {enClp ? ' · CLP neto' : datos?.unidad ? ` · en ${datos.unidad}` : ''}{!nivel && !desde && !hasta ? ' · últimos 12 meses' : ''}
            </span>
          </div>
          <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 2 }}>
            {datos?.agrupacion === 'dia' ? 'Detalle por día.' : 'Haz clic en una barra para ver el detalle por semana y por día.'}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button className="btn btn-ghost btn-sm" id="btn-csv-mes" disabled={!datos?.labels?.length} onClick={descargarDatos}>Descargar datos</button>
          <button className="btn btn-ghost btn-sm" id="btn-img-mes" disabled={!datos?.labels?.length}
            onClick={() => descargarGrafico(ref.current, 'consumo-en-el-tiempo')}>Descargar imagen</button>
        </div>
      </div>

      <div className="filter-row" style={{ alignItems: 'flex-end' }}>
        <div>
          <label className="form-label" htmlFor="mes-medida" style={{ marginBottom: 4 }}>Medida</label>
          {verCostos ? (
            <select className="form-control" id="mes-medida" style={{ width: 'auto' }} value={medida} onChange={e => setMedida(e.target.value)}>
              <option value="clp">CLP neto</option>
              <option value="unidades">Unidades</option>
            </select>
          ) : <div style={{ fontSize: 13, padding: '8px 0' }}>Unidades</div>}
        </div>
        <div>
          <label className="form-label" htmlFor="mes-categoria" style={{ marginBottom: 4 }}>Categoría</label>
          <select className="form-control" id="mes-categoria" style={{ width: 'auto' }} value={categoria}
            onChange={e => { setCategoria(e.target.value); if (e.target.value) setSku(''); }}>
            <option value="">Todas</option>
            {categorias.map(c => <option key={c.id} value={c.id}>{c.nombre}</option>)}
          </select>
        </div>
        <div style={{ minWidth: 240 }}>
          <label className="form-label" style={{ marginBottom: 4 }}>Producto</label>
          <SelectorProducto id="mes-sku" vacio="Todos los productos" opciones={materiales} value={sku}
            onChange={v => { setSku(v); if (v) setCategoria(''); }} />
        </div>
      </div>

      {ruta.length > 0 && (
        <nav aria-label="Nivel del gráfico" style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', fontSize: 12, margin: '4px 0 8px' }}>
          <button className="btn-texto" onClick={() => setRuta([])}>Todo el período</button>
          {ruta.map((r, k) => (
            <span key={k} style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <span style={{ color: 'var(--gray)' }}>›</span>
              {k === ruta.length - 1
                ? <strong>{r.etiqueta}</strong>
                : <button className="btn-texto" onClick={() => setRuta(ruta.slice(0, k + 1))}>{r.etiqueta}</button>}
            </span>
          ))}
        </nav>
      )}

      {aviso && vacio(aviso)}
      {!aviso && !datos && vacio('Cargando…')}
      {!aviso && datos && datos.labels.length === 0 && vacio('Sin consumos en este período.')}
      {!aviso && datos && datos.labels.length > 0 && (
        <BarrasAgrupadas apiladas svgRef={ref} labels={etiquetas} series={datos.datasets}
          formato={formato} formatoDetalle={formatoDetalle}
          onClickEtiqueta={datos.agrupacion === 'dia' ? undefined : bajar} />
      )}
    </div>
  );
}
