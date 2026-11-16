import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { API } from '../../services/api';
import { useAuth } from '../../hooks/useAuth';
import { usePageTitle } from '../../contexts/TitleContext';
import Alert, { useAlert } from '../../components/Alert';
import Pagination, { EmptyRow } from '../../components/Pagination';
import { usePagination } from '../../hooks/usePagination';
import { ocultaMontos } from '../../utils/user';
import { etiqueta } from '../../utils/format';
import NuevaOT from './NuevaOT';

import PageHeader from '../../components/PageHeader';   // F-25d
const badgeEstado = (e) => e === 'cancelada' ? 'badge-ghost'
  : e === 'cerrada' || e === 'finalizada' || e === 'completada' ? 'badge-success'
  : e === 'en_curso' ? 'badge-warning' : 'badge-gray';

/** Órdenes de Trabajo — conversión 1:1 de ordenes/lista.html. data-rol="gerencia": enlace Costos. */
export default function OrdenLista() {
  usePageTitle('Órdenes de Trabajo');
  const { user } = useAuth();
  const { alert, showAlert } = useAlert();
  const verCostos = !ocultaMontos(user);
  // F-06: crear OT (mismo permiso que el backend: soloOperativo)
  const puedeCrear = ['gerencia', 'jop'].includes(user?.rol);
  const [nuevaAbierta, setNuevaAbierta] = useState(false);

  const [estado, setEstado] = useState('');
  const [buscar, setBuscar] = useState('');
  const [ots, setOts] = useState(null);

  const cargar = useCallback(async () => {
    try {
      const data = await API.ordenesTrabajo.listar({ estado, buscar: buscar.trim() });
      if (data?.error) { showAlert('danger', data.error); return; }
      const lista = Array.isArray(data) ? data : [];
      setOts(lista);
      // CU-130 CP3: Si hay OTs canceladas, sugerir regenerar el reporte semanal
      const canceladas = lista.filter(o => o.estado === 'cancelada');
      if (canceladas.length > 0) {
        showAlert('warning', <>⚠ Hay {canceladas.length} orden(es) de trabajo cancelada(s). Los datos del cronograma semanal pueden estar desactualizados. <Link to="/reportes/programacion" style={{ fontWeight: 600, textDecoration: 'underline' }}>Regenerar reporte semanal</Link></>);
      }
    } catch (err) {
      showAlert('danger', 'Error: ' + err.message);
    }
  }, [estado, buscar, showAlert]);

  // Carga inicial y al cambiar el select de estado; el buscador requiere Enter o el botón "Filtrar"
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { cargar(); }, [estado]);

  // F-30: las OT de una misma puerta (creadas juntas, una por área) se muestran en una fila expandible
  const [abiertas, setAbiertas] = useState({});
  const filas = useMemo(() => {
    if (!ots) return null;
    const grupos = new Map();
    const res = [];
    for (const o of ots) {
      if (o.puerta == null) { res.push({ tipo: 'ot', ot: o }); continue; }
      if (!grupos.has(o.puerta)) { const g = { tipo: 'puerta', puerta: o.puerta, ots: [] }; grupos.set(o.puerta, g); res.push(g); }
      grupos.get(o.puerta).ots.push(o);
    }
    return res;
  }, [ots]);
  const pag = usePagination(filas, 20);

  return (
    <>
      <PageHeader contexto="Producción" titulo="Órdenes de Trabajo" descripcion="Consumos, estimados y costos por orden">
        {/* F-24: proyectos con sus OT, para crear una OT desde el proyecto */}
        <Link className="btn btn-secondary" to="/ordenes/proyectos">Proyectos</Link>
        {puedeCrear && (
          <button className="btn btn-primary" id="btn-nueva-ot" onClick={() => setNuevaAbierta(true)}>+ Nueva OT</button>
        )}
      </PageHeader>
      {nuevaAbierta && <NuevaOT onCerrar={() => setNuevaAbierta(false)}
        onCreadas={(msg) => { setNuevaAbierta(false); showAlert('success', msg); cargar(); }} />}

      <div id="alert-container"><Alert {...alert} /></div>

      {/* Filtros */}
      <div className="card" style={{ marginBottom: 20 }}>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <div className="form-group" style={{ marginBottom: 0, flex: 1, minWidth: 140 }}>
            <label className="form-label">Estado</label>
            <select className="form-control" id="filter-estado" value={estado} onChange={e => setEstado(e.target.value)}>
              <option value="">Todos</option>
              <option value="pendiente">Pendiente</option>
              <option value="en_curso">En curso</option>
              <option value="finalizada">Finalizada</option>
              <option value="cancelada">Cancelada</option>
            </select>
          </div>
          <div className="form-group" style={{ marginBottom: 0, flex: 2, minWidth: 200 }}>
            <label className="form-label">Buscar (código o nombre proyecto)</label>
            <input className="form-control" id="filter-buscar" placeholder="Buscar…" value={buscar} onChange={e => setBuscar(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') cargar(); }} />
          </div>
          <button className="btn btn-primary" id="btn-filtrar" onClick={cargar}>Filtrar</button>
        </div>
      </div>

      {/* Tabla */}
      <div className="card">
        <div style={{ overflowX: 'auto' }}>
          <table className="table">
            <thead>
              <tr>
                <th>OT</th><th>Fecha</th><th className="col-nombre">Proyecto</th><th>Área</th><th>Responsable</th><th>Estado</th>
                <th style={{ textAlign: 'center' }}>Materiales</th>
                <th style={{ textAlign: 'center' }}>Con estimado</th>
                <th style={{ textAlign: 'center' }}>Con real</th>
                <th>Acciones</th>
              </tr>
            </thead>
            <tbody id="tabla-body">
              {ots === null && <tr><td colSpan={10} style={{ textAlign: 'center', padding: 32, color: 'var(--text-secondary)' }}>Cargando…</td></tr>}
              {ots !== null && ots.length === 0 && <EmptyRow colSpan={10} emptyMsg="No se encontraron órdenes de trabajo" />}
              {pag.items.map(f => f.tipo === 'puerta' ? (
                <Fragment key={'p' + f.puerta}>
                  <FilaPuerta g={f} abierta={!!abiertas[f.puerta]}
                    alternar={() => setAbiertas(a => ({ ...a, [f.puerta]: !a[f.puerta] }))} />
                  {abiertas[f.puerta] && f.ots.map(o => <FilaOT key={o.id} o={o} verCostos={verCostos} hija />)}
                </Fragment>
              ) : <FilaOT key={f.ot.id} o={f.ot} verCostos={verCostos} />)}
            </tbody>
          </table>
        </div>
        <Pagination {...pag} />
      </div>
    </>
  );
}

/** F-30: fila de una puerta: sus áreas con su estado; un clic muestra sus OT. */
function FilaPuerta({ g, abierta, alternar }) {
  const o = g.ots[0];
  const suma = (k) => g.ots.reduce((n, x) => n + Number(x[k] || 0), 0);
  return (
    <tr className="fila-puerta" style={{ cursor: 'pointer', background: 'var(--gray-light)' }} onClick={alternar}
      title={abierta ? 'Ocultar sus OT' : 'Ver sus OT'}>
      <td style={{ whiteSpace: 'nowrap' }}>
        <span aria-hidden="true">{abierta ? '▾' : '▸'}</span> <strong>Puerta #{g.puerta}</strong>
        <div style={{ fontSize: 11, color: 'var(--gray)' }}>{o.receta_codigo || '—'} · {o.cantidad_puertas ?? '—'} puerta{Number(o.cantidad_puertas) === 1 ? '' : 's'}</div>
      </td>
      <td>{new Date(o.fecha).toLocaleDateString('sv-SE')}</td>
      <td>{o.proyecto_codigo || ''} {o.proyecto_nombre || '—'}</td>
      <td colSpan={3}>
        {g.ots.map(x => (
          <span key={x.id} style={{ marginRight: 10, whiteSpace: 'nowrap' }}>
            {x.area || '—'} <span className={`badge ${badgeEstado(x.estado)}`}>{etiqueta(x.estado)}</span>
          </span>
        ))}
      </td>
      <td style={{ textAlign: 'center' }}>{suma('total_materiales')}</td>
      <td style={{ textAlign: 'center' }}>{suma('con_estimado')}</td>
      <td style={{ textAlign: 'center' }}>{suma('con_real')}</td>
      <td style={{ fontSize: 12, color: 'var(--gray)' }}>{g.ots.length} OT</td>
    </tr>
  );
}

/** Fila de una OT (suelta, o dentro de una puerta con `hija`). */
function FilaOT({ o, verCostos, hija = false }) {
  return (
                <tr key={o.id}>
                  <td style={hija ? { paddingLeft: 28 } : undefined}><Link to={`/ordenes/${o.id}`}>#{o.id}</Link></td>
                  <td>{new Date(o.fecha).toLocaleDateString('sv-SE')}</td>
                  <td>{o.proyecto_codigo || ''} {o.proyecto_nombre || '—'}</td>
                  <td>{o.area || '—'}</td>
                  <td>{o.responsable || '—'}</td>
                  <td><span className={`badge ${badgeEstado(o.estado)}`}>{etiqueta(o.estado)}</span></td>
                  <td style={{ textAlign: 'center' }}>{o.total_materiales}</td>
                  <td style={{ textAlign: 'center' }}>{o.con_estimado}</td>
                  <td style={{ textAlign: 'center' }}>{o.con_real}</td>
                  <td>
                    <Link to={`/ordenes/${o.id}`} className="btn btn-ghost" style={{ padding: '4px 8px', fontSize: 12 }}>Detalle</Link>
                    {verCostos && <Link to={`/ordenes/${o.id}/costos`} className="btn btn-ghost" style={{ padding: '4px 8px', fontSize: 12 }}>Costos</Link>}
                    {o.estado === 'cancelada' && <> <span style={{ fontSize: 11, color: 'var(--warning)' }} title="Reporte semanal puede estar desactualizado">⚠ Regenerar reporte</span></>}
                  </td>
                </tr>
  );
}
