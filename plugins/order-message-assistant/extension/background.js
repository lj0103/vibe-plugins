const ALLOWED_URL = 'https://im.jinritemai.com/pc_seller_v2/main/workspace';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function command(target, method, params = {}) {
  return chrome.debugger.sendCommand(target, method, params);
}

async function key(target, type, keyName, code, virtualKeyCode, modifiers = 0) {
  await command(target, 'Input.dispatchKeyEvent', {
    type,
    key: keyName,
    code,
    modifiers,
    windowsVirtualKeyCode: virtualKeyCode,
    nativeVirtualKeyCode: virtualKeyCode
  });
}

async function mouseClick(target, x, y) {
  await command(target, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  await command(target, 'Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  await command(target, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
}

async function currentSendPoint(target) {
  const result = await command(target, 'Runtime.evaluate', {
    returnByValue: true,
    expression: `(() => {
      const visible = el => !!el && el.isConnected && el.getClientRects().length > 0;
      const input = [...document.querySelectorAll('textarea')]
        .find(el => visible(el) && (el.getAttribute('placeholder') || '').startsWith('发送给'));
      if (!input) return null;
      const inputRect = input.getBoundingClientRect();
      const button = [...document.querySelectorAll('button,[role="button"]')]
        .filter(el => visible(el) && (el.textContent || '').replace(/\\s/g, '') === '发送')
        .map(el => {
          const rect = el.getBoundingClientRect();
          const dx = Math.abs((rect.left + rect.width / 2) - (inputRect.right - rect.width / 2));
          const dy = Math.abs((rect.top + rect.height / 2) - (inputRect.bottom - rect.height / 2));
          return { el, distance: dx + dy };
        })
        .sort((a, b) => a.distance - b.distance)[0]?.el;
      if (!button) return null;
      const rect = button.getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    })()`
  });
  return result?.result?.value || null;
}

async function sendFixedMessage(tabId, points, message) {
  const target = { tabId };
  await chrome.debugger.attach(target, '1.3');
  try {
    // 使用浏览器级真实鼠标点击聚焦输入框，然后产生真实文本输入。
    await mouseClick(target, points.inputX, points.inputY);
    await delay(100);
    await key(target, 'rawKeyDown', 'a', 'KeyA', 65, 4);
    await key(target, 'keyUp', 'a', 'KeyA', 65, 4);
    await key(target, 'rawKeyDown', 'Backspace', 'Backspace', 8);
    await key(target, 'keyUp', 'Backspace', 'Backspace', 8);
    await command(target, 'Input.insertText', { text: message });
    // 长消息会改变输入框高度，因此必须在写入后重新读取按钮位置。
    await delay(800);
    const sendPoint = await currentSendPoint(target);
    if (!sendPoint) throw new Error('消息已写入，但无法重新定位飞鸽发送按钮');
    await mouseClick(target, sendPoint.x, sendPoint.y);
    return { ok: true };
  } finally {
    await chrome.debugger.detach(target).catch(() => {});
  }
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request?.type !== 'OMA_TRUSTED_SEND') return false;
  const tab = sender.tab;
  if (!tab?.id || !tab.url?.startsWith(ALLOWED_URL) || sender.frameId !== 0) {
    sendResponse({ ok: false, error: '请求不是来自飞鸽主工作台' });
    return false;
  }
  const targetOrderId = String(request.targetOrderId || '');
  const message = String(request.message || '').trim();
  const urlOrderId = new URL(tab.url).searchParams.get('fromOrder') || '';
  if (!/^\d{10,25}$/.test(targetOrderId) || urlOrderId !== targetOrderId) {
    sendResponse({ ok: false, error: '飞鸽当前 URL 的订单号与目标订单不一致，已禁止发送' });
    return false;
  }
  if (!message || message.length > 800 || /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(message)) {
    sendResponse({ ok: false, error: '消息内容为空、过长或包含非法控制字符' });
    return false;
  }
  const points = {
    inputX: Number(request.inputX),
    inputY: Number(request.inputY),
    sendX: Number(request.sendX),
    sendY: Number(request.sendY)
  };
  if (Object.values(points).some(value => !Number.isFinite(value) || value < 0 || value > 10000)) {
    sendResponse({ ok: false, error: '输入框或发送按钮坐标无效' });
    return false;
  }
  sendFixedMessage(tab.id, points, message)
    .then(sendResponse)
    .catch(error => sendResponse({ ok: false, error: error?.message || String(error) }));
  return true;
});
