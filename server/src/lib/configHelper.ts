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
  domestic: ['momentumScalp', 'realtimeDdsobV2'] as const,
  overseas: ['infinite', 'vr', 'realtimeDdsobV2_1'] as const,
};

export interface MarketConfig {
  enabled: boolean;
  strategy: DomesticStrategy | OverseasStrategy | null;
  swingEnabled?: boolean;
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

export function isMarketActive(config: CommonConfig, market: MarketType): boolean {
  const mc = config[market];
  if (!mc) return false;
  return config.tradingEnabled && mc.enabled && mc.strategy !== null;
}

export function isMarketStrategyActive(
  config: CommonConfig,
  market: MarketType,
  strategy: AccountStrategy
): boolean {
  const mc = config[market];
  if (!mc) return false;
  return config.tradingEnabled && mc.enabled && mc.strategy === strategy;
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
