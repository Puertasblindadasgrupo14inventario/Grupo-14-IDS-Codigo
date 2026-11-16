import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { API } from '../../services/api';
import { useAuth } from '../../hooks/useAuth';
import { AvisoCerrable } from '../../components/Alert';

const ESPESORES_MDF = [3, 4, 5.5, 9];   // mismos que config/medidas.js
const mm = (v) => String(v).replace('.', ',');
const lineaVacia = () => ({ recetaId: '', puertas: '1', medido: 'vano', ancho: '', alto: '', perfil: '', hojas: '1', mdf: false, espesor: '4' });

/**
 * F-06 (D70, D71): formulario "Nueva OT". Una OT por área; el proyecto se elige directo o
 * sale de la venta (la OT guarda el proyecto de Terreno de esa venta). La receta es opcional:
 * si se elige, la pestaña Consumo la precarga para N puertas (R1). Al crear, va al detalle.
 * F-30: modo "Puertas de un proyecto" (por defecto): una línea por tipo de puerta (receta, medidas y
 * cantidad) y el sistema crea una OT por cada área con insumos en la receta. `onCreadas(mensaje)`
 * avisa a la lista; sin él, se abre la primera OT creada.
 */
export default function NuevaOT({ onCerrar, onCreadas, proyectoInicial = '' }) {   // F-24: abrir con un proyecto ya elegido
  const navigate = useNavigate();
  const { user } = useAuth();
  const [opciones, setOpciones] = useState(null);
  const [recetas, setRecetas] = useState([]);
  const [error, setError] = useState(null);
  const [guardando, setGuardando] = useState(false);
  const [modo, setModo] = useState('puertas');   // F-30: 'puertas' | 'suelta'

  // F-30: líneas de puertas, áreas de cada receta y responsable por área
  const [lineas, setLineas] = useState([lineaVacia()]);
  const [areasDe, setAreasDe] = useState({});          // recetaId → [{ id, nombre }]
  const [responsables, setResponsables] = useState({}); // areaId → usuario
  const [erroresLinea, setErroresLinea] = useState([]);

  const [areaId, setAreaId] = useState('');
  const [origen, setOrigen] = useState('proyecto');   // 'proyecto' | 'venta' | 'ninguno'
  const [proyectoId, setProyectoId] = useState(String(proyectoInicial ?? ''));
  const [ventaId, setVentaId] = useState('');
  const [recetaId, setRecetaId] = useState('');
  const [puertas, setPuertas] = useState('1');
  const [responsableId, setResponsableId] = useState(String(user?.id ?? ''));

  useEffect(() => {
    let vigente = true;
    Promise.all([API.ordenesTrabajo.opcionesNueva(), API.recetas.listar()])
      .then(([o, r]) => { if (vigente) { setOpciones(o); setRecetas(Array.isArray(r) ? r : []); } })
      .catch(err => { if (vigente) setError('No se pudieron cargar las opciones: ' + err.message); });
    return () => { vigente = false; };
  }, []);

  // F-30: áreas que tendrán OT según cada receta elegida (las que tienen insumos en ella)
  useEffect(() => {
    const faltan = [...new Set(lineas.map(l => l.recetaId).filter(id => id && !(id in areasDe)))];
    if (!faltan.length) return;
    let vigente = true;
    Promise.all(faltan.map(id => API.recetas.obtener(id).then(r => [id, r]).catch(() => [id, null])))
      .then(res => {
        if (!vigente) return;
        setAreasDe(prev => {
          const n = { ...prev };
          for (const [id, r] of res) {
            const vistas = new Map((r?.materiales || []).map(m => [String(m.area_id), { id: String(m.area_id), nombre: m.area }]));
            n[id] = [...vistas.values()].sort((a, b) => Number(a.id) - Number(b.id));
          }
          return n;
        });
      });
    return () => { vigente = false; };
  }, [lineas, areasDe]);

  // Solo las áreas de producción tienen OT; lo de instalación va por el pedido de instalación (D44), igual que el backend
  const produccion = new Set((opciones?.areas || []).filter(a => a.clasificacion === 'produccion').map(a => String(a.id)));
  const areasDeLinea = (recetaId) => (areasDe[recetaId] ? areasDe[recetaId].filter(a => produccion.has(a.id)) : undefined);
  const areasTotales = [...new Map(lineas.flatMap(l => areasDeLinea(l.recetaId) || []).map(a => [a.id, a])).values()]
    .sort((a, b) => Number(a.id) - Number(b.id));
  const cambiarLinea = (i, campo, valor) => setLineas(ls => ls.map((l, j) => (j === i ? { ...l, [campo]: valor } : l)));
  // "Otro tipo de puerta" copia la última línea (suele cambiar solo la medida o la cantidad)
  const agregarLinea = () => setLineas(ls => [...ls, { ...ls[ls.length - 1], puertas: '1' }]);
  const quitarLinea = (i) => setLineas(ls => ls.filter((_, j) => j !== i));

  const crearPuertas = async () => {
    if (origen === 'proyecto' && !proyectoId) { setError('Elija el proyecto.'); return; }
    if (origen === 'venta' && !ventaId) { setError('Elija la venta.'); return; }
    setGuardando(true);
    setError(null);
    setErroresLinea([]);
    try {
      const r = await API.ordenesTrabajo.crearPuertas({
        ...(origen === 'proyecto' ? { proyecto_id: Number(proyectoId) } : { nota_venta_id: Number(ventaId) }),
        responsables: Object.fromEntries(areasTotales.map(a => [a.id, Number(responsables[a.id] ?? user?.id)])),
        lineas: lineas.map(l => ({
          receta_id: l.recetaId ? Number(l.recetaId) : null,
          cantidad_puertas: l.puertas,
          medidas: {
            medido: l.medido, vano_ancho_mm: l.ancho, vano_alto_mm: l.alto, perfil_marco_mm: l.perfil,
            hojas: l.hojas, mdf: l.mdf, ...(l.mdf && { mdf_espesor_mm: l.espesor }),
          },
        })),
      });
      if (onCreadas) onCreadas(r.message);
      else navigate(`/ordenes/${r.puertas[0].ots[0].id}`);
    } catch (err) {
      if (err.payload?.errores?.length) setErroresLinea(err.payload.errores);
      setError(err.message);
    } finally {
      setGuardando(false);
    }
  };

  const crear = async () => {
    if (modo === 'puertas') { crearPuertas(); return; }
    if (!areaId) { setError('Elija el área de la OT.'); return; }
    if (origen === 'proyecto' && !proyectoId) { setError('Elija el proyecto, o marque "Sin proyecto".'); return; }
    if (origen === 'venta' && !ventaId) { setError('Elija la venta.'); return; }
    if (recetaId && !/^\d+$/.test(puertas)) { setError('La cantidad de puertas debe ser un número entero.'); return; }
    setGuardando(true);
    setError(null);
    try {
      const r = await API.ordenesTrabajo.crear({
        area_id: Number(areaId),
        ...(origen === 'proyecto' && { proyecto_id: Number(proyectoId) }),
        ...(origen === 'venta' && { nota_venta_id: Number(ventaId) }),
        ...(recetaId && { receta_id: Number(recetaId), cantidad_puertas: Number(puertas) }),
        responsable_id: Number(responsableId),
      });
      navigate(`/ordenes/${r.id}`);
    } catch (err) {
      setError(err.message);
    } finally {
      setGuardando(false);
    }
  };

  const ventasConProyecto = (opciones?.ventas || []).filter(v => v.proyecto_id != null);
  const ventasSinProyecto = (opciones?.ventas || []).length - ventasConProyecto.length;

  return (
    <div className="modal-backdrop show" id="modal-nueva-ot" onClick={e => { if (e.target === e.currentTarget) onCerrar(); }}>
      <div className={'modal' + (modo === 'puertas' ? ' modal-lg' : '')}>
        <div className="modal-header">
          <div>
            <div className="modal-title">{modo === 'puertas' ? 'Nuevas puertas' : 'Nueva orden de trabajo'}</div>
            <div className="modal-subtitle">
              {modo === 'puertas'
                ? 'Una línea por tipo de puerta. Se crea una OT por cada área con insumos en la receta, con las medidas ya cargadas.'
                : 'Una OT por área. La receta se puede cargar ahora o después, en la pestaña Consumo.'}
            </div>
          </div>
          <button className="modal-close" onClick={onCerrar}>&#x2715;</button>
        </div>
        <div className="modal-body">
          {/* F-30: puertas de un proyecto (por defecto) o una OT suelta (como antes) */}
          <div className="tabs" style={{ marginBottom: 14 }}>
            {[['puertas', 'Puertas de un proyecto'], ['suelta', 'Una OT suelta']].map(([v, t]) => (
              <button key={v} type="button" className={'tab' + (modo === v ? ' active' : '')} id={`not-modo-${v}`}
                onClick={() => { setModo(v); setError(null); setErroresLinea([]); if (v === 'puertas' && origen === 'ninguno') setOrigen('proyecto'); }}>{t}</button>
            ))}
          </div>
          {error && <AvisoCerrable className="alert alert-danger">{error}</AvisoCerrable>}
          {erroresLinea.length > 1 && (
            <ul style={{ fontSize: 12, color: 'var(--danger)', margin: '0 0 12px 18px' }} id="not-errores-linea">
              {erroresLinea.map((e, i) => <li key={i}>{e.error}</li>)}
            </ul>
          )}
          {!opciones && !error && <div style={{ color: 'var(--gray)' }}>Cargando…</div>}
          {opciones && modo === 'puertas' && (
            <FormPuertas opciones={opciones} recetas={recetas} usuarios={opciones.usuarios} user={user}
              origen={origen} setOrigen={setOrigen} proyectoId={proyectoId} setProyectoId={setProyectoId}
              ventaId={ventaId} setVentaId={setVentaId}
              lineas={lineas} cambiarLinea={cambiarLinea} agregarLinea={agregarLinea} quitarLinea={quitarLinea}
              areasDeLinea={areasDeLinea} areasTotales={areasTotales} responsables={responsables} setResponsables={setResponsables}
              erroresLinea={erroresLinea} />
          )}
          {opciones && modo === 'suelta' && (
            <>
              <div className="form-group">
                <label className="form-label" htmlFor="not-area">Área <span className="required">*</span></label>
                <select className="form-control" id="not-area" value={areaId} onChange={e => setAreaId(e.target.value)}>
                  <option value="">Elija el área…</option>
                  {opciones.areas.map(a => <option key={a.id} value={a.id}>{a.nombre}</option>)}
                </select>
              </div>

              <div className="form-group">
                <label className="form-label">Para</label>
                <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', fontSize: 14 }}>
                  {[['proyecto', 'Un proyecto'], ['venta', 'Una venta'], ['ninguno', 'Sin proyecto']].map(([v, t]) => (
                    <label key={v} style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                      <input type="radio" name="not-origen" value={v} checked={origen === v} onChange={() => setOrigen(v)} /> {t}
                    </label>
                  ))}
                </div>
              </div>
              {origen === 'proyecto' && (
                <div className="form-group">
                  <select className="form-control" id="not-proyecto" aria-label="Proyecto" value={proyectoId} onChange={e => setProyectoId(e.target.value)}>
                    <option value="">Elija el proyecto…</option>
                    {opciones.proyectos.map(p => <option key={p.id} value={p.id}>{p.codigo} — {p.nombre}</option>)}
                  </select>
                </div>
              )}
              {origen === 'venta' && (
                <div className="form-group">
                  <select className="form-control" id="not-venta" aria-label="Venta" value={ventaId} onChange={e => setVentaId(e.target.value)}>
                    <option value="">Elija la venta (aprobada o en proceso)…</option>
                    {ventasConProyecto.map(v => <option key={v.id} value={v.id}>{v.numero}</option>)}
                  </select>
                  {ventasSinProyecto > 0 && (
                    <div className="form-hint">
                      {ventasSinProyecto} venta(s) no aparecen porque no tienen un proyecto de Terreno: la OT se liga al proyecto de la venta.
                    </div>
                  )}
                </div>
              )}

              <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
                <div className="form-group" style={{ flex: 2, minWidth: 200 }}>
                  <label className="form-label" htmlFor="not-receta">Receta</label>
                  <select className="form-control" id="not-receta" value={recetaId} onChange={e => setRecetaId(e.target.value)}>
                    <option value="">Sin receta por ahora</option>
                    {recetas.filter(r => r.activo).map(r => <option key={r.id} value={r.id}>{r.codigo} — {r.nombre}</option>)}
                  </select>
                </div>
                {recetaId && (
                  <div className="form-group" style={{ flex: 1, minWidth: 90 }}>
                    <label className="form-label" htmlFor="not-puertas">Puertas</label>
                    <input className="form-control" id="not-puertas" inputMode="numeric" value={puertas}
                      onChange={e => setPuertas(e.target.value.trim())} />
                  </div>
                )}
              </div>

              <div className="form-group">
                <label className="form-label" htmlFor="not-responsable">Responsable</label>
                <select className="form-control" id="not-responsable" value={responsableId} onChange={e => setResponsableId(e.target.value)}>
                  {opciones.usuarios.map(u => <option key={u.id} value={u.id}>{u.nombre ? `${u.nombre} (${u.username})` : u.username}</option>)}
                </select>
              </div>
            </>
          )}
        </div>
        <div className="modal-footer">
          <button className="btn btn-secondary" onClick={onCerrar} disabled={guardando}>Cancelar</button>
          <button className="btn btn-primary" id="btn-crear-ot" onClick={crear} disabled={guardando || !opciones}>
            {guardando ? 'Creando…' : modo === 'puertas' ? 'Crear las OT' : 'Crear OT'}
          </button>
        </div>
      </div>
    </div>
  );
}

/** F-30: proyecto o venta, líneas de puertas (receta, medidas, cantidad) y responsable de cada área. */
function FormPuertas({ opciones, recetas, usuarios, user, origen, setOrigen, proyectoId, setProyectoId, ventaId, setVentaId,
                       lineas, cambiarLinea, agregarLinea, quitarLinea, areasDeLinea, areasTotales, responsables, setResponsables,
                       erroresLinea }) {
  const ventasConProyecto = (opciones.ventas || []).filter(v => v.proyecto_id != null);
  const conError = (i, campo) => erroresLinea.some(e => e.linea === i + 1 && e.campo === campo);
  const borde = (i, campo) => (conError(i, campo) ? { borderColor: 'var(--danger)' } : {});
  const totalOT = lineas.reduce((n, l) => n + (areasDeLinea(l.recetaId)?.length || 0), 0);

  return (
    <>
      <div className="form-group">
        <label className="form-label">Para</label>
        <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', fontSize: 14 }}>
          {[['proyecto', 'Un proyecto'], ['venta', 'Una venta']].map(([v, t]) => (
            <label key={v} style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <input type="radio" name="np-origen" value={v} checked={origen === v} onChange={() => setOrigen(v)} /> {t}
            </label>
          ))}
        </div>
      </div>
      {origen === 'proyecto' ? (
        <div className="form-group">
          <select className="form-control" id="np-proyecto" aria-label="Proyecto" value={proyectoId} onChange={e => setProyectoId(e.target.value)}>
            <option value="">Elija el proyecto…</option>
            {opciones.proyectos.map(p => <option key={p.id} value={p.id}>{p.codigo} — {p.nombre}</option>)}
          </select>
        </div>
      ) : (
        <div className="form-group">
          <select className="form-control" id="np-venta" aria-label="Venta" value={ventaId} onChange={e => setVentaId(e.target.value)}>
            <option value="">Elija la venta (aprobada o en proceso)…</option>
            {ventasConProyecto.map(v => <option key={v.id} value={v.id}>{v.numero}</option>)}
          </select>
        </div>
      )}

      <div className="section-label" style={{ marginTop: 4 }}>Tipos de puerta</div>
      {lineas.map((l, i) => {
        const areas = areasDeLinea(l.recetaId);
        return (
          <div key={i} className="card card-sm" style={{ marginBottom: 10, padding: 12 }} id={`np-linea-${i + 1}`}>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-end' }}>
              <div style={{ flex: 3, minWidth: 200 }}>
                <label className="form-label" style={{ marginBottom: 4 }}>Receta (modelo)</label>
                <select className="form-control" value={l.recetaId} style={borde(i, 'receta_id')} onChange={e => cambiarLinea(i, 'recetaId', e.target.value)}>
                  <option value="">Elija la receta…</option>
                  {recetas.filter(r => r.activo).map(r => <option key={r.id} value={r.id}>{r.codigo} — {r.nombre}</option>)}
                </select>
              </div>
              <div style={{ width: 90 }}>
                <label className="form-label" style={{ marginBottom: 4 }}>Puertas</label>
                <input className="form-control" inputMode="numeric" value={l.puertas} style={borde(i, 'cantidad_puertas')}
                  onChange={e => cambiarLinea(i, 'puertas', e.target.value.trim())} />
              </div>
              {lineas.length > 1 && (
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => quitarLinea(i)} title="Quitar este tipo de puerta">Quitar</button>
              )}
            </div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-end', marginTop: 8 }}>
              <div style={{ width: 150 }}>
                <label className="form-label" style={{ marginBottom: 4 }}>¿Qué midió?</label>
                <select className="form-control" value={l.medido} onChange={e => cambiarLinea(i, 'medido', e.target.value)}>
                  <option value="vano">Vano, por dentro</option>
                  <option value="marco">Marco</option>
                </select>
              </div>
              <div style={{ width: 110 }}>
                <label className="form-label" style={{ marginBottom: 4 }}>Ancho (mm)</label>
                <input className="form-control" inputMode="decimal" value={l.ancho} style={borde(i, 'vano_ancho_mm')} onChange={e => cambiarLinea(i, 'ancho', e.target.value)} />
              </div>
              <div style={{ width: 110 }}>
                <label className="form-label" style={{ marginBottom: 4 }}>Alto (mm)</label>
                <input className="form-control" inputMode="decimal" value={l.alto} style={borde(i, 'vano_alto_mm')} onChange={e => cambiarLinea(i, 'alto', e.target.value)} />
              </div>
              <div style={{ width: 110 }}>
                <label className="form-label" style={{ marginBottom: 4 }}>Perfil marco (mm)</label>
                <input className="form-control" inputMode="decimal" value={l.perfil} style={borde(i, 'perfil_marco_mm')} onChange={e => cambiarLinea(i, 'perfil', e.target.value)} />
              </div>
              <div style={{ width: 80 }}>
                <label className="form-label" style={{ marginBottom: 4 }}>Hojas</label>
                <select className="form-control" value={l.hojas} onChange={e => cambiarLinea(i, 'hojas', e.target.value)}>
                  <option value="1">1</option><option value="2">2</option>
                </select>
              </div>
              <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 13, paddingBottom: 8 }}>
                <input type="checkbox" checked={l.mdf} onChange={e => cambiarLinea(i, 'mdf', e.target.checked)} /> Con MDF
              </label>
              {l.mdf && (
                <div style={{ width: 100 }}>
                  <label className="form-label" style={{ marginBottom: 4 }}>MDF (mm)</label>
                  <select className="form-control" value={l.espesor} onChange={e => cambiarLinea(i, 'espesor', e.target.value)}>
                    {ESPESORES_MDF.map(v => <option key={v} value={String(v)}>{mm(v)}</option>)}
                  </select>
                </div>
              )}
            </div>
            <div style={{ fontSize: 12, color: 'var(--gray)', marginTop: 6 }}>
              {!l.recetaId ? 'Elija la receta para ver qué OT se crean.'
                : !areas ? 'Revisando la receta…'
                : areas.length ? `Se crea una OT de: ${areas.map(a => a.nombre).join(', ')}.`
                : 'Esta receta no tiene insumos de áreas de producción: no se puede crear su OT.'}
            </div>
          </div>
        );
      })}
      <button type="button" className="btn btn-ghost btn-sm" id="np-agregar" onClick={agregarLinea}>+ Otro tipo de puerta</button>

      {areasTotales.length > 0 && (
        <>
          <div className="section-label" style={{ marginTop: 14 }}>Responsable de cada área</div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {areasTotales.map(a => (
              <div key={a.id} style={{ minWidth: 180, flex: 1 }}>
                <label className="form-label" style={{ marginBottom: 4 }}>{a.nombre}</label>
                <select className="form-control" value={String(responsables[a.id] ?? user?.id ?? '')}
                  onChange={e => setResponsables(r => ({ ...r, [a.id]: e.target.value }))}>
                  {usuarios.map(u => <option key={u.id} value={u.id}>{u.nombre ? `${u.nombre} (${u.username})` : u.username}</option>)}
                </select>
              </div>
            ))}
          </div>
          <div style={{ fontSize: 12, color: 'var(--gray)', marginTop: 8 }} id="np-resumen">
            Se crearán {totalOT} OT. Las holguras usan los valores sugeridos; se ajustan después en la pestaña Consumo de cualquier OT de la puerta.
          </div>
        </>
      )}
    </>
  );
}
