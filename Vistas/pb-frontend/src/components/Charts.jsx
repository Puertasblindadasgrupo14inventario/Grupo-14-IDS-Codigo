import { lazy, Suspense } from 'react';

/**
 * Gráficos — OPUS-12 (Req #4); F-18 (D88): con Recharts.
 *
 * Mantiene los nombres y props de antes (BarrasHorizontales, BarrasAgrupadas, LineaTemporal, svgRef) para que las
 * pantallas casi no cambien. El dibujo vive en ChartsRecharts.jsx, que se carga aparte la primera vez que se muestra
 * un gráfico: Recharts no entra al bundle principal.
 *
 * `svgRef` recibe el contenedor del gráfico (no el <svg>): svgAPng y descargarGrafico buscan el <svg> adentro y
 * agregan la leyenda, que Recharts dibuja en HTML.
 * `formato` es para el eje (montos abreviados); `formatoDetalle`, para el valor al pasar el mouse (monto completo).
 * Color de cada barra o línea: `color` ('var(--token)'), o `area_id` (color fijo por área), o el orden de la serie.
 */

const cargar = (nombre) => lazy(() => import('./ChartsRecharts').then(m => ({ default: m[nombre] })));
const BarrasHorizontalesR = cargar('BarrasHorizontales');
const BarrasAgrupadasR = cargar('BarrasAgrupadas');
const LineaTemporalR = cargar('LineaTemporal');

function Grafico({ svgRef, alto, children }) {
  return (
    <div ref={svgRef} style={{ width: '100%', minHeight: alto }}>
      <Suspense fallback={<div style={{ height: alto, display: 'grid', placeItems: 'center', fontSize: 12, color: 'var(--gray)' }}>Cargando gráfico…</div>}>
        {children}
      </Suspense>
    </div>
  );
}

/** Barras horizontales: una fila por ítem ({ label, valor, color?, area_id? }). */
export function BarrasHorizontales({ svgRef, ...props }) {
  const alto = Math.max((props.datos?.length || 0) * (props.alturaFila || 32) + 24, 80);
  return <Grafico svgRef={svgRef} alto={alto}><BarrasHorizontalesR {...props} /></Grafico>;
}

/**
 * Barras verticales por etiqueta, una por serie ({ label, data, area_id? }); `apiladas` las apila.
 * `onClickEtiqueta(label, indice)`: clic en un grupo de barras (F-18: bajar al detalle).
 */
export function BarrasAgrupadas({ svgRef, ...props }) {
  return <Grafico svgRef={svgRef} alto={340}><BarrasAgrupadasR {...props} /></Grafico>;
}

/** Serie temporal: una línea por serie ({ label, data, punteada?, area_id? }). */
export function LineaTemporal({ svgRef, ...props }) {
  return <Grafico svgRef={svgRef} alto={320}><LineaTemporalR {...props} /></Grafico>;
}

const MESES_CORTOS = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];

/**
 * F-18: etiqueta legible de un período del gráfico de consumo: 'YYYY-MM' → "jun 2026"; una semana
 * ('YYYY-MM-DD', su lunes) → "Sem. 08/06"; un día → "10/06".
 */
export function etiquetaPeriodo(iso, agrupacion = 'mes') {
  const [y, m, d] = String(iso).split('-');
  if (agrupacion === 'mes') return `${MESES_CORTOS[Number(m) - 1] || m} ${y}`;
  return `${agrupacion === 'semana' ? 'Sem. ' : ''}${d}/${m}`;
}

/** Valor de un token de global.css (el canvas necesita el color, no la variable). */
const token = (nombre) => getComputedStyle(document.documentElement).getPropertyValue(nombre).trim() || 'gray';

/**
 * El <svg> del gráfico: acepta el propio <svg> o el contenedor que entrega svgRef. Es el hijo directo de
 * .recharts-wrapper; los íconos de la leyenda también son <svg class="recharts-surface"> y no sirven.
 */
const svgDe = (el) => (!el ? null : el.tagName?.toLowerCase() === 'svg' ? el : el.querySelector('.recharts-wrapper > svg'));

/** Ítems de la leyenda HTML de Recharts: [{ texto, color }]. */
function leyendaDe(el) {
  if (!el || el.tagName?.toLowerCase() === 'svg') return [];
  return [...el.querySelectorAll('.recharts-legend-item')].map(li => {
    const marca = li.querySelector('svg path, svg line, svg rect');
    const color = marca?.getAttribute('fill') && marca.getAttribute('fill') !== 'none' ? marca.getAttribute('fill') : marca?.getAttribute('stroke');
    return { texto: li.querySelector('.recharts-legend-item-text')?.textContent || li.textContent, color: color || token('--gray') };
  });
}

/**
 * Convierte un gráfico en PNG (data URL) sobre fondo blanco, al doble de tamaño para que no se vea pixelado.
 * Recibe el <svg> o su contenedor. Resuelve { dataUrl, ancho, alto }. La usan la descarga de imagen y el PDF.
 */
export function svgAPng(el) {
  return new Promise((resolve, reject) => {
    const svgEl = svgDe(el);
    if (!svgEl) { reject(new Error('No hay gráfico para convertir')); return; }
    const caja = svgEl.getBoundingClientRect();
    const anchoSvg = svgEl.viewBox?.baseVal?.width || caja.width || 800;
    const altoSvg  = svgEl.viewBox?.baseVal?.height || caja.height || 400;
    const items = leyendaDe(el);
    const altoLeyenda = items.length ? 28 : 0;
    const escala = 2;

    const xml = new XMLSerializer().serializeToString(svgEl);
    const svg64 = 'data:image/svg+xml;base64,' + window.btoa(unescape(encodeURIComponent(xml)));

    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = anchoSvg * escala;
      canvas.height = (altoSvg + altoLeyenda) * escala;
      const ctx = canvas.getContext('2d');
      ctx.scale(escala, escala);
      ctx.fillStyle = token('--white');
      ctx.fillRect(0, 0, anchoSvg, altoSvg + altoLeyenda);
      // La leyenda de Recharts es HTML: se dibuja arriba para que no se pierda en la imagen
      let x = 8;
      ctx.font = '12px sans-serif';
      ctx.textBaseline = 'middle';
      items.forEach(it => {
        ctx.fillStyle = it.color;
        ctx.fillRect(x, 9, 10, 10);
        ctx.fillStyle = token('--gray');
        ctx.fillText(it.texto, x + 15, 14);
        x += 15 + ctx.measureText(it.texto).width + 16;
      });
      ctx.drawImage(img, 0, altoLeyenda, anchoSvg, altoSvg);
      resolve({ dataUrl: canvas.toDataURL('image/png'), ancho: anchoSvg, alto: altoSvg + altoLeyenda });
    };
    img.onerror = () => reject(new Error('No se pudo convertir el gráfico a imagen'));
    img.src = svg64;
  });
}

/**
 * Descarga un gráfico como PNG. Recibe el contenedor (vía svgRef) o el <svg>, y el nombre base.
 * Se dibuja sobre fondo blanco para que sirva en un informe impreso.
 */
export function descargarGrafico(el, nombre) {
  if (!el) return;
  svgAPng(el).then(({ dataUrl }) => {
    // Fecha LOCAL: toISOString() da UTC y de tarde en Chile nombraría el archivo
    // con el día siguiente
    const f = new Date();
    const fecha = `${f.getFullYear()}-${String(f.getMonth() + 1).padStart(2, '0')}-${String(f.getDate()).padStart(2, '0')}`;
    const a = document.createElement('a');
    a.href = dataUrl;
    a.download = `${nombre}-${fecha}.png`;
    document.body.appendChild(a);
    a.click();
    a.remove();
  }).catch(e => console.warn(e.message));
}
