# Yandex Metrika for Claude

This plugin adds the read-only Yandex Metrika (Яндекс Метрика) MCP server to Claude Code and to Cowork sessions on your computer. Ask about traffic, sources, landing pages and goals; every answer states exact dates, the counter time zone, sampling and filters, so the numbers can be checked.

After installing, ask Claude to connect Yandex Metrika. It calls `metrika_connect` and gives you a local sign-in link: you sign in with Yandex in the browser and approve read-only access. No API key is needed and the token never enters the chat. A synthetic demo connection, `conn_demo`, works without an account.

The plugin runs `npx -y @dev-crabs/yandex-metrika-mcp@1.0.0` and needs Node.js 22.13 or later. Documentation, privacy and security details: https://github.com/DevCrabs-Inc/yandex-metrika-mcp.

License: MIT.
