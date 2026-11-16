import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { API } from '../../services/api';
import { formatMoney, etiqueta, fechaLocal } from '../../utils/format';
import { useAuth } from '../../hooks/useAuth';
import { useConfirm, usePrompt } from '../../hooks/useDialog';
import { usePageTitle } from '../../contexts/TitleContext';
import Alert, { useAlert } from '../../components/Alert';
import TabDesviaciones from './TabDesviaciones';
import TabConsumo from './TabConsumo';
import { ocultaMontos } from '../../utils/user';
import NombreCorto from '../../components/NombreCorto';   // F-17
import PageHeader from '../../components/PageHeader';   // F-25d
import StatusPill from '../../components/StatusPill';
import { tonoMovimiento } from '../../utils/estados';

// R1: Consumo reemplaza a Consumos, Estimados y Registrar consumo (docs/incremento-3-4/decisiones.md)
// F-30 parte 2: Puerta = especificación de la OT en papel y su hoja imprimible
const TABS = [['consumo', 'Consumo'], ['puerta', 'Puerta'], ['movimientos', 'Movimientos'], ['desviaciones', 'Desviaciones']];   // CU-103
// Estados en que la OT ya no admite finalizarse (mismo criterio que el backend)
const ESTADOS_CERRADOS = ['cancelada', 'finalizada', 'completada', 'cerrada'];

/**
 * Detalle Orden de Trabajo — conversión 1:1 de ordenes/detalle.html (?id= → /ordenes/:id).
 * data-rol="gerencia": enlace "Costos" (oculto si rol === 'jop').
 */
export default function OrdenDetalle() {
  usePageTitle('Detalle Orden de Trabajo');
  const { id: otId } = useParams();
  const { user } = useAuth();
  const { alert, showAlert } = useAlert();
  const confirm = useConfirm();
  const prompt = usePrompt();

  const [tab, setTab] = useState('consumo');
  const [data, setData] = useState(null);       // respuesta de consumos()
  const [bodegas, setBodegas] = useState([]);


  // Comparativo (CU-92)
  const [comp, setComp] = useState(null); // null | { loading } | { error } | { detalle, resumen }

  // OPUS-11 (Req #3): pinturas usadas en esta OT (seguimiento por peso)
  const [pinturas, setPinturas] = useState(null);

  // OPUS-9 (Req #1): movimientos de inventario generados por esta OT
  const [movs, setMovs] = useState(null);      // null = aún no cargado
  const [movTipo, setMovTipo] = useState('');
  const [movDesde, setMovDesde] = useState('');
  const [movHasta, setMovHasta] = useState('');
  const [movError, setMovError] = useState(null);

  useEffect(() => {
    if (!otId) showAlert('danger', 'No se especificó un ID de orden de trabajo');
  }, [otId, showAlert]);

  const cargarConsumos = useCallback(async () => {
    try {
      const d = await API.ordenesTrabajo.consumos(otId);
      setData(d);
    } catch (err) {
      showAlert('danger', 'Error: ' + err.message);
    }
  }, [otId, showAlert]);

  useEffect(() => {
    if (!otId) return;
    cargarConsumos();
    API.bodegas.listar().then(b => setBodegas(b || [])).catch(e => console.warn('Error cargando bodegas:', e.message));
    // OPUS-11: la sección de pinturas solo aparece si esta OT tiene usos registrados
    API.seguimientoPinturas.listar({ orden_trabajo_id: otId })
      .then(d => setPinturas(d))
      .catch(e => console.warn('Error cargando pinturas de la OT:', e.message));
  }, [otId, cargarConsumos]);



  // CU-103: finalizar la OT (gerencia y jop). El backend bloquea si hay reservas
  // activas o retiros de pintura sin devolver.
  const gestionaProduccion = ['gerencia', 'jop'].includes(user?.rol);
  const estadoOT = data?.orden?.estado;
  const finalizarOT = async () => {
    const ok = await confirm(
      `¿Finalizar la orden de trabajo #${otId}? Ya no se podrán registrar consumos ni estimados, y quedará lista para procesar sus diferenciales.`,
      'Finalizar orden de trabajo');
    if (!ok) return;
    try {
      const r = await API.ordenesTrabajo.finalizar(otId);
      showAlert('success', r.message);
      cargarConsumos();
    } catch (err) {
      showAlert('danger', err.message);
    }
  };

  // B-03: cambiar el responsable (solo gerencia, OT abierta)
  const [resp, setResp] = useState(null);   // null | { usuarios, nuevo }
  const abrirCambioResponsable = async () => {
    try {
      const o = await API.ordenesTrabajo.opcionesNueva();
      setResp({ usuarios: o.usuarios || [], nuevo: String(data?.orden?.responsable_id ?? '') });
    } catch (err) { showAlert('danger', err.message); }
  };
  const guardarResponsable = async () => {
    try {
      const r = await API.ordenesTrabajo.cambiarResponsable(otId, Number(resp.nuevo));
      showAlert('success', r.message);
      setResp(null);
      cargarConsumos();
    } catch (err) { showAlert('danger', err.message); }
  };

  // F-27: cambiar el empleado tentativo (gerencia y jop, OT abierta). Vacío = vuelve a heredar el responsable
  const [tent, setTent] = useState(null);   // null | { usuarios, nuevo }
  const abrirCambioTentativo = async () => {
    try {
      const o = await API.ordenesTrabajo.opcionesNueva();
      setTent({ usuarios: o.usuarios || [], nuevo: String(data?.orden?.empleado_tentativo_id ?? '') });
    } catch (err) { showAlert('danger', err.message); }
  };
  const guardarTentativo = async () => {
    try {
      const r = await API.ordenesTrabajo.asignarEmpleadoTentativo(otId, tent.nuevo ? Number(tent.nuevo) : null);
      showAlert('success', r.message);
      setTent(null);
      cargarConsumos();
    } catch (err) { showAlert('danger', err.message); }
  };

  // F-28: anular (nunca borrar). El backend rechaza si hay consumo vigente y libera las reservas.
  const anularOT = async () => {
    const motivo = await prompt(
      `Indique por qué se anula la OT #${otId}. Queda como "Cancelada" con su historial; sus reservas se liberan.`,
      'Anular orden de trabajo', 'Ej: se creó con el área equivocada');
    if (motivo == null) return;
    if (!motivo.trim()) { showAlert('danger', 'Indique el motivo de la anulación.'); return; }
    if (!(await confirm(`¿Anular la orden de trabajo #${otId}? No se puede deshacer.`, 'Anular orden de trabajo'))) return;
    try {
      const r = await API.ordenesTrabajo.anular(otId, motivo.trim());
      // Desde B-26 el 409 (tiene consumo; el mensaje dice qué devolver primero) se lanza y lo muestra el catch:
      // este chequeo quedó de antes (M-01)
      if (r?.codigo) { showAlert('danger', r.error); return; }
      showAlert('success', r.message);
      cargarConsumos();
    } catch (err) {
      showAlert('danger', err.message);
    }
  };

  // F-47: reabrir una OT cerrada (solo gerencia, con firma). Las canceladas no se reabren.
  const reabrible = user?.rol === 'gerencia' && !!estadoOT && ESTADOS_CERRADOS.includes(estadoOT) && estadoOT !== 'cancelada';
  const reabrirOT = async () => {
    const motivo = await prompt(
      `Indique por qué se reabre la OT #${otId}. Vuelve a "En curso" para corregirla y consumir; después se finaliza de nuevo.`,
      'Reabrir orden de trabajo', 'Ej: hay que corregir las medidas de la puerta');
    if (motivo == null) return;
    if (!motivo.trim()) { showAlert('danger', 'Indique el motivo por el que se reabre la OT.'); return; }
    const cerradas = (data?.orden?.misma_puerta || []).filter(h => ESTADOS_CERRADOS.includes(h.estado));
    const aviso = cerradas.length
      ? ` ${cerradas.map(h => `#${h.id} ${h.area || ''}`.trim()).join(', ')}, de la misma puerta, ` +
        `${cerradas.length === 1 ? 'seguirá cerrada' : 'seguirán cerradas'}: un cambio de medidas o especificación no les llega.`
      : '';
    if (!(await confirm(
      `¿Reabrir la orden de trabajo #${otId}? El stock no cambia. Si ya procesó sus desviaciones, se borran y hay que ` +
      `procesarlas de nuevo al finalizarla.${aviso}`, 'Reabrir orden de trabajo'))) return;
    try {
      const r = await API.ordenesTrabajo.reabrir(otId, motivo.trim());
      showAlert('success', r.message);
      cargarConsumos();
    } catch (err) {
      showAlert('danger', err.message);
    }
  };

  const cambiarTab = (t) => setTab(t);

  // OPUS-9: los filtros se aplican solos al cambiarlos (mismo criterio que SONNET-1)
  useEffect(() => {
    if (tab !== 'movimientos' || !otId) return;
    let cancelado = false;
    setMovError(null);
    API.ordenesTrabajo.movimientos(otId, { tipo: movTipo || null, desde: movDesde || null, hasta: movHasta || null })
      .then(d => { if (!cancelado) setMovs(d); })
      .catch(err => { if (!cancelado) { setMovs(null); setMovError(err.message); } });
    return () => { cancelado = true; };
  }, [tab, otId, movTipo, movDesde, movHasta]);

  // Comparativo (CU-92)
  const verComparativo = async () => {
    setComp({ loading: true });
    try {
      const d = await API.ordenesTrabajo.comparativo(otId);
      if (d?.error) { setComp({ error: d.error }); return; }
      setComp({ detalle: d.detalle || [], resumen: d.resumen || {} });
    } catch (err) {
      setComp({ error: 'Error: ' + err.message });
    }
  };

  const tieneEstimadosComp = comp?.detalle?.some(d => d.estimado != null && parseFloat(d.estimado) > 0);

  return (
    <>
      <PageHeader contexto="Producción" titulo={<>Orden de Trabajo <span id="ot-id">{data ? '#' + otId : ''}</span></>} descripcion={data ? 'Estado: ' + etiqueta(data.orden?.estado) : ''} nota={<>{data && <FichaOT orden={data.orden} />}
          {data && (
            <div className="page-subtitle" id="ot-responsable" style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              Responsable: <strong>{data.orden?.responsable || '—'}</strong>
              {user?.rol === 'gerencia' && estadoOT && !ESTADOS_CERRADOS.includes(estadoOT) && !resp && (
                <button className="btn btn-ghost btn-sm" id="btn-cambiar-responsable" onClick={abrirCambioResponsable}>Cambiar</button>
              )}
              {resp && (
                <>
                  <select className="form-control" id="ot-nuevo-responsable" style={{ width: 'auto' }} value={resp.nuevo}
                    onChange={e => setResp({ ...resp, nuevo: e.target.value })}>
                    {resp.usuarios.map(u => <option key={u.id} value={u.id}>{u.nombre ? `${u.nombre} (${u.username})` : u.username}</option>)}
                  </select>
                  <button className="btn btn-primary btn-sm" id="btn-guardar-responsable" onClick={guardarResponsable}>Guardar</button>
                  <button className="btn btn-ghost btn-sm" onClick={() => setResp(null)}>Cancelar</button>
                </>
              )}
            </div>
          )}
          {data && (
            <div className="page-subtitle" id="ot-tentativo" style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              Empleado tentativo: <strong>{data.orden?.empleado_tentativo || '—'}</strong>
              {data.orden?.empleado_tentativo_heredado && data.orden?.empleado_tentativo && <span>(el responsable)</span>}
              {gestionaProduccion && estadoOT && !ESTADOS_CERRADOS.includes(estadoOT) && !tent && (
                <button className="btn btn-ghost btn-sm" id="btn-cambiar-tentativo" onClick={abrirCambioTentativo}>Cambiar</button>
              )}
              {tent && (
                <>
                  <select className="form-control" id="ot-nuevo-tentativo" style={{ width: 'auto' }} value={tent.nuevo}
                    onChange={e => setTent({ ...tent, nuevo: e.target.value })}>
                    <option value="">Sin tentativo (usar el responsable)</option>
                    {tent.usuarios.map(u => <option key={u.id} value={u.id}>{u.nombre ? `${u.nombre} (${u.username})` : u.username}</option>)}
                  </select>
                  <button className="btn btn-primary btn-sm" id="btn-guardar-tentativo" onClick={guardarTentativo}>Guardar</button>
                  <button className="btn btn-ghost btn-sm" onClick={() => setTent(null)}>Cancelar</button>
                </>
              )}
            </div>
          )}</>}>
        <Link to="/ordenes" className="btn btn-ghost">← Órdenes de trabajo</Link>
        <button className="btn btn-ghost" id="btn-comparativo" onClick={verComparativo}>Ver comparativo</button>
        {!ocultaMontos(user) && <Link to={`/ordenes/${otId}/costos`} className="btn btn-ghost" id="link-costos">Costos</Link>}
        {gestionaProduccion && estadoOT && !ESTADOS_CERRADOS.includes(estadoOT) && (
          <button className="btn btn-primary" id="btn-finalizar-ot" onClick={finalizarOT}>Finalizar OT</button>
        )}
        {gestionaProduccion && estadoOT && !ESTADOS_CERRADOS.includes(estadoOT) && (
          <button className="btn btn-ghost" id="btn-anular-ot" style={{ color: 'var(--danger)' }} onClick={anularOT}>Anular OT</button>
        )}
        {reabrible && (
          <button className="btn btn-ghost" id="btn-reabrir-ot" onClick={reabrirOT}>Reabrir OT</button>
        )}
      </PageHeader>

      <div id="alert-container"><Alert {...alert} /></div>

      {/* Tabs */}
      <div style={{ display: 'flex', gap: 0, marginBottom: 20, borderBottom: '2px solid var(--border)', flexWrap: 'wrap' }}>   {/* B-27: en el teléfono las pestañas pasan a otra línea */}
        {TABS.map(([k, label]) => (
          <button key={k} className={'btn btn-ghost tab-btn' + (tab === k ? ' active' : '')}
            style={{ borderRadius: 0, marginBottom: -2, borderBottom: tab === k ? '2px solid var(--primary)' : 'none' }}
            onClick={() => cambiarTab(k)}>{label}</button>
        ))}
      </div>

      {/* Tab: Desviaciones (CU-103) */}
      {tab === 'desviaciones' && (
        <TabDesviaciones otId={otId} estado={estadoOT} puedeProcesar={gestionaProduccion} />
      )}

      {/* Tab: Puerta (F-30 parte 2): especificación compartida por la puerta, nota del área y hoja imprimible */}
      {tab === 'puerta' && data && (
        <TabPuerta key={JSON.stringify(data.orden?.especificacion ?? null)} otId={otId} orden={data.orden}
          campos={data.campos_especificacion || []} showAlert={showAlert} onGuardado={cargarConsumos}
          editable={['gerencia', 'jop'].includes(user?.rol) && !!estadoOT && !ESTADOS_CERRADOS.includes(estadoOT)} />
      )}

      {/* Tab: Consumo (R1): receta + consumo real, se guarda todo junto */}
      {tab === 'consumo' && (
        <TabConsumo otId={otId} data={data} bodegas={bodegas} showAlert={showAlert} onGuardado={cargarConsumos}
          abierta={!!estadoOT && !ESTADOS_CERRADOS.includes(estadoOT)}
          puedeCorregir={user?.rol === 'gerencia' && !!estadoOT && ESTADOS_CERRADOS.includes(estadoOT)} />
      )}

      {/* OPUS-11 (Req #3): pinturas utilizadas en esta OT */}
      {tab === 'consumo' && pinturas?.seguimientos?.length > 0 && (
        <div className="card" style={{ marginTop: 20 }}>
          <div className="card-title">
            Pinturas utilizadas
            <span style={{ fontWeight: 400, fontSize: 12, color: 'var(--text-secondary)' }}>
              {' · '}{pinturas.resumen.consumido_gr} gr consumidos en {pinturas.resumen.cerrados} uso(s)
              {pinturas.resumen.abiertos > 0 && ` · ${pinturas.resumen.abiertos} envase(s) sin devolver`}
            </span>
          </div>
          <div style={{ overflowX: 'auto' }}>
            <table className="table">
              <thead>
                <tr>
                  <th>Fecha</th><th>Pintura</th><th>Color</th><th>Área</th>
                  <th style={{ textAlign: 'right' }}>Retiro</th>
                  <th style={{ textAlign: 'right' }}>Devolución</th>
                  <th style={{ textAlign: 'right' }}>Consumido</th>
                  <th style={{ textAlign: 'right' }}>gr/m²</th>
                </tr>
              </thead>
              <tbody>
                {pinturas.seguimientos.map(s => (
                  <tr key={s.id}>
                    <td style={{ fontSize: 12, color: 'var(--gray)', whiteSpace: 'nowrap' }}>
                      {s.fecha_uso ? new Date(s.fecha_uso).toLocaleString('sv-SE').slice(0, 16) : '—'}
                    </td>
                    <td>
                      <div style={{ fontWeight: 500, fontSize: 13 }}><NombreCorto texto={s.material} /></div>
                      <div style={{ fontSize: 11, color: 'var(--gray)' }}>{s.sku}</div>
                    </td>
                    <td style={{ fontSize: 12, color: 'var(--gray)' }}>{s.color_aplicado || s.color_catalogo || '—'}</td>
                    <td style={{ fontSize: 12, color: 'var(--gray)' }}>{s.area || '—'}</td>
                    <td style={{ textAlign: 'right' }}>{s.peso_entrada_gr} gr</td>
                    <td style={{ textAlign: 'right' }}>
                      {s.abierto
                        ? <span className="badge badge-warning" style={{ fontSize: 10 }}>sin devolver</span>
                        : s.peso_salida_gr + ' gr'}
                    </td>
                    <td style={{ textAlign: 'right', fontWeight: 600 }}>
                      {s.peso_consumido_gr != null ? s.peso_consumido_gr + ' gr' : '—'}
                    </td>
                    <td style={{ textAlign: 'right', fontSize: 12 }}>{s.rendimiento_gr_m2 ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div style={{ padding: '8px 4px 0', fontSize: 12 }}>
            <Link to="/pinturas/seguimiento">Ir al seguimiento de pinturas →</Link>
          </div>
        </div>
      )}

      {/* Tab: Movimientos vinculados a la OT (OPUS-9 / Req #1) */}
      {tab === 'movimientos' && (
        <div className="tab-content" id="tab-movimientos">
          <div className="card card-sm" style={{ marginBottom: 16 }}>
            <div className="filter-row" style={{ marginBottom: 0, flexWrap: 'wrap', alignItems: 'flex-end' }}>
              <div>
                <label className="form-label" style={{ marginBottom: 4 }}>Tipo</label>
                <select className="form-control" id="mov-filtro-tipo" style={{ width: 'auto' }}
                  value={movTipo} onChange={e => setMovTipo(e.target.value)}>
                  <option value="">Todos</option>
                  <option value="salida">Salida</option>
                  <option value="entrada">Entrada</option>
                </select>
              </div>
              <div>
                <label className="form-label" style={{ marginBottom: 4 }}>Desde</label>
                <input className="form-control" type="date" id="mov-filtro-desde" style={{ width: 'auto' }}
                  value={movDesde} onChange={e => setMovDesde(e.target.value)} />
              </div>
              <div>
                <label className="form-label" style={{ marginBottom: 4 }}>Hasta</label>
                <input className="form-control" type="date" id="mov-filtro-hasta" style={{ width: 'auto' }}
                  value={movHasta} onChange={e => setMovHasta(e.target.value)} />
              </div>
              <div>
                <button className="btn btn-ghost btn-sm" id="btn-limpiar-mov"
                  onClick={() => { setMovTipo(''); setMovDesde(''); setMovHasta(''); }}>Limpiar filtros</button>
              </div>
            </div>
          </div>

          <Alert type="danger" message={movError && `Error cargando movimientos: ${movError}`} style={{ marginBottom: 16, fontSize: 13 }}
            onClose={() => setMovError(null)} />

          {movs?.resumen && (
            <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap', marginBottom: 12, fontSize: 13 }}>
              <span><strong>{movs.resumen.total}</strong> movimiento(s)</span>
              <span style={{ color: 'var(--danger)' }}><strong>{movs.resumen.salidas}</strong> salida(s)</span>
              <span style={{ color: 'var(--success)' }}><strong>{movs.resumen.entradas}</strong> devolución(es)</span>
              <span>Neto descontado: <strong>{movs.resumen.cantidad_neta}</strong></span>
              {movs.resumen.revertidos > 0 && <span style={{ color: 'var(--text-secondary)' }}>{movs.resumen.revertidos} revertido(s)</span>}
            </div>
          )}

          <div className="card">
            <div style={{ overflowX: 'auto' }}>
              <table className="table">
                <thead>
                  <tr>
                    <th>ID</th><th>Fecha</th><th>Tipo</th><th>Material</th>
                    <th style={{ textAlign: 'right' }}>Cantidad</th>
                    <th>Bodega</th><th>Lote</th><th>Motivo</th><th>Trabajador</th><th>Estado</th>
                  </tr>
                </thead>
                <tbody id="movimientos-ot-body">
                  {!movs && !movError && <tr><td colSpan={10} style={{ textAlign: 'center', padding: 32 }}>Cargando…</td></tr>}
                  {movs && movs.movimientos.length === 0 && (
                    <tr><td colSpan={10} style={{ textAlign: 'center', padding: 32, color: 'var(--text-secondary)' }}>
                      No hay movimientos de inventario vinculados a esta OT
                      {(movTipo || movDesde || movHasta) ? ' con los filtros aplicados.' : '. Se generan automáticamente al registrar consumos reales.'}
                    </td></tr>
                  )}
                  {movs && movs.movimientos.map(m => {
                    const tl = (m.tipo || '').toLowerCase();
                    const signo = tl.includes('entrada') ? '+' : tl.includes('salida') ? '−' : '';
                    const revertido = m.estado === 'revertido';
                    return (
                      <tr key={m.id} style={revertido ? { opacity: 0.55, textDecoration: 'line-through' } : undefined}>
                        <td><span className="td-mono" style={{ fontSize: 11 }}>{m.id}</span></td>
                        <td style={{ fontSize: 12, color: 'var(--gray)', whiteSpace: 'nowrap' }}>
                          {m.fecha_hora ? new Date(m.fecha_hora).toLocaleString('sv-SE').slice(0, 16) : '—'}
                        </td>
                        <td><StatusPill tono={tonoMovimiento(tl)}>{m.tipo || '—'}</StatusPill></td>
                        <td>
                          <div style={{ fontWeight: 500, fontSize: 13 }}><NombreCorto texto={m.material} /></div>
                          <div style={{ fontSize: 11, color: 'var(--gray)' }}>{m.sku}</div>
                        </td>
                        <td style={{ textAlign: 'right', fontWeight: 600 }}>
                          {signo}{parseFloat(m.cantidad || 0)}
                          {m.unidad && <span style={{ fontWeight: 400, fontSize: 11, color: 'var(--text-secondary)' }}> {m.unidad}</span>}
                        </td>
                        <td style={{ fontSize: 12, color: 'var(--gray)' }}>{m.bodega || '—'}</td>
                        <td style={{ fontSize: 11, color: 'var(--gray)' }}>{m.lote || '—'}</td>
                        <td style={{ fontSize: 12, color: 'var(--gray)' }}>
                          {m.motivo || '—'}
                          {/* F-05: el detalle (p. ej. el motivo de un consumo extra) se lee sin pasar el mouse */}
                          {m.descripcion_motivo && <div style={{ fontSize: 11, maxWidth: 280 }}>{m.descripcion_motivo}</div>}
                        </td>
                        {/* El movimiento hereda el trabajador asignado a la OT, no quien lo registró */}
                        <td style={{ fontSize: 12, color: 'var(--gray)' }}>{m.usuario || '—'}</td>
                        <td>
                          <span className={'badge ' + (revertido ? 'badge-gray' : m.estado === 'pendiente_aprobacion' ? 'badge-warning' : 'badge-success')}>
                            {etiqueta(m.estado)}
                          </span>
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

      {/* Modal comparativo (CU-92) */}
      {comp && (
        <div className="modal-overlay" id="modal-comparativo" style={{ display: 'flex' }}>
          <div className="modal" style={{ maxWidth: 800 }}>
            <div className="modal-header">
              <div className="modal-title">Comparativo Estimado vs Real</div>
              <button className="modal-close" id="cerrar-comparativo" onClick={() => setComp(null)}>×</button>
            </div>
            <div className="modal-body" id="comparativo-body">
              {comp.loading && 'Cargando…'}
              {comp.error}
              {comp.detalle && !tieneEstimadosComp && (
                <div style={{ textAlign: 'center', padding: 32, color: 'var(--text-secondary)' }}>
                  <div style={{ fontSize: 32, marginBottom: 12 }}>📊</div>
                  <div style={{ fontWeight: 600, marginBottom: 8 }}>No existe una base de comparación</div>
                  <div style={{ fontSize: 13 }}>Debe registrar estimados cargando la receta en la pestaña "Consumo" antes de poder generar un comparativo.</div>
                </div>
              )}
              {comp.detalle && tieneEstimadosComp && (
                <>
                  {/* Los costos solo llegan si el rol puede verlos (el backend los quita a jop) */}
                  {comp.resumen.costo_total_estimado != null && (
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(140px,1fr))', gap: 8, marginBottom: 16 }}>
                    <div style={{ textAlign: 'center' }}><div style={{ fontSize: 11, color: 'var(--text-secondary)' }}>Costo estimado</div><div style={{ fontWeight: 700 }}>{formatMoney(comp.resumen.costo_total_estimado)}</div></div>
                    <div style={{ textAlign: 'center' }}><div style={{ fontSize: 11, color: 'var(--text-secondary)' }}>Costo real</div><div style={{ fontWeight: 700 }}>{formatMoney(comp.resumen.costo_total_real)}</div></div>
                    <div style={{ textAlign: 'center' }}><div style={{ fontSize: 11, color: 'var(--text-secondary)' }}>Diferencia</div><div style={{ fontWeight: 700, color: comp.resumen.costo_total_real > comp.resumen.costo_total_estimado ? 'var(--danger)' : 'var(--success)' }}>{formatMoney(comp.resumen.costo_total_real - comp.resumen.costo_total_estimado)}</div></div>
                  </div>
                  )}
                  <table className="table">
                    <thead><tr><th>SKU</th><th>Material</th><th style={{ textAlign: 'right' }}>Estimado</th><th style={{ textAlign: 'right' }}>Real</th><th style={{ textAlign: 'right' }}>Var.</th><th style={{ textAlign: 'right' }}>Var. %</th></tr></thead>
                    <tbody>
                      {comp.detalle.map(d => (
                        <tr key={d.sku}>
                          <td><code>{d.sku}</code></td><td>{d.nombre}</td>
                          <td style={{ textAlign: 'right' }}>{d.estimado ?? '—'}</td>
                          <td style={{ textAlign: 'right' }}>{d.real ?? '—'}</td>
                          <td style={{ textAlign: 'right' }}>{d.varianza != null ? (d.varianza > 0 ? '+' : '') + d.varianza : '—'}</td>
                          <td style={{ textAlign: 'right' }}>{d.varianza_pct != null ? d.varianza_pct + '%' : '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}

/**
 * F-27: a qué pertenece la OT, en una línea bajo el título: área, proyecto, ventas del proyecto
 * (Finanzas, solo lectura), receta con sus puertas y fecha de creación. Lo que falta no se muestra.
 * F-30: debajo, las otras OT de la misma puerta, con su estado y si sus medidas difieren.
 */
function FichaOT({ orden }) {
  if (!orden) return null;
  const partes = [];
  partes.push(['Área', orden.area || '—']);
  if (orden.proyecto_codigo) {
    partes.push(['Proyecto', orden.proyecto_nombre ? `${orden.proyecto_codigo} — ${orden.proyecto_nombre}` : orden.proyecto_codigo]);
  } else {
    partes.push(['Proyecto', 'sin proyecto']);
  }
  if (orden.ventas?.length) {
    partes.push([orden.ventas.length === 1 ? 'Venta' : 'Ventas',
      orden.ventas.map(v => `${v.numero} (${etiqueta(v.estado)})`).join(', ')]);
  }
  if (orden.receta_codigo) {
    const puertas = orden.cantidad_puertas ? ` · ${orden.cantidad_puertas} ${orden.cantidad_puertas == 1 ? 'puerta' : 'puertas'}` : '';
    partes.push(['Receta', orden.receta_codigo + puertas]);
  }
  if (orden.fecha_creacion) partes.push(['Creada el', fechaLocal(orden.fecha_creacion)]);
  return (
    <>
      <div className="page-subtitle" id="ot-ficha" style={{ display: 'flex', columnGap: 16, rowGap: 2, flexWrap: 'wrap' }}>
        {partes.map(([k, v]) => <span key={k}>{k}: <strong>{v}</strong></span>)}
      </div>
      {/* F-30: las otras OT de la misma puerta (creadas juntas, una por área) */}
      {orden.misma_puerta?.length > 0 && (
        <div className="page-subtitle" id="ot-misma-puerta">
          Misma puerta:{' '}
          {orden.misma_puerta.map((h, i) => (
            <span key={h.id}>
              {i > 0 && ' · '}
              <Link to={`/ordenes/${h.id}`}>#{h.id} {h.area || ''}</Link> ({etiqueta(h.estado)})
              {!h.medidas_iguales && <span style={{ color: 'var(--danger)' }}> · medidas distintas a las de esta OT</span>}
            </span>
          ))}
        </div>
      )}
    </>
  );
}

/**
 * F-30 parte 2: especificación de la puerta (los datos de la OT en papel: abertura, cerradura, enchape…)
 * y la nota de esta área. La especificación es de la puerta: al guardarla se aplica a todas sus OT
 * abiertas, como las medidas. Requiere medidas (se cargan en Consumo). Los campos vienen del backend.
 */
function TabPuerta({ otId, orden, campos, editable, showAlert, onGuardado }) {
  const esp = orden.especificacion || {};
  const notaInicial = esp.notas_area?.[String(orden.area_id)] ?? '';
  const [form, setForm] = useState(() => Object.fromEntries(campos.map(c => [c.clave, esp.campos?.[c.clave] ?? ''])));
  const [nota, setNota] = useState(notaInicial);
  // F-09: ítems no estándar de la puerta (mocheta, rejilla, vidrio…): no están en el catálogo ni mueven stock;
  // con área, salen solo en la hoja de esa área
  const [items, setItems] = useState(() => (esp.no_estandar || []).map(i => ({
    descripcion: i.descripcion ?? '', cantidad: i.cantidad != null ? String(i.cantidad) : '', unidad: i.unidad ?? '',
    area_id: i.area_id != null ? String(i.area_id) : '', nota: i.nota ?? '' })));
  const [areas, setAreas] = useState([]);
  useEffect(() => {
    API.reportes.listarAreas().then(a => setAreas((a || []).filter(x => x.activo !== false))).catch(() => setAreas([]));
  }, []);
  const [guardando, setGuardando] = useState(false);
  const deLaPuerta = orden.puerta != null;
  const puedeEditar = editable && orden.tiene_medidas;
  const cambiarItem = (i, campo, v) => setItems(lista => lista.map((x, j) => (j === i ? { ...x, [campo]: v } : x)));

  const guardar = async () => {
    setGuardando(true);
    try {
      const noEstandar = items
        .filter(i => i.descripcion.trim() || i.cantidad.trim())
        .map(i => ({ descripcion: i.descripcion.trim(), cantidad: i.cantidad.trim().replace(',', '.'), unidad: i.unidad.trim() || null,
                     area_id: i.area_id ? Number(i.area_id) : null, nota: i.nota.trim() || null }));
      const r = await API.ordenesTrabajo.guardarEspecificacion(otId, { especificacion: form, nota_area: nota, no_estandar: noEstandar });
      showAlert('success', r.message);
      onGuardado();
    } catch (err) {
      showAlert('danger', err.message);
    } finally {
      setGuardando(false);
    }
  };

  return (
    <div className="card" style={{ padding: 16 }} id="tab-puerta">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap', marginBottom: 8 }}>
        <div>
          <div className="section-label" style={{ marginBottom: 2 }}>Especificación de la puerta</div>
          <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
            Lo que va en la OT en papel. Todos los campos son opcionales.
            {deLaPuerta && <strong> Es de la puerta: al guardarla se aplica a todas sus OT abiertas.</strong>}
          </div>
        </div>
        <Link to={`/ordenes/${otId}/hoja`} className="btn btn-secondary" id="btn-hoja-ot">Imprimir hoja</Link>
      </div>

      {!orden.tiene_medidas && (
        <div style={{ fontSize: 13, color: 'var(--danger)', marginBottom: 12 }} id="puerta-sin-medidas">
          Cargue primero las medidas de la puerta en la pestaña Consumo.
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 12 }}>
        {campos.filter(c => c.clave !== 'otros').map(c => (
          <div className="form-group" key={c.clave} style={{ marginBottom: 0 }}>
            <label className="form-label" htmlFor={`esp-${c.clave}`}>{c.etiqueta}</label>
            <input className="form-control" id={`esp-${c.clave}`} maxLength={c.max} value={form[c.clave] ?? ''}
              disabled={!puedeEditar} onChange={e => setForm({ ...form, [c.clave]: e.target.value })} />
          </div>
        ))}
      </div>
      {campos.some(c => c.clave === 'otros') && (
        <div className="form-group" style={{ marginTop: 12 }}>
          <label className="form-label" htmlFor="esp-otros">{campos.find(c => c.clave === 'otros').etiqueta}</label>
          <textarea className="form-control" id="esp-otros" rows={2} maxLength={campos.find(c => c.clave === 'otros').max}
            value={form.otros ?? ''} disabled={!puedeEditar} onChange={e => setForm({ ...form, otros: e.target.value })} />
        </div>
      )}
      <div className="form-group">
        <label className="form-label" htmlFor="esp-nota-area">Nota para {orden.area || 'esta área'} (solo sale en la hoja de esta área)</label>
        <textarea className="form-control" id="esp-nota-area" rows={2} maxLength={500} value={nota}
          disabled={!puedeEditar} onChange={e => setNota(e.target.value)} />
      </div>

      {/* F-09: ítems no estándar (no están en el catálogo y no mueven stock) */}
      <div className="form-group" id="puerta-no-estandar">
        <div className="form-label">Ítems no estándar</div>
        <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 6 }}>
          Lo que no está en el catálogo (mocheta, rejilla, vidrio, puerta de mascota…). No descuenta stock. Con área, sale
          solo en la hoja de esa área; sin área, en todas.
        </div>
        {items.length > 0 && (
          <div className="table-wrap">
            <table>
              <thead><tr><th>Descripción</th><th style={{ width: 90 }}>Cantidad</th><th style={{ width: 100 }}>Unidad</th><th style={{ width: 160 }}>Área</th><th>Nota</th><th /></tr></thead>
              <tbody>
                {items.map((it, i) => (
                  <tr key={i}>
                    <td><input className="form-control" aria-label={`Descripción del ítem ${i + 1}`} maxLength={150} value={it.descripcion}
                      disabled={!puedeEditar} onChange={e => cambiarItem(i, 'descripcion', e.target.value)} placeholder="Ej: mocheta de 15 cm" /></td>
                    <td><input className="form-control" aria-label={`Cantidad del ítem ${i + 1}`} inputMode="decimal" value={it.cantidad}
                      disabled={!puedeEditar} onChange={e => cambiarItem(i, 'cantidad', e.target.value)} /></td>
                    <td><input className="form-control" aria-label={`Unidad del ítem ${i + 1}`} maxLength={30} value={it.unidad}
                      disabled={!puedeEditar} onChange={e => cambiarItem(i, 'unidad', e.target.value)} placeholder="unidad" /></td>
                    <td>
                      <select className="form-control" aria-label={`Área del ítem ${i + 1}`} value={it.area_id} disabled={!puedeEditar}
                        onChange={e => cambiarItem(i, 'area_id', e.target.value)}>
                        <option value="">Todas las áreas</option>
                        {areas.map(a => <option key={a.id} value={a.id}>{a.nombre}</option>)}
                      </select>
                    </td>
                    <td><input className="form-control" aria-label={`Nota del ítem ${i + 1}`} maxLength={200} value={it.nota}
                      disabled={!puedeEditar} onChange={e => cambiarItem(i, 'nota', e.target.value)} /></td>
                    <td>{puedeEditar && (
                      <button type="button" className="btn btn-ghost btn-sm" aria-label={`Quitar el ítem ${i + 1}`}
                        onClick={() => setItems(lista => lista.filter((_, j) => j !== i))}>✕</button>
                    )}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {puedeEditar && items.length < 30 && (
          <button type="button" className="btn btn-secondary btn-sm" id="btn-agregar-no-estandar" style={{ marginTop: 6 }}
            onClick={() => setItems(lista => [...lista, { descripcion: '', cantidad: '1', unidad: '', area_id: '', nota: '' }])}>
            + Agregar ítem no estándar
          </button>
        )}
      </div>

      {puedeEditar && (
        <button type="button" className="btn btn-primary" id="btn-guardar-especificacion" disabled={guardando} onClick={guardar}>
          {guardando ? 'Guardando…' : 'Guardar especificación'}
        </button>
      )}
    </div>
  );
}
