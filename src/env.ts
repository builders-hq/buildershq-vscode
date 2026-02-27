import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { parse } from 'dotenv';

const ENV_CONFIG_KEY = 'sharedEnvFilePath';
const DEFAULT_ENV_PATH = '';
const FORCED_DB_NAME = 'BuildersHQ';

export interface RuntimeConfig {
  envPath: string;
  githubClientId: string;
  githubClientSecret: string;
  mongodbUri: string;
  mongodbDb: string;
  presenceServerUrl: string;
}

function resolveEnvPath(configuredPath: string): string {
  if (path.isAbsolute(configuredPath)) {
    return configuredPath;
  }

  const folders = vscode.workspace.workspaceFolders;
  if (folders && folders.length > 0) {
    return path.resolve(folders[0].uri.fsPath, configuredPath);
  }

  return path.resolve(configuredPath);
}

export function loadRuntimeConfig(): RuntimeConfig {
  const config = vscode.workspace.getConfiguration('buildershq');
  const configuredPath = config.get<string>(ENV_CONFIG_KEY, DEFAULT_ENV_PATH);
  const envPath = resolveEnvPath(configuredPath);

  let parsed: Record<string, string> = {};
  try {
    const raw = fs.readFileSync(envPath, 'utf8');
    parsed = parse(raw);
  } catch {
    parsed = {};
  }

  return {
    envPath,
    githubClientId: parsed.GITHUB_CLIENT_ID ?? '',
    githubClientSecret: parsed.GITHUB_CLIENT_SECRET ?? '',
    mongodbUri: parsed.MONGODB_URI ?? '',
    // Force BuildersHQ as requested, regardless of MONGODB_DB in the shared file.
    mongodbDb: FORCED_DB_NAME,
    presenceServerUrl: parsed.PRESENCE_SERVER_URL?.trim() ?? '',
  };
}
