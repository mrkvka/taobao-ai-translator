// ==UserScript==
// @name         Taobao AI Translator (RU)
// @namespace    https://github.com/mrkvka/taobao-ai-translator
// @version      1.5.0
// @description  Контекстный перевод Taobao/Tmall (товар, характеристики, отзывы)
// @author       cursor
// @updateURL    https://raw.githubusercontent.com/mrkvka/taobao-ai-translator/main/taobao-ai-translator.user.js
// @downloadURL  https://raw.githubusercontent.com/mrkvka/taobao-ai-translator/main/taobao-ai-translator.user.js
// @match        https://*.taobao.com/*
// @match        https://*.tmall.com/*
// @match        https://taobao.com/*
// @match        https://tmall.com/*
// @match        https://login.taobao.com/*
// @match        https://www.taobao.com/*
// @match        http://*.taobao.com/*
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

  const STORE = {
    apiKey: 'tbtr.apiKey',
    lang: 'tbtr.lang',
    auto: 'tbtr.auto',
    engine: 'tbtr.engine',
    priceRub: 'tbtr.priceRub',
    cnyRubManual: 'tbtr.cnyRubManual',
    cnyRubRate: 'tbtr.cnyRubRate',
    cnyRubRateAt: 'tbtr.cnyRubRateAt',
  };

  function migrateStore() {
    const old = {
      apiKey: GM_getValue('apiKey', null),
      lang: GM_getValue('lang', null),
      auto: GM_getValue('auto', null),
      engine: GM_getValue('engine', null),
      priceRub: GM_getValue('priceRub', null),
      cnyRubManual: GM_getValue('cnyRubManual', null),
      cnyRubRate: GM_getValue('cnyRubRate', null),
      cnyRubRateAt: GM_getValue('cnyRubRateAt', null),
    };
    if (old.apiKey !== null && GM_getValue(STORE.apiKey, null) === null) GM_setValue(STORE.apiKey, old.apiKey);
    if (old.lang !== null && GM_getValue(STORE.lang, null) === null) GM_setValue(STORE.lang, old.lang);
    if (old.auto !== null && GM_getValue(STORE.auto, null) === null) GM_setValue(STORE.auto, old.auto);
    if (old.engine !== null && GM_getValue(STORE.engine, null) === null) GM_setValue(STORE.engine, old.engine);
    if (old.priceRub !== null && GM_getValue(STORE.priceRub, null) === null) GM_setValue(STORE.priceRub, old.priceRub);
    if (old.cnyRubManual !== null && GM_getValue(STORE.cnyRubManual, null) === null)
      GM_setValue(STORE.cnyRubManual, old.cnyRubManual);
    if (old.cnyRubRate !== null && GM_getValue(STORE.cnyRubRate, null) === null)
      GM_setValue(STORE.cnyRubRate, old.cnyRubRate);
    if (old.cnyRubRateAt !== null && GM_getValue(STORE.cnyRubRateAt, null) === null)
      GM_setValue(STORE.cnyRubRateAt, old.cnyRubRateAt);
  }

  migrateStore();

  const CFG = loadCfg();

  function loadCfg() {
    return {
      apiKey: GM_getValue(STORE.apiKey, ''),
      lang: GM_getValue(STORE.lang, 'ru'),
      auto: GM_getValue(STORE.auto, true),
      engine: GM_getValue(STORE.engine, 'auto'),
      priceRub: GM_getValue(STORE.priceRub, false),
    };
  }

  function saveCfg(partial) {
    Object.assign(CFG, partial);
    if ('apiKey' in partial) GM_setValue(STORE.apiKey, CFG.apiKey);
    if ('lang' in partial) GM_setValue(STORE.lang, CFG.lang);
    if ('auto' in partial) GM_setValue(STORE.auto, CFG.auto);
    if ('engine' in partial) GM_setValue(STORE.engine, CFG.engine);
    if ('priceRub' in partial) GM_setValue(STORE.priceRub, CFG.priceRub);
  }

  function saveManualRate(val) {
    GM_setValue(STORE.cnyRubManual, val > 0 ? val : 0);
    cnyRubRate = null;
  }

  GM_registerMenuCommand('⚙ Настройки', openSettings);

  function openSettings() {
    document.getElementById('tb-tr-settings')?.remove();
    const box = document.createElement('div');
    box.id = 'tb-tr-settings';
    Object.assign(box.style, {
      position: 'fixed',
      top: '50%',
      left: '50%',
      transform: 'translate(-50%,-50%)',
      zIndex: '2147483647',
      background: '#fff',
      color: '#222',
      borderRadius: '12px',
      boxShadow: '0 8px 40px rgba(0,0,0,.35)',
      padding: '20px 22px',
      width: 'min(92vw, 380px)',
      font: '14px/1.4 system-ui,sans-serif',
    });

    const manualRate = GM_getValue(STORE.cnyRubManual, 0) || '';

    box.innerHTML =
      '<div style="font:bold 16px/1.2 system-ui;margin-bottom:14px">Настройки переводчика</div>' +
      '<label style="display:block;margin:10px 0 4px">OpenAI API key <span style="color:#888;font-weight:400">(пусто = Google)</span></label>' +
      `<input id="tb-s-key" type="password" value="${esc(CFG.apiKey)}" placeholder="sk-..." style="width:100%;box-sizing:border-box;padding:8px 10px;border:1px solid #ccc;border-radius:6px">` +
      '<label style="display:block;margin:10px 0 4px">Язык</label>' +
      `<input id="tb-s-lang" value="${esc(CFG.lang)}" style="width:100%;box-sizing:border-box;padding:8px 10px;border:1px solid #ccc;border-radius:6px">` +
      '<label style="display:block;margin:10px 0 4px">Движок</label>' +
      `<select id="tb-s-engine" style="width:100%;padding:8px 10px;border:1px solid #ccc;border-radius:6px">` +
      `<option value="auto"${CFG.engine === 'auto' ? ' selected' : ''}>auto (OpenAI если есть ключ)</option>` +
      `<option value="openai"${CFG.engine === 'openai' ? ' selected' : ''}>OpenAI</option>` +
      `<option value="google"${CFG.engine === 'google' ? ' selected' : ''}>Google</option>` +
      '</select>' +
      '<label style="display:block;margin:10px 0 4px">Курс CNY→RUB <span style="color:#888;font-weight:400">(пусто = авто)</span></label>' +
      `<input id="tb-s-rate" value="${manualRate ? esc(String(manualRate)) : ''}" placeholder="12.8" style="width:100%;box-sizing:border-box;padding:8px 10px;border:1px solid #ccc;border-radius:6px">` +
      `<label style="display:flex;align-items:center;gap:8px;margin:12px 0 6px;cursor:pointer"><input id="tb-s-auto" type="checkbox"${CFG.auto ? ' checked' : ''}> Авто-перевод при загрузке</label>` +
      `<label style="display:flex;align-items:center;gap:8px;margin:6px 0;cursor:pointer"><input id="tb-s-rub" type="checkbox"${CFG.priceRub ? ' checked' : ''}> Цены в рублях</label>` +
      '<div style="display:flex;gap:8px;margin-top:16px">' +
      '<button id="tb-s-save" style="flex:1;padding:10px;border:none;border-radius:8px;background:#ff5000;color:#fff;font:bold 14px system-ui;cursor:pointer">Сохранить</button>' +
      '<button id="tb-s-close" style="padding:10px 14px;border:1px solid #ccc;border-radius:8px;background:#f5f5f5;cursor:pointer">Закрыть</button>' +
      '</div>' +
      '<div id="tb-s-msg" style="margin-top:10px;color:#2a9d4b;font-size:13px;min-height:18px"></div>';

    const backdrop = document.createElement('div');
    backdrop.id = 'tb-tr-settings-bg';
    Object.assign(backdrop.style, {
      position: 'fixed',
      inset: '0',
      zIndex: '2147483646',
      background: 'rgba(0,0,0,.45)',
    });
    backdrop.onclick = closeSettings;
    document.body.append(backdrop, box);

    box.querySelector('#tb-s-close').onclick = closeSettings;
    box.querySelector('#tb-s-save').onclick = () => {
      const rate = parseFloat(String(box.querySelector('#tb-s-rate').value || '').replace(',', '.'));
      saveCfg({
        apiKey: box.querySelector('#tb-s-key').value.trim(),
        lang: (box.querySelector('#tb-s-lang').value || 'ru').trim(),
        engine: box.querySelector('#tb-s-engine').value,
        auto: box.querySelector('#tb-s-auto').checked,
        priceRub: box.querySelector('#tb-s-rub').checked,
      });
      saveManualRate(rate);
      syncUI();
      box.querySelector('#tb-s-msg').textContent = '✓ Сохранено';
      runInitialPass();
    };
  }

  function closeSettings() {
    document.getElementById('tb-tr-settings')?.remove();
    document.getElementById('tb-tr-settings-bg')?.remove();
  }

  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  }

  function syncUI() {
    const rubBtn = document.getElementById('tb-tr-rub-btn');
    if (rubBtn) {
      rubBtn.textContent = CFG.priceRub ? '₽ ✓' : '₽';
      rubBtn.style.background = CFG.priceRub ? '#2a9d4b' : '#555';
    }
  }

  function togglePriceRub() {
    saveCfg({ priceRub: !CFG.priceRub });
    syncUI();
    if (CFG.priceRub) runPrices();
  }

  const OUR_SEL = '#tb-tr-wrap,#tb-tr-settings,#tb-tr-settings-bg';
  const SCAN_DEBOUNCE = 2500;
  const LOAD_RETRIES = [800, 2500];

  function isOurNode(el) {
    return el && el.closest && el.closest(OUR_SEL);
  }

  let pauseMut = 0;
  let busy = false;
  let priceBusy = false;
  let runId = 0;
  let scanTimer = null;

  function pauseDom() {
    pauseMut++;
    return () => {
      pauseMut = Math.max(0, pauseMut - 1);
    };
  }

  function isHiddenEl(el) {
    if (!el || el.hidden) return true;
    return !el.getClientRects().length;
  }

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

  GM_registerMenuCommand((CFG.priceRub ? '✓ ' : '') + 'Цены в рублях', togglePriceRub);

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

  function ensureTranslateCss() {
    if (document.getElementById('tb-tr-css')) return;
    const st = document.createElement('style');
    st.id = 'tb-tr-css';
    st.textContent =
      '[data-tb-tr]{white-space:normal!important;word-break:break-word!important;overflow:visible!important;text-overflow:unset!important}' +
      '[data-tb-tr-block]{display:block!important;width:100%!important;height:auto!important;min-height:0!important;white-space:normal!important;line-height:1.45!important;word-break:break-word!important;overflow:visible!important}';
    document.head.appendChild(st);
  }

  function markLayoutFix(el) {
    const block = el.closest(
      '[class*="agree" i],[class*="protocol" i],[class*="clause" i],[class*="footer" i],[class*="login" i],[class*="Login" i],label,form'
    );
    if (block && (block.innerText || '').length < 600) block.dataset.tbTrBlock = '1';
  }

  function collectItems(root = document.body) {
    const items = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(n) {
        const p = n.parentElement;
        if (!p || SKIP.has(p.tagName) || isOurNode(p) || p.closest('[data-tb-tr]')) return NodeFilter.FILTER_REJECT;
        if (p.isContentEditable || p.hidden || isHiddenEl(p)) return NodeFilter.FILTER_REJECT;
        const t = n.textContent.trim();
        if (t.length < MIN_LEN || !CHINESE.test(t)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    let n;
    while ((n = walker.nextNode())) {
      const text = n.textContent.trim();
      const block = getBlockRoot(n.parentElement);
      items.push({ node: n, text, section: detectSection(block, n.parentElement), kind: 'text' });
    }
    return items;
  }

  function collectAttrItems(root = document.body) {
    const items = [];
    root.querySelectorAll('input, textarea, select').forEach((el) => {
      if (el.dataset.tbTrAttr || isOurNode(el)) return;
      for (const attr of ['placeholder', 'aria-label', 'title', 'alt']) {
        const v = el.getAttribute(attr);
        if (v && CHINESE.test(v)) items.push({ el, attr, text: v.trim(), kind: 'attr' });
      }
    });
    root.querySelectorAll('[class*="placeholder" i],[class*="Placeholder" i]').forEach((el) => {
      if (el.dataset.tbTr || el.dataset.tbTrAttr || el.children.length > 0 || isOurNode(el)) return;
      if (!el.closest('form, [class*="login" i], [class*="Login" i], [class*="input" i], [class*="Input" i]'))
        return;
      const t = (el.textContent || '').trim();
      if (t.length >= MIN_LEN && CHINESE.test(t)) items.push({ el, attr: null, text: t, kind: 'pseudo' });
    });
    return items;
  }

  function collectAllItems(root = document.body) {
    return [...collectItems(root), ...collectAttrItems(root)];
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
    const useAI =
      CFG.engine !== 'google' && (CFG.engine === 'openai' || (CFG.engine === 'auto' && CFG.apiKey.length > 10));
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
    ensureTranslateCss();
    const done = pauseDom();
    try {
      for (const it of items) {
        if (it.kind !== 'text') continue;
        const tr = textMap.get(it.text);
        if (!tr || tr === it.text) continue;
        const el = it.node.parentElement;
        if (!el || el.dataset.tbTr) continue;
        el.dataset.tbTr = '1';
        el.title = it.text;
        markLayoutFix(el);
        it.node.textContent = it.node.textContent.replace(it.text, tr);
      }
    } finally {
      done();
    }
  }

  function applyAttrItems(items, textMap) {
    ensureTranslateCss();
    const done = pauseDom();
    try {
      for (const it of items) {
        if (it.kind === 'text') continue;
        const tr = textMap.get(it.text);
        if (!tr || tr === it.text) continue;
        if (it.kind === 'attr') {
          it.el.setAttribute(it.attr, tr);
          it.el.dataset.tbTrAttr = '1';
          it.el.title = it.text;
        } else if (it.kind === 'pseudo') {
          it.el.textContent = tr;
          it.el.dataset.tbTrAttr = '1';
          it.el.title = it.text;
          markLayoutFix(it.el);
        }
      }
    } finally {
      done();
    }
  }

  function applyAll(items, textMap) {
    applyToNodes(items, textMap);
    applyAttrItems(items, textMap);
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
    return !isHiddenEl(el);
  }

  function isLikelyPriceEl(el) {
    if (!el || isHiddenEl(el) || el.closest('[data-tb-price]') || isOurNode(el)) return false;
    if (el.closest(PRICE_SEL)) return true;
    const cls = (el.className || '').toString();
    return /price|Price|rmb|RMB|amount|Amount|money|Money|total|Total|currency|Currency|unit|Unit|symbol|Symbol/i.test(
      cls
    );
  }

  function ensurePriceCss() {
    if (document.getElementById('tb-price-css')) return;
    const st = document.createElement('style');
    st.id = 'tb-price-css';
    st.textContent =
      '[data-tb-price-hide]{display:none!important;width:0!important;height:0!important;overflow:hidden!important;font-size:0!important;line-height:0!important;margin:0!important;padding:0!important;border:0!important}' +
      '[data-tb-price-root]::before,[data-tb-price-root]::after{content:none!important;display:none!important;width:0!important;height:0!important}' +
      '[data-tb-price-root] [class*="symbol"],[data-tb-price-root] [class*="Symbol"],' +
      '[data-tb-price-root] [class*="currency"],[data-tb-price-root] [class*="Currency"],' +
      '[data-tb-price-root] [class*="unit"],[data-tb-price-root] [class*="Unit"],' +
      '[class*="Price--symbol"],[class*="price--symbol"],[class*="currency--"],[class*="Unit--"],[class*="unit--"]{display:none!important;width:0!important;height:0!important;overflow:hidden!important;font-size:0!important}';
    document.head.appendChild(st);
  }

  function isYuanOnlyText(text) {
    const t = String(text || '').trim();
    return !t || /^[¥￥\u00a5\uffe5]$/.test(t) || /^[¥￥\u00a5\uffe5]\s*$/.test(t) || t === '元';
  }

  function findPriceRow(el) {
    let node = el;
    for (let i = 0; i < 5 && node; i++) {
      const t = (node.innerText || '').trim();
      if (!t || t.length > 80) {
        node = node.parentElement;
        continue;
      }
      if (extractCny(t) && (/[¥￥\u00a5\uffe5₽元]/.test(t) || isLikelyPriceEl(node) || node.closest(PRICE_SEL)))
        return node;
      node = node.parentElement;
    }
    return el.parentElement || el;
  }

  function hideAllYuanInRow(row) {
    if (!row) return;
    row.dataset.tbPriceRoot = '1';
    row.querySelectorAll('span, em, i, b, s, div').forEach((s) => {
      if (s.dataset.tbPrice) return;
      const t = (s.textContent || '').trim();
      if (isYuanOnlyText(t)) {
        s.style.cssText =
          'display:none!important;width:0!important;height:0!important;overflow:hidden!important;font-size:0!important;line-height:0!important;margin:0!important;padding:0!important';
        s.dataset.tbPriceHide = '1';
      }
    });
  }

  function hideYuanSymbol(root) {
    hideAllYuanInRow(findPriceRow(root));
    hideAllYuanInRow(root);
  }

  function markPrice(el, orig) {
    el.dataset.tbPrice = '1';
    el.title = /[¥￥\u00a5\uffe5]/.test(orig) ? orig : '¥' + String(orig).replace(/\s[\s\S]*/, '');
  }

  function extractCny(text) {
    const m = String(text)
      .replace(/\s+/g, '')
      .match(/(?:[¥￥\u00a5\uffe5])?(\d{1,3}(?:,\d{3})*(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?)/);
    return m ? parseCnyNum(m[1]) : null;
  }

  function isPurePriceText(text) {
    const t = String(text).replace(/\s+/g, ' ').trim();
    if (!t || /₽/.test(t)) return false;
    const rest = t.replace(/[¥￥\u00a5\uffe5元,\s\d.]/g, '');
    return rest.length === 0 && extractCny(t) > 0;
  }

  function getDigitLeaves(el) {
    return [...el.querySelectorAll('span, em, b, i, div')].filter(
      (c) => isVisible(c) && c.children.length === 0 && /^[\d.]+$/.test((c.textContent || '').trim())
    );
  }

  function isDigitSplitContainer(el) {
    if (!el || el.dataset.tbPrice || el.children.length < 2) return false;
    const leaves = getDigitLeaves(el);
    if (leaves.length < 2 || leaves.length > 6) return false;
    const cny = extractCny(el.innerText);
    if (!cny || cny <= 0) return false;
    const extra = (el.innerText || '').replace(/[\d.,\s¥￥\u00a5\uffe5元]/g, '').trim();
    return extra.length <= 4;
  }

  function combineSplitDigits(el) {
    const cny = extractCny(el.innerText);
    return cny ? String(cny) : null;
  }

  function applyPriceContainer(el, rate) {
    if (!el || el.dataset.tbPrice || !isVisible(el) || el.closest('[data-tb-price]') || isOurNode(el)) return false;
    const done = pauseDom();
    try {
      if (isDigitSplitContainer(el)) {
        const combined = combineSplitDigits(el);
        const cny = parseCnyNum(combined);
        if (cny > 0 && cny < 10000000) {
          replacePriceContainer(el, cny, combined, rate);
          return true;
        }
      }

      const raw = (el.innerText || el.textContent || '').trim();
      if (!raw || /₽/.test(raw)) return false;

      if (isPurePriceText(raw)) {
        const cny = extractCny(raw);
        if (cny > 0 && cny < 10000000) {
          replacePriceContainer(el, cny, raw, rate);
          return true;
        }
      }

      if (/[¥￥\u00a5\uffe5]|元/.test(raw)) {
        const next = convertAnyPrice(raw, rate, el);
        if (next && next !== raw) {
          markPrice(el, raw);
          el.textContent = next;
          hideYuanSymbol(el);
          return true;
        }
      }

      return false;
    } finally {
      done();
    }
  }

  function replacePriceContainer(el, cny, orig, rate) {
    const row = findPriceRow(el);
    hideAllYuanInRow(row);
    markPrice(el, orig);
    el.textContent = formatRub(cny, rate);
    hideAllYuanInRow(row);
  }

  async function getCnyRubRate() {
    if (cnyRubRate) return cnyRubRate;
    const manual = +GM_getValue(STORE.cnyRubManual, 0);
    if (manual > 0) {
      cnyRubRate = manual;
      return manual;
    }
    const saved = GM_getValue(STORE.cnyRubRate, 0);
    const savedAt = GM_getValue(STORE.cnyRubRateAt, 0);
    if (saved > 0 && Date.now() - savedAt < 6 * 3600000) {
      cnyRubRate = saved;
      return saved;
    }
    try {
      const r = await http({ method: 'GET', url: 'https://open.er-api.com/v6/latest/CNY' });
      const rate = JSON.parse(r.responseText).rates?.RUB;
      if (rate > 0) {
        GM_setValue(STORE.cnyRubRate, rate);
        GM_setValue(STORE.cnyRubRateAt, Date.now());
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

  function collectPriceContainers(root = document.body) {
    const set = new Set();
    root.querySelectorAll('[class*="Price"], [class*="price"], [class*="RMB"], [class*="rmb"]').forEach((el) => {
      if (isOurNode(el)) return;
      if (isDigitSplitContainer(el) || isPurePriceText((el.innerText || '').trim())) set.add(el);
      el.querySelectorAll('span, em, b, i').forEach((c) => {
        if (isDigitSplitContainer(c) || isPurePriceText((c.textContent || '').trim())) set.add(c);
      });
    });
    return [...set].filter((el) => isVisible(el) && !el.closest('[data-tb-price]'));
  }

  function fixBrokenRubPrices(root = document.body) {
    root.querySelectorAll('[class*="Price"], [class*="price"], [class*="RMB"], [class*="rmb"]').forEach((block) => {
      block.querySelectorAll('span, em, b, i').forEach((el) => {
        if (el.children.length > 0) return;
        let t = (el.textContent || '').trim();
        const both = t.match(/^([¥￥\u00a5\uffe5]\s*)?([\d\s.,]+ ₽)(.*)$/);
        if (both) {
          el.textContent = both[2] + both[3];
          el.dataset.tbPrice = '1';
          hideAllYuanInRow(el.parentElement);
          return;
        }
        if (isYuanOnlyText(t) && /₽/.test(block.innerText || '')) {
          el.style.cssText = 'display:none!important;width:0!important;height:0!important;font-size:0!important';
          el.dataset.tbPriceHide = '1';
        }
      });
    });
  }

  async function runPrices(root = document.body) {
    if (!CFG.priceRub || priceBusy) return;
    priceBusy = true;
    const done = pauseDom();
    try {
      ensurePriceCss();
      fixBrokenRubPrices(root);
      const rate = await getCnyRubRate();
      for (const el of collectPriceContainers(root)) applyPriceContainer(el, rate);
    } finally {
      done();
      priceBusy = false;
    }
  }

  async function runTranslate(root = document.body) {
    if (busy || pauseMut > 0) return;
    busy = true;
    const id = ++runId;
    const status = document.getElementById('tb-tr-status');
    try {
      pageCtx = getPageContext();
      ensureTranslateCss();
      const items = collectAllItems(root);
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
      applyAll(items, cachedMap);

      if (!todo.length) {
        if (status) status.textContent = '✓';
        return;
      }

      let left = todo.length;
      if (status) status.textContent = `… ${left}`;

      await translateUnique(todo, CFG.lang, (part, translated) => {
        if (id !== runId) return;
        const map = new Map(part.map((t, i) => [t, translated[i] || t]));
        applyAll(part.flatMap((t) => byText.get(t) || []), map);
        left -= part.length;
        if (status) status.textContent = left > 0 ? `… ${left}` : '✓';
      });

      if (id === runId && status) status.textContent = '✓';
      if (CFG.priceRub) await runPrices(root);
    } catch (e) {
      console.error('[Taobao TR]', e);
      const st = document.getElementById('tb-tr-status');
      if (st) st.textContent = '✗';
    } finally {
      busy = false;
    }
  }

  function makeUI() {
    if (document.getElementById('tb-tr-wrap')) return;
    const wrap = document.createElement('div');
    wrap.id = 'tb-tr-wrap';
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
    rubBtn.id = 'tb-tr-rub-btn';
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
    rubBtn.onclick = togglePriceRub;

    const cfgBtn = document.createElement('button');
    cfgBtn.textContent = '⚙';
    cfgBtn.title = 'Настройки';
    Object.assign(cfgBtn.style, {
      padding: '10px 12px',
      border: 'none',
      borderRadius: '8px',
      background: '#333',
      color: '#fff',
      font: 'bold 14px/1 system-ui,sans-serif',
      cursor: 'pointer',
      boxShadow: '0 2px 12px rgba(0,0,0,.25)',
    });
    cfgBtn.onclick = openSettings;

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

    wrap.append(cfgBtn, rubBtn, btn, status);
    document.body.appendChild(wrap);
  }

  function scheduleScan() {
    if (pauseMut > 0 || busy || priceBusy) return;
    clearTimeout(scanTimer);
    scanTimer = setTimeout(() => {
      if (pauseMut > 0 || busy || priceBusy) return;
      if (CFG.auto) runTranslate();
      else if (CFG.priceRub) runPrices();
    }, SCAN_DEBOUNCE);
  }

  function runInitialPass() {
    if (CFG.priceRub) runPrices();
    if (CFG.auto) runTranslate();
    LOAD_RETRIES.forEach((ms) =>
      setTimeout(() => {
        if (CFG.priceRub) runPrices();
        if (CFG.auto) runTranslate();
      }, ms)
    );
  }

  let booted = false;
  function boot() {
    if (booted || !document.body) return;
    booted = true;
    makeUI();
    runInitialPass();

    const obs = new MutationObserver((mutations) => {
      if (pauseMut > 0) return;
      const roots = [];
      for (const m of mutations) {
        if (isOurNode(m.target)) continue;
        for (const n of m.addedNodes) {
          if (n.nodeType === 1 && !isOurNode(n)) roots.push(n);
        }
      }
      if (roots.length) scheduleScan();
    });
    obs.observe(document.body, { childList: true, subtree: true });
  }

  if (document.body) boot();
  else {
    const wait = new MutationObserver(() => {
      if (document.body) {
        wait.disconnect();
        boot();
      }
    });
    wait.observe(document.documentElement, { childList: true });
    window.addEventListener('load', boot, { once: true });
  }
})();
