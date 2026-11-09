/** Self-contained HTML for the local sign-in flow: no scripts, no external resources. */

const escapeHtml = (value: string): string =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

function layout(title: string, body: string): string {
  return `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  body { font: 16px/1.5 system-ui, sans-serif; max-width: 640px; margin: 40px auto; padding: 0 16px; color: #1d1d1f; background: #fff; }
  h1 { font-size: 22px; }
  .en { color: #666; font-size: 14px; }
  .box { border: 1px solid #ddd; border-radius: 8px; padding: 12px 16px; margin: 16px 0; }
  a.button, button { display: inline-block; background: #fc3f1d; color: #fff; border: 0; border-radius: 8px; padding: 10px 18px; font-size: 16px; text-decoration: none; cursor: pointer; }
  label { display: block; margin: 6px 0; }
  code { background: #f4f4f4; padding: 1px 4px; border-radius: 4px; }
  @media (prefers-color-scheme: dark) { body { background: #111; color: #eee; } .box { border-color: #333; } code { background: #222; } .en { color: #aaa; } }
</style>
</head>
<body>
${body}
</body>
</html>`;
}

export function connectPage(startPath: string, alias: string | null): string {
  return layout(
    "Подключение Яндекс Метрики",
    `<h1>Подключение Яндекс Метрики${alias ? ` — ${escapeHtml(alias)}` : ""}</h1>
<p class="en">Connect Yandex Metrika to your AI client.</p>
<div class="box">
  <p><b>Что будет доступно:</b> только чтение статистики и списка счётчиков (право <code>metrika:read</code>). Сервер не может менять счётчики, цели и доступы.</p>
  <p class="en">Read-only access to statistics and the counter list. Nothing can be changed.</p>
  <p><b>Куда пойдут данные:</b> отчёты, которые вы запросите, передаются вашему AI-клиенту и его провайдеру модели. Токен хранится только на этом компьютере и в чат не попадает.</p>
  <p class="en">Reports you request are sent to your AI client and its model provider. The token stays on this computer and never enters the chat.</p>
</div>
<p><a class="button" href="${escapeHtml(startPath)}">Войти через Яндекс</a></p>`,
  );
}

export function selectPage(
  actionPath: string,
  csrf: string,
  counters: readonly { readonly id: string; readonly name: string; readonly site: string }[],
): string {
  const items =
    counters.length === 0
      ? "<p>У этого аккаунта нет доступных счётчиков. Попросите владельца сайта выдать доступ на просмотр.</p>"
      : counters
          .map(
            (c) =>
              `<label><input type="checkbox" name="counter" value="${escapeHtml(c.id)}" checked> ${escapeHtml(c.name || c.site)} <span class="en">(${escapeHtml(c.site)}, ID ${escapeHtml(c.id)})</span></label>`,
          )
          .join("\n");
  return layout(
    "Выбор счётчиков",
    `<h1>Вход выполнен</h1>
<p>Выберите счётчики, которые будут доступны AI-клиенту через это подключение.</p>
<p class="en">Choose which counters the AI client may use through this connection.</p>
<form method="post" action="${escapeHtml(actionPath)}">
  <input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
  <div class="box">${items}</div>
  <button type="submit">Сохранить</button>
</form>`,
  );
}

export function donePage(connectionId: string, counters: number | null): string {
  return layout(
    "Готово",
    `<h1>Готово</h1>
<p>Подключение <code>${escapeHtml(connectionId)}</code> создано${counters === null ? "" : `, доступно счётчиков: ${counters}`}. Можно закрыть вкладку и вернуться в AI-клиент.</p>
<p class="en">Connection created. You can close this tab and return to your AI client.</p>`,
  );
}

export function errorPage(message: string): string {
  return layout(
    "Ошибка входа",
    `<h1>Не удалось подключиться</h1>
<p>${escapeHtml(message)}</p>
<p>Запустите подключение заново из AI-клиента (<code>metrika_connect</code>) или командой <code>yandex-metrika-mcp auth login</code>.</p>
<p class="en">Sign-in failed. Start it again from your AI client or the CLI.</p>`,
  );
}
