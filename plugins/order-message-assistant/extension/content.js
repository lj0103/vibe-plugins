const REQUEST = 'OMA_TRUSTED_SEND_REQUEST';
const RESPONSE = 'OMA_TRUSTED_SEND_RESPONSE';
let busy = false;

function visible(el) {
  return !!el && el.isConnected && el.getClientRects().length > 0;
}

function currentInput() {
  return [...document.querySelectorAll('textarea')]
    .find(el => visible(el) && (el.getAttribute('placeholder') || '').startsWith('发送给')) || null;
}

function recipientOf(input) {
  const placeholder = input?.getAttribute('placeholder') || '';
  return placeholder.match(/^发送给\s*(.+?)，/)?.[1]?.trim() || '';
}

async function waitForIntendedConversation(targetOrderId, timeout = 45000) {
  // 必须以“本次请求开始时”的会话为基准。使用扩展首次加载时的买家会导致
  // 批量处理绕一圈后再次遇到该买家时永远等待。
  const baselineRecipient = recipientOf(currentInput());
  const baselineOrderId = new URLSearchParams(location.search).get('fromOrder') || '';
  const alreadyOnTargetAtStart = baselineOrderId === targetOrderId;
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const input = currentInput();
    const recipient = recipientOf(input);
    const urlOrderId = new URLSearchParams(location.search).get('fromOrder') || '';
    const orderVisible = document.body.textContent.includes(targetOrderId);
    const recipientChanged = !!recipient && (!baselineRecipient || recipient !== baselineRecipient);
    if (
      input &&
      urlOrderId === targetOrderId &&
      orderVisible &&
      (recipientChanged || alreadyOnTargetAtStart)
    ) {
      const stableRecipient = recipient;
      await new Promise(resolve => setTimeout(resolve, 1800));
      const stableInput = currentInput();
      if (recipientOf(stableInput) === stableRecipient) return stableInput;
    }
    await new Promise(resolve => setTimeout(resolve, 300));
  }
  throw new Error(`飞鸽未在限定时间内从旧会话切换到订单 ${targetOrderId} 的买家，已禁止发送`);
}

window.addEventListener('message', async event => {
  // 扩展隔离环境与 Tampermonkey 沙箱中的 window 包装对象并不相等。
  if (event.origin !== location.origin) return;
  const data = event.data;
  if (data?.source !== 'oma-userscript' || data?.type !== REQUEST || !data.requestId) return;
  if (!/^order-\d+$/.test(String(data.orderKey || ''))) return;
  if (!/^\d{10,25}$/.test(String(data.targetOrderId || ''))) return;
  const message = String(data.message || '').trim();
  if (!message || message.length > 800) return;
  const panel = document.getElementById('oma-panel');
  if (!panel || !panel.textContent.includes('运行中')) {
    window.postMessage({ source: 'oma-companion', type: RESPONSE, requestId: data.requestId, ok: false, error: '订单消息助手当前未处于运行状态' }, location.origin);
    return;
  }
  if (busy) {
    window.postMessage({ source: 'oma-companion', type: RESPONSE, requestId: data.requestId, ok: false, error: '配套扩展正在处理上一条消息' }, location.origin);
    return;
  }

  busy = true;
  try {
    const input = await waitForIntendedConversation(String(data.targetOrderId), 45000);
    const sendButtons = [...document.querySelectorAll('button,[role="button"]')]
      .filter(el => visible(el) && (el.textContent || '').replace(/\s/g, '') === '发送');
    const inputRect = input.getBoundingClientRect();
    const sendButton = sendButtons
      .map(el => ({ el, distance: Math.abs(el.getBoundingClientRect().top - inputRect.top) }))
      .sort((a, b) => a.distance - b.distance)[0]?.el;
    if (!sendButton) throw new Error('目标买家会话已打开，但飞鸽发送按钮不可见');
    input.scrollIntoView({ block: 'center', behavior: 'instant' });
    const freshInputRect = input.getBoundingClientRect();
    const sendRect = sendButton.getBoundingClientRect();
    const response = await chrome.runtime.sendMessage({
      type: 'OMA_TRUSTED_SEND',
      inputX: freshInputRect.left + freshInputRect.width / 2,
      inputY: freshInputRect.top + freshInputRect.height / 2,
      sendX: sendRect.left + sendRect.width / 2,
      sendY: sendRect.top + sendRect.height / 2,
      targetOrderId: String(data.targetOrderId),
      message
    });
    window.postMessage({ source: 'oma-companion', type: RESPONSE, requestId: data.requestId, ...response }, location.origin);
  } catch (error) {
    window.postMessage({ source: 'oma-companion', type: RESPONSE, requestId: data.requestId, ok: false, error: error?.message || String(error) }, location.origin);
  } finally {
    busy = false;
  }
});

window.postMessage({ source: 'oma-companion', type: 'OMA_COMPANION_READY' }, location.origin);
