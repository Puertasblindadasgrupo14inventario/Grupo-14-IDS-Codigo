import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { API } from '../../services/api';
import { formatQty, formatMoneySigno } from '../../utils/format';
import { exportarCSV } from '../../utils/csvExport';
import { exportarPDF } from '../../utils/pdfExport';
import { usePageTitle } from '../../contexts/TitleContext';
import Alert, { useAlert } from '../../components/Alert';
import Pagination from '../../components/Pagination';
import BotonExportar from '../../components/BotonExportar';
import { usePagination } from '../../hooks/usePagination';
import ReportesNav from '../../components/ReportesNav';
import NotaMontosNetos from '../../components/NotaMontosNetos';   // F-35
import PageHeader from '../../components/PageHeader';   // F-25d

/**
 * CU-104 — Ranking de desviaciones críticas por impacto (gerencia y jop).
 * Lee los diferenciales procesados en CU-103 (detalle de la OT → Desviaciones) de
 * las OTs del período, opcionalmente de un área. Solo pérdidas: sobregasto y
 * consumo no planificado, del mayor impacto en CLP al menor. El backend no envía
 * los montos a jop (D36) pero le entrega el mismo orden.
 * F-13: "Agrupar por" trabajador (responsable de la OT) o área muestra una fila por
 * grupo con sus totales; "Ver ítems" vuelve al ranking filtrado a ese grupo.
 */

/** 'YYYY-MM-DD' local de hoy + n días (nunca toISOString, que es UTC). */
function fechaLocal(n = 0) {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** dd/mm/aaaa a partir de 'YYYY-MM-DD'. */
const ddmmaaaa = (iso) => iso ? iso.split('-').reverse().join('/') : '';

const TIPOS = {
  sobre_gasto: { etiqueta: 'Sobregasto',     badge: 'badge-danger' },
  sin_base:    { etiqueta: 'No planificado', badge: 'badge-orange' },
};

const formatPct = (v) => v == null ? 'Sin base'
  : (v > 0 ? '+' : '') + v.toLocaleString('es-CL', { minimumFractionDigits: 1, maximumFractionDigits: 1 }) + ' %';
const conSigno = (v) => (v > 0 ? '+' : '') + formatQty(v);

const AGRUPAR = {
  item:       { etiqueta: 'Ítem (producto por OT)' },
  trabajador: { etiqueta: 'Trabajador (responsable de la OT)', columna: 'Trabajador' },
  area:       { etiqueta: 'Área de la OT', columna: 'Área' },
};

// F-44 (Ley 21.719, art. 8 bis): la vista de una persona es un perfil; lo decide una persona, no el reporte
const AVISO_PERSONA = 'Reporte informativo para el control de pérdidas: no reemplaza la evaluación de una persona. ' +
                      'Antes de decidir algo sobre un trabajador, revise cada caso.';

export default function ReporteDesviaciones() {
  usePageTitle('Desviaciones de consumo');
  const { alert, showAlert, clearAlert } = useAlert();

  const [desde, setDesde] = useState(fechaLocal(-89));
  const [hasta, setHasta] = useState(fechaLocal(0));
  const [areaId, setAreaId] = useState('');
  const [agrupar, setAgrupar] = useState('item');
  const [responsable, setResponsable] = useState(null);   // F-13: { id, nombre } al ver los ítems de un trabajador
  const [areas, setAreas] = useState([]);
  const [res, setRes] = useState(null);
  const [cargando, setCargando] = useState(false);

  useEffect(() => {
    API.reportes.listarAreas().then(setAreas).catch(() => setAreas([]));
  }, []);

  // F-13: "Ver ítems" de un grupo consulta con sus criterios sin esperar al re-render
  const consultar = async (cambios = {}) => {
    const c = { agrupar, areaId, responsable, ...cambios };
    // Exc 1: se valida aquí para avisar rápido; el backend vuelve a validar
    if (!desde || !hasta) { showAlert('danger', 'Ingrese la fecha de inicio y la fecha de fin.'); return; }
    if (desde > hasta) { showAlert('danger', 'La fecha de inicio no puede ser posterior a la fecha de fin. Corrija las fechas.'); return; }
    setCargando(true);
    try {
      const data = await API.reportes.desviaciones({
        desde, hasta, area_id: c.areaId, agrupar: c.agrupar,
        ...(c.agrupar === 'item' && c.responsable && { responsable_id: c.responsable.id }),
      });
      setRes(data);
      clearAlert();
    } catch (err) {
      setRes(null);
      showAlert('danger', err.message || 'No se pudo generar el ranking.');
    } finally {
      setCargando(false);
    }
  };

  // B-32: se carga solo al abrir, con los últimos 90 días (antes quedaba vacío hasta "Filtrar")
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { consultar(); }, []);

  const ranking = res?.ranking || [];
  const grupos = res?.grupos || null;   // F-13: solo al agrupar por trabajador o área
  const porPersona = !!res && (res.agrupar === 'trabajador' || !!res.responsable);   // F-44
  const pag = usePagination(res ? ranking : null, 20);
  const pagGrupos = usePagination(grupos, 20);

  /** F-13: del grupo al ranking por ítem filtrado a ese trabajador o área. */
  const verItems = (g) => {
    const cambios = res.agrupar === 'trabajador'
      ? { agrupar: 'item', responsable: { id: g.id, nombre: g.nombre } }
      : { agrupar: 'item', areaId: String(g.id), responsable: null };
    setAgrupar(cambios.agrupar);
    setResponsable(cambios.responsable);
    if (cambios.areaId) setAreaId(cambios.areaId);
    consultar(cambios);
  };
  const quitarResponsable = () => { setResponsable(null); consultar({ responsable: null }); };
  const r = res?.resumen || {};
  // El backend decide: a jop no le llegan los montos
  const conMontos = res != null && 'impacto_total_clp' in r;

  const alcance = res
    ? `Período ${ddmmaaaa(res.periodo.desde)} al ${ddmmaaaa(res.periodo.hasta)} · ${res.area ? 'Área ' + res.area.nombre : 'Todas las áreas'}` +
      (res.responsable ? ` · Responsable ${res.responsable.nombre}` : '') +
      (grupos ? ` · Por ${AGRUPAR[res.agrupar].columna.toLowerCase()}` : '')
    : '';

  // Mismas columnas para el CSV y el PDF (D35)
  const tabla = () => {
    const num = (titulo) => ({ titulo, formato: 'numero' });
    if (grupos) {
      return {
        headers: ['N°', AGRUPAR[res.agrupar].columna, num('OT con pérdida'), num('OT procesadas'),
                  num('Ítems con pérdida'), num('Sobregasto'), num('No planificado'), num('Ahorros'),
                  ...(conMontos ? [{ titulo: 'Impacto CLP', formato: 'clp' }, num('Ítems sin precio')] : [])],
        rows: grupos.map(g => [
          g.posicion, g.nombre, g.ots_con_perdida, g.ots_procesadas, g.items, g.sobre_gasto, g.sin_base, g.ahorro,
          ...(conMontos ? [-g.impacto_clp, g.sin_precio] : []),
        ]),
      };
    }
    return {
      headers: ['N°', 'OT', { titulo: 'Fecha OT', formato: 'fecha' }, 'Área', 'Responsable', 'SKU', 'Producto', 'Unidad',
                num('Estimado'), num('Real'), num('Desviación (unidades)'), 'Desviación %', 'Tipo',
                ...(conMontos ? [{ titulo: 'Impacto CLP', formato: 'clp' }] : [])],
      rows: ranking.map(i => [
        i.posicion, i.ot_id, i.ot_fecha, i.area, i.responsable || '', i.sku, i.nombre, i.unidad || '',
        i.estimado, i.real, i.desviacion_abs, formatPct(i.desviacion_pct), TIPOS[i.tipo].etiqueta,
        // F-07 (#20): la pérdida va negativa, igual que en pantalla
        ...(conMontos ? [i.sin_precio ? 'Sin precio' : -i.impacto_clp] : []),
      ]),
    };
  };
  const nombreArchivo = () => `desviaciones-${res.periodo.desde}-a-${res.periodo.hasta}` +
                              (res.area ? `-area-${res.area.id}` : '') +
                              (res.responsable ? `-trabajador-${res.responsable.id}` : '') +
                              (grupos ? `-por-${res.agrupar}` : '');
  const exportar = () => {
    const { headers, rows } = tabla();
    try { exportarCSV(nombreArchivo(), headers, rows); }
    catch (e) { showAlert('danger', e.message); }
  };
  const [generandoPdf, setGenerandoPdf] = useState(false);
  const exportarPdf = async () => {
    setGenerandoPdf(true);
    try {
      await exportarPDF({
        tipo: nombreArchivo(),
        // F-13: el título dice qué se agrupó
        titulo: grupos ? `Desviaciones por ${AGRUPAR[res.agrupar].columna.toLowerCase()}` : 'Desviaciones críticas por impacto',
        subtitulo: alcance + ' · Del mayor al menor sobregasto',
        resumen: [
          ['Ítems con pérdida', String(r.items ?? 0)], ['Órdenes de trabajo', String(r.ots ?? 0)],
          ['Sobregasto', String(r.sobre_gasto ?? 0)], ['No planificado', String(r.sin_base ?? 0)],
          ...(conMontos ? [['Impacto total', formatMoneySigno(-r.impacto_total_clp)]] : []),
          ['Ahorros (fuera del ranking)', String(r.ahorro ?? 0)],
        ],
        ...tabla(),
        notas: [
          'Fuente: diferenciales de consumo procesados por OT finalizada (real - estimado de la OT). Se filtra por la ' +
          'fecha de la OT y, si se elige, por su área.',
          'Solo pérdidas: sobregasto y consumo no planificado (sin estimado). El impacto es la desviación por el precio ' +
          'vigente a la fecha de la OT; los ítems sin precio van al final.',
          ...(grupos ? ['El trabajador es el responsable de la OT. Los ahorros se cuentan aparte y no descuentan la pérdida.'] : []),
          ...(porPersona ? [AVISO_PERSONA] : []),
        ],
      });
    } catch (e) { showAlert('danger', e.message); }
    finally { setGenerandoPdf(false); }
  };

  const kpi = (etiqueta, valor, sub, color) => (
    <div className="kpi-card">
      <div className="kpi-label">{etiqueta}</div>
      <div className="kpi-value" style={{ color }}>{valor}</div>
      <div className="kpi-sub">{sub}</div>
    </div>
  );

  const filasExportables = res && !res.mensaje ? (grupos || ranking).length : null;

  return (
    <>
      <PageHeader contexto="Reportes" titulo="Desviaciones de consumo" descripcion="Dónde se producen las mayores mermas o ineficiencias, ordenadas por impacto económico" nota={<NotaMontosNetos />}>
        <BotonExportar onClick={exportar} filas={filasExportables} />
        <BotonExportar onClick={exportarPdf} cargando={generandoPdf} filas={filasExportables} etiqueta="Exportar PDF" />
      </PageHeader>
      <ReportesNav />

      <Alert {...alert} />

      <div className="card" style={{ marginBottom: 20 }}>
        <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 12 }}>Criterios</div>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <div className="form-group" style={{ marginBottom: 0, flex: 1, minWidth: 160 }}>
            <label className="form-label">Fecha inicio (de la OT)</label>
            <input className="form-control" type="date" value={desde} onChange={e => setDesde(e.target.value)} />
          </div>
          <div className="form-group" style={{ marginBottom: 0, flex: 1, minWidth: 160 }}>
            <label className="form-label">Fecha fin (de la OT)</label>
            <input className="form-control" type="date" value={hasta} onChange={e => setHasta(e.target.value)} />
          </div>
          <div className="form-group" style={{ marginBottom: 0, flex: 1, minWidth: 180 }}>
            <label className="form-label">Área de producción (opcional)</label>
            <select className="form-control" value={areaId} onChange={e => setAreaId(e.target.value)}>
              <option value="">Todas las áreas</option>
              {areas.map(a => (
                <option key={a.id} value={a.id}>{a.nombre}{a.activo === false ? ' (inactiva)' : ''}</option>
              ))}
            </select>
          </div>
          <div className="form-group" style={{ marginBottom: 0, flex: 1, minWidth: 200 }}>
            <label className="form-label">Agrupar por</label>
            <select className="form-control" value={agrupar}
                    onChange={e => { setAgrupar(e.target.value); setResponsable(null); }}>
              {Object.entries(AGRUPAR).map(([k, v]) => <option key={k} value={k}>{v.etiqueta}</option>)}
            </select>
          </div>
          <button className="btn btn-primary" onClick={() => consultar()} disabled={cargando}>
            {cargando ? 'Consultando…' : 'Consultar ranking'}
          </button>
        </div>
        {responsable && agrupar === 'item' && (
          <div style={{ marginTop: 12, fontSize: 13 }}>
            <span className="badge badge-gray">Responsable: {responsable.nombre}</span>
            <button className="btn-texto" onClick={quitarResponsable} disabled={cargando}>Quitar filtro</button>
          </div>
        )}
      </div>

      {!res && (
        <div className="card" style={{ textAlign: 'center', padding: '48px 24px', color: 'var(--gray)' }}>
          <div style={{ fontSize: 40, marginBottom: 12, opacity: .3 }}>📉</div>
          <p style={{ fontSize: 14 }}>Elija el período y presione <strong>Consultar ranking</strong></p>
          <p style={{ fontSize: 12 }}>Solo aparecen las OTs finalizadas cuyos diferenciales ya se procesaron (detalle de la OT → Desviaciones).</p>
        </div>
      )}

      {res?.mensaje && (
        <div className="card" style={{ textAlign: 'center', padding: '40px 24px', color: 'var(--gray)' }}>
          <div style={{ fontSize: 36, marginBottom: 10, opacity: .4 }}>📭</div>
          <p style={{ fontSize: 14 }}>{res.mensaje}</p>
          <p style={{ fontSize: 12 }}>{alcance}. Pruebe con otro período u otra área.</p>
        </div>
      )}

      {res && !res.mensaje && (
        <>
          {porPersona && <div id="aviso-persona" className="alert alert-info" style={{ fontSize: 13 }}>{AVISO_PERSONA}</div>}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(160px,1fr))', gap: 16, marginBottom: 16 }}>
            {kpi('Ítems con pérdida', r.items, `en ${r.ots} OT(s)`, 'var(--danger)')}
            {kpi('Sobregasto', r.sobre_gasto, 'real mayor que lo estimado')}
            {kpi('No planificado', r.sin_base, 'consumido sin estimado')}
            {conMontos && kpi('Impacto total', formatMoneySigno(-r.impacto_total_clp),
                              r.sin_precio > 0 ? `${r.sin_precio} ítem(s) sin precio no suman` : 'pérdida valorizada', 'var(--danger)')}
            {kpi('Ahorros', r.ahorro, 'fuera del ranking', 'var(--success)')}
          </div>

          {grupos && (
            <div className="card" style={{ marginBottom: 20 }}>
              <div style={{ fontSize: 13, color: 'var(--gray)', marginBottom: 12 }}>
                {grupos.length} {res.agrupar === 'trabajador' ? 'trabajador(es)' : 'área(s)'} · {alcance} · del mayor al menor impacto
              </div>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>N°</th><th className="col-nombre">{AGRUPAR[res.agrupar].columna}</th>
                      <th>OT con pérdida</th><th>Ítems con pérdida</th><th>Sobregasto</th><th>No planificado</th><th>Ahorros</th>
                      {conMontos && <th>Impacto</th>}
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {pagGrupos.items.map(g => (
                      <tr key={g.id}>
                        <td style={{ fontWeight: 700 }}>{g.posicion}</td>
                        <td className="col-nombre" style={{ fontSize: 13 }}>
                          <span style={{ fontWeight: 500 }}>{g.nombre}</span>
                          {res.agrupar === 'trabajador' && !g.con_ficha && (
                            <div style={{ fontSize: 11, color: 'var(--gray)' }}
                                 title="El usuario no tiene RUT de empleado registrado: se muestra su nombre de usuario">
                              Sin ficha de empleado
                            </div>
                          )}
                        </td>
                        <td>{g.ots_con_perdida} <span style={{ fontSize: 11, color: 'var(--gray)' }}>de {g.ots_procesadas}</span></td>
                        <td style={{ fontWeight: 600 }}>{g.items}</td>
                        <td>{g.sobre_gasto}</td>
                        <td>{g.sin_base}</td>
                        <td style={{ color: g.ahorro > 0 ? 'var(--success)' : undefined }}>{g.ahorro}</td>
                        {conMontos && (
                          <td style={{ fontWeight: 700 }}>
                            <span style={{ color: g.impacto_clp > 0 ? 'var(--danger)' : undefined }}>{formatMoneySigno(-g.impacto_clp)}</span>
                            {g.sin_precio > 0 && <div style={{ fontSize: 11, color: 'var(--gray)', fontWeight: 400 }}>{g.sin_precio} sin precio</div>}
                          </td>
                        )}
                        <td>
                          <button className="btn-texto" onClick={() => verItems(g)} disabled={cargando || g.items === 0}>
                            Ver ítems
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <Pagination {...pagGrupos} />
            </div>
          )}

          {!grupos && (
          <div className="card" style={{ marginBottom: 20 }}>
            <div style={{ fontSize: 13, color: 'var(--gray)', marginBottom: 12 }}>
              {ranking.length} ítem(s) · {alcance} · del mayor al menor impacto
            </div>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>N°</th><th>OT</th><th>Área</th><th>Producto</th>
                    <th>Estimado</th><th>Real</th><th>Desviación</th><th>Desviación %</th><th>Tipo</th>
                    {conMontos && <th>Impacto</th>}
                  </tr>
                </thead>
                <tbody>
                  {pag.items.map(i => (
                    <tr key={`${i.ot_id}-${i.sku}`}>
                      <td style={{ fontWeight: 700 }}>{i.posicion}</td>
                      <td>
                        <Link to={`/ordenes/${i.ot_id}`} className="td-mono">OT #{i.ot_id}</Link>
                        <div style={{ fontSize: 11, color: 'var(--gray)' }}>{ddmmaaaa(i.ot_fecha)}</div>
                      </td>
                      <td style={{ fontSize: 13 }}>
                        {i.area}
                        <div style={{ fontSize: 11, color: 'var(--gray)' }}>{i.responsable}</div>
                      </td>
                      <td style={{ fontSize: 13 }}>
                        <span style={{ fontWeight: 500 }}>{i.nombre}</span>
                        <div className="td-mono" style={{ fontSize: 11 }}>{i.sku}</div>
                      </td>
                      <td>{formatQty(i.estimado)}</td>
                      <td>{formatQty(i.real)}</td>
                      <td style={{ fontWeight: 600 }}>
                        {conSigno(i.desviacion_abs)} <span style={{ fontSize: 11, color: 'var(--gray)' }}>{i.unidad || ''}</span>
                      </td>
                      <td>{formatPct(i.desviacion_pct)}</td>
                      <td><span className={'badge ' + TIPOS[i.tipo].badge}>{TIPOS[i.tipo].etiqueta}</span></td>
                      {conMontos && (
                        <td style={{ fontWeight: 700 }}>
                          {i.sin_precio ? <span className="badge badge-gray" title="El material no tenía precio a la fecha de la OT">Sin precio</span>
                                        : <span style={{ color: 'var(--danger)' }}>{formatMoneySigno(-i.impacto_clp)}</span>}
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Pagination {...pag} />
          </div>
          )}

          <div style={{ fontSize: 12, color: 'var(--gray)', lineHeight: 1.6 }}>
            <strong>Cómo se calcula.</strong> Desviación = consumo real − estimado de la OT; % = desviación ÷ estimado × 100
            (sin estimado es "no planificado", sin porcentaje). El impacto es la desviación por el precio vigente a la fecha
            de la OT. Solo entran las pérdidas; los ítems sin precio van al final, ordenados por desviación %. Si el consumo
            de una OT cambia, vuelva a procesar sus diferenciales desde el detalle de la OT.
            {grupos && ' Por trabajador o área: el trabajador es el responsable de la OT; el impacto suma solo las pérdidas ' +
                      'con precio (los ahorros se cuentan aparte y no la descuentan).'}
          </div>
        </>
      )}
    </>
  );
}
