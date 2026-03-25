/**
 * 무한매수법 — 장 오픈 주문 제출
 * GitHub Actions cron: 0 15 * * 1-5 (00:00 KST)
 *
 * 흐름:
 * 1. config 체크 (enabled?)
 * 2. 휴장일 체크
 * 3. KIS 토큰 → 잔고/보유 조회
 * 4. 종목별 사이클 state 읽기
 * 5. 새 사이클 or 기존 사이클 주문 계산
 * 6. LOC 매수 + LOC 쿼터매도 + LIMIT 목표가 매도 제출
 * 7. state 업데이트 & 로그 기록
 */

import { KisApiClient } from './kisApi.js';
import { calculate, calculateDecreaseRate } from './calculator.js';
import type { StrategyVersion, QuarterModeState } from './calculator.js';
import { calculatePrincipal } from './principalCalculator.js';
import type { CycleStatus } from './principalCalculator.js';
import {
  readConfig, readCycleState, writeCycleState, appendLog, getNextCycleNumber,
  type CycleState, type LogEntry,
} from './stateManager.js';
import { notifyError } from './telegram.js';
import { isUSMarketClosed, getETDateISO, nowISO, fmtUSD } from './utils.js';

async function main() {
  // 1. Config
  const config = readConfig();
  if (!config.enabled) {
    console.log('[Open] Disabled. Exiting.');
    return;
  }

  // 2. 휴장일
  if (isUSMarketClosed()) {
    console.log('[Open] US market closed (holiday/weekend). Skipping.');
    return;
  }

  const today = getETDateISO();
  console.log(`[Open] Starting — ${today}`);

  // 3. KIS API
  const appKey = process.env.KIS_APP_KEY!;
  const appSecret = process.env.KIS_APP_SECRET!;
  const accountNo = process.env.KIS_ACCOUNT_NO!;

  if (!appKey || !appSecret || !accountNo) {
    await notifyError('환경변수', 'KIS_APP_KEY, KIS_APP_SECRET, KIS_ACCOUNT_NO 미설정');
    throw new Error('Missing KIS credentials');
  }

  const kis = new KisApiClient();
  let accessToken: string;
  try {
    accessToken = await kis.getAccessToken(appKey, appSecret);
    console.log('[Open] Token acquired');
  } catch (err) {
    await notifyError('토큰 발급', String(err));
    throw err;
  }

  // 4. 잔고 조회
  let accountCash = 0;
  let balanceData;
  try {
    balanceData = await kis.getBalance(appKey, appSecret, accessToken, accountNo);
    await delay(300);

    const buyableData = await kis.getBuyableAmount(
      appKey, appSecret, accessToken, accountNo, 'AAPL', 1, 'NASD'
    ).catch(() => null);

    if (buyableData?.rt_cd === '0' && buyableData.output) {
      accountCash = parseFloat(buyableData.output.ovrs_ord_psbl_amt || '0');
    } else {
      const holdingsArray = Array.isArray(balanceData.output1) ? balanceData.output1 : [];
      const totalEvalAmount = holdingsArray.reduce(
        (sum, h) => sum + parseFloat(h.ovrs_stck_evlu_amt || '0'), 0
      );
      const output2 = Array.isArray(balanceData.output2) ? balanceData.output2[0] : null;
      const totalAsset = parseFloat(output2?.tot_asst_amt || '0');
      accountCash = Math.max(0, totalAsset - totalEvalAmount);
    }
    console.log(`[Open] Account cash: ${fmtUSD(accountCash)}`);
  } catch (err) {
    await notifyError('잔고 조회', String(err));
    throw err;
  }

  const holdingsArray = Array.isArray(balanceData.output1) ? balanceData.output1 : [];
  const { tickers, tickerConfigs, strategyVersion } = config;

  // 5. 종목별 사이클 상태 조회
  const cycleStatusMap = new Map<string, {
    needsNewCycle: boolean;
    principal: number;
    nextPrincipal: number;
    holdingValue: number;
    cycleData: CycleState | null;
    totalQuantity: number;
    avgPrice: number;
  }>();

  for (const ticker of tickers) {
    const holdingData = holdingsArray.find(h => h.ovrs_pdno === ticker);
    const totalQuantity = holdingData ? parseInt(holdingData.ovrs_cblc_qty || '0') : 0;
    const avgPrice = holdingData ? parseFloat(holdingData.pchs_avg_pric || '0') : 0;
    const holdingValue = totalQuantity * avgPrice;
    const cycleData = readCycleState(ticker);

    const needsNewCycle = (totalQuantity === 0 && avgPrice === 0) &&
      (!cycleData || cycleData.status === 'completed');

    const nextPrincipal = cycleData
      ? (cycleData.principal || 0) + (cycleData.totalRealizedProfit || 0)
      : 0;

    console.log(`[Open] ${ticker}: qty=${totalQuantity}, avg=${avgPrice}, needsNew=${needsNewCycle}`);

    cycleStatusMap.set(ticker, {
      needsNewCycle, principal: cycleData?.principal || 0,
      nextPrincipal, holdingValue, cycleData, totalQuantity, avgPrice,
    });
  }

  // 6. 원금 계산 (principalCalculator)
  const cycleStatusForCalc = new Map<string, CycleStatus>();
  for (const ticker of tickers) {
    const status = cycleStatusMap.get(ticker)!;
    cycleStatusForCalc.set(ticker, {
      ticker,
      needsNewCycle: status.needsNewCycle,
      nextPrincipal: status.nextPrincipal,
      holdingValue: status.holdingValue,
      cycleData: status.cycleData ? {
        remainingCash: status.cycleData.remainingCash,
        principal: status.cycleData.principal,
      } : null,
    });
  }

  const principalResult = calculatePrincipal({
    accountCash, tickers, cycleStatusMap: cycleStatusForCalc,
  });

  console.log(`[Open] Principal calc: allocated=${fmtUSD(principalResult.totalAllocatedFunds)}, additional=${fmtUSD(principalResult.additionalDeposit)}`);

  // 7. 종목별 주문 처리
  for (const ticker of tickers) {
    try {
      await processTickerOrders(
        ticker, config, kis, appKey, appSecret, accessToken, accountNo,
        cycleStatusMap, principalResult, holdingsArray, today
      );
      await delay(500); // KIS API 속도제한
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error(`[Open] ${ticker} error:`, errorMsg);
      await notifyError(`${ticker} 주문 처리`, errorMsg);
      appendLog(today, {
        timestamp: nowISO(), ticker, action: 'ERROR',
        details: { phase: 'open', error: errorMsg },
      });
    }
  }

  console.log('[Open] Done.');
}

async function processTickerOrders(
  ticker: string,
  config: ReturnType<typeof readConfig>,
  kis: KisApiClient,
  appKey: string, appSecret: string, accessToken: string, accountNo: string,
  cycleStatusMap: Map<string, any>,
  principalResult: any,
  holdingsArray: any[],
  today: string,
) {
  const status = cycleStatusMap.get(ticker)!;
  const tickerConfig = config.tickerConfigs[ticker];
  const sv: StrategyVersion = config.strategyVersion as StrategyVersion;
  let { totalQuantity, avgPrice, cycleData } = status;

  const splitCount = tickerConfig.splitCount;
  const targetProfit = tickerConfig.targetProfit;
  const starDecreaseRate = calculateDecreaseRate(targetProfit, splitCount);

  // 새 사이클 시작
  if (status.needsNewCycle) {
    if (!config.autoRestart && cycleData?.status === 'completed') {
      console.log(`[Open] ${ticker}: autoRestart=false, skipping.`);
      appendLog(today, { timestamp: nowISO(), ticker, action: 'SKIP', details: { reason: 'autoRestart disabled' } });
      return;
    }

    const principal = principalResult.newCyclePrincipalMap.get(ticker) || (accountCashForTicker(principalResult, ticker));
    const buyPerRound = principal / splitCount;
    const cycleNumber = getNextCycleNumber(ticker);

    // 현재가 조회
    const currentPrice = await kis.getCurrentPrice(appKey, appSecret, accessToken, ticker);
    await delay(300);

    // 새 사이클 state 생성
    const newState: CycleState = {
      ticker, status: 'active', cycleNumber, strategyVersion: sv,
      splitCount, targetProfit, starDecreaseRate,
      principal, buyPerRound,
      totalQuantity: 0, avgPrice: 0,
      totalInvested: 0, remainingCash: principal,
      totalBuyAmount: 0, totalSellAmount: 0, totalRealizedProfit: 0,
      startedAt: nowISO(), updatedAt: nowISO(),
    };
    writeCycleState(ticker, newState);
    cycleData = newState;

    console.log(`[Open] ${ticker}: New cycle #${cycleNumber}, principal=${fmtUSD(principal)}, buyPerRound=${fmtUSD(buyPerRound)}`);
    appendLog(today, {
      timestamp: nowISO(), ticker, action: 'CYCLE_START',
      details: { cycleNumber, principal, buyPerRound, splitCount, targetProfit, strategyVersion: sv },
    });

    // 최초 매수: LOC +5%
    const locPrice = Math.round(currentPrice * 1.05 * 100) / 100;
    const quantity = Math.floor(buyPerRound / currentPrice);
    if (quantity <= 0) {
      console.log(`[Open] ${ticker}: quantity=0, skipping first buy.`);
      return;
    }

    console.log(`[Open] ${ticker}: First buy LOC @ ${locPrice} x ${quantity}`);
    const result = await kis.submitOrder(appKey, appSecret, accessToken, accountNo, {
      ticker, side: 'BUY', orderType: 'LOC', price: locPrice, quantity,
    });

    const success = result.rt_cd === '0';
    console.log(`[Open] ${ticker}: Order result: ${success ? 'OK' : 'FAIL'} - ${result.msg1}`);
    if (!success) {
      await notifyError(`${ticker} 최초매수`, result.msg1);
    }

    appendLog(today, {
      timestamp: nowISO(), ticker, action: 'ORDER_RESULT',
      details: {
        type: 'FIRST_BUY', side: 'BUY', orderType: 'LOC',
        price: locPrice, quantity, success, message: result.msg1,
        orderNo: result.output?.ODNO,
      },
    });
    return;
  }

  // 기존 사이클 계속
  if (!cycleData || cycleData.status !== 'active') {
    console.log(`[Open] ${ticker}: No active cycle.`);
    return;
  }

  // 현재가 조회
  const currentPrice = await kis.getCurrentPrice(appKey, appSecret, accessToken, ticker);
  await delay(300);

  const totalInvested = totalQuantity * avgPrice;
  const remainingCash = cycleData.principal - totalInvested;
  const quarterMode = cycleData.quarterMode as QuarterModeState | undefined;

  // 주문 계산
  const calcResult = calculate({
    ticker, currentPrice, totalQuantity, avgPrice,
    totalInvested, remainingCash,
    buyPerRound: cycleData.buyPerRound,
    splitCount: cycleData.splitCount,
    targetProfit: cycleData.targetProfit,
    starDecreaseRate: cycleData.starDecreaseRate,
    strategyVersion: sv,
    quarterMode,
  });

  console.log(`[Open] ${ticker}: T=${calcResult.tValue}, phase=${calcResult.phaseLabel}, star=${(calcResult.starPercent * 100).toFixed(2)}%`);
  console.log(`[Open] ${ticker}: buyOrders=${calcResult.buyOrders.length}, sellOrders=${calcResult.sellOrders.length}`);

  // 쿼터모드 진입 감지
  if (calcResult.quarterModeInfo?.shouldEnterQuarterMode && calcResult.quarterModeInfo.quarterModeState) {
    writeCycleState(ticker, {
      ...cycleData,
      quarterMode: { ...calcResult.quarterModeInfo.quarterModeState, isActive: false },
      updatedAt: nowISO(),
    });
    console.log(`[Open] ${ticker}: Quarter mode pending activation`);
  }

  // 매수 주문
  let buyOrders = calcResult.buyOrders.map(o => ({ ...o }));
  const sellOrders = calcResult.sellOrders.map(o => ({ ...o }));

  // 자전거래 방지: 매수/매도 가격 겹치면 매수 -0.01
  if (buyOrders.length > 0 && sellOrders.length > 0) {
    const sellPrices = new Set(sellOrders.map(o => o.price));
    for (const bo of buyOrders) {
      if (sellPrices.has(bo.price)) {
        bo.price = Math.round((bo.price - 0.01) * 100) / 100;
        bo.amount = Math.round(bo.price * bo.quantity * 100) / 100;
      }
    }
  }

  // 매수 주문 제출
  for (const order of buyOrders) {
    if (order.quantity <= 0) continue;
    try {
      const result = await kis.submitOrder(appKey, appSecret, accessToken, accountNo, {
        ticker, side: 'BUY', orderType: order.orderType as 'LOC' | 'LIMIT',
        price: order.price, quantity: order.quantity,
      });
      const success = result.rt_cd === '0';
      console.log(`[Open] ${ticker}: BUY ${order.label} → ${success ? 'OK' : 'FAIL'} ${result.msg1}`);
      if (!success) await notifyError(`${ticker} 매수`, `${order.label}: ${result.msg1}`);
      appendLog(today, {
        timestamp: nowISO(), ticker, action: 'ORDER_RESULT',
        details: {
          side: 'BUY', orderType: order.orderType, price: order.price,
          quantity: order.quantity, label: order.label, success, message: result.msg1,
          orderNo: result.output?.ODNO,
        },
      });
      await delay(500);
    } catch (err) {
      console.error(`[Open] ${ticker}: BUY order error:`, err);
      await notifyError(`${ticker} 매수 주문`, String(err));
    }
  }

  // 매도 주문 제출 (기존 포지션 있을 때만)
  if (totalQuantity > 0) {
    for (const order of sellOrders) {
      if (order.quantity <= 0) continue;
      try {
        const result = await kis.submitOrder(appKey, appSecret, accessToken, accountNo, {
          ticker, side: 'SELL', orderType: order.orderType as 'LOC' | 'LIMIT' | 'MOC',
          price: order.price, quantity: order.quantity,
        });
        const success = result.rt_cd === '0';
        console.log(`[Open] ${ticker}: SELL ${order.label} → ${success ? 'OK' : 'FAIL'} ${result.msg1}`);
        if (!success) await notifyError(`${ticker} 매도`, `${order.label}: ${result.msg1}`);
        appendLog(today, {
          timestamp: nowISO(), ticker, action: 'ORDER_RESULT',
          details: {
            side: 'SELL', orderType: order.orderType, price: order.price,
            quantity: order.quantity, label: order.label, success, message: result.msg1,
            orderNo: result.output?.ODNO,
          },
        });
        await delay(500);
      } catch (err) {
        console.error(`[Open] ${ticker}: SELL order error:`, err);
        await notifyError(`${ticker} 매도 주문`, String(err));
      }
    }
  }
}

function accountCashForTicker(principalResult: any, ticker: string): number {
  return principalResult.updatedAllocatedFunds.get(ticker) || 0;
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// 실행
main().catch(async (err) => {
  console.error('[Open] Fatal error:', err);
  await notifyError('치명적 오류 (Open)', String(err));
  process.exit(1);
});
