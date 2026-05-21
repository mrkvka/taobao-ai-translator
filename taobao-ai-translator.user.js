// ==UserScript==
// @name         Taobao AI Translator (RU)
// @namespace    https://github.com/mrkvka/taobao-ai-translator
// @version      1.3.1
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
// @connect      open.er-api.com
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  const CFG = {
    apiKey: GM_getValue('apiKey', ''),
    lang: GM_getValue('lang', 'ru'),
    auto: GM_getValue('auto', true),
    engine: GM_getValue('engine', 'auto'),
    priceRub: GM_getValue('priceRub', false),
  };

  const CACHE = new Map();
  let cnyRubRate = null;
  const CHINESE = /[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]/;
  const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'CODE', 'SVG', 'INPUT', 'TEXTAREA']);
  const MIN_LEN = 2;
  const GOOGLE_LINES = 40;
  const GOOGLE_PARALLEL = 10;
  const AI_CHUNK = 100;
  const AI_PARALLEL = 3;
  const PRICE_SEL =
    '[class*="price" i],[class*="Price"],[class*="amount" i],[class*="Amount"],[class*="money" i],[class*="Money"],[class*="total" i],[class*="Total"],[class*="fee" i],[class*="Fee"],[class*="rmb" i],[class*="RMB"],[class*="currency" i],[class*="Currency"]';
  const BLOCK_SEL =
    'h1,h2,h3,h4,li,tr,td,th,article,section,[class*="title"],[class*="Title"],[class*="desc"],[class*="Desc"],[class*="spec"],[class*="Spec"],[class*="attr"],[class*="sku"],[class*="param"],[class*="review"],[class*="Review"],[class*="item"],[class*="Item"]';

  GM_registerMenuCommand('⚙ Настройки переводчика', openSettings);
  GM_registerMenuCommand(
    (CFG.priceRub ? '✓ ' : '✗ ') + 'Цены в рублях',
    togglePriceRub
  );

  function togglePriceRub() {
    GM_setValue('priceRub', !CFG.priceRub);
    location.reload();
  }

  function openSettings() {
    const key = prompt('OpenAI API key (пусто = Google, хуже контекст):', CFG.apiKey) ?? CFG.apiKey;
    const lang = prompt('Язык (ru, en, uk...):', CFG.lang) ?? CFG.lang;
    const auto = confirm('Авто-перевод при загрузке?\nOK = да, Отмена = нет');
    const priceRub = confirm('Конвертировать все цены в рубли?\nOK = да, Отмена = нет');
    const manualRate = prompt(
      'Курс CNY→RUB (пусто = авто с API):',
      GM_getValue('cnyRubManual', '') || ''
    );
    GM_setValue('apiKey', key.trim());
    GM_setValue('lang', (lang || 'ru').trim());
    GM_setValue('auto', auto);
    GM_setValue('priceRub', priceRub);
    const rate = parseFloat(String(manualRate || '').replace(',', '.'));
    GM_setValue('cnyRubManual', rate > 0 ? rate : 0);
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

  function parseCnyNum(s) {
    return parseFloat(String(s).replace(/,/g, ''));
  }

  function formatRub(cny, rate) {
    const rub = cny * rate;
    if (rub >= 1000) return Math.round(rub).toLocaleString('ru-RU') + ' ₽';
    if (rub >= 100) return Math.round(rub) + ' ₽';
    const rounded = Math.round(rub * 100) / 100;
    return (Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(2)) + ' ₽';
  }

  function isVisible(el) {
    if (!el || el.hidden) return false;
    const st = getComputedStyle(el);
    return st.display !== 'none' && st.visibility !== 'hidden' && +st.opacity !== 0;
  }

  function isLikelyPriceEl(el) {
    if (!el || !isVisible(el) || el.closest('[data-tb-price]')) return false;
    if (el.closest(PRICE_SEL)) return true;
    const cls = (el.className || '').toString();
    if (
      /price|Price|rmb|RMB|amount|Amount|money|Money|total|Total|fee|Fee|integer|Integer|decimal|Decimal|num|Num|value|Value|currency|Currency|unit|Unit|symbol|Symbol|sale|Sale|promo|Promo|deal|Deal/i.test(
        cls
      )
    )
      return true;
    const c = getComputedStyle(el).color.replace(/\s/g, '');
    if (/255,80,0|#ff5000|#ff4400|#f40|rgb\(255,/.test(c)) return true;
    const t = el.textContent?.trim() || '';
    if (/^\d{2,6}(\.\d{1,2})?$/.test(t)) {
      const fw = getComputedStyle(el).fontWeight;
      if (+fw >= 600 || fw === 'bold') return true;
    }
    return false;
  }

  function ensurePriceCss() {
    if (document.getElementById('tb-price-css')) return;
    const st = document.createElement('style');
    st.id = 'tb-price-css';
    st.textContent =
      '[data-tb-price-hide]{display:none!important;width:0!important;height:0!important;overflow:hidden!important;font-size:0!important}' +
      '[data-tb-price-root]::before,[data-tb-price-root]::after{content:none!important;display:none!important}' +
      '[class*="Price--symbol"],[class*="price--symbol"],[class*="currency--"],[class*="Unit--"],[class*="unit--"]{display:none!important}';
    document.head.appendChild(st);
  }

  function hideYuanSymbol(el) {
    const root = el.closest('[class*="Price"], [class*="price"]') || el.parentElement;
    if (!root) return;
    root.dataset.tbPriceRoot = '1';
    root.querySelectorAll('span, em, i, b, div').forEach((s) => {
      if (s === el || s.dataset.tbPrice) return;
      const t = (s.textContent || '').trim();
      if (!t || /^\d/.test(t)) return;
      if (/^[¥￥\u00a5\uffe5]$/.test(t) || /^\.?\d{0,2}$/.test(t) || /元/.test(t)) {
        s.style.cssText = 'display:none!important;font-size:0!important;width:0!important;overflow:hidden!important';
        s.dataset.tbPriceHide = '1';
      }
    });
  }

  function markPrice(el, orig) {
    el.dataset.tbPrice = '1';
    el.title = /[¥￥\u00a5\uffe5]/.test(orig) ? orig : '¥' + orig.replace(/\s[\s\S]*/, '');
  }

  async function getCnyRubRate() {
    if (cnyRubRate) return cnyRubRate;
    const manual = +GM_getValue('cnyRubManual', 0);
    if (manual > 0) {
      cnyRubRate = manual;
      return manual;
    }
    const saved = GM_getValue('cnyRubRate', 0);
    const savedAt = GM_getValue('cnyRubRateAt', 0);
    if (saved > 0 && Date.now() - savedAt < 6 * 3600000) {
      cnyRubRate = saved;
      return saved;
    }
    try {
      const r = await http({ method: 'GET', url: 'https://open.er-api.com/v6/latest/CNY' });
      const rate = JSON.parse(r.responseText).rates?.RUB;
      if (rate > 0) {
        GM_setValue('cnyRubRate', rate);
        GM_setValue('cnyRubRateAt', Date.now());
        cnyRubRate = rate;
        return rate;
      }
    } catch (e) {
      console.warn('[Taobao TR] rate fetch failed', e);
    }
    cnyRubRate = 12.8;
    return cnyRubRate;
  }

  function convertAnyPrice(text, rate, el) {
    if (!text || /₽/.test(text)) return null;

    if (/[¥￥\u00a5\uffe5]|元|CN¥/.test(text)) {
      let hit = false;
      const out = text
        .replace(/([¥￥\u00a5\uffe5]|CN¥)\s*(\d{1,3}(?:,\d{3})*(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?)/g, (_, __, num) => {
          hit = true;
          return formatRub(parseCnyNum(num), rate);
        })
        .replace(/(\d{1,3}(?:,\d{3})*(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?)\s*元/g, (_, num) => {
          hit = true;
          return formatRub(parseCnyNum(num), rate);
        });
      if (hit) return out;
    }

    if (!el || !isLikelyPriceEl(el)) return null;
    const m = text.match(
      /^(\d{1,3}(?:,\d{3})*(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?)([\s\S]*)$/
    );
    if (!m) return null;
    const cny = parseCnyNum(m[1]);
    if (cny < 0.01 || cny >= 10000000) return null;
    return formatRub(cny, rate) + m[2];
  }

  function applyPriceLeaf(el, rate) {
    if (!el || el.dataset.tbPrice || !isVisible(el)) return false;
    if (el.children.length > 0) return false;
    const raw = (el.textContent || '').trim();
    if (!raw || raw.length > 60 || /₽/.test(raw)) return false;
    const next = convertAnyPrice(raw, rate, el);
    if (!next || next === raw) return false;
    markPrice(el, raw);
    el.textContent = next;
    hideYuanSymbol(el);
    return true;
  }

  function applyPriceElement(el, rate) {
    if (!el || el.dataset.tbPrice || !isVisible(el)) return false;
    const raw = (el.innerText || el.textContent || '').trim();
    if (!raw || raw.length > 80 || /₽/.test(raw)) return false;

    if (el.children.length === 0) return applyPriceLeaf(el, rate);

    if (el.children.length <= 3 && isLikelyPriceEl(el)) {
      let changed = false;
      el.querySelectorAll('span, em, b, i, strong, div').forEach((c) => {
        if (applyPriceLeaf(c, rate)) changed = true;
      });
      if (changed) {
        hideYuanSymbol(el);
        el.dataset.tbPrice = '1';
        return true;
      }
    }

    const next = convertAnyPrice(raw, rate, el);
    if (!next || next === raw) return false;
    markPrice(el, raw);
    el.textContent = next;
    hideYuanSymbol(el);
    return true;
  }

  function collectPriceNodes(root = document.body) {
    const nodes = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(n) {
        const p = n.parentElement;
        if (!p || SKIP.has(p.tagName) || p.closest('[data-tb-price]')) return NodeFilter.FILTER_REJECT;
        if (p.isContentEditable || p.hidden) return NodeFilter.FILTER_REJECT;
        const t = n.textContent;
        if (!t || !t.trim() || /₽/.test(t)) return NodeFilter.FILTER_REJECT;
        if (!isVisible(p)) return NodeFilter.FILTER_REJECT;
        if (/[¥￥\u00a5\uffe5]|元|CN¥/.test(t)) return NodeFilter.FILTER_ACCEPT;
        if (isLikelyPriceEl(p) && /^\s*\d[\d,.\s]*/.test(t)) return NodeFilter.FILTER_ACCEPT;
        return NodeFilter.FILTER_REJECT;
      },
    });
    let n;
    while ((n = walker.nextNode())) nodes.push(n);
    return nodes;
  }

  function applyPriceTextNode(node, rate) {
    const raw = node.textContent;
    const el = node.parentElement;
    const next = convertAnyPrice(raw.trim(), rate, el);
    if (!next || next === raw.trim()) return false;
    markPrice(el, raw.trim());
    node.textContent = raw.replace(raw.trim(), next);
    hideYuanSymbol(el);
    return true;
  }

  async function runPrices() {
    if (!CFG.priceRub) return;
    ensurePriceCss();
    const rate = await getCnyRubRate();

    document
      .querySelectorAll('[class*="Price"], [class*="price"], [class*="RMB"], [class*="rmb"]')
      .forEach((el) => applyPriceElement(el, rate));

    for (const node of collectPriceNodes()) applyPriceTextNode(node, rate);

    document.querySelectorAll('span, em, b, i, strong, div, p').forEach((el) => {
      if (el.children.length > 0 || el.dataset.tbPrice) return;
      if (!isLikelyPriceEl(el)) return;
      applyPriceLeaf(el, rate);
    });
  }

  function startPriceWatcher() {
    if (!CFG.priceRub) return;
    runPrices();
    [200, 600, 1200, 2500, 5000].forEach((ms) => setTimeout(runPrices, ms));
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
      if (CFG.priceRub) runPrices();
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

    const rubBtn = document.createElement('button');
    rubBtn.textContent = CFG.priceRub ? '₽ ✓' : '₽';
    rubBtn.title = 'Цены в рублях';
    Object.assign(rubBtn.style, {
      padding: '10px 12px',
      border: 'none',
      borderRadius: '8px',
      background: CFG.priceRub ? '#2a9d4b' : '#555',
      color: '#fff',
      font: 'bold 14px/1 system-ui,sans-serif',
      cursor: 'pointer',
      boxShadow: '0 2px 12px rgba(0,0,0,.25)',
    });
    rubBtn.onclick = () => {
      GM_setValue('priceRub', !CFG.priceRub);
      location.reload();
    };

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
      if (CFG.priceRub) runPrices();
      runTranslate();
    };

    wrap.append(rubBtn, btn, status);
    document.body.appendChild(wrap);
  }

  let debounce;
  const obs = new MutationObserver(() => {
    clearTimeout(debounce);
    debounce = setTimeout(() => {
      if (CFG.priceRub) runPrices();
      if (CFG.auto) runTranslate();
    }, 400);
  });

  makeUI();
  startPriceWatcher();
  if (CFG.auto) runTranslate();
  obs.observe(document.body, { childList: true, subtree: true });
})();
