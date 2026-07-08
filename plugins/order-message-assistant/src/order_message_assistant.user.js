// ==UserScript==
// @name         订单批量消息助手
// @namespace    local.order.message.assistant
// @version      2.8.0
// @description  自动逐批处理全部订单；仅向蓝旗订单发送换紫色消息，成功后将备注旗子设为灰旗
// @match        https://erp.kuaidizs.cn/*
// @match        https://*.jinritemai.com/*
// @match        https://*.douyinec.com/*
// @match        https://*.douyin.com/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_addValueChangeListener
// @run-at       document-idle
// @noframes
// ==/UserScript==

(() => {
  'use strict';

  // 双保险：旧版 Tampermonkey 或站点动态 iframe 也不得启动第二个主循环。
  if (window.top !== window.self) return;

  const MESSAGE = '抱歉您的订单由于工厂缺货超售导致无法发货，约2个月后才能补货，现在先给您办理【退款】可以吗？谢谢您的理解~';
  const BLUE_FLAG_MESSAGE = '抱歉，您拍的本子因为缺货导致无法发货，将会给您换成【紫色】发货，如果您不喜欢的话也可以现在提交退款，谢谢您的理解！';
  const STORE = 'oma_state_v1';
  const PROCESSING_RULE = 'only_blue_to_gray_v1';
  const PAGE_ID = sessionStorage.getItem('oma_page_id') || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  sessionStorage.setItem('oma_page_id', PAGE_ID);
  const isERP = location.hostname === 'erp.kuaidizs.cn';
  const isChat = location.hostname === 'im.jinritemai.com' && location.pathname.includes('/workspace');
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const norm = value => String(value || '').replace(/\s+/g, ' ').trim();
  const visible = el => !!el && el.isConnected && el.getClientRects().length > 0;
  const $ = (selector, root = document) => {
    try { return root.querySelector(selector); } catch (_) { return null; }
  };
  const $$ = (selector, root = document) => {
    try { return [...root.querySelectorAll(selector)]; } catch (_) { return []; }
  };

  const defaults = {
    running: false,
    dryRun: true,
    delayMin: 1800,
    delayMax: 3200,
    selectors: {},
    processed: {},
    processedFingerprints: {},
    failed: {},
    pending: null,
    erpOwner: null,
    processingRule: PROCESSING_RULE,
    log: []
  };

  function state() {
    const stored = GM_getValue(STORE, {});
    const current = Object.assign({}, defaults, stored);
    if (stored.processingRule !== PROCESSING_RULE) {
      current.processingRule = PROCESSING_RULE;
      current.processedFingerprints = {};
      current.pending = null;
      current.running = false;
      current.erpOwner = null;
      GM_setValue(STORE, current);
    }
    const inputSelector = current.selectors?.messageInput || '';
    if (inputSelector.includes('textarea[placeholder=') && inputSelector.includes('发送给')) {
      current.selectors = Object.assign({}, current.selectors, {
        messageInput: 'textarea[placeholder^="发送给"]'
      });
    }
    return current;
  }

  function save(patch) {
    const next = Object.assign({}, state(), patch);
    GM_setValue(STORE, next);
    render();
    return next;
  }

  function log(message) {
    const s = state();
    const line = `${new Date().toLocaleTimeString()} ${message}`;
    save({ log: [line, ...(s.log || [])].slice(0, 30) });
  }

  function cssEscape(value) {
    return CSS.escape(String(value));
  }

  function uniqueSelector(el, stopAt = null) {
    if (!el || el === stopAt) return '';
    const testRoot = stopAt || document;
    if (el.id) {
      const byId = `#${cssEscape(el.id)}`;
      if ($$(byId, testRoot).length === 1) return byId;
    }
    // placeholder 往往包含买家昵称等动态文本，不适合作为长期选择器。
    for (const attr of ['data-testid', 'data-id', 'data-row-key', 'name', 'aria-label']) {
      const value = el.getAttribute?.(attr);
      if (!value) continue;
      const selector = `${el.tagName.toLowerCase()}[${attr}="${cssEscape(value)}"]`;
      if ($$(selector, testRoot).length === 1) return selector;
    }
    const parts = [];
    let node = el;
    while (node && node !== stopAt && node.nodeType === 1) {
      let part = node.tagName.toLowerCase();
      const stableClasses = [...node.classList].filter(c => !/^(css-|ant-|semi-|arco-|el-)|\d{3,}/.test(c)).slice(0, 2);
      if (stableClasses.length) part += stableClasses.map(c => `.${cssEscape(c)}`).join('');
      const parent = node.parentElement;
      if (parent) {
        const peers = [...parent.children].filter(x => x.tagName === node.tagName);
        if (peers.length > 1) part += `:nth-of-type(${peers.indexOf(node) + 1})`;
      }
      parts.unshift(part);
      const selector = parts.join(' > ');
      if ($$(selector, testRoot).length === 1) return selector;
      node = parent;
    }
    return parts.join(' > ');
  }

  function waitFor(selector, timeout = 15000, root = document) {
    return new Promise((resolve, reject) => {
      const found = $(selector, root);
      if (visible(found)) return resolve(found);
      const observer = new MutationObserver(() => {
        const el = $(selector, root);
        if (visible(el)) {
          observer.disconnect();
          clearTimeout(timer);
          resolve(el);
        }
      });
      observer.observe(root === document ? document.documentElement : root, { childList: true, subtree: true });
      const timer = setTimeout(() => {
        observer.disconnect();
        reject(new Error(`等待控件超时：${selector}`));
      }, timeout);
    });
  }

  function click(el) {
    if (!visible(el)) throw new Error('目标控件不可见');
    // 校准时经常点到按钮内部的 SVG/path；优先提升到真正可点击的父控件。
    const target = el.closest?.('button,a,[role="button"],[role="menuitem"]') || el;
    target.scrollIntoView({ block: 'center', behavior: 'instant' });
    target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    target.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    if (typeof target.click === 'function') {
      target.click();
    } else {
      // SVG 图标没有 HTMLElement.click()，需要派发可冒泡的点击事件给父级按钮。
      // Tampermonkey 的 window 是沙箱包装对象，不能作为 MouseEvent.view 传入。
      target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    }
  }

  function setText(el, text) {
    el.focus();
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
      const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      const previous = el.value;
      setter ? setter.call(el, '') : (el.value = '');
      el.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'deleteContentBackward' }));
      el.focus();
      let inserted = false;
      try {
        inserted = !!document.execCommand?.('insertText', false, text);
      } catch (_) {
        inserted = false;
      }
      if (!inserted || norm(el.value) !== norm(text)) {
        setter ? setter.call(el, text) : (el.value = text);
      }
      // 无论 execCommand 是否报告成功，都显式通知 React 的受控输入状态。
      el._valueTracker?.setValue(previous);
      el.dispatchEvent(new InputEvent('input', {
        bubbles: true,
        composed: true,
        inputType: 'insertText',
        data: text
      }));
      el.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
      notifyReactInput(el, text);
    } else {
      el.textContent = text;
      el.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertText', data: text }));
    }
  }

  function notifyReactInput(el, text) {
    const propsKey = Object.keys(el).find(key => key.startsWith('__reactProps$'));
    const props = propsKey ? el[propsKey] : null;
    if (!props) return false;
    const nativeEvent = new InputEvent('input', {
      bubbles: true,
      composed: true,
      inputType: 'insertText',
      data: text
    });
    const event = {
      target: el,
      currentTarget: el,
      nativeEvent,
      type: 'change',
      bubbles: true,
      cancelable: true,
      defaultPrevented: false,
      isTrusted: false,
      preventDefault() { this.defaultPrevented = true; },
      stopPropagation() {},
      persist() {}
    };
    try {
      props.onInput?.(event);
      props.onChange?.(event);
      return typeof props.onInput === 'function' || typeof props.onChange === 'function';
    } catch (_) {
      return false;
    }
  }

  function inputText(el) {
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) return el.value;
    return el.textContent || '';
  }

  function findSendButton(input, savedSelector) {
    const saved = $(savedSelector);
    if (visible(saved) && norm(saved.textContent).replace(/\s/g, '') === '发送') return saved;
    const candidates = $$('button,[role="button"]')
      .filter(el => visible(el) && norm(el.textContent).replace(/\s/g, '') === '发送');
    if (candidates.length === 1) return candidates[0];
    if (candidates.length > 1) {
      const inputRect = input.getBoundingClientRect();
      return candidates
        .map(el => ({ el, distance: Math.abs(el.getBoundingClientRect().top - inputRect.top) }))
        .sort((a, b) => a.distance - b.distance)[0].el;
    }
    return null;
  }

  async function waitUntilInputStablyCleared(input, timeout = 10000, stableFor = 3000) {
    const deadline = Date.now() + timeout;
    let emptySince = 0;
    while (Date.now() < deadline) {
      const liveInput = visible(input)
        ? input
        : $$('textarea[placeholder^="发送给"]').find(visible);
      if (liveInput && !norm(inputText(liveInput))) {
        if (!emptySince) emptySince = Date.now();
        if (Date.now() - emptySince >= stableFor) return true;
      } else {
        emptySince = 0;
      }
      await sleep(200);
    }
    return false;
  }

  function messageOccurrences(text, input) {
    const expected = norm(text);
    const inputRect = input.getBoundingClientRect();
    return $$('div,span,p')
      .filter(el => {
        const text = norm(el.textContent);
        if (!visible(el) || el.closest('#oma-panel') || !text.includes(expected)) return false;
        // 只统计包含消息的最内层节点，避免一个气泡被多层容器重复计数。
        if ([...el.children].some(child => visible(child) && norm(child.textContent).includes(expected))) return false;
        const rect = el.getBoundingClientRect();
        const centerX = rect.left + rect.width / 2;
        // 只接受当前聊天栏中、输入框上方的新气泡；排除左侧会话摘要和右侧订单/脚本面板。
        return rect.bottom < inputRect.top - 5 &&
          rect.left >= inputRect.left - 20 &&
          rect.right <= inputRect.right + 20 &&
          centerX >= inputRect.left &&
          centerX <= inputRect.right;
      })
      .length;
  }

  async function waitForMessageBubble(text, input, beforeCount, timeout = 12000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if (messageOccurrences(text, input) > beforeCount) return true;
      await sleep(250);
    }
    return false;
  }

  function companionSend(orderKey, targetOrderId, message, timeout = 60000) {
    return new Promise((resolve, reject) => {
      const requestId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const timer = setTimeout(() => {
        window.removeEventListener('message', onMessage);
        reject(new Error('未收到飞鸽真实输入扩展响应；请检查扩展是否安装并启用'));
      }, timeout);
      function onMessage(event) {
        const data = event.data;
        if (
          event.origin !== location.origin ||
          data?.source !== 'oma-companion' ||
          data?.type !== 'OMA_TRUSTED_SEND_RESPONSE' ||
          data?.requestId !== requestId
        ) return;
        clearTimeout(timer);
        window.removeEventListener('message', onMessage);
        if (data.ok) resolve(data);
        else reject(new Error(data.error || '配套扩展执行失败'));
      }
      window.addEventListener('message', onMessage);
      window.postMessage({
        source: 'oma-userscript',
        type: 'OMA_TRUSTED_SEND_REQUEST',
        requestId,
        orderKey,
        targetOrderId,
        message
      }, location.origin);
    });
  }

  function orderKey(row, index) {
    const keyed = row.matches('[data-row-key],[data-id]')
      ? row
      : $('[data-row-key],[data-id]', row);
    const explicitKey = keyed?.getAttribute('data-row-key') || keyed?.getAttribute('data-id') || '';
    // 商品详情链接可能在所有订单中完全相同，不能作为订单唯一标识。
    // 使用订单行自身标识；若页面未提供，则使用行号和去除倒计时后的订单文本。
    const stableText = norm(row.innerText)
      .replace(/剩余\s*\d+(?:\.\d+)?\s*(?:天|小时|分钟)/g, '')
      .replace(/\d+(?:\.\d+)?\s*(?:天|小时|分钟)后/g, '')
      .slice(0, 500);
    const raw = explicitKey || `${index}|${stableText}` || `row-${index}`;
    let hash = 0;
    for (let i = 0; i < raw.length; i++) hash = ((hash << 5) - hash + raw.charCodeAt(i)) | 0;
    return `order-${Math.abs(hash)}`;
  }

  function rowFingerprint(row) {
    if (!row) return '';
    const keyed = row.matches('[data-row-key],[data-id]')
      ? row
      : $('[data-row-key],[data-id]', row);
    const explicitKey = keyed?.getAttribute('data-row-key') || keyed?.getAttribute('data-id') || '';
    if (explicitKey) return `id:${explicitKey}`;
    // 排除持续变化的倒计时，但保留序号、昵称、数量、地址、商品等稳定信息。
    return `text:${norm(row.innerText)
      .replace(/剩余\s*(?:\d+(?:\.\d+)?\s*(?:天|小时|分钟))+/g, '')
      .replace(/\d+(?:\.\d+)?\s*(?:天|小时|分钟)(?:后)?/g, '')
      .replace(/\s+/g, ' ')
      .trim()}`;
  }

  function orderSummary(row) {
    if (!row) return '';
    const ignored = /^(?:\d+|剩余.*|含预售商品|精选联盟|达人订单|改地址|加急\/优先发货|乡镇)$/;
    const parts = String(row.innerText || '')
      .split(/\n+/)
      .map(norm)
      .filter(Boolean)
      .filter(text => !ignored.test(text))
      .filter(text => !/^(?:订单标签|是否到达|订单异常|留言备注|产品内容)$/.test(text));
    return parts.slice(0, 5).join(' / ').slice(0, 140);
  }

  function orderRef(key, summary = '') {
    return summary ? `${key}｜${summary}` : key;
  }

  let calibration = null;
  let sampleRow = null;

  function capture(name, relativeToRow = false) {
    calibration = { name, relativeToRow };
    showToast(`请点击“${labelFor(name)}”样本；本次点击只用于校准，不会执行操作`);
  }

  function labelFor(name) {
    return ({
      row: '一整条订单记录',
      orderEntry: '进入订单/联系买家入口',
      noteEntry: '无旗订单的备注加号',
      flaggedNoteEntry: '已有旗子时的备注铅笔',
      greenFlagIndicator: '已有任意旗子标志',
      greenFlagOption: '弹窗中的绿旗选项',
      blueFlagOption: '弹窗中的蓝旗选项',
      grayFlagOption: '弹窗中的灰旗选项',
      noteSave: '备注保存按钮',
      messageInput: '消息输入框',
      sendButton: '发送按钮',
    })[name] || name;
  }

  document.addEventListener('click', event => {
    if (!calibration) return;
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    const target = event.target.closest('button,a,input,textarea,img,svg,[contenteditable="true"],[role="button"],[role="textbox"],tr,li,div') || event.target;
    const s = state();
    const selectors = Object.assign({}, s.selectors);
    if (calibration.name === 'row') {
      sampleRow = target;
      selectors.row = uniqueSelector(target);
    } else if (calibration.relativeToRow) {
      const clickedRow = selectors.row ? target.closest(selectors.row) : null;
      const row = clickedRow || (sampleRow?.contains(target) ? sampleRow : null);
      if (!row) {
        calibration = null;
        return showToast('请先校准订单行');
      }
      selectors[calibration.name] = uniqueSelector(target, row);
    } else if (
      calibration.name === 'messageInput' &&
      target.matches('textarea') &&
      $$('textarea[placeholder^="发送给"]').length === 1
    ) {
      // 抖店输入框的 placeholder 会随买家变化，只匹配固定开头。
      selectors.messageInput = 'textarea[placeholder^="发送给"]';
    } else {
      selectors[calibration.name] = uniqueSelector(target);
    }
    const captured = calibration.name;
    calibration = null;
    save({ selectors });
    showToast(`已记录：${labelFor(captured)}`);
  }, true);

  let chatActive = false;

  async function processChatPage() {
    if (chatActive) return;
    chatActive = true;
    try {
      await processChatPageImpl();
    } finally {
      chatActive = false;
    }
  }

  async function processChatPageImpl() {
    const s = state();
    if (
      !isChat ||
      !s.running ||
      !s.pending ||
      s.pending.phase !== 'opening'
    ) return;
    let lockOwner = null;
    try {
      const input = await waitFor('textarea[placeholder^="发送给"]', 20000);
      const latest = state();
      if (!latest.pending || latest.pending.key !== s.pending.key || latest.pending.phase !== 'opening') return;

      // 多个页面或 iframe 可能同时运行用户脚本。先竞争发送锁，只有锁的最终持有者可以发送。
      const owner = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      lockOwner = owner;
      save({
        pending: Object.assign({}, latest.pending, {
          phase: 'sending',
          owner,
          at: Date.now()
        })
      });
      await sleep(150);
      const locked = state();
      if (!locked.pending || locked.pending.key !== s.pending.key || locked.pending.owner !== owner) return;

      if (s.dryRun) {
        log(`[演练] 已找到消息框：${orderRef(s.pending.key, s.pending.orderSummary)}`);
      } else {
        const pendingMessage = String(s.pending.message || MESSAGE);
        const bubblesBefore = messageOccurrences(pendingMessage, input);
        const targetOrderId = new URLSearchParams(location.search).get('fromOrder') || '';
        if (!/^\d{10,25}$/.test(targetOrderId)) {
          throw new Error('飞鸽页面缺少目标订单号，已禁止发送');
        }
        // 不再根据页面中是否出现相同文本来跳过发送：飞鸽的会话摘要、快捷短语
        // 等区域可能包含同文案，容易把未发送订单误判为已发送。
        await companionSend(s.pending.key, targetOrderId, pendingMessage, 60000);
        // 飞鸽的气泡 DOM 会因版本和窗口尺寸变化；稳定清空说明发送按钮已受理。
        // 气泡出现仍可提前确认，但不再把气泡选择器作为唯一成功依据。
        const [cleared, appeared] = await Promise.all([
          waitUntilInputStablyCleared(input, 10000, 3000),
          waitForMessageBubble(pendingMessage, input, bubblesBefore, 10000)
        ]);
        if (!cleared && !appeared) {
          throw new Error('发送后输入框未稳定清空，且聊天区未出现消息，判定发送失败');
        }
        log(`消息已发送（${s.pending.messageType || '订单消息'}）：${orderRef(s.pending.key, s.pending.orderSummary)}`);
      }
      save({ pending: Object.assign({}, state().pending, { phase: 'sent', owner: null, at: Date.now() }) });
      if (!isERP && window.opener) setTimeout(() => window.close(), 700);
    } catch (error) {
      const now = state();
      if (!now.pending || now.pending.key !== s.pending?.key || now.pending.phase === 'sent') return;
      if (now.pending.phase === 'sending' && lockOwner && now.pending.owner !== lockOwner) return;
      save({
        running: false,
        pending: null,
        failed: Object.assign({}, now.failed, { [now.pending?.key || 'unknown']: error.message })
      });
      log(`已停止：${error.message}`);
    }
  }

  let masterActive = false;

  async function masterLoop() {
    if (!isERP || masterActive) return;
    const current = state();
    if (current.erpOwner && current.erpOwner !== PAGE_ID) return;
    masterActive = true;
    try {
      await masterLoopImpl();
    } catch (error) {
      const current = state();
      const message = error?.message || String(error);
      save({
        running: false,
        pending: null,
        failed: Object.assign({}, current.failed, { unexpected: message })
      });
      log(`已停止：主循环异常：${message}`);
    } finally {
      masterActive = false;
    }
  }

  function rowAt(index, rowSelector) {
    return $$(rowSelector).filter(visible)[index] || null;
  }

  function flagElements(row, selector) {
    if (!row) return [];
    const found = [];
    const calibrated = $(selector, row);
    if (visible(calibrated)) found.push(calibrated.closest?.('svg') || calibrated);
    for (const el of $$('svg,use,i,[aria-label],[title],[data-icon]', row)) {
      const icon = el.closest?.('svg') || el;
      const signature = [
        el.getAttribute?.('class'),
        el.getAttribute?.('aria-label'),
        el.getAttribute?.('title'),
        el.getAttribute?.('data-icon'),
        el.getAttribute?.('href'),
        el.getAttribute?.('xlink:href')
      ].filter(Boolean).join(' ');
      if (visible(icon) && /flag|旗帜|旗子/i.test(signature)) found.push(icon);
    }
    return found.filter((el, index, list) => list.indexOf(el) === index);
  }

  function isGreenColor(value) {
    const text = String(value || '').trim().toLowerCase();
    if (!text || text === 'none' || text === 'transparent') return false;
    if (/green|绿色/.test(text)) return true;
    let rgb = text.match(/rgba?\(\s*(\d+)\D+(\d+)\D+(\d+)/);
    if (!rgb) {
      const hex = text.match(/#([0-9a-f]{6})\b/i);
      if (hex) rgb = [null,
        parseInt(hex[1].slice(0, 2), 16),
        parseInt(hex[1].slice(2, 4), 16),
        parseInt(hex[1].slice(4, 6), 16)
      ];
    }
    if (!rgb) return false;
    const red = Number(rgb[1]);
    const green = Number(rgb[2]);
    const blue = Number(rgb[3]);
    return green >= 80 && green > red * 1.18 && green > blue * 1.12;
  }

  function isGreenFlag(el) {
    const nodes = [el, ...$$('path,use,i', el)];
    return nodes.some(node => {
      const style = getComputedStyle(node);
      const values = [
        node.getAttribute?.('class'),
        node.getAttribute?.('style'),
        node.getAttribute?.('fill'),
        node.getAttribute?.('stroke'),
        node.getAttribute?.('color'),
        style.color,
        style.fill,
        style.stroke,
        style.backgroundColor
      ];
      return values.some(isGreenColor);
    });
  }

  function isBlueColor(value) {
    const text = String(value || '').trim().toLowerCase();
    if (!text || text === 'none' || text === 'transparent') return false;
    if (/blue|蓝色|蓝旗/.test(text)) return true;
    let rgb = text.match(/rgba?\(\s*(\d+)\D+(\d+)\D+(\d+)/);
    if (!rgb) {
      const hex = text.match(/#([0-9a-f]{6})\b/i);
      if (hex) rgb = [null,
        parseInt(hex[1].slice(0, 2), 16),
        parseInt(hex[1].slice(2, 4), 16),
        parseInt(hex[1].slice(4, 6), 16)
      ];
    }
    if (!rgb) return false;
    const red = Number(rgb[1]);
    const green = Number(rgb[2]);
    const blue = Number(rgb[3]);
    return blue >= 80 && blue > red * 1.15 && blue > green * 1.08;
  }

  function isBlueFlag(el) {
    const nodes = [el, ...$$('path,use,i', el)];
    return nodes.some(node => {
      const style = getComputedStyle(node);
      const values = [
        node.getAttribute?.('class'),
        node.getAttribute?.('style'),
        node.getAttribute?.('fill'),
        node.getAttribute?.('stroke'),
        node.getAttribute?.('color'),
        style.color,
        style.fill,
        style.stroke,
        style.backgroundColor
      ];
      return values.some(isBlueColor);
    });
  }

  function isGrayColor(value) {
    const text = String(value || '').trim().toLowerCase();
    if (!text || text === 'none' || text === 'transparent') return false;
    if (/gray|grey|灰色|灰旗/.test(text)) return true;
    let rgb = text.match(/rgba?\(\s*(\d+)\D+(\d+)\D+(\d+)/);
    if (!rgb) {
      const hex = text.match(/#([0-9a-f]{6})\b/i);
      if (hex) rgb = [null,
        parseInt(hex[1].slice(0, 2), 16),
        parseInt(hex[1].slice(2, 4), 16),
        parseInt(hex[1].slice(4, 6), 16)
      ];
    }
    if (!rgb) return false;
    const red = Number(rgb[1]);
    const green = Number(rgb[2]);
    const blue = Number(rgb[3]);
    return red >= 65 && red <= 225 &&
      Math.max(red, green, blue) - Math.min(red, green, blue) <= 22;
  }

  function isGrayFlag(el) {
    const nodes = [el, ...$$('path,use,i', el)];
    return nodes.some(node => {
      const style = getComputedStyle(node);
      const values = [
        node.getAttribute?.('class'),
        node.getAttribute?.('style'),
        node.getAttribute?.('fill'),
        node.getAttribute?.('stroke'),
        node.getAttribute?.('color'),
        style.color,
        style.fill,
        style.stroke,
        style.backgroundColor
      ];
      return values.some(isGrayColor);
    });
  }

  function flagStatus(row, selector) {
    const flags = flagElements(row, selector);
    if (!flags.length) return 'none';
    if (flags.every(isGreenFlag)) return 'green-only';
    if (flags.every(isBlueFlag)) return 'blue-only';
    if (flags.every(isGrayFlag)) return 'gray-only';
    // 颜色无法确认时按“其他旗子”处理，宁可跳过也不误发。
    return 'other';
  }

  function findBlueFlagOption(savedSelector) {
    const saved = $(savedSelector);
    if (visible(saved) && isBlueFlag(saved)) return saved;
    const candidates = $$([
      '.modify-memo-flag-item',
      '[class*="memo-flag-item"]',
      '[class*="flag-item"]',
      '[role="option"]'
    ].join(','))
      .filter(visible)
      .filter(el => !el.closest('#oma-panel'));
    const blueOptions = candidates.filter(isBlueFlag);
    return blueOptions.length === 1 ? blueOptions[0] : null;
  }

  async function waitForBlueFlagOption(savedSelector, timeout = 10000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const option = findBlueFlagOption(savedSelector);
      if (option) return option;
      await sleep(200);
    }
    throw new Error('点击备注入口后未找到蓝旗选项；请检查备注弹窗是否打开，并重新校准蓝旗选项');
  }

  function findGrayFlagOption(savedSelector) {
    const saved = $(savedSelector);
    if (visible(saved) && isGrayFlag(saved)) return saved;
    const candidates = $$([
      '.modify-memo-flag-item',
      '[class*="memo-flag-item"]',
      '[class*="flag-item"]',
      '[role="option"]'
    ].join(','))
      .filter(visible)
      .filter(el => !el.closest('#oma-panel'));
    const grayOptions = candidates.filter(isGrayFlag);
    return grayOptions.length === 1 ? grayOptions[0] : null;
  }

  async function waitForGrayFlagOption(savedSelector, timeout = 10000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const option = findGrayFlagOption(savedSelector);
      if (option) return option;
      await sleep(200);
    }
    throw new Error('点击备注入口后未找到灰旗选项；请检查备注弹窗是否打开，并重新校准灰旗选项');
  }

  function hasAnyFlag(row, selector) {
    return flagStatus(row, selector) !== 'none';
  }

  async function waitForBlueFlag(originalRow, fingerprint, selectors, timeout = 15000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const currentRows = $$(selectors.row).filter(visible);
      const fingerprintRow = currentRows.find(candidate => rowFingerprint(candidate) === fingerprint);
      const candidates = [originalRow, fingerprintRow].filter((row, position, rows) =>
        row && rows.indexOf(row) === position
      );
      if (candidates.some(row => flagStatus(row, selectors.greenFlagIndicator) === 'blue-only')) return true;
      await sleep(250);
    }
    return false;
  }

  async function waitForGrayFlag(originalRow, fingerprint, selectors, timeout = 15000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const currentRows = $$(selectors.row).filter(visible);
      const fingerprintRow = currentRows.find(candidate => rowFingerprint(candidate) === fingerprint);
      const candidates = [originalRow, fingerprintRow].filter((row, position, rows) =>
        row && rows.indexOf(row) === position
      );
      if (candidates.some(row => flagStatus(row, selectors.greenFlagIndicator) === 'gray-only')) return true;
      await sleep(250);
    }
    return false;
  }

  async function setBlueFlag(row, fingerprint, key, summary, selectors) {
    const currentFlag = flagStatus(row, selectors.greenFlagIndicator);
    if (currentFlag === 'blue-only') {
      log(`订单已有蓝旗，无需重复标记：${orderRef(key, summary)}`);
      return;
    }
    if (currentFlag === 'other') throw new Error('发送后订单出现了其他颜色旗子，已禁止修改备注');
    const entrySelector = currentFlag === 'green-only'
      ? selectors.flaggedNoteEntry
      : selectors.noteEntry;
    const entry = $(entrySelector, row);
    if (!visible(entry)) {
      throw new Error(currentFlag === 'green-only'
        ? '找不到绿旗订单旁的备注铅笔，请重新校准“已有旗子时的备注铅笔”'
        : '找不到无旗订单的备注加号，请重新校准“无旗订单的备注加号”');
    }
    click(entry);
    const flagOption = await waitForBlueFlagOption(selectors.blueFlagOption, 10000);
    click(flagOption);
    await sleep(300);
    const saveButton = await waitFor(selectors.noteSave, 10000);
    click(saveButton);
    if (!await waitForBlueFlag(row, fingerprint, selectors, 15000)) {
      // 快递助手偶尔会重建或虚拟化订单行，导致已显示的绿旗无法被旧选择器确认。
      // 保存动作已经完成，此处只警告并继续，避免一条验证误判中断整批任务。
      log(`警告：备注已保存，但未能自动确认蓝旗，继续处理：${orderRef(key, summary)}`);
      return;
    }
    log(`已设置蓝旗备注：${orderRef(key, summary)}`);
  }

  async function setGrayFlag(row, fingerprint, key, summary, selectors) {
    const currentFlag = flagStatus(row, selectors.greenFlagIndicator);
    if (currentFlag === 'gray-only') {
      log(`订单已有灰旗，无需重复标记：${orderRef(key, summary)}`);
      return;
    }
    if (currentFlag !== 'blue-only') {
      throw new Error('发送后订单已不是蓝旗，已禁止修改备注');
    }
    const entry = $(selectors.flaggedNoteEntry, row);
    if (!visible(entry)) {
      throw new Error('找不到蓝旗订单旁的备注铅笔，请重新校准“已有旗子时的备注铅笔”');
    }
    click(entry);
    const flagOption = await waitForGrayFlagOption(selectors.grayFlagOption, 10000);
    click(flagOption);
    await sleep(300);
    const saveButton = await waitFor(selectors.noteSave, 10000);
    click(saveButton);
    if (!await waitForGrayFlag(row, fingerprint, selectors, 15000)) {
      log(`警告：备注已保存，但未能自动确认灰旗，继续处理：${orderRef(key, summary)}`);
      return;
    }
    log(`已设置灰旗备注：${orderRef(key, summary)}`);
  }

  function findOrderScrollers(row) {
    const candidates = [];
    let node = row?.parentElement || null;
    while (node && node !== document.documentElement) {
      const canScroll = node.scrollHeight > node.clientHeight + 20;
      // ERP 使用自定义滚动条时 overflow-y 可能是 hidden，但 scrollTop 仍可控制虚拟列表。
      if (canScroll && node.clientHeight > 40) candidates.push(node);
      node = node.parentElement;
    }
    const pageScroller = document.scrollingElement;
    if (
      pageScroller &&
      pageScroller.scrollHeight > pageScroller.clientHeight + 20 &&
      !candidates.includes(pageScroller)
    ) candidates.push(pageScroller);
    return candidates;
  }

  async function scrollToNextOrderBatch(selectors) {
    const beforeRows = $$(selectors.row).filter(visible);
    if (!beforeRows.length) return false;
    const beforeSignature = beforeRows.map(rowFingerprint).join('||');
    const rowHeight = beforeRows[0]?.getBoundingClientRect().height || 80;
    const candidates = findOrderScrollers(beforeRows[0]);

    for (const scroller of candidates) {
      const beforeTop = scroller.scrollTop;
      const maxTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
      if (beforeTop >= maxTop - 2) continue;
      // 每次只前进约四分之一屏，确保相邻批次大幅重叠，不遗漏虚拟列表中间行。
      const rowsToAdvance = Math.max(1, Math.floor(beforeRows.length / 4));
      const step = Math.max(
        rowHeight,
        Math.min(scroller.clientHeight * 0.35, rowHeight * rowsToAdvance)
      );
      scroller.scrollTop = Math.min(maxTop, beforeTop + step);
      scroller.dispatchEvent(new Event('scroll', { bubbles: true }));
      await sleep(1000);

      const afterRows = $$(selectors.row).filter(visible);
      const afterSignature = afterRows.map(rowFingerprint).join('||');
      if (scroller.scrollTop > beforeTop + 1 && afterSignature && afterSignature !== beforeSignature) {
        return true;
      }

      // 该元素虽然能滚动，但不控制订单虚拟列表，恢复后尝试下一个父级。
      scroller.scrollTop = beforeTop;
      scroller.dispatchEvent(new Event('scroll', { bubbles: true }));
      await sleep(150);
    }
    log(`未找到能加载下一批订单的滚动容器（已检查 ${candidates.length} 个）`);
    return false;
  }

  async function masterLoopImpl(context = { completed: 0, viewports: new Set(), seen: new Set() }) {
    let s = state();
    if (!s.running) return;
    const required = [
      'row',
      'orderEntry',
      'flaggedNoteEntry',
      'greenFlagIndicator',
      'grayFlagOption',
      'noteSave'
    ];
    const missing = required.filter(name => !s.selectors[name]);
    if (missing.length) {
      save({ running: false });
      return log(`缺少校准项：${missing.map(labelFor).join('、')}`);
    }
    const initialRows = $$(s.selectors.row).filter(visible);
    if (!initialRows.length) {
      save({ running: false });
      return log('没有找到订单行，请重新校准订单行');
    }
    const keys = initialRows.map((row, index) => orderKey(row, index));
    const fingerprints = initialRows.map(rowFingerprint);
    if (new Set(keys).size !== keys.length) {
      save({ running: false, pending: null });
      return log('检测到订单唯一标识冲突，已停止；请重新校准完整订单行');
    }
    if (fingerprints.some(value => !value) || new Set(fingerprints).size !== fingerprints.length) {
      save({ running: false, pending: null });
      return log('检测到订单行指纹为空或重复，已停止；为防止给错误订单打旗，请重新校准完整订单行');
    }
    const viewportSignature = `${fingerprints[0]}||${fingerprints[fingerprints.length - 1]}||${fingerprints.length}`;
    if (context.viewports.has(viewportSignature)) {
      save({ running: false, pending: null, erpOwner: null });
      return log(`已到达订单列表末尾，本次处理结束：完成 ${context.completed} 条`);
    }
    context.viewports.add(viewportSignature);
    log(`已识别当前页面订单：${initialRows.length} 条`);

    for (let index = 0; index < keys.length; index++) {
      s = state();
      if (!s.running) return;
      // 保存绿旗后 ERP 会重建订单表，不能继续使用启动时缓存的旧 DOM 节点。
      const currentRows = $$(s.selectors.row).filter(visible);
      const targetFingerprint = s.pending?.phase === 'sent' && s.pending.index === index
        ? s.pending.rowFingerprint
        : fingerprints[index];
      if (!targetFingerprint) {
        throw new Error('待打旗订单缺少稳定行指纹；为避免标错订单，已禁止继续');
      }
      const matchingRows = currentRows.filter(candidate => rowFingerprint(candidate) === targetFingerprint);
      if (matchingRows.length !== 1) {
        throw new Error(`无法唯一定位第 ${index + 1} 条订单（匹配 ${matchingRows.length} 条）；为避免标错订单，已禁止继续`);
      }
      const row = matchingRows[0];
      const pendingSent = s.pending?.phase === 'sent' && s.pending.index === index;
      if (context.seen.has(targetFingerprint) && !pendingSent) continue;
      if (!pendingSent) context.seen.add(targetFingerprint);
      // 消息发送后必须沿用打开飞鸽前保存的 key。ERP 的倒计时和表格重建
      // 会改变基于行文本生成的临时 key，重新计算会错过打绿旗阶段。
      const key = s.pending?.phase === 'sent' && s.pending.index === index
        ? s.pending.key
        : orderKey(row, index);
      const summary = pendingSent
        ? (s.pending.orderSummary || orderSummary(row))
        : orderSummary(row);

      if (!pendingSent && s.processedFingerprints[targetFingerprint]) continue;

      // 新规则：仅蓝旗发送换紫色消息；无旗及其他颜色全部跳过。
      const currentFlag = flagStatus(row, s.selectors.greenFlagIndicator);
      if (!pendingSent && currentFlag !== 'blue-only') {
        log(`订单不是蓝旗，已跳过消息处理：${orderRef(key, summary)}`);
        continue;
      }

      if (s.pending?.key === key && s.pending.phase === 'sent') {
        const latest = state();
        if (s.dryRun) {
          log(`[演练] 将把蓝旗订单备注设为灰旗：${orderRef(key, summary)}`);
        } else {
          try {
            await setGrayFlag(row, targetFingerprint, key, summary, latest.selectors);
          } catch (error) {
            save({
              running: false,
              failed: Object.assign({}, latest.failed, { [key]: error.message })
            });
            log(`已停止：${error.message}`);
            return;
          }
        }
        save({
          processed: Object.assign({}, latest.processed, { [key]: new Date().toISOString() }),
          processedFingerprints: Object.assign({}, latest.processedFingerprints, {
            [targetFingerprint]: new Date().toISOString()
          }),
          pending: null
        });
        context.completed++;
        log(`${s.dryRun ? '[演练] ' : ''}订单消息流程完成：${orderRef(key, summary)}`);
        continue;
      }

      const selectedMessage = BLUE_FLAG_MESSAGE;
      const postAction = 'set-gray';
      const messageType = '蓝旗换紫色消息';

      const entry = $(s.selectors.orderEntry, row);
      if (!entry) {
        const latest = state();
        save({
          running: false,
          pending: null,
          failed: Object.assign({}, latest.failed, { [key]: '找不到订单入口' })
        });
        return log('找不到当前订单的“进入订单/联系买家入口”，已停止。请重置并重新校准订单行和订单入口');
      }

      log(`准备打开订单（${messageType}）：${orderRef(key, summary)}`);
      save({ pending: { key, index, rowFingerprint: targetFingerprint, orderSummary: summary, message: selectedMessage, messageType, postAction, phase: 'opening', at: Date.now() } });
      if (s.dryRun) {
        log(`[演练] 将打开订单并发送${messageType}：${orderRef(key, summary)}`);
        save({ pending: { key, index, rowFingerprint: targetFingerprint, orderSummary: summary, message: selectedMessage, messageType, postAction, phase: 'sent', at: Date.now() } });
        await sleep(500);
        index--;
        continue;
      }
      click(entry);
      log(`已打开订单：${orderRef(key, summary)}`);
      await sleep(2000);
      await processChatPage();

      const deadline = Date.now() + 90000;
      while (Date.now() < deadline && state().running) {
        if (state().pending?.phase === 'sent') break;
        await sleep(1000);
      }
      if (!state().running) return;
      if (state().pending?.phase !== 'sent') {
        save({ running: false });
        return log('等待消息页处理超时，已停止');
      }
      index--;
      const delay = s.delayMin + Math.random() * (s.delayMax - s.delayMin);
      await sleep(delay);
    }
    if (state().running && await scrollToNextOrderBatch(s.selectors)) {
      log('当前批次处理完成，已滚动到下一批订单');
      return masterLoopImpl(context);
    }
    save({ running: false, pending: null, erpOwner: null });
    if (context.completed > 0) {
      log(`全部可加载订单处理结束：完成 ${context.completed} 条`);
    } else {
      log('没有处理新订单：当前筛选结果可能均已有旗子或本地完成记录');
    }
  }

  function showToast(text) {
    let toast = document.getElementById('oma-toast');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'oma-toast';
      toast.style.cssText = 'position:fixed;z-index:2147483647;left:50%;top:24px;transform:translateX(-50%);background:#222;color:#fff;padding:10px 16px;border-radius:8px;font:14px sans-serif;box-shadow:0 4px 16px #0005';
      document.documentElement.appendChild(toast);
    }
    toast.textContent = text;
    toast.hidden = false;
    setTimeout(() => { toast.hidden = true; }, 5000);
  }

  function button(text, onClick, danger = false) {
    const el = document.createElement('button');
    el.textContent = text;
    el.style.cssText = `border:0;border-radius:6px;padding:6px 9px;cursor:pointer;background:${danger ? '#d93025' : '#1677ff'};color:#fff;font-size:12px`;
    el.addEventListener('click', onClick);
    return el;
  }

  function ensurePanel() {
    if (document.getElementById('oma-panel')) return;
    const panel = document.createElement('section');
    panel.id = 'oma-panel';
    panel.style.cssText = 'position:fixed;z-index:2147483646;right:16px;bottom:16px;width:310px;background:#fff;color:#222;border:1px solid #ddd;border-radius:10px;box-shadow:0 8px 30px #0004;font:13px/1.45 -apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif;padding:12px';
    panel.innerHTML = '<div style="display:flex;justify-content:space-between;align-items:center"><b>订单消息助手</b><button id="oma-fold" style="border:0;background:transparent;cursor:pointer">收起</button></div><div id="oma-body"></div>';
    document.documentElement.appendChild(panel);
    panel.querySelector('#oma-fold').onclick = () => {
      const body = panel.querySelector('#oma-body');
      body.hidden = !body.hidden;
      panel.querySelector('#oma-fold').textContent = body.hidden ? '展开' : '收起';
    };
    render();
  }

  function render() {
    const body = document.getElementById('oma-body');
    if (!body) return;
    const s = state();
    body.innerHTML = '';
    const status = document.createElement('div');
    status.style.cssText = 'margin:8px 0;padding:7px;background:#f5f5f5;border-radius:6px';
    status.textContent = `v2.8.0｜${s.running ? '运行中' : '已停止'}｜${s.dryRun ? '演练模式（不发送）' : '正式模式'}｜本规则已完成 ${Object.keys(s.processedFingerprints || {}).length}`;
    body.appendChild(status);

    const message = document.createElement('div');
    message.style.cssText = 'margin-bottom:8px;color:#555;word-break:break-all';
    message.textContent = `仅蓝旗发送：${BLUE_FLAG_MESSAGE}\n发送成功后：蓝旗改为灰旗`;
    message.style.whiteSpace = 'pre-wrap';
    body.appendChild(message);

    const controls = document.createElement('div');
    controls.style.cssText = 'display:flex;gap:6px;flex-wrap:wrap;margin-bottom:8px';
    if (isERP) {
      controls.append(
        button(s.running ? '停止' : '开始', () => {
          if (s.running) return save({ running: false, erpOwner: null });
          if (!s.dryRun && !confirm(`将只向蓝旗订单发送：\n\n${BLUE_FLAG_MESSAGE}\n\n发送成功后改为灰旗。确定开始吗？`)) return;
          save({ running: true, erpOwner: PAGE_ID });
          masterLoop();
        }, s.running),
        button(s.dryRun ? '切换为正式模式' : '切换为演练模式', () => save({ dryRun: !state().dryRun }))
      );
    }
    controls.append(button('清除进度', () => {
      if (confirm('只清除本脚本的处理记录，不修改订单。确定吗？')) save({ processed: {}, processedFingerprints: {}, failed: {}, pending: null, log: [] });
    }, true));
    if (s.pending) {
      controls.append(button('放弃当前待处理', () => {
        if (confirm('只放弃当前待处理订单，不清除历史完成记录。确定吗？')) {
          save({ running: false, pending: null });
          log('已放弃当前待处理订单');
        }
      }, true));
    }
    controls.append(button('重置校准', () => {
      if (confirm('将清除已记录的页面控件位置，需要重新校准。确定吗？')) {
        sampleRow = null;
        calibration = null;
        save({ running: false, pending: null, selectors: {}, failed: {} });
      }
    }, true));
    body.appendChild(controls);

    const calibrate = document.createElement('div');
    calibrate.style.cssText = 'display:grid;grid-template-columns:1fr 1fr;gap:5px;margin-bottom:8px';
    const items = isERP
      ? [
          ['row', false],
          ['orderEntry', true],
          ['flaggedNoteEntry', true],
          ['greenFlagIndicator', true],
          ['grayFlagOption', false],
          ['noteSave', false]
        ]
      : [];
    for (const [name, relative] of items) {
      const done = !!s.selectors[name];
      calibrate.appendChild(button(`${done ? '✓' : '○'} ${labelFor(name)}`, () => capture(name, relative)));
    }
    body.appendChild(calibrate);

    const logBox = document.createElement('div');
    logBox.style.cssText = 'max-height:105px;overflow:auto;background:#111;color:#ddd;padding:7px;border-radius:6px;font:11px/1.45 monospace;white-space:pre-wrap';
    logBox.textContent = (s.log || []).join('\n') || '等待校准或启动…';
    body.appendChild(logBox);
  }

  ensurePanel();
  GM_addValueChangeListener(STORE, () => {
    render();
    processChatPage();
    const current = state();
    if (isERP && current.running && (!current.erpOwner || current.erpOwner === PAGE_ID)) masterLoop();
  });
  processChatPage();
})();
