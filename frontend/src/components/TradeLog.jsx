/**
 * TradeLog — scrollable list of recent trades
 */
export function TradeLog({ trades = [] }) {
  // Show last 60 trades, newest first
  const visible = [...trades].reverse().slice(0, 60);

  return (
    <div style={styles.wrap}>
      <div style={styles.title}>Trades</div>
      <div style={styles.scroll}>
        {visible.length === 0 && (
          <div style={styles.empty}>Geen trades nog</div>
        )}
        {visible.map((t, i) => (
          <TradeRow key={i} trade={t} />
        ))}
      </div>
    </div>
  );
}

function TradeRow({ trade }) {
  const isBuy     = trade.side === 'BUY';
  const isSell    = trade.side === 'SELL';
  const isPartial = trade.side?.startsWith('PARTIAL');
  const win       = trade.win;

  let sideColor = '#64748b';
  let sideLabel = trade.side;
  if (isBuy)          { sideColor = '#22d3ee'; sideLabel = 'BUY'; }
  if (isSell && win)  { sideColor = '#22c55e'; sideLabel = 'SELL'; }
  if (isSell && !win) { sideColor = '#f87171'; sideLabel = 'SELL'; }
  if (isPartial)      { sideColor = '#a78bfa'; sideLabel = trade.side === 'PARTIAL1' ? 'P1' : 'P2'; }

  const asset = trade.id?.replace('USDT', '') || '?';
  const time  = trade.t || (trade.timestamp ? new Date(trade.timestamp).toLocaleTimeString('nl-NL') : '—');

  return (
    <div style={styles.row}>
      <span style={{ ...styles.side, color: sideColor }}>{sideLabel}</span>
      <span style={styles.asset}>{asset}</span>
      <span style={styles.price}>${_fmt(trade.price)}</span>
      {trade.pnl != null ? (
        <span style={{ ...styles.pnl, color: trade.pnl >= 0 ? '#22c55e' : '#f87171' }}>
          {trade.pnl >= 0 ? '+' : ''}${trade.pnl.toFixed(2)}
        </span>
      ) : (
        <span style={styles.reason}>{trade.reason?.slice(0, 18) || ''}</span>
      )}
      <span style={styles.time}>{time}</span>
    </div>
  );
}

function _fmt(n) {
  if (!n) return '0';
  if (n >= 1000) return n.toLocaleString('en-US', { maximumFractionDigits: 0 });
  if (n >= 1)    return n.toFixed(2);
  return n.toFixed(4);
}

const styles = {
  wrap: {
    background: '#0f172a', border: '1px solid #1e293b', borderRadius: 8,
    display: 'flex', flexDirection: 'column', overflow: 'hidden',
  },
  title: {
    color: '#475569', fontSize: 11, fontWeight: 700, letterSpacing: 1,
    padding: '10px 14px 6px', textTransform: 'uppercase', borderBottom: '1px solid #1e293b',
  },
  scroll: { overflowY: 'auto', maxHeight: 340, padding: '4px 0' },
  empty: { color: '#334155', fontSize: 12, padding: '16px', textAlign: 'center' },
  row: {
    display: 'flex', alignItems: 'center', gap: 8,
    padding: '5px 14px', fontSize: 11,
    borderBottom: '1px solid #0d1117',
  },
  side:   { width: 36, fontWeight: 700, flexShrink: 0 },
  asset:  { width: 32, color: '#94a3b8', fontWeight: 600, flexShrink: 0 },
  price:  { width: 72, color: '#64748b', fontVariantNumeric: 'tabular-nums', flexShrink: 0 },
  pnl:    { width: 64, fontWeight: 700, fontVariantNumeric: 'tabular-nums', flexShrink: 0 },
  reason: { color: '#475569', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  time:   { color: '#334155', marginLeft: 'auto', flexShrink: 0 },
};
