/**
 * 텔레그램 Long-Polling — webhook 대체
 * getUpdates API로 메시지/콜백 수신
 */

import { handleMessage, handleCallbackQuery } from './handlers';

const TELEGRAM_API = 'https://api.telegram.org/bot';

interface TelegramUpdate {
  update_id: number;
  message?: {
    message_id: number;
    chat: { id: number };
    text?: string;
  };
  callback_query?: {
    id: string;
    message: { chat: { id: number }; message_id: number };
    data: string;
  };
}

let polling = false;

export async function startTelegramPolling(): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    console.log('[Telegram] TELEGRAM_BOT_TOKEN 미설정, polling 비활성화');
    return;
  }

  // 기존 webhook 제거 (polling과 충돌 방지)
  try {
    await fetch(`${TELEGRAM_API}${token}/deleteWebhook`);
    console.log('[Telegram] Webhook 삭제 완료');
  } catch {
    // 무시
  }

  polling = true;
  let offset = 0;

  console.log('[Telegram] Long-polling 시작');

  while (polling) {
    try {
      const res = await fetch(
        `${TELEGRAM_API}${token}/getUpdates?offset=${offset}&timeout=30&allowed_updates=["message","callback_query"]`,
        { signal: AbortSignal.timeout(35000) }
      );

      if (!res.ok) {
        console.error(`[Telegram] getUpdates 실패: ${res.status}`);
        await sleep(5000);
        continue;
      }

      const data = await res.json() as { ok: boolean; result?: TelegramUpdate[] };
      if (!data.ok || !data.result) {
        await sleep(1000);
        continue;
      }

      for (const update of data.result) {
        offset = update.update_id + 1;

        try {
          if (update.callback_query) {
            await handleCallbackQuery(update.callback_query);
          } else if (update.message?.text) {
            await handleMessage(update.message);
          }
        } catch (err) {
          console.error('[Telegram] Update 처리 오류:', err);
        }
      }
    } catch (err) {
      if (err instanceof Error && err.name === 'TimeoutError') {
        // 정상 — long-poll timeout
        continue;
      }
      console.error('[Telegram] Polling 오류:', err);
      await sleep(5000);
    }
  }
}

export function stopTelegramPolling(): void {
  polling = false;
  console.log('[Telegram] Polling 중지');
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
