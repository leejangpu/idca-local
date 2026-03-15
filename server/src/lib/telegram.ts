/**
 * Telegram Bot 알림 서비스 — 로컬 버전
 * Firebase 의존성 제거, 환경변수에서 직접 읽기
 */

const TELEGRAM_API_URL = 'https://api.telegram.org/bot';

interface InlineKeyboardButton {
  text: string;
  callback_data?: string;
  url?: string;
}

interface TelegramMessage {
  chat_id: string;
  text: string;
  parse_mode?: 'HTML' | 'Markdown' | 'MarkdownV2';
  disable_web_page_preview?: boolean;
  reply_markup?: {
    inline_keyboard: InlineKeyboardButton[][];
  };
}

interface TelegramResponse {
  ok: boolean;
  result?: {
    message_id?: number;
    [key: string]: unknown;
  };
  description?: string;
}

interface SendMessageResult {
  success: boolean;
  messageId?: number;
}

function getBotToken(): string {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN is not configured');
  return token;
}

export async function sendTelegramMessage(
  chatId: string,
  text: string,
  parseMode: 'HTML' | 'Markdown' = 'HTML',
  inlineKeyboard?: InlineKeyboardButton[][]
): Promise<boolean> {
  const result = await sendTelegramMessageWithId(chatId, text, parseMode, inlineKeyboard);
  return result.success;
}

export async function sendTelegramMessageWithId(
  chatId: string,
  text: string,
  parseMode: 'HTML' | 'Markdown' = 'HTML',
  inlineKeyboard?: InlineKeyboardButton[][]
): Promise<SendMessageResult> {
  try {
    const token = getBotToken();
    const message: TelegramMessage = {
      chat_id: chatId,
      text,
      parse_mode: parseMode,
      disable_web_page_preview: true,
    };

    if (inlineKeyboard) {
      message.reply_markup = { inline_keyboard: inlineKeyboard };
    }

    const response = await fetch(`${TELEGRAM_API_URL}${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(message),
    });

    const data = await response.json() as TelegramResponse;
    if (data.ok) {
      return { success: true, messageId: data.result?.message_id };
    }
    console.error('[Telegram] 메시지 전송 실패:', data.description);
    return { success: false };
  } catch (err) {
    console.error('[Telegram] 메시지 전송 오류:', err);
    return { success: false };
  }
}

/**
 * 텔레그램 chatId 조회 — 환경변수에서 직접 읽기 (단일 사용자)
 */
export async function getUserTelegramChatId(_userId?: string): Promise<string | null> {
  return process.env.ADMIN_TELEGRAM_CHAT_ID || null;
}

/**
 * 텔레그램 메시지 편집
 */
export async function editTelegramMessage(
  chatId: string,
  messageId: number,
  text: string,
  parseMode: 'HTML' | 'Markdown' = 'HTML',
  inlineKeyboard?: InlineKeyboardButton[][]
): Promise<boolean> {
  try {
    const token = getBotToken();
    const body: Record<string, unknown> = {
      chat_id: chatId,
      message_id: messageId,
      text,
      parse_mode: parseMode,
      disable_web_page_preview: true,
    };
    if (inlineKeyboard) {
      body.reply_markup = { inline_keyboard: inlineKeyboard };
    }
    const response = await fetch(`${TELEGRAM_API_URL}${token}/editMessageText`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await response.json() as TelegramResponse;
    return data.ok;
  } catch (err) {
    console.error('[Telegram] 메시지 편집 오류:', err);
    return false;
  }
}

/**
 * 텔레그램 콜백 쿼리 응답
 */
export async function answerCallbackQuery(
  callbackQueryId: string,
  text?: string
): Promise<boolean> {
  try {
    const token = getBotToken();
    const response = await fetch(`${TELEGRAM_API_URL}${token}/answerCallbackQuery`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        callback_query_id: callbackQueryId,
        text,
      }),
    });
    const data = await response.json() as TelegramResponse;
    return data.ok;
  } catch {
    return false;
  }
}
