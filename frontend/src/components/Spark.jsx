/**
 * Spark — tiny inline sparkline (SVG, no deps)
 * Props: data (number[]), width, height, color, filled
 */
export function Spark({ data = [], width = 80, height = 28, color = '#22d3ee', filled = false }) {
  if (data.length < 2) return <svg width={width} height={height} />;

  const min = Math.min(...data);
  const max = Math.max(...data);
  const range = max - min || 1;

  const xs = data.map((_, i) => (i / (data.length - 1)) * width);
  const ys = data.map(v => height - ((v - min) / range) * (height - 2) - 1);

  const pts = xs.map((x, i) => `${x},${ys[i]}`).join(' ');
  const line = `M ${pts.replace(/ /g, ' L ')}`;
  const area = `${line} L ${xs[xs.length - 1]},${height} L 0,${height} Z`;

  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} style={{ display: 'block' }}>
      {filled && (
        <path d={area} fill={color} fillOpacity={0.12} />
      )}
      <polyline
        points={pts}
        fill="none"
        stroke={color}
        strokeWidth={1.5}
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}

/**
 * MiniBar — horizontal bar showing a percentage fill
 */
export function MiniBar({ pct, color = '#22d3ee', height = 4 }) {
  const clamped = Math.max(0, Math.min(100, pct));
  return (
    <div style={{ background: '#1e293b', borderRadius: 2, height, overflow: 'hidden' }}>
      <div style={{ width: `${clamped}%`, height: '100%', background: color, borderRadius: 2, transition: 'width 0.4s' }} />
    </div>
  );
}
