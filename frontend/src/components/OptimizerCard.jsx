import { useState, useEffect } from 'react';

const API = 'http://localhost:3001';

export function OptimizerCard() {
  const [history, setHistory]   = useState([]);
  const [running, setRunning]   = useState(false);
  const [lastResult, setResult] = useState(null);

  // Load optimizer history on mount
  useEffect(() => {
    fetch(`${API}/optimizer/history`)
      .then(r => r.json())
      .then(setHistory)
      .catch(() => {});
  }, []);

  async function triggerOptimize() {
    setRunning(true);
    setResult(null);
    try {
      const res = await fetch(`${API}/optimize`, { method: 'POST' });
      const data = await res.json();
      setResult(data);
      // Refresh history
      const h = await fetch(`${API}/optimizer/history`).then(r => r.json());
      setHistory(h);
    } catch (err) {
      setResult({ status: 'error', error: err.message });
    } finally {
      setRunning(false);
    }
  }

  const latest = history[0];

  return (
    <div style={s.card}>
      <div style={s.header}>
        <span style={s.title}>OPTIMIZER</span>
        <span style={s.subtitle}>Level 2 · Sundays 02:00 UTC</span>
      </div>

      {/* Last run summary */}
      {latest ? (
        <div style={s.latestRow}>
          <StatusBadge status={latest.status} />
          <span style={s.metaText}>
            {latest.baseline_avg !== null && `Base: ${latest.baseline_avg}/w`}
            {latest.new_avg !== null && ` → ${latest.new_avg}/w`}
            {latest.improvement_pct !== null && (
              <span style={{ color: '#22c55e', marginLeft: 6 }}>
                +{latest.improvement_pct}%
              </span>
            )}
          </span>
          <span style={s.dateText}>{formatDate(latest.timestamp)}</span>
        </div>
      ) : (
        <div style={s.noRuns}>No optimization runs yet</div>
      )}

      {/* Changes from last improvement */}
      {latest?.changes && Object.keys(latest.changes).length > 0 && (
        <div style={s.changes}>
          <div style={s.changesTitle}>Last changes:</div>
          {Object.entries(latest.changes).slice(0, 4).map(([key, val]) => (
            <div key={key} style={s.changeRow}>
              <span style={{ color: '#94a3b8' }}>{key}</span>
              <span style={{ color: '#f87171' }}>{String(val.from)}</span>
              <span style={{ color: '#64748b' }}>→</span>
              <span style={{ color: '#22c55e' }}>{String(val.to)}</span>
            </div>
          ))}
        </div>
      )}

      {/* Manual trigger */}
      <button
        style={{ ...s.btn, opacity: running ? 0.6 : 1 }}
        onClick={triggerOptimize}
        disabled={running}
      >
        {running ? 'Analysing...' : 'Run Now'}
      </button>

      {/* Inline result after manual run */}
      {lastResult && (
        <div style={s.resultBox}>
          <StatusBadge status={lastResult.status} />
          {lastResult.status === 'improved' && (
            <span style={{ color: '#22c55e', marginLeft: 6, fontSize: 11 }}>
              +${(lastResult.new?.avgPnl - lastResult.baseline?.avgPnl).toFixed(2)}/week
            </span>
          )}
          {lastResult.status === 'no_change' && (
            <span style={{ color: '#64748b', marginLeft: 6, fontSize: 11 }}>
              Current params already optimal
            </span>
          )}
          {lastResult.status === 'skipped' && (
            <span style={{ color: '#f59e0b', marginLeft: 6, fontSize: 11 }}>
              {lastResult.reason === 'insufficient_trades'
                ? `Need 20+ trades (have ${lastResult.count})`
                : lastResult.reason}
            </span>
          )}
          {lastResult.status === 'error' && (
            <span style={{ color: '#f87171', marginLeft: 6, fontSize: 11 }}>
              {lastResult.error}
            </span>
          )}
          {lastResult.elapsed && (
            <span style={{ color: '#475569', marginLeft: 6, fontSize: 10 }}>
              ({lastResult.elapsed}s)
            </span>
          )}
        </div>
      )}
    </div>
  );
}

function StatusBadge({ status }) {
  const colors = {
    improved:    '#22c55e',
    no_change:   '#64748b',
    skipped:     '#f59e0b',
    error:       '#f87171',
  };
  const labels = {
    improved:  'IMPROVED',
    no_change: 'NO CHANGE',
    skipped:   'SKIPPED',
    error:     'ERROR',
  };
  return (
    <span style={{
      ...s.badge,
      background: (colors[status] || '#475569') + '22',
      color: colors[status] || '#94a3b8',
      border: `1px solid ${colors[status] || '#475569'}44`,
    }}>
      {labels[status] || status.toUpperCase()}
    </span>
  );
}

function formatDate(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  return d.toLocaleDateString('nl-NL', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
}

const s = {
  card: {
    background: '#0f172a',
    border: '1px solid #1e293b',
    borderRadius: 10,
    padding: '14px 16px',
    display: 'flex',
    flexDirection: 'column',
    gap: 10,
    minWidth: 260,
  },
  header: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  title: {
    fontSize: 11,
    fontWeight: 700,
    letterSpacing: 2,
    color: '#a78bfa',
  },
  subtitle: {
    fontSize: 10,
    color: '#475569',
  },
  latestRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    flexWrap: 'wrap',
  },
  metaText: {
    fontSize: 12,
    color: '#94a3b8',
    flex: 1,
  },
  dateText: {
    fontSize: 10,
    color: '#475569',
  },
  noRuns: {
    fontSize: 11,
    color: '#475569',
    fontStyle: 'italic',
  },
  changes: {
    background: '#020817',
    borderRadius: 6,
    padding: '8px 10px',
    display: 'flex',
    flexDirection: 'column',
    gap: 4,
  },
  changesTitle: {
    fontSize: 10,
    color: '#475569',
    letterSpacing: 1,
    textTransform: 'uppercase',
    marginBottom: 2,
  },
  changeRow: {
    display: 'flex',
    gap: 6,
    fontSize: 11,
    alignItems: 'center',
    fontVariantNumeric: 'tabular-nums',
  },
  btn: {
    background: '#1e293b',
    border: '1px solid #334155',
    color: '#a78bfa',
    borderRadius: 6,
    padding: '7px 14px',
    fontSize: 11,
    fontWeight: 600,
    cursor: 'pointer',
    letterSpacing: 0.5,
    alignSelf: 'flex-start',
    transition: 'background 0.15s',
  },
  resultBox: {
    display: 'flex',
    alignItems: 'center',
    gap: 4,
    flexWrap: 'wrap',
  },
  badge: {
    fontSize: 10,
    fontWeight: 700,
    letterSpacing: 1,
    padding: '2px 7px',
    borderRadius: 4,
  },
};
