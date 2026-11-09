# Установка

## Требования

- Node.js **22.13** или новее (`node --version`). Нужен встроенный SQLite и современный JSON-парсер.
- MCP-клиент: Claude Desktop, Claude Code, Cursor, VS Code, Windsurf, Codex или любой клиент с поддержкой stdio.
- Яндекс-аккаунт с доступом к счётчику (достаточно права на просмотр).

Свой OAuth-токен, своё приложение в Яндекс ID и API-ключ LLM не нужны.

## Мастер настройки

Команда добавляет сервер в конфиг выбранного клиента. Остальные настройки сохраняются, рядом создаётся резервная копия `*.bak-<время>`.

```bash
npx -y @devcrabs/yandex-metrika-mcp setup --client claude-desktop
```

| `--client`       | Что делает                                                                |
| ---------------- | ------------------------------------------------------------------------- |
| `claude-desktop` | Правит `claude_desktop_config.json`                                       |
| `cursor`         | Правит `~/.cursor/mcp.json`                                               |
| `vscode`         | Правит пользовательский `mcp.json` VS Code                                |
| `windsurf`       | Правит `~/.codeium/windsurf/mcp_config.json`                              |
| `codex`          | Добавляет таблицу `[mcp_servers.yandex-metrika]` в `~/.codex/config.toml` |
| `claude-code`    | Печатает команду `claude mcp add …`                                       |

Флаги:

- `--dry-run` показывает результат и ничего не записывает;
- `--remove` удаляет сервер из конфига;
- `--launcher node` запускает текущую установку вместо `npx`.

После изменения перезапустите клиент.

## Ручная настройка

Для большинства клиентов:

```json
{
  "mcpServers": {
    "yandex-metrika": { "command": "npx", "args": ["-y", "@devcrabs/yandex-metrika-mcp"] }
  }
}
```

На Windows клиенты запускают команду без оболочки, поэтому используйте `"command": "cmd", "args": ["/c", "npx", "-y", "@devcrabs/yandex-metrika-mcp"]`.

## Claude Desktop: пакет MCPB

В релизах на GitHub лежит файл `yandex-metrika-mcp-<версия>.mcpb`. Откройте его двойным щелчком, Claude Desktop покажет окно установки. Для работы нужен Node.js 22.13 или новее; если встроенный в клиент Node старше, используйте установку через `npx`.

## Docker

```bash
docker build -t yandex-metrika-mcp .
docker run -i --rm -e YANDEX_METRIKA_TOKEN -v ymmcp:/data yandex-metrika-mcp
```

В контейнере нет системного хранилища паролей. Передайте токен через `YANDEX_METRIKA_TOKEN` или явно включите файловое хранилище: `-e YM_MCP_SECRET_STORE=file`. Файл лежит в томе `/data` и доступен только пользователю контейнера.

## Проверка

```bash
npx -y @devcrabs/yandex-metrika-mcp doctor
npx -y @devcrabs/yandex-metrika-mcp demo
```

`doctor` показывает версию Node, состояние базы, хранилища токенов и входа. Флаг `--network` дополнительно проверяет доступность серверов Яндекса. `demo` печатает пример сравнения на синтетических данных.
