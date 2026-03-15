/**
 * 장 마감 동기화 러너
 * 매일 장 마감 후 — KIS API로 체결/잔고 조회, 사이클 동기화, 텔레그램 알림
 *
 * 원본: idca-functions/src/functions/marketClose.ts
 * 변경: Firebase onSchedule → 단순 async 함수, Firestore → localStore, 단일 사용자
 */

import { config } from '../config';
import * as localStore from '../lib/localStore';
import { KisApiClient, getOrRefreshToken } from '../lib/kisApi';
import { sendTelegramMessage, getUserTelegramChatId } from '../lib/telegram';
import { generateBuyRecordId, BuyRecord } from '../lib/ddsobCalculator';
import { markFilledOrders } from '../lib/vrCalculator';
import { MarketType, getMarketType } from '../lib/marketUtils';
import { getCommonConfig, getMarketStrategyConfig } from '../lib/configHelper';

// --- 실사오팔V2 TickerConfig 타입 & 추출 (realtimeV2에서 인라인) ---

interface RealtimeDdsobV2TickerConfig {
  ticker: string;
  market?: MarketType;
  stockName?: string;
  principal: number;
  splitCount: number;
  profitPercent: number;
  forceSellCandles: number;
  intervalMinutes: number;
  autoSelected?: boolean;
  autoStopLoss?: boolean;
  stopLossPercent?: number;
  exhaustionStopLoss?: boolean;
  stopLossMultiplier?: number;
  forceLiquidateAtClose?: boolean;
  minDropPercent?: number;
  peakCheckCandles?: number;
  exchangeCode?: string;
  selectionMode?: string;
  conditionName?: string;
  ascendingSplit?: boolean;
}

function extractTickerConfigsV2(rdConfig: Record<string, any>): RealtimeDdsobV2TickerConfig[] {
  // 새 형식: tickers 배열
  if (Array.isArray(rdConfig.tickers)) {
    return rdConfig.tickers.map((t: RealtimeDdsobV2TickerConfig) => ({
      ...t,
      market: t.market || getMarketType(t.ticker),
    }));
  }
  // 구 형식: 단일 ticker
  if (typeof rdConfig.ticker === 'string') {
    const ticker = rdConfig.ticker;
    const market = getMarketType(ticker);
    return [{
      ticker,
      market,
      principal: market === 'domestic' ? 5000000 : 5000,
      splitCount: rdConfig.splitCount ?? 10,
      profitPercent: rdConfig.profitPercent ?? 0.01,
      forceSellCandles: rdConfig.forceSellCandles ?? 10,
      intervalMinutes: rdConfig.intervalMinutes ?? 15,
    }];
  }
  return [];
}

// --- 헬퍼 함수 ---

/** 계좌의 처리 대상 종목 결정 (전략 무관, market 매칭 기준) */
function getTickersForMarket(strategy: string, strategyConfig: any, market: MarketType): string[] {
  if (strategy === 'realtimeDdsobV2') {
    if (!strategyConfig) return [];
    const tickerConfigs = extractTickerConfigsV2(strategyConfig);
    return tickerConfigs.filter((t: any) => t.market === market).map((t: any) => t.ticker);
  }
  // infinite/VR/ddsob: tickers에서 market 매칭 필터
  const tickers: string[] = strategyConfig?.tickers || ['TQQQ', 'SOXL'];
  return tickers.filter(t => getMarketType(t) === market);
}

/** 금액 포맷 (overseas: $, domestic: ₩) */
function fmtAmt(market: MarketType, amount: number): string {
  return market === 'overseas'
    ? `$${amount.toFixed(2)}`
    : `₩${Math.round(amount).toLocaleString()}`;
}

/** notifyCycleCompleted 인라인 (원본 telegram.ts에서 가져옴) */
async function notifyCycleCompleted(
  chatId: string,
  ticker: string,
  cycleNumber: number,
  totalProfit: number
): Promise<boolean> {
  const emoji = totalProfit >= 0 ? '🎉' : '📉';
  const profitStr = totalProfit.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    signDisplay: 'always',
  });

  const message = `${emoji} <b>사이클 완료</b>

종목: <b>${ticker}</b>
사이클: #${cycleNumber}
실현수익: <b>${profitStr}</b>`;

  return sendTelegramMessage(chatId, message, 'HTML');
}

// --- 메인 처리 함수 ---

async function processMarketClose(market: MarketType) {
  const marketLabel = market === 'overseas' ? '미국' : '한국';
  console.log(`Market close trigger started (${marketLabel})`);

  try {
    const { userId, accountId } = config;
    const chatId = await getUserTelegramChatId(userId);

    const commonConfig = getCommonConfig();
    if (!commonConfig) {
      console.log('[MarketClose] No common config found, skipping');
      return;
    }
    if (!commonConfig.tradingEnabled) {
      console.log('[MarketClose] Trading disabled, skipping');
      return;
    }

    const marketConfig = commonConfig[market];
    const strategy = marketConfig?.strategy;
    if (!strategy) {
      console.log(`[MarketClose] No strategy for ${market}, skipping`);
      return;
    }
    const strategyConfig = getMarketStrategyConfig<any>(market, strategy);

    // 해당 market에 매칭되는 종목이 있는지 확인
    const tickersToProcess = getTickersForMarket(strategy, strategyConfig, market);
    const isRealtimeDdsob = strategy === 'realtimeDdsobV2';
    if (tickersToProcess.length === 0 && !isRealtimeDdsob) {
      console.log(`[MarketClose] No tickers for ${market}, skipping`);
      return;
    }

    interface AccountSummary {
      nickname: string;
      accountNo: string;
      strategy: string;
      strategyVersion?: string;
      splitCount?: number;
      executions: Array<{
        ticker: string;
        side: 'BUY' | 'SELL';
        quantity: number;
        price: number;
        amount: number;
      }>;
      holdings: Array<{
        ticker: string;
        quantity: number;
        avgPrice: number;
        currentPrice: number;
        profitRate: number;
      }>;
      ordersTotal: number;
      ordersSuccess: number;
      cashBalance?: number;
      nextBuyEstimates?: Array<{
        ticker: string;
        amount: number;
      }>;
      realtimeDdsobSummary?: {
        completedCycles: number;
        totalProfit: number;
        totalPrincipal: number;
        profitRate: number;
        tickerProfits: Array<{
          ticker: string;
          cycles: number;
          profit: number;
          principal: number;
        }>;
        activeCycles: Array<{
          ticker: string;
          buyRounds: number;
          splitCount: number;
          unrealizedPnl: number;
        }>;
      };
    }

    const accountSummary: AccountSummary = {
      nickname: '',
      accountNo: '',
      strategy: strategy,
      strategyVersion: strategyConfig?.strategyVersion,
      splitCount: strategyConfig?.splitCount,
      executions: [],
      holdings: [],
      ordersTotal: 0,
      ordersSuccess: 0,
    };

    const userExecutions: Array<{
      ticker: string;
      side: 'BUY' | 'SELL';
      quantity: number;
      price: number;
      amount: number;
    }> = [];

    // --- 사이클 데이터 동기화 (KIS API 실제 보유 정보 기반) ---
    try {
      const credentials = {
        appKey: config.kis.appKey,
        appSecret: config.kis.appSecret,
        accountNo: config.kis.accountNo,
      };

      accountSummary.nickname = '로컬계좌';
      accountSummary.accountNo = credentials.accountNo;

      const kisClient = new KisApiClient(config.kis.paperTrading);
      const accessToken = await getOrRefreshToken(userId, accountId, credentials, kisClient);

      // --- 잔고 조회 (market별 분기) ---
      let holdingsArray: any[];
      let balanceData: any;
      if (market === 'overseas') {
        balanceData = await kisClient.getBalance(
          credentials.appKey, credentials.appSecret, accessToken, credentials.accountNo
        );
        holdingsArray = Array.isArray(balanceData.output1) ? balanceData.output1 : [];
      } else {
        balanceData = await kisClient.getDomesticBalance(
          credentials.appKey, credentials.appSecret, accessToken, credentials.accountNo
        );
        holdingsArray = Array.isArray(balanceData.output1) ? balanceData.output1 : [];
      }

      // --- 오늘 체결 내역 조회 ---
      let todayExecutions: Array<{
        ticker: string;
        side: 'BUY' | 'SELL';
        quantity: number;
        price: number;
        amount: number;
      }> = [];
      const today = new Date();
      const todayStr = today.toISOString().slice(0, 10).replace(/-/g, '');

      try {
        if (market === 'overseas') {
          const execHistory = await kisClient.getOrderHistory(
            credentials.appKey, credentials.appSecret, accessToken,
            credentials.accountNo,
            todayStr, todayStr,
            '%',    // 전종목
            '00',   // 매도매수 전체
            '01'    // 체결건만
          );

          if (execHistory.output && execHistory.output.length > 0) {
            for (const exec of execHistory.output) {
              const filledQty = parseInt(exec.ft_ccld_qty || '0');
              if (filledQty > 0) {
                const execData = {
                  ticker: exec.pdno || '',
                  side: exec.sll_buy_dvsn_cd === '01' ? 'SELL' as const : 'BUY' as const,
                  quantity: filledQty,
                  price: parseFloat(exec.ft_ccld_unpr3 || '0'),
                  amount: parseFloat(exec.ft_ccld_amt3 || '0'),
                };
                todayExecutions.push(execData);
                userExecutions.push(execData);
                accountSummary.executions.push(execData);
              }
            }
          }
        } else {
          // domestic
          const execHistory = await kisClient.getDomesticOrderHistory(
            credentials.appKey, credentials.appSecret, accessToken,
            credentials.accountNo,
            todayStr, todayStr,
            '01',   // 체결건만
            '00'    // 매도매수 전체
          );

          if (execHistory.output1 && execHistory.output1.length > 0) {
            for (const exec of execHistory.output1) {
              const filledQty = parseInt(exec.tot_ccld_qty || '0');
              if (filledQty > 0) {
                const execData = {
                  ticker: exec.pdno || '',
                  side: exec.sll_buy_dvsn_cd === '01' ? 'SELL' as const : 'BUY' as const,
                  quantity: filledQty,
                  price: parseFloat(exec.avg_prvs || '0'),
                  amount: parseFloat(exec.tot_ccld_amt || '0'),
                };
                todayExecutions.push(execData);
                userExecutions.push(execData);
                accountSummary.executions.push(execData);
              }
            }
          }
        }
      } catch (execError) {
        console.error(`Execution history error:`, execError);
      }

      // --- 종목별 처리 ---
      for (const ticker of tickersToProcess) {
        // holdings 매칭 (market별 필드)
        let holdingData: any;
        let totalQuantity: number;
        let avgPrice: number;
        let currentPrice: number;

        if (market === 'overseas') {
          holdingData = holdingsArray.find((h: any) => h.ovrs_pdno === ticker);
          totalQuantity = holdingData ? parseInt(holdingData.ovrs_cblc_qty || '0') : 0;
          avgPrice = holdingData ? parseFloat(holdingData.pchs_avg_pric || '0') : 0;
          currentPrice = holdingData ? parseFloat(holdingData.now_pric2 || '0') : 0;
        } else {
          holdingData = holdingsArray.find((h: any) => h.pdno === ticker);
          totalQuantity = holdingData ? parseInt(holdingData.hldg_qty || '0') : 0;
          avgPrice = holdingData ? parseFloat(holdingData.pchs_avg_pric || '0') : 0;
          currentPrice = holdingData ? parseFloat(holdingData.prpr || '0') : 0;
        }

        const totalInvested = totalQuantity * avgPrice;

        // holdings 정보 저장 (보유 수량이 있는 경우만)
        if (totalQuantity > 0 && avgPrice > 0) {
          const profitRate = currentPrice > 0 ? (currentPrice - avgPrice) / avgPrice : 0;
          accountSummary.holdings.push({
            ticker,
            quantity: totalQuantity,
            avgPrice,
            currentPrice,
            profitRate,
          });
        }

        // --- 계좌 전략별 장 마감 동기화 ---
        if (strategy === 'vr') {
          // VR 계좌: vrState 동기화
          const vrState = localStore.getState<any>('vrState', ticker);
          if (vrState && holdingData) {
            const evaluation = totalQuantity * currentPrice;
            localStore.updateState('vrState', ticker, {
              lastQuantity: totalQuantity,
              lastAvgPrice: avgPrice,
              lastEvaluation: evaluation,
              syncedAt: new Date().toISOString(),
            });
            console.log(`[VRSync] ${ticker}: qty=${totalQuantity}, avgPrice=${fmtAmt(market, avgPrice)}, evaluation=${fmtAmt(market, evaluation)}`);
          }
        } else if (strategy === 'realtimeDdsobV2') {
          // 실사오팔V2: EOD 매도 미체결 잔여 확인 (안전망)
          const stateCollName = 'realtimeDdsobV2State';
          const allStates = localStore.getAllStates<any>(stateCollName);

          // EOD 매도 미체결 + forceStop 미체결 확인
          const pendingEodStates: Array<[string, any]> = [];
          const pendingForceStopStates: Array<[string, any]> = [];
          for (const [id, data] of allStates) {
            if (data.eodSellPending === true && (data.market || 'overseas') === market) {
              pendingEodStates.push([id, data]);
            }
            if (data.forceStopPending === true && (data.market || 'overseas') === market) {
              pendingForceStopStates.push([id, data]);
            }
          }

          if (pendingEodStates.length > 0 || pendingForceStopStates.length > 0) {
            const userChatId = await getUserTelegramChatId(userId);
            let alertMsg = '';

            if (pendingEodStates.length > 0) {
              const eodTickers = pendingEodStates.map(([id, d]) => d.stockName || id).join(', ');
              console.warn(`[RealtimeDdsob] EOD sell pending: ${eodTickers}`);
              alertMsg += `장마감 청산 미확인: ${eodTickers}\n`;
            }
            if (pendingForceStopStates.length > 0) {
              const fsTickers = pendingForceStopStates.map(([id, d]) => d.stockName || id).join(', ');
              console.warn(`[RealtimeDdsob] ForceStop pending: ${fsTickers}`);
              alertMsg += `전량매도 미체결: ${fsTickers}\n`;
            }

            if (userChatId) {
              await sendTelegramMessage(userChatId,
                `⚠️ <b>매도 미체결 알림</b>\n\n` +
                `${alertMsg}\n계좌 잔고를 확인해주세요.`,
                'HTML'
              );
            }
          } else {
            console.log(`[RealtimeDdsob] No pending sells (${market})`);
          }
        } else if ((strategy as string) === 'ddsob') {
          // 떨사오팔 계좌: ddsobState 동기화
          const ddsobState = localStore.getState<any>('ddsobState', ticker);

          if (ddsobState) {
            if (ddsobState.status !== 'active') continue;

            const tickerExecs = todayExecutions.filter(e => e.ticker === ticker);
            const buyExecs = tickerExecs.filter(e => e.side === 'BUY');
            const sellExecs = tickerExecs.filter(e => e.side === 'SELL');
            const hasBuy = buyExecs.length > 0;
            const hasSell = sellExecs.length > 0;

            const buyRecords: BuyRecord[] = ddsobState.buyRecords || [];
            const splitCount = ddsobState.splitCount || 10;
            let newMaxRounds = ddsobState.maxRounds ?? splitCount;
            const pendingForceSellCount = ddsobState.pendingForceSellCount || 0;
            let newTotalForceSellCount = ddsobState.totalForceSellCount || 0;
            let newTotalForceSellLoss = ddsobState.totalForceSellLoss || 0;

            // 매수 체결 → 새 BuyRecord 추가
            for (const exec of buyExecs) {
              buyRecords.push({
                id: generateBuyRecordId(),
                buyPrice: exec.price,
                quantity: exec.quantity,
                buyAmount: exec.amount,
                buyDate: new Date().toISOString().slice(0, 10),
              });
              console.log(`[DdsobSync] ${ticker}: BUY ${exec.quantity}주 @ ${fmtAmt(market, exec.price)}`);
            }

            // 매도 체결 → 대응 BuyRecord 제거 + 수익 계산
            let todaySellProfit = 0;
            let todayForceSellProfit = 0;
            const profitPercent = ddsobState.profitPercent || 0.01;
            const isForceSellDay = pendingForceSellCount > 0;
            let forceSellsExecuted = 0;

            for (const exec of sellExecs) {
              let matchIdx = -1;
              let bestMatch = Infinity;
              for (let i = 0; i < buyRecords.length; i++) {
                const expectedSellPrice = buyRecords[i].buyPrice * (1 + profitPercent);
                const diff = Math.abs(exec.price - expectedSellPrice);
                const diffFromBuy = Math.abs(exec.price - buyRecords[i].buyPrice);
                const minDiff = Math.min(diff, diffFromBuy);
                if (minDiff < bestMatch && buyRecords[i].quantity === exec.quantity) {
                  bestMatch = minDiff;
                  matchIdx = i;
                }
              }
              if (matchIdx === -1) {
                for (let i = 0; i < buyRecords.length; i++) {
                  const expectedSellPrice = buyRecords[i].buyPrice * (1 + profitPercent);
                  const diff = Math.abs(exec.price - expectedSellPrice);
                  const diffFromBuy = Math.abs(exec.price - buyRecords[i].buyPrice);
                  const minDiff = Math.min(diff, diffFromBuy);
                  if (minDiff < bestMatch) {
                    bestMatch = minDiff;
                    matchIdx = i;
                  }
                }
              }

              if (matchIdx >= 0) {
                const matched = buyRecords[matchIdx];
                const profit = exec.amount - matched.buyAmount;
                todaySellProfit += profit;

                if (isForceSellDay && forceSellsExecuted < pendingForceSellCount) {
                  forceSellsExecuted++;
                  todayForceSellProfit += profit;
                  console.log(`[DdsobSync] ${ticker}: FORCE_SELL ${exec.quantity}주 @ ${fmtAmt(market, exec.price)} (매수가 ${fmtAmt(market, matched.buyPrice)}, 손익 ${fmtAmt(market, profit)})`);
                } else {
                  console.log(`[DdsobSync] ${ticker}: SELL ${exec.quantity}주 @ ${fmtAmt(market, exec.price)} (매수가 ${fmtAmt(market, matched.buyPrice)}, 수익 ${fmtAmt(market, profit)})`);
                }
                buyRecords.splice(matchIdx, 1);
              } else {
                console.log(`[DdsobSync] ${ticker}: SELL ${exec.quantity}주 @ ${fmtAmt(market, exec.price)} - 매칭 매수기록 없음`);
              }
            }

            if (forceSellsExecuted > 0) {
              newMaxRounds -= forceSellsExecuted;
              newTotalForceSellCount += forceSellsExecuted;
              newTotalForceSellLoss += todayForceSellProfit;
              console.log(`[DdsobSync] ${ticker}: Force sell executed: ${forceSellsExecuted}건, maxRounds: ${newMaxRounds}/${splitCount}, forceSellLoss: ${fmtAmt(market, todayForceSellProfit)}`);
            }

            const currentDaysWithoutTrade = ddsobState.daysWithoutTrade || 0;
            let newDaysWithoutTrade: number;
            if (hasBuy || hasSell) {
              newDaysWithoutTrade = 0;
            } else if (buyRecords.length > 0) {
              newDaysWithoutTrade = currentDaysWithoutTrade + 1;
            } else {
              newDaysWithoutTrade = 0;
            }

            const newTotalBuyAmt = (ddsobState.totalBuyAmount || 0) + buyExecs.reduce((s, e) => s + e.amount, 0);
            const newTotalSellAmt = (ddsobState.totalSellAmount || 0) + sellExecs.reduce((s, e) => s + e.amount, 0);
            const newTotalProfit = (ddsobState.totalRealizedProfit || 0) + todaySellProfit;

            if (buyRecords.length === 0 && hasSell) {
              // 사이클 완료 → 히스토리 아카이브
              localStore.addCycleHistory({
                ticker,
                market,
                strategy: 'ddsob',
                cycleNumber: ddsobState.cycleNumber || 1,
                startedAt: ddsobState.startedAt,
                completedAt: new Date().toISOString(),
                principal: ddsobState.principal || 0,
                splitCount,
                profitPercent,
                amountPerRound: ddsobState.amountPerRound || 0,
                forceSellDays: ddsobState.forceSellDays || 0,
                totalBuyAmount: newTotalBuyAmt,
                totalSellAmount: newTotalSellAmt,
                totalRealizedProfit: newTotalProfit,
                finalProfitRate: (ddsobState.principal || 0) > 0
                  ? newTotalProfit / (ddsobState.principal || 1)
                  : 0,
                maxRoundsAtEnd: newMaxRounds,
                totalForceSellCount: newTotalForceSellCount,
                totalForceSellLoss: newTotalForceSellLoss,
              });

              localStore.updateState('ddsobState', ticker, {
                status: 'completed',
                buyRecords: [],
                daysWithoutTrade: 0,
                maxRounds: newMaxRounds,
                totalBuyAmount: newTotalBuyAmt,
                totalSellAmount: newTotalSellAmt,
                totalRealizedProfit: newTotalProfit,
                totalForceSellCount: newTotalForceSellCount,
                totalForceSellLoss: newTotalForceSellLoss,
                pendingForceSellCount: 0,
                completedAt: new Date().toISOString(),
                syncedAt: new Date().toISOString(),
              });

              console.log(`[DdsobSync] ${ticker}: Cycle completed! totalProfit=${fmtAmt(market, newTotalProfit)}, maxRounds=${newMaxRounds}/${splitCount}, forceSells=${newTotalForceSellCount}`);

              if (chatId) {
                const profitRate = (ddsobState.principal || 0) > 0
                  ? (newTotalProfit / (ddsobState.principal || 1) * 100).toFixed(2)
                  : '0.00';
                let completionMsg =
                  `🎯 <b>떨사오팔 사이클 완료</b>\n\n` +
                  `종목: <b>${ticker}</b>\n` +
                  `━━━━━━━━━━━━━━━\n` +
                  `투자원금: ${fmtAmt(market, ddsobState.principal || 0)}\n` +
                  `실현수익: <b>${fmtAmt(market, newTotalProfit)}</b> (${profitRate}%)\n` +
                  `총 매수: ${fmtAmt(market, newTotalBuyAmt)}\n` +
                  `총 매도: ${fmtAmt(market, newTotalSellAmt)}`;
                if (newTotalForceSellCount > 0) {
                  completionMsg += `\n━━━━━━━━━━━━━━━\n` +
                    `강제매도: ${newTotalForceSellCount}건 (${fmtAmt(market, newTotalForceSellLoss)})\n` +
                    `최종 max: ${newMaxRounds}/${splitCount}`;
                }
                await sendTelegramMessage(chatId, completionMsg, 'HTML');
              }
            } else {
              // 일반 동기화
              localStore.updateState('ddsobState', ticker, {
                buyRecords,
                daysWithoutTrade: newDaysWithoutTrade,
                maxRounds: newMaxRounds,
                totalBuyAmount: newTotalBuyAmt,
                totalSellAmount: newTotalSellAmt,
                totalRealizedProfit: newTotalProfit,
                totalForceSellCount: newTotalForceSellCount,
                totalForceSellLoss: newTotalForceSellLoss,
                pendingForceSellCount: 0,
                previousClose: currentPrice,
                syncedAt: new Date().toISOString(),
              });

              if (hasBuy || hasSell) {
                console.log(`[DdsobSync] ${ticker}: synced - buyRecords=${buyRecords.length}, maxRounds=${newMaxRounds}/${splitCount}, daysWithoutTrade=${newDaysWithoutTrade}, todayProfit=${fmtAmt(market, todaySellProfit)}`);
              }
            }
          }
        } else {
          // 무한매수법 계좌: 체결 내역 기반 수익 계산 + 사이클 완료 감지 및 동기화
          const cycleData = localStore.getState<any>('cycles', ticker);
          if (cycleData) {
            const principal = cycleData.principal || 0;

            if (!holdingData) {
              console.log(`[CycleSync] ${ticker}: holdingData not found in KIS API response (holdingsArray length=${holdingsArray.length}). Skipping cycle completion check and sync.`);
              continue;
            }

            const tickerExecs = todayExecutions.filter(e => e.ticker === ticker);
            const todayBuyAmt = tickerExecs.filter(e => e.side === 'BUY').reduce((s, e) => s + e.amount, 0);
            const todaySellAmt = tickerExecs.filter(e => e.side === 'SELL').reduce((s, e) => s + e.amount, 0);

            const newTotalBuy = (cycleData.totalBuyAmount || 0) + todayBuyAmt;
            const newTotalSell = (cycleData.totalSellAmount || 0) + todaySellAmt;
            const totalRealizedProfit = newTotalSell - newTotalBuy;

            if (todayBuyAmt > 0 || todaySellAmt > 0) {
              console.log(`[CycleSync] ${ticker}: todayBuy=${fmtAmt(market, todayBuyAmt)}, todaySell=${fmtAmt(market, todaySellAmt)}, totalBuy=${fmtAmt(market, newTotalBuy)}, totalSell=${fmtAmt(market, newTotalSell)}, totalRealizedProfit=${fmtAmt(market, totalRealizedProfit)}`);
            }

            // --- 쿼터모드 상태 전환 (체결 기반) ---
            const quarterMode = cycleData.quarterMode;
            if (quarterMode) {
              const tickerSells = tickerExecs.filter(e => e.side === 'SELL');
              const tickerBuys = tickerExecs.filter(e => e.side === 'BUY');
              const hasSellExec = tickerSells.length > 0;
              const hasBuyExec = tickerBuys.length > 0;

              if (!quarterMode.isActive && hasSellExec) {
                localStore.updateState('cycles', ticker, {
                  'quarterMode.isActive': true,
                  updatedAt: new Date().toISOString(),
                });
                console.log(`[QuarterMode] Activated for ${ticker}: MOC sell confirmed`);
                const remainingCash = principal - totalInvested;
                localStore.updateState('cycles', ticker, {
                  totalInvested, remainingCash, avgPrice, totalQuantity,
                  totalBuyAmount: newTotalBuy, totalSellAmount: newTotalSell,
                  totalRealizedProfit, syncedAt: new Date().toISOString(),
                });
                continue;
              }

              if (quarterMode.isActive && totalQuantity === 0 && hasSellExec) {
                const soldAmount = tickerSells.reduce((s, e) => s + e.amount, 0);
                const newPrincipal = (cycleData.remainingCash || 0) + soldAmount;
                const qSplitCount = cycleData.splitCount || 40;
                const newBuyPerRound = newPrincipal / qSplitCount;
                console.log(`[QuarterMode] Exiting for ${ticker}: sold=${fmtAmt(market, soldAmount)}, newPrincipal=${fmtAmt(market, newPrincipal)}`);
                // Read current state, remove quarterMode, update rest
                const currentState = localStore.getState<any>('cycles', ticker) || {};
                const { quarterMode: _qm, ...rest } = currentState;
                localStore.setState('cycles', ticker, {
                  ...rest,
                  principal: newPrincipal,
                  buyPerRound: newBuyPerRound,
                  remainingCash: newPrincipal,
                  totalInvested: 0,
                  totalQuantity: 0,
                  avgPrice: 0,
                  totalBuyAmount: newTotalBuy,
                  totalSellAmount: newTotalSell,
                  totalRealizedProfit,
                  updatedAt: new Date().toISOString(),
                });
                continue;
              }

              if (quarterMode.isActive && hasBuyExec) {
                const newRound = (quarterMode.round || 0) + 1;
                localStore.updateState('cycles', ticker, {
                  quarterMode: { ...quarterMode, round: newRound },
                  updatedAt: new Date().toISOString(),
                });
                console.log(`[QuarterMode] Round ${quarterMode.round || 0} -> ${newRound} for ${ticker}`);
              }
            }
            // --- 쿼터모드 처리 끝 ---

            // 사이클 완료 감지
            if (cycleData.status === 'active' && totalQuantity === 0 && cycleData.totalInvested > 0) {
              const historyData = {
                ticker,
                market,
                cycleNumber: cycleData.cycleNumber || 1,
                startedAt: cycleData.startedAt,
                completedAt: new Date().toISOString(),
                strategyVersion: cycleData.strategyVersion || 'v3.0',
                splitCount: cycleData.splitCount || 20,
                targetProfit: cycleData.targetProfit || 0.15,
                starDecreaseRate: cycleData.starDecreaseRate || 0.015,
                principal: cycleData.principal || 0,
                buyPerRound: cycleData.buyPerRound || 0,
                totalInvested: cycleData.totalInvested || 0,
                totalBuyAmount: newTotalBuy,
                totalSellAmount: newTotalSell,
                totalRealizedProfit,
                finalProfitRate: principal > 0 ? totalRealizedProfit / principal : 0,
              };
              localStore.addCycleHistory(historyData);

              // Remove quarterMode and update status
              const currentState = localStore.getState<any>('cycles', ticker) || {};
              const { quarterMode: _qm2, ...restState } = currentState;
              localStore.setState('cycles', ticker, {
                ...restState,
                status: 'completed',
                completedAt: new Date().toISOString(),
                totalQuantity: 0,
                avgPrice: 0,
                totalInvested: 0,
                remainingCash: principal,
              });

              console.log(`[CycleComplete] ${ticker}: Cycle #${cycleData.cycleNumber} completed naturally (all shares sold). totalRealizedProfit=${fmtAmt(market, totalRealizedProfit)}`);

              if (chatId) {
                await notifyCycleCompleted(
                  chatId,
                  ticker,
                  cycleData.cycleNumber || 1,
                  totalRealizedProfit
                );
              }
            } else {
              const remainingCash = principal - totalInvested;
              localStore.updateState('cycles', ticker, {
                totalInvested,
                remainingCash,
                avgPrice,
                totalQuantity,
                totalBuyAmount: newTotalBuy,
                totalSellAmount: newTotalSell,
                totalRealizedProfit,
                syncedAt: new Date().toISOString(),
              });

              console.log(`[CycleSync] ${ticker}: principal=${fmtAmt(market, principal)}, totalInvested=${fmtAmt(market, totalInvested)}, remainingCash=${fmtAmt(market, remainingCash)}, avgPrice=${fmtAmt(market, avgPrice)}, qty=${totalQuantity}`);
            }
          }
        }
      }

      // --- 오늘 주문 건수 조회 + VR 잔량주문 추적 + Trade Log + 사이클 요약 ---
      try {
        // 오늘 주문 건수 조회 (체결 + 미체결) - market별 분기
        let allOrdersOutput: any[];
        if (market === 'overseas') {
          const allOrderHistory = await kisClient.getOrderHistory(
            credentials.appKey, credentials.appSecret, accessToken,
            credentials.accountNo,
            todayStr, todayStr,
            '%',    // 전종목
            '00',   // 매도매수 전체
            '00'    // 전체 (체결+미체결)
          );
          allOrdersOutput = allOrderHistory.output || [];
        } else {
          const allOrderHistory = await kisClient.getDomesticOrderHistory(
            credentials.appKey, credentials.appSecret, accessToken,
            credentials.accountNo,
            todayStr, todayStr,
            '00',   // 전체 (체결+미체결)
            '00'    // 매도매수 전체
          );
          allOrdersOutput = allOrderHistory.output1 || [];
        }
        accountSummary.ordersTotal = allOrdersOutput.length;
        accountSummary.ordersSuccess = todayExecutions.length;

        // --- VR 잔량주문 체결 추적 ---
        if (strategy === 'vr' && todayExecutions.length > 0) {
          for (const vrTicker of tickersToProcess) {
            const vrState = localStore.getState<any>('vrState', vrTicker);

            if (vrState && vrState.pendingOrders) {
              const vrTickerExecutions = todayExecutions
                .filter(e => e.ticker === vrTicker)
                .map(e => ({
                  side: e.side === 'SELL' ? 'sell' as const : 'buy' as const,
                  price: e.price,
                  quantity: e.quantity,
                  executedAt: new Date(),
                }));

              if (vrTickerExecutions.length > 0) {
                const updatedOrders = markFilledOrders(vrState.pendingOrders, vrTickerExecutions);
                localStore.updateState('vrState', vrTicker, {
                  pendingOrders: updatedOrders,
                  updatedAt: new Date().toISOString(),
                });
                console.log(`[VR] Updated pending orders for ${vrTicker}: ${vrTickerExecutions.length} executions tracked`);
              }
            }
          }
        }
        // --- VR 잔량주문 체결 추적 끝 ---

        // --- 실사오팔/V2 Trade Log 저장 (market별 분리) ---
        if (strategy === 'realtimeDdsobV2') {
          try {
            const ordersKey = market === 'overseas' ? 'overseasOrders' : 'domesticOrders';
            const fetchedAtKey = market === 'overseas' ? 'fetchedAtUS' : 'fetchedAtKR';

            if (allOrdersOutput.length > 0) {
              // localStore: tradeLogs에 merge 방식으로 저장
              const existingLog = localStore.getLogs<any>('tradeLogs', todayStr);
              // tradeLogs는 단일 객체로 저장 (배열 append가 아닌 merge)
              const logEntry = {
                date: todayStr,
                strategy: strategy,
                [ordersKey]: allOrdersOutput,
                [fetchedAtKey]: new Date().toISOString(),
              };

              // 기존 로그가 있으면 merge, 없으면 새로 생성
              if (existingLog.length > 0 && typeof existingLog[0] === 'object') {
                const merged = { ...existingLog[0], ...logEntry };
                // 파일 직접 덮어쓰기 (appendLog 대신)
                localStore.writeJson(
                  localStore.paths.logFile('tradeLogs', todayStr),
                  [merged]
                );
              } else {
                localStore.appendLog('tradeLogs', todayStr, logEntry);
              }
              console.log(`[TradeLog] Saved ${allOrdersOutput.length} ${market} orders`);
            }
          } catch (logError) {
            console.error(`[TradeLog] Error saving trade log:`, logError);
          }
        }
        // --- 실사오팔/V2 Trade Log 저장 끝 ---

        // --- 실사오팔/V2 사이클 요약 조회 (장마감 메시지용) ---
        if (strategy === 'realtimeDdsobV2') {
          const strategyId = strategy;
          const stateCollName = 'realtimeDdsobV2State';
          try {
            // 오늘 완료된 사이클 조회 (market 필터)
            const todayDateStr = new Date().toISOString().slice(0, 10);
            const allCycleHistory = localStore.getAllCycleHistory<any>();
            const todayCompletedCycles = allCycleHistory.filter(c =>
              c.strategy === strategyId &&
              c.market === market &&
              c.completedAt && c.completedAt.startsWith(todayDateStr)
            );

            let totalProfit = 0;
            let totalPrincipal = 0;
            const tickerProfitMap = new Map<string, { cycles: number; profit: number; principal: number }>();
            for (const data of todayCompletedCycles) {
              const profit = data.totalRealizedProfit || 0;
              const princ = data.principal || 0;
              totalProfit += profit;
              totalPrincipal += princ;
              const t = data.ticker || 'unknown';
              const existing = tickerProfitMap.get(t) || { cycles: 0, profit: 0, principal: 0 };
              existing.cycles += 1;
              existing.profit += profit;
              existing.principal += princ;
              tickerProfitMap.set(t, existing);
            }
            const tickerProfits = Array.from(tickerProfitMap.entries()).map(([ticker, v]) => ({
              ticker, cycles: v.cycles, profit: v.profit, principal: v.principal,
            }));

            // 진행 중인 사이클 조회 (market 필터링)
            const allActiveStates = localStore.getAllStates<any>(stateCollName);
            const activeCycles: Array<{
              ticker: string;
              buyRounds: number;
              splitCount: number;
              unrealizedPnl: number;
            }> = [];
            for (const [docId, data] of allActiveStates) {
              // market 불일치 시 스킵
              if (getMarketType(docId) !== market) continue;

              if (data.status === 'active' && data.buyRecords?.length > 0) {
                const holding = accountSummary.holdings.find(h => h.ticker === docId);
                const unrealizedPnl = holding
                  ? (holding.currentPrice - holding.avgPrice) * holding.quantity
                  : 0;
                activeCycles.push({
                  ticker: docId,
                  buyRounds: data.buyRecords.length,
                  splitCount: data.splitCount || 0,
                  unrealizedPnl,
                });
              }
            }

            const profitRate = totalPrincipal > 0 ? (totalProfit / totalPrincipal * 100) : 0;

            accountSummary.realtimeDdsobSummary = {
              completedCycles: todayCompletedCycles.length,
              totalProfit,
              totalPrincipal,
              profitRate,
              tickerProfits,
              activeCycles,
            };
          } catch (summaryError) {
            console.error(`[${strategyId}] Cycle summary error:`, summaryError);
          }
        }
        // --- 실사오팔/V2 사이클 요약 조회 끝 ---
      } catch (orderError) {
        console.error(`Order history error:`, orderError);
      }
      // --- 주문 건수 조회 끝 ---

      // --- 예수금 잔액 체크 (무한매수법만, 다음 매수 충분성 확인) ---
      if (strategy === 'infinite') {
        try {
          await new Promise(resolve => setTimeout(resolve, 300));
          let cashBalance = 0;

          if (market === 'overseas') {
            const buyableData = await kisClient.getBuyableAmount(
              credentials.appKey, credentials.appSecret, accessToken,
              credentials.accountNo, 'TQQQ', 1, 'NASD'
            ).catch(() => null);

            if (buyableData?.rt_cd === '0' && buyableData.output) {
              cashBalance = parseFloat(buyableData.output.ovrs_ord_psbl_amt || buyableData.output.frcr_ord_psbl_amt1 || '0');
            }

            // fallback: balanceData에서 산출
            if (cashBalance <= 0) {
              const balOutput2 = Array.isArray(balanceData.output2) ? balanceData.output2[0] : null;
              const totalAsset = parseFloat(balOutput2?.tot_asst_amt || '0');
              const totalEvalAmount = holdingsArray.reduce(
                (sum: number, h: { ovrs_stck_evlu_amt?: string }) => sum + parseFloat(h.ovrs_stck_evlu_amt || '0'), 0
              );
              cashBalance = Math.max(0, totalAsset - totalEvalAmount);
            }
          } else {
            // domestic: getDomesticBuyableAmount 사용
            const balOutput2 = Array.isArray(balanceData.output2) ? balanceData.output2[0] : null;
            cashBalance = parseFloat(balOutput2?.dnca_tot_amt || '0');
          }

          accountSummary.cashBalance = cashBalance;

          // 각 ticker의 다음 매수 예상 금액
          const nextBuyEstimates: Array<{ ticker: string; amount: number }> = [];
          for (const t of tickersToProcess) {
            const cd = localStore.getState<any>('cycles', t);
            if (!cd) continue;

            if (cd.status === 'completed') {
              const estBuyPerRound = (cd.principal || 0) / (cd.splitCount || 20);
              if (estBuyPerRound > 0) {
                nextBuyEstimates.push({ ticker: t, amount: Math.round(estBuyPerRound * 100) / 100 });
              }
              continue;
            }

            if (cd.status !== 'active') continue;

            const qm = cd.quarterMode;
            if (qm?.isActive) {
              const qbpr = qm.quarterBuyPerRound || 0;
              if (qbpr > 0) {
                nextBuyEstimates.push({ ticker: t, amount: Math.round(qbpr * 100) / 100 });
              }
            } else {
              const bpr = cd.buyPerRound || 0;
              if (bpr > 0) {
                nextBuyEstimates.push({ ticker: t, amount: Math.round(bpr * 100) / 100 });
              }
            }
          }

          if (nextBuyEstimates.length > 0) {
            accountSummary.nextBuyEstimates = nextBuyEstimates;
          }
        } catch (balanceCheckError) {
          console.error(`Balance check error:`, balanceCheckError);
        }
      }
      // --- 예수금 잔액 체크 끝 ---
    } catch (syncError) {
      console.error(`Cycle sync error:`, syncError);
    }
    // --- 사이클 데이터 동기화 끝 ---

    // --- 장 마감 알림 ---
    if (chatId) {
      const marketEmoji = market === 'overseas' ? '🇺🇸' : '🇰🇷';
      let message = `🔔 <b>${marketEmoji} ${marketLabel} 장 마감</b>\n\n`;

      // 계좌 요약 정보 판별
      const totalNextBuy = (accountSummary.nextBuyEstimates || []).reduce((sum, e) => sum + e.amount, 0);
      const hasBalanceShortfall = accountSummary.cashBalance !== undefined && totalNextBuy > accountSummary.cashBalance;
      const hasCycleSummary = accountSummary.realtimeDdsobSummary &&
        (accountSummary.realtimeDdsobSummary.completedCycles > 0 || accountSummary.realtimeDdsobSummary.activeCycles.length > 0);
      const hasContent = accountSummary.executions.length > 0 || accountSummary.holdings.length > 0 || hasBalanceShortfall || hasCycleSummary;

      if (hasContent) {
        const acct = accountSummary;
        const maskedNo = '****' + acct.accountNo.slice(-4);
        message += `📌 <b>${acct.nickname}</b> (${maskedNo})\n`;

        // 전략 정보
        if (acct.strategy === 'vr') {
          message += `전략: <b>VR매매법</b>\n`;
        } else if (acct.strategy === 'ddsob') {
          message += `전략: <b>떨사오팔</b>\n`;
        } else if (acct.strategy === 'realtimeDdsobV2') {
          message += `전략: <b>실사오팔v2</b>\n`;
        } else {
          const splitLabel = acct.splitCount ? `${acct.splitCount}분할` : (acct.strategyVersion === 'v2.2' ? '40분할' : '20분할');
          const versionLabel = acct.strategyVersion === 'v2.2' ? `V2.2` : `V3.0`;
          message += `전략: <b>무한매수법 ${versionLabel}</b> (${splitLabel})\n`;
        }

        if (acct.ordersTotal > 0) {
          message += `주문: ${acct.ordersSuccess}/${acct.ordersTotal}건 체결\n`;
        }

        message += `━━━━━━━━━━━━━━━\n`;

        // 실사오팔: 사이클 요약 중심으로 표시
        if (acct.strategy === 'realtimeDdsobV2' && acct.realtimeDdsobSummary) {
          const summary = acct.realtimeDdsobSummary;

          if (summary.completedCycles > 0) {
            message += `🎯 <b>오늘 완료 사이클: ${summary.completedCycles}건</b>\n`;
            // 수익률 기준 내림차순 정렬
            const sortedProfits = [...summary.tickerProfits].sort((a, b) => {
              const rateA = a.principal > 0 ? (a.profit / a.principal) : 0;
              const rateB = b.principal > 0 ? (b.profit / b.principal) : 0;
              return rateB - rateA;
            });
            for (const tp of sortedProfits) {
              const sign = tp.profit >= 0 ? '+' : '';
              const rate = tp.principal > 0 ? (tp.profit / tp.principal * 100) : 0;
              message += `  ${tp.ticker}: ${tp.cycles}건 ${sign}${fmtAmt(market, tp.profit)} (${sign}${rate.toFixed(2)}%)\n`;
            }
            const totalSign = summary.totalProfit >= 0 ? '+' : '';
            const totalEmoji = summary.totalProfit >= 0 ? '📈' : '📉';
            message += `${totalEmoji} 총 실현수익: <b>${totalSign}${fmtAmt(market, summary.totalProfit)}</b> (${totalSign}${summary.profitRate.toFixed(2)}%)\n`;
          }

          if (summary.activeCycles.length > 0) {
            message += `\n🔄 <b>진행 중</b>\n`;
            for (const ac of summary.activeCycles) {
              const pnlSign = ac.unrealizedPnl >= 0 ? '+' : '';
              message += `${ac.ticker}: ${ac.buyRounds}/${ac.splitCount}회 (${pnlSign}${fmtAmt(market, ac.unrealizedPnl)})\n`;
            }
          }

          if (summary.completedCycles === 0 && summary.activeCycles.length === 0) {
            message += `오늘 완료된 사이클이 없습니다.\n`;
          }
        } else {
          // 기존 로직: 무한매수법, VR, 떨사오팔 등
          if (acct.holdings.length > 0) {
            message += `📊 <b>보유 현황</b>\n`;
            for (const h of acct.holdings) {
              const profitEmoji = h.profitRate >= 0 ? '📈' : '📉';
              const profitSign = h.profitRate >= 0 ? '+' : '';
              message += `${h.ticker}: ${h.quantity}주\n`;
              message += `   평단 ${fmtAmt(market, h.avgPrice)} → 현재 ${fmtAmt(market, h.currentPrice)}\n`;
              message += `   ${profitEmoji} <b>${profitSign}${(h.profitRate * 100).toFixed(2)}%</b>\n`;
            }
            message += `━━━━━━━━━━━━━━━\n`;
          }

          if (acct.executions.length > 0) {
            message += `📋 <b>오늘 체결</b>\n`;

            const tickerMap = new Map<string, { buys: typeof acct.executions, sells: typeof acct.executions }>();
            for (const exec of acct.executions) {
              if (!tickerMap.has(exec.ticker)) {
                tickerMap.set(exec.ticker, { buys: [], sells: [] });
              }
              const group = tickerMap.get(exec.ticker)!;
              if (exec.side === 'BUY') {
                group.buys.push(exec);
              } else {
                group.sells.push(exec);
              }
            }

            for (const [ticker, group] of tickerMap) {
              if (group.buys.length > 0) {
                const qty = group.buys.reduce((s, e) => s + e.quantity, 0);
                const amt = group.buys.reduce((s, e) => s + e.amount, 0);
                const avgP = amt / qty;
                message += `🔴 ${ticker} 매수: ${qty}주 × ${fmtAmt(market, avgP)} = <b>${fmtAmt(market, amt)}</b>\n`;
              }
              if (group.sells.length > 0) {
                const qty = group.sells.reduce((s, e) => s + e.quantity, 0);
                const amt = group.sells.reduce((s, e) => s + e.amount, 0);
                const avgP = amt / qty;
                message += `🟢 ${ticker} 매도: ${qty}주 × ${fmtAmt(market, avgP)} = <b>${fmtAmt(market, amt)}</b>\n`;
              }
            }
          }

          // 예수금 잔액 부족 경고
          if (acct.nextBuyEstimates && acct.nextBuyEstimates.length > 0 && acct.cashBalance !== undefined) {
            const acctTotalNextBuy = acct.nextBuyEstimates.reduce((sum, e) => sum + e.amount, 0);
            const shortfall = acctTotalNextBuy - acct.cashBalance;
            if (shortfall > 0) {
              message += `━━━━━━━━━━━━━━━\n`;
              message += `⚠️ <b>잔액부족</b>\n`;
              message += `   예수금: ${fmtAmt(market, acct.cashBalance)}\n`;
              message += `   내일 매수 예상: ~${fmtAmt(market, acctTotalNextBuy)}\n`;
              for (let ei = 0; ei < acct.nextBuyEstimates.length; ei++) {
                const est = acct.nextBuyEstimates[ei];
                const prefix = ei === acct.nextBuyEstimates.length - 1 ? '└' : '├';
                message += `   ${prefix} ${est.ticker}: ~${fmtAmt(market, est.amount)}\n`;
              }
              message += `   추가 필요: <b>${fmtAmt(market, shortfall)}</b>\n`;
            }
          }
        }

        message += `\n`;

        // 전체 합계
        const totalBuyAmount = userExecutions.filter(e => e.side === 'BUY').reduce((sum, e) => sum + e.amount, 0);
        const totalSellAmount = userExecutions.filter(e => e.side === 'SELL').reduce((sum, e) => sum + e.amount, 0);
        if (totalBuyAmount > 0 || totalSellAmount > 0) {
          message += `━━━━━━━━━━━━━━━\n`;
          message += `<b>📊 전체 합계</b>\n`;
          message += `총 매수: <b>${fmtAmt(market, totalBuyAmount)}</b>\n`;
          message += `총 매도: <b>${fmtAmt(market, totalSellAmount)}</b>`;
        }
      } else {
        message += `오늘 체결된 거래가 없습니다.`;
      }

      await sendTelegramMessage(chatId, message);
    }

    console.log(`Market close trigger completed (${marketLabel})`);
  } catch (error) {
    console.error(`Market close trigger error (${marketLabel}):`, error);
  }
}

// --- 내보내기 함수 ---

export async function runMarketCloseKR(): Promise<void> {
  await processMarketClose('domestic');
}

export async function runMarketCloseUS(): Promise<void> {
  await processMarketClose('overseas');
}
