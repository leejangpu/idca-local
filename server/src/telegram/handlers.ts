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

  await answerCallbackQuery(query.id);
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
