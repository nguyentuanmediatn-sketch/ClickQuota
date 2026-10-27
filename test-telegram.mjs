#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { createTelegramNotifier } from './src/alert/telegram-notifier.mjs';

export async function main({ env = process.env, fetchImpl = globalThis.fetch, log = console.log } = {}) {
  const notifier = createTelegramNotifier({ env, fetchImpl });
  if (!notifier.enabled) {
    log('Chưa cấu hình Telegram: đặt TELEGRAM_BOT_TOKEN và TELEGRAM_CHAT_ID trong .env.');
    return 0;
  }
  // Keep the CLI alive while the notifier uses its unref timeout.
  const keepAlive = setInterval(() => {}, 1000);
  try {
    const { ok } = await notifier.sendTestMessage();
    log(ok ? 'Đã gửi tin nhắn kiểm thử Telegram.' : 'Gửi Telegram thất bại hoặc hết thời gian. Kiểm tra cấu hình và kết nối.');
    return ok ? 0 : 1;
  } catch {
    log('Gửi Telegram thất bại. Không hiển thị thông tin bí mật.');
    return 1;
  } finally { clearInterval(keepAlive); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await main();
