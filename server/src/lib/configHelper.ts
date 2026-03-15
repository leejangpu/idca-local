/**
 * Config Helper — 로컬 JSON 기반 설정 접근 헬퍼
 * Firestore 대체: localStore 사용
 */

import * as localStore from './localStore';

// ==================== 타입 정의 ====================

export type AccountStrategy = 'infinite' | 'vr' | 'realtimeDdsobV2' | 'realtimeDdsobV2_1' | 'momentumScalp' | 'swing';
export type MarketType = 'domestic' | 'overseas';
export type DomesticStrategy = 'momentumScalp' | 'realtimeDdsobV2';
export type OverseasStrategy = 'infinite' | 'vr' | 'realtimeDdsobV2_1';

export const MARKET_STRATEGIES: Record<MarketType, readonly AccountStrategy[]> = {
  domestic: ['momentumScalp', 'realtimeDdsobV2', 'swing'] as const,
  overseas: ['infinite', 'vr', 'realtimeDdsobV2_1'] as const,
};

export interface MarketConfig {
  enabled: boolean;
  strategies?: AccountStrategy[];      // 멀티 전략 (신규)
  strategy?: DomesticStrategy | OverseasStrategy | null;  // 레거시 (하위 호환)
  swingEnabled?: boolean;              // 레거시 (하위 호환)
}

export interface CommonConfig {
  tradingEnabled: boolean;
  autoApprove: boolean;
  domestic: MarketConfig;
  overseas: MarketConfig;
  accountStrategy?: AccountStrategy;
  updatedAt: string;
}

// ==================== 시장별 헬퍼 함수 ====================

/** 마켓의 활성 전략 목록 반환 (레거시 호환) */
export function getActiveStrategies(config: CommonConfig, market: MarketType): AccountStrategy[] {
  const mc = config[market];
  if (!mc || !config.tradingEnabled || !mc.enabled) return [];

  // 신규: strategies 배열 사용
  if (mc.strategies && mc.strategies.length > 0) return mc.strategies;

  // 레거시: strategy 단일값 + swingEnabled
  const result: AccountStrategy[] = [];
  if (mc.strategy) result.push(mc.strategy as AccountStrategy);
  if (market === 'domestic' && mc.swingEnabled) {
    if (!result.includes('swing')) result.push('swing');
  }
  return result;
}

export function isMarketActive(config: CommonConfig, market: MarketType): boolean {
  return getActiveStrategies(config, market).length > 0;
}

export function isMarketStrategyActive(
  config: CommonConfig,
  market: MarketType,
  strategy: AccountStrategy
): boolean {
  return getActiveStrategies(config, market).includes(strategy);
}

// ==================== 설정 조회 (로컬 JSON) ====================

export function getCommonConfig(): CommonConfig | null {
  return localStore.getTradingConfig<CommonConfig>();
}

export function getMarketStrategyConfig<T>(market: MarketType, strategy: AccountStrategy): T | null {
  return localStore.getStrategyConfig<T>(market, strategy);
}

// ==================== 설정 저장 ====================

export function setCommonConfig(config: Partial<CommonConfig>): void {
  const existing = getCommonConfig();
  localStore.setTradingConfig({
    ...existing,
    ...config,
  });
}

export function setMarketStrategyConfig(
  market: MarketType,
  strategy: AccountStrategy,
  data: unknown
): void {
  localStore.setStrategyConfig(market, strategy, data);
}

// ==================== Account-Scoped 설정 조회/저장 ====================

export function getCommonConfigFor(accountId: string): CommonConfig | null {
  const store = localStore.forAccount(accountId);
  return store.getTradingConfig<CommonConfig>();
}

export function getMarketStrategyConfigFor<T>(accountId: string, market: MarketType, strategy: AccountStrategy): T | null {
  const store = localStore.forAccount(accountId);
  return store.getStrategyConfig<T>(market, strategy);
}

export function setCommonConfigFor(accountId: string, config: Partial<CommonConfig>): void {
  const store = localStore.forAccount(accountId);
  const existing = store.getTradingConfig<CommonConfig>();
  store.setTradingConfig({ ...existing, ...config });
}

export function setMarketStrategyConfigFor(accountId: string, market: MarketType, strategy: AccountStrategy, data: unknown): void {
  const store = localStore.forAccount(accountId);
  store.setStrategyConfig(market, strategy, data);
}
