# taobao-ai-translator

Tampermonkey userscript for AI-powered Taobao/Tmall page translation (product pages, specs, reviews).

## Install

1. Install [Tampermonkey](https://www.tampermonkey.net/).
2. Create a new script and paste the contents of [`taobao-ai-translator.user.js`](./taobao-ai-translator.user.js), or install from raw URL once published.

## Usage

- Open any Taobao/Tmall page — translation runs automatically (configurable).
- Click **🇷🇺 Перевести** (bottom-right) to re-translate manually.
- Tampermonkey menu → **⚙ Настройки переводчика** — set OpenAI API key, target language, auto-translate.

## Engines

- **OpenAI** (`gpt-4o-mini`) — context-aware translation when API key is set.
- **Google Translate** — fallback when no key or on API errors.
