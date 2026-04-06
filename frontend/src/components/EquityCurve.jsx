import { useMemo } from 'react';

/**
 * EquityCurve — SVG line chart of equity over time
 * Builds from trade history within current session
 */
export function EquityCurve({ trades = [], startCapital = 2000 }) {
  const { points, min, max, width, height } = useMemo(() => {
    const W = 560, H = 100;

    // Build equity series from closed trades (BUY/SELL events)
    let equity = startCapital;
    const series = [{ equity, t: 0 }];

    for (const t of trades) {
      if (t.pnl != null) {
        equity = Math.max(0, equity + t.pnl);
        series.push({ equity, t: t.timestamp || Date.now() });
      }
    }

    if (series.length < 2) {
      return { points: [], min: startCapital, max: startCapital, width: W, height: H };
    }

    const equities = series.map(s => s.equity);
    const lo = Math.min(...equities) * 0.998;
    const hi = Math.max(...equities) * 1.002;

    const pts = series.map((s, i) => {
      const x = (i / (series.length - 1)) * W;
      const y = H - ((s.equity - lo) / (hi - lo || 1)) * (H - 4) - 2;
      return { x, y };
    });

    return { points: pts, min: lo, max: hi, width: W, height: H };
  }, [trades, startCapital]);

  if (points.length < 2) {
    return (
      <div style={styles.wrap}>
        <div style={styles.title}>Equity Curve</div>
        <div style={{ color: '#334155', fontSize: 12, padding: 20, textAlign: 'center' }}>
          Wachten op trades...
        </div>
      </div>
    );
  }

  const polyPts  = points.map(p => `${p.x},${p.y}`).join(' ');
  const lastPt   = points[points.length - 1];
  const isProfit = points[points.length - 1].y < points[0].y; // SVG: lower y = higher value
  const lineColor = isProfit ? '#22d3ee' : '#f87171';

  // Fill area below line
  const areaPath = `M 0,${height} L ${points.map(p => `${p.x},${p.y}`).join(' L ')} L ${width},${height} Z`;

  return (
    <div style={styles.wrap}>
      <div style={styles.titleRow}>
        <span style={styles.title}>Equity Curve</span>
        <span style={{ fontSize: 11, color: '#475569' }}>
          Min: €{min.toFixed(0)} — Max: €{max.toFixed(0)}
        </span>
      </div>

      <svg
        viewBox={`0 0 ${width} ${height}`}
        style={{ width: '100%', height: 100, display: 'block' }}
        preserveAspectRatio="none"
      >
        {/* Zero line (start capital) */}
        {(() => {
          const baseY = height - ((startCapital - min) / (max - min || 1)) * (height - 4) - 2;
          return <line x1={0} y1={baseY} x2={width} y2={baseY} stroke="#1e293b" strokeWidth={1} strokeDasharray="4,4" />;
        })()}

        {/* Fill */}
        <path d={areaPath} fill={lineColor} fillOpacity={0.07} />

        {/* Line */}
        <polyline
          points={polyPts}
          fill="none"
          stroke={lineColor}
          strokeWidth={1.8}
          strokeLinejoin="round"
          strokeLinecap="round"
        />

        {/* Current dot */}
        <circle cx={lastPt.x} cy={lastPt.y} r={3} fill={lineColor} />
      </svg>
    </div>
  );
}

const styles = {
  wrap: {
    background: '#0f172a', border: '1px solid #1e293b', borderRadius: 8,
    overflow: 'hidden',
  },
  titleRow: {
    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
    padding: '10px 14px 6px', borderBottom: '1px solid #1e293b',
  },
  title: { color: '#475569', fontSize: 11, fontWeight: 700, letterSpacing: 1, textTransform: 'uppercase' },
};
