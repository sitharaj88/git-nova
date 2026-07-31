# Change Log

All notable changes to the "GitNova" extension will be documented in this file.

## [3.0.0] - 2026-08-01

A major release on two fronts: a ground-up **multi-provider AI platform** with a real chat assistant, and a **deep performance overhaul** of the refresh/git-process architecture.

### Added — AI

- **Multi-provider AI layer**: first-class adapters for **Anthropic (Claude)**, **OpenAI / Azure OpenAI** (auto-detected from the base URL), **Google Gemini**, the **VS Code Language Model API** (Copilot), and any **OpenAI-compatible** endpoint with one-click presets for **Ollama, LM Studio, Groq, OpenRouter, Mistral, xAI, DeepSeek, and Zhipu GLM**. Streaming-first (SSE) with no SDK dependencies; per-provider API keys in SecretStorage (the legacy single key migrates automatically).
- `GitNova: Select AI Model` — guided provider → preset → model picker with **live model listing** from each provider, plus a status bar item (`✦ model`) showing what's active.
- **AI Assistant chat** (`gitNova.aiChat` view + `GitNova: Open AI Chat (Editor Panel)`): Claude-style chat grounded in the repository via a strict **read-only git tool loop** (status, log, diff, show, blame, branches) that works on every provider. Persistent **per-workspace chat history** with session switching/deletion, repo context (branch, ahead/behind, recent commits) and optional active-file/selection context on every turn, adaptive typewriter streaming, syntax-highlighted code blocks with copy buttons, markdown tables, and animated tool chips.
- **AI Review Panel** (`GitNova: AI Review Panel`): structured findings with file/line/severity, jump-to-line, severity filter chips, and confirm-then-apply suggestions; review staged, working-tree, or branch-vs-merge-base changes. Falls back to a markdown report if the model returns unstructured output.
- **Streaming output panel**: explain-commit, explain-changes, review, changelog and Repo Doctor AI analysis now stream token-by-token with a Stop button instead of spinner-then-dump.
- **Semantic history tools**: `Search Commits with AI` (natural-language → local git filters, including pickaxe), `Generate Changelog / Release Notes (AI)` between any two refs with save-to-file, and `Suggest Branch Name (AI)` with create-and-switch.
- New AI settings: `gitNova.ai.preset`, `gitNova.ai.maxTokens`, `gitNova.ai.azureApiVersion`; `gitNova.ai.provider` now accepts `anthropic`, `openai`, `gemini`.

### Added — Git

- **Real branch ahead/behind and upstream tracking** in the branches view and source-control overview (previously always rendered as 0 / none).

### Performance

- **Coalesced refresh pipeline**: one debounced, scope-aware refresh per change instead of multiple full fan-outs to every view; tree views only refresh the data they show, and hidden views defer refreshing until reopened.
- **Removed the workspace-wide file watcher** that ran `git status` for every file event in the workspace (builds, `npm install`, test output).
- **Git result caching** with in-flight deduplication and precise invalidation (from GitNova's own operations and the `.git` watcher for terminal git usage).
- **Far fewer git processes**: tags now load with one `for-each-ref` instead of 2 per tag; local+remote branches with one process; commit details with one `git show` instead of three; HEAD via `rev-parse`. Read commands no longer take the index lock (`GIT_OPTIONAL_LOCKS=0`).
- **Faster activation**: single cheap repo validation (was two full `git status` runs), webview managers constructed lazily on first open, non-critical services deferred until after activation, CodeLens registered only while enabled, auto-refresh paused while the window is unfocused.
- **Webview performance**: commit graph "Load more" now fetches only the next page (`--skip`) and appends; search filters rows without re-rendering; performance monitoring is wired end-to-end (`GitNova: Show Performance Report` now shows real activation/git/cache metrics).

### Changed

- **Commit graph redesigned**: proper graph rails — continuous colored branch lines with rounded merge/fork curves — instead of disconnected dots; slim themed scrollbars across all GitNova webviews.
- All webviews hardened with Content-Security-Policy + script nonces.
- Saving an AI API key now offers to switch the active provider immediately (previously requests silently kept using the old provider).

### Fixed

- `gitNova.commit.create` ignored the message passed by the commit template wizard.
- Custom OpenAI base URLs were silently ignored (traffic always went to api.openai.com).

## [2.1.0] - 2026-07-03

### Added
- **History rewriting commands**: `Cherry-pick Commit`, `Revert Commit`, `Amend Last Commit`, `Reset to Commit (Soft/Mixed/Hard)`, `Squash Commits`, and `Create Fixup Commit` — from the palette or the Commit History context menu.
- **Visual Interactive Rebase**: `GitNova: Interactive Rebase (Visual)` — a drag-and-drop todo editor with per-commit pick/reword/squash/fixup/drop actions and inline message editing.
- **Operation recovery UX**: continue/skip/abort commands for rebase and merge, plus a warning status bar item while a rebase, merge, or cherry-pick is in progress that opens a Continue/Skip/Abort quick pick (`GitNova: Show In-Progress Operation Actions`).
- **Built-in merge editor integration**: "Resolve in Merge Editor" opens conflicted files in VS Code's native 3-way merge editor.
- **Native diff editors**: staged/unstaged changes, single commits, and commit/branch comparisons now open in VS Code's built-in diff editor, backed by a revision content provider.
- **Create Pull Request**: guided in-editor PR creation (push check, base branch pick, title, draft toggle) with an optional **AI-generated description** from the branch diff.
- **Autolinks**: `gitNova.autolinks` rules turn issue references (e.g. `#123`) in commit messages into clickable links; `{owner}`/`{repo}` placeholders resolve from the GitHub remote.
- **Status bar blame**: blame for the current line in the status bar (`gitNova.blame.statusBar`), and a configurable inline annotation template (`gitNova.blame.format`).
- **Rich Diff Viewer**: the all-files unified patch overview is now reachable via `GitNova: Open Diff Viewer` (staged-mode, multi-file rendering, and disposal bugs fixed).

### Fixed
- Rebase/merge in-progress detection never matched, so `Continue`/`Abort` commands reported "no operation in progress"; merge continue/abort also failed once all conflicts were staged.
- `gitNova.showStatusBar`, `gitNova.autoRefresh`, and `gitNova.refreshInterval` are now actually honored.
- Blame annotations now read the documented `gitNova.blame.*` settings (previously several undocumented keys were consulted).
- Conflicted files opened from merge flows resolved against the wrong (relative) path.

### Removed
- 12 dead settings that were declared but never read (`gitNova.branchProtection.enabled`/`protectedPatterns`/`requirePullRequest`, `gitNova.branchNaming.pattern`, `gitNova.performance.*`, `gitNova.telemetry.enabled`, `gitNova.worktree.*`, `gitNova.logging.*`) — branch protection is configured via `gitNova.branchProtection.rules` instead. `gitNova.diffViewMode` was removed because native diff editors follow VS Code's own inline/side-by-side toggle.
- Unused React/Zustand webview pipeline (never loaded at runtime); webviews are dependency-free HTML/CSS/JS. Shrinks the install footprint.

## [1.1.0] - 2026-06-20

### Added
- **AI Assistance (new)**: provider-agnostic AI features built on the VS Code Language Model API (GitHub Copilot, no API key) with an OpenAI-compatible fallback (OpenAI, Azure OpenAI, Ollama, LM Studio, Groq, OpenRouter).
  - `GitNova: Generate Commit Message (AI)` — Conventional Commits-style messages from the staged diff, styled after recent commits.
  - `GitNova: Explain Commit (AI)` — reviewer-focused explanation of any commit (from the Commit History context menu).
  - `GitNova: Explain Current Changes (AI)` — summarize working-tree/staged changes.
  - `GitNova: Set AI Provider API Key` — keys stored securely in VS Code SecretStorage.
- AI settings under `gitNova.ai.*` (enabled, provider, model, base URL, Conventional Commits toggle).
- **Git CodeLens (new)**: inline authorship above files and code blocks — file-level "last changed / N authors" and per-symbol "recent change" lenses, click to open the commit. Toggle with `GitNova: Toggle Git CodeLens`; settings under `gitNova.codeLens.*`.
- **GitHub Pull Requests & Issues (new)**: a dedicated view listing open PRs and issues for the repository's GitHub remote, using VS Code's built-in GitHub sign-in (no token stored). View PR details in-editor, one-click checkout of a PR branch (`pr-<n>`), and open PRs/issues in the browser.
- **Visual File History (new)**: `GitNova: Visual File History` opens an interactive timeline for any file — author swimlanes, time on the x-axis, and a bubble per commit sized by change magnitude and coloured by net additions/deletions. Available from the editor and explorer context menus.
- **Interactive Commit Graph workbench (new)**: a redesigned `Open Git Graph` — an SVG graph with coloured lanes, ref/branch/tag badges, live search, and an embedded details panel (changed files + checkout / explain-with-AI / copy-SHA actions).
- **Launchpad (new)**: `GitNova: Open Launchpad` — a unified hub of your actionable items for the current GitHub repo: PRs awaiting your review, your open PRs, and issues assigned to you, with checkout/open actions.
- **AI merge-conflict resolution (new)**: `GitNova: Resolve Merge Conflicts (AI)` proposes a merged version of each conflicted file and shows it as a **diff to review before applying**; only applied (and staged) on confirmation.
- **AI code review (new)**: `GitNova: Review Changes (AI)` reviews your diff and **fuses the editor's own linter/compiler diagnostics** into the prompt, returning a severity-grouped Markdown report.
- **Repo Doctor (new, unique)**: `GitNova: Repo Doctor` — a repository health dashboard combining maintenance diagnostics (size, loose objects, integrity/fsck), Git LFS candidate detection, merged-branch and stash hygiene, rule-based recommendations with **one-click remediation**, and an optional **AI deep-analysis** action plan. No mainstream Git extension bundles these signals into a single guided dashboard.

### Fixed
- **Performance**: removed a git-status refresh that ran on *every keystroke* and debounced/narrowed the `.git` file watcher — eliminates the refresh storm that made the UI sluggish during typing and Git operations.
- **Commit History**: commits are now expandable to list their changed files (previously the click did nothing and `getCommit` never parsed files because it read `git --stat` output in the wrong order). Clicking a file now opens a **native side-by-side diff** (parent ↔ commit), matching the built-in Git experience.
- Aligned all command IDs between `package.json` and their handlers — fixes the `Ctrl/Cmd+Alt+B` (toggle blame) and `Ctrl/Cmd+Alt+L` (show logs) keybindings and several palette commands that previously errored with "command not found".
- Added handlers for `Show File Blame`, `Commit Template Wizard`, and `Clear Cache`.
- Resolved all outstanding TypeScript type errors across the codebase (remote quick-picks, commit result mapping, config update typing, changes-cache mutations, source-control tracking branch, deactivation metrics) — the project now type-checks cleanly.

### Changed
- Production builds are now minified with sourcemaps stripped (smaller `.vsix`, faster startup).
- Trimmed redundant `onCommand`/`onView` activation events (auto-generated by VS Code).
- Marketplace metadata: added `AI`/`Machine Learning` categories and discoverability keywords.

## [1.0.4] - 2025-12-28
- Enhanced Diff view handling and performance.
- Improved Stash management reliability.
- Optimized Status Bar updates and git service interactions.
- General codebase refactoring and stability improvements.

## [1.0.3] - 2025-12-28
- Faster stage/unstage updates in CHANGES via optimistic status cache and debounced refreshes.
- Discard fixes: handle untracked files, add discard-all action, and refresh status immediately.
- Status bar now reflects branch switches and dirty state more reliably.
- Stash context menus support apply/pop/drop/details with cache invalidation.
- Align command IDs and contributions to avoid activation errors.

## [1.0.2] - 2025-12-28
- Optimized icon sizes to VS Code extension standards (128x128).

## [1.0.3] - 2025-12-28
- Updated: Application icon is now a full square to prevent cutoff.

## [1.0.1] - 2025-12-28
- Fixed: Application icon now has transparent corners.

## [1.0.0] - 2025-12-28

### Added
- Initial release of GitNova.
- **Branch Management**: Create, delete, rename, switch, and compare branches.
- **Commit History**: View and search commit history with detailed information.
- **Diff Viewer**: Side-by-side and unified diff views with syntax highlighting.
- **Stash Management**: Create, apply, pop, and drop stashes.
- **Tree Views**: Dedicated views for Source Control, Changes, Branches, Commits, Stashes, Remotes, and Tags.
- **Interactive UI**: Modern, glassmorphism-inspired React-based webviews for complex operations.
- **Git Graph**: Integration for visualizing commit history graph.
- **Status Bar**: Quick access to branch status and sync operations.
