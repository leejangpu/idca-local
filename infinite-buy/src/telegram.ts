/**
 * Telegram 알림 — 사이클 완료 + 에러만 전송
 */

const TELEGRAM_API = 'https://api.telegram.org/bot';

function getConfig() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  return { token, chatId };
}

export async function sendTelegram(text: string): Promise<void> {
  const { token, chatId } = getConfig();
  if (!token || !chatId) return;

  try {
    await fetch(`${TELEGRAM_API}${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      }),
    });
  } catch (err) {
    console.error('[Telegram] 전송 실패:', err);
  }
}

export async function notifyCycleCompleted(
  ticker: string, cycleNumber: number, profit: number, profitRate: number
): Promise<void> {
  await sendTelegram(
    `🎯 <b>무한매수법 사이클 완료</b>\n\n` +
    `종목: <b>${ticker}</b>\n` +
    `사이클: #${cycleNumber}\n` +
    `수익: $${profit.toFixed(2)} (${(profitRate * 100).toFixed(2)}%)\n` +
    `전략: V2.2`
  );
}

export async function notifyError(context: string, error: string): Promise<void> {
  await sendTelegram(
    `❌ <b>무한매수법 오류</b>\n\n` +
    `단계: ${context}\n` +
    `오류: ${error}`
  );
}
