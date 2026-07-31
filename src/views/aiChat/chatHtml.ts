import * as vscode from 'vscode';
import { getNonce, cspMeta } from '../webviewHtml';

/**
 * Shared chat HTML for both hosts (sidebar view and editor panel). The
 * `compact` flag tightens spacing for the narrow sidebar.
 */
export function chatHtml(webview: vscode.Webview, compact: boolean): string {
  const nonce = getNonce();
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
${cspMeta(webview, nonce)}
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>GitNova AI</title>
<style>
  * { box-sizing: border-box; }
  html, body { height: 100%; }
  body { font-family: var(--vscode-font-family, sans-serif); color: var(--vscode-foreground);
    background: ${compact ? 'transparent' : 'var(--vscode-editor-background)'};
    font-size: ${compact ? '12.5px' : '13.5px'}; margin: 0; display: flex; flex-direction: column; }

  /* Header */
  #header { display: flex; align-items: center; gap: 8px; padding: ${compact ? '6px 10px' : '10px 16px'};
    border-bottom: 1px solid var(--vscode-panel-border); }
  #title { flex: 1; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .iconbtn { background: none; border: none; color: var(--vscode-foreground); cursor: pointer;
    padding: 3px 6px; border-radius: 4px; font-size: 14px; line-height: 1; }
  .iconbtn:hover { background: var(--vscode-toolbar-hoverBackground, rgba(255,255,255,0.08)); }

  /* Messages */
  #scroll { flex: 1; overflow-y: auto; }
  #messages { max-width: ${compact ? '100%' : '780px'}; margin: 0 auto; padding: ${compact ? '8px' : '16px 20px'}; }
  .turn { margin: ${compact ? '10px 0' : '16px 0'}; display: flex; flex-direction: column; }
  .who { font-size: 10.5px; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase;
    color: var(--vscode-descriptionForeground); margin-bottom: 4px; }
  .turn.user .who { color: var(--vscode-charts-purple, #A78BFA); }
  .bubble { border-radius: 10px; padding: ${compact ? '8px 11px' : '10px 14px'}; line-height: 1.6;
    word-wrap: break-word; overflow-wrap: anywhere; }
  .turn.user .bubble { background: var(--vscode-input-background);
    border: 1px solid var(--vscode-panel-border); }
  .turn.assistant .bubble { background: var(--vscode-editorWidget-background, rgba(255,255,255,0.035)); }
  .bubble p { margin: 5px 0; }
  .bubble h1, .bubble h2, .bubble h3 { margin: 10px 0 4px; line-height: 1.3; }
  .bubble pre { background: var(--vscode-textCodeBlock-background, rgba(0,0,0,0.25));
    padding: 10px 12px; border-radius: 6px; overflow-x: auto;
    font-size: ${compact ? '11.5px' : '12.5px'}; position: relative; }
  .bubble code { font-family: var(--vscode-editor-font-family, monospace);
    background: var(--vscode-textCodeBlock-background, rgba(0,0,0,0.25));
    padding: 1px 4px; border-radius: 3px; font-size: 0.95em; }
  .bubble pre code { background: none; padding: 0; }
  .bubble ul, .bubble ol { margin: 4px 0; padding-left: 20px; }
  .bubble blockquote { border-left: 3px solid var(--vscode-textBlockQuote-border, #555);
    margin: 6px 0; padding: 2px 10px; color: var(--vscode-descriptionForeground); }
  .copybtn { position: absolute; top: 6px; right: 6px; font-size: 10px; opacity: 0;
    transition: opacity .15s; background: var(--vscode-button-secondaryBackground, #3a3d41);
    color: var(--vscode-button-secondaryForeground, #fff); border: none; border-radius: 3px;
    padding: 2px 7px; cursor: pointer; }
  pre:hover .copybtn { opacity: 1; }

  /* Tool chips */
  .toolchip { display: flex; flex-direction: column; gap: 2px; margin: 6px 0; font-size: 11px;
    border-left: 2px solid var(--vscode-charts-purple, #7C3AED);
    background: rgba(124, 58, 237, 0.06); border-radius: 0 6px 6px 0; padding: 5px 10px;
    color: var(--vscode-descriptionForeground); cursor: pointer; }
  .toolchip .thead { font-family: var(--vscode-editor-font-family, monospace); }
  .toolchip .tbody { display: none; white-space: pre-wrap; max-height: 180px; overflow-y: auto;
    font-family: var(--vscode-editor-font-family, monospace); font-size: 10.5px; margin-top: 3px; }
  .toolchip.open .tbody { display: block; }

  .cursor { display: inline-block; width: 7px; height: 14px; vertical-align: text-bottom;
    background: var(--vscode-editorCursor-foreground, #aeafad); animation: blink 1s steps(1) infinite; }
  @keyframes blink { 50% { opacity: 0; } }
  .err { color: var(--vscode-errorForeground); font-size: 12px; padding: 6px 2px; }

  /* Welcome */
  #welcome { padding: ${compact ? '18px 12px' : '48px 24px'}; text-align: center; }
  #welcome .big { font-size: ${compact ? '14px' : '18px'}; font-weight: 600; margin-bottom: 6px; }
  #welcome .sub { color: var(--vscode-descriptionForeground); margin-bottom: 16px; }
  .sugg { display: grid; grid-template-columns: ${compact ? '1fr' : '1fr 1fr'}; gap: 8px;
    max-width: 560px; margin: 0 auto; }
  .sugg button { text-align: left; background: var(--vscode-editorWidget-background, rgba(255,255,255,0.04));
    border: 1px solid var(--vscode-panel-border); color: var(--vscode-foreground);
    border-radius: 8px; padding: 10px 12px; cursor: pointer; font-size: 12.5px; }
  .sugg button:hover { border-color: var(--vscode-focusBorder); }

  /* Composer */
  #composerWrap { border-top: 1px solid var(--vscode-panel-border); padding: ${compact ? '8px' : '12px 20px 8px'}; }
  #composer { max-width: ${compact ? '100%' : '780px'}; margin: 0 auto; }
  #inputRow { display: flex; align-items: flex-end; gap: 8px;
    background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
    border-radius: 10px; padding: 7px 9px; }
  #inputRow:focus-within { border-color: var(--vscode-focusBorder); }
  textarea { flex: 1; resize: none; background: none; border: none; outline: none;
    color: var(--vscode-input-foreground); font-family: inherit; font-size: inherit;
    line-height: 1.5; max-height: 160px; }
  #send { background: var(--vscode-button-background); color: var(--vscode-button-foreground);
    border: none; border-radius: 7px; width: 28px; height: 28px; cursor: pointer; font-size: 14px; }
  #send:disabled { opacity: 0.4; cursor: default; }
  #stop { background: var(--vscode-inputValidation-errorBackground, #5a1d1d); color: #fff;
    border: none; border-radius: 7px; height: 28px; padding: 0 10px; cursor: pointer; font-size: 12px; }
  #footer { display: flex; align-items: center; gap: 10px; padding: 6px 2px 2px;
    font-size: 11px; color: var(--vscode-descriptionForeground); flex-wrap: wrap; }
  #model { cursor: pointer; }
  #model:hover { color: var(--vscode-textLink-foreground); }
  label.ctx { display: flex; align-items: center; gap: 4px; cursor: pointer; user-select: none; }
  #footer .spacer { flex: 1; }
</style>
</head>
<body>
  <div id="header">
    <span id="title">New chat</span>
    <button class="iconbtn" id="newChat" title="New chat">＋</button>
    <button class="iconbtn" id="history" title="Chat history">🕘</button>
    ${compact ? '<button class="iconbtn" id="openPanel" title="Open as editor panel">⧉</button>' : ''}
  </div>
  <div id="scroll">
    <div id="messages"></div>
    <div id="welcome" hidden>
      <div class="big">GitNova AI</div>
      <div class="sub">Ask anything about <span id="repoName">this repository</span> —
        it can read status, history, diffs, blame and branches.</div>
      <div class="sugg">
        <button data-q="Summarize what changed in the working tree right now.">Summarize my current changes</button>
        <button data-q="What are the most significant recent commits and what did they do?">Recap recent commits</button>
        <button data-q="Which branches exist, and how do they relate to the current branch?">Explain the branch situation</button>
        <button data-q="Look at the currently selected code and explain its git history.">History of the selected code</button>
      </div>
    </div>
  </div>
  <div id="composerWrap">
    <div id="composer">
      <div id="inputRow">
        <textarea id="input" placeholder="Ask about this repo… (Enter to send, Shift+Enter for newline)" rows="1"></textarea>
        <button id="stop" hidden>Stop</button>
        <button id="send" title="Send">➤</button>
      </div>
      <div id="footer">
        <span id="model" title="Click to change provider/model">…</span>
        <label class="ctx"><input type="checkbox" id="editorCtx" checked />editor context</label>
        <span class="spacer"></span>
        <span id="hint"></span>
      </div>
    </div>
  </div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const messagesEl = document.getElementById('messages');
    const scrollEl = document.getElementById('scroll');
    const welcomeEl = document.getElementById('welcome');
    const input = document.getElementById('input');
    const sendBtn = document.getElementById('send');
    const stopBtn = document.getElementById('stop');
    const modelEl = document.getElementById('model');
    const ctxBox = document.getElementById('editorCtx');
    let streamEl = null, streamRaw = '', busy = false, stick = true;

    // ------- helpers
    function esc(s) {
      return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }
    function inline(s) {
      return s
        .replace(/\`([^\`]+)\`/g, (_, c) => '<code>' + c + '</code>')
        .replace(/\\*\\*([^*]+)\\*\\*/g, '<strong>$1</strong>')
        .replace(/(^|[^*])\\*([^*\\s][^*]*)\\*/g, '$1<em>$2</em>')
        .replace(/\\[([^\\]]+)\\]\\((https?:[^)\\s]+)\\)/g, '<a href="$2">$1</a>');
    }
    function md(raw) {
      const lines = raw.split('\\n');
      let html = '', inCode = false, listTag = null;
      const closeList = () => { if (listTag) { html += '</' + listTag + '>'; listTag = null; } };
      for (const lineRaw of lines) {
        const line = esc(lineRaw);
        if (line.startsWith('\`\`\`')) {
          closeList();
          html += inCode ? '</code></pre>' : '<pre><button class="copybtn">copy</button><code>';
          inCode = !inCode; continue;
        }
        if (inCode) { html += line + '\\n'; continue; }
        const h = line.match(/^(#{1,3})\\s+(.*)$/);
        if (h) { closeList(); html += '<h' + h[1].length + '>' + inline(h[2]) + '</h' + h[1].length + '>'; continue; }
        const ul = line.match(/^\\s*[-*]\\s+(.*)$/);
        const ol = line.match(/^\\s*\\d+[.)]\\s+(.*)$/);
        if (ul || ol) {
          const tag = ul ? 'ul' : 'ol';
          if (listTag !== tag) { closeList(); html += '<' + tag + '>'; listTag = tag; }
          html += '<li>' + inline((ul || ol)[1]) + '</li>'; continue;
        }
        if (line.startsWith('&gt;')) { closeList(); html += '<blockquote>' + inline(line.slice(4)) + '</blockquote>'; continue; }
        closeList();
        if (line.trim() === '') continue;
        html += '<p>' + inline(line) + '</p>';
      }
      if (inCode) html += '</code></pre>';
      closeList();
      return html;
    }
    function scrollDown() { if (stick) scrollEl.scrollTop = scrollEl.scrollHeight; }
    scrollEl.addEventListener('scroll', () => {
      stick = scrollEl.scrollTop + scrollEl.clientHeight >= scrollEl.scrollHeight - 60;
    });

    function addTurn(role, contentHtml) {
      welcomeEl.hidden = true;
      const turn = document.createElement('div');
      turn.className = 'turn ' + role;
      turn.innerHTML = '<div class="who">' + (role === 'user' ? 'You' : 'GitNova AI') + '</div>' +
        '<div class="bubble">' + contentHtml + '</div>';
      messagesEl.appendChild(turn);
      scrollDown();
      return turn.querySelector('.bubble');
    }
    function addToolChip(tool, argsText, resultText) {
      welcomeEl.hidden = true;
      const chip = document.createElement('div');
      chip.className = 'toolchip';
      chip.innerHTML = '<span class="thead">🔧 ' + esc(tool) + ' ' + esc(argsText || '') + '</span>' +
        '<span class="tbody">' + esc(resultText || '(running…)') + '</span>';
      chip.addEventListener('click', () => chip.classList.toggle('open'));
      messagesEl.appendChild(chip);
      scrollDown();
      return chip;
    }
    function addError(text) {
      const div = document.createElement('div');
      div.className = 'err';
      div.textContent = text;
      messagesEl.appendChild(div);
      scrollDown();
    }

    // Copy buttons in code blocks (delegated)
    messagesEl.addEventListener('click', e => {
      const btn = e.target.closest('.copybtn');
      if (!btn) return;
      const code = btn.parentElement.querySelector('code');
      navigator.clipboard.writeText(code ? code.innerText : '');
      btn.textContent = 'copied';
      setTimeout(() => (btn.textContent = 'copy'), 1200);
    });

    // ------- composer
    function autoGrow() {
      input.style.height = 'auto';
      input.style.height = Math.min(input.scrollHeight, 160) + 'px';
    }
    input.addEventListener('input', autoGrow);
    function send(textOverride) {
      const text = (textOverride ?? input.value).trim();
      if (!text || busy) return;
      input.value = ''; autoGrow();
      vscode.postMessage({ type: 'send', text });
    }
    sendBtn.addEventListener('click', () => send());
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
    });
    stopBtn.addEventListener('click', () => vscode.postMessage({ type: 'stop' }));
    document.getElementById('newChat').addEventListener('click', () => vscode.postMessage({ type: 'newChat' }));
    document.getElementById('history').addEventListener('click', () => vscode.postMessage({ type: 'history' }));
    const openPanelBtn = document.getElementById('openPanel');
    if (openPanelBtn) openPanelBtn.addEventListener('click', () => vscode.postMessage({ type: 'openPanel' }));
    modelEl.addEventListener('click', () => vscode.postMessage({ type: 'selectModel' }));
    ctxBox.addEventListener('change', () => vscode.postMessage({ type: 'toggleEditorContext', value: ctxBox.checked }));
    welcomeEl.addEventListener('click', e => {
      const b = e.target.closest('[data-q]');
      if (b) send(b.dataset.q);
    });

    // ------- state / stream handling
    window.addEventListener('message', e => {
      const m = e.data;
      switch (m.type) {
        case 'state': {
          document.getElementById('title').textContent = m.session.title;
          document.getElementById('repoName').textContent = m.repo || 'this repository';
          modelEl.textContent = '✦ ' + m.model;
          ctxBox.checked = !!m.editorContext;
          messagesEl.innerHTML = '';
          streamEl = null;
          for (const rec of m.session.messages) {
            if (rec.role === 'user') addTurn('user', md(rec.content));
            else if (rec.role === 'assistant') addTurn('assistant', md(rec.content));
            else addToolChip(rec.tool, rec.args, rec.content.slice(0, 1500));
          }
          welcomeEl.hidden = m.session.messages.length > 0;
          setBusy(!!m.busy);
          stick = true; scrollDown();
          break;
        }
        case 'title':
          document.getElementById('title').textContent = m.title;
          break;
        case 'userMessage':
          addTurn('user', md(m.text));
          break;
        case 'assistantStart':
          streamRaw = '';
          streamEl = addTurn('assistant', '<span class="cursor"></span>');
          break;
        case 'assistantChunk':
          streamRaw += m.text;
          if (streamEl) { streamEl.innerHTML = md(streamRaw) + '<span class="cursor"></span>'; scrollDown(); }
          break;
        case 'assistantEnd':
          if (streamEl) streamEl.innerHTML = md(streamRaw);
          streamEl = null;
          break;
        case 'toolCall': {
          // The streamed JSON becomes a compact tool chip instead
          if (streamEl) { streamEl.closest('.turn').remove(); streamEl = null; }
          addToolChip(m.tool, JSON.stringify(m.args), '');
          break;
        }
        case 'toolResult': {
          const chips = messagesEl.querySelectorAll('.toolchip');
          const last = chips[chips.length - 1];
          if (last) last.querySelector('.tbody').textContent = m.preview || '(empty)';
          break;
        }
        case 'error':
          if (streamEl) { streamEl.innerHTML = md(streamRaw); streamEl = null; }
          addError(m.message);
          break;
        case 'busy':
          setBusy(m.busy);
          break;
      }
    });

    function setBusy(b) {
      busy = b;
      stopBtn.hidden = !b;
      sendBtn.disabled = b;
      document.getElementById('hint').textContent = b ? 'thinking…' : '';
    }

    vscode.postMessage({ type: 'init' });
  </script>
</body>
</html>`;
}
