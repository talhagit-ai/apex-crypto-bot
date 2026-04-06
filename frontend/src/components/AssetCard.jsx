import { Spark, MiniBar } from './Spark.jsx';

const ASSET_NAMES = {
  BTCUSDT:  'Bitcoin',
  ETHUSDT:  'Ethereum',
  SOLUSDT:  'Solana',
  XRPUSDT:  'XRP',
  ADAUSDT:  'Cardano',
  DOTUSD:   'Polkadot',
  LINKUSD:  'Chainlink',
  AVAXUSD:  'Avalanche',
  ATOMUSD:  'Cosmos',
  UNIUSD:   'Uniswap',
  LTCUSD:   'Litecoin',
  MATICUSD: 'Polygon',
  POLUSD:   'Polkadot (POL)',
  DOGEUSD:  'Dogecoin',
  ALGOUSD:  'Algorand',
  NEARUSD:  'NEAR',
  FILUSD:   'Filecoin',
  AAVEUSD:  'Aave',
  GRTUSD:   'The Graph',
  SNXUSD:   'Synthetix',
  CRVUSD:   'Curve',
  COMPUSD:  'Compound',
  ENJUSD:   'Enjin',
  FLOWUSD:  'Flow',
  KSMUSD:   'Kusama',
  SANDUSD:  'The Sandbox',
  MANAUSD:  'Decentraland',
  AXSUSD:   'Axie Infinity',
  '1INCHUSD': '1inch',
  OCEANUSD: 'Ocean',
};

/**
 * AssetCard — shows live price, open position, signal indicators
 */
export function AssetCard({ assetId, color, position, recentTrades, currentPrice, regime }) {
  const name    = ASSET_NAMES[assetId] || assetId.replace('USDT', '');
  const ticker  = (ASSET_NAMES[assetId] ? assetId.replace(/USD(T?)$/, '') : assetId) + '/EUR';
  const hasPos  = !!position;
  const isShort = hasPos && position.side === 'short';

  // Price history from recent trades to build sparkline
  const priceSeries = recentTrades
    .filter(t => t.id === assetId && (t.side === 'BUY' || t.side === 'SHORT'))
    .map(t => t.price)
    .slice(-20);

  if (currentPrice && priceSeries.length > 0) priceSeries.push(currentPrice);

  // Position stats — short P&L is inverted
  const pnl    = hasPos && currentPrice
    ? isShort
      ? (position.entry - currentPrice) * position.qty
      : (currentPrice - position.entry) * position.qty
    : 0;
  const pnlPct = hasPos
    ? isShort
      ? ((position.entry - currentPrice) / position.entry * 100)
      : ((currentPrice - position.entry) / position.entry * 100)
    : 0;
  const pnlPos = pnl >= 0;

  // SL/TP progress bar
  const tpDist = hasPos
    ? isShort ? position.entry - position.tp : position.tp - position.entry
    : 0;
  const moved  = hasPos && currentPrice
    ? isShort ? position.entry - currentPrice : currentPrice - position.entry
    : 0;
  const rPct   = hasPos ? Math.max(0, Math.min(100, (moved / Math.max(tpDist, 0.001)) * 100)) : 0;

  const p1Done = hasPos && position.partial1Taken;
  const p2Done = hasPos && position.partial2Taken;

  return (
    <div style={{ ...styles.card, borderLeft: `3px solid ${color}` }}>
      {/* Header */}
      <div style={styles.cardHead}>
        <div style={styles.assetInfo}>
          <span style={{ ...styles.dot, background: color }} />
          <span style={styles.assetName}>{name}</span>
          <span style={styles.ticker}>{ticker}</span>
        </div>
        {hasPos && (
          <span style={{
            ...styles.posTag,
            color: '#0f172a',
            background: isShort ? '#f87171' : color,
          }}>
            {isShort ? 'SHORT' : 'LONG'}
          </span>
        )}
      </div>

      {/* Price + Spark */}
      <div style={styles.priceRow}>
        <span style={styles.price}>
          {currentPrice ? `€${_fmt(currentPrice)}` : '—'}
        </span>
        <Spark data={priceSeries} color={color} width={72} height={24} />
      </div>

      {/* Open position details */}
      {hasPos ? (
        <div style={styles.posDetails}>
          <div style={styles.posRow}>
            <span style={styles.label}>Entry</span>
            <span style={styles.val}>€{_fmt(position.entry)}</span>
            <span style={{ ...styles.pnl, color: pnlPos ? '#22d3ee' : '#f87171' }}>
              {pnlPos ? '+' : ''}€{pnl.toFixed(2)} ({pnlPct >= 0 ? '+' : ''}{pnlPct.toFixed(1)}%)
            </span>
          </div>

          <div style={styles.posRow}>
            <span style={styles.label}>SL</span>
            <span style={{ ...styles.val, color: '#f87171' }}>€{_fmt(position.sl)}</span>
            <span style={styles.label}>TP</span>
            <span style={{ ...styles.val, color: '#22c55e' }}>€{_fmt(position.tp)}</span>
          </div>

          {/* Progress bar: entry → TP */}
          <div style={{ marginTop: 6 }}>
            <MiniBar pct={rPct} color={pnlPos ? '#22d3ee' : '#f87171'} height={3} />
          </div>

          {/* Partial profit indicators */}
          <div style={styles.partialRow}>
            <span style={{ ...styles.partial, opacity: p1Done ? 1 : 0.3, color: p1Done ? '#22c55e' : '#64748b' }}>
              {p1Done ? '✓' : '○'} P1 @0.5R
            </span>
            <span style={{ ...styles.partial, opacity: p2Done ? 1 : 0.3, color: p2Done ? '#22c55e' : '#64748b' }}>
              {p2Done ? '✓' : '○'} P2 @1.0R
            </span>
            <span style={styles.partial}>Age: {position.age || 0}b</span>
          </div>
        </div>
      ) : (
        <div style={styles.idle}>
          <span style={{
            fontSize: 10, fontWeight: 700, letterSpacing: 1, padding: '2px 8px',
            borderRadius: 3, textTransform: 'uppercase',
            background: regime === 'bull' ? '#14532d' : regime === 'bear' ? '#450a0a' : '#1e293b',
            color: regime === 'bull' ? '#4ade80' : regime === 'bear' ? '#f87171' : '#475569',
          }}>
            {regime === 'bull' ? '▲ Bullish' : regime === 'bear' ? '▼ Bearish' : '— Neutral'}
          </span>
        </div>
      )}
    </div>
  );
}

function _fmt(n) {
  if (!n) return '0';
  if (n >= 1000) return n.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
  if (n >= 1)    return n.toFixed(2);
  return n.toFixed(4);
}

const styles = {
  card: {
    background: '#0f172a', border: '1px solid #1e293b', borderRadius: 8,
    padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 6,
    minWidth: 220,
  },
  cardHead: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' },
  assetInfo: { display: 'flex', alignItems: 'center', gap: 6 },
  dot: { width: 7, height: 7, borderRadius: '50%' },
  assetName: { color: '#e2e8f0', fontWeight: 600, fontSize: 13 },
  ticker: { color: '#475569', fontSize: 11 },
  posTag: { fontSize: 9, fontWeight: 800, padding: '1px 6px', borderRadius: 3, letterSpacing: 1 },
  priceRow: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' },
  price: { color: '#f1f5f9', fontSize: 17, fontWeight: 700, fontVariantNumeric: 'tabular-nums' },
  posDetails: { display: 'flex', flexDirection: 'column', gap: 4, marginTop: 2 },
  posRow: { display: 'flex', alignItems: 'center', gap: 8 },
  label: { color: '#475569', fontSize: 10, width: 20 },
  val:   { color: '#94a3b8', fontSize: 11, fontVariantNumeric: 'tabular-nums' },
  pnl:   { fontSize: 11, marginLeft: 'auto', fontWeight: 600 },
  partialRow: { display: 'flex', gap: 10, marginTop: 2 },
  partial: { fontSize: 9, fontWeight: 600, letterSpacing: 0.5 },
  idle: { display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '6px 0' },
};
