import {
  Bar, BarChart, CartesianGrid, Cell, LabelList, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';

/**
 * F-18 (D88): los gráficos con Recharts, la misma librería y versión que Finanzas (3.10.1).
 * Se carga aparte (lazy, desde Charts.jsx) para no agrandar el bundle principal.
 *
 * Los colores se leen de los tokens de global.css y se pasan como valores fijos: al exportar el SVG a PNG o PDF
 * las variables CSS no se resuelven y saldría todo negro.
 */

const leerToken = (nombre) => {
  const v = getComputedStyle(document.documentElement).getPropertyValue(nombre).trim();
  return v || 'gray';
};
const SERIES = 8;
const colorSerie = (i) => leerToken(`--serie-${(i % SERIES) + 1}`);

/** Color fijo por área (por su id, no por su nombre): la misma área tiene el mismo color en todos los gráficos. */
const colorArea = (areaId) => colorSerie(Math.max(Number(areaId) - 1, 0));

/** Un color pedido como 'var(--token)' se resuelve a su valor. */
const resolver = (c) => {
  const m = /^var\((--[\w-]+)\)$/.exec(String(c || '').trim());
  return m ? leerToken(m[1]) : c;
};

const colorDe = (s, i) => (s.color ? resolver(s.color) : s.area_id != null ? colorArea(s.area_id) : colorSerie(i));

/** Texto recortado para que no se desborde del área de etiquetas. */
const corta = (s, n) => (String(s).length > n ? String(s).slice(0, n - 1) + '…' : String(s));

const estilos = () => {
  const gris = leerToken('--gray');
  return {
    tick: { fontSize: 11, fill: gris },
    grilla: leerToken('--gray-mid'),
    tooltip: {
      contentStyle: { borderRadius: 8, border: `1px solid ${leerToken('--gray-mid')}`, fontSize: 12, boxShadow: '0 4px 16px rgba(0,0,0,.10)' },
      labelStyle: { fontWeight: 600, marginBottom: 4 },
    },
    leyenda: { fontSize: 12, color: gris },
  };
};

/** Barras horizontales: una fila por ítem. Para comparar pocas categorías con nombres largos (las áreas). */
export function BarrasHorizontales({ datos, formato = v => v, formatoDetalle = formato, alturaFila = 32 }) {
  const e = estilos();
  const alto = Math.max(datos.length * alturaFila + 24, 80);
  return (
    <ResponsiveContainer width="100%" height={alto}>
      <BarChart data={datos} layout="vertical" margin={{ top: 4, right: 90, bottom: 4, left: 8 }}>
        <XAxis type="number" hide domain={[0, 'dataMax']} />
        <YAxis type="category" dataKey="label" width={170} tick={e.tick} tickFormatter={l => corta(l, 24)} axisLine={false} tickLine={false} />
        <Tooltip cursor={{ fill: leerToken('--gray-light') }} formatter={v => [formatoDetalle(v), '']} separator="" {...e.tooltip} />
        <Bar dataKey="valor" radius={[0, 3, 3, 0]} barSize={Math.max(alturaFila - 12, 8)} isAnimationActive={false}>
          {datos.map((d, i) => <Cell key={d.label} fill={colorDe(d, i)} />)}
          <LabelList dataKey="valor" position="right" formatter={formato} style={{ fontSize: 11, fill: e.tick.fill }} />
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}

/**
 * Pasa labels + series ({ label, data }) a las filas que usa Recharts: { label, s0, s1, ... }.
 * Con `sinCeros`, un 0 pasa a null: en las barras apiladas no aparece en el detalle un área que no consumió.
 */
const filas = (labels, series, sinCeros = false) => labels.map((label, i) => {
  const fila = { label };
  series.forEach((s, si) => { fila[`s${si}`] = sinCeros && s.data[i] === 0 ? null : s.data[i]; });
  return fila;
});

/**
 * Barras verticales: un grupo por etiqueta y una barra por serie. Con `apiladas`, las series se apilan (consumo
 * mensual por área: la altura es el total del mes y cada color, lo de un área). Un dato null no se dibuja (F-14).
 */
export function BarrasAgrupadas({ labels, series, formato = v => v, formatoDetalle = formato, apiladas = false, onClickEtiqueta }) {
  const e = estilos();
  return (
    <ResponsiveContainer width="100%" height={340}>
      <BarChart data={filas(labels, series, apiladas)} margin={{ top: 8, right: 12, bottom: 8, left: 8 }}
        style={onClickEtiqueta ? { cursor: 'pointer' } : undefined}
        onClick={onClickEtiqueta ? (st) => {
          // F-18: clic en un grupo de barras → su etiqueta (para bajar de mes a semana y de semana a día)
          const i = Number(st?.activeTooltipIndex);
          const idx = Number.isInteger(i) && i >= 0 ? i : labels.indexOf(st?.activeLabel);
          if (idx >= 0) onClickEtiqueta(labels[idx], idx);
        } : undefined}>
        <CartesianGrid vertical={false} stroke={e.grilla} />
        <XAxis dataKey="label" tick={e.tick} tickFormatter={l => corta(l, 22)} interval={0}
          angle={labels.length > 6 ? -35 : 0} textAnchor={labels.length > 6 ? 'end' : 'middle'} height={labels.length > 6 ? 70 : 30} />
        <YAxis tick={e.tick} tickFormatter={formato} width={70} axisLine={false} tickLine={false} />
        <Tooltip cursor={{ fill: leerToken('--gray-light') }} formatter={(v, n) => [formatoDetalle(v), n]} {...e.tooltip} />
        <Legend verticalAlign="top" align="left" iconType="square" iconSize={10} height={32} wrapperStyle={e.leyenda} />
        {series.map((s, si) => (
          <Bar key={s.label} dataKey={`s${si}`} name={s.label} fill={colorDe(s, si)} stackId={apiladas ? 'total' : undefined}
            radius={apiladas ? 0 : [2, 2, 0, 0]} maxBarSize={28} isAnimationActive={false} />
        ))}
      </BarChart>
    </ResponsiveContainer>
  );
}

/**
 * Serie temporal: una línea por serie. Una serie con `punteada: true` se dibuja discontinua y sin puntos (p. ej. una
 * línea de tendencia, CU-75). Para saldos en el tiempo (histórico); los consumos van en barras (F-18).
 */
export function LineaTemporal({ labels, series, formato = v => v, formatoDetalle = formato }) {
  const e = estilos();
  return (
    <ResponsiveContainer width="100%" height={320}>
      <LineChart data={filas(labels, series)} margin={{ top: 8, right: 16, bottom: 8, left: 8 }}>
        <CartesianGrid vertical={false} stroke={e.grilla} />
        <XAxis dataKey="label" tick={e.tick} />
        <YAxis tick={e.tick} tickFormatter={formato} width={70} axisLine={false} tickLine={false} />
        <Tooltip formatter={(v, n) => [formatoDetalle(v), n]} {...e.tooltip} />
        <Legend verticalAlign="top" align="left" iconType="plainline" height={32} wrapperStyle={e.leyenda} />
        {series.map((s, si) => (
          <Line key={s.label} dataKey={`s${si}`} name={s.label} stroke={colorDe(s, si)} strokeWidth={2} type="linear"
            strokeDasharray={s.punteada ? '6 4' : undefined} dot={s.punteada ? false : { r: 3 }} activeDot={{ r: 5 }}
            isAnimationActive={false} />
        ))}
      </LineChart>
    </ResponsiveContainer>
  );
}
