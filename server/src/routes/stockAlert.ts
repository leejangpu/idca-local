/**
 * 종목 알리미 API 라우트
 */

import { Router } from 'express';
import * as localStore from '../lib/localStore';
import { getOrRefreshToken, KisApiClient } from '../lib/kisApi';
import { getEnabledAccounts } from '../lib/accountContext';
import type { StockAlert, StockMarket } from '../runners/stockAlert/stockAlertTypes';
import { COLLECTION } from '../runners/stockAlert/stockAlertTypes';

export const stockAlertRoutes = Router();
const kisClient = new KisApiClient();

function emptyAlertsSent() {
  return {
    buy2: null, buy3: null, rapid_drop: null, stop_loss: null,
    profit1: null, profit2: null, trailing_ma20: null, trailing_high: null,
  };
}

function roundPrice(price: number, market: StockMarket): number {
  return market === 'US' ? Math.round(price * 100) / 100 : Math.round(price);
}

function computeTriggers(alert: StockAlert) {
  const m = alert.market || 'KR';
  return {
    buy2Price: roundPrice(alert.initialBuyPrice * 0.97, m),
    buy3Price: roundPrice(alert.initialBuyPrice * 0.94, m),
    stopLossPrice: roundPrice(alert.initialBuyPrice * 0.92, m),
    profit1Price: alert.avgPrice > 0 ? roundPrice(alert.avgPrice * 1.10, m) : null,
    profit2Price: alert.avgPrice > 0 ? roundPrice(alert.avgPrice * 1.20, m) : null,
    trailingStopPrice: alert.highSinceEntry > 0 ? roundPrice(alert.highSinceEntry * 0.90, m) : null,
  };
}

// GET / — 전체 목록 (+ 계산된 trigger prices)
stockAlertRoutes.get('/', (_req, res) => {
  const allAlerts = localStore.getAllStates<StockAlert>(COLLECTION);
  const result: Array<StockAlert & { triggers: ReturnType<typeof computeTriggers> }> = [];

  for (const [, alert] of allAlerts) {
    result.push({ ...alert, triggers: computeTriggers(alert) });
  }

  // 최신순 정렬
  result.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  res.json(result);
});

// POST / — 등록
stockAlertRoutes.post('/', async (req, res) => {
  try {
    const { ticker, initialBuyPrice, initialBuyAmount, stockName, market: rawMarket } = req.body;
    const market: StockMarket = rawMarket === 'US' ? 'US' : 'KR';
    if (!ticker || !initialBuyPrice || !initialBuyAmount) {
      res.status(400).json({ error: 'ticker, initialBuyPrice, initialBuyAmount 필수' });
      return;
    }

    const now = new Date().toISOString();
    const alertId = market === 'US' ? `US:${ticker}` : ticker;

    // 중복 체크 (US 종목은 US: prefix로 저장)
    const existingById = localStore.getState<StockAlert>(COLLECTION, alertId);
    if (existingById) {
      res.status(409).json({ error: '이미 등록된 종목입니다' });
      return;
    }

    const alert: StockAlert = {
      id: alertId,
      ticker,
      stockName: stockName || ticker,
      market,
      type: 'holding',
      initialBuyPrice: Number(initialBuyPrice),
      initialBuyAmount: Number(initialBuyAmount),
      totalAmount: Number(initialBuyAmount) * 2,
      avgPrice: Number(initialBuyPrice),
      holdingQty: 0,
      buyPhase: 'buy1_done',
      sellPhase: 'none',
      highSinceEntry: Number(initialBuyPrice),
      lastCheckedPrice: 0,
      lastCheckedAt: '',
      ma20: null,
      alertsSent: emptyAlertsSent(),
      rapidDropDetected: false,
      active: true,
      createdAt: now,
      updatedAt: now,
    };

    localStore.setState(COLLECTION, alertId, alert);
    res.json({ ...alert, triggers: computeTriggers(alert) });
  } catch (err) {
    console.error('[StockAlert:Route] 등록 오류:', err);
    res.status(500).json({ error: String(err) });
  }
});

// PUT /:id — 상태 업데이트
stockAlertRoutes.put('/:id', (req, res) => {
  try {
    const { id } = req.params;
    const alert = localStore.getState<StockAlert>(COLLECTION, id);
    if (!alert) {
      res.status(404).json({ error: '종목을 찾을 수 없습니다' });
      return;
    }

    const allowed: (keyof StockAlert)[] = ['avgPrice', 'holdingQty', 'buyPhase', 'sellPhase', 'active'];
    for (const key of allowed) {
      if (req.body[key] !== undefined) {
        (alert as unknown as Record<string, unknown>)[key] = req.body[key];
      }
    }

    // sellPhase가 변경되면 트레일링 관련 알림 리셋
    if (req.body.sellPhase !== undefined) {
      alert.alertsSent.trailing_high = null;
      alert.alertsSent.trailing_ma20 = null;
    }

    // buyPhase가 변경되면 매수 알림 리셋
    if (req.body.buyPhase !== undefined) {
      if (req.body.buyPhase === 'buy1_done') {
        alert.alertsSent.buy2 = null;
        alert.alertsSent.buy3 = null;
      } else if (req.body.buyPhase === 'buy2_done') {
        alert.alertsSent.buy3 = null;
      }
    }

    localStore.setState(COLLECTION, id, alert);
    res.json({ ...alert, triggers: computeTriggers(alert) });
  } catch (err) {
    console.error('[StockAlert:Route] 업데이트 오류:', err);
    res.status(500).json({ error: String(err) });
  }
});

// DELETE /:id — 삭제
stockAlertRoutes.delete('/:id', (req, res) => {
  const { id } = req.params;
  localStore.deleteState(COLLECTION, id);
  res.json({ success: true });
});

// POST /lookup — 종목 조회
stockAlertRoutes.post('/lookup', async (req, res) => {
  try {
    const { ticker, market: rawMarket } = req.body;
    if (!ticker) { res.status(400).json({ error: 'ticker 필수' }); return; }
    const market: StockMarket = rawMarket === 'US' ? 'US' : 'KR';

    const accounts = getEnabledAccounts();
    if (accounts.length === 0) {
      res.status(500).json({ error: '활성 계정 없음' });
      return;
    }

    const ctx = accounts[0];
    const accessToken = await getOrRefreshToken(
      'default', ctx.accountId, ctx.credentials, ctx.kisClient, false, ctx.store
    );

    if (market === 'US') {
      // 해외주식 현재가 조회
      const quoteRes = await kisClient.getCurrentPrice(
        ctx.credentials.appKey, ctx.credentials.appSecret, accessToken, ticker
      );
      const currentPrice = Number(quoteRes.output?.last) || 0;
      const stockName = ticker.toUpperCase(); // 해외주식은 티커 자체를 이름으로

      res.json({ stockName, currentPrice, ticker: ticker.toUpperCase(), market });
    } else {
      // 국내주식 종목 정보 조회
      const infoRes = await kisClient.getDomesticStockInfo(
        ctx.credentials.appKey, ctx.credentials.appSecret, accessToken, ticker
      );
      const stockName = infoRes.output1?.hts_kor_isnm || '';

      // 현재가 조회
      const quoteRes = await kisClient.getDomesticCurrentPrice(
        ctx.credentials.appKey, ctx.credentials.appSecret, accessToken, ticker
      );
      const currentPrice = Number(quoteRes.output?.stck_prpr) || 0;

      res.json({ stockName, currentPrice, ticker, market });
    }
  } catch (err) {
    console.error('[StockAlert:Route] 조회 오류:', err);
    res.status(500).json({ error: String(err) });
  }
});
