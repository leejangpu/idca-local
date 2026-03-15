/**
 * Active Ticker Registry — 전략 간 종목 중복 방지
 *
 * 모든 전략의 state를 읽어 현재 활성 종목 맵을 제공.
 * 다른 전략이 종목을 자동 선정/매수할 때 이미 점유된 종목을 필터링.
 */

import * as localStore from './localStore';

export interface ActiveTickerEntry {
  ticker: string;
  strategy: string;
  market: 'domestic' | 'overseas';
  status: string;
}

// 10초 TTL 캐시
let cache: Map<string, ActiveTickerEntry> | null = null;
let cacheTime = 0;
const CACHE_TTL = 10_000;

function isActive(status: string): boolean {
  return ['active', 'pending_buy', 'pending_sell', 'holding', 'trailing', 'ready'].includes(status);
}

function getMarketFromTicker(ticker: string): 'domestic' | 'overseas' {
  return /^[A-Z]/.test(ticker) ? 'overseas' : 'domestic';
}

/** 모든 전략의 활성 종목을 수집 */
function buildRegistry(): Map<string, ActiveTickerEntry> {
  const map = new Map<string, ActiveTickerEntry>();

  // momentumScalp (domestic)
  const scalpStates = localStore.getAllStates<Record<string, unknown>>('momentumScalpState');
  for (const [ticker, s] of scalpStates) {
    const status = String(s.status || '');
    if (isActive(status)) {
      map.set(ticker, { ticker, strategy: 'momentumScalp', market: 'domestic', status });
    }
  }

  // realtimeDdsobV2 (domestic + overseas)
  const rdStates = localStore.getAllStates<Record<string, unknown>>('realtimeDdsobV2State');
  for (const [ticker, s] of rdStates) {
    const status = String(s.status || '');
    if (isActive(status)) {
      const market = (s.market as string) || getMarketFromTicker(ticker);
      map.set(ticker, { ticker, strategy: 'realtimeDdsobV2', market: market as 'domestic' | 'overseas', status });
    }
  }

  // swing (domestic)
  const swingStates = localStore.getAllStates<Record<string, unknown>>('swingState');
  for (const [ticker, s] of swingStates) {
    const status = String(s.status || '');
    if (isActive(status)) {
      map.set(ticker, { ticker, strategy: 'swing', market: 'domestic', status });
    }
  }

  // infinite (overseas) — cycles
  const cycles = localStore.getAllStates<Record<string, unknown>>('cycles');
  for (const [ticker, s] of cycles) {
    const status = String(s.status || 'active');
    if (status !== 'completed') {
      map.set(ticker, { ticker, strategy: 'infinite', market: 'overseas', status });
    }
  }

  // vr (overseas)
  const vrStates = localStore.getAllStates<Record<string, unknown>>('vrState');
  for (const [ticker, s] of vrStates) {
    const status = String(s.status || 'active');
    if (isActive(status)) {
      map.set(ticker, { ticker, strategy: 'vr', market: 'overseas', status });
    }
  }

  return map;
}

function getRegistry(): Map<string, ActiveTickerEntry> {
  const now = Date.now();
  if (cache && now - cacheTime < CACHE_TTL) return cache;
  cache = buildRegistry();
  cacheTime = now;
  return cache;
}

/** 캐시 무효화 (state 변경 후 호출) */
export function invalidateCache(): void {
  cache = null;
}

/** 특정 시장에서 특정 전략을 제외한 점유 종목 Set */
export function getOccupiedTickersExcluding(market: 'domestic' | 'overseas', excludeStrategy: string): Set<string> {
  const registry = getRegistry();
  const result = new Set<string>();
  for (const [ticker, entry] of registry) {
    if (entry.market === market && entry.strategy !== excludeStrategy) {
      result.add(ticker);
    }
  }
  return result;
}

/** 특정 종목이 다른 전략에 의해 점유되었는지 확인 */
export function isTickerOccupied(ticker: string, excludeStrategy?: string): boolean {
  const registry = getRegistry();
  const entry = registry.get(ticker);
  if (!entry) return false;
  if (excludeStrategy && entry.strategy === excludeStrategy) return false;
  return true;
}

/** 전체 레지스트리 반환 (UI/디버그용) */
export function getAllActiveTickers(): ActiveTickerEntry[] {
  return Array.from(getRegistry().values());
}
