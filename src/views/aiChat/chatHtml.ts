import * as vscode from 'vscode';
import { getNonce, cspMeta } from '../webviewHtml';

/**
 * Shared chat HTML for both hosts (sidebar view and editor panel).
 *
 * Rendering/animation notes:
 * - Streaming uses an adaptive typewriter: incoming chunks land in a pending
 *   buffer and a requestAnimationFrame pump reveals them at a rate that
 *   scales with the backlog, so text flows smoothly and never lags the model.
 * - Markdown rendering includes fenced code with a lightweight scanner-based
 *   syntax highlighter (strings/comments/keywords/numbers/diff), language
 *   badges + copy buttons, tables, lists, quotes and links.
 * - Message entrances, the thinking indicator, the caret, and tool chips are
 *   all CSS-animated; bubbles re-render throttled (~30ms) during streaming.
 *
 * The `compact` flag tightens spacing for the narrow sidebar.
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
    font-size: ${compact ? '12.5px' : '13.5px'}; margin: 0; display: flex; flex-direction: column;
    overflow: hidden; /* one scroll region only (#scroll) — never a second page scrollbar */ }

  /* Slim, themed scrollbars.
     Modern Chromium (recent VS Code) honours the STANDARD scrollbar-width /
     scrollbar-color properties — and once scrollbar-color is set anywhere
     (VS Code's injected webview defaults set it), all ::-webkit-scrollbar
     rules are ignored per spec. So the standard properties are the real fix;
     the webkit rules below only serve older engines. */
  * { scrollbar-width: thin; }
  html { scrollbar-color: var(--vscode-scrollbarSlider-background, rgba(121,121,121,0.45)) transparent; }
  ::-webkit-scrollbar { width: 6px; height: 6px; }
  ::-webkit-scrollbar-button { display: none; width: 0; height: 0; }
  ::-webkit-scrollbar-track { background: transparent; }
  ::-webkit-scrollbar-thumb { background: var(--vscode-scrollbarSlider-background, rgba(121,121,121,0.35));
    border-radius: 3px; }
  ::-webkit-scrollbar-thumb:hover { background: var(--vscode-scrollbarSlider-hoverBackground, rgba(100,100,100,0.6)); }
  ::-webkit-scrollbar-corner { background: transparent; }

  /* ---------- Header ---------- */
  #header { display: flex; align-items: center; gap: 8px; padding: ${compact ? '6px 10px' : '10px 16px'};
    border-bottom: 1px solid var(--vscode-panel-border); }
  #title { flex: 1; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .iconbtn { background: none; border: none; color: var(--vscode-foreground); cursor: pointer;
    padding: 4px 6px; border-radius: 4px; line-height: 0; display: inline-flex; align-items: center;
    transition: background .12s ease, transform .12s ease; }
  .iconbtn svg { display: block; }
  .iconbtn:hover { background: var(--vscode-toolbar-hoverBackground, rgba(255,255,255,0.08)); transform: scale(1.08); }
  .iconbtn:active { transform: scale(0.94); }

  /* ---------- Messages ---------- */
  #scroll { flex: 1; overflow-y: auto; scroll-behavior: auto; }
  #messages { max-width: ${compact ? '100%' : '780px'}; margin: 0 auto; padding: ${compact ? '8px' : '16px 20px'}; }
  .turn { margin: ${compact ? '10px 0' : '16px 0'}; display: flex; flex-direction: column;
    animation: rise .28s cubic-bezier(.2,.8,.25,1); }
  @keyframes rise { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: none; } }
  .who { font-size: 10.5px; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase;
    color: var(--vscode-descriptionForeground); margin-bottom: 4px; display: flex; align-items: center; gap: 6px; }
  .turn.user .who { color: var(--vscode-charts-purple, #A78BFA); }
  .turn.assistant .who::before { content: '✦'; color: var(--vscode-charts-purple, #A78BFA); }
  .bubble { border-radius: 12px; padding: ${compact ? '8px 11px' : '11px 15px'}; line-height: 1.62;
    word-wrap: break-word; overflow-wrap: anywhere; }
  .turn.user .bubble { background: var(--vscode-input-background);
    border: 1px solid var(--vscode-panel-border); }
  .turn.assistant .bubble { background: var(--vscode-editorWidget-background, rgba(255,255,255,0.035)); }
  .bubble > *:first-child { margin-top: 0; }
  .bubble > *:last-child { margin-bottom: 0; }
  .bubble p { margin: 6px 0; }
  .bubble h1, .bubble h2, .bubble h3 { margin: 12px 0 5px; line-height: 1.3; }
  .bubble h1 { font-size: 1.25em; } .bubble h2 { font-size: 1.12em; } .bubble h3 { font-size: 1.02em; }
  .bubble ul, .bubble ol { margin: 5px 0; padding-left: 20px; }
  .bubble li { margin: 2px 0; }
  .bubble blockquote { border-left: 3px solid var(--vscode-charts-purple, #7C3AED);
    margin: 6px 0; padding: 2px 10px; color: var(--vscode-descriptionForeground); }
  .bubble hr { border: none; border-top: 1px solid var(--vscode-panel-border); margin: 10px 0; }
  .bubble a { color: var(--vscode-textLink-foreground); text-decoration: none; }
  .bubble a:hover { text-decoration: underline; }
  .bubble table { border-collapse: collapse; margin: 8px 0; font-size: 0.95em; display: block; overflow-x: auto; }
  .bubble th, .bubble td { border: 1px solid var(--vscode-panel-border); padding: 4px 10px; text-align: left; }
  .bubble th { background: var(--vscode-editorWidget-background, rgba(255,255,255,0.05)); font-weight: 600; }
  .bubble code { font-family: var(--vscode-editor-font-family, monospace);
    background: var(--vscode-textCodeBlock-background, rgba(0,0,0,0.25));
    padding: 1px 5px; border-radius: 4px; font-size: 0.93em; }

  /* Code blocks */
  .codeblock { margin: 8px 0; border-radius: 8px; overflow: hidden;
    border: 1px solid var(--vscode-panel-border);
    background: var(--vscode-textCodeBlock-background, rgba(0,0,0,0.25)); }
  .codebar { display: flex; align-items: center; justify-content: space-between;
    padding: 3px 10px; font-size: 10.5px; color: var(--vscode-descriptionForeground);
    border-bottom: 1px solid var(--vscode-panel-border); background: rgba(0,0,0,0.12); }
  .codeblock pre { margin: 0; padding: 10px 12px; overflow-x: auto;
    font-size: ${compact ? '11.5px' : '12.5px'}; }
  .codeblock code { background: none; padding: 0; border-radius: 0; font-size: 1em; }
  .copybtn { font-size: 10px; background: none; border: 1px solid var(--vscode-panel-border);
    color: var(--vscode-descriptionForeground); border-radius: 4px; padding: 1px 8px; cursor: pointer;
    transition: all .12s ease; }
  .copybtn:hover { color: var(--vscode-foreground); border-color: var(--vscode-focusBorder); }
  .tok-k { color: var(--vscode-charts-purple, #C586C0); }
  .tok-s { color: var(--vscode-charts-orange, #CE9178); }
  .tok-c { color: var(--vscode-descriptionForeground); font-style: italic; }
  .tok-n { color: var(--vscode-charts-green, #B5CEA8); }
  .tok-add { color: #4EC9B0; } .tok-add-bg { display: block; background: rgba(46,160,67,0.15); }
  .tok-del { color: #F14C4C; } .tok-del-bg { display: block; background: rgba(248,81,73,0.15); }

  /* Streaming caret + thinking dots */
  .caret { display: inline-block; width: 8px; height: 15px; margin-left: 1px; border-radius: 2px;
    vertical-align: text-bottom;
    background: linear-gradient(180deg, var(--vscode-charts-purple, #A78BFA), var(--vscode-charts-blue, #60A5FA));
    animation: caretPulse 0.9s ease-in-out infinite; }
  @keyframes caretPulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.25; } }
  .dots { display: inline-flex; gap: 5px; align-items: center; height: 18px; }
  .dots span { width: 6px; height: 6px; border-radius: 50%;
    background: var(--vscode-charts-purple, #A78BFA); animation: bounce 1.2s ease-in-out infinite; }
  .dots span:nth-child(2) { animation-delay: 0.15s; }
  .dots span:nth-child(3) { animation-delay: 0.3s; }
  @keyframes bounce { 0%, 60%, 100% { transform: translateY(0); opacity: .45; }
    30% { transform: translateY(-5px); opacity: 1; } }

  /* Tool chips */
  .toolchip { display: flex; flex-direction: column; gap: 2px; margin: 8px 0; font-size: 11px;
    border-left: 2px solid var(--vscode-charts-purple, #7C3AED);
    background: rgba(124, 58, 237, 0.07); border-radius: 0 8px 8px 0; padding: 6px 11px;
    color: var(--vscode-descriptionForeground); cursor: pointer;
    animation: rise .25s cubic-bezier(.2,.8,.25,1); transition: background .15s ease; }
  .toolchip:hover { background: rgba(124, 58, 237, 0.13); }
  .toolchip .thead { font-family: var(--vscode-editor-font-family, monospace);
    display: flex; align-items: center; gap: 6px; }
  .toolchip .spin { display: inline-block; animation: spin 0.9s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
  .toolchip .ok { color: var(--vscode-charts-green, #10B981); }
  .toolchip .tbody { white-space: pre-wrap; overflow-y: auto;
    font-family: var(--vscode-editor-font-family, monospace); font-size: 10.5px;
    max-height: 0; opacity: 0; transition: max-height .25s ease, opacity .2s ease, margin .2s ease; margin-top: 0; }
  .toolchip.open .tbody { max-height: 200px; opacity: 1; margin-top: 4px; }

  .err { color: var(--vscode-errorForeground); font-size: 12px; padding: 6px 2px;
    animation: rise .25s ease; }

  /* ---------- Welcome ---------- */
  #welcome { padding: ${compact ? '18px 12px' : '48px 24px'}; text-align: center;
    animation: rise .35s cubic-bezier(.2,.8,.25,1); }
  #welcome .logo { font-size: ${compact ? '22px' : '30px'}; margin-bottom: 8px;
    background: linear-gradient(135deg, var(--vscode-charts-purple, #A78BFA), var(--vscode-charts-blue, #60A5FA));
    -webkit-background-clip: text; background-clip: text; color: transparent; }
  #welcome .big { font-size: ${compact ? '14px' : '18px'}; font-weight: 600; margin-bottom: 6px; }
  #welcome .sub { color: var(--vscode-descriptionForeground); margin-bottom: 18px; }
  .sugg { display: grid; grid-template-columns: ${compact ? '1fr' : '1fr 1fr'}; gap: 8px;
    max-width: 560px; margin: 0 auto; }
  .sugg button { text-align: left; background: var(--vscode-editorWidget-background, rgba(255,255,255,0.04));
    border: 1px solid var(--vscode-panel-border); color: var(--vscode-foreground);
    border-radius: 10px; padding: 11px 13px; cursor: pointer; font-size: 12.5px;
    transition: transform .15s ease, border-color .15s ease, box-shadow .15s ease; }
  .sugg button:hover { border-color: var(--vscode-focusBorder); transform: translateY(-2px);
    box-shadow: 0 4px 14px rgba(0,0,0,0.25); }

  /* ---------- Composer ---------- */
  #composerWrap { border-top: 1px solid var(--vscode-panel-border); padding: ${compact ? '8px' : '12px 20px 8px'}; }
  #composer { max-width: ${compact ? '100%' : '780px'}; margin: 0 auto; }
  #inputRow { display: flex; align-items: flex-end; gap: 8px;
    background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
    border-radius: 12px; padding: 8px 10px; transition: border-color .15s ease, box-shadow .15s ease; }
  #inputRow:focus-within { border-color: var(--vscode-focusBorder);
    box-shadow: 0 0 0 1px var(--vscode-focusBorder); }
  textarea { flex: 1; resize: none; background: none; border: none; outline: none;
    color: var(--vscode-input-foreground); font-family: inherit; font-size: inherit;
    line-height: 1.5; max-height: 160px; scrollbar-width: none; }
  textarea::-webkit-scrollbar { display: none; }
  #send { background: linear-gradient(135deg, var(--vscode-charts-purple, #7C3AED), var(--vscode-charts-blue, #3B82F6));
    color: #fff; border: none; border-radius: 8px; width: 30px; height: 30px; cursor: pointer;
    font-size: 14px; transition: transform .12s ease, opacity .15s ease, filter .15s ease; }
  #send:hover:not(:disabled) { transform: scale(1.08); filter: brightness(1.15); }
  #send:active:not(:disabled) { transform: scale(0.92); }
  #send:disabled { opacity: 0.35; cursor: default; }
  #stop { background: var(--vscode-inputValidation-errorBackground, #5a1d1d); color: #fff;
    border: none; border-radius: 8px; height: 30px; padding: 0 12px; cursor: pointer; font-size: 12px;
    animation: rise .2s ease; }
  #footer { display: flex; align-items: center; gap: 10px; padding: 7px 2px 2px;
    font-size: 11px; color: var(--vscode-descriptionForeground); flex-wrap: wrap; }
  #model { cursor: pointer; transition: color .12s ease; }
  #model:hover { color: var(--vscode-textLink-foreground); }
  label.ctx { display: flex; align-items: center; gap: 4px; cursor: pointer; user-select: none; }
  #footer .spacer { flex: 1; }
</style>
</head>
<body>
  <div id="header">
    <span id="title">New chat</span>
    <button class="iconbtn" id="newChat" title="New chat">
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><path d="M8 3v10M3 8h10"/></svg>
    </button>
    <button class="iconbtn" id="history" title="Chat history">
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><path d="M3.1 6.4A5.2 5.2 0 1 1 2.8 9"/><path d="M2.2 5.2l.9 1.9 2-.6"/><path d="M8 5.2V8.2l2.1 1.3"/></svg>
    </button>
    ${
      compact
        ? `<button class="iconbtn" id="openPanel" title="Open as editor panel">
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><rect x="2.5" y="2.5" width="11" height="11" rx="1.5"/><path d="M6.5 9.5l3.5-3.5M7.5 6h2.5v2.5"/></svg>
    </button>`
        : ''
    }
  </div>
  <div id="scroll">
    <div id="messages"></div>
    <div id="welcome" hidden>
      <div class="logo">✦</div>
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
    const hintEl = document.getElementById('hint');
    let busy = false, stick = true;

    // ===================== markdown + syntax highlighting =====================
    function esc(s) {
      return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }
    function inline(s) {
      return s
        .replace(/\`([^\`]+)\`/g, function(_, c) { return '<code>' + c + '</code>'; })
        .replace(/\\*\\*([^*]+)\\*\\*/g, '<strong>$1</strong>')
        .replace(/(^|[^*])\\*([^*\\s][^*]*)\\*/g, '$1<em>$2</em>')
        .replace(/\\[([^\\]]+)\\]\\((https?:[^)\\s]+)\\)/g, '<a href="$2">$1</a>');
    }

    const KEYWORDS = new Set(('const let var function return if else for while do switch case break continue ' +
      'import from export default class new async await try catch finally throw typeof instanceof in of ' +
      'interface type enum extends implements public private protected readonly static void yield delete ' +
      'def elif lambda pass with as global nonlocal raise except is not and or None True False ' +
      'fn pub use match struct impl mut loop trait mod crate self Self where ' +
      'null undefined true false this super package final abstract').split(' '));
    const HASH_COMMENT_LANGS = new Set(['python','py','bash','sh','shell','zsh','yaml','yml','ruby','rb','toml','ini','']);

    /** Scanner-based highlighter: safe on any input, no regex-on-html issues. */
    function hl(src, lang) {
      lang = (lang || '').toLowerCase();
      if (lang === 'diff' || lang === 'patch') {
        return src.split('\\n').map(function(l) {
          if (l.startsWith('+')) return '<span class="tok-add-bg tok-add">' + esc(l) + '</span>';
          if (l.startsWith('-')) return '<span class="tok-del-bg tok-del">' + esc(l) + '</span>';
          if (l.startsWith('@@')) return '<span class="tok-k">' + esc(l) + '</span>';
          return esc(l) + '\\n';
        }).join('');
      }
      const hashComments = HASH_COMMENT_LANGS.has(lang);
      const slashComments = !hashComments || lang === '';
      let out = '', i = 0;
      const n = src.length;
      function span(cls, text) { out += '<span class="' + cls + '">' + esc(text) + '</span>'; }
      while (i < n) {
        const c = src[i];
        // line comments
        if (slashComments && c === '/' && src[i+1] === '/') {
          let j = src.indexOf('\\n', i); if (j === -1) j = n;
          span('tok-c', src.slice(i, j)); i = j; continue;
        }
        if (slashComments && c === '/' && src[i+1] === '*') {
          let j = src.indexOf('*/', i + 2); j = j === -1 ? n : j + 2;
          span('tok-c', src.slice(i, j)); i = j; continue;
        }
        if (hashComments && c === '#') {
          let j = src.indexOf('\\n', i); if (j === -1) j = n;
          span('tok-c', src.slice(i, j)); i = j; continue;
        }
        // strings
        if (c === '"' || c === "'" || c === '\`') {
          let j = i + 1;
          while (j < n && src[j] !== c) { if (src[j] === '\\\\') j++; j++; }
          j = Math.min(j + 1, n);
          span('tok-s', src.slice(i, j)); i = j; continue;
        }
        // numbers
        if (c >= '0' && c <= '9' && !/[A-Za-z0-9_$]/.test(src[i-1] || '')) {
          let j = i;
          while (j < n && /[0-9a-fA-FxX._]/.test(src[j])) j++;
          span('tok-n', src.slice(i, j)); i = j; continue;
        }
        // identifiers / keywords
        if (/[A-Za-z_$]/.test(c)) {
          let j = i;
          while (j < n && /[A-Za-z0-9_$]/.test(src[j])) j++;
          const word = src.slice(i, j);
          if (KEYWORDS.has(word)) span('tok-k', word); else out += esc(word);
          i = j; continue;
        }
        out += esc(c); i++;
      }
      return out;
    }

    function codeBlockHtml(raw, lang) {
      return '<div class="codeblock"><div class="codebar"><span>' + esc(lang || 'code') +
        '</span><button class="copybtn">copy</button></div><pre><code>' +
        hl(raw, lang) + '</code></pre></div>';
    }

    function tableHtml(rows) {
      const cells = function(line) {
        return line.replace(/^\\s*\\|/, '').replace(/\\|\\s*$/, '').split('|').map(function(s) { return s.trim(); });
      };
      let html = '<table><thead><tr>';
      for (const h of cells(rows[0])) html += '<th>' + inline(esc(h)) + '</th>';
      html += '</tr></thead><tbody>';
      for (let r = 2; r < rows.length; r++) {
        html += '<tr>';
        for (const d of cells(rows[r])) html += '<td>' + inline(esc(d)) + '</td>';
        html += '</tr>';
      }
      return html + '</tbody></table>';
    }

    function md(raw) {
      const lines = raw.split('\\n');
      let html = '', inCode = false, codeLang = '', codeBuf = [], listTag = null, tableBuf = [];
      const closeList = function() { if (listTag) { html += '</' + listTag + '>'; listTag = null; } };
      const flushTable = function() {
        if (!tableBuf.length) return;
        if (tableBuf.length >= 2 && /^\\s*\\|?[\\s:|-]+\\|?\\s*$/.test(tableBuf[1])) {
          html += tableHtml(tableBuf);
        } else {
          for (const l of tableBuf) html += '<p>' + inline(esc(l)) + '</p>';
        }
        tableBuf = [];
      };
      for (const lineRaw of lines) {
        const fence = lineRaw.match(/^\\s*\`\`\`\\s*(\\S*)\\s*$/);
        if (fence) {
          flushTable(); closeList();
          if (!inCode) { inCode = true; codeLang = fence[1]; codeBuf = []; }
          else { html += codeBlockHtml(codeBuf.join('\\n'), codeLang); inCode = false; }
          continue;
        }
        if (inCode) { codeBuf.push(lineRaw); continue; }
        if (/^\\s*\\|/.test(lineRaw)) { closeList(); tableBuf.push(lineRaw); continue; }
        flushTable();
        const line = esc(lineRaw);
        const h = line.match(/^(#{1,3})\\s+(.*)$/);
        if (h) { closeList(); html += '<h' + h[1].length + '>' + inline(h[2]) + '</h' + h[1].length + '>'; continue; }
        if (/^\\s*([-*_])\\s*\\1\\s*\\1[\\s\\1]*$/.test(lineRaw)) { closeList(); html += '<hr>'; continue; }
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
      if (inCode) html += codeBlockHtml(codeBuf.join('\\n'), codeLang);
      flushTable(); closeList();
      return html;
    }

    // ===================== DOM helpers =====================
    function scrollDown(force) {
      if (stick || force) scrollEl.scrollTop = scrollEl.scrollHeight;
    }
    scrollEl.addEventListener('scroll', function() {
      stick = scrollEl.scrollTop + scrollEl.clientHeight >= scrollEl.scrollHeight - 70;
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
    function addToolChip(tool, argsText, resultText, running) {
      welcomeEl.hidden = true;
      const chip = document.createElement('div');
      chip.className = 'toolchip';
      chip.innerHTML =
        '<span class="thead">' +
          (running ? '<span class="spin">⟳</span>' : '<span class="ok">✓</span>') +
          ' <span class="tname"></span> <span class="targs"></span></span>' +
        '<span class="tbody"></span>';
      chip.querySelector('.tname').textContent = tool;
      chip.querySelector('.targs').textContent = argsText || '';
      chip.querySelector('.tbody').textContent = resultText || '';
      chip.addEventListener('click', function() { chip.classList.toggle('open'); });
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

    // Copy buttons (delegated)
    messagesEl.addEventListener('click', function(e) {
      const btn = e.target.closest('.copybtn');
      if (!btn) return;
      e.stopPropagation();
      const code = btn.closest('.codeblock').querySelector('code');
      navigator.clipboard.writeText(code ? code.innerText : '');
      btn.textContent = 'copied ✓';
      setTimeout(function() { btn.textContent = 'copy'; }, 1200);
    });

    // ===================== streaming typewriter engine =====================
    const CARET = '<span class="caret"></span>';
    const THINKING = '<span class="dots"><span></span><span></span><span></span></span>';
    let streamEl = null;     // bubble currently being streamed into
    let shownText = '';      // revealed characters
    let pendingText = '';    // received but not yet revealed
    let streamEnded = false; // model finished; drain fast
    let rafId = null, lastPaint = 0, firstChunk = true;

    function schedulePump() { if (rafId === null) rafId = requestAnimationFrame(pump); }

    function pump(now) {
      rafId = null;
      if (!streamEl) return;
      if (pendingText.length) {
        // Adaptive reveal: small steady steps normally, bigger steps as the
        // backlog grows (and a fast drain after the stream ends) so the UI
        // stays smooth without falling behind the model.
        const step = streamEnded
          ? Math.max(24, Math.ceil(pendingText.length / 4))
          : Math.max(2, Math.ceil(pendingText.length / 24));
        shownText += pendingText.slice(0, step);
        pendingText = pendingText.slice(step);
      }
      // Throttled re-render (~30ms) — markdown re-parse is cheap at bubble size
      if (now - lastPaint > 30 || pendingText.length === 0) {
        lastPaint = now;
        streamEl.innerHTML = md(shownText) + (streamEnded && !pendingText.length ? '' : CARET);
        scrollDown();
      }
      if (pendingText.length) schedulePump();
      else if (streamEnded && streamEl) { streamEl.innerHTML = md(shownText); streamEl = null; }
    }

    function beginStream() {
      shownText = ''; pendingText = ''; streamEnded = false; firstChunk = true;
      streamEl = addTurn('assistant', THINKING);
    }
    function feedStream(text) {
      if (firstChunk && streamEl) { firstChunk = false; streamEl.innerHTML = CARET; }
      pendingText += text;
      schedulePump();
    }
    function endStream() {
      streamEnded = true;
      schedulePump();
    }
    function abortStream(keepText) {
      if (streamEl) {
        if (keepText && (shownText + pendingText).trim()) {
          streamEl.innerHTML = md(shownText + pendingText);
        } else {
          streamEl.closest('.turn').remove();
        }
      }
      streamEl = null; pendingText = ''; shownText = '';
    }

    // ===================== composer =====================
    function autoGrow() {
      input.style.height = 'auto';
      input.style.height = Math.min(input.scrollHeight, 160) + 'px';
    }
    input.addEventListener('input', autoGrow);
    function send(textOverride) {
      const text = (textOverride !== undefined ? textOverride : input.value).trim();
      if (!text || busy) return;
      input.value = ''; autoGrow();
      vscode.postMessage({ type: 'send', text: text });
    }
    sendBtn.addEventListener('click', function() { send(); });
    input.addEventListener('keydown', function(e) {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
    });
    stopBtn.addEventListener('click', function() { vscode.postMessage({ type: 'stop' }); });
    document.getElementById('newChat').addEventListener('click', function() { vscode.postMessage({ type: 'newChat' }); });
    document.getElementById('history').addEventListener('click', function() { vscode.postMessage({ type: 'history' }); });
    const openPanelBtn = document.getElementById('openPanel');
    if (openPanelBtn) openPanelBtn.addEventListener('click', function() { vscode.postMessage({ type: 'openPanel' }); });
    modelEl.addEventListener('click', function() { vscode.postMessage({ type: 'selectModel' }); });
    ctxBox.addEventListener('change', function() { vscode.postMessage({ type: 'toggleEditorContext', value: ctxBox.checked }); });
    welcomeEl.addEventListener('click', function(e) {
      const b = e.target.closest('[data-q]');
      if (b) send(b.dataset.q);
    });

    // ===================== state / protocol =====================
    window.addEventListener('message', function(e) {
      const m = e.data;
      switch (m.type) {
        case 'state': {
          document.getElementById('title').textContent = m.session.title;
          document.getElementById('repoName').textContent = m.repo || 'this repository';
          modelEl.textContent = '✦ ' + m.model;
          ctxBox.checked = !!m.editorContext;
          messagesEl.innerHTML = '';
          abortStream(false);
          for (const rec of m.session.messages) {
            if (rec.role === 'user') addTurn('user', md(rec.content));
            else if (rec.role === 'assistant') addTurn('assistant', md(rec.content));
            else addToolChip(rec.tool, rec.args, (rec.content || '').slice(0, 1500), false);
          }
          welcomeEl.hidden = m.session.messages.length > 0;
          setBusy(!!m.busy);
          stick = true; scrollDown(true);
          break;
        }
        case 'title':
          document.getElementById('title').textContent = m.title;
          break;
        case 'userMessage':
          addTurn('user', md(m.text));
          break;
        case 'assistantStart':
          beginStream();
          break;
        case 'assistantChunk':
          feedStream(m.text);
          break;
        case 'assistantEnd':
          endStream();
          break;
        case 'toolCall':
          // The streamed JSON becomes an animated tool chip instead
          abortStream(false);
          addToolChip(m.tool, JSON.stringify(m.args), '', true);
          break;
        case 'toolResult': {
          const chips = messagesEl.querySelectorAll('.toolchip');
          const last = chips[chips.length - 1];
          if (last) {
            last.querySelector('.tbody').textContent = m.preview || '(empty)';
            const head = last.querySelector('.thead');
            const spinner = head.querySelector('.spin');
            if (spinner) { spinner.outerHTML = '<span class="ok">✓</span>'; }
          }
          break;
        }
        case 'error':
          abortStream(true);
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
      // No footer animation — the thinking indicator lives in the chat bubble only.
      hintEl.textContent = '';
      if (!b && streamEl) { streamEnded = true; schedulePump(); }
    }

    vscode.postMessage({ type: 'init' });
  </script>
</body>
</html>`;
}
