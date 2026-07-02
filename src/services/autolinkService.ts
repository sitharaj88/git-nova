import * as vscode from 'vscode';
import { gitHubService } from './gitHubService';
import { logger } from '../utils/logger';

/**
 * A user-configured autolink rule (`gitNova.autolinks`).
 */
export interface AutolinkRule {
  /** Regular expression matched against commit message text. */
  pattern: string;
  /** URL template. Supports `$1`..`$9` capture groups and `{owner}`/`{repo}`. */
  url: string;
}

interface CompiledRule {
  regex: RegExp;
  url: string;
}

/**
 * AutolinkService — turns issue references (e.g. `#123`) in commit messages
 * into clickable links wherever messages are rendered (webviews, tooltips,
 * hovers). Rules come from `gitNova.autolinks`; `{owner}`/`{repo}` placeholders
 * resolve against the detected GitHub remote.
 */
export class AutolinkService {
  private static instance: AutolinkService | null = null;
  private compiled: CompiledRule[] = [];
  private disposables: vscode.Disposable[] = [];

  private constructor() {}

  /**
   * Get singleton instance
   */
  static getInstance(): AutolinkService {
    if (!AutolinkService.instance) {
      AutolinkService.instance = new AutolinkService();
    }
    return AutolinkService.instance;
  }

  /**
   * Initialize the service and compile rules from configuration
   */
  initialize(context: vscode.ExtensionContext): void {
    const configListener = vscode.workspace.onDidChangeConfiguration(
      (e: vscode.ConfigurationChangeEvent) => {
        if (e.affectsConfiguration('gitNova.autolinks')) {
          void this.refresh();
        }
      }
    );
    this.disposables.push(configListener);
    context.subscriptions.push(configListener);

    void this.refresh();
    logger.info('AutolinkService initialized');
  }

  /**
   * Recompile rules from configuration, resolving {owner}/{repo} placeholders
   */
  async refresh(): Promise<void> {
    const rules = vscode.workspace.getConfiguration('gitNova').get<AutolinkRule[]>('autolinks', []);
    const needsSlug = rules.some(r => r?.url && /\{owner\}|\{repo\}/.test(r.url));
    const slug = needsSlug ? await gitHubService.getRepoSlug() : undefined;

    const compiled: CompiledRule[] = [];
    for (const rule of rules) {
      if (!rule?.pattern || !rule?.url) {
        continue;
      }
      let url = rule.url;
      if (/\{owner\}|\{repo\}/.test(url)) {
        if (!slug) {
          // No GitHub remote detected — rule cannot be resolved
          continue;
        }
        url = url.replace(/\{owner\}/g, slug.owner).replace(/\{repo\}/g, slug.repo);
      }
      try {
        compiled.push({ regex: new RegExp(rule.pattern, 'g'), url });
      } catch (error) {
        logger.warn(`Invalid autolink pattern '${rule.pattern}': ${error}`);
      }
    }
    this.compiled = compiled;
  }

  /**
   * Wrap autolink matches in anchor tags, HTML-escaping everything else.
   * Matching runs against the raw text (never against escape entities like
   * &#39;, which the default #\d+ rule would otherwise hit).
   * Safe to inject into webview HTML; links open externally.
   */
  linkifyHtml(text: string): string {
    interface LinkSpan {
      start: number;
      end: number;
      href: string;
    }
    const spans: LinkSpan[] = [];
    for (const rule of this.compiled) {
      rule.regex.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = rule.regex.exec(text)) !== null) {
        if (match[0].length === 0) {
          rule.regex.lastIndex++;
          continue;
        }
        const start = match.index;
        const end = start + match[0].length;
        if (!spans.some(s => start < s.end && end > s.start)) {
          spans.push({ start, end, href: this.expandUrl(rule.url, match[0], match.slice(1)) });
        }
      }
    }
    spans.sort((a, b) => a.start - b.start);

    let out = '';
    let pos = 0;
    for (const span of spans) {
      out += AutolinkService.escapeHtml(text.slice(pos, span.start));
      const label = AutolinkService.escapeHtml(text.slice(span.start, span.end));
      out += `<a href="${AutolinkService.escapeHtml(span.href)}">${label}</a>`;
      pos = span.end;
    }
    out += AutolinkService.escapeHtml(text.slice(pos));
    return out;
  }

  /**
   * Replace autolink matches with Markdown links (for tooltips/hovers)
   */
  linkifyMarkdown(text: string): string {
    let out = text;
    for (const rule of this.compiled) {
      out = out.replace(rule.regex, (match, ...args) => {
        // replace() callback args are (...groups, offset, string, namedGroups?)
        const offsetIndex = args.findIndex(a => typeof a === 'number');
        const groups = args.slice(0, offsetIndex) as (string | undefined)[];
        const href = this.expandUrl(rule.url, match, groups);
        return `[${match}](${href})`;
      });
    }
    return out;
  }

  /**
   * Substitute $0..$9 in a URL template with the match and capture groups
   */
  private expandUrl(template: string, match: string, groups: (string | undefined)[]): string {
    return template.replace(/\$(\d)/g, (_placeholder, digit: string) => {
      const index = parseInt(digit, 10);
      if (index === 0) {
        return match;
      }
      return groups[index - 1] ?? '';
    });
  }

  /**
   * Escape HTML special characters
   */
  static escapeHtml(text: string): string {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  /**
   * Dispose
   */
  dispose(): void {
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
    this.disposables = [];
    this.compiled = [];
  }
}

// Export singleton instance
export const autolinkService = AutolinkService.getInstance();
