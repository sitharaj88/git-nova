import * as vscode from 'vscode';
import { GitService } from '../core/gitService';
import { logger } from '../utils/logger';

/** URI scheme that serves file content at a git revision. */
export const REVISION_SCHEME = 'gitnova-rev';

/**
 * Build a URI that resolves to a file's content at the given revision
 * (commit hash, ref, or index stage like ':0').
 */
export function toRevisionUri(filePath: string, ref: string): vscode.Uri {
  return vscode.Uri.from({
    scheme: REVISION_SCHEME,
    path: '/' + filePath,
    query: ref,
  });
}

/**
 * Build a URI that resolves to empty content, used as the missing side of a
 * diff for added/deleted/untracked files.
 */
export function toEmptyUri(filePath: string): vscode.Uri {
  return vscode.Uri.from({
    scheme: REVISION_SCHEME,
    path: '/' + filePath,
  });
}

/**
 * Register the content provider backing native vscode.diff editors for
 * arbitrary revisions. Serves `git show <ref>:<path>`; an empty query yields
 * empty content.
 */
export function registerRevisionContentProvider(
  context: vscode.ExtensionContext,
  gitService: GitService
): void {
  const revisionProvider: vscode.TextDocumentContentProvider = {
    provideTextDocumentContent: async (uri: vscode.Uri) => {
      const ref = uri.query;
      const filePath = uri.path.replace(/^\//, '');
      if (!ref) {
        return '';
      }
      return gitService.getFileAtRevision(ref, filePath);
    },
  };
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(REVISION_SCHEME, revisionProvider)
  );
  logger.info('Revision content provider registered');
}
