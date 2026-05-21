// ==UserScript==
// @name         Taobao AI Translator (RU)
// @namespace    https://github.com/mrkvka/taobao-ai-translator
// @version      1.1.0
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
  const BATCH = 10;
  const MIN_LEN = 2;
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
    const crumbs = [...document.querySelectorAll('[class*="breadcrumb"],[class*="BreadCrumb"],nav a')]
      .map((a) => a.innerText.trim())
      .filter((t) => CHINESE.test(t))
      .join(' › ')
      .slice(0, 200);

    return { pageType, productTitle, crumbs, host: location.hostname };
  }

  let pageCtx = getPageContext();
  const blockIds = new WeakMap();
  let blockSeq = 0;

  function getBlockId(block) {
    if (!block) return 'x';
    if (!blockIds.has(block)) blockIds.set(block, 'b' + ++blockSeq);
    return blockIds.get(block);
  }

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
    if (block?.closest('tr,li')) return 'list-item';
    return 'ui';
  }

  function getLocalContext(block, text) {
    if (!block) return '';
    const raw = block.innerText.replace(/\s+/g, ' ').trim();
    if (raw.length < 120) return raw.slice(0, 120);
    const i = raw.indexOf(text);
    if (i < 0) return raw.slice(0, 120);
    const start = Math.max(0, i - 50);
    return raw.slice(start, start + 140);
  }

  function cacheKey(item) {
    return `${pageCtx.pageType}|${item.section}|${item.text}`;
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
      const section = detectSection(block, n.parentElement);
      items.push({
        node: n,
        text,
        section,
        near: getLocalContext(block, text),
        blockId: getBlockId(block),
      });
    }
    return items;
  }

  function groupBlocks(items) {
    const blocks = new Map();
    for (const it of items) {
      if (!blocks.has(it.blockId)) blocks.set(it.blockId, []);
      blocks.get(it.blockId).push(it);
    }
    return blocks;
  }

  async function translateGoogle(items, tl, ctx) {
    const hint = `[${ctx.pageType}] ${ctx.productTitle || ''}`.trim();
    const out = [];
    for (const it of items) {
      const q = `Taobao ${it.section}. Page: ${hint}. Nearby: ${it.near}. Translate to ${tl}: ${it.text}`;
      const url =
        'https://translate.googleapis.com/translate_a/single?client=gtx&sl=zh-CN&tl=' +
        encodeURIComponent(tl) +
        '&dt=t&q=' +
        encodeURIComponent(q);
      const r = await http({ method: 'GET', url });
      const data = JSON.parse(r.responseText);
      const full = (data[0] || []).map((x) => x[0]).join('');
      out.push(cleanGoogle(full, it.text) || it.text);
    }
    return out;
  }

  function cleanGoogle(raw, original) {
    const m = raw.match(/Translate to \w+:\s*(.+)$/i) || raw.match(/:\s*(.+)$/);
    return (m ? m[1] : raw).trim();
  }

  async function translateOpenAI(items, tl, ctx) {
    const payload = {
      page: ctx,
      targetLang: tl,
      items: items.map((it, i) => ({
        id: i + 1,
        section: it.section,
        text: it.text,
        context: it.near,
      })),
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
        temperature: 0.15,
        response_format: { type: 'json_object' },
        messages: [
          {
            role: 'system',
            content: `You translate Chinese Taobao/Tmall e-commerce text to ${tl}.
Use page context (product title, category, page type) and each item's section (title, spec, review, shipping, etc.) plus nearby "context" text.
Rules: keep brand/model/SKU codes; translate sizes naturally; spec labels and values must stay paired logically; UI buttons concise.
Return JSON only: {"items":[{"id":number,"text":"translation"}]} — same ids, same count.`,
          },
          { role: 'user', content: JSON.stringify(payload) },
        ],
      }),
    });
    if (r.status !== 200) throw new Error(r.responseText);
    const body = JSON.parse(r.responseText);
    const parsed = JSON.parse(body.choices?.[0]?.message?.content || '{}');
    const map = new Map((parsed.items || []).map((x) => [x.id, x.text]));
    return items.map((_, i) => map.get(i + 1)?.trim() || items[i].text);
  }

  async function translateBlock(blockItems, tl) {
    const combined = blockItems.map((x) => x.text).join(' / ');
    if (combined.length > 380 || blockItems.length < 2) return null;

    const useAI = CFG.engine === 'openai' || (CFG.engine === 'auto' && CFG.apiKey.length > 10);
    const section = blockItems[0].section;
    const single = { text: combined, section, near: getLocalContext(getBlockRoot(blockItems[0].node.parentElement), combined) };

    let tr;
    if (useAI) {
      try {
        [tr] = await translateOpenAI([single], tl, pageCtx);
      } catch {
        [tr] = await translateGoogle([single], tl, pageCtx);
      }
    } else {
      [tr] = await translateGoogle([single], tl, pageCtx);
    }
    if (!tr || tr === combined) return null;
    return blockItems.map((it, i) => {
      const parts = tr.split(/\s*\/\s*|\s*\|\s*/);
      return parts[i]?.trim() || tr;
    });
  }

  async function translateBatch(items, tl) {
    const useAI = CFG.engine === 'openai' || (CFG.engine === 'auto' && CFG.apiKey.length > 10);
    try {
      return useAI ? await translateOpenAI(items, tl, pageCtx) : await translateGoogle(items, tl, pageCtx);
    } catch {
      return translateGoogle(items, tl, pageCtx);
    }
  }

  function applyTranslation(item, tr) {
    if (!tr || tr === item.text) return;
    const el = item.node.parentElement;
    if (!el || el.dataset.tbTr) return;
    el.dataset.tbTr = '1';
    el.title = (pageCtx.productTitle ? pageCtx.productTitle + '\n' : '') + item.text;
    item.node.textContent = item.node.textContent.replace(item.text, tr);
  }

  let busy = false;

  async function runTranslate() {
    if (busy) return;
    busy = true;
    try {
      pageCtx = getPageContext();
      const items = collectItems();
      const blocks = groupBlocks(items);

      for (const [, blockItems] of blocks) {
        const todo = blockItems.filter((it) => !CACHE.has(cacheKey(it)));
        if (!todo.length) continue;

        const blockTr = await translateBlock(todo, CFG.lang);
        if (blockTr) {
          todo.forEach((it, j) => {
            const tr = blockTr[j];
            CACHE.set(cacheKey(it), tr);
            applyTranslation(it, tr);
          });
          continue;
        }

        for (let i = 0; i < todo.length; i += BATCH) {
          const chunk = todo.slice(i, i + BATCH);
          const res = await translateBatch(chunk, CFG.lang);
          chunk.forEach((it, j) => {
            const tr = res[j] || it.text;
            CACHE.set(cacheKey(it), tr);
            applyTranslation(it, tr);
          });
        }
      }

      items.filter((it) => CACHE.has(cacheKey(it))).forEach((it) => {
        if (!it.node.parentElement?.dataset.tbTr) applyTranslation(it, CACHE.get(cacheKey(it)));
      });
    } finally {
      busy = false;
    }
  }

  function makeUI() {
    const btn = document.createElement('button');
    btn.textContent = '🇷🇺 Перевести';
    Object.assign(btn.style, {
      position: 'fixed',
      bottom: '20px',
      right: '20px',
      zIndex: '2147483646',
      padding: '10px 14px',
      border: 'none',
      borderRadius: '8px',
      background: '#ff5000',
      color: '#fff',
      font: 'bold 14px/1 system-ui,sans-serif',
      cursor: 'pointer',
      boxShadow: '0 2px 12px rgba(0,0,0,.25)',
    });
    btn.onclick = async () => {
      btn.disabled = true;
      btn.textContent = '…';
      CACHE.clear();
      try {
        await runTranslate();
        btn.textContent = '✓ Готово';
      } catch (e) {
        btn.textContent = '✗ Ошибка';
        console.error('[Taobao TR]', e);
      }
      setTimeout(() => {
        btn.disabled = false;
        btn.textContent = '🇷🇺 Перевести';
      }, 2000);
    };
    document.body.appendChild(btn);
  }

  let debounce;
  const obs = new MutationObserver(() => {
    clearTimeout(debounce);
    debounce = setTimeout(() => CFG.auto && runTranslate(), 1500);
  });

  makeUI();
  if (CFG.auto) runTranslate();
  obs.observe(document.body, { childList: true, subtree: true });
})();
