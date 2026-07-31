import * as vscode from 'vscode';
import { AiMessage } from './types';

/** Hard cap on diff size sent to a model, to control cost and token limits. */
export const MAX_DIFF_CHARS = 24000;

/** Truncate a diff to a safe size, marking where it was cut. */
export function truncateDiff(diff: string): string {
  if (diff.length <= MAX_DIFF_CHARS) {
    return diff;
  }
  return (
    diff.slice(0, MAX_DIFF_CHARS) +
    `\n\n[... diff truncated at ${MAX_DIFF_CHARS} characters for AI processing ...]`
  );
}

/** Strip a leading/trailing Markdown code fence if a model added one anyway. */
export function stripCodeFence(text: string): string {
  const fence = text.match(/^```[\w-]*\n([\s\S]*?)\n```\s*$/);
  return fence ? fence[1] : text;
}

/**
 * Robust JSON extraction ladder for model output:
 * 1. plain JSON.parse
 * 2. strip a Markdown code fence, then parse
 * 3. balanced-brace scan for the first {...} or [...] region
 * Returns undefined when nothing parseable is found — callers must fall back
 * gracefully (e.g. render the raw text) rather than erroring out.
 */
export function extractJson<T>(text: string): T | undefined {
  const candidates = [text.trim(), stripCodeFence(text.trim()).trim()];
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate) as T;
    } catch {
      // continue
    }
  }
  // Balanced scan from the first opening brace/bracket
  for (const open of ['{', '[']) {
    const close = open === '{' ? '}' : ']';
    const start = text.indexOf(open);
    if (start === -1) {
      continue;
    }
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < text.length; i++) {
      const ch = text[i];
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === '\\') {
        escaped = inString;
        continue;
      }
      if (ch === '"') {
        inString = !inString;
        continue;
      }
      if (inString) {
        continue;
      }
      if (ch === open) {
        depth++;
      } else if (ch === close) {
        depth--;
        if (depth === 0) {
          try {
            return JSON.parse(text.slice(start, i + 1)) as T;
          } catch {
            break;
          }
        }
      }
    }
  }
  return undefined;
}

/**
 * Build the prompt for AI commit-message generation.
 * @param diff - Raw staged unified diff
 * @param recentMessages - Recent commit subjects, used to mirror the repo's style
 */
export function buildCommitPrompt(diff: string, recentMessages: string[] = []): AiMessage[] {
  const config = vscode.workspace.getConfiguration('gitNova');
  const conventional = config.get<boolean>('ai.conventionalCommits', true);
  const maxSubject = config.get<number>('commitMessage.maxSubjectLength', 72);

  const styleHint = recentMessages.length
    ? `\nRecent commit subjects in this repository (mirror their style/casing):\n${recentMessages
        .map(m => `- ${m}`)
        .join('\n')}`
    : '';

  const system =
    'You are an expert software engineer writing a Git commit message. ' +
    'Summarize the intent of the change, not a line-by-line description. ' +
    (conventional
      ? 'Use the Conventional Commits format: "<type>(<optional scope>): <subject>". ' +
        'Choose an accurate type (feat, fix, docs, style, refactor, perf, test, build, ci, chore, revert). '
      : '') +
    `Keep the subject line in the imperative mood and at most ${maxSubject} characters. ` +
    'If the change is non-trivial, add a blank line and a concise body explaining the why. ' +
    'Output ONLY the commit message — no markdown fences, no preamble, no quotes.';

  const user = `Generate a commit message for the following staged diff:${styleHint}\n\n\`\`\`diff\n${truncateDiff(
    diff
  )}\n\`\`\``;

  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

/**
 * Build the prompt for AI merge-conflict resolution.
 * The model must return the FULL resolved file content with all conflict
 * markers removed — nothing else — so the result can be written verbatim.
 */
export function buildConflictPrompt(filePath: string, content: string): AiMessage[] {
  const system =
    'You are resolving a Git merge conflict. You are given a file that contains ' +
    'conflict markers (<<<<<<<, =======, >>>>>>>). Produce the correct merged file ' +
    'by reconciling both sides, preserving intended behavior from each where ' +
    'possible. Remove ALL conflict markers. ' +
    'Output ONLY the complete resolved file content — no explanations, no markdown ' +
    'code fences, no commentary. If you cannot safely resolve a hunk, keep the ' +
    'side most consistent with the surrounding code.';

  const user = `File: ${filePath}\n\nResolve all conflicts in this file:\n\n${content}`;

  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

/**
 * Build the prompt for AI pull-request description generation.
 */
export function buildPullRequestPrompt(
  commits: string[],
  diff: string,
  meta: { head: string; base: string }
): AiMessage[] {
  const system =
    'You are writing a GitHub pull request description for a teammate to review. ' +
    'Summarize the intent of the whole branch, not each commit individually. ' +
    'Use short Markdown sections: "## Summary" (1-3 sentences), "## Changes" (bulleted), ' +
    'and "## Notes" only when there are risks, breaking changes or follow-ups worth calling out. ' +
    'Output ONLY the description body — no title, no markdown fences, no preamble.';

  const commitList = commits.length
    ? `Commits on this branch (newest first):\n${commits.map(c => `- ${c}`).join('\n')}\n\n`
    : '';
  const user =
    `Write a pull request description for merging \`${meta.head}\` into \`${meta.base}\`.\n\n` +
    `${commitList}\`\`\`diff\n${truncateDiff(diff)}\n\`\`\``;

  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

/**
 * Build the prompt for AI commit / change explanation.
 */
export function buildExplainPrompt(
  diff: string,
  meta?: { subject?: string; author?: string }
): AiMessage[] {
  const system =
    'You are a senior engineer reviewing a change for a teammate. ' +
    'Explain what the change does and, more importantly, WHY it likely matters. ' +
    'Be concise and use short Markdown sections: a one-line summary, key changes ' +
    '(bulleted), and any risks or things a reviewer should double-check. ' +
    'Do not restate the diff verbatim.';

  const header = meta?.subject
    ? `Commit: ${meta.subject}${meta.author ? ` (by ${meta.author})` : ''}\n\n`
    : '';

  const user = `${header}Explain the following diff:\n\n\`\`\`diff\n${truncateDiff(diff)}\n\`\`\``;

  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

/**
 * Build the AI code-review prompt, fusing the diff with linter findings.
 * (Moved here from commands/ai.ts so review surfaces share one builder.)
 */
export function buildReviewPrompt(diff: string, lintFindings: string): AiMessage[] {
  const system =
    'You are a meticulous senior code reviewer. Review the provided diff for ' +
    'correctness bugs, security issues, performance problems, and maintainability. ' +
    'You are also given findings from deterministic linters/compilers — incorporate ' +
    'and prioritize them, but also find issues they cannot. ' +
    'Return concise Markdown grouped by severity (Critical / High / Medium / Low). ' +
    'For each finding give: file:line, what is wrong, and a concrete fix. ' +
    'If the change looks good, say so briefly.';

  const lintSection = lintFindings
    ? `\n\nLinter/compiler findings for changed files:\n${lintFindings}`
    : '\n\n(No linter findings were available from the editor.)';

  const user = `Review this diff:${lintSection}\n\n\`\`\`diff\n${truncateDiff(diff)}\n\`\`\``;

  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

/**
 * Structured-review prompt for the review PANEL: demands strict JSON findings
 * so results can be rendered with jump-to-line and severity filters.
 */
export function buildStructuredReviewPrompt(diff: string, lintFindings: string): AiMessage[] {
  const system =
    'You are a meticulous senior code reviewer. Review the diff for correctness ' +
    'bugs, security issues, performance problems, and maintainability. Report every ' +
    'issue you find, including ones you are uncertain about or consider low-severity — ' +
    'include your confidence via the severity field rather than filtering. ' +
    'Respond with ONLY a JSON object matching exactly this shape (no markdown fences, no prose):\n' +
    '{"summary": "<1-3 sentence overall assessment>", "findings": [{"file": "<repo-relative path>", ' +
    '"startLine": <number>, "endLine": <number>, "severity": "critical"|"warning"|"suggestion"|"nit", ' +
    '"title": "<short title>", "rationale": "<why this matters>", ' +
    '"suggestion": "<optional replacement code for those lines, omit if none>"}]}\n' +
    'Line numbers refer to the NEW file version (use the diff hunk headers). ' +
    'If the change looks good, return an empty findings array with a positive summary.';

  const lintSection = lintFindings
    ? `\n\nLinter/compiler findings for changed files:\n${lintFindings}`
    : '';

  const user = `Review this diff:${lintSection}\n\n\`\`\`diff\n${truncateDiff(diff)}\n\`\`\``;

  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

/** Natural-language commit search → git log filter translation. */
export function buildCommitSearchPrompt(query: string): AiMessage[] {
  const system =
    "You translate a natural-language question about a Git repository's history into " +
    'git log filters. Respond with ONLY a JSON object (no fences, no prose) of this shape:\n' +
    '{"grep": "<regex for commit messages, or omit>", "author": "<author name/email fragment, or omit>", ' +
    '"since": "<ISO date or git-approxidate like \\"2 weeks ago\\", or omit>", ' +
    '"until": "<ISO date, or omit>", "pickaxe": "<code string whose additions/removals to find (git -S), or omit>", ' +
    '"paths": ["<path fragments to limit to, or omit>"]}\n' +
    'Prefer "pickaxe" when the question is about when specific code/identifiers changed; ' +
    'prefer "grep" for topics mentioned in commit messages. Keep filters broad enough to match.';

  return [
    { role: 'system', content: system },
    { role: 'user', content: query },
  ];
}

/** Changelog / release-notes generation between two refs. */
export function buildChangelogPrompt(
  commits: string[],
  diffStat: string,
  meta: { from: string; to: string }
): AiMessage[] {
  const config = vscode.workspace.getConfiguration('gitNova');
  const conventional = config.get<boolean>('ai.conventionalCommits', true);

  const system =
    'You write clear, user-facing release notes from Git history. ' +
    (conventional
      ? 'Commits follow Conventional Commits — group entries under "### Features", ' +
        '"### Bug Fixes", "### Performance", and "### Other" as applicable. '
      : 'Group related changes under sensible headings. ') +
    'Write for users of the software, not contributors: describe outcomes, not implementation. ' +
    'Merge related commits into single entries. Skip trivial chores unless notable. ' +
    'Output Markdown only — start with a "## <from>..<to>" heading line.';

  const user =
    `Generate release notes for changes from \`${meta.from}\` to \`${meta.to}\`.\n\n` +
    `Commits (newest first):\n${commits.map(c => `- ${c}`).join('\n')}\n\n` +
    `Diffstat:\n${diffStat}`;

  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

/** Branch name suggestions from a description or diff. */
export function buildBranchNamePrompt(input: string, prefixes: string[]): AiMessage[] {
  const system =
    'You suggest Git branch names. Respond with ONLY a JSON array of 3-5 strings ' +
    '(no fences, no prose). Names must be kebab-case, short (max ~40 chars), and ' +
    (prefixes.length
      ? `start with one of these prefixes where appropriate: ${prefixes.join(', ')}. `
      : 'use conventional prefixes like feature/, bugfix/, chore/ where appropriate. ') +
    'Order from best to worst.';

  return [
    { role: 'system', content: system },
    { role: 'user', content: `Suggest branch names for this work:\n\n${input}` },
  ];
}
