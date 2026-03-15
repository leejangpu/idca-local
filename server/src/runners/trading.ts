/**
 * 해외 매매 트리거 러너 — 로컬 버전
 * 원본: idca-functions/src/functions/trading.ts
 * 변경: Firebase onSchedule/onRequest → 단순 async 함수, Firestore → localStore
 *
 * 포함 함수:
 * - processVRTrading: VR 매매법 처리
 * - processDdsobTrading: 떨사오팔 매매 처리 (미사용, 복원 가능)
 * - processInfiniteSellOnly: 무한매수법 매도 전용 모드
 * - processDdsobSellOnly: 떨사오팔 매도 전용 모드
 * - processAccountTrading: 계좌별 매매 처리
 * - runDailyTrading: 메인 엔트리 포인트
 */

import { config } from '../config';
import * as localStore from '../lib/localStore';
import { calculate, StrategyVersion, QuarterModeState } from '../lib/calculator';
import {
  CycleStatus,
  calculatePrincipal,
} from '../lib/principalCalculator';
import { getUSMarketHolidayName, getTodayStart } from '../lib/usMarketHolidays';
import { KisApiClient, getOrRefreshToken } from '../lib/kisApi';
import {
  sendTelegramMessage,
  sendTelegramMessageWithId,
  getUserTelegramChatId,
} from '../lib/telegram';
import {
  createInitialVRState,
  calculateWeekNumber,
  calculatePoolUsageLimit,
  calculateBands,
  checkVUpdateNeeded,
  calculateNewTargetValue,
  initializeCycleOrders,
  needsOrderInitialization,
  pendingOrdersToVROrders,
  adjustOrdersForCurrentPrice,
  VRFormulaType,
} from '../lib/vrCalculator';
import {
  calculateDdsob,
  BuyRecord,
} from '../lib/ddsobCalculator';
import { getCommonConfig, getMarketStrategyConfig, isMarketActive, type CommonConfig } from '../lib/configHelper';

// ==================== 헬퍼: 타임스탬프 생성 ====================

function nowISO(): string {
  return new Date().toISOString();
}

// ==================== 헬퍼: 주문 저장 및 자동 실행 ====================

/**
 * pendingOrder를 localStore에 저장하고 ID를 반환.
 * autoApprove 모드에서는 상태를 approved로 설정.
 */
function createPendingOrder(order: Record<string, unknown>): string {
  const orderId = `ord_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const now = nowISO();
  const isApproved = order.status === 'approved';
  localStore.setPendingOrder(orderId, {
    ...order,
    createdAt: now,
    ...(isApproved && { approvedAt: now }),
  });
  return orderId;
}

function updatePendingOrder(orderId: string, update: Record<string, unknown>): void {
  const existing = localStore.getPendingOrder<Record<string, unknown>>(orderId);
  if (existing) {
    localStore.setPendingOrder(orderId, { ...existing, ...update });
  }
}

// ==================== VR 매매법 처리 ====================

async function processVRTrading(
  common: CommonConfig,
  options: { bypassRejection?: boolean } = {}
): Promise<void> {
  const { userId, accountId } = config;
  console.log(`[VR] Processing VR trading for user: ${userId}, account: ${accountId}`);

  const chatId = await getUserTelegramChatId(userId);

  // 자격증명: config에서 직접 읽기
  const credentials = {
    appKey: config.kis.appKey,
    appSecret: config.kis.appSecret,
    accountNo: config.kis.accountNo,
  };

  // 계좌 컨텍스트 생성 (텔레그램 메시지용)
  const accountContext = {
    nickname: accountId,
    accountNo: credentials.accountNo,
  };

  // KIS API 클라이언트 생성
  const kisClient = new KisApiClient(config.kis.paperTrading);

  // 액세스 토큰 가져오기
  let accessToken: string;
  try {
    accessToken = await getOrRefreshToken(userId, accountId, credentials, kisClient);
  } catch (err) {
    console.error(`[VR] Failed to get access token for user ${userId}:`, err);
    if (chatId) {
      await sendTelegramMessage(
        chatId,
        `❌ <b>API 토큰 발급 실패</b>\n\n` +
        `한국투자증권 API 키를 확인해주세요.\n` +
        `오류: ${err instanceof Error ? err.message : 'Unknown error'}`,
        'HTML'
      );
    }
    return;
  }

  // 잔고 조회
  let balanceData;
  let accountCash = 0;
  try {
    balanceData = await kisClient.getBalance(
      credentials.appKey,
      credentials.appSecret,
      accessToken,
      credentials.accountNo
    );

    await new Promise(resolve => setTimeout(resolve, 300));

    const buyableData = await kisClient.getBuyableAmount(
      credentials.appKey,
      credentials.appSecret,
      accessToken,
      credentials.accountNo,
      'TQQQ',
      1,
      'NASD'
    ).catch((err) => {
      console.log(`[VR] getBuyableAmount API failed: ${err instanceof Error ? err.message : 'Unknown'}`);
      return null;
    });

    if (balanceData.output1 && !Array.isArray(balanceData.output1)) {
      balanceData.output1 = [];
    }

    // 디버깅: buyableData 응답 출력
    console.log(`[VR] buyableData response: rt_cd=${buyableData?.rt_cd}, msg=${buyableData?.msg1}`);
    if (buyableData?.output) {
      console.log(`[VR] buyableData.output: ovrs_ord_psbl_amt=${buyableData.output.ovrs_ord_psbl_amt}, frcr_ord_psbl_amt1=${buyableData.output.frcr_ord_psbl_amt1}`);
    }

    if (buyableData?.rt_cd === '0' && buyableData.output) {
      accountCash = parseFloat(buyableData.output.ovrs_ord_psbl_amt || buyableData.output.frcr_ord_psbl_amt1 || '0');
    }

    // buyableData가 실패하거나 0이면 fallback 계산
    if (accountCash <= 0) {
      const holdingsArray = Array.isArray(balanceData.output1) ? balanceData.output1 : [];
      const totalEvalAmount = holdingsArray.reduce(
        (sum, h) => sum + parseFloat(h.ovrs_stck_evlu_amt || '0'),
        0
      );
      const output2 = Array.isArray(balanceData.output2) ? balanceData.output2[0] : null;
      const totalAsset = parseFloat(output2?.tot_asst_amt || '0');

      console.log(`[VR] Fallback calculation: totalAsset=${totalAsset}, totalEvalAmount=${totalEvalAmount}`);
      console.log(`[VR] output2 raw: ${JSON.stringify(output2)}`);

      accountCash = Math.max(0, totalAsset - totalEvalAmount);
    }
    console.log(`[VR] Account cash for user ${userId}: $${accountCash.toFixed(2)}`);
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : 'Unknown error';
    console.error(`[VR] Failed to get balance for user ${userId}:`, err);
    if (chatId) {
      await sendTelegramMessage(
        chatId,
        `❌ <b>잔고 조회 실패</b>\n\n오류: ${errorMsg}`,
        'HTML'
      );
    }
    return;
  }

  // VR은 TQQQ만 지원
  const ticker = 'TQQQ';
  const holdingsArray = Array.isArray(balanceData.output1) ? balanceData.output1 : [];
  const holdingData = holdingsArray.find((h) => h.ovrs_pdno === ticker);
  const totalQuantity = holdingData ? parseInt(holdingData.ovrs_cblc_qty || '0') : 0;
  const avgPrice = holdingData ? parseFloat(holdingData.pchs_avg_pric || '0') : 0;

  // 현재가 조회
  let currentPrice: number;
  try {
    await new Promise(resolve => setTimeout(resolve, 300));
    const priceData = await kisClient.getCurrentPrice(
      credentials.appKey,
      credentials.appSecret,
      accessToken,
      ticker,
      'NAS'
    );
    currentPrice = parseFloat(priceData.output?.last || '0');
  } catch (err) {
    console.error(`[VR] Failed to get current price for ${ticker}:`, err);
    if (chatId) {
      await sendTelegramMessage(chatId, `❌ <b>${ticker} 현재가 조회 실패</b>`, 'HTML');
    }
    return;
  }

  if (currentPrice <= 0) {
    console.log(`[VR] Invalid current price for ${ticker}: ${currentPrice}`);
    return;
  }

  // VR 설정 조회 (시장별 경로)
  const vrConfig = getMarketStrategyConfig<Record<string, any>>('overseas', 'vr');

  if (!vrConfig?.enabled) {
    console.log(`[VR] VR not enabled for user ${userId}, account ${accountId}, vrConfig=${JSON.stringify(vrConfig)}`);
    return;
  }

  console.log(`[VR] ========== VR Trading Debug ==========`);
  console.log(`[VR] User: ${userId}, Account: ${accountId}`);
  console.log(`[VR] vrConfig: ${JSON.stringify(vrConfig)}`);
  console.log(`[VR] totalQuantity: ${totalQuantity}, avgPrice: ${avgPrice}`);
  console.log(`[VR] currentPrice: ${currentPrice}, accountCash (Pool): ${accountCash}`);
  console.log(`[VR] autoApprove: ${common.autoApprove}`);

  // ==================== VR 초기 진입 처리 ====================
  if (totalQuantity === 0 && accountCash > 0) {
    console.log(`[VR] Initial entry mode: no holdings, cash=$${accountCash.toFixed(2)}, price=$${currentPrice.toFixed(2)}`);

    const investmentMode = vrConfig.investmentMode || 'accumulate';
    const poolUsageLimit =
      investmentMode === 'accumulate' ? 0.75 :
      investmentMode === 'lump' ? 0.50 : 0.25;
    const availableCash = accountCash * poolUsageLimit;

    const buyQuantity = Math.floor(availableCash / currentPrice);

    if (buyQuantity <= 0) {
      console.log(`[VR] Initial entry: insufficient funds (available=$${availableCash.toFixed(2)}, price=$${currentPrice.toFixed(2)})`);
      if (chatId) {
        await sendTelegramMessage(
          chatId,
          `⚠️ <b>VR 초기 진입 불가</b>\n\n` +
          `예수금: $${accountCash.toFixed(2)}\n` +
          `사용 가능 (${(poolUsageLimit * 100).toFixed(0)}%): $${availableCash.toFixed(2)}\n` +
          `현재가: $${currentPrice.toFixed(2)}\n\n` +
          `매수 가능 수량이 없습니다.`,
          'HTML'
        );
      }
      return;
    }

    const totalAmount = buyQuantity * currentPrice;
    const expectedV = totalAmount;
    const autoApprove = common.autoApprove === true;

    const initialOrder = {
      userId,
      accountId,
      ticker,
      type: 'buy' as const,
      status: autoApprove ? 'approved' as const : 'pending' as const,
      strategy: 'vr' as const,
      isInitialEntry: true,
      orders: [{
        orderType: 'LIMIT',
        price: currentPrice,
        quantity: buyQuantity,
        amount: totalAmount,
        label: `VR 초기 진입 ${buyQuantity}주 @ $${currentPrice.toFixed(2)} [${ticker}]`,
      }],
      vrCalculation: {
        targetValue: expectedV,
        minBand: expectedV * 0.85,
        maxBand: expectedV * 1.15,
        currentEvaluation: 0,
        currentPrice,
        pool: accountCash,
        poolAvailable: availableCash,
        investmentMode,
        actionReason: `VR 초기 진입: 예수금 $${accountCash.toFixed(2)}로 ${buyQuantity}주 매수`,
        daysUntilVUpdate: 14,
      },
    };

    const orderId = createPendingOrder(initialOrder);
    console.log(`[VR] Created initial entry order: ${orderId}, qty=${buyQuantity}, amount=$${totalAmount.toFixed(2)}`);

    // 텔레그램 알림
    if (chatId) {
      const modeKr = investmentMode === 'accumulate' ? '적립식' :
                     investmentMode === 'lump' ? '거치식' : '인출식';

      if (autoApprove) {
        await sendTelegramMessage(
          chatId,
          `🚀 <b>VR 초기 진입 자동 주문</b> ⚡\n\n` +
          `종목: <b>${ticker}</b>\n` +
          `━━━━━━━━━━━━━━━\n` +
          `전략: <b>VR (${modeKr})</b>\n` +
          `현재가: <b>$${currentPrice.toFixed(2)}</b>\n` +
          `예수금: $${accountCash.toFixed(2)}\n` +
          `사용 가능 (${(poolUsageLimit * 100).toFixed(0)}%): $${availableCash.toFixed(2)}\n` +
          `━━━━━━━━━━━━━━━\n\n` +
          `📋 <b>초기 진입 주문</b>\n` +
          `수량: <b>${buyQuantity}주</b>\n` +
          `금액: <b>$${totalAmount.toFixed(2)}</b>\n\n` +
          `체결 후 V값: <b>$${expectedV.toFixed(2)}</b>\n` +
          `⚡ <i>자동 주문 모드 - 바로 실행됩니다</i>`,
          'HTML'
        );
      } else {
        const msgResult = await sendTelegramMessageWithId(
          chatId,
          `🚀 <b>VR 초기 진입 주문 대기</b>\n\n` +
          `종목: <b>${ticker}</b>\n` +
          `━━━━━━━━━━━━━━━\n` +
          `전략: <b>VR (${modeKr})</b>\n` +
          `현재가: <b>$${currentPrice.toFixed(2)}</b>\n` +
          `예수금: $${accountCash.toFixed(2)}\n` +
          `사용 가능 (${(poolUsageLimit * 100).toFixed(0)}%): $${availableCash.toFixed(2)}\n` +
          `━━━━━━━━━━━━━━━\n\n` +
          `📋 <b>초기 진입 주문</b>\n` +
          `수량: <b>${buyQuantity}주</b>\n` +
          `금액: <b>$${totalAmount.toFixed(2)}</b>\n\n` +
          `체결 후 V값: <b>$${expectedV.toFixed(2)}</b>`,
          'HTML',
          [
            [
              { text: '✅ 승인', callback_data: `approve:${orderId}` },
              { text: '❌ 거부', callback_data: `reject:${orderId}` },
            ],
          ]
        );
        if (msgResult.success && msgResult.messageId) {
          updatePendingOrder(orderId, {
            telegramChatId: chatId,
            telegramMessageId: msgResult.messageId,
          });
        }
      }
    }

    return; // 초기 진입 처리 후 종료
  }

  // ==================== 일반 VR 처리 (잔량주문 방식) ====================
  let vrState = localStore.getState<Record<string, any>>('vrState', ticker);

  // VR 상태가 없으면 초기화 (보유 수량이 있는 경우)
  if (!vrState) {
    const investedAmount = totalQuantity * avgPrice;
    const initialV = investedAmount > 0 ? investedAmount : totalQuantity * currentPrice;

    const initialState = createInitialVRState(
      ticker,
      initialV,
      vrConfig.investmentMode || 'accumulate',
      vrConfig.periodicAmount || 0,
      vrConfig.gradient || 10,
      vrConfig.bandPercent || 0.15
    );

    vrState = {
      ...initialState,
      formulaType: vrConfig.formulaType || 'basic',
      pool: accountCash,
      totalQuantity,
      avgPrice,
      weekNumber: 1,
      cycleStartDate: nowISO(),
      lastVUpdateDate: nowISO(),
      createdAt: nowISO(),
    };

    localStore.setState('vrState', ticker, vrState);
    console.log(`[VR] Initialized VR state for ${ticker}: V=$${initialV.toFixed(2)} (invested), eval=$${(totalQuantity * currentPrice).toFixed(2)}, weekNumber=1`);
  }

  // 사이클 시작일 기준 주차 계산
  const cycleStartDate = vrState.cycleStartDate ? new Date(vrState.cycleStartDate) : new Date();
  const weekNumber = calculateWeekNumber(cycleStartDate);
  const lastVUpdateDate = vrState.lastVUpdateDate ? new Date(vrState.lastVUpdateDate) : new Date();

  // Pool 사용 한도 계산
  const poolUsageLimit = calculatePoolUsageLimit(vrState.investmentMode || 'accumulate', weekNumber);
  const poolAvailable = accountCash * poolUsageLimit;

  // 밴드 계산
  const { minBand, maxBand } = calculateBands(vrState.targetValue, vrState.bandPercent || 0.15);
  const currentEvaluation = totalQuantity * currentPrice;

  console.log(`[VR] ${ticker}: eval=$${currentEvaluation.toFixed(2)}, V=$${vrState.targetValue.toFixed(2)}, band=[$${minBand.toFixed(2)}~$${maxBand.toFixed(2)}], pool=$${poolAvailable.toFixed(2)}`);

  // V 업데이트 필요 여부 확인
  const vUpdateCheck = checkVUpdateNeeded(lastVUpdateDate);
  let needsOrderReinitialization = false;

  if (vUpdateCheck.needsUpdate) {
    const formulaType: VRFormulaType = (vrConfig.formulaType as VRFormulaType) || 'basic';

    // ==================== 이전 사이클 히스토리 저장 ====================
    try {
      localStore.addCycleHistory({
        ticker,
        market: 'overseas' as const,
        strategy: 'vr',
        cycleNumber: vrState.cycleNumber || 1,
        startedAt: vrState.lastVUpdateDate || vrState.cycleStartDate || vrState.createdAt,
        completedAt: nowISO(),
        targetValue: vrState.targetValue,
        newTargetValue: undefined,
        gradient: vrState.gradient || 10,
        bandPercent: vrState.bandPercent || 0.15,
        investmentMode: vrState.investmentMode || 'accumulate',
        formulaType: vrState.formulaType || 'basic',
        periodicAmount: vrState.periodicAmount || 0,
        pool: accountCash,
        evaluation: currentEvaluation,
        quantity: totalQuantity,
        avgPrice,
        minBand,
        maxBand,
        principal: vrState.initialInvestment || 0,
        totalInvested: vrState.initialInvestment || 0,
        totalRealizedProfit: vrState.totalRealizedProfit || 0,
        finalProfitRate: vrState.initialInvestment > 0
          ? (vrState.totalRealizedProfit || 0) / vrState.initialInvestment : 0,
        strategyVersion: 'vr',
        splitCount: 0,
        targetProfit: 0,
        starDecreaseRate: 0,
        buyPerRound: 0,
      });
      console.log(`[VR] Saved cycle history for cycle #${vrState.cycleNumber || 1}: V=$${vrState.targetValue.toFixed(2)}, E=$${currentEvaluation.toFixed(2)}`);
    } catch (err) {
      console.error(`[VR] Failed to save cycle history:`, err);
    }

    const newV = calculateNewTargetValue(
      vrState.targetValue,
      accountCash,
      vrState.gradient || 10,
      vrState.periodicAmount || 0,
      vrState.investmentMode || 'accumulate',
      formulaType,
      currentEvaluation
    );

    localStore.updateState('vrState', ticker, {
      targetValue: newV,
      formulaType,
      lastVUpdateDate: nowISO(),
      cycleNumber: (vrState.cycleNumber || 1) + 1,
      weekNumber: (vrState.weekNumber || 1) + 2,
      pendingOrders: undefined, // 새 사이클 시작으로 주문 초기화
    });
    console.log(`[VR] Updated V value: $${vrState.targetValue.toFixed(2)} -> $${newV.toFixed(2)} (formula: ${formulaType}, E=$${currentEvaluation.toFixed(2)})`);
    needsOrderReinitialization = true;

    vrState.targetValue = newV;
  }

  // ==================== 잔량주문 관리 ====================
  let pendingOrders = vrState.pendingOrders;

  console.log(`[VR] pendingOrders from vrState: ${pendingOrders ? `buy=${pendingOrders.buy?.length || 0}, sell=${pendingOrders.sell?.length || 0}` : 'null'}`);
  console.log(`[VR] needsOrderReinitialization: ${needsOrderReinitialization}`);

  // 검증: pendingOrders가 비정상적이면 재초기화 강제
  let forceReinitialize = false;
  if (pendingOrders) {
    const sellCount = pendingOrders.sell?.length || 0;
    const maxPossibleSellOrders = Math.max(0, totalQuantity - 1);
    if (sellCount > maxPossibleSellOrders) {
      console.log(`[VR] ⚠️ Invalid pendingOrders: ${sellCount} sell orders but only ${totalQuantity} shares (max ${maxPossibleSellOrders}). Force reinitializing.`);
      forceReinitialize = true;
    } else if (sellCount > 10) {
      console.log(`[VR] ⚠️ Excessive sell orders: ${sellCount} (max 10). Force reinitializing.`);
      forceReinitialize = true;
    }
  }

  const needsInit = !pendingOrders || needsOrderReinitialization || forceReinitialize ||
    needsOrderInitialization(pendingOrders, lastVUpdateDate);

  console.log(`[VR] needsInit: ${needsInit} (forceReinitialize: ${forceReinitialize})`);

  if (needsInit) {
    console.log(`[VR] Initializing cycle orders (qty=${totalQuantity}, minBand=$${minBand.toFixed(2)}, maxBand=$${maxBand.toFixed(2)}, poolAvail=$${poolAvailable.toFixed(2)})`);

    pendingOrders = initializeCycleOrders(
      ticker,
      totalQuantity,
      minBand,
      maxBand,
      poolAvailable,
      10
    );

    // localStore에 저장
    localStore.updateState('vrState', ticker, {
      pendingOrders: {
        buy: pendingOrders.buy,
        sell: pendingOrders.sell,
        initializedAt: nowISO(),
        baseQuantity: totalQuantity,
      },
    });

    console.log(`[VR] Saved pending orders: ${pendingOrders.buy.length} buy, ${pendingOrders.sell.length} sell`);
  }

  // 미체결 주문만 추출
  const { buyOrders: rawBuyOrders, sellOrders: rawSellOrders } = pendingOrdersToVROrders(ticker, pendingOrders);

  // 현재가 기준 주문 조정
  const { buyOrders, sellOrders } = adjustOrdersForCurrentPrice(rawBuyOrders, rawSellOrders, currentPrice, ticker);
  const totalBuyOrders = buyOrders.length;
  const totalSellOrders = sellOrders.length;

  console.log(`[VR] Unfilled orders: ${totalBuyOrders} buy, ${totalSellOrders} sell`);

  if (totalBuyOrders === 0 && totalSellOrders === 0) {
    console.log(`[VR] ${ticker}: All orders filled or no orders available`);
    return;
  }

  const autoApprove = common.autoApprove === true;

  const pendingOrder = {
    userId,
    accountId,
    ticker,
    type: 'combined' as const,
    status: autoApprove ? 'approved' as const : 'pending' as const,
    strategy: 'vr' as const,
    buyOrders: buyOrders.map(o => ({
      orderType: o.orderType,
      price: o.price,
      quantity: o.quantity,
      amount: o.amount,
      label: o.label,
    })),
    sellOrders: sellOrders.map(o => ({
      orderType: o.orderType,
      price: o.price,
      quantity: o.quantity,
      amount: o.amount,
      label: o.label,
    })),
    vrCalculation: {
      targetValue: vrState.targetValue,
      minBand,
      maxBand,
      currentEvaluation,
      currentPrice,
      pool: accountCash,
      poolAvailable,
      investmentMode: vrState.investmentMode,
      actionReason: `잔량주문: 매수 ${totalBuyOrders}건, 매도 ${totalSellOrders}건`,
      daysUntilVUpdate: vUpdateCheck.daysUntilUpdate,
    },
  };

  const orderId = createPendingOrder(pendingOrder);

  // 텔레그램 알림
  if (chatId) {
    const modeKr = vrState.investmentMode === 'accumulate' ? '적립식' :
                   vrState.investmentMode === 'lump' ? '거치식' : '인출식';

    const currentWeekNumber = vrState.weekNumber || 1;

    const profitRate = avgPrice > 0 ? (currentPrice - avgPrice) / avgPrice : 0;
    const profitEmoji = profitRate >= 0 ? '📈' : '📉';
    const profitSign = profitRate >= 0 ? '+' : '';

    const maskedNo = '****' + accountContext.accountNo.slice(-4);
    const accountDisplay = `📌 ${accountContext.nickname} (${maskedNo})`;

    let ordersText = '';
    if (totalBuyOrders > 0) {
      ordersText += `\n📈 <b>매수 주문 (${totalBuyOrders}건)</b>\n`;
      buyOrders.slice(0, 5).forEach((o, i) => {
        ordersText += `  ${i + 1}. $${o.price.toFixed(2)} × ${o.quantity}주\n`;
      });
      if (totalBuyOrders > 5) ordersText += `  ... 외 ${totalBuyOrders - 5}건\n`;
    }
    if (totalSellOrders > 0) {
      ordersText += `\n📉 <b>매도 주문 (${totalSellOrders}건)</b>\n`;
      sellOrders.slice(0, 5).forEach((o, i) => {
        ordersText += `  ${i + 1}. $${o.price.toFixed(2)} × ${o.quantity}주\n`;
      });
      if (totalSellOrders > 5) ordersText += `  ... 외 ${totalSellOrders - 5}건\n`;
    }

    if (autoApprove) {
      await sendTelegramMessage(
        chatId,
        `📊 <b>VR매매법 잔량주문 제출</b> ⚡\n\n` +
        `${accountDisplay}\n` +
        `종목: <b>${ticker}</b>\n` +
        `━━━━━━━━━━━━━━━\n` +
        `📊 <b>VR 상태 (${currentWeekNumber}주차)</b>\n` +
        `현재가: <b>$${currentPrice.toFixed(2)}</b>\n` +
        `평단가: $${avgPrice.toFixed(2)} (${profitEmoji} ${profitSign}${(profitRate * 100).toFixed(2)}%)\n` +
        `전략: <b>VR (${modeKr})</b>\n` +
        `V값: $${vrState.targetValue.toFixed(2)}\n` +
        `밴드: $${minBand.toFixed(2)} ~ $${maxBand.toFixed(2)}\n` +
        `평가금: <b>$${currentEvaluation.toFixed(2)}</b>\n` +
        `━━━━━━━━━━━━━━━` +
        ordersText +
        `\n⚡ <i>자동 주문 모드 - 바로 실행됩니다</i>`,
        'HTML'
      );
    } else {
      const msgResult = await sendTelegramMessageWithId(
        chatId,
        `📊 <b>VR매매법 잔량주문 대기</b>\n\n` +
        `${accountDisplay}\n` +
        `종목: <b>${ticker}</b>\n` +
        `━━━━━━━━━━━━━━━\n` +
        `📊 <b>VR 상태 (${currentWeekNumber}주차)</b>\n` +
        `현재가: <b>$${currentPrice.toFixed(2)}</b>\n` +
        `평단가: $${avgPrice.toFixed(2)} (${profitEmoji} ${profitSign}${(profitRate * 100).toFixed(2)}%)\n` +
        `전략: <b>VR (${modeKr})</b>\n` +
        `V값: $${vrState.targetValue.toFixed(2)}\n` +
        `밴드: $${minBand.toFixed(2)} ~ $${maxBand.toFixed(2)}\n` +
        `평가금: <b>$${currentEvaluation.toFixed(2)}</b>\n` +
        `━━━━━━━━━━━━━━━` +
        ordersText,
        'HTML',
        [
          [
            { text: '✅ 승인', callback_data: `approve:${orderId}` },
            { text: '❌ 거부', callback_data: `reject:${orderId}` },
          ],
        ]
      );
      if (msgResult.success && msgResult.messageId) {
        updatePendingOrder(orderId, {
          telegramChatId: chatId,
          telegramMessageId: msgResult.messageId,
        });
      }
    }
  }

  console.log(`[VR] Created ${autoApprove ? 'auto-approved' : 'pending'} orders for ${ticker}: ${orderId} (buy=${totalBuyOrders}, sell=${totalSellOrders})`);
}

// ==================== 떨사오팔 매매법 처리 함수 ====================

/**
 * 떨사오팔 매매 처리 (무한매수법/VR과 완전히 분리된 함수)
 * NOTE: 해외 떨사오팔 제거 후 미사용. 국내 떨사오팔 재활성화 시 복원 가능.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export async function processDdsobTrading(
  common: CommonConfig,
  _options: { bypassRejection?: boolean } = {}
): Promise<void> {
  const { userId, accountId } = config;
  console.log(`[DDSOB] Processing trading for user: ${userId}, account: ${accountId}`);

  const chatId = await getUserTelegramChatId(userId);

  // 떨사오팔 전략별 설정 조회 (시장별 경로)
  const ddsobConfig = getMarketStrategyConfig<{
    ticker: string;
    splitCount: number;
    profitPercent: number;
    forceSellDays: number;
    stopAfterCycleEnd: boolean;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }>('overseas', 'ddsob' as any);
  if (!ddsobConfig?.ticker) {
    console.log(`[DDSOB] No ddsob config or ticker for user ${userId}, account ${accountId}`);
    return;
  }

  const ticker: string = ddsobConfig.ticker;
  const splitCount: number = ddsobConfig.splitCount || 10;
  const profitPercent: number = ddsobConfig.profitPercent || 0.01;
  const forceSellDays: number = ddsobConfig.forceSellDays ?? 10;

  // 자격증명: config에서 직접 읽기
  const credentials = {
    appKey: config.kis.appKey,
    appSecret: config.kis.appSecret,
    accountNo: config.kis.accountNo,
  };

  const accountContext = {
    nickname: accountId,
    accountNo: credentials.accountNo,
  };

  // KIS API 클라이언트 생성
  const kisClient = new KisApiClient(config.kis.paperTrading);

  // 액세스 토큰 가져오기
  let accessToken: string;
  try {
    accessToken = await getOrRefreshToken(userId, accountId, credentials, kisClient);
  } catch (err) {
    console.error(`[DDSOB] Failed to get access token for user ${userId}:`, err);
    if (chatId) {
      await sendTelegramMessage(
        chatId,
        `❌ <b>API 토큰 발급 실패</b>\n\n` +
        `한국투자증권 API 키를 확인해주세요.\n` +
        `오류: ${err instanceof Error ? err.message : 'Unknown error'}`,
        'HTML'
      );
    }
    return;
  }

  // 현재가 및 전일 종가 조회
  let currentPrice: number;
  let previousClose: number;
  try {
    await new Promise(resolve => setTimeout(resolve, 300));
    const priceData = await kisClient.getCurrentPrice(
      credentials.appKey,
      credentials.appSecret,
      accessToken,
      ticker
    );
    currentPrice = parseFloat(priceData.output?.last || '0');
    previousClose = parseFloat(priceData.output?.base || '0');
  } catch (err) {
    console.error(`[DDSOB] Failed to get current price for ${ticker}:`, err);
    if (chatId) {
      await sendTelegramMessage(chatId, `❌ <b>${ticker} 현재가 조회 실패</b>`, 'HTML');
    }
    return;
  }

  if (currentPrice <= 0) {
    console.log(`[DDSOB] Invalid current price for ${ticker}: ${currentPrice}`);
    return;
  }

  // ddsobState 조회 또는 초기화
  let ddsobState = localStore.getState<Record<string, any>>('ddsobState', ticker);

  const amountPerRound = Math.round(((ddsobState?.principal || 0) / splitCount) * 100) / 100;
  let isFirstBuy = false;

  // 상태가 없으면 새 사이클 초기화
  if (!ddsobState) {
    let accountCash = 0;
    try {
      await new Promise(resolve => setTimeout(resolve, 300));
      const buyableData = await kisClient.getBuyableAmount(
        credentials.appKey,
        credentials.appSecret,
        accessToken,
        credentials.accountNo,
        ticker,
        1,
        'NASD'
      ).catch(() => null);

      if (buyableData?.rt_cd === '0' && buyableData.output) {
        accountCash = parseFloat(buyableData.output.ovrs_ord_psbl_amt || buyableData.output.frcr_ord_psbl_amt1 || '0');
      }
    } catch {
      console.log(`[DDSOB] getBuyableAmount failed, using 0`);
    }

    if (accountCash <= 0) {
      console.log(`[DDSOB] No cash available for new cycle`);
      if (chatId) {
        await sendTelegramMessage(chatId, `⚠️ <b>떨사오팔 사이클 시작 불가</b>\n\n예수금이 없습니다.`, 'HTML');
      }
      return;
    }

    const principal = accountCash;
    const newAmountPerRound = Math.round((principal / splitCount) * 100) / 100;

    // 이전 사이클 번호 조회 (로컬 히스토리에서)
    const allHistory = localStore.getAllCycleHistory<Record<string, any>>();
    const ddsobHistory = allHistory
      .filter(h => h.ticker === ticker && h.strategy === 'ddsob')
      .sort((a, b) => (b.completedAt || '').localeCompare(a.completedAt || ''));
    const lastDdsobCycleNumber = ddsobHistory.length > 0 ? (ddsobHistory[0].cycleNumber || 0) : 0;

    ddsobState = {
      ticker,
      status: 'active',
      cycleNumber: lastDdsobCycleNumber + 1,
      principal,
      splitCount,
      maxRounds: splitCount,
      amountPerRound: newAmountPerRound,
      profitPercent,
      forceSellDays,
      buyRecords: [],
      daysWithoutTrade: 0,
      totalRealizedProfit: 0,
      totalBuyAmount: 0,
      totalSellAmount: 0,
      totalForceSellCount: 0,
      totalForceSellLoss: 0,
      pendingForceSellCount: 0,
      previousClose: 0,
      startedAt: nowISO(),
    };

    localStore.setState('ddsobState', ticker, ddsobState);
    isFirstBuy = true;
    console.log(`[DDSOB] Initialized new cycle for ${ticker}: principal=$${principal.toFixed(2)}, amountPerRound=$${newAmountPerRound.toFixed(2)}`);
  } else if (ddsobState.status === 'completed') {
    // 사이클 종료 후 자동 재시작
    if (ddsobConfig.stopAfterCycleEnd) {
      console.log(`[DDSOB] Cycle completed and stopAfterCycleEnd is enabled for ${ticker}`);
      if (chatId) {
        await sendTelegramMessage(chatId, `ℹ️ <b>${ticker} 떨사오팔 사이클 종료됨</b>\n\n사이클 종료 후 자동 재시작이 비활성화되어 있습니다.\n설정에서 재시작하세요.`, 'HTML');
      }
      return;
    }

    // 자동 재시작
    console.log(`[DDSOB] Auto-restarting cycle for ${ticker}`);
    localStore.deleteState('ddsobState', ticker);
    ddsobState = null;

    let accountCash = 0;
    try {
      await new Promise(resolve => setTimeout(resolve, 300));
      const buyableData = await kisClient.getBuyableAmount(
        credentials.appKey,
        credentials.appSecret,
        accessToken,
        credentials.accountNo,
        ticker,
        1,
        'NASD'
      ).catch(() => null);

      if (buyableData?.rt_cd === '0' && buyableData.output) {
        accountCash = parseFloat(buyableData.output.ovrs_ord_psbl_amt || buyableData.output.frcr_ord_psbl_amt1 || '0');
      }
    } catch {
      console.log(`[DDSOB] getBuyableAmount failed on restart, using 0`);
    }

    if (accountCash <= 0) {
      console.log(`[DDSOB] No cash available for cycle restart`);
      if (chatId) {
        await sendTelegramMessage(chatId, `⚠️ <b>${ticker} 떨사오팔 사이클 재시작 불가</b>\n\n예수금이 없습니다.`, 'HTML');
      }
      return;
    }

    const principal = accountCash;
    const newAmountPerRound = Math.round((principal / splitCount) * 100) / 100;

    const allHistory = localStore.getAllCycleHistory<Record<string, any>>();
    const ddsobHistory = allHistory
      .filter(h => h.ticker === ticker && h.strategy === 'ddsob')
      .sort((a, b) => (b.completedAt || '').localeCompare(a.completedAt || ''));
    const lastDdsobCycleNumber2 = ddsobHistory.length > 0 ? (ddsobHistory[0].cycleNumber || 0) : 0;

    ddsobState = {
      ticker,
      status: 'active',
      cycleNumber: lastDdsobCycleNumber2 + 1,
      principal,
      splitCount,
      maxRounds: splitCount,
      amountPerRound: newAmountPerRound,
      profitPercent,
      forceSellDays,
      buyRecords: [],
      daysWithoutTrade: 0,
      totalRealizedProfit: 0,
      totalBuyAmount: 0,
      totalSellAmount: 0,
      totalForceSellCount: 0,
      totalForceSellLoss: 0,
      pendingForceSellCount: 0,
      previousClose: 0,
      startedAt: nowISO(),
    };

    localStore.setState('ddsobState', ticker, ddsobState);
    isFirstBuy = true;
    console.log(`[DDSOB] Restarted cycle for ${ticker}: principal=$${principal.toFixed(2)}, amountPerRound=$${newAmountPerRound.toFixed(2)}`);

    if (chatId) {
      await sendTelegramMessage(
        chatId,
        `🔄 <b>${ticker} 떨사오팔 새 사이클 시작</b>\n\n` +
        `투자원금: $${principal.toFixed(2)}\n` +
        `1회분: $${newAmountPerRound.toFixed(2)}\n` +
        `분할 수: ${splitCount}\n` +
        `익절 목표: ${(profitPercent * 100).toFixed(1)}%`,
        'HTML'
      );
    }
  } else if (ddsobState.status !== 'active') {
    console.log(`[DDSOB] Cycle for ${ticker} is not active: ${ddsobState.status}`);
    return;
  } else {
    isFirstBuy = (ddsobState.buyRecords || []).length === 0;
    if (isFirstBuy && ddsobState.maxRounds !== undefined && ddsobState.maxRounds < splitCount) {
      console.log(`[DDSOB] Resetting maxRounds from ${ddsobState.maxRounds} to ${splitCount} for new cycle start`);
      ddsobState.maxRounds = splitCount;
      localStore.updateState('ddsobState', ticker, { maxRounds: splitCount });
    }
  }

  // BuyRecord 복원
  const buyRecords: BuyRecord[] = (ddsobState!.buyRecords || []).map((r: BuyRecord) => ({
    id: r.id,
    buyPrice: r.buyPrice,
    quantity: r.quantity,
    buyAmount: r.buyAmount,
    buyDate: r.buyDate,
  }));

  const effectivePreviousClose = previousClose > 0 ? previousClose : (ddsobState!.previousClose || currentPrice);

  console.log(`[DDSOB] ${ticker}: price=$${currentPrice.toFixed(2)}, prevClose=$${effectivePreviousClose.toFixed(2)}, buyRecords=${buyRecords.length}, daysWithoutTrade=${ddsobState!.daysWithoutTrade || 0}`);

  // 떨사오팔 계산
  const calcResult = calculateDdsob({
    ticker,
    currentPrice,
    previousClose: effectivePreviousClose,
    buyRecords,
    splitCount,
    profitPercent,
    amountPerRound: ddsobState!.amountPerRound || amountPerRound,
    isFirstBuy,
    forceSellDays,
    daysWithoutTrade: ddsobState!.daysWithoutTrade || 0,
    maxRounds: ddsobState!.maxRounds ?? splitCount,
  });

  console.log(`[DDSOB] Calculation result: action=${calcResult.action}, reason=${calcResult.actionReason}, buy=${calcResult.buyOrders.length}, sell=${calcResult.sellOrders.length}, maxRounds=${calcResult.analysis.maxRounds}`);

  // 강제 매도 발동 시 pendingForceSellCount 기록
  if (calcResult.action === 'force_sell') {
    localStore.updateState('ddsobState', ticker, {
      pendingForceSellCount: calcResult.sellOrders.length,
    });
    console.log(`[DDSOB] Force sell pending: ${calcResult.sellOrders.length}건, current maxRounds=${calcResult.analysis.maxRounds}`);
  }

  // 주문이 없으면 종료
  if (calcResult.buyOrders.length === 0 && calcResult.sellOrders.length === 0) {
    console.log(`[DDSOB] No orders to create for ${ticker}`);
    return;
  }

  const autoApprove = common.autoApprove === true;

  const pendingOrderData = {
    userId,
    accountId,
    ticker,
    type: (calcResult.buyOrders.length > 0 && calcResult.sellOrders.length > 0)
      ? 'combined' as const
      : (calcResult.buyOrders.length > 0 ? 'buy' as const : 'sell' as const),
    status: autoApprove ? 'approved' as const : 'pending' as const,
    strategy: 'ddsob' as const,
    ...(calcResult.buyOrders.length > 0 && calcResult.sellOrders.length > 0
      ? {
        buyOrders: calcResult.buyOrders.map(o => ({
          orderType: o.orderType,
          price: o.price,
          quantity: o.quantity,
          amount: o.amount,
          label: o.label,
          buyRecordId: o.buyRecordId,
          isForceSell: o.isForceSell,
        })),
        sellOrders: calcResult.sellOrders.map(o => ({
          orderType: o.orderType,
          price: o.price,
          quantity: o.quantity,
          amount: o.amount,
          label: o.label,
          buyRecordId: o.buyRecordId,
          isForceSell: o.isForceSell,
        })),
      }
      : {
        orders: [...calcResult.buyOrders, ...calcResult.sellOrders].map(o => ({
          orderType: o.orderType,
          price: o.price,
          quantity: o.quantity,
          amount: o.amount,
          label: o.label,
          buyRecordId: o.buyRecordId,
          isForceSell: o.isForceSell,
        })),
      }
    ),
    ddsobCalculation: {
      action: calcResult.action,
      actionReason: calcResult.actionReason,
      usedRounds: calcResult.analysis.usedRounds,
      availableRounds: calcResult.analysis.availableRounds,
      maxRounds: calcResult.analysis.maxRounds,
      amountPerRound: calcResult.analysis.amountPerRound,
      daysWithoutTrade: calcResult.analysis.daysWithoutTrade,
      currentPrice,
      previousClose: effectivePreviousClose,
    },
  };

  const orderId = createPendingOrder(pendingOrderData);

  // 텔레그램 알림
  if (chatId) {
    const maskedNo = '****' + accountContext.accountNo.slice(-4);
    const accountDisplay = `📌 ${accountContext.nickname} (${maskedNo})`;

    let ordersText = '';
    if (calcResult.buyOrders.length > 0) {
      ordersText += `\n📈 <b>매수 주문</b>\n`;
      calcResult.buyOrders.forEach(o => {
        ordersText += `  LOC ${o.quantity}주 @ $${o.price.toFixed(2)} ($${o.amount.toFixed(2)})\n`;
      });
    }
    if (calcResult.sellOrders.length > 0) {
      const normalSells = calcResult.sellOrders.filter(o => !o.isForceSell);
      const forceSells = calcResult.sellOrders.filter(o => o.isForceSell);
      if (normalSells.length > 0) {
        ordersText += `\n📉 <b>매도 주문 (${normalSells.length}건)</b>\n`;
        normalSells.slice(0, 5).forEach(o => {
          ordersText += `  LOC ${o.quantity}주 @ $${o.price.toFixed(2)}\n`;
        });
        if (normalSells.length > 5) ordersText += `  ... 외 ${normalSells.length - 5}건\n`;
      }
      if (forceSells.length > 0) {
        ordersText += `\n🔴 <b>강제 매도 (${forceSells.length}건 MOC)</b>\n`;
        forceSells.forEach(o => {
          ordersText += `  ${o.quantity}주 (매수가 $${o.label.match(/\$[\d.]+/)?.[0] || '?'})\n`;
        });
      }
    }

    const { analysis } = calcResult;

    if (autoApprove) {
      await sendTelegramMessage(
        chatId,
        `📊 <b>떨사오팔 주문 제출</b> ⚡\n\n` +
        `${accountDisplay}\n` +
        `종목: <b>${ticker}</b>\n` +
        `━━━━━━━━━━━━━━━\n` +
        `현재가: <b>$${currentPrice.toFixed(2)}</b>\n` +
        `전일종가: $${effectivePreviousClose.toFixed(2)}\n` +
        `보유: ${analysis.usedRounds}/${splitCount}회분\n` +
        `1회분: $${analysis.amountPerRound.toFixed(2)}\n` +
        `━━━━━━━━━━━━━━━` +
        ordersText +
        `\n⚡ <i>자동 주문 모드 - 바로 실행됩니다</i>`,
        'HTML'
      );
    } else {
      const msgResult = await sendTelegramMessageWithId(
        chatId,
        `📊 <b>떨사오팔 주문 대기</b>\n\n` +
        `${accountDisplay}\n` +
        `종목: <b>${ticker}</b>\n` +
        `━━━━━━━━━━━━━━━\n` +
        `현재가: <b>$${currentPrice.toFixed(2)}</b>\n` +
        `전일종가: $${effectivePreviousClose.toFixed(2)}\n` +
        `보유: ${analysis.usedRounds}/${splitCount}회분\n` +
        `1회분: $${analysis.amountPerRound.toFixed(2)}\n` +
        `━━━━━━━━━━━━━━━` +
        ordersText,
        'HTML',
        [
          [
            { text: '✅ 승인', callback_data: `approve:${orderId}` },
            { text: '❌ 거부', callback_data: `reject:${orderId}` },
          ],
        ]
      );
      if (msgResult.success && msgResult.messageId) {
        updatePendingOrder(orderId, {
          telegramChatId: chatId,
          telegramMessageId: msgResult.messageId,
        });
      }
    }
  }

  console.log(`[DDSOB] Created ${autoApprove ? 'auto-approved' : 'pending'} orders for ${ticker}: ${orderId}`);
}

// ==================== 무한매수법 매도 전용 모드 ====================

async function processInfiniteSellOnly(
  common: CommonConfig,
): Promise<void> {
  const { userId, accountId } = config;

  // 활성/completing 사이클 조회 (localStore에서)
  const allCycles = localStore.getAllStates<Record<string, any>>('cycles');
  const activeCycles = new Map<string, Record<string, any>>();
  for (const [ticker, data] of allCycles) {
    if (data.status === 'active' || data.status === 'completing') {
      activeCycles.set(ticker, data);
    }
  }
  if (activeCycles.size === 0) return;

  console.log(`[SellOnly:Infinite] ${userId}/${accountId} — 매도 전용 모드: ${activeCycles.size}개 무한매수법 사이클 잔여`);

  const chatId = await getUserTelegramChatId(userId);

  const credentials = {
    appKey: config.kis.appKey,
    appSecret: config.kis.appSecret,
    accountNo: config.kis.accountNo,
  };

  const accountContext = {
    nickname: accountId,
    accountNo: credentials.accountNo,
  };

  const kisClient = new KisApiClient(config.kis.paperTrading);

  let accessToken: string;
  try {
    accessToken = await getOrRefreshToken(userId, accountId, credentials, kisClient);
  } catch (err) {
    console.error(`[SellOnly:Infinite] Failed to get access token for user ${userId}:`, err);
    return;
  }

  // 잔고 조회
  let balanceData;
  try {
    balanceData = await kisClient.getBalance(
      credentials.appKey,
      credentials.appSecret,
      accessToken,
      credentials.accountNo
    );
    if (balanceData.output1 && !Array.isArray(balanceData.output1)) {
      balanceData.output1 = [];
    }
  } catch (err) {
    console.error(`[SellOnly:Infinite] Failed to get balance for user ${userId}:`, err);
    return;
  }

  const holdingsArray = Array.isArray(balanceData.output1) ? balanceData.output1 : [];

  for (const [ticker, cycleData] of activeCycles) {
    const holdingData = holdingsArray.find((h) => h.ovrs_pdno === ticker);
    const totalQuantity = holdingData ? parseInt(holdingData.ovrs_cblc_qty || '0') : 0;
    const avgPrice = holdingData ? parseFloat(holdingData.pchs_avg_pric || '0') : 0;

    if (totalQuantity <= 0) {
      console.log(`[SellOnly:Infinite] ${ticker}: no holdings, skipping`);
      continue;
    }

    // 현재가 조회
    let currentPrice: number;
    try {
      await new Promise(resolve => setTimeout(resolve, 300));
      const quoteResponse = await kisClient.getCurrentPrice(
        credentials.appKey,
        credentials.appSecret,
        accessToken,
        ticker
      );
      currentPrice = parseFloat(quoteResponse.output?.last || '0');
      if (currentPrice <= 0) continue;
    } catch {
      console.log(`[SellOnly:Infinite] ${ticker}: failed to get price, skipping`);
      continue;
    }

    const principal = cycleData.principal || 0;
    const splitCount = cycleData.splitCount || 20;
    const targetProfit = cycleData.targetProfit || 0.15;
    const starDecreaseRate = cycleData.starDecreaseRate || (targetProfit * 2 / splitCount);
    const strategyVersion = cycleData.strategyVersion || 'v3.0';
    const buyPerRound = cycleData.buyPerRound || (principal / splitCount);
    const totalInvested = totalQuantity * avgPrice;
    const remainingCash = principal - totalInvested;
    const quarterMode = cycleData.quarterMode as QuarterModeState | undefined;

    const calcResult = calculate({
      ticker,
      currentPrice,
      totalQuantity,
      avgPrice,
      totalInvested,
      remainingCash,
      buyPerRound,
      splitCount,
      targetProfit,
      starDecreaseRate,
      strategyVersion,
      quarterMode,
    });

    if (calcResult.sellOrders.length === 0) {
      console.log(`[SellOnly:Infinite] ${ticker}: no sell orders, skipping`);
      continue;
    }

    const sellOrdersToCreate = calcResult.sellOrders.map(o => ({
      orderType: o.orderType,
      price: o.price,
      quantity: o.quantity,
      amount: o.amount,
      label: o.label,
    }));

    const autoApprove = common.autoApprove === true;
    const totalSellAmount = sellOrdersToCreate.reduce((sum, o) => sum + o.amount, 0);

    const sellPendingOrder = {
      userId,
      accountId,
      ticker,
      type: 'sell' as const,
      status: autoApprove ? 'approved' as const : 'pending' as const,
      sellOnlyMode: true,
      orders: sellOrdersToCreate,
      calculation: {
        tValue: calcResult.tValue,
        phase: calcResult.phase,
        starPercent: calcResult.starPercent,
        targetPercent: calcResult.targetPercent,
        totalInvested,
        buyPerRound,
        avgPrice,
        currentPrice,
        strategyVersion,
        splitCount,
      },
    };

    const orderId = createPendingOrder(sellPendingOrder);

    if (chatId) {
      const maskedNo = '****' + accountContext.accountNo.slice(-4);
      const accountDisplay = `📌 ${accountContext.nickname} (${maskedNo})`;

      if (autoApprove) {
        await sendTelegramMessage(
          chatId,
          `📊 <b>무한매수법 매도전용 주문 제출</b> ⚡\n\n` +
          `${accountDisplay}\n` +
          `종목: <b>${ticker}</b>\n` +
          `현재가: $${currentPrice.toFixed(2)}\n` +
          `매도 ${sellOrdersToCreate.length}건, 총 $${totalSellAmount.toFixed(2)}\n` +
          `⚡ <i>자동 주문 모드</i>`,
          'HTML'
        );
      } else {
        const msgResult = await sendTelegramMessageWithId(
          chatId,
          `📊 <b>무한매수법 매도전용 주문 대기</b>\n\n` +
          `${accountDisplay}\n` +
          `종목: <b>${ticker}</b>\n` +
          `현재가: $${currentPrice.toFixed(2)}\n` +
          `매도 ${sellOrdersToCreate.length}건, 총 $${totalSellAmount.toFixed(2)}`,
          'HTML',
          [
            [
              { text: '✅ 승인', callback_data: `approve:${orderId}` },
              { text: '❌ 거부', callback_data: `reject:${orderId}` },
            ],
          ]
        );
        if (msgResult.success && msgResult.messageId) {
          updatePendingOrder(orderId, {
            telegramChatId: chatId,
            telegramMessageId: msgResult.messageId,
          });
        }
      }
    }

    console.log(`[SellOnly:Infinite] Created ${autoApprove ? 'auto-approved' : 'pending'} sell order for ${ticker}: ${orderId}`);
  }
}

// ==================== 떨사오팔 매도 전용 모드 ====================

async function processDdsobSellOnly(
  common: CommonConfig,
): Promise<void> {
  const { userId, accountId } = config;

  // 활성 ddsobState 조회 (localStore에서)
  const allDdsobStates = localStore.getStatesWhere<Record<string, any>>('ddsobState', (data) => {
    return data.status === 'active' && (data.buyRecords || []).length > 0;
  });

  if (allDdsobStates.size === 0) return;

  console.log(`[SellOnly:DDSOB] ${userId}/${accountId} — 매도 전용 모드: ${allDdsobStates.size}개 떨사오팔 종목 잔여`);

  const chatId = await getUserTelegramChatId(userId);

  const credentials = {
    appKey: config.kis.appKey,
    appSecret: config.kis.appSecret,
    accountNo: config.kis.accountNo,
  };

  const accountContext = {
    nickname: accountId,
    accountNo: credentials.accountNo,
  };

  const kisClient = new KisApiClient(config.kis.paperTrading);

  let accessToken: string;
  try {
    accessToken = await getOrRefreshToken(userId, accountId, credentials, kisClient);
  } catch (err) {
    console.error(`[SellOnly:DDSOB] Failed to get access token for user ${userId}:`, err);
    return;
  }

  for (const [ticker, ddsobState] of allDdsobStates) {
    let currentPrice: number;
    let previousClose: number;
    try {
      await new Promise(resolve => setTimeout(resolve, 300));
      const priceData = await kisClient.getCurrentPrice(
        credentials.appKey,
        credentials.appSecret,
        accessToken,
        ticker
      );
      currentPrice = parseFloat(priceData.output?.last || '0');
      previousClose = parseFloat(priceData.output?.base || '0');
      if (currentPrice <= 0) continue;
    } catch {
      console.log(`[SellOnly:DDSOB] ${ticker}: failed to get price, skipping`);
      continue;
    }

    const buyRecords: BuyRecord[] = (ddsobState.buyRecords || []).map((r: BuyRecord) => ({
      id: r.id,
      buyPrice: r.buyPrice,
      quantity: r.quantity,
      buyAmount: r.buyAmount,
      buyDate: r.buyDate,
    }));

    const splitCount = ddsobState.splitCount || 10;
    const profitPercent = ddsobState.profitPercent || 0.01;
    const forceSellDays = ddsobState.forceSellDays ?? 10;
    const effectivePreviousClose = previousClose > 0 ? previousClose : (ddsobState.previousClose || currentPrice);

    const calcResult = calculateDdsob({
      ticker,
      currentPrice,
      previousClose: effectivePreviousClose,
      buyRecords,
      splitCount,
      profitPercent,
      amountPerRound: ddsobState.amountPerRound || 0,
      isFirstBuy: false,
      forceSellDays,
      daysWithoutTrade: ddsobState.daysWithoutTrade || 0,
      maxRounds: buyRecords.length,
    });

    // 강제 매도 발동 시 pendingForceSellCount 기록
    if (calcResult.action === 'force_sell') {
      localStore.updateState('ddsobState', ticker, {
        pendingForceSellCount: calcResult.sellOrders.length,
      });
      console.log(`[SellOnly:DDSOB] Force sell pending: ${calcResult.sellOrders.length}건 for ${ticker}`);
    }

    if (calcResult.sellOrders.length === 0) {
      console.log(`[SellOnly:DDSOB] ${ticker}: no sell orders, skipping`);
      continue;
    }

    const autoApprove = common.autoApprove === true;

    const pendingOrderData = {
      userId,
      accountId,
      ticker,
      type: 'sell' as const,
      status: autoApprove ? 'approved' as const : 'pending' as const,
      strategy: 'ddsob' as const,
      sellOnlyMode: true,
      orders: calcResult.sellOrders.map(o => ({
        orderType: o.orderType,
        price: o.price,
        quantity: o.quantity,
        amount: o.amount,
        label: o.label,
        buyRecordId: o.buyRecordId,
        isForceSell: o.isForceSell,
      })),
      ddsobCalculation: {
        action: calcResult.action,
        actionReason: `[매도전용] ${calcResult.actionReason}`,
        usedRounds: calcResult.analysis.usedRounds,
        availableRounds: 0,
        maxRounds: calcResult.analysis.maxRounds,
        amountPerRound: calcResult.analysis.amountPerRound,
        daysWithoutTrade: calcResult.analysis.daysWithoutTrade,
        currentPrice,
        previousClose: effectivePreviousClose,
      },
    };

    const orderId = createPendingOrder(pendingOrderData);

    if (chatId) {
      const maskedNo = '****' + accountContext.accountNo.slice(-4);
      const accountDisplay = `📌 ${accountContext.nickname} (${maskedNo})`;

      let ordersText = '';
      const normalSells = calcResult.sellOrders.filter(o => !o.isForceSell);
      const forceSells = calcResult.sellOrders.filter(o => o.isForceSell);
      if (normalSells.length > 0) {
        ordersText += `\n📉 <b>매도 주문 (${normalSells.length}건)</b>\n`;
        normalSells.slice(0, 5).forEach(o => {
          ordersText += `  LOC ${o.quantity}주 @ $${o.price.toFixed(2)}\n`;
        });
        if (normalSells.length > 5) ordersText += `  ... 외 ${normalSells.length - 5}건\n`;
      }
      if (forceSells.length > 0) {
        ordersText += `\n🔴 <b>강제 매도 (${forceSells.length}건 MOC)</b>\n`;
        forceSells.forEach(o => {
          ordersText += `  ${o.quantity}주 (매수가 $${o.label.match(/\$[\d.]+/)?.[0] || '?'})\n`;
        });
      }

      if (autoApprove) {
        await sendTelegramMessage(
          chatId,
          `📊 <b>떨사오팔 매도전용 주문 제출</b> ⚡\n\n` +
          `${accountDisplay}\n` +
          `종목: <b>${ticker}</b>\n` +
          `━━━━━━━━━━━━━━━\n` +
          `현재가: <b>$${currentPrice.toFixed(2)}</b>\n` +
          `전일종가: $${effectivePreviousClose.toFixed(2)}\n` +
          `잔여 보유: ${buyRecords.length}건\n` +
          `━━━━━━━━━━━━━━━` +
          ordersText +
          `\n⚠️ <i>매도 전용 모드 — 전략 변경으로 신규 매수 없음</i>\n` +
          `⚡ <i>자동 주문 모드 - 바로 실행됩니다</i>`,
          'HTML'
        );
      } else {
        const msgResult = await sendTelegramMessageWithId(
          chatId,
          `📊 <b>떨사오팔 매도전용 주문 대기</b>\n\n` +
          `${accountDisplay}\n` +
          `종목: <b>${ticker}</b>\n` +
          `━━━━━━━━━━━━━━━\n` +
          `현재가: <b>$${currentPrice.toFixed(2)}</b>\n` +
          `전일종가: $${effectivePreviousClose.toFixed(2)}\n` +
          `잔여 보유: ${buyRecords.length}건\n` +
          `━━━━━━━━━━━━━━━` +
          ordersText +
          `\n⚠️ <i>매도 전용 모드 — 전략 변경으로 신규 매수 없음</i>`,
          'HTML',
          [
            [
              { text: '✅ 승인', callback_data: `approve:${orderId}` },
              { text: '❌ 거부', callback_data: `reject:${orderId}` },
            ],
          ]
        );
        if (msgResult.success && msgResult.messageId) {
          updatePendingOrder(orderId, {
            telegramChatId: chatId,
            telegramMessageId: msgResult.messageId,
          });
        }
      }
    }

    console.log(`[SellOnly:DDSOB] Created ${autoApprove ? 'auto-approved' : 'pending'} sell order for ${ticker}: ${orderId}`);
  }
}

// ==================== 계좌별 매매 처리 ====================

async function processAccountTrading(
  common: CommonConfig,
  options: { bypassRejection?: boolean } = {}
): Promise<void> {
  const { userId, accountId } = config;
  console.log(`Processing trading for user: ${userId}, account: ${accountId}`);

  // [시장별 전략 분기] 해외 시장 전략에 따라 별도 함수로 위임
  const overseasStrategy = common.overseas?.strategy;

  // 해외 비활성 또는 전략 미선택: 잔여 포지션 매도 전용
  if (!isMarketActive(common, 'overseas')) {
    await processInfiniteSellOnly(common);
    await processDdsobSellOnly(common);
    return;
  }

  if (overseasStrategy === 'vr') {
    await processVRTrading(common, options);
    await processInfiniteSellOnly(common);
    await processDdsobSellOnly(common);
    return;
  }
  if (overseasStrategy === 'realtimeDdsobV2') {
    // 실사오팔v2는 realtimeTradingTriggerV2US/KR에서 별도 처리
    await processInfiniteSellOnly(common);
    await processDdsobSellOnly(common);
    return;
  }

  // Default: 무한매수법 (overseasStrategy === 'infinite')
  const infiniteConfig = getMarketStrategyConfig<{
    tickers: string[];
    tickerConfigs: Record<string, any>;
    splitCount?: number;
    targetProfit?: Record<string, number>;
    cycleEndRequested?: boolean;
    stopAfterCycleEnd?: boolean;
    updatedAt?: any;
  }>('overseas', 'infinite');
  if (!infiniteConfig) {
    console.log(`Skipping user ${userId}, account ${accountId}: no infinite strategy config found`);
    return;
  }

  const chatId = await getUserTelegramChatId(userId);

  // 자격증명: config에서 직접 읽기
  const credentials = {
    appKey: config.kis.appKey,
    appSecret: config.kis.appSecret,
    accountNo: config.kis.accountNo,
  };

  const accountContext = {
    nickname: accountId,
    accountNo: credentials.accountNo,
  };

  // KIS API 클라이언트 생성
  const kisClient = new KisApiClient(config.kis.paperTrading);

  let accessToken: string;
  try {
    accessToken = await getOrRefreshToken(userId, accountId, credentials, kisClient);
  } catch (err) {
    console.error(`Failed to get access token for user ${userId}, account ${accountId}:`, err);
    if (chatId) {
      await sendTelegramMessage(
        chatId,
        `❌ <b>API 토큰 발급 실패</b>\n\n` +
        `한국투자증권 API 키를 확인해주세요.\n` +
        `오류: ${err instanceof Error ? err.message : 'Unknown error'}`,
        'HTML'
      );
    }
    return;
  }

  // 잔고 조회 및 매수가능금액 조회
  let balanceData;
  let accountCash = 0;
  try {
    balanceData = await kisClient.getBalance(
      credentials.appKey,
      credentials.appSecret,
      accessToken,
      credentials.accountNo
    );

    await new Promise(resolve => setTimeout(resolve, 300));

    const buyableData = await kisClient.getBuyableAmount(
      credentials.appKey,
      credentials.appSecret,
      accessToken,
      credentials.accountNo,
      'AAPL',
      1,
      'NASD'
    ).catch(() => null);

    if (balanceData.output1 && !Array.isArray(balanceData.output1)) {
      console.log(`Balance output1 is not an array for user ${userId}, treating as empty holdings`);
      balanceData.output1 = [];
    }

    if (buyableData?.rt_cd === '0' && buyableData.output) {
      accountCash = parseFloat(buyableData.output.ovrs_ord_psbl_amt || '0');
    } else {
      const holdingsArray = Array.isArray(balanceData.output1) ? balanceData.output1 : [];
      const totalEvalAmount = holdingsArray.reduce(
        (sum, h) => sum + parseFloat(h.ovrs_stck_evlu_amt || '0'),
        0
      );
      const output2 = Array.isArray(balanceData.output2) ? balanceData.output2[0] : null;
      const totalAsset = parseFloat(output2?.tot_asst_amt || '0');
      accountCash = Math.max(0, totalAsset - totalEvalAmount);
    }
    console.log(`Account cash for user ${userId}: $${accountCash.toFixed(2)}`);
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : 'Unknown error';
    console.error(`Failed to get balance for user ${userId}:`, err);
    if (chatId) {
      await sendTelegramMessage(
        chatId,
        `❌ <b>잔고 조회 실패</b>\n\n` +
        `오류: ${errorMsg}\n\n` +
        `가능한 원인:\n` +
        `• 장외 시간\n` +
        `• API 자격증명 만료\n` +
        `• 계좌번호 오류`,
        'HTML'
      );
    }
    return;
  }

  const tickers = infiniteConfig.tickers || ['SOXL', 'TQQQ'];

  // 모든 종목의 사이클 상태를 먼저 조회
  const holdingsArray = Array.isArray(balanceData.output1) ? balanceData.output1 : [];
  const cycleStatusMap: Map<string, {
    needsNewCycle: boolean;
    principal: number;
    nextPrincipal: number;
    holdingValue: number;
    cycleData: Record<string, any> | null;
  }> = new Map();

  for (const ticker of tickers) {
    const holdingData = holdingsArray.find((h) => h.ovrs_pdno === ticker);
    const totalQuantity = holdingData ? parseInt(holdingData.ovrs_cblc_qty || '0') : 0;
    const avgPrice = holdingData ? parseFloat(holdingData.pchs_avg_pric || '0') : 0;
    const holdingValue = totalQuantity * avgPrice;
    const cycleData = localStore.getState<Record<string, any>>('cycles', ticker);

    const needsNewCycle = totalQuantity === 0 && avgPrice === 0;

    console.log(`[무한매수법] ${ticker} - holdingData found: ${!!holdingData}, qty=${totalQuantity}, avgPrice=${avgPrice}, needsNewCycle=${needsNewCycle}`);

    const nextPrincipal = (cycleData?.principal || 0) + (cycleData?.totalRealizedProfit || 0);

    cycleStatusMap.set(ticker, {
      needsNewCycle,
      principal: cycleData?.principal || 0,
      nextPrincipal,
      holdingValue,
      cycleData,
    });
  }

  // 원금 계산 로직 (V2)
  const cycleStatusForCalc = new Map<string, CycleStatus>();
  for (const ticker of tickers) {
    const status = cycleStatusMap.get(ticker);
    if (status) {
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
  }

  const principalResult = calculatePrincipal({
    accountCash,
    tickers,
    cycleStatusMap: cycleStatusForCalc,
  });

  const { totalAllocatedFunds, additionalDeposit, depositPerTicker, updatedAllocatedFunds, newCyclePrincipalMap } = principalResult;

  console.log(`[Principal Calc V2] Account cash: $${accountCash.toFixed(2)}`);
  console.log(`[Principal Calc V2] Total allocated funds: $${totalAllocatedFunds.toFixed(2)}`);
  console.log(`[Principal Calc V2] Additional deposit: $${additionalDeposit.toFixed(2)}`);
  console.log(`[Principal Calc V2] Deposit per ticker: $${depositPerTicker.toFixed(2)}`);

  if (depositPerTicker > 0) {
    for (const ticker of tickers) {
      const newNextPrincipal = updatedAllocatedFunds.get(ticker) || 0;
      const oldStatus = cycleStatusMap.get(ticker);
      const oldNextPrincipal = oldStatus?.nextPrincipal || 0;

      if (oldStatus) {
        oldStatus.nextPrincipal = newNextPrincipal;
      }

      console.log(`[Principal Calc V2] ${ticker}: nextPrincipal updated $${oldNextPrincipal.toFixed(2)} -> $${newNextPrincipal.toFixed(2)} (+$${depositPerTicker.toFixed(2)})`);
    }
  }

  const tickersNeedingNewCycle = tickers.filter((t: string) => cycleStatusMap.get(t)?.needsNewCycle);
  let newCyclePrincipal = 0;

  if (tickersNeedingNewCycle.length > 0) {
    for (const ticker of tickersNeedingNewCycle) {
      const principal = newCyclePrincipalMap.get(ticker) || 0;
      console.log(`[Principal Calc V2] ${ticker}: newPrincipal=$${principal.toFixed(2)}`);
    }
    newCyclePrincipal = newCyclePrincipalMap.get(tickersNeedingNewCycle[0]) || 0;
  }

  for (let i = 0; i < tickers.length; i++) {
    const ticker = tickers[i];

    const tickerConfig = infiniteConfig.tickerConfigs?.[ticker];
    if (tickerConfig?.enabled === false) {
      console.log(`Skipping ${ticker} for user ${userId}: ticker autotrading disabled`);
      continue;
    }

    if (i > 0) {
      await new Promise(resolve => setTimeout(resolve, 300));
    }

    try {
      // 로컬: hasRejectedOrderToday 대신 단순 skip (단일 사용자, autoApprove)
      // bypassRejection이 false인 경우에도 로컬에서는 skip
      // (원본에서 hasRejectedOrderToday는 Firestore pendingOrders 쿼리)

      // 오늘 이미 pending 주문이 있는지 확인 (localStore)
      const todayStart = getTodayStart();
      const allPending = localStore.getAllPendingOrders<Record<string, any>>();
      let hasPendingToday = false;
      for (const [, order] of allPending) {
        if (order.ticker === ticker && order.status === 'pending') {
          const createdAt = order.createdAt ? new Date(order.createdAt) : new Date(0);
          if (createdAt >= todayStart) {
            hasPendingToday = true;
            break;
          }
        }
      }

      if (hasPendingToday) {
        console.log(`Skipping ${ticker} for user ${userId}: pending order already exists today`);
        continue;
      }

      // 현재가 조회
      let currentPrice: number;
      try {
        const quoteResponse = await kisClient.getCurrentPrice(
          credentials.appKey,
          credentials.appSecret,
          accessToken,
          ticker
        );
        currentPrice = parseFloat(quoteResponse.output?.last || '0');
        if (currentPrice <= 0) {
          throw new Error(`현재가가 유효하지 않음 (last: "${quoteResponse.output?.last || ''}")`);
        }
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : 'Unknown error';
        console.error(`Failed to get current price for ${ticker}:`, err);
        if (chatId) {
          await sendTelegramMessage(
            chatId,
            `⚠️ <b>${ticker} 현재가 조회 실패</b>\n\n` +
            `오류: ${errorMsg}\n\n` +
            `가능한 원인:\n` +
            `• 장외 시간 (프리마켓/애프터마켓 제외)\n` +
            `• 거래소 코드 불일치\n` +
            `• API 일시적 오류`,
            'HTML'
          );
        }
        continue;
      }

      const holdingData = holdingsArray.find((h) => h.ovrs_pdno === ticker);
      const totalQuantity = holdingData ? parseInt(holdingData.ovrs_cblc_qty || '0') : 0;
      const avgPrice = holdingData ? parseFloat(holdingData.pchs_avg_pric || '0') : 0;

      const cycleStatus = cycleStatusMap.get(ticker);
      let cycleData = cycleStatus?.cycleData || null;

      if (tickerConfig?.stopAfterCycleEnd) {
        if (!cycleData || cycleData.status === 'completed' || totalQuantity === 0) {
          console.log(`Skipping ${ticker} for user ${userId}: stopAfterCycleEnd is enabled and no active cycle`);
          continue;
        }
      }

      const strategyVersion: StrategyVersion = tickerConfig?.strategyVersion || 'v3.0';
      const isNewCycleStart = cycleStatus?.needsNewCycle || false;

      let targetProfit: number;
      let starDecreaseRate: number;
      let splitCount: number;

      if (isNewCycleStart) {
        if (strategyVersion === 'v2.2') {
          splitCount = tickerConfig.splitCount || 40;
          targetProfit = tickerConfig.targetProfit || (ticker === 'SOXL' ? 0.12 : 0.10);
        } else {
          splitCount = tickerConfig.splitCount || infiniteConfig.splitCount || 20;
          targetProfit = tickerConfig.targetProfit || infiniteConfig.targetProfit?.[ticker] || (ticker === 'SOXL' ? 0.20 : 0.15);
        }
      } else {
        splitCount = cycleData?.splitCount || tickerConfig.splitCount || (strategyVersion === 'v2.2' ? 40 : 20);
        targetProfit = cycleData?.targetProfit || tickerConfig.targetProfit || (ticker === 'SOXL' ? (strategyVersion === 'v2.2' ? 0.12 : 0.20) : (strategyVersion === 'v2.2' ? 0.10 : 0.15));
      }

      starDecreaseRate = cycleData?.starDecreaseRate || tickerConfig.starDecreaseRate || (targetProfit * 2 / splitCount);

      console.log(`${ticker} - strategyVersion: ${strategyVersion}, splitCount: ${splitCount}, targetProfit: ${(targetProfit * 100).toFixed(1)}%, isNewCycle: ${isNewCycleStart}`);

      const userPrincipal = tickerConfig.principal;
      const calculatedPrincipal = newCyclePrincipalMap.get(ticker) || newCyclePrincipal;
      const principal = isNewCycleStart
        ? (userPrincipal !== undefined ? userPrincipal : calculatedPrincipal)
        : (cycleData?.principal || 0);
      const buyPerRound = isNewCycleStart ? (principal / splitCount) : (cycleData?.buyPerRound || (principal / splitCount));
      const totalInvested = totalQuantity * avgPrice;
      const remainingCash = principal - totalInvested;

      // --- 새 사이클 초기화 ---
      if (isNewCycleStart) {
        const oldCycleData = cycleStatus?.cycleData;
        const newCycleNumber = (oldCycleData?.cycleNumber || 0) + 1;

        const newCycleState = {
          ticker,
          status: 'active',
          cycleNumber: newCycleNumber,
          principal,
          buyPerRound,
          splitCount,
          targetProfit,
          strategyVersion,
          starDecreaseRate,
          remainingCash: principal,
          totalInvested: 0,
          totalQuantity: 0,
          avgPrice: 0,
          totalBuyAmount: 0,
          totalSellAmount: 0,
          totalRealizedProfit: 0,
          startedAt: nowISO(),
        };

        localStore.setState('cycles', ticker, newCycleState);

        cycleData = newCycleState;

        console.log(`[Cycle] New cycle #${newCycleNumber} initialized for ${ticker}: principal=$${principal.toFixed(2)}, buyPerRound=$${buyPerRound.toFixed(2)}`);
      }

      // 쿼터모드 상태 읽기
      const quarterMode: QuarterModeState | undefined = cycleData?.quarterMode as QuarterModeState | undefined;

      console.log(`${ticker} - isNewCycle: ${isNewCycleStart}, principal: $${principal}${userPrincipal ? ' (user-set)' : ''}, buyPerRound: $${buyPerRound}, totalInvested: $${totalInvested.toFixed(2)} (qty=${totalQuantity} × avg=$${avgPrice.toFixed(2)})`);
      if (quarterMode) {
        console.log(`${ticker} - quarterMode: active=${quarterMode.isActive}, round=${quarterMode.round}`);
      }

      // 계산 수행
      const calcResult = calculate({
        ticker,
        currentPrice,
        totalQuantity,
        avgPrice,
        totalInvested,
        remainingCash,
        buyPerRound,
        splitCount,
        targetProfit,
        starDecreaseRate,
        strategyVersion,
        quarterMode,
      });

      // --- 쿼터모드 진입 감지 시 pending 상태 저장 ---
      if (calcResult.quarterModeInfo?.shouldEnterQuarterMode &&
          calcResult.quarterModeInfo.quarterModeState) {
        localStore.updateState('cycles', ticker, {
          quarterMode: {
            ...calcResult.quarterModeInfo.quarterModeState,
            isActive: false,
          },
        });
        console.log(`[QuarterMode] Pending activation written for ${ticker}: seed=${calcResult.quarterModeInfo.quarterModeState.quarterSeed}`);
      }

      // 주문 생성
      let ordersToCreate: Array<{
        orderType: 'LOC' | 'LIMIT' | 'MOC';
        price: number;
        quantity: number;
        amount: number;
        label: string;
      }> = [];
      let orderType: 'buy' | 'sell' = 'buy';

      if (isNewCycleStart) {
        const locPrice = Math.round(currentPrice * 1.05 * 100) / 100;
        const quantity = Math.floor(buyPerRound / currentPrice);
        if (quantity > 0) {
          ordersToCreate = [{
            orderType: 'LOC',
            price: locPrice,
            quantity,
            amount: Math.round(locPrice * quantity * 100) / 100,
            label: '최초 매수 (LOC +5%)',
          }];
        }
      } else {
        console.log(`${ticker} - calcResult: buyOrders.length=${calcResult.buyOrders.length}, sellOrders.length=${calcResult.sellOrders.length}`);

        if (calcResult.buyOrders.length > 0) {
          ordersToCreate = calcResult.buyOrders.map(o => ({
            orderType: o.orderType,
            price: o.price,
            quantity: o.quantity,
            amount: o.amount,
            label: o.label,
          }));
        }
      }

      // 매도 주문 생성
      let sellOrdersToCreate: Array<{
        orderType: 'LOC' | 'LIMIT' | 'MOC';
        price: number;
        quantity: number;
        amount: number;
        label: string;
      }> = [];

      if (!isNewCycleStart && totalQuantity > 0 && calcResult.sellOrders.length > 0) {
        sellOrdersToCreate = calcResult.sellOrders.map(o => ({
          orderType: o.orderType,
          price: o.price,
          quantity: o.quantity,
          amount: o.amount,
          label: o.label,
        }));
      }

      // 매수와 매도 가격이 같은 경우 매수 가격을 -0.01 조정 (자전거래 방지)
      if (ordersToCreate.length > 0 && sellOrdersToCreate.length > 0) {
        const sellPrices = new Set(sellOrdersToCreate.map(o => o.price));
        for (const buyOrder of ordersToCreate) {
          if (sellPrices.has(buyOrder.price)) {
            const originalPrice = buyOrder.price;
            buyOrder.price = Math.round((buyOrder.price - 0.01) * 100) / 100;
            buyOrder.amount = Math.round(buyOrder.price * buyOrder.quantity * 100) / 100;
            console.log(`${ticker} - Adjusted buy price from ${originalPrice} to ${buyOrder.price} to avoid same price as sell order`);
          }
        }
      }

      const hasBuyOrders = ordersToCreate.length > 0;
      const hasSellOrders = sellOrdersToCreate.length > 0;

      console.log(`${ticker} - Order creation check: hasBuyOrders=${hasBuyOrders} (${ordersToCreate.length}), hasSellOrders=${hasSellOrders} (${sellOrdersToCreate.length})`);

      // 매수와 매도 주문이 모두 있으면 combined 주문
      if (hasBuyOrders && hasSellOrders) {
        const autoApprove = common.autoApprove === true;

        const combinedPendingOrder = {
          userId,
          accountId,
          ticker,
          type: 'combined' as const,
          status: autoApprove ? 'approved' as const : 'pending' as const,
          buyOrders: ordersToCreate,
          sellOrders: sellOrdersToCreate,
          calculation: {
            tValue: calcResult.tValue,
            phase: calcResult.phase,
            starPercent: calcResult.starPercent,
            targetPercent: calcResult.targetPercent,
            totalInvested,
            buyPerRound,
            avgPrice,
            currentPrice,
            strategyVersion,
            splitCount,
          },
        };

        const orderId = createPendingOrder(combinedPendingOrder);

        if (chatId) {
          const maskedNo = '****' + accountContext.accountNo.slice(-4);
          const accountDisplay = `📌 ${accountContext.nickname} (${maskedNo})`;

          if (autoApprove) {
            await sendTelegramMessage(
              chatId,
              `📊 <b>무한매수법 매수+매도 주문 제출</b> ⚡\n\n` +
              `${accountDisplay}\n` +
              `종목: <b>${ticker}</b>\n` +
              `현재가: $${currentPrice.toFixed(2)}\n` +
              `매수 ${ordersToCreate.length}건, 매도 ${sellOrdersToCreate.length}건\n` +
              `⚡ <i>자동 주문 모드</i>`,
              'HTML'
            );
          } else {
            const msgResult = await sendTelegramMessageWithId(
              chatId,
              `📊 <b>무한매수법 매수+매도 주문 대기</b>\n\n` +
              `${accountDisplay}\n` +
              `종목: <b>${ticker}</b>\n` +
              `현재가: $${currentPrice.toFixed(2)}\n` +
              `매수 ${ordersToCreate.length}건, 매도 ${sellOrdersToCreate.length}건`,
              'HTML',
              [
                [
                  { text: '✅ 승인', callback_data: `approve:${orderId}` },
                  { text: '❌ 거부', callback_data: `reject:${orderId}` },
                ],
              ]
            );
            if (msgResult.success && msgResult.messageId) {
              updatePendingOrder(orderId, {
                telegramChatId: chatId,
                telegramMessageId: msgResult.messageId,
              });
            }
          }
        }

        console.log(`Created ${autoApprove ? 'auto-approved' : 'pending'} combined order for ${ticker}: ${orderId} (buy: ${ordersToCreate.length}, sell: ${sellOrdersToCreate.length})`);
      }
      // 매수 주문만 있는 경우
      else if (hasBuyOrders) {
        const totalAmount = ordersToCreate.reduce((sum, o) => sum + o.amount, 0);
        const autoApprove = common.autoApprove === true;

        const pendingOrderData = {
          userId,
          accountId,
          ticker,
          type: orderType,
          status: autoApprove ? 'approved' as const : 'pending' as const,
          orders: ordersToCreate,
          calculation: {
            tValue: calcResult.tValue,
            phase: calcResult.phase,
            starPercent: calcResult.starPercent,
            targetPercent: calcResult.targetPercent,
            totalInvested,
            buyPerRound,
            avgPrice,
            currentPrice,
            strategyVersion,
            splitCount,
          },
        };

        const orderId = createPendingOrder(pendingOrderData);

        if (chatId) {
          const maskedNo = '****' + accountContext.accountNo.slice(-4);
          const accountDisplay = `📌 ${accountContext.nickname} (${maskedNo})`;

          if (autoApprove) {
            await sendTelegramMessage(
              chatId,
              `📊 <b>무한매수법 ${orderType === 'buy' ? '매수' : '매도'} 주문 제출</b> ⚡\n\n` +
              `${accountDisplay}\n` +
              `종목: <b>${ticker}</b>\n` +
              `현재가: $${currentPrice.toFixed(2)}\n` +
              `${ordersToCreate.length}건, 총 $${totalAmount.toFixed(2)}\n` +
              `⚡ <i>자동 주문 모드</i>`,
              'HTML'
            );
          } else {
            const msgResult = await sendTelegramMessageWithId(
              chatId,
              `📊 <b>무한매수법 ${orderType === 'buy' ? '매수' : '매도'} 주문 대기</b>\n\n` +
              `${accountDisplay}\n` +
              `종목: <b>${ticker}</b>\n` +
              `현재가: $${currentPrice.toFixed(2)}\n` +
              `${ordersToCreate.length}건, 총 $${totalAmount.toFixed(2)}`,
              'HTML',
              [
                [
                  { text: '✅ 승인', callback_data: `approve:${orderId}` },
                  { text: '❌ 거부', callback_data: `reject:${orderId}` },
                ],
              ]
            );
            if (msgResult.success && msgResult.messageId) {
              updatePendingOrder(orderId, {
                telegramChatId: chatId,
                telegramMessageId: msgResult.messageId,
              });
            }
          }
        }

        console.log(`Created ${autoApprove ? 'auto-approved' : 'pending'} ${orderType} order for ${ticker}: ${orderId}`);
      }
      // 매도 주문만 있는 경우
      else if (hasSellOrders) {
        const autoApprove = common.autoApprove === true;
        const totalSellAmount = sellOrdersToCreate.reduce((sum, o) => sum + o.amount, 0);

        const sellPendingOrder = {
          userId,
          accountId,
          ticker,
          type: 'sell' as const,
          status: autoApprove ? 'approved' as const : 'pending' as const,
          orders: sellOrdersToCreate,
          calculation: {
            tValue: calcResult.tValue,
            phase: calcResult.phase,
            starPercent: calcResult.starPercent,
            targetPercent: calcResult.targetPercent,
            totalInvested,
            buyPerRound,
            avgPrice,
            currentPrice,
            strategyVersion,
            splitCount,
          },
        };

        const orderId = createPendingOrder(sellPendingOrder);

        if (chatId) {
          const maskedNo = '****' + accountContext.accountNo.slice(-4);
          const accountDisplay = `📌 ${accountContext.nickname} (${maskedNo})`;

          if (autoApprove) {
            await sendTelegramMessage(
              chatId,
              `📊 <b>무한매수법 매도 주문 제출</b> ⚡\n\n` +
              `${accountDisplay}\n` +
              `종목: <b>${ticker}</b>\n` +
              `현재가: $${currentPrice.toFixed(2)}\n` +
              `매도 ${sellOrdersToCreate.length}건, 총 $${totalSellAmount.toFixed(2)}\n` +
              `⚡ <i>자동 주문 모드</i>`,
              'HTML'
            );
          } else {
            const msgResult = await sendTelegramMessageWithId(
              chatId,
              `📊 <b>무한매수법 매도 주문 대기</b>\n\n` +
              `${accountDisplay}\n` +
              `종목: <b>${ticker}</b>\n` +
              `현재가: $${currentPrice.toFixed(2)}\n` +
              `매도 ${sellOrdersToCreate.length}건, 총 $${totalSellAmount.toFixed(2)}`,
              'HTML',
              [
                [
                  { text: '✅ 승인', callback_data: `approve:${orderId}` },
                  { text: '❌ 거부', callback_data: `reject:${orderId}` },
                ],
              ]
            );
            if (msgResult.success && msgResult.messageId) {
              updatePendingOrder(orderId, {
                telegramChatId: chatId,
                telegramMessageId: msgResult.messageId,
              });
            }
          }
        }

        console.log(`Created ${autoApprove ? 'auto-approved' : 'pending'} sell order for ${ticker}: ${orderId}`);
      }

    } catch (err) {
      console.error(`Error processing ${ticker} for user ${userId}:`, err);
      if (chatId) {
        await sendTelegramMessage(
          chatId,
          `❌ <b>${ticker} 주문 생성 실패</b>\n\n` +
          `오류: ${err instanceof Error ? err.message : 'Unknown error'}`,
          'HTML'
        );
      }
    }
  }
}

// ==================== 메인 엔트리 포인트 ====================

/**
 * 해외 매매 트리거 — 로컬 실행 버전
 * 스케줄러에서 호출하거나 수동 실행
 */
export async function runDailyTrading(options: { bypassRejection?: boolean } = {}): Promise<void> {
  console.log('Buy order trigger started (local)');

  const { userId, accountId } = config;

  // 1. 전날 미처리된 pending 주문 모두 만료 처리
  try {
    const todayStart = getTodayStart();
    const allPending = localStore.getAllPendingOrders<Record<string, any>>();

    for (const [orderId, order] of allPending) {
      if (order.status === 'pending') {
        const createdAt = order.createdAt ? new Date(order.createdAt) : new Date(0);
        if (createdAt < todayStart) {
          localStore.setPendingOrder(orderId, {
            ...order,
            status: 'expired',
            expiredAt: nowISO(),
          });

          const chatId = await getUserTelegramChatId(userId);
          if (chatId) {
            const typeLabel = order.type === 'buy' ? '매수' : '매도';
            await sendTelegramMessage(
              chatId,
              `⏰ <b>${order.ticker} ${typeLabel} 주문 만료</b>\n\n` +
                `어제 생성된 주문이 응답 없이 만료되었습니다.`
            );
          }
        }
      }
    }
  } catch (err) {
    console.error('Error expiring old orders:', err);
  }

  // 미국 동부 시간 기준으로 오늘 날짜 계산
  const now = new Date();
  const estOffset = -5;
  const edtOffset = -4;
  const year = now.getUTCFullYear();
  const marchSecondSunday = new Date(year, 2, 8 + (7 - new Date(year, 2, 1).getDay()) % 7);
  const novFirstSunday = new Date(year, 10, 1 + (7 - new Date(year, 10, 1).getDay()) % 7);
  const isDST = now >= marchSecondSunday && now < novFirstSunday;
  const offset = isDST ? edtOffset : estOffset;
  const usDate = new Date(now.getTime() + offset * 60 * 60 * 1000);

  // 휴장일 확인
  const holidayName = getUSMarketHolidayName(usDate);
  if (holidayName) {
    console.log(`US market is closed for holiday: ${holidayName}`);

    const chatId = await getUserTelegramChatId(userId);
    if (chatId) {
      await sendTelegramMessage(
        chatId,
        `🏖️ <b>오늘은 미국 주식시장 휴장일입니다</b>\n\n` +
        `휴장 사유: <b>${holidayName}</b>\n\n` +
        `주문을 넣지 않습니다.`
      );
    }
    return;
  }

  try {
    const common = getCommonConfig();
    if (!common) {
      console.log(`No trading config found for ${userId}/${accountId}`);
      return;
    }

    if (!common.tradingEnabled) {
      console.log(`Trading not enabled for ${userId}/${accountId}`);
      return;
    }

    await processAccountTrading(common, options);

    console.log('Trading trigger completed');
  } catch (error) {
    console.error('Trading trigger error:', error);
  }
}
