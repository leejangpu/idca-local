/**
 * 설정 CRUD API — 웹 UI용
 * localStore에서 JSON 파일 읽기/쓰기
 */

import { Router } from 'express';
import * as localStore from '../lib/localStore';

export const configRoutes = Router();

// 공통 설정 (trading.json)
configRoutes.get('/trading', (_req, res) => {
  const data = localStore.getTradingConfig();
  res.json(data ?? {});
});

configRoutes.put('/trading', (req, res) => {
  localStore.setTradingConfig(req.body);
  res.json({ success: true });
});

// 전략별 설정 (domestic/momentumScalp.json 등)
configRoutes.get('/:market/:strategy', (req, res) => {
  const { market, strategy } = req.params;
  const data = localStore.getStrategyConfig(market, strategy);
  res.json(data ?? {});
});

configRoutes.put('/:market/:strategy', (req, res) => {
  const { market, strategy } = req.params;
  localStore.setStrategyConfig(market, strategy, req.body);
  res.json({ success: true });
});

// 전체 설정 목록 (UI 로딩용)
configRoutes.get('/', (_req, res) => {
  const trading = localStore.getTradingConfig() ?? {};
  const domesticMomentumScalp = localStore.getStrategyConfig('domestic', 'momentumScalp');
  const domesticRealtimeDdsobV2 = localStore.getStrategyConfig('domestic', 'realtimeDdsobV2');
  const overseasInfinite = localStore.getStrategyConfig('overseas', 'infinite');
  const overseasVr = localStore.getStrategyConfig('overseas', 'vr');
  const overseasRealtimeDdsobV2 = localStore.getStrategyConfig('overseas', 'realtimeDdsobV2');
  const overseasRealtimeDdsobV2_1 = localStore.getStrategyConfig('overseas', 'realtimeDdsobV2_1');

  res.json({
    trading,
    strategies: {
      domestic: {
        momentumScalp: domesticMomentumScalp,
        realtimeDdsobV2: domesticRealtimeDdsobV2,
      },
      overseas: {
        infinite: overseasInfinite,
        vr: overseasVr,
        realtimeDdsobV2: overseasRealtimeDdsobV2,
        realtimeDdsobV2_1: overseasRealtimeDdsobV2_1,
      },
    },
  });
});
