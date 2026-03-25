/**
 * 단타 v2 — 공개 API (re-export)
 */

export { startDantaWorker, stopDantaWorker, stopAllDantaWorkers, getDantaWorkerStatus } from './dantaScheduler';
export { getMarketDataProvider } from './dantaEngine';
export { createMarketDataProvider } from '../../lib/marketDataProvider';
export type { MarketDataProvider, TickData, MarketDataMode } from '../../lib/marketDataProvider';
export { getStatus as getRiskStatus } from './dantaRisk';
export type { DantaV2Config, DantaV2State } from './dantaTypes';
export { DEFAULT_DANTA_CONFIG } from './dantaTypes';
export { getSnapshot as getMetricsSnapshot, generateReport as generateMetricsReport } from './dantaMetrics';
