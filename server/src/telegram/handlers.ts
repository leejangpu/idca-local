/**
 * 텔레그램 명령 핸들러
 *
 * 명령어:
 *   /status     — 현재 설정 상태 표시
 *   /trading on/off — 매매 활성화/비활성화
 *   /stop TICKER — 종목 강제 종료
 *   /help       — 명령어 도움말
 *
 * 콜백:
 *   fs:{ticker}:{market} — 강제종료 확인 버튼
 *   approve:{orderId}    — 주문 승인
 *   reject:{orderId}     — 주문 거부
 */

import { config } from '../config';
import {
  sendTelegramMessage,
  answerCallbackQuery,
  editTelegramMessage,
} from '../lib/telegram';
import * as localStore from '../lib/localStore';
import { getCommonConfig, setCommonConfig } from '../lib/configHelper';
import { forceStopRealtimeDdsobV2Ticker } from '../runners/realtimeV2/forceStop';
import { type MarketType } from '../lib/marketUtils';
import { type AccountStrategy } from '../lib/configHelper';
import { getEnabledAccounts } from '../lib/accountContext';
import { getOrRefreshToken, isTokenExpiredError } from '../lib/kisApi';

interface TelegramMessage {
  message_id: number;
  chat: { id: number };
  text?: string;
}

interface TelegramCallbackQuery {
  id: string;
  message: { chat: { id: number }; message_id: number };
  data: string;
}

const adminChatId = config.telegram.adminChatId;

// ==================== 메시지 핸들러 ====================

export async function handleMessage(message: TelegramMessage): Promise<void> {
  const chatId = message.chat.id.toString();
  const text = (message.text || '').trim();

  // 관리자 chat ID 확인
  if (chatId !== adminChatId) {
    await sendTelegramMessage(chatId, '⛔ 권한이 없습니다.');
    return;
  }

  if (text === '/start' || text === '/help') {
    await cmdHelp(chatId);
  } else if (text === '/status') {
    await cmdStatus(chatId);
  } else if (text.startsWith('/trading')) {
    await cmdTrading(chatId, text);
  } else if (text.startsWith('/stop')) {
    await cmdStop(chatId, text);
  } else if (text === '/positions') {
    await cmdPositions(chatId);
  } else {
    await sendTelegramMessage(chatId, '❓ 알 수 없는 명령어입니다.\n/help 로 도움말을 확인하세요.');
  }
}

// ==================== 콜백 핸들러 ====================

export async function handleCallbackQuery(query: TelegramCallbackQuery): Promise<void> {
  const chatId = query.message.chat.id.toString();
  const messageId = query.message.message_id;
  const data = query.data;

  // 강제종료 콜백: fs:{ticker}:{market}:{strategyId}
  if (data.startsWith('fs:')) {
    const parts = data.split(':');
    const ticker = parts[1];
    const market = (parts[2] || 'domestic') as MarketType;
    const strategyId = (parts[3] || 'realtimeDdsobV2') as AccountStrategy;

    await answerCallbackQuery(query.id, '⏳ 전량매도 처리 중...');

    try {
      const result = await forceStopRealtimeDdsobV2Ticker(ticker, market, 'force_stop', strategyId);
      const resultText = result.success
        ? `✅ <b>전량매도 완료</b> [${ticker}]\n\n${result.message}`
        : `❌ <b>전량매도 실패</b> [${ticker}]\n\n${result.message}`;
      await editTelegramMessage(chatId, messageId, resultText);
    } catch (err) {
      await editTelegramMessage(chatId, messageId,
        `❌ <b>전량매도 실패</b> [${ticker}]\n\n${err instanceof Error ? err.message : String(err)}`);
    }
    return;
  }

  // 주문 승인 콜백: approve:{orderId}
  if (data.startsWith('approve:')) {
    const orderId = data.slice('approve:'.length);
    await handleOrderApproval(query, chatId, messageId, orderId, true);
    return;
  }

  // 주문 거부 콜백: reject:{orderId}
  if (data.startsWith('reject:')) {
    const orderId = data.slice('reject:'.length);
    await handleOrderApproval(query, chatId, messageId, orderId, false);
    return;
  }

  await answerCallbackQuery(query.id);
}

// ==================== 주문 승인/거부 처리 ====================

async function handleOrderApproval(
  query: TelegramCallbackQuery,
  chatId: string,
  messageId: number,
  orderId: string,
  approve: boolean,
): Promise<void> {
  // 주문 조회 — 계좌별 store에서 검색
  let order: Record<string, unknown> | null = null;
  let orderStore: typeof localStore = localStore;

  // 먼저 글로벌 store에서 검색
  order = localStore.getPendingOrder<Record<string, unknown>>(orderId);

  // 없으면 각 계좌 store에서 검색
  if (!order) {
    for (const ctx of getEnabledAccounts()) {
      order = ctx.store.getPendingOrder<Record<string, unknown>>(orderId);
      if (order) {
        orderStore = ctx.store as unknown as typeof localStore;
        break;
      }
    }
  }

  if (!order) {
    await answerCallbackQuery(query.id, '주문을 찾을 수 없습니다.');
    return;
  }

  if (order.status !== 'pending') {
    await answerCallbackQuery(query.id, `이미 처리된 주문입니다 (${order.status})`);
    return;
  }

  if (!approve) {
    // ── 거부 ──
    orderStore.setPendingOrder(orderId, {
      ...order,
      status: 'rejected',
      rejectedAt: new Date().toISOString(),
    });

    await answerCallbackQuery(query.id, '주문이 거부되었습니다.');

    const ticker = order.ticker as string || '?';
    const typeLabel = order.type === 'buy' ? '매수' : order.type === 'sell' ? '매도' : '매매';
    await editTelegramMessage(chatId, messageId,
      `❌ <b>${ticker} ${typeLabel} 주문 거부됨</b>\n\n주문 ID: ${orderId}\n거부 시각: ${new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })}`);
    return;
  }

  // ── 승인 → 실행 ──
  await answerCallbackQuery(query.id, '⏳ 주문 실행 중...');

  const ticker = order.ticker as string;
  const accountId = order.accountId as string;
  const strategy = order.strategy as string;
  const orders = (order.orders || order.buyOrders || order.sellOrders || []) as Array<{
    orderType: string;
    price: number;
    quantity: number;
    amount?: number;
    label?: string;
    side?: string;
  }>;

  // 계좌 컨텍스트 찾기
  const accounts = getEnabledAccounts();
  const ctx = accounts.find(a => a.accountId === accountId);

  if (!ctx) {
    await editTelegramMessage(chatId, messageId,
      `❌ <b>주문 실행 실패</b>\n\n계좌를 찾을 수 없습니다: ${accountId}`);
    orderStore.setPendingOrder(orderId, { ...order, status: 'error', error: 'account_not_found' });
    return;
  }

  try {
    const { credentials, kisClient } = ctx;
    let accessToken = await getOrRefreshToken(
      '', accountId,
      { appKey: credentials.appKey, appSecret: credentials.appSecret },
      kisClient,
    );

    const results: string[] = [];
    let allSuccess = true;

    // 복합 주문 처리 (combined: buyOrders + sellOrders)
    const allOrders: Array<{ side: 'BUY' | 'SELL'; orderType: string; price: number; quantity: number; label?: string }> = [];

    if (order.type === 'combined') {
      const buyOrders = (order.buyOrders || []) as Array<{ orderType: string; price: number; quantity: number; label?: string }>;
      const sellOrders = (order.sellOrders || []) as Array<{ orderType: string; price: number; quantity: number; label?: string }>;
      for (const o of buyOrders) allOrders.push({ ...o, side: 'BUY' });
      for (const o of sellOrders) allOrders.push({ ...o, side: 'SELL' });
    } else {
      const side: 'BUY' | 'SELL' = order.type === 'sell' ? 'SELL' : 'BUY';
      for (const o of orders) {
        allOrders.push({ ...o, side: o.side as 'BUY' | 'SELL' || side });
      }
    }

    if (allOrders.length === 0) {
      await editTelegramMessage(chatId, messageId,
        `❌ <b>주문 실행 실패</b>\n\n실행할 주문 내역이 없습니다.`);
      orderStore.setPendingOrder(orderId, { ...order, status: 'error', error: 'no_orders' });
      return;
    }

    for (const sub of allOrders) {
      try {
        // 해외(VR/DDSOB) vs 국내 분기
        const isDomestic = !credentials.accountNo.includes('-') || ticker.match(/^\d{6}$/);
        let orderRes;

        if (isDomestic) {
          orderRes = await kisClient.submitDomesticOrder(
            credentials.appKey, credentials.appSecret, accessToken, credentials.accountNo,
            {
              ticker,
              side: sub.side,
              orderType: sub.orderType === 'MARKET' ? 'MARKET' : 'LIMIT',
              price: sub.price,
              quantity: sub.quantity,
            },
          );
        } else {
          orderRes = await kisClient.submitOrder(
            credentials.appKey, credentials.appSecret, accessToken, credentials.accountNo,
            {
              ticker,
              side: sub.side,
              orderType: sub.orderType as 'LOC' | 'LIMIT' | 'MOC' | 'MOO' | 'LOO',
              price: sub.price,
              quantity: sub.quantity,
            },
          );
        }

        if (orderRes.rt_cd === '0') {
          const orderNo = orderRes.output?.ODNO || orderRes.output?.ODNO || '';
          results.push(`✅ ${sub.side} ${sub.quantity}주 @ $${sub.price} (${orderNo})`);
        } else {
          allSuccess = false;
          results.push(`❌ ${sub.side} ${sub.quantity}주: ${orderRes.msg1 || 'unknown error'}`);
        }
      } catch (subErr) {
        if (isTokenExpiredError(subErr)) {
          try {
            accessToken = await getOrRefreshToken('', accountId, { appKey: credentials.appKey, appSecret: credentials.appSecret }, kisClient, true);
            const isDomestic2 = !credentials.accountNo.includes('-') || ticker.match(/^\d{6}$/);
            const retryRes = isDomestic2
              ? await kisClient.submitDomesticOrder(credentials.appKey, credentials.appSecret, accessToken, credentials.accountNo,
                  { ticker, side: sub.side, orderType: sub.orderType === 'MARKET' ? 'MARKET' : 'LIMIT', price: sub.price, quantity: sub.quantity })
              : await kisClient.submitOrder(credentials.appKey, credentials.appSecret, accessToken, credentials.accountNo,
                  { ticker, side: sub.side, orderType: sub.orderType as 'LOC' | 'LIMIT' | 'MOC' | 'MOO' | 'LOO', price: sub.price, quantity: sub.quantity });
            if (retryRes.rt_cd === '0') {
              results.push(`✅ ${sub.side} ${sub.quantity}주 @ $${sub.price} (${retryRes.output?.ODNO || ''}, 토큰재발급)`);
              continue;
            }
          } catch { /* retry failed */ }
        }
        allSuccess = false;
        results.push(`❌ ${sub.side} ${sub.quantity}주: ${subErr instanceof Error ? subErr.message : String(subErr)}`);
      }

      // API 호출 간 딜레이
      await new Promise(resolve => setTimeout(resolve, 500));
    }

    // 상태 업데이트
    orderStore.setPendingOrder(orderId, {
      ...order,
      status: allSuccess ? 'executed' : 'partial',
      approvedAt: new Date().toISOString(),
      executedAt: new Date().toISOString(),
      executionResults: results,
    });

    const typeLabel = order.type === 'buy' ? '매수' : order.type === 'sell' ? '매도' : '매매';
    const statusIcon = allSuccess ? '✅' : '⚠️';
    const statusText = allSuccess ? '체결 완료' : '일부 실패';

    await editTelegramMessage(chatId, messageId,
      `${statusIcon} <b>${ticker} ${typeLabel} ${statusText}</b>\n\n` +
      `전략: ${strategy}\n` +
      `계좌: ${ctx.nickname}\n\n` +
      results.join('\n') +
      `\n\n주문 ID: ${orderId}`);

  } catch (err) {
    orderStore.setPendingOrder(orderId, {
      ...order,
      status: 'error',
      error: err instanceof Error ? err.message : String(err),
    });

    await editTelegramMessage(chatId, messageId,
      `❌ <b>${ticker} 주문 실행 실패</b>\n\n${err instanceof Error ? err.message : String(err)}`);
  }
}

// ==================== 명령어 구현 ====================

async function cmdHelp(chatId: string): Promise<void> {
  await sendTelegramMessage(chatId,
    `🤖 <b>IDCA Local 명령어</b>\n\n` +
    `/status — 현재 설정 상태\n` +
    `/trading on — 매매 활성화\n` +
    `/trading off — 매매 비활성화\n` +
    `/positions — 보유 종목 목록\n` +
    `/stop [종목코드] — 종목 강제 종료\n` +
    `/help — 이 도움말`,
    'HTML'
  );
}

async function cmdStatus(chatId: string): Promise<void> {
  const common = getCommonConfig();

  if (!common) {
    await sendTelegramMessage(chatId, '⚠️ 설정 파일이 없습니다. 웹 UI에서 초기 설정을 해주세요.');
    return;
  }

  const dm = common.domestic || { enabled: false, strategy: null };
  const ov = common.overseas || { enabled: false, strategy: null };

  const lines = [
    `📊 <b>IDCA Local 상태</b>\n`,
    `매매: ${common.tradingEnabled ? '✅ 활성' : '❌ 비활성'}`,
    `자동승인: ${common.autoApprove ? 'ON' : 'OFF'}`,
    ``,
    `🇰🇷 국내: ${dm.enabled ? '✅' : '❌'} ${dm.strategy || '전략 없음'}`,
    `🇺🇸 해외: ${ov.enabled ? '✅' : '❌'} ${ov.strategy || '전략 없음'}`,
  ];

  // 보유 종목 수
  const rdStates = localStore.getAllStates('realtimeDdsobV2State');
  const scalpStates = localStore.getAllStates('momentumScalpState');
  if (rdStates.size > 0 || scalpStates.size > 0) {
    lines.push('');
    if (rdStates.size > 0) lines.push(`실사오팔 보유: ${rdStates.size}종목`);
    if (scalpStates.size > 0) lines.push(`스캘핑 보유: ${scalpStates.size}종목`);
  }

  await sendTelegramMessage(chatId, lines.join('\n'), 'HTML');
}

async function cmdTrading(chatId: string, text: string): Promise<void> {
  const arg = text.replace('/trading', '').trim().toLowerCase();

  if (arg === 'on') {
    setCommonConfig({ tradingEnabled: true });
    await sendTelegramMessage(chatId, '✅ 매매 활성화');
  } else if (arg === 'off') {
    setCommonConfig({ tradingEnabled: false });
    await sendTelegramMessage(chatId, '❌ 매매 비활성화');
  } else {
    const common = getCommonConfig();
    const status = common?.tradingEnabled ? 'ON' : 'OFF';
    await sendTelegramMessage(chatId, `현재 매매: ${status}\n\n/trading on 또는 /trading off`);
  }
}

async function cmdStop(chatId: string, text: string): Promise<void> {
  const ticker = text.replace('/stop', '').trim().toUpperCase();

  if (!ticker) {
    // 보유 종목 목록 + 강제종료 버튼
    const rdStates = localStore.getAllStates<Record<string, unknown>>('realtimeDdsobV2State');
    const scalpStates = localStore.getAllStates<Record<string, unknown>>('momentumScalpState');

    if (rdStates.size === 0 && scalpStates.size === 0) {
      await sendTelegramMessage(chatId, '보유 종목이 없습니다.');
      return;
    }

    const buttons: Array<Array<{ text: string; callback_data: string }>> = [];
    for (const [t, state] of rdStates) {
      const market = (state.market as string) || 'domestic';
      buttons.push([{ text: `🔴 ${t} (${state.stockName || t})`, callback_data: `fs:${t}:${market}:realtimeDdsobV2` }]);
    }
    for (const [t, state] of scalpStates) {
      buttons.push([{ text: `🔴 ${t} (${state.stockName || t})`, callback_data: `fs:${t}:domestic:momentumScalp` }]);
    }

    await sendTelegramMessage(chatId, '🛑 <b>강제 종료할 종목을 선택하세요</b>', 'HTML', buttons);
    return;
  }

  // 직접 종목 코드 지정
  const rdState = localStore.getState<Record<string, unknown>>('realtimeDdsobV2State', ticker);
  if (rdState) {
    const market = ((rdState.market as string) || 'domestic') as MarketType;
    await sendTelegramMessage(chatId, `⏳ ${ticker} 강제종료 중...`);
    const result = await forceStopRealtimeDdsobV2Ticker(ticker, market, 'force_stop', 'realtimeDdsobV2');
    await sendTelegramMessage(chatId, result.success ? `✅ ${ticker} 종료: ${result.message}` : `❌ ${ticker} 실패: ${result.message}`);
    return;
  }

  const scalpState = localStore.getState<Record<string, unknown>>('momentumScalpState', ticker);
  if (scalpState) {
    // 스캘핑 강제종료 — 상태 삭제
    localStore.deleteState('momentumScalpState', ticker);
    await sendTelegramMessage(chatId, `✅ ${ticker} 스캘핑 상태 제거 완료`);
    return;
  }

  await sendTelegramMessage(chatId, `❓ ${ticker} — 보유 종목에 없습니다.`);
}

async function cmdPositions(chatId: string): Promise<void> {
  const rdStates = localStore.getAllStates<Record<string, unknown>>('realtimeDdsobV2State');
  const scalpStates = localStore.getAllStates<Record<string, unknown>>('momentumScalpState');

  if (rdStates.size === 0 && scalpStates.size === 0) {
    await sendTelegramMessage(chatId, '📭 보유 종목 없음');
    return;
  }

  const lines: string[] = ['📋 <b>보유 종목</b>\n'];

  if (rdStates.size > 0) {
    lines.push('<b>실사오팔v2:</b>');
    for (const [ticker, state] of rdStates) {
      const name = (state.stockName as string) || ticker;
      const status = state.status as string;
      const buyCount = Array.isArray(state.buyRecords) ? state.buyRecords.length : 0;
      const split = (state.splitCount as number) || '?';
      lines.push(`  ${ticker} ${name} [${status}] ${buyCount}/${split}회`);
    }
  }

  if (scalpStates.size > 0) {
    lines.push('\n<b>모멘텀 스캘핑:</b>');
    for (const [ticker, state] of scalpStates) {
      const name = (state.stockName as string) || ticker;
      const status = state.status as string;
      const entry = state.entryPrice ? `@${state.entryPrice}` : '';
      lines.push(`  ${ticker} ${name} [${status}] ${entry}`);
    }
  }

  await sendTelegramMessage(chatId, lines.join('\n'), 'HTML');
}
