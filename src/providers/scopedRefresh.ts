import * as vscode from 'vscode';
import { EventBus, EventType } from '../core/eventBus';
import { RefreshScope, changeAffects } from '../core/refreshScheduler';

/**
 * ScopedRefreshGate — shared RepositoryChanged handling for tree providers.
 *
 * Skips refreshes whose scopes don't intersect the provider's, and defers
 * refreshes while the provider's view is hidden: a pending flag is set and
 * the refresh fires once when the view becomes visible again, so hidden views
 * cost nothing but are never stale when reopened.
 */
export class ScopedRefreshGate implements vscode.Disposable {
  private view: vscode.TreeView<unknown> | undefined;
  private pendingWhileHidden = false;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    eventBus: EventBus,
    private readonly scopes: readonly RefreshScope[],
    private readonly refresh: () => void
  ) {
    this.disposables.push(
      eventBus.on(EventType.RepositoryChanged, (data: unknown) => this.onChange(data)),
      // Repo switches must always repaint, regardless of scopes/visibility.
      eventBus.on(EventType.RepositoryDetected, () => this.refresh())
    );
  }

  /** Attach the provider's TreeView so refreshes can be gated on visibility. */
  attachView(view: vscode.TreeView<unknown>): void {
    this.view = view;
    this.disposables.push(
      view.onDidChangeVisibility(e => {
        if (e.visible && this.pendingWhileHidden) {
          this.pendingWhileHidden = false;
          this.refresh();
        }
      })
    );
  }

  private onChange(data: unknown): void {
    if (!changeAffects(data, this.scopes)) {
      return;
    }
    if (this.view && !this.view.visible) {
      this.pendingWhileHidden = true;
      return;
    }
    this.refresh();
  }

  dispose(): void {
    this.disposables.forEach(d => d.dispose());
  }
}
