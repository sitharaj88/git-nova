/**
 * Represents a git commit author
 */
export interface Author {
  /** Author name */
  readonly name: string;
  /** Author email */
  readonly email: string;
}

/**
 * One commit in a single file's history, with the line stats for that file.
 * Used by the Visual File History timeline.
 */
export interface FileHistoryEntry {
  readonly hash: string;
  readonly shortHash: string;
  readonly author: string;
  readonly authorEmail: string;
  readonly date: Date;
  readonly subject: string;
  readonly additions: number;
  readonly deletions: number;
}

/**
 * Represents a file in a commit
 */
export interface CommitFile {
  /** File path */
  readonly path: string;
  /** File status change type */
  readonly status: FileStatus;
  /** Number of added lines */
  readonly additions: number;
  /** Number of deleted lines */
  readonly deletions: number;
}

/**
 * Statistics for a commit
 */
export interface CommitStats {
  /** Total added lines */
  readonly totalAdditions: number;
  /** Total deleted lines */
  readonly totalDeletions: number;
  /** Total changed files */
  readonly totalFiles: number;
}

/**
 * Represents a git commit
 */
export interface Commit {
  /** Full commit hash */
  readonly hash: string;
  /** Short commit hash (abbreviated) */
  readonly shortHash: string;
  /** Commit message */
  readonly message: string;
  /** Commit author */
  readonly author: Author;
  /** Commit date */
  readonly date: Date;
  /** Parent commit hashes */
  readonly parents: string[];
  /** Git refs pointing to this commit */
  readonly refs: string[];
}

/**
 * detailed information about a commit
 */
export interface CommitDetail extends Commit {
  /** List of changed files */
  readonly files: CommitFile[];
  /** Detailed commit body/description */
  readonly body?: string;
  /** Commit statistics */
  readonly stats: CommitStats;
}

/**
 * Git file status codes
 */
export enum FileStatus {
  Unmodified = ' ',
  Modified = 'M',
  Added = 'A',
  Deleted = 'D',
  Renamed = 'R',
  Copied = 'C',
  Unmerged = 'U',
  Untracked = '?',
}
