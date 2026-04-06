import { useState, useEffect, useRef, useCallback } from 'react';

// In production (Render) connect to same host via wss://, locally use ws://localhost:3001
const WS_URL = import.meta.env.VITE_WS_URL ||
  (location.hostname === 'localhost'
    ? 'ws://localhost:3001'
    : `wss://${location.hostname}`);
const RECONNECT_DELAY = 3000;

/**
 * useWebSocket — connects to the bot server and streams live state
 *
 * Returns:
 *   state    — latest engine state object (equity, positions, trades, stats, risk)
 *   status   — 'connecting' | 'connected' | 'disconnected'
 *   lastPing — timestamp of last message received
 */
export function useWebSocket() {
  const [state, setState]     = useState(null);
  const [prices, setPrices]   = useState({});
  const [status, setStatus]   = useState('connecting');
  const [lastPing, setLastPing] = useState(null);
  const wsRef     = useRef(null);
  const timerRef  = useRef(null);
  const unmounted = useRef(false);

  const connect = useCallback(() => {
    if (unmounted.current) return;

    const ws = new WebSocket(WS_URL);
    wsRef.current = ws;
    setStatus('connecting');

    ws.onopen = () => {
      if (unmounted.current) return;
      setStatus('connected');
      clearTimeout(timerRef.current);
    };

    ws.onmessage = (evt) => {
      if (unmounted.current) return;
      try {
        const msg = JSON.parse(evt.data);
        if (msg.type === 'state') {
          setState(msg.data);
          setLastPing(Date.now());
        }
        if (msg.type === 'prices') {
          setPrices(msg.data);
          setLastPing(Date.now());
        }
      } catch (_) {}
    };

    ws.onclose = () => {
      if (unmounted.current) return;
      setStatus('disconnected');
      timerRef.current = setTimeout(connect, RECONNECT_DELAY);
    };

    ws.onerror = () => {
      ws.close();
    };
  }, []);

  useEffect(() => {
    unmounted.current = false; // Reset on each mount (fixes React 18 StrictMode double-invoke)
    connect();
    return () => {
      unmounted.current = true;
      clearTimeout(timerRef.current);
      wsRef.current?.close();
    };
  }, [connect]);

  return { state, status, lastPing, prices };
}
