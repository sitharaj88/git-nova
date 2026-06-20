# GitNova - Enterprise Git Integration for VS Code

<p align="center">
  <img src="https://raw.githubusercontent.com/sitharaj88/git-nova/main/resources/icons/logo.png" alt="GitNova Logo" width="128" height="128">
</p>

<p align="center">
  <strong>Visualize and manage your Git workflow with a rhythm. The heartbeat of your codebase.</strong>
</p>

<p align="center">
  <a href="#features">Features</a> •
  <a href="#enterprise-features">Enterprise Features</a> •
  <a href="#installation">Installation</a> •
  <a href="#configuration">Configuration</a> •
  <a href="#commands">Commands</a>
</p>

---

A comprehensive, enterprise-grade Git plugin for Visual Studio Code that provides advanced git operations through an intuitive, performant, and modern user interface. Built for teams that demand reliability, observability, and professional-grade tooling.

## Features

### Core Git Operations

- **Branch Management**: Create, delete, rename, switch, and compare branches with ease
- **Commit History**: View and search commit history with detailed information
- **Diff Viewer**: Side-by-side and unified diff views with syntax highlighting
- **Stash Management**: Create, apply, pop, and drop stashes
- **Interactive Rebase**: Drag-and-drop commit reordering with conflict resolution
- **Merge Conflict Resolution**: Side-by-side conflict view with merge strategies
- **Remote Operations**: Fetch, pull, push, and manage remotes
- **Tag Management**: Create, delete, and push tags
- **Status Bar Integration**: Quick access to branch, status, and sync information
- **Tree Views**: Native VSCode tree views for branches, commits, stashes, remotes, and tags

### 🤖 AI Assistance

Provider-agnostic AI built on the VS Code Language Model API (works with GitHub Copilot out of the box, no API key required) or any OpenAI-compatible endpoint (OpenAI, Azure OpenAI, Ollama, LM Studio, Groq, OpenRouter):

- **AI commit messages** — generate Conventional Commits-style messages from your staged diff, mirroring your repository's existing style
- **Explain commit** — get a concise, reviewer-focused explanation of any commit's changes and risks
- **Explain current changes** — summarize your working-tree/staged diff before committing
- **AI merge-conflict resolution** — proposes a merged version of each conflicted file and shows it as a *diff to review before applying*
- **AI code review** — reviews your diff and *fuses the editor's own linter/compiler diagnostics* into a severity-grouped report
- **Bring your own key** — API keys stored securely in VS Code SecretStorage, never in settings

### 🔎 Git CodeLens

Inline authorship insight, built on GitNova's blame data:

- File-level lens showing the most recent change and number of authors
- Per-symbol lens above functions, methods, and classes with their most recent change
- Click any lens to open the corresponding commit; toggle with `Ctrl/Cmd` palette → *Toggle Git CodeLens*

### 🔀 GitHub Pull Requests & Issues

Collaborate without leaving the editor:

- Dedicated **Pull Requests & Issues** view listing open PRs and issues for your GitHub remote
- Built-in VS Code GitHub sign-in — no personal access token to manage or store
- View PR details in-editor, **one-click checkout** of a PR branch, and open PRs/issues in the browser
- **Launchpad** — a unified hub of your actionable items: PRs awaiting your review, your PRs, and issues assigned to you

### 📊 Visualization

- **Visual File History** — interactive timeline per file with author swimlanes and change-magnitude bubbles
- **Interactive Commit Graph workbench** — coloured lanes, ref badges, live search, and an embedded details panel with checkout / explain-with-AI / copy actions

### 🩺 Repo Doctor (unique to GitNova)

A repository health dashboard you won't find in other Git extensions — it fuses GitNova's deep maintenance tooling with AI guidance:

- At-a-glance metrics: `.git` size, loose objects, pack count, integrity (fsck), merged branches, large files, stashes, LFS status
- Prioritized, **rule-based recommendations with one-click remediation** (run gc, track LFS, run fsck)
- Optional **AI deep-analysis** that turns the metrics into a concrete maintenance action plan
- Detects large files that should move to Git LFS, and branches already merged that can be cleaned up

> **What makes GitNova different:** the AI features work through the **VS Code Language Model API (free with Copilot)** *and* fully **local models via Ollama** — so AI commit messages, explanations, conflict resolution, and review can run at **zero cost and fully offline**, unlike the paywalled/credit-metered AI in comparable extensions. GitNova also bundles power-user plumbing most extensions omit — bisect, reflog restore, sparse checkout, submodules, LFS, archive/bundle, git notes, and the Repo Doctor — in one tool.

## Enterprise Features

### 🔒 Branch Protection

Protect critical branches from accidental changes:

- Configurable protected branch patterns (main, master, develop, release/*, hotfix/*)
- Warning prompts before operations on protected branches
- Admin override capability for authorized users
- Branch naming convention enforcement

### 📝 Commit Templates

Streamline your commit workflow with templates:

- Pre-configured conventional commit templates
- Custom template creation and management
- Interactive commit message wizard
- Placeholder system for dynamic content
- Breaking change support

### 👥 Git Blame

Inline blame annotations for code authorship:

- Line-by-line blame information
- Hover details with commit info
- Recent commit highlighting
- Configurable date formats (relative, short, full)
- Toggle inline blame on/off

### 🌳 Worktree Management

Parallel development with Git worktrees:

- List, create, and remove worktrees
- Open worktrees in new VS Code windows
- Lock/unlock worktrees
- Move worktrees to new locations
- Status bar integration

### 📦 Submodule Support

Enterprise-grade submodule management:

- Initialize submodules recursively
- Update submodules with various strategies
- Add new submodules with branch tracking
- Remove submodules cleanly
- Sync submodule URLs
- Status tracking and notifications

### 📁 Git LFS Support

Large File Storage for enterprise workflows:

- Install and configure Git LFS
- Track/untrack file patterns
- Pull LFS objects with progress
- Prune old LFS objects
- Storage statistics and status

### 📊 Performance Monitoring

Enterprise observability features:

- Operation timing metrics
- Cache hit/miss statistics
- Slow operation warnings
- Performance reports

### 🔍 Enhanced Logging

Professional-grade logging:

- VS Code Output Channel integration
- Configurable log levels (trace, debug, info, warn, error)
- Performance timing utilities
- Log rotation support

### 📈 Telemetry

Usage analytics (respects VS Code settings):

- Command usage tracking
- Feature adoption metrics
- Error tracking
- Performance analytics

### 🛡️ Error Handling

Robust error management:

- Centralized error handling
- Error classification and categorization
- Recovery strategies
- User-friendly error messages
- Retry mechanisms

## Technology Stack

- **TypeScript 5.x** - Type-safe development
- **VSCode Extension API** - Native integration with VSCode
- **Simple-git 3.x** - Git operations wrapper
- **React 18.x** - Modern UI components for webviews
- **Zustand 4.x** - Lightweight state management
- **esbuild** - Fast bundling and compilation

## Installation

### From VSCode Marketplace

Coming soon!

### From Source

1. Clone the repository:
```bash
git clone https://github.com/sitharaj88/git-nova.git
cd git-nova
```

2. Install dependencies:
```bash
npm install
```

3. Build the extension:
```bash
npm run compile
```

4. Run in development mode:
```bash
npm run watch
```

5. Press F5 in VSCode to launch the Extension Development Host

## Commands

### Branch Commands
| Command | Description |
|---------|-------------|
| `GitNova: Create Branch` | Create a new branch |
| `GitNova: Delete Branch` | Delete a branch |
| `GitNova: Switch Branch` | Switch to another branch |
| `GitNova: Rename Branch` | Rename the current branch |
| `GitNova: Merge Branch` | Merge a branch into current |
| `GitNova: Compare Branches` | Compare two branches |

### Commit Commands
| Command | Description |
|---------|-------------|
| `GitNova: Create Commit` | Create a new commit |
| `GitNova: View Commit History` | View commit history |
| `GitNova: Insert Commit Template` | Use a commit template |
| `GitNova: Commit Template Wizard` | Interactive template wizard |

### Stash Commands
| Command | Description |
|---------|-------------|
| `GitNova: Create Stash` | Create a new stash |
| `GitNova: Apply Stash` | Apply a stash |
| `GitNova: Pop Stash` | Pop a stash |
| `GitNova: Drop Stash` | Delete a stash |

### Enterprise Commands
| Command | Description |
|---------|-------------|
| `GitNova: Toggle Inline Blame` | Toggle inline blame annotations |
| `GitNova: Show File Blame` | Show blame for current file |
| `GitNova: List Worktrees` | List all worktrees |
| `GitNova: Create Worktree` | Create a new worktree |
| `GitNova: Initialize Submodules` | Initialize all submodules |
| `GitNova: Update Submodules` | Update all submodules |
| `GitNova: Add Submodule` | Add a new submodule |
| `GitNova: Install Git LFS` | Install LFS in repository |
| `GitNova: Track Files with LFS` | Track file patterns with LFS |
| `GitNova: Show Logs` | Open GitNova log output |
| `GitNova: Show Performance Report` | View performance metrics |

## Keyboard Shortcuts

| Shortcut | Command |
|----------|---------|
| `Ctrl+Alt+B` / `Cmd+Alt+B` | Toggle Inline Blame |
| `Ctrl+Alt+T` / `Cmd+Alt+T` | Insert Commit Template |
| `Ctrl+Alt+W` / `Cmd+Alt+W` | List Worktrees |
| `Ctrl+Alt+L` / `Cmd+Alt+L` | Show Logs |

## Configuration

The extension can be configured through VSCode settings:

### General Settings

```json
{
  "gitNova.autoRefresh": true,
  "gitNova.refreshInterval": 60000,
  "gitNova.showStatusBar": true,
  "gitNova.defaultBranchName": "main",
  "gitNova.showRemoteBranches": true,
  "gitNova.branchSortOrder": "recent"
}
```

### Diff Settings

```json
{
  "gitNova.diffViewMode": "unified",
  "gitNova.ignoreWhitespace": false,
  "gitNova.showLineNumbers": true
}
```

### Branch Protection

```json
{
  "gitNova.branchProtection.enabled": true,
  "gitNova.branchProtection.protectedPatterns": [
    "main", "master", "develop", "release/*", "hotfix/*"
  ],
  "gitNova.branchProtection.requirePullRequest": true
}
```

### Branch Naming Conventions

```json
{
  "gitNova.branchNaming.enabled": true,
  "gitNova.branchNaming.pattern": "^(feature|bugfix|hotfix|release|chore)/[a-z0-9-]+$",
  "gitNova.branchNaming.prefixes": [
    "feature/", "bugfix/", "hotfix/", "release/", "chore/"
  ],
  "gitNova.branchNaming.requireTicketNumber": false
}
```

### Commit Message Settings

```json
{
  "gitNova.commitMessage.maxSubjectLength": 72,
  "gitNova.commitMessage.requireType": false,
  "gitNova.commitMessage.allowedTypes": [
    "feat", "fix", "docs", "style", "refactor", "perf", "test", "build", "ci", "chore", "revert"
  ]
}
```

### Blame Settings

```json
{
  "gitNova.blame.enabled": true,
  "gitNova.blame.dateFormat": "relative",
  "gitNova.blame.highlightRecent": true,
  "gitNova.blame.recentDays": 7
}
```

### Performance Settings

```json
{
  "gitNova.performance.enableMetrics": true,
  "gitNova.performance.slowOperationThreshold": 3000,
  "gitNova.performance.showCacheStats": false
}
```

### Logging Settings

```json
{
  "gitNova.logging.level": "info",
  "gitNova.logging.includeTimestamp": true
}
```

## Project Structure

```
git-nova/
├── src/                    # Main source code
│   ├── commands/          # Command handlers
│   ├── core/              # Core services (GitService, RepositoryManager, EventBus)
│   ├── models/            # Data models and interfaces
│   ├── providers/         # Tree data providers
│   ├── services/          # Enterprise services
│   │   ├── telemetryService.ts
│   │   ├── errorHandler.ts
│   │   ├── performanceMonitor.ts
│   │   ├── workspaceStateManager.ts
│   │   ├── branchProtectionManager.ts
│   │   ├── commitTemplateManager.ts
│   │   ├── worktreeManager.ts
│   │   ├── gitBlameService.ts
│   │   ├── submoduleManager.ts
│   │   └── lfsManager.ts
│   ├── views/             # Webview panel managers
│   └── utils/             # Utility functions
├── webviews/              # React webview source
├── test/                  # Test files
│   └── unit/             # Unit tests
└── resources/             # Icons and schemas
```

## Architecture

The plugin follows a layered architecture with event-driven communication:

1. **Presentation Layer**: Tree views, webviews, and status bar
2. **Command Layer**: Command handlers for user actions
3. **Service Layer**: GitService, RepositoryManager, EventBus, and Enterprise Services
4. **Data Layer**: Models, interfaces, and cache

### Enterprise Service Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                     Extension Entry                          │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐         │
│  │   Logger    │  │  Telemetry  │  │   Error     │         │
│  │             │  │   Service   │  │  Handler    │         │
│  └─────────────┘  └─────────────┘  └─────────────┘         │
│                                                              │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐         │
│  │ Performance │  │  Workspace  │  │   Branch    │         │
│  │   Monitor   │  │   State     │  │ Protection  │         │
│  └─────────────┘  └─────────────┘  └─────────────┘         │
│                                                              │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐         │
│  │   Commit    │  │  Worktree   │  │  Git Blame  │         │
│  │  Templates  │  │   Manager   │  │   Service   │         │
│  └─────────────┘  └─────────────┘  └─────────────┘         │
│                                                              │
│  ┌─────────────┐  ┌─────────────┐                          │
│  │  Submodule  │  │    LFS      │                          │
│  │   Manager   │  │   Manager   │                          │
│  └─────────────┘  └─────────────┘                          │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

## Available Scripts

- `npm run compile` - Build the extension
- `npm run watch` - Build and watch for changes
- `npm run lint` - Run ESLint
- `npm run lint:fix` - Fix ESLint issues
- `npm run test` - Run tests
- `npm run package` - Package the extension for distribution

## Contributing

Contributions are welcome! Please follow these steps:

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes using conventional commits (`git commit -m 'feat: add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

### Commit Message Guidelines

We follow [Conventional Commits](https://www.conventionalcommits.org/):

- `feat:` - New features
- `fix:` - Bug fixes
- `docs:` - Documentation changes
- `style:` - Code style changes (formatting, etc.)
- `refactor:` - Code refactoring
- `perf:` - Performance improvements
- `test:` - Test additions or modifications
- `build:` - Build system changes
- `ci:` - CI configuration changes
- `chore:` - Other changes

## License

Apache-2.0 License - see LICENSE file for details

## Support

- [Report Issues](https://github.com/sitharaj88/git-nova/issues)
- [Request Features](https://github.com/sitharaj88/git-nova/issues/new?template=feature_request.md)

---

<p align="center">Made with ❤️ for developers who love Git</p>
