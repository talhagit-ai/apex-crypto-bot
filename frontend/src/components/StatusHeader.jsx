import { MiniBar } from './Spark.jsx';

const STATUS_COLOR = { connected: '#22c55e', connecting: '#f59e0b', disconnected: '#ef4444' };
const STATUS_LABEL = { connected: 'LIVE', connecting: 'CONNECTING...', disconnected: 'OFFLINE' };

/**
 * StatusHeader — top bar showing connection, equity, risk meters
 */
export function StatusHeader({ state, status, lastPing }) {
  const color  = STATUS_COLOR[status] || '#94a3b8';
  const label  = STATUS_LABEL[status] || status.toUpperCase();

  const equity   = state?.equity   ?? 0;
  const pnl      = state?.pnl      ?? 0;
  const pnlPct   = state?.returnPct ?? 0;
  const daily    = state?.risk?.dailyLoss   ?? 0;
  const weekly   = state?.risk?.weeklyLoss  ?? 0;
  const killed   = state?.risk?.killed      ?? false;
  const reduced  = (state?.risk?.riskReduction ?? 1) < 1;

  const spotEUR    = state?.realBalances?.spotEUR    ?? null;
  const futuresUSD = state?.realBalances?.futuresUSD ?? null;

  const pnlColor = pnl >= 0 ? '#22d3ee' : '#f87171';
  const lastStr  = lastPing ? new Date(lastPing).toLocaleTimeString('nl-NL') : '—';

  return (
    <header style={styles.header}>
      {/* Left: status dot + title */}
      <div style={styles.left}>
        <span style={{ ...styles.dot, background: color }} />
        <span style={styles.title}>APEX CRYPTO</span>
        <span style={{ ...styles.badge, color }}>{label}</span>
        {killed  && <span style={{ ...styles.badge, color: '#ef4444', border: '1px solid #ef4444' }}>KILL SWITCH</span>}
        {reduced && !killed && <span style={{ ...styles.badge, color: '#f59e0b', border: '1px solid #f59e0b' }}>RISK REDUCED</span>}
      </div>

      {/* Centre: real Kraken balances + engine P&L */}
      <div style={styles.centre}>
        <div style={styles.balances}>
          <div style={styles.balanceItem}>
            <span style={styles.balanceLabel}>Spot</span>
            <span style={styles.balanceValue}>
              {spotEUR !== null ? `€${spotEUR.toFixed(2)}` : '—'}
            </span>
          </div>
          <div style={{ color: '#334155', fontSize: 16, margin: '0 6px' }}>|</div>
          <div style={styles.balanceItem}>
            <span style={styles.balanceLabel}>Futures</span>
            <span style={styles.balanceValue}>
              {futuresUSD !== null ? `$${futuresUSD.toFixed(2)}` : '—'}
            </span>
          </div>
        </div>
        <span style={{ color: pnlColor, fontSize: 12, marginLeft: 14 }}>
          Bot P&L: {pnl >= 0 ? '+' : ''}€{pnl.toFixed(2)} ({pnlPct >= 0 ? '+' : ''}{pnlPct.toFixed(2)}%)
        </span>
      </div>

      {/* Right: risk meters + last tick */}
      <div style={styles.right}>
        <div style={styles.meter}>
          <span style={styles.meterLabel}>Dag</span>
          <MiniBar pct={daily * 50} color={daily > 3 ? '#ef4444' : '#f59e0b'} />
          <span style={styles.meterVal}>{daily.toFixed(1)}%</span>
        </div>
        <div style={styles.meter}>
          <span style={styles.meterLabel}>Week</span>
          <MiniBar pct={weekly * 12.5} color={weekly > 6 ? '#ef4444' : '#f59e0b'} />
          <span style={styles.meterVal}>{weekly.toFixed(1)}%</span>
        </div>
        <span style={styles.lastTick}>Tick: {lastStr}</span>
      </div>
    </header>
  );
}

const styles = {
  header: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    background: '#0f172a', borderBottom: '1px solid #1e293b',
    padding: '10px 20px', gap: 16, flexWrap: 'wrap',
  },
  left: { display: 'flex', alignItems: 'center', gap: 8 },
  dot:  { width: 8, height: 8, borderRadius: '50%', flexShrink: 0 },
  title: { color: '#e2e8f0', fontWeight: 700, fontSize: 15, letterSpacing: 1 },
  badge: {
    fontSize: 10, fontWeight: 700, letterSpacing: 1, padding: '2px 6px',
    borderRadius: 4, background: 'transparent',
  },
  centre: { display: 'flex', alignItems: 'center', gap: 4 },
  balances: { display: 'flex', alignItems: 'center', gap: 4 },
  balanceItem: { display: 'flex', flexDirection: 'column', alignItems: 'center', minWidth: 70 },
  balanceLabel: { color: '#475569', fontSize: 9, letterSpacing: 1, textTransform: 'uppercase' },
  balanceValue: { color: '#f1f5f9', fontSize: 18, fontWeight: 700, fontVariantNumeric: 'tabular-nums' },
  right: { display: 'flex', alignItems: 'center', gap: 14 },
  meter: { display: 'flex', alignItems: 'center', gap: 5, minWidth: 110 },
  meterLabel: { color: '#64748b', fontSize: 11, width: 28 },
  meterVal:   { color: '#94a3b8', fontSize: 11, width: 34, textAlign: 'right' },
  lastTick: { color: '#475569', fontSize: 11, marginLeft: 4 },
};
