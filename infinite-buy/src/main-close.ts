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
  console.log('========================================');
  console.log('[Close] 무한매수법 Market Close 시작');
  console.log('========================================');

  // Step 1. Config
  console.log('\n[Close] Step 1/6: Config 확인');
  const config = readConfig();
  console.log(`[Close]   enabled=${config.enabled}, tickers=[${config.tickers.join(', ')}]`);
  if (!config.enabled) {
    console.log('[Close]   → Disabled. Exiting.');
    return;
  }

  // Step 2. 휴장일
  console.log('\n[Close] Step 2/6: 휴장일 체크');
  if (isUSMarketClosed()) {
    console.log('[Close]   → US market closed. Skipping.');
    return;
  }

  const today = getETDateISO();
  const todayCompact = getETDateString();
  console.log(`[Close]   → 개장일 확인. ET date: ${today} (compact: ${todayCompact})`);

  // Step 3. KIS API 인증
  console.log('\n[Close] Step 3/6: KIS API 인증');
  const appKey = process.env.KIS_APP_KEY!;
  const appSecret = process.env.KIS_APP_SECRET!;
  const accountNo = process.env.KIS_ACCOUNT_NO!;

  if (!appKey || !appSecret || !accountNo) {
    console.error('[Close]   → KIS credentials 미설정!');
    await notifyError('환경변수', 'KIS credentials 미설정');
    throw new Error('Missing KIS credentials');
  }

  const kis = new KisApiClient();
  let accessToken: string;
  try {
    console.log('[Close]   토큰 발급 중...');
    accessToken = await kis.getAccessToken(appKey, appSecret);
    console.log('[Close]   → 토큰 발급 완료');
  } catch (err) {
    console.error('[Close]   → 토큰 발급 실패:', err);
    await notifyError('토큰 발급 (Close)', String(err));
    throw err;
  }

  // Step 4. 체결내역 조회
  console.log('\n[Close] Step 4/6: 당일 체결내역 조회');
  let executions: Execution[] = [];
  try {
    console.log('[Close]   체결내역 API 호출 중...');
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
    console.log(`[Close]   → 총 ${executions.length}건 체결`);
    for (const exec of executions) {
      console.log(`[Close]   - ${exec.ticker} ${exec.side} ${exec.quantity}주 @ ${fmtUSD(exec.price)} = ${fmtUSD(exec.amount)}`);
    }
  } catch (err) {
    console.error('[Close]   → 체결내역 조회 실패:', err);
    await notifyError('체결내역 조회', String(err));
    throw err;
  }

  await delay(300);

  // Step 5. 현재 잔고 조회
  console.log('\n[Close] Step 5/6: 현재 잔고 조회');
  let balanceData;
  try {
    console.log('[Close]   잔고 API 호출 중...');
    balanceData = await kis.getBalance(appKey, appSecret, accessToken, accountNo);
    console.log('[Close]   → 잔고 조회 완료');
  } catch (err) {
    console.error('[Close]   → 잔고 조회 실패:', err);
    await notifyError('잔고 조회 (Close)', String(err));
    throw err;
  }
  const holdingsArray = Array.isArray(balanceData.output1) ? balanceData.output1 : [];
  console.log(`[Close]   보유 종목 수: ${holdingsArray.length}`);
  for (const h of holdingsArray) {
    console.log(`[Close]   - ${h.ovrs_pdno}: qty=${h.ovrs_cblc_qty}, avg=${h.pchs_avg_pric}, now=${h.now_pric2}`);
  }

  // Step 6. 종목별 동기화
  console.log('\n[Close] Step 6/6: 종목별 동기화');
  for (const ticker of config.tickers) {
    console.log(`\n[Close] ── ${ticker} 동기화 시작 ──`);
    try {
      await syncTicker(
        ticker, config, kis, appKey, appSecret, accessToken, accountNo,
        executions, holdingsArray, today
      );
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error(`[Close]   ${ticker} 동기화 실패:`, errorMsg);
      await notifyError(`${ticker} 동기화`, errorMsg);
      appendLog(today, {
        timestamp: nowISO(), ticker, action: 'ERROR',
        details: { phase: 'close', error: errorMsg },
      });
    }
    console.log(`[Close] ── ${ticker} 동기화 완료 ──`);
  }

  console.log('\n========================================');
  console.log('[Close] 완료');
  console.log('========================================');
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
    console.log(`[Close]   활성 사이클 없음 (status=${cycleData?.status || 'null'})`);
    return;
  }

  console.log(`[Close]   사이클 #${cycleData.cycleNumber}, 원금: ${fmtUSD(cycleData.principal)}, buyPerRound: ${fmtUSD(cycleData.buyPerRound)}`);

  const tickerExecs = allExecutions.filter(e => e.ticker === ticker);
  const todayBuyAmt = tickerExecs.filter(e => e.side === 'BUY').reduce((s, e) => s + e.amount, 0);
  const todaySellAmt = tickerExecs.filter(e => e.side === 'SELL').reduce((s, e) => s + e.amount, 0);

  const newTotalBuy = (cycleData.totalBuyAmount || 0) + todayBuyAmt;
  const newTotalSell = (cycleData.totalSellAmount || 0) + todaySellAmt;
  const totalRealizedProfit = newTotalSell - newTotalBuy;

  console.log(`[Close]   당일 체결: 매수 ${fmtUSD(todayBuyAmt)}, 매도 ${fmtUSD(todaySellAmt)} (${tickerExecs.length}건)`);
  console.log(`[Close]   누적: 매수총액 ${fmtUSD(newTotalBuy)}, 매도총액 ${fmtUSD(newTotalSell)}, 손익 ${fmtUSD(totalRealizedProfit)}`);

  // 현재 보유 상태 (KIS API 기준)
  const holdingData = holdingsArray.find((h: any) => h.ovrs_pdno === ticker);
  const totalQuantity = holdingData ? parseInt(holdingData.ovrs_cblc_qty || '0') : 0;
  const avgPrice = holdingData ? parseFloat(holdingData.pchs_avg_pric || '0') : 0;
  const totalInvested = totalQuantity * avgPrice;
  const currentPrice = holdingData ? parseFloat(holdingData.now_pric2 || '0') : 0;

  console.log(`[Close]   KIS 잔고: qty=${totalQuantity}, avg=${fmtUSD(avgPrice)}, invested=${fmtUSD(totalInvested)}, 현재가=${fmtUSD(currentPrice)}`);

  // 쿼터모드 상태 전환 (V2.2)
  const quarterMode = cycleData.quarterMode;
  if (quarterMode) {
    const hasSellExec = tickerExecs.some(e => e.side === 'SELL');
    const hasBuyExec = tickerExecs.some(e => e.side === 'BUY');
    console.log(`[Close]   쿼터모드 상태: active=${quarterMode.isActive}, round=${quarterMode.round}, hasSell=${hasSellExec}, hasBuy=${hasBuyExec}`);

    if (!quarterMode.isActive && hasSellExec) {
      // MOC 매도 체결 → 쿼터모드 활성화 + 시드 재계산
      const newRemainingCash = cycleData.principal - totalInvested;
      const { quarterSeed, quarterBuyPerRound } = calculateQuarterModeSeed(
        newRemainingCash, quarterMode.originalBuyPerRound
      );
      console.log(`[Close]   → 쿼터모드 활성화: remainingCash=${fmtUSD(newRemainingCash)}, seed=${fmtUSD(quarterSeed)}, qBuyPerRound=${fmtUSD(quarterBuyPerRound)}`);

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

      console.log(`[Close]   → 쿼터모드 탈출! soldAmount=${fmtUSD(soldAmount)}, 새 원금=${fmtUSD(newPrincipal)}, 새 buyPerRound=${fmtUSD(newBuyPerRound)}`);

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
      console.log(`[Close]   → 쿼터모드 round ${quarterMode.round} → ${newRound}`);
    }
  }

  // 사이클 완료 감지
  if (cycleData.status === 'active' && totalQuantity === 0 && (cycleData.totalInvested || 0) > 0) {
    console.log(`[Close]   → 사이클 #${cycleData.cycleNumber} 완료 감지! (qty=0, 이전 invested>0)`);

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
    console.log(`[Close]   히스토리 저장 완료: 수익=${fmtUSD(totalRealizedProfit)} (${(history.finalProfitRate * 100).toFixed(2)}%)`);

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

    console.log(`[Close]   텔레그램 알림 전송 중...`);
    await notifyCycleCompleted(
      ticker, cycleData.cycleNumber, totalRealizedProfit,
      history.finalProfitRate
    );
    console.log(`[Close]   텔레그램 전송 완료`);

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
  console.log(`[Close]   state 동기화 완료: remainingCash=${fmtUSD(remainingCash)}`);

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
    console.log(`[Close]   MOO 체크: 현재가 ${fmtUSD(currentPrice)} vs 목표가 ${fmtUSD(targetPrice)}`);

    if (currentPrice >= targetPrice) {
      // 목표가 이상인데 아직 보유 중 → MOO 예약매도 (전체 수량)
      try {
        console.log(`[Close]   → 목표가 도달! MOO 예약매도 제출: ${totalQuantity}주`);
        const result = await kis.submitReservationOrder(
          appKey, appSecret, accessToken, accountNo,
          { ticker, side: 'SELL', quantity: totalQuantity, orderType: 'MOO' }
        );
        const success = result.rt_cd === '0';
        console.log(`[Close]   → MOO 예약 ${success ? '✓ 성공' : '✗ 실패'}: ${result.msg1}`);
        if (!success) await notifyError(`${ticker} MOO 예약`, result.msg1);
        appendLog(today, {
          timestamp: nowISO(), ticker, action: 'MOO_RESERVATION',
          details: {
            currentPrice, targetPrice, quantity: totalQuantity,
            success, message: result.msg1,
          },
        });
      } catch (err) {
        console.error(`[Close]   → MOO 예약 주문 에러:`, err);
        await notifyError(`${ticker} MOO 예약 주문`, String(err));
      }
    } else {
      console.log(`[Close]   → 목표가 미도달, MOO 스킵`);
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
