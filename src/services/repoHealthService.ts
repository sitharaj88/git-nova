import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { GitService } from '../core/gitService';

export interface LargeFile {
  path: string;
  bytes: number;
}

export interface RepoHealthReport {
  /** Human-readable on-disk repository size (working tree + .git pack). */
  repoSizePretty: string;
  /** Loose (unpacked) object count — high values suggest running `gc`. */
  looseObjects: number;
  /** Bytes held by loose objects. */
  looseSizePretty: string;
  /** Number of packs. */
  packs: number;
  /** Garbage objects reported by count-objects. */
  garbage: number;
  /** Integrity check result. */
  fsckOk: boolean;
  fsckIssues: string[];
  /** Local branches already merged into the default branch (cleanup candidates). */
  mergedBranches: string[];
  /** Largest tracked files (LFS candidates). */
  largeFiles: LargeFile[];
  /** Number of stash entries. */
  stashCount: number;
  /** Whether git-lfs appears installed/initialized in this repo. */
  lfsConfigured: boolean;
  /** Derived, rule-based recommendations (independent of AI). */
  recommendations: HealthRecommendation[];
}

export interface HealthRecommendation {
  severity: 'high' | 'medium' | 'low' | 'ok';
  title: string;
  detail: string;
  /** Optional command id GitNova can run to remediate. */
  action?: { command: string; label: string };
}

const LARGE_FILE_THRESHOLD = 5 * 1024 * 1024; // 5 MB

/**
 * RepoHealthService — gathers a holistic health snapshot of the repository by
 * combining Git plumbing (count-objects, fsck, merged branches, file sizes,
 * stashes, LFS state). This is the data layer behind the Repo Doctor, a feature
 * not offered by mainstream Git extensions, which combine these signals with AI
 * guidance.
 */
export class RepoHealthService {
  constructor(private gitService: GitService) {}

  async analyze(defaultBranch: string): Promise<RepoHealthReport> {
    const repoPath = this.gitService.getRepositoryPath();
    if (!repoPath) {
      throw new Error('No active repository.');
    }

    const [counts, fsck, merged, largeFiles, stashCount, lfsConfigured] = await Promise.all([
      this.countObjects(repoPath),
      this.fsck(repoPath),
      this.mergedBranches(repoPath, defaultBranch),
      this.largeFiles(repoPath),
      this.stashCount(),
      this.lfsConfigured(repoPath),
    ]);

    const repoBytes = await this.dirSize(path.join(repoPath, '.git')).catch(() => 0);

    const report: RepoHealthReport = {
      repoSizePretty: prettyBytes(repoBytes),
      looseObjects: counts.count,
      looseSizePretty: prettyBytes(counts.sizeBytes),
      packs: counts.packs,
      garbage: counts.garbage,
      fsckOk: fsck.valid,
      fsckIssues: fsck.issues.slice(0, 20),
      mergedBranches: merged,
      largeFiles,
      stashCount,
      lfsConfigured,
      recommendations: [],
    };

    report.recommendations = buildRecommendations(report);
    return report;
  }

  private runGit(cwd: string, args: string[]): Promise<string> {
    return new Promise(resolve => {
      execFile('git', args, { cwd, maxBuffer: 20 * 1024 * 1024 }, (err, stdout) => {
        resolve(err ? '' : stdout);
      });
    });
  }

  private async countObjects(
    repoPath: string
  ): Promise<{ count: number; sizeBytes: number; packs: number; garbage: number }> {
    const out = await this.runGit(repoPath, ['count-objects', '-v']);
    const get = (key: string) => {
      const m = out.match(new RegExp(`^${key}:\\s*(\\d+)`, 'm'));
      return m ? parseInt(m[1], 10) : 0;
    };
    return {
      count: get('count'),
      sizeBytes: get('size') * 1024, // count-objects reports KiB
      packs: get('packs'),
      garbage: get('garbage'),
    };
  }

  private async fsck(repoPath: string): Promise<{ valid: boolean; issues: string[] }> {
    const out = await this.runGit(repoPath, ['fsck', '--no-progress', '--connectivity-only']);
    const issues = out
      .split('\n')
      .map(l => l.trim())
      .filter(l => /^(error|missing|broken|corrupt)/i.test(l));
    return { valid: issues.length === 0, issues };
  }

  private async mergedBranches(repoPath: string, defaultBranch: string): Promise<string[]> {
    const out = await this.runGit(repoPath, ['branch', '--merged', defaultBranch]);
    return out
      .split('\n')
      .map(l => l.replace('*', '').trim())
      .filter(
        l => l && l !== defaultBranch && !l.startsWith('(') && l !== 'master' && l !== 'main'
      );
  }

  private async largeFiles(repoPath: string): Promise<LargeFile[]> {
    const out = await this.runGit(repoPath, ['ls-files', '-z']);
    const files = out.split('\0').filter(Boolean);
    const result: LargeFile[] = [];
    for (const rel of files) {
      try {
        const stat = fs.statSync(path.join(repoPath, rel));
        if (stat.size >= LARGE_FILE_THRESHOLD) {
          result.push({ path: rel, bytes: stat.size });
        }
      } catch {
        /* ignore unreadable/deleted */
      }
    }
    return result.sort((a, b) => b.bytes - a.bytes).slice(0, 10);
  }

  private async stashCount(): Promise<number> {
    try {
      return (await this.gitService.getStashes()).length;
    } catch {
      return 0;
    }
  }

  private async lfsConfigured(repoPath: string): Promise<boolean> {
    return fs.existsSync(path.join(repoPath, '.gitattributes'))
      ? fs.readFileSync(path.join(repoPath, '.gitattributes'), 'utf8').includes('filter=lfs')
      : false;
  }

  /** Best-effort recursive directory size (bounded; ignores errors). */
  private async dirSize(dir: string): Promise<number> {
    let total = 0;
    const stack = [dir];
    let visited = 0;
    while (stack.length && visited < 50000) {
      const current = stack.pop()!;
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(current, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const e of entries) {
        visited++;
        const full = path.join(current, e.name);
        if (e.isDirectory()) {
          stack.push(full);
        } else {
          try {
            total += fs.statSync(full).size;
          } catch {
            /* ignore */
          }
        }
      }
    }
    return total;
  }
}

/** Convert the report into an AI prompt context string. */
export function reportToContext(r: RepoHealthReport): string {
  return [
    `Repository size (.git): ${r.repoSizePretty}`,
    `Loose objects: ${r.looseObjects} (${r.looseSizePretty}), packs: ${r.packs}, garbage: ${r.garbage}`,
    `Integrity (fsck): ${r.fsckOk ? 'OK' : 'ISSUES'} ${r.fsckIssues.join('; ')}`,
    `Merged branches not deleted: ${r.mergedBranches.length} (${r.mergedBranches.slice(0, 10).join(', ')})`,
    `Large tracked files (>5MB): ${r.largeFiles.map(f => `${f.path} (${prettyBytes(f.bytes)})`).join(', ') || 'none'}`,
    `LFS configured: ${r.lfsConfigured}`,
    `Stash entries: ${r.stashCount}`,
  ].join('\n');
}

function buildRecommendations(r: RepoHealthReport): HealthRecommendation[] {
  const recs: HealthRecommendation[] = [];

  if (!r.fsckOk) {
    recs.push({
      severity: 'high',
      title: 'Repository integrity issues detected',
      detail: `git fsck reported ${r.fsckIssues.length} issue(s). Investigate before relying on history.`,
      action: { command: 'gitNova.maintenance.fsck', label: 'Run full fsck' },
    });
  }

  if (r.looseObjects > 2000 || r.garbage > 0) {
    recs.push({
      severity: 'medium',
      title: 'Many loose objects — run garbage collection',
      detail: `${r.looseObjects} loose objects${r.garbage ? ` and ${r.garbage} garbage objects` : ''}. Running gc will repack and shrink the repo.`,
      action: { command: 'gitNova.maintenance.gc', label: 'Run gc' },
    });
  }

  if (r.largeFiles.length && !r.lfsConfigured) {
    recs.push({
      severity: 'medium',
      title: 'Large files not tracked by Git LFS',
      detail: `${r.largeFiles.length} file(s) over 5 MB are stored directly in Git. Consider Git LFS to keep the repo lean.`,
      action: { command: 'gitNova.lfs.track', label: 'Track with LFS' },
    });
  }

  if (r.mergedBranches.length >= 3) {
    recs.push({
      severity: 'low',
      title: 'Merged branches can be cleaned up',
      detail: `${r.mergedBranches.length} local branches are already merged and can be safely deleted.`,
    });
  }

  if (r.stashCount >= 5) {
    recs.push({
      severity: 'low',
      title: 'Several stashes are piling up',
      detail: `${r.stashCount} stash entries exist. Old stashes are easy to forget — review and clear them.`,
    });
  }

  if (recs.length === 0) {
    recs.push({
      severity: 'ok',
      title: 'Repository looks healthy',
      detail: 'No maintenance issues detected. Nice and tidy!',
    });
  }

  return recs;
}

function prettyBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(1)} ${units[i]}`;
}

export function createRepoHealthService(gitService: GitService): RepoHealthService {
  return new RepoHealthService(gitService);
}
