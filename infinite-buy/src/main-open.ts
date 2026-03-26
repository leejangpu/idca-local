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
  console.log('========================================');
  console.log('[Open] 무한매수법 Market Open 시작');
  console.log('========================================');

  // Step 1. Config
  console.log('\n[Open] Step 1/7: Config 확인');
  const config = readConfig();
  console.log(`[Open]   enabled=${config.enabled}, tickers=[${config.tickers.join(', ')}], strategy=${config.strategyVersion}`);
  console.log(`[Open]   autoRestart=${config.autoRestart}, equalSplit=${config.equalSplit}`);
  if (!config.enabled) {
    console.log('[Open]   → Disabled. Exiting.');
    return;
  }

  // Step 2. 휴장일
  console.log('\n[Open] Step 2/7: 휴장일 체크');
  if (isUSMarketClosed()) {
    console.log('[Open]   → US market closed (holiday/weekend). Skipping.');
    return;
  }

  const today = getETDateISO();
  console.log(`[Open]   → 개장일 확인. ET date: ${today}`);

  // Step 3. KIS API 인증 & 잔고 조회
  console.log('\n[Open] Step 3/7: KIS API 인증 & 잔고 조회');
  const appKey = process.env.KIS_APP_KEY!;
  const appSecret = process.env.KIS_APP_SECRET!;
  const accountNo = process.env.KIS_ACCOUNT_NO!;

  if (!appKey || !appSecret || !accountNo) {
    console.error('[Open]   → KIS credentials 미설정!');
    await notifyError('환경변수', 'KIS_APP_KEY, KIS_APP_SECRET, KIS_ACCOUNT_NO 미설정');
    throw new Error('Missing KIS credentials');
  }
  console.log(`[Open]   계좌번호: ${accountNo.replace(/(.{4})/, '****')}`);

  const kis = new KisApiClient();
  let accessToken: string;
  try {
    console.log('[Open]   토큰 발급 중...');
    accessToken = await kis.getAccessToken(appKey, appSecret);
    console.log('[Open]   → 토큰 발급 완료');
  } catch (err) {
    console.error('[Open]   → 토큰 발급 실패:', err);
    await notifyError('토큰 발급', String(err));
    throw err;
  }

  // Step 4. 잔고 조회
  console.log('\n[Open] Step 4/7: 잔고/보유 조회');
  let accountCash = 0;
  let balanceData;
  try {
    console.log('[Open]   잔고 API 호출 중...');
    balanceData = await kis.getBalance(appKey, appSecret, accessToken, accountNo);
    await delay(300);

    console.log('[Open]   매수가능금액 API 호출 중...');
    const buyableData = await kis.getBuyableAmount(
      appKey, appSecret, accessToken, accountNo, 'AAPL', 1, 'NASD'
    ).catch((err) => {
      console.log(`[Open]   매수가능금액 API 실패 (fallback 사용): ${err}`);
      return null;
    });

    if (buyableData?.rt_cd === '0' && buyableData.output) {
      accountCash = parseFloat(buyableData.output.ovrs_ord_psbl_amt || '0');
      console.log(`[Open]   → 매수가능금액 API 기준: ${fmtUSD(accountCash)}`);
    } else {
      const holdingsArray = Array.isArray(balanceData.output1) ? balanceData.output1 : [];
      const totalEvalAmount = holdingsArray.reduce(
        (sum, h) => sum + parseFloat(h.ovrs_stck_evlu_amt || '0'), 0
      );
      const output2 = Array.isArray(balanceData.output2) ? balanceData.output2[0] : null;
      const totalAsset = parseFloat(output2?.tot_asst_amt || '0');
      accountCash = Math.max(0, totalAsset - totalEvalAmount);
      console.log(`[Open]   → Fallback 계산: 총자산=${fmtUSD(totalAsset)}, 평가금=${fmtUSD(totalEvalAmount)}, 예수금=${fmtUSD(accountCash)}`);
    }
  } catch (err) {
    console.error('[Open]   → 잔고 조회 실패:', err);
    await notifyError('잔고 조회', String(err));
    throw err;
  }

  const holdingsArray = Array.isArray(balanceData.output1) ? balanceData.output1 : [];
  console.log(`[Open]   보유 종목 수: ${holdingsArray.length}`);
  for (const h of holdingsArray) {
    console.log(`[Open]   - ${h.ovrs_pdno}: qty=${h.ovrs_cblc_qty}, avg=${h.pchs_avg_pric}, eval=${h.ovrs_stck_evlu_amt}`);
  }

  const { tickers, tickerConfigs, strategyVersion } = config;

  // Step 5. 종목별 사이클 상태 조회
  console.log('\n[Open] Step 5/7: 종목별 사이클 상태 조회');
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

    console.log(`[Open]   ${ticker}: qty=${totalQuantity}, avg=${fmtUSD(avgPrice)}, holdingValue=${fmtUSD(holdingValue)}`);
    console.log(`[Open]   ${ticker}: cycleStatus=${cycleData?.status || 'none'}, needsNewCycle=${needsNewCycle}`);
    if (cycleData?.quarterMode) {
      const qm = cycleData.quarterMode;
      console.log(`[Open]   ${ticker}: quarterMode active=${qm.isActive}, round=${qm.round}, seed=${fmtUSD(qm.quarterSeed)}, buyPerRound=${fmtUSD(qm.quarterBuyPerRound)}`);
    }

    cycleStatusMap.set(ticker, {
      needsNewCycle, principal: cycleData?.principal || 0,
      nextPrincipal, holdingValue, cycleData, totalQuantity, avgPrice,
    });
  }

  // Step 6. 원금 계산
  console.log('\n[Open] Step 6/7: 원금 계산 (principalCalculator)');
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

  console.log(`[Open]   총 할당금: ${fmtUSD(principalResult.totalAllocatedFunds)}`);
  console.log(`[Open]   추가 입금 감지: ${fmtUSD(principalResult.additionalDeposit)}`);
  for (const ticker of tickers) {
    const newPrincipal = principalResult.newCyclePrincipalMap.get(ticker);
    const allocated = principalResult.updatedAllocatedFunds.get(ticker);
    console.log(`[Open]   ${ticker}: newCyclePrincipal=${fmtUSD(newPrincipal || 0)}, allocated=${fmtUSD(allocated || 0)}`);
  }

  // Step 7. 종목별 주문 처리
  console.log('\n[Open] Step 7/7: 종목별 주문 처리');
  for (const ticker of tickers) {
    console.log(`\n[Open] ── ${ticker} 주문 처리 시작 ──`);
    try {
      await processTickerOrders(
        ticker, config, kis, appKey, appSecret, accessToken, accountNo,
        cycleStatusMap, principalResult, holdingsArray, today
      );
      await delay(500); // KIS API 속도제한
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error(`[Open]   ${ticker} 주문 처리 실패:`, errorMsg);
      await notifyError(`${ticker} 주문 처리`, errorMsg);
      appendLog(today, {
        timestamp: nowISO(), ticker, action: 'ERROR',
        details: { phase: 'open', error: errorMsg },
      });
    }
    console.log(`[Open] ── ${ticker} 주문 처리 완료 ──`);
  }

  console.log('\n========================================');
  console.log('[Open] 완료');
  console.log('========================================');
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
  console.log(`[Open]   설정: split=${splitCount}, target=${(targetProfit * 100).toFixed(1)}%, decrease=${(starDecreaseRate * 100).toFixed(3)}%`);

  // 새 사이클 시작
  if (status.needsNewCycle) {
    if (!config.autoRestart && cycleData?.status === 'completed') {
      console.log(`[Open]   autoRestart=false → 스킵`);
      appendLog(today, { timestamp: nowISO(), ticker, action: 'SKIP', details: { reason: 'autoRestart disabled' } });
      return;
    }

    const principal = principalResult.newCyclePrincipalMap.get(ticker) || (accountCashForTicker(principalResult, ticker));
    const buyPerRound = principal / splitCount;
    const cycleNumber = getNextCycleNumber(ticker);

    console.log(`[Open]   → 새 사이클 시작 #${cycleNumber}`);
    console.log(`[Open]     원금: ${fmtUSD(principal)}, 1회매수금: ${fmtUSD(buyPerRound)}`);

    // 현재가 조회
    console.log(`[Open]     현재가 조회 중...`);
    const currentPrice = await kis.getCurrentPrice(appKey, appSecret, accessToken, ticker);
    console.log(`[Open]     현재가: ${fmtUSD(currentPrice)}`);
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
    console.log(`[Open]     state 저장 완료`);

    appendLog(today, {
      timestamp: nowISO(), ticker, action: 'CYCLE_START',
      details: { cycleNumber, principal, buyPerRound, splitCount, targetProfit, strategyVersion: sv },
    });

    // 최초 매수: LOC +5%
    const locPrice = Math.round(currentPrice * 1.05 * 100) / 100;
    const quantity = Math.floor(buyPerRound / currentPrice);
    if (quantity <= 0) {
      console.log(`[Open]     quantity=0 (buyPerRound=${fmtUSD(buyPerRound)}, price=${fmtUSD(currentPrice)}) → 스킵`);
      return;
    }

    console.log(`[Open]     최초 매수 주문: LOC @ ${fmtUSD(locPrice)} x ${quantity}주 = ${fmtUSD(locPrice * quantity)}`);
    const result = await kis.submitOrder(appKey, appSecret, accessToken, accountNo, {
      ticker, side: 'BUY', orderType: 'LOC', price: locPrice, quantity,
    });

    const success = result.rt_cd === '0';
    console.log(`[Open]     주문 결과: ${success ? '✓ 성공' : '✗ 실패'} — ${result.msg1}`);
    if (success) console.log(`[Open]     주문번호: ${result.output?.ODNO}`);
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
    console.log(`[Open]   → 활성 사이클 없음 (status=${cycleData?.status || 'null'})`);
    return;
  }

  console.log(`[Open]   → 기존 사이클 #${cycleData.cycleNumber} 계속`);
  console.log(`[Open]     원금: ${fmtUSD(cycleData.principal)}, 1회매수금: ${fmtUSD(cycleData.buyPerRound)}`);

  // 현재가 조회
  console.log(`[Open]     현재가 조회 중...`);
  const currentPrice = await kis.getCurrentPrice(appKey, appSecret, accessToken, ticker);
  console.log(`[Open]     현재가: ${fmtUSD(currentPrice)}`);
  await delay(300);

  const totalInvested = totalQuantity * avgPrice;
  const remainingCash = cycleData.principal - totalInvested;
  const quarterMode = cycleData.quarterMode as QuarterModeState | undefined;

  console.log(`[Open]     보유: ${totalQuantity}주 @ ${fmtUSD(avgPrice)}, 투자금: ${fmtUSD(totalInvested)}, 잔금: ${fmtUSD(remainingCash)}`);
  if (quarterMode) {
    console.log(`[Open]     쿼터모드: active=${quarterMode.isActive}, round=${quarterMode.round}, seed=${fmtUSD(quarterMode.quarterSeed)}, qBuyPerRound=${fmtUSD(quarterMode.quarterBuyPerRound)}`);
  }

  // 주문 계산
  console.log(`[Open]     주문 계산 중...`);
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

  console.log(`[Open]     T=${calcResult.tValue}, phase=${calcResult.phaseLabel}, star%=${(calcResult.starPercent * 100).toFixed(2)}%`);
  console.log(`[Open]     수익률: ${(calcResult.analysis.currentProfitRate * 100).toFixed(2)}%, 목표가: ${fmtUSD(calcResult.analysis.targetSellPrice)}, 거리: ${(calcResult.analysis.distanceToTarget * 100).toFixed(2)}%`);

  // 쿼터모드 진입 감지
  if (calcResult.quarterModeInfo?.shouldEnterQuarterMode && calcResult.quarterModeInfo.quarterModeState) {
    const qmState = calcResult.quarterModeInfo.quarterModeState;
    console.log(`[Open]     → 쿼터모드 진입 감지! reason=${calcResult.quarterModeInfo.reason}, seed=${fmtUSD(qmState.quarterSeed)}`);
    writeCycleState(ticker, {
      ...cycleData,
      quarterMode: { ...qmState, isActive: false },
      updatedAt: nowISO(),
    });
    console.log(`[Open]     쿼터모드 state 저장 (pending activation)`);
  }

  // 매수/매도 주문 생성
  let buyOrders = calcResult.buyOrders.map(o => ({ ...o }));
  const sellOrders = calcResult.sellOrders.map(o => ({ ...o }));

  console.log(`[Open]     매수 주문 ${buyOrders.length}건, 매도 주문 ${sellOrders.length}건`);

  // 자전거래 방지: 매수/매도 가격 겹치면 매수 -0.01
  if (buyOrders.length > 0 && sellOrders.length > 0) {
    const sellPrices = new Set(sellOrders.map(o => o.price));
    for (const bo of buyOrders) {
      if (sellPrices.has(bo.price)) {
        const oldPrice = bo.price;
        bo.price = Math.round((bo.price - 0.01) * 100) / 100;
        bo.amount = Math.round(bo.price * bo.quantity * 100) / 100;
        console.log(`[Open]     자전거래 방지: 매수가 ${fmtUSD(oldPrice)} → ${fmtUSD(bo.price)}`);
      }
    }
  }

  // 매수 주문 제출
  for (const order of buyOrders) {
    if (order.quantity <= 0) {
      console.log(`[Open]     매수 스킵 (qty=0): ${order.label}`);
      continue;
    }
    try {
      console.log(`[Open]     매수 제출: ${order.label} — ${order.orderType} @ ${fmtUSD(order.price)} x ${order.quantity}주`);
      const result = await kis.submitOrder(appKey, appSecret, accessToken, accountNo, {
        ticker, side: 'BUY', orderType: order.orderType as 'LOC' | 'LIMIT',
        price: order.price, quantity: order.quantity,
      });
      const success = result.rt_cd === '0';
      console.log(`[Open]     → ${success ? '✓ 성공' : '✗ 실패'} ${result.msg1}${success ? ` (주문번호: ${result.output?.ODNO})` : ''}`);
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
      console.error(`[Open]     매수 주문 에러:`, err);
      await notifyError(`${ticker} 매수 주문`, String(err));
    }
  }

  // 매도 주문 제출 (기존 포지션 있을 때만)
  if (totalQuantity > 0) {
    for (const order of sellOrders) {
      if (order.quantity <= 0) {
        console.log(`[Open]     매도 스킵 (qty=0): ${order.label}`);
        continue;
      }
      try {
        console.log(`[Open]     매도 제출: ${order.label} — ${order.orderType} @ ${order.price > 0 ? fmtUSD(order.price) : 'MARKET'} x ${order.quantity}주`);
        const result = await kis.submitOrder(appKey, appSecret, accessToken, accountNo, {
          ticker, side: 'SELL', orderType: order.orderType as 'LOC' | 'LIMIT' | 'MOC',
          price: order.price, quantity: order.quantity,
        });
        const success = result.rt_cd === '0';
        console.log(`[Open]     → ${success ? '✓ 성공' : '✗ 실패'} ${result.msg1}${success ? ` (주문번호: ${result.output?.ODNO})` : ''}`);
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
        console.error(`[Open]     매도 주문 에러:`, err);
        await notifyError(`${ticker} 매도 주문`, String(err));
      }
    }
  } else {
    console.log(`[Open]     보유 수량 0 → 매도 주문 스킵`);
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
