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

/** 특정 collection의 활성 종목을 맵에 추가하는 헬퍼 */
function collectActive(
  map: Map<string, ActiveTickerEntry>,
  store: { getAllStates<T>(col: string): Map<string, T> },
  collection: string,
  strategy: string,
  marketOverride?: 'domestic' | 'overseas',
): void {
  const states = store.getAllStates<Record<string, unknown>>(collection);
  for (const [ticker, s] of states) {
    const status = String(s.status || '');
    if (collection === 'cycles' ? status !== 'completed' : isActive(status)) {
      const market = marketOverride ?? ((s.market as string) || getMarketFromTicker(ticker));
      map.set(ticker, { ticker, strategy, market: market as 'domestic' | 'overseas', status });
    }
  }
}

/** 모든 전략의 활성 종목을 수집 (글로벌 + 계좌별 store) */
function buildRegistry(): Map<string, ActiveTickerEntry> {
  const map = new Map<string, ActiveTickerEntry>();

  // 수집 대상 store 목록: 글로벌 + 각 계좌
  const stores: Array<{ getAllStates<T>(col: string): Map<string, T> }> = [localStore];
  const registry = localStore.getAccountRegistry();
  for (const account of registry.accounts) {
    stores.push(localStore.forAccount(account.id));
  }

  for (const store of stores) {
    collectActive(map, store, 'momentumScalpState', 'momentumScalp', 'domestic');
    collectActive(map, store, 'realtimeDdsobV2State', 'realtimeDdsobV2');
    collectActive(map, store, 'swingState', 'swing', 'domestic');
    collectActive(map, store, 'cycles', 'infinite', 'overseas');
    collectActive(map, store, 'vrState', 'vr', 'overseas');
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
