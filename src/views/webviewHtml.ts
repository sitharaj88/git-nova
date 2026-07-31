import * as vscode from 'vscode';

/** Random nonce for CSP-gated inline scripts. */
export function getNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let text = '';
  for (let i = 0; i < 32; i++) {
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return text;
}

/**
 * Content-Security-Policy meta tag for GitNova webviews: no external network,
 * inline styles allowed (templates use them heavily), scripts only with the
 * given nonce.
 */
export function cspMeta(webview: vscode.Webview, nonce: string): string {
  return (
    `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; ` +
    `img-src ${webview.cspSource} data:; ` +
    `style-src ${webview.cspSource} 'unsafe-inline'; ` +
    `font-src ${webview.cspSource}; ` +
    `script-src 'nonce-${nonce}';">`
  );
}
