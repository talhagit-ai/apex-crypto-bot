import { useWebSocket } from './hooks/useWebSocket.js';
import { StatusHeader }  from './components/StatusHeader.jsx';
import { AssetCard }     from './components/AssetCard.jsx';
import { TradeLog }      from './components/TradeLog.jsx';
import { EquityCurve }   from './components/EquityCurve.jsx';
import { OptimizerCard } from './components/OptimizerCard.jsx';

const CAPITAL = 100;

export default function Dashboard() {
  const { state, status, lastPing, prices } = useWebSocket();

  const positions  = state?.positions  || {};
  const trades     = state?.trades     || [];
  const stats      = state?.stats      || {};
  const equity     = state?.equity     ?? CAPITAL;
  // Assets come from the server (config-driven, no hardcoding needed)
  const assets     = state?.assets     || [];

  // Build price map from most recent trade per asset
  const priceMap = {};
  for (const t of trades) {
    priceMap[t.id] = t.price;
  }

  // Merge WebSocket live prices with state prices (state prices take precedence)
  const livePrices = { ...prices, ...(state?.prices || {}) };

  return (
    <div style={styles.root}>
      <StatusHeader state={state} status={status} lastPing={lastPing} />

      <main style={styles.main}>
        {/* ── Asset Cards (dynamic — all coins from config) ── */}
        <section style={styles.assets}>
          {assets.map(a => (
            <AssetCard
              key={a.id}
              assetId={a.id}
              color={a.color}
              position={positions[a.id] || null}
              recentTrades={trades}
              currentPrice={livePrices[a.id] || null}
              regime={state?.regimes?.[a.id] || 'neutral'}
            />
          ))}
        </section>

        {/* ── Stats Row ──────────────────────────── */}
        <section style={styles.statsRow}>
          <StatBox label="Win Rate"      value={`${stats.winRate ?? 0}%`}   color="#22d3ee" />
          <StatBox label="Profit Factor" value={stats.profitFactor ?? '—'}  color="#22c55e" />
          <StatBox label="Trades"        value={stats.totalTrades ?? 0}     color="#a78bfa" />
          <StatBox label="Wins"          value={stats.wins ?? 0}            color="#22c55e" />
          <StatBox label="Losses"        value={stats.losses ?? 0}          color="#f87171" />
          <StatBox label="Positions"     value={Object.keys(positions).length} color="#f59e0b" />
        </section>

        {/* ── Bottom Row: Equity Curve + Trade Log + Optimizer ─ */}
        <section style={styles.bottom}>
          <div style={{ flex: '1 1 50%' }}>
            <EquityCurve trades={trades} startCapital={state?.startCapital ?? CAPITAL} />
          </div>
          <div style={{ flex: '1 1 30%' }}>
            <TradeLog trades={trades} />
          </div>
          <div style={{ flex: '0 0 auto' }}>
            <OptimizerCard />
          </div>
        </section>
      </main>
    </div>
  );
}

function StatBox({ label, value, color }) {
  return (
    <div style={styles.statBox}>
      <span style={{ color, fontSize: 22, fontWeight: 800, fontVariantNumeric: 'tabular-nums' }}>
        {value}
      </span>
      <span style={{ color: '#475569', fontSize: 10, letterSpacing: 1, textTransform: 'uppercase' }}>
        {label}
      </span>
    </div>
  );
}

const styles = {
  root: {
    background: '#020817', minHeight: '100vh', color: '#e2e8f0',
    fontFamily: "'Inter', 'SF Pro Display', 'Segoe UI', monospace",
    display: 'flex', flexDirection: 'column',
  },
  main: { flex: 1, padding: '16px 20px', display: 'flex', flexDirection: 'column', gap: 14 },
  assets: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))',
    gap: 12,
  },
  statsRow: {
    display: 'grid',
    gridTemplateColumns: 'repeat(6, 1fr)',
    gap: 10,
  },
  statBox: {
    background: '#0f172a', border: '1px solid #1e293b', borderRadius: 8,
    padding: '12px 16px', display: 'flex', flexDirection: 'column', gap: 4,
    alignItems: 'center', textAlign: 'center',
  },
  bottom: { display: 'flex', gap: 14, flexWrap: 'wrap' },
};
