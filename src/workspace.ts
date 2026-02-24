import { createHash } from 'crypto';
import { execFile } from 'child_process';
import * as vscode from 'vscode';

/**
 * Returns the SHA-256 hex digest of the first workspace folder's path.
 * Returns undefined if no workspace folder is open.
 */
export function getWorkspaceId(): string | undefined {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    return undefined;
  }
  return createHash('sha256').update(folders[0].uri.fsPath).digest('hex');
}

/**
 * Returns the name of the first workspace folder.
 * Returns undefined if no workspace folder is open.
 */
export function getWorkspaceName(): string | undefined {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    return undefined;
  }
  return folders[0].name;
}

// Cache: undefined = not yet resolved, null = resolved but no remote
let cachedRepoUrl: string | null | undefined;
let cachedRepoName: string | null | undefined;

/**
 * Normalizes a git remote URL to canonical form: "github.com/user/repo".
 * Handles SSH (git@host:path), ssh:// protocol, and HTTPS variants.
 */
export function normalizeGitUrl(raw: string): string | null {
  const url = raw.trim();
  if (!url) { return null; }

  // SSH: git@host:path or ssh://git@host/path
  const sshMatch = url.match(/^(?:ssh:\/\/)?[^@]+@([^:/]+)[:/](.+)$/);
  if (sshMatch) {
    const host = sshMatch[1].toLowerCase();
    const path = sshMatch[2].replace(/\.git$/, '').replace(/^\/+/, '');
    return `${host}/${path}`;
  }

  // HTTPS/HTTP: https://[user@]host/path
  const httpsMatch = url.match(/^https?:\/\/(?:[^@]+@)?([^/]+)\/(.+)$/);
  if (httpsMatch) {
    const host = httpsMatch[1].toLowerCase();
    const path = httpsMatch[2].replace(/\.git$/, '').replace(/\/+$/, '');
    return `${host}/${path}`;
  }

  return null;
}

/**
 * Derives a short repo name from a normalized URL.
 * "github.com/user/repo" → "user/repo"
 */
export function deriveRepoName(normalizedUrl: string): string {
  const slashIndex = normalizedUrl.indexOf('/');
  return slashIndex === -1 ? normalizedUrl : normalizedUrl.substring(slashIndex + 1);
}

/**
 * Resolves the git remote origin URL for the current workspace.
 * Result is cached for the extension lifetime.
 */
export async function getRepoUrl(): Promise<string | null> {
  if (cachedRepoUrl !== undefined) { return cachedRepoUrl; }

  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    cachedRepoUrl = null;
    cachedRepoName = null;
    return null;
  }

  try {
    const raw = await execGitRemote(folders[0].uri.fsPath);
    const normalized = normalizeGitUrl(raw);
    cachedRepoUrl = normalized;
    cachedRepoName = normalized ? deriveRepoName(normalized) : null;
    return cachedRepoUrl;
  } catch {
    cachedRepoUrl = null;
    cachedRepoName = null;
    return null;
  }
}

/** Returns the cached short repo name. Must be called after getRepoUrl() resolves. */
export function getRepoName(): string | null {
  return cachedRepoName ?? null;
}

function execGitRemote(cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', ['remote', 'get-url', 'origin'], { cwd, timeout: 5000 }, (error, stdout) => {
      if (error) { reject(error); }
      else { resolve(stdout.trim()); }
    });
  });
}
