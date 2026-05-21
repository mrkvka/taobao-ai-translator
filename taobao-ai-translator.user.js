// ==UserScript==
// @name         Taobao AI Translator (RU)
// @namespace    https://github.com/mrkvka/taobao-ai-translator
// @version      1.2.0
// @description  Контекстный перевод Taobao/Tmall (товар, характеристики, отзывы)
// @author       cursor
// @match        https://*.taobao.com/*
// @match        https://*.tmall.com/*
// @match        https://taobao.com/*
// @match        https://tmall.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_registerMenuCommand
// @connect      api.openai.com
// @connect      translate.googleapis.com
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  const CFG = {
    apiKey: GM_getValue('apiKey', ''),
    lang: GM_getValue('lang', 'ru'),
    auto: GM_getValue('auto', true),
    engine: GM_getValue('engine', 'auto'),
  };

  const CACHE = new Map();
  const CHINESE = /[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]/;
  const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'CODE', 'SVG', 'INPUT', 'TEXTAREA']);
  const MIN_LEN = 2;
  const GOOGLE_LINES = 40;
  const GOOGLE_PARALLEL = 10;
  const AI_CHUNK = 100;
  const AI_PARALLEL = 3;
  const BLOCK_SEL =
    'h1,h2,h3,h4,li,tr,td,th,article,section,[class*="title"],[class*="Title"],[class*="desc"],[class*="Desc"],[class*="spec"],[class*="Spec"],[class*="attr"],[class*="sku"],[class*="param"],[class*="review"],[class*="Review"],[class*="item"],[class*="Item"]';

  GM_registerMenuCommand('⚙ Настройки переводчика', openSettings);

  function openSettings() {
    const key = prompt('OpenAI API key (пусто = Google, хуже контекст):', CFG.apiKey) ?? CFG.apiKey;
    const lang = prompt('Язык (ru, en, uk...):', CFG.lang) ?? CFG.lang;
    const auto = confirm('Авто-перевод при загрузке?\nOK = да, Отмена = нет');
    GM_setValue('apiKey', key.trim());
    GM_setValue('lang', (lang || 'ru').trim());
    GM_setValue('auto', auto);
    location.reload();
  }

  function http(opts) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({ ...opts, onload: (r) => resolve(r), onerror: reject });
    });
  }

  function getPageContext() {
    const url = location.href;
    let pageType = 'browse';
    if (/item\.(taobao|tmall)|detail\.tmall|\/i\d+/i.test(url)) pageType = 'product';
    else if (/s\.taobao|search\.taobao|q=/.test(url)) pageType = 'search';
    else if (/cart|buy\.taobao/i.test(url)) pageType = 'cart';
    else if (/shop\./i.test(url)) pageType = 'shop';

    const titleEl = document.querySelector(
      'h1,[class*="MainTitle"],[class*="ItemTitle"],[class*="mainTitle"],[data-title]'
    );
    const productTitle = (titleEl?.innerText || document.title || '').trim().slice(0, 280);

    return { pageType, productTitle, host: location.hostname };
  }

  let pageCtx = getPageContext();

  function getBlockRoot(el) {
    return el.closest(BLOCK_SEL) || el.parentElement?.closest('div,span,p') || el.parentElement;
  }

  function detectSection(block, el) {
    const blob = ((block?.className || '') + ' ' + (el?.className || '')).toString();
    if (/title|Title|mainTitle/i.test(blob) || block?.tagName === 'H1') return 'title';
    if (/desc|detail|Detail|content/i.test(blob)) return 'description';
    if (/sku|spec|attr|param|property|Property/i.test(blob)) return 'spec';
    if (/review|comment|rate|feedback/i.test(blob)) return 'review';
    if (/shop|seller|store/i.test(blob)) return 'seller';
    if (/service|logistic|ship|freight/i.test(blob)) return 'shipping';
    if (/price|Price|promo|coupon/i.test(blob)) return 'promo';
    return 'ui';
  }

  function cacheKey(text) {
    return `${CFG.lang}|${text}`;
  }

  function collectItems(root = document.body) {
    const items = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(n) {
        const p = n.parentElement;
        if (!p || SKIP.has(p.tagName) || p.closest('[data-tb-tr]')) return NodeFilter.FILTER_REJECT;
        if (p.isContentEditable || p.hidden) return NodeFilter.FILTER_REJECT;
        const t = n.textContent.trim();
        if (t.length < MIN_LEN || !CHINESE.test(t)) return NodeFilter.FILTER_REJECT;
        const st = getComputedStyle(p);
        if (st.display === 'none' || st.visibility === 'hidden' || +st.opacity === 0)
          return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    let n;
    while ((n = walker.nextNode())) {
      const text = n.textContent.trim();
      const block = getBlockRoot(n.parentElement);
      items.push({ node: n, text, section: detectSection(block, n.parentElement) });
    }
    return items;
  }

  function chunk(arr, size) {
    const out = [];
    for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
    return out;
  }

  async function runPool(tasks, concurrency) {
    const results = new Array(tasks.length);
    let next = 0;
    async function worker() {
      while (next < tasks.length) {
        const i = next++;
        results[i] = await tasks[i]();
      }
    }
    await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, worker));
    return results;
  }

  async function translateGoogleBulk(texts, tl) {
    if (!texts.length) return [];
    const joined = texts.join('\n');
    const url =
      'https://translate.googleapis.com/translate_a/single?client=gtx&sl=zh-CN&tl=' +
      encodeURIComponent(tl) +
      '&dt=t&q=' +
      encodeURIComponent(joined);
    const r = await http({ method: 'GET', url });
    const data = JSON.parse(r.responseText);
    const full = (data[0] || []).map((x) => x[0]).join('');
    const lines = full.split('\n').map((s) => s.trim());
    if (lines.length === texts.length) return lines;
    if (texts.length === 1) return [full.trim()];
    return texts.map((t, i) => lines[i]?.trim() || full.trim());
  }

  async function translateOpenAIChunk(texts, tl, ctx) {
    const payload = {
      page: ctx,
      targetLang: tl,
      items: texts.map((text, i) => ({ id: i + 1, text })),
    };
    const r = await http({
      method: 'POST',
      url: 'https://api.openai.com/v1/chat/completions',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + CFG.apiKey,
      },
      data: JSON.stringify({
        model: 'gpt-4o-mini',
        temperature: 0.1,
        response_format: { type: 'json_object' },
        messages: [
          {
            role: 'system',
            content: `Translate Chinese Taobao/Tmall e-commerce UI to ${tl}. Page: ${ctx.pageType}, product: ${ctx.productTitle || 'n/a'}. Keep brands/SKU codes. Return JSON: {"items":[{"id":number,"text":"translation"}]} — same ids, same count.`,
          },
          { role: 'user', content: JSON.stringify(payload) },
        ],
      }),
    });
    if (r.status !== 200) throw new Error(r.responseText);
    const body = JSON.parse(r.responseText);
    const parsed = JSON.parse(body.choices?.[0]?.message?.content || '{}');
    const map = new Map((parsed.items || []).map((x) => [x.id, x.text]));
    return texts.map((t, i) => map.get(i + 1)?.trim() || t);
  }

  async function translateUnique(texts, tl, onChunk) {
    const useAI = CFG.engine === 'openai' || (CFG.engine === 'auto' && CFG.apiKey.length > 10);
    const chunks = chunk(texts, useAI ? AI_CHUNK : GOOGLE_LINES);

    const tasks = chunks.map((part) => async () => {
      let translated;
      try {
        translated = useAI ? await translateOpenAIChunk(part, tl, pageCtx) : await translateGoogleBulk(part, tl);
      } catch {
        translated = await translateGoogleBulk(part, tl);
      }
      part.forEach((src, i) => {
        const tr = translated[i] || src;
        CACHE.set(cacheKey(src), tr);
      });
      onChunk(part, translated);
      return translated;
    });

    await runPool(tasks, useAI ? AI_PARALLEL : GOOGLE_PARALLEL);
  }

  function applyToNodes(items, textMap) {
    for (const it of items) {
      const tr = textMap.get(it.text);
      if (!tr || tr === it.text) continue;
      const el = it.node.parentElement;
      if (!el || el.dataset.tbTr) continue;
      el.dataset.tbTr = '1';
      el.title = it.text;
      it.node.textContent = it.node.textContent.replace(it.text, tr);
    }
  }

  let busy = false;
  let runId = 0;

  async function runTranslate() {
    if (busy) return;
    busy = true;
    const id = ++runId;
    const status = document.getElementById('tb-tr-status');
    try {
      pageCtx = getPageContext();
      const items = collectItems();
      const byText = new Map();
      for (const it of items) {
        if (!byText.has(it.text)) byText.set(it.text, []);
        byText.get(it.text).push(it);
      }

      const todo = [...byText.keys()].filter((t) => !CACHE.has(cacheKey(t)));

      const cachedMap = new Map();
      for (const t of byText.keys()) {
        const tr = CACHE.get(cacheKey(t));
        if (tr) cachedMap.set(t, tr);
      }
      applyToNodes(items, cachedMap);

      if (!todo.length) {
        if (status) status.textContent = '✓';
        return;
      }

      let left = todo.length;
      if (status) status.textContent = `… ${left}`;

      await translateUnique(todo, CFG.lang, (part, translated) => {
        if (id !== runId) return;
        const map = new Map(part.map((t, i) => [t, translated[i] || t]));
        applyToNodes(part.flatMap((t) => byText.get(t) || []), map);
        left -= part.length;
        if (status) status.textContent = left > 0 ? `… ${left}` : '✓';
      });

      if (id === runId && status) status.textContent = '✓';
    } catch (e) {
      console.error('[Taobao TR]', e);
      const status = document.getElementById('tb-tr-status');
      if (status) status.textContent = '✗';
    } finally {
      busy = false;
    }
  }

  function makeUI() {
    const wrap = document.createElement('div');
    Object.assign(wrap.style, {
      position: 'fixed',
      bottom: '20px',
      right: '20px',
      zIndex: '2147483646',
      display: 'flex',
      gap: '6px',
      alignItems: 'center',
    });

    const btn = document.createElement('button');
    btn.textContent = '🇷🇺 Перевести';
    Object.assign(btn.style, {
      padding: '10px 14px',
      border: 'none',
      borderRadius: '8px',
      background: '#ff5000',
      color: '#fff',
      font: 'bold 14px/1 system-ui,sans-serif',
      cursor: 'pointer',
      boxShadow: '0 2px 12px rgba(0,0,0,.25)',
    });

    const status = document.createElement('span');
    status.id = 'tb-tr-status';
    status.textContent = '…';
    Object.assign(status.style, {
      padding: '6px 10px',
      borderRadius: '8px',
      background: 'rgba(0,0,0,.65)',
      color: '#fff',
      font: '12px/1 system-ui,sans-serif',
    });

    btn.onclick = () => {
      CACHE.clear();
      runId++;
      runTranslate();
    };

    wrap.append(btn, status);
    document.body.appendChild(wrap);
  }

  let debounce;
  const obs = new MutationObserver(() => {
    if (!CFG.auto) return;
    clearTimeout(debounce);
    debounce = setTimeout(runTranslate, 600);
  });

  makeUI();
  if (CFG.auto) runTranslate();
  obs.observe(document.body, { childList: true, subtree: true });
})();
