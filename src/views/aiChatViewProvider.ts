import * as vscode from 'vscode';
import { ChatController } from './aiChat/chatController';
import { chatHtml } from './aiChat/chatHtml';

/**
 * Sidebar host for the GitNova AI chat. All chat logic (sessions, tool loop,
 * context, persistence) lives in {@link ChatController}; this class only
 * renders the shared chat UI in the view container.
 */
export class AiChatViewProvider implements vscode.WebviewViewProvider {
  static readonly viewId = 'gitNova.aiChat';

  constructor(private readonly controller: ChatController) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    view.webview.options = { enableScripts: true };
    view.webview.html = chatHtml(view.webview, true);

    const host = { post: (m: unknown) => void view.webview.postMessage(m) };
    const attachment = this.controller.attach(host);
    view.onDidDispose(() => attachment.dispose());
    view.webview.onDidReceiveMessage(async msg => {
      if (msg?.type === 'history') {
        await this.controller.showHistoryPicker();
        return;
      }
      await this.controller.onHostMessage(msg);
    });
  }
}

/**
 * Editor-panel host — the "full window" chat experience. Opens beside the
 * current editor and shares the controller (and therefore the live
 * conversation) with the sidebar view.
 */
export class AiChatPanel {
  private panel: vscode.WebviewPanel | undefined;

  constructor(private readonly controller: ChatController) {}

  show(): void {
    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.Beside, false);
      return;
    }
    this.panel = vscode.window.createWebviewPanel(
      'gitNova.aiChatPanel',
      'GitNova AI',
      vscode.ViewColumn.Beside,
      { enableScripts: true, retainContextWhenHidden: true }
    );
    this.panel.webview.html = chatHtml(this.panel.webview, false);

    const host = { post: (m: unknown) => void this.panel?.webview.postMessage(m) };
    const attachment = this.controller.attach(host);
    this.panel.webview.onDidReceiveMessage(async msg => {
      if (msg?.type === 'history') {
        await this.controller.showHistoryPicker();
        return;
      }
      await this.controller.onHostMessage(msg);
    });
    this.panel.onDidDispose(() => {
      attachment.dispose();
      this.panel = undefined;
    });
  }

  dispose(): void {
    this.panel?.dispose();
  }
}
