/**
 * 무한매수법 — 장 마감 체결 확인 & 사이클 동기화
 * GitHub Actions cron: 0 22 * * 1-5 (07:00 KST)
 *
 * 흐름:
 * 1. config 체크 (enabled?)
 * 2. KIS 토큰 → 체결내역 + 잔고 조회
 * 3. 종목별 사이클 state 동기화
 * 4. 사이클 완료 감지 → history 저장 + 텔레그램 알림
 * 5. 종가 ≥ 목표가인데 LIMIT 미체결 → MOO 예약매도
 * 6. 로그 & state commit
 */

import { KisApiClient } from './kisApi.js';
import { calculateDecreaseRate, calculateQuarterModeSeed } from './calculator.js';
import type { QuarterModeState } from './calculator.js';
import {
  readConfig, readCycleState, writeCycleState, appendLog, saveCycleHistory,
  type CycleState, type CycleHistory,
} from './stateManager.js';
import { notifyCycleCompleted, notifyError } from './telegram.js';
import { isUSMarketClosed, getETDateString, getETDateISO, nowISO, fmtUSD } from './utils.js';

interface Execution {
  ticker: string;
  side: 'BUY' | 'SELL';
  quantity: number;
  price: number;
  amount: number;
}

async function main() {
  const config = readConfig();
  if (!config.enabled) {
    console.log('[Close] Disabled. Exiting.');
    return;
  }

  if (isUSMarketClosed()) {
    console.log('[Close] US market closed. Skipping.');
    return;
  }

  const today = getETDateISO();
  const todayCompact = getETDateString();
  console.log(`[Close] Starting — ${today}`);

  const appKey = process.env.KIS_APP_KEY!;
  const appSecret = process.env.KIS_APP_SECRET!;
  const accountNo = process.env.KIS_ACCOUNT_NO!;

  if (!appKey || !appSecret || !accountNo) {
    await notifyError('환경변수', 'KIS credentials 미설정');
    throw new Error('Missing KIS credentials');
  }

  const kis = new KisApiClient();
  let accessToken: string;
  try {
    accessToken = await kis.getAccessToken(appKey, appSecret);
  } catch (err) {
    await notifyError('토큰 발급 (Close)', String(err));
    throw err;
  }

  // 당일 체결내역 조회
  let executions: Execution[] = [];
  try {
    const historyData = await kis.getOrderHistory(
      appKey, appSecret, accessToken, accountNo, todayCompact, '01'
    );
    if (historyData.output) {
      executions = historyData.output
        .filter(o => parseInt(o.ft_ccld_qty || '0') > 0)
        .map(o => ({
          ticker: o.pdno,
          side: o.sll_buy_dvsn_cd === '01' ? 'SELL' as const : 'BUY' as const,
          quantity: parseInt(o.ft_ccld_qty || '0'),
          price: parseFloat(o.ft_ccld_unpr3 || '0'),
          amount: parseFloat(o.ft_ccld_amt3 || '0'),
        }));
    }
    console.log(`[Close] ${executions.length} executions found`);
  } catch (err) {
    await notifyError('체결내역 조회', String(err));
    throw err;
  }

  await delay(300);

  // 현재 잔고 조회
  let balanceData;
  try {
    balanceData = await kis.getBalance(appKey, appSecret, accessToken, accountNo);
  } catch (err) {
    await notifyError('잔고 조회 (Close)', String(err));
    throw err;
  }
  const holdingsArray = Array.isArray(balanceData.output1) ? balanceData.output1 : [];

  // 종목별 동기화
  for (const ticker of config.tickers) {
    try {
      await syncTicker(
        ticker, config, kis, appKey, appSecret, accessToken, accountNo,
        executions, holdingsArray, today
      );
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error(`[Close] ${ticker} sync error:`, errorMsg);
      await notifyError(`${ticker} 동기화`, errorMsg);
      appendLog(today, {
        timestamp: nowISO(), ticker, action: 'ERROR',
        details: { phase: 'close', error: errorMsg },
      });
    }
  }

  console.log('[Close] Done.');
}

async function syncTicker(
  ticker: string,
  config: ReturnType<typeof readConfig>,
  kis: KisApiClient,
  appKey: string, appSecret: string, accessToken: string, accountNo: string,
  allExecutions: Execution[],
  holdingsArray: any[],
  today: string,
) {
  const cycleData = readCycleState(ticker);
  if (!cycleData || cycleData.status !== 'active') {
    console.log(`[Close] ${ticker}: No active cycle.`);
    return;
  }

  const tickerExecs = allExecutions.filter(e => e.ticker === ticker);
  const todayBuyAmt = tickerExecs.filter(e => e.side === 'BUY').reduce((s, e) => s + e.amount, 0);
  const todaySellAmt = tickerExecs.filter(e => e.side === 'SELL').reduce((s, e) => s + e.amount, 0);

  const newTotalBuy = (cycleData.totalBuyAmount || 0) + todayBuyAmt;
  const newTotalSell = (cycleData.totalSellAmount || 0) + todaySellAmt;
  const totalRealizedProfit = newTotalSell - newTotalBuy;

  // 현재 보유 상태 (KIS API 기준)
  const holdingData = holdingsArray.find((h: any) => h.ovrs_pdno === ticker);
  const totalQuantity = holdingData ? parseInt(holdingData.ovrs_cblc_qty || '0') : 0;
  const avgPrice = holdingData ? parseFloat(holdingData.pchs_avg_pric || '0') : 0;
  const totalInvested = totalQuantity * avgPrice;
  const currentPrice = holdingData ? parseFloat(holdingData.now_pric2 || '0') : 0;

  console.log(`[Close] ${ticker}: qty=${totalQuantity}, avg=${avgPrice}, todayBuy=${fmtUSD(todayBuyAmt)}, todaySell=${fmtUSD(todaySellAmt)}`);

  // 쿼터모드 상태 전환 (V2.2)
  const quarterMode = cycleData.quarterMode;
  if (quarterMode) {
    const hasSellExec = tickerExecs.some(e => e.side === 'SELL');
    const hasBuyExec = tickerExecs.some(e => e.side === 'BUY');

    if (!quarterMode.isActive && hasSellExec) {
      // MOC 매도 체결 → 쿼터모드 활성화 + 시드 재계산
      const newRemainingCash = cycleData.principal - totalInvested;
      const { quarterSeed, quarterBuyPerRound } = calculateQuarterModeSeed(
        newRemainingCash, quarterMode.originalBuyPerRound
      );
      const updatedState: CycleState = {
        ...cycleData,
        quarterMode: {
          ...quarterMode,
          isActive: true,
          quarterSeed,
          quarterBuyPerRound,
        },
        totalInvested, remainingCash: newRemainingCash,
        avgPrice, totalQuantity,
        totalBuyAmount: newTotalBuy, totalSellAmount: newTotalSell,
        totalRealizedProfit, updatedAt: nowISO(),
      };
      writeCycleState(ticker, updatedState);
      console.log(`[Close] ${ticker}: Quarter mode ACTIVATED, seed=${fmtUSD(quarterSeed)}, buyPerRound=${fmtUSD(quarterBuyPerRound)}`);
      appendLog(today, {
        timestamp: nowISO(), ticker, action: 'SYNC',
        details: { event: 'quarterModeActivated', totalQuantity, avgPrice, quarterSeed, quarterBuyPerRound },
      });
      return;
    }

    if (quarterMode.isActive && totalQuantity === 0 && hasSellExec) {
      // 쿼터모드 중 전량매도 → 쿼터모드 탈출, 원금 재계산
      const soldAmount = tickerExecs.filter(e => e.side === 'SELL').reduce((s, e) => s + e.amount, 0);
      const newPrincipal = (cycleData.remainingCash || 0) + soldAmount;
      const newBuyPerRound = newPrincipal / cycleData.splitCount;

      const updatedState: CycleState = {
        ...cycleData,
        principal: newPrincipal, buyPerRound: newBuyPerRound,
        remainingCash: newPrincipal, totalInvested: 0,
        totalQuantity: 0, avgPrice: 0,
        totalBuyAmount: newTotalBuy, totalSellAmount: newTotalSell,
        totalRealizedProfit, updatedAt: nowISO(),
      };
      // quarterMode 제거
      delete updatedState.quarterMode;
      writeCycleState(ticker, updatedState);

      console.log(`[Close] ${ticker}: Quarter mode EXITED, newPrincipal=${fmtUSD(newPrincipal)}`);
      appendLog(today, {
        timestamp: nowISO(), ticker, action: 'SYNC',
        details: { event: 'quarterModeExited', newPrincipal, newBuyPerRound },
      });
      return;
    }

    if (quarterMode.isActive && hasBuyExec) {
      // 쿼터모드 매수 체결 → round 증가
      const newRound = (quarterMode.round || 0) + 1;
      cycleData.quarterMode = { ...quarterMode, round: newRound };
      console.log(`[Close] ${ticker}: Quarter mode round ${quarterMode.round} → ${newRound}`);
    }
  }

  // 사이클 완료 감지
  if (cycleData.status === 'active' && totalQuantity === 0 && (cycleData.totalInvested || 0) > 0) {
    const history: CycleHistory = {
      ticker,
      cycleNumber: cycleData.cycleNumber,
      strategyVersion: cycleData.strategyVersion,
      splitCount: cycleData.splitCount,
      targetProfit: cycleData.targetProfit,
      starDecreaseRate: cycleData.starDecreaseRate,
      principal: cycleData.principal,
      buyPerRound: cycleData.buyPerRound,
      totalBuyAmount: newTotalBuy,
      totalSellAmount: newTotalSell,
      totalRealizedProfit,
      finalProfitRate: cycleData.principal > 0 ? totalRealizedProfit / cycleData.principal : 0,
      startedAt: cycleData.startedAt,
      completedAt: nowISO(),
    };
    saveCycleHistory(history);

    const completedState: CycleState = {
      ...cycleData,
      status: 'completed',
      totalQuantity: 0, avgPrice: 0, totalInvested: 0,
      remainingCash: cycleData.principal,
      totalBuyAmount: newTotalBuy, totalSellAmount: newTotalSell,
      totalRealizedProfit,
      completedAt: nowISO(), updatedAt: nowISO(),
    };
    delete completedState.quarterMode;
    writeCycleState(ticker, completedState);

    console.log(`[Close] ${ticker}: Cycle #${cycleData.cycleNumber} COMPLETED! profit=${fmtUSD(totalRealizedProfit)}`);
    await notifyCycleCompleted(
      ticker, cycleData.cycleNumber, totalRealizedProfit,
      history.finalProfitRate
    );
    appendLog(today, {
      timestamp: nowISO(), ticker, action: 'CYCLE_COMPLETE',
      details: {
        cycleNumber: cycleData.cycleNumber,
        principal: cycleData.principal,
        totalBuyAmount: newTotalBuy, totalSellAmount: newTotalSell,
        totalRealizedProfit, finalProfitRate: history.finalProfitRate,
      },
    });
    return;
  }

  // 일반 동기화
  const remainingCash = cycleData.principal - totalInvested;
  const updatedState: CycleState = {
    ...cycleData,
    totalInvested, remainingCash, avgPrice, totalQuantity,
    totalBuyAmount: newTotalBuy, totalSellAmount: newTotalSell,
    totalRealizedProfit, updatedAt: nowISO(),
  };
  writeCycleState(ticker, updatedState);

  appendLog(today, {
    timestamp: nowISO(), ticker, action: 'SYNC',
    details: {
      totalQuantity, avgPrice, totalInvested,
      remainingCash, todayBuyAmt, todaySellAmt,
      totalRealizedProfit,
    },
  });

  // MOO 매도 예약: 종가 ≥ 목표가이면 다음날 시가에 매도
  if (totalQuantity > 0 && currentPrice > 0) {
    const targetPrice = avgPrice * (1 + cycleData.targetProfit);
    if (currentPrice >= targetPrice) {
      // 목표가 이상인데 아직 보유 중 → MOO 예약매도 (전체 수량)
      try {
        console.log(`[Close] ${ticker}: Price ${fmtUSD(currentPrice)} >= target ${fmtUSD(targetPrice)}, submitting MOO reservation sell`);
        const result = await kis.submitReservationOrder(
          appKey, appSecret, accessToken, accountNo,
          { ticker, side: 'SELL', quantity: totalQuantity, orderType: 'MOO' }
        );
        const success = result.rt_cd === '0';
        console.log(`[Close] ${ticker}: MOO reservation → ${success ? 'OK' : 'FAIL'} ${result.msg1}`);
        if (!success) await notifyError(`${ticker} MOO 예약`, result.msg1);
        appendLog(today, {
          timestamp: nowISO(), ticker, action: 'MOO_RESERVATION',
          details: {
            currentPrice, targetPrice, quantity: totalQuantity,
            success, message: result.msg1,
          },
        });
      } catch (err) {
        console.error(`[Close] ${ticker}: MOO reservation error:`, err);
        await notifyError(`${ticker} MOO 예약 주문`, String(err));
      }
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

main().catch(async (err) => {
  console.error('[Close] Fatal error:', err);
  await notifyError('치명적 오류 (Close)', String(err));
  process.exit(1);
});
