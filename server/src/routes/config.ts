/**
 * 설정 CRUD API — 웹 UI용
 * localStore에서 JSON 파일 읽기/쓰기
 */

import { Router } from 'express';
import * as localStore from '../lib/localStore';
import { config } from '../config';
import { KisApiClient, getOrRefreshToken } from '../lib/kisApi';
import { getAllActiveTickers } from '../lib/activeTickerRegistry';

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

// 활성 종목 레지스트리 (전략 간 종목 충돌 확인)
configRoutes.get('/active-tickers', (_req, res) => {
  const tickers = getAllActiveTickers();
  const market = _req.query.market as string | undefined;
  const filtered = market ? tickers.filter(t => t.market === market) : tickers;
  res.json(filtered);
});

// HTS 조건검색 목록 조회 (KIS API) — 와일드카드 라우트보다 먼저 등록
configRoutes.get('/kis/condition-list', async (_req, res) => {
  try {
    const credentials = {
      appKey: config.kis.appKey,
      appSecret: config.kis.appSecret,
      accountNo: config.kis.accountNo,
    };
    const kisClient = new KisApiClient(config.kis.paperTrading);
    const accessToken = await getOrRefreshToken(config.userId, config.accountId, credentials, kisClient);
    const result = await kisClient.getConditionSearchList(
      credentials.appKey, credentials.appSecret, accessToken, config.kis.htsUserId,
    );
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// === Account-scoped config routes ===

// Full config for account
configRoutes.get('/account/:accountId', (req, res) => {
  const store = localStore.forAccount(req.params.accountId);
  const trading = store.getTradingConfig() ?? {};
  const strategies = {
    domestic: {
      momentumScalp: store.getStrategyConfig('domestic', 'momentumScalp'),
      realtimeDdsobV2: store.getStrategyConfig('domestic', 'realtimeDdsobV2'),
      swing: store.getStrategyConfig('domestic', 'swing'),
    },
    overseas: {
      infinite: store.getStrategyConfig('overseas', 'infinite'),
      vr: store.getStrategyConfig('overseas', 'vr'),
      realtimeDdsobV2: store.getStrategyConfig('overseas', 'realtimeDdsobV2'),
      realtimeDdsobV2_1: store.getStrategyConfig('overseas', 'realtimeDdsobV2_1'),
    },
  };
  res.json({ trading, strategies });
});

configRoutes.get('/account/:accountId/trading', (req, res) => {
  const store = localStore.forAccount(req.params.accountId);
  res.json(store.getTradingConfig() ?? {});
});

configRoutes.put('/account/:accountId/trading', (req, res) => {
  const store = localStore.forAccount(req.params.accountId);
  store.setTradingConfig(req.body);
  res.json({ success: true });
});

configRoutes.get('/account/:accountId/:market/:strategy', (req, res) => {
  const store = localStore.forAccount(req.params.accountId);
  res.json(store.getStrategyConfig(req.params.market, req.params.strategy) ?? {});
});

configRoutes.put('/account/:accountId/:market/:strategy', (req, res) => {
  const store = localStore.forAccount(req.params.accountId);
  store.setStrategyConfig(req.params.market, req.params.strategy, req.body);
  res.json({ success: true });
});

// Account-scoped KIS condition list
configRoutes.get('/account/:accountId/kis/condition-list', async (req, res) => {
  try {
    const store = localStore.forAccount(req.params.accountId);
    const creds = store.getCredentials<{ appKey: string; appSecret: string; accountNo: string; htsUserId: string; paperTrading?: boolean }>();
    if (!creds) { res.status(404).json({ error: 'credentials not found' }); return; }
    const kisClient = new KisApiClient(creds.paperTrading || false);
    const accessToken = await getOrRefreshToken('', req.params.accountId, { appKey: creds.appKey, appSecret: creds.appSecret }, kisClient);
    const result = await kisClient.getConditionSearchList(creds.appKey, creds.appSecret, accessToken, creds.htsUserId);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// Account-scoped active tickers
configRoutes.get('/account/:accountId/active-tickers', (req, res) => {
  // For now, use global active tickers (will be account-scoped later)
  const tickers = getAllActiveTickers();
  const market = req.query.market as string | undefined;
  const filtered = market ? tickers.filter(t => t.market === market) : tickers;
  res.json(filtered);
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
  const domesticSwing = localStore.getStrategyConfig('domestic', 'swing');
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
        swing: domesticSwing,
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
