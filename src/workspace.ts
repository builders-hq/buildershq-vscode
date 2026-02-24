import { createHash } from 'crypto';
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
