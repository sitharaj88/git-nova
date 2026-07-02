/**
 * Commands for branch operations
 */
export const BranchCommands = {
  Create: 'gitNova.branch.create',
  Delete: 'gitNova.branch.delete',
  Switch: 'gitNova.branch.switch',
  Rename: 'gitNova.branch.rename',
  Compare: 'gitNova.branch.compare',
  CheckoutNew: 'gitNova.branch.checkoutNew',
  Checkout: 'gitNova.branch.checkout',
  Merge: 'gitNova.branch.merge',
  Fetch: 'gitNova.branch.fetch',
  Push: 'gitNova.branch.push',
  Pull: 'gitNova.branch.pull',
  Track: 'gitNova.branch.track',
  Untrack: 'gitNova.branch.untrack',
} as const;

/**
 * Commands for commit operations
 */
export const CommitCommands = {
  Create: 'gitNova.commit.create',
  Amend: 'gitNova.commit.amend',
  ViewHistory: 'gitNova.commit.viewHistory',
  Show: 'gitNova.commit.show',
  Log: 'gitNova.commit.log',
  Search: 'gitNova.commit.search',
  CherryPick: 'gitNova.commit.cherryPick',
  Revert: 'gitNova.commit.revert',
  Reset: 'gitNova.commit.reset',
  Squash: 'gitNova.commit.squash',
  Fixup: 'gitNova.commit.fixup',
  EditMessage: 'gitNova.commit.editMessage',
  Filter: 'gitNova.commit.filter',
} as const;

/**
 * Commands for diff operations
 */
export const DiffCommands = {
  ViewFileDiff: 'gitNova.diff.viewFile',
  ViewStaged: 'gitNova.diff.viewStaged',
  ViewUnstaged: 'gitNova.diff.viewUnstaged',
  ViewCommit: 'gitNova.diff.viewCommit',
  CompareCommits: 'gitNova.diff.compareCommits',
  CompareBranches: 'gitNova.diff.compareBranches',
  OpenViewer: 'gitNova.diff.openViewer',
  DiscardChanges: 'gitNova.discardChanges',
  DiscardAllChanges: 'gitNova.discardAllChanges',
  StageFile: 'gitNova.diff.stageFile',
  UnstageFile: 'gitNova.diff.unstageFile',
} as const;

/**
 * Commands for stash operations
 */
export const StashCommands = {
  Create: 'gitNova.stash.create',
  Pop: 'gitNova.stash.pop',
  Apply: 'gitNova.stash.apply',
  Drop: 'gitNova.stash.drop',
  List: 'gitNova.stash.list',
  Clear: 'gitNova.stash.clear',
} as const;

/**
 * Commands for rebase operations
 */
export const RebaseCommands = {
  Start: 'gitNova.rebase.start',
  Interactive: 'gitNova.rebase.interactive',
  InteractiveEditor: 'gitNova.rebase.interactiveEditor',
  Continue: 'gitNova.rebase.continue',
  Abort: 'gitNova.rebase.abort',
  Skip: 'gitNova.rebase.skip',
  EditTodo: 'gitNova.rebase.editTodo',
} as const;

/**
 * Commands for merge operations
 */
export const MergeCommands = {
  Start: 'gitNova.merge.start',
  Continue: 'gitNova.merge.continue',
  Abort: 'gitNova.merge.abort',
  ResolveConflict: 'gitNova.merge.resolveConflict',
  AcceptOurs: 'gitNova.merge.acceptOurs',
  AcceptTheirs: 'gitNova.merge.acceptTheirs',
} as const;

/**
 * Commands for in-progress operation handling (rebase/merge/cherry-pick)
 */
export const OperationCommands = {
  ShowActions: 'gitNova.operation.showActions',
} as const;

/**
 * Commands for remote operations
 */
export const RemoteCommands = {
  Fetch: 'gitNova.remote.fetch',
  Pull: 'gitNova.remote.pull',
  Push: 'gitNova.remote.push',
  Add: 'gitNova.remote.add',
  Remove: 'gitNova.remote.remove',
  SetUrl: 'gitNova.remote.setUrl',
  Prune: 'gitNova.remote.prune',
} as const;
