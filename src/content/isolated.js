(function () {
  if (window.__typstAgentIsolatedLoaded) return;
  window.__typstAgentIsolatedLoaded = true;

  const ASYNC_TYPES = {
    GET_EDITOR_CONTEXT: 'TYPST_AGENT_CONTEXT',
    GET_PREVIEW: 'TYPST_AGENT_PREVIEW',
    EXECUTE_TOOL: 'TYPST_AGENT_TOOL_RESULT',
    GET_DIAGNOSTICS: 'TYPST_AGENT_DIAGNOSTICS',
    GET_PROBE: 'TYPST_AGENT_PROBE_RESULT'
  };

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || typeof msg.type !== 'string') return false;

    const responseType = ASYNC_TYPES[msg.type];
    if (!responseType) return false;

    let done = false;
    const cleanup = () => {
      window.removeEventListener('message', onMsg);
      clearTimeout(tid);
    };
    const onMsg = (evt) => {
      if (evt.source !== window || evt.data?.type !== responseType) return;
      if (msg.type === 'EXECUTE_TOOL' && evt.data.callId !== msg.callId) return;
      if (done) return;
      done = true;
      cleanup();
      sendResponse(evt.data);
    };
    const tid = setTimeout(() => {
      if (done) return;
      done = true;
      cleanup();
      sendResponse({ error: 'Timeout waiting for ' + responseType });
    }, 12000);

    window.addEventListener('message', onMsg);

    let mainMsg;
    if (msg.type === 'EXECUTE_TOOL') {
      mainMsg = { type: 'TYPST_AGENT_EXECUTE_TOOL', toolName: msg.toolName, args: msg.args, callId: msg.callId };
    } else if (msg.type === 'GET_EDITOR_CONTEXT') {
      mainMsg = { type: 'TYPST_AGENT_GET_CONTEXT' };
    } else if (msg.type === 'GET_PREVIEW') {
      mainMsg = { type: 'TYPST_AGENT_GET_PREVIEW' };
      if (msg.preferTypstCanvas) mainMsg.preferTypstCanvas = true;
      if (msg.preferAssetImage) mainMsg.preferAssetImage = true;
    } else if (msg.type === 'GET_DIAGNOSTICS') {
      mainMsg = { type: 'TYPST_AGENT_GET_DIAGNOSTICS' };
    } else if (msg.type === 'GET_PROBE') {
      mainMsg = { type: 'TYPST_AGENT_GET_PROBE' };
    }
    window.postMessage(mainMsg, '*');
    return true;
  });

  window.addEventListener('message', (evt) => {
    if (evt.source !== window || !evt.data?.type) return;
    if (evt.data.type === 'TYPST_AGENT_QUICK_SELECTION') {
      chrome.runtime.sendMessage({ type: 'QUICK_ATTACH_SELECTION' }).catch(() => {});
    } else if (evt.data.type === 'TYPST_AGENT_QUICK_IMAGE_PREVIEW') {
      chrome.runtime.sendMessage({ type: 'QUICK_ATTACH_IMAGE_PREVIEW' }).catch(() => {});
    }
  });
})();
