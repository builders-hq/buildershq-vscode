import * as vscode from 'vscode';
import * as os from 'os';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { PresenceTracker, PresenceStatus, ActivityReason } from './presence';
import { HeartbeatService, HeartbeatUser } from './heartbeat';
import { StatusBarManager } from './statusBar';
import { ClaudeCodeWatcher } from './claudeWatcher';
import { CodexSessionWatcher } from './codexWatcher';
import { OpencodeSessionWatcher } from './opencodeWatcher';
import { GeminiSessionWatcher } from './geminiWatcher';
import { AiderWatcher } from './aiderWatcher';
import { GitCommitWatcher } from './gitWatcher';
import { RoomWatcher } from './roomWatcher';
import { playSound } from './soundPlayer';
import { loadRuntimeConfig } from './env';
import { MongoStore } from './mongoStore';
import { GitHubAuthService } from './githubAuth';
import { getWorkspaceId } from './workspace';

const PAUSE_STATE_KEY = 'buildershq.paused';

let presenceTracker: PresenceTracker | undefined;
let heartbeatService: HeartbeatService | undefined;
let statusBarManager: StatusBarManager | undefined;
let claudeWatcher: ClaudeCodeWatcher | undefined;
let codexWatcher: CodexSessionWatcher | undefined;
let opencodeWatcher: OpencodeSessionWatcher | undefined;
let geminiWatcher: GeminiSessionWatcher | undefined;
let aiderWatcher: AiderWatcher | undefined;
let gitWatcher: GitCommitWatcher | undefined;
let mongoStore: MongoStore | undefined;
let githubAuthService: GitHubAuthService | undefined;
let roomWatcher: RoomWatcher | undefined;
let trackingStarted = false;
let serverBaseUrl = '';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const sessionId = randomUUID();
  const runtimeConfigProvider = () => loadRuntimeConfig();

  mongoStore = new MongoStore(runtimeConfigProvider);
  githubAuthService = new GitHubAuthService(context, runtimeConfigProvider, mongoStore);
  await githubAuthService.restoreSession();

  presenceTracker = new PresenceTracker();
  const cfg = vscode.workspace.getConfiguration('buildershq');
  const runtimeCfg = loadRuntimeConfig();
  console.log(`[BuildersHQ] Runtime config: envPath=${runtimeCfg.envPath}, presenceServerUrl=${runtimeCfg.presenceServerUrl || '(empty)'}`);
  const endpointUrl = runtimeCfg.presenceServerUrl ||
    cfg.get<string>('serverUrl', 'https://buildershq.net/api/presence');
  console.log(`[BuildersHQ] Resolved endpointUrl=${endpointUrl}`);
  // Auth always uses the VS Code setting (not .env override) so it hits production
  const authEndpointUrl = cfg.get<string>('serverUrl', 'https://buildershq.net/api/presence');
  serverBaseUrl = authEndpointUrl.replace(/\/api\/presence\/?$/, '');

  // Register URI handler for browser-based login callback
  const uriHandlerDisposable = githubAuthService.registerUriHandler(serverBaseUrl);

  heartbeatService = new HeartbeatService(sessionId, () => presenceTracker!.isFocused(), {
    endpointUrl,
    getUser: () => getHeartbeatUser(),
    getAccessToken: () => githubAuthService?.getBuildersHQAccessToken(),
    persistPayload: async (payload) => {
      await mongoStore?.saveHeartbeat(payload);
    },
  });
  heartbeatService.resolveRepoInfo().catch(() => { /* repoUrl stays null */ });
  statusBarManager = new StatusBarManager();

  // Room presence: play a door sound when a new person joins the workspace
  const workspaceId = getWorkspaceId();
  if (workspaceId) {
    roomWatcher = new RoomWatcher(workspaceId, endpointUrl + '/current');
    roomWatcher.onPersonJoined((name) => {
      playSound(path.join(context.extensionPath, 'media', 'door.wav'));
      vscode.window.showInformationMessage(`${name} joined the room`);
    });
  }

  // Wire presence state changes → status bar + heartbeat
  presenceTracker.onStateChange(
    (newStatus: PresenceStatus, oldStatus: PresenceStatus, reason: ActivityReason) => {
      updateStatusBar(context);
      if (!context.globalState.get<boolean>(PAUSE_STATE_KEY, false) && trackingStarted) {
        heartbeatService!.onPresenceStateChange(newStatus, oldStatus, reason);
      }
    }
  );

  // Wire force heartbeat (for debug/task events that need immediate send)
  presenceTracker.onForceHeartbeat((reason: ActivityReason) => {
    if (!context.globalState.get<boolean>(PAUSE_STATE_KEY, false) && trackingStarted) {
      heartbeatService!.forceHeartbeat(reason);
    }
  });

  // Wire connection changes → status bar
  heartbeatService.onConnectionChange(() => {
    updateStatusBar(context);
  });

  // Wire auth failure → try refresh, re-exchange, or prompt login
  heartbeatService.onAuthFailure(async () => {
    console.log('[BuildersHQ] Handling auth failure — attempting token refresh');
    const refreshed = await githubAuthService!.refreshBuildersHQToken(serverBaseUrl);
    if (refreshed) {
      console.log('[BuildersHQ] Token refreshed successfully');
      return;
    }

    console.log('[BuildersHQ] Refresh failed — attempting re-exchange');
    const exchanged = await githubAuthService!.exchangeForBuildersHQToken(serverBaseUrl);
    if (exchanged) {
      console.log('[BuildersHQ] Token re-exchanged successfully');
      return;
    }

    console.log('[BuildersHQ] All token recovery failed — stopping tracking');
    stopTracking();
    promptLogin(context);
  });

  // Pause / Resume commands
  const pauseCmd = vscode.commands.registerCommand('buildershq.pause', async () => {
    await context.globalState.update(PAUSE_STATE_KEY, true);
    heartbeatService!.stop();
    claudeWatcher?.stop();
    codexWatcher?.stop();
    opencodeWatcher?.stop();
    geminiWatcher?.stop();
    aiderWatcher?.stop();
    gitWatcher?.stop();
    roomWatcher?.stop();
    updateStatusBar(context);
  });

  const resumeCmd = vscode.commands.registerCommand('buildershq.resume', async () => {
    await context.globalState.update(PAUSE_STATE_KEY, false);
    if (trackingStarted) {
      const state = presenceTracker!.getState();
      heartbeatService!.start(state.status, state.reason);
      if (claudeWatcher) {
        claudeWatcher.start();
      }
      if (codexWatcher) {
        codexWatcher.start();
      }
      if (opencodeWatcher) {
        opencodeWatcher.start();
      }
      if (geminiWatcher) {
        geminiWatcher.start();
      }
      if (aiderWatcher) {
        aiderWatcher.start();
      }
      if (gitWatcher) {
        gitWatcher.start();
      }
      roomWatcher?.start();
    }
    updateStatusBar(context);
  });

  const loginCmd = vscode.commands.registerCommand('buildershq.loginWithGitHub', async () => {
    console.log('[BuildersHQ] Login command invoked — trying browser flow');
    try {
      // Primary: browser-based login
      const user = await githubAuthService!.loginViaBrowser(serverBaseUrl);
      if (user) {
        console.log(`[BuildersHQ] Browser login succeeded: ${user.githubLogin}`);
        vscode.window.showInformationMessage(`BuildersHQ: Logged in as ${user.githubLogin}`);
        startTracking(context);
        updateStatusBar(context);
        return;
      }

      // Fallback: VS Code built-in GitHub auth + device flow
      console.log('[BuildersHQ] Browser login timed out — falling back to VS Code auth');
      const fallbackUser = await githubAuthService!.login();
      if (fallbackUser) {
        console.log(`[BuildersHQ] Fallback login succeeded: ${fallbackUser.githubLogin}`);
        vscode.window.showInformationMessage(`BuildersHQ: Logged in as ${fallbackUser.githubLogin}`);
        const exchanged = await githubAuthService!.exchangeForBuildersHQToken(serverBaseUrl);
        if (exchanged) {
          startTracking(context);
        } else {
          vscode.window.showWarningMessage(
            'BuildersHQ: Logged in to GitHub but could not connect to the BuildersHQ server.',
          );
        }
      } else {
        console.log('[BuildersHQ] Fallback login also returned no user');
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.log(`[BuildersHQ] Login command error: ${message}`);
      vscode.window.showErrorMessage(`BuildersHQ GitHub login failed: ${message}`);
    }
    updateStatusBar(context);
  });

  const logoutCmd = vscode.commands.registerCommand('buildershq.logoutFromGitHub', async () => {
    console.log('[BuildersHQ] Logout command invoked');
    stopTracking();
    await githubAuthService!.logout();
    vscode.window.showInformationMessage('BuildersHQ: Logged out. Use "BuildersHQ: Login" to sign in again.');
    updateStatusBar(context);
  });

  const dashboardCmd = vscode.commands.registerCommand('buildershq.openDashboard', () => {
    vscode.env.openExternal(vscode.Uri.parse(serverBaseUrl || 'https://buildershq.net'));
  });

  // Debug session activity detection
  const debugStartSub = vscode.debug.onDidStartDebugSession((session) => {
    heartbeatService!.setDebugType(session.type);
    presenceTracker!.recordExternalActivity('debug_start', true);
  });

  const debugStopSub = vscode.debug.onDidTerminateDebugSession(() => {
    heartbeatService!.setDebugType(null);
    presenceTracker!.recordExternalActivity('debug_stop', false);
  });

  // Task activity detection (build/test)
  const taskStartSub = vscode.tasks.onDidStartTaskProcess((e) => {
    heartbeatService!.setTaskName(e.execution.task.name);
    presenceTracker!.recordExternalActivity('task_start', true);
  });

  const taskEndSub = vscode.tasks.onDidEndTaskProcess(() => {
    heartbeatService!.setTaskName(null);
    presenceTracker!.recordExternalActivity('task_end', false);
  });

  // Manual save activity tracking (source: 'vscode')
  const saveActivitySub = vscode.workspace.onDidSaveTextDocument((doc) => {
    if (context.globalState.get<boolean>(PAUSE_STATE_KEY, false)) { return; }
    const languageId = doc.languageId || null;
    heartbeatService!.setActivity({
      timestamp: Date.now(),
      claudeSessionId: 'vscode:edit',
      activityType: 'editing',
      tool: null,
      filePath: null,
      command: null,
      summary: languageId ? `Writing ${languageId}` : 'Writing code',
    }, 'vscode');
  });

  // Restart heartbeat timer when configuration changes
  const configChangeSub = vscode.workspace.onDidChangeConfiguration((e) => {
    if (e.affectsConfiguration('buildershq')) {
      // Re-apply endpoint URL if serverUrl changed
      if (e.affectsConfiguration('buildershq.serverUrl')) {
        const newCfg = vscode.workspace.getConfiguration('buildershq');
        const newRuntime = loadRuntimeConfig();
        heartbeatService!.setEndpointUrl(
          newRuntime.presenceServerUrl ||
          newCfg.get<string>('serverUrl', 'https://buildershq.net/api/presence')
        );
      }

      // Existing heartbeat reconfiguration
      if (!context.globalState.get<boolean>(PAUSE_STATE_KEY, false) && trackingStarted) {
        const state = presenceTracker!.getState();
        heartbeatService!.onPresenceStateChange(state.status, state.status, state.reason);
      }

      // Handle Claude Code enabled/disabled toggle
      if (e.affectsConfiguration('buildershq.claudeCode')) {
        handleClaudeCodeConfigChange(context);
      }

      // Handle OpenAI Codex enabled/disabled toggle
      if (e.affectsConfiguration('buildershq.codex')) {
        handleCodexConfigChange(context);
      }

      // Handle Opencode enabled/disabled toggle
      if (e.affectsConfiguration('buildershq.opencode')) {
        handleOpencodeConfigChange(context);
      }

      // Handle Gemini CLI enabled/disabled toggle
      if (e.affectsConfiguration('buildershq.gemini')) {
        handleGeminiConfigChange(context);
      }

      // Handle Aider enabled/disabled toggle
      if (e.affectsConfiguration('buildershq.aider')) {
        handleAiderConfigChange(context);
      }

      // Handle git commits enabled/disabled toggle
      if (e.affectsConfiguration('buildershq.gitCommits')) {
        handleGitCommitsConfigChange(context);
      }
    }
  });

  // Start presence tracker always (needed for status tracking)
  presenceTracker.start();

  // Attempt to start tracking if authenticated
  console.log(`[BuildersHQ] Activation auth check: isAuthenticated=${githubAuthService.isAuthenticated()}, hasApiToken=${Boolean(githubAuthService.getBuildersHQAccessToken())}, user=${githubAuthService.getUserProfile()?.githubLogin ?? 'none'}`);
  if (githubAuthService.isAuthenticated()) {
    if (githubAuthService.getBuildersHQAccessToken()) {
      // Fully authenticated — start immediately
      console.log('[BuildersHQ] Fully authenticated — starting tracking immediately');
      startTracking(context);
    } else {
      // Has GitHub but no BuildersHQ token — exchange
      console.log('[BuildersHQ] Has GitHub auth but no API token — exchanging');
      const exchanged = await githubAuthService.exchangeForBuildersHQToken(serverBaseUrl);
      if (exchanged) {
        console.log('[BuildersHQ] Token exchange succeeded — starting tracking');
        startTracking(context);
      } else {
        // Server unreachable or token invalid — show as not connected
        // Will retry on next login or when server becomes available
        console.log('[BuildersHQ] Token exchange failed on activation — prompting login');
        promptLogin(context);
      }
    }
  } else {
    // Not authenticated at all — prompt login
    console.log('[BuildersHQ] Not authenticated — prompting login');
    promptLogin(context);
  }

  updateStatusBar(context);

  // Register all disposables
  context.subscriptions.push(
    presenceTracker,
    statusBarManager,
    uriHandlerDisposable,
    pauseCmd,
    resumeCmd,
    loginCmd,
    logoutCmd,
    dashboardCmd,
    debugStartSub,
    debugStopSub,
    taskStartSub,
    taskEndSub,
    saveActivitySub,
    configChangeSub,
    githubAuthService
  );
}

function startTracking(context: vscode.ExtensionContext): void {
  if (trackingStarted) {
    console.log('[BuildersHQ] startTracking() — already started, skipping');
    return;
  }
  console.log('[BuildersHQ] startTracking() — initializing heartbeats and watchers');
  trackingStarted = true;

  const isPaused = context.globalState.get<boolean>(PAUSE_STATE_KEY, false);

  if (!isPaused) {
    heartbeatService!.start('active', 'activate');
    roomWatcher?.start();
  }

  // Claude Code activity tracking
  initClaudeCodeTracking(context, isPaused);

  // OpenAI Codex activity tracking
  initCodexTracking(context, isPaused);

  // Opencode activity tracking
  initOpencodeTracking(context, isPaused);

  // Gemini CLI activity tracking
  initGeminiTracking(context, isPaused);

  // Aider activity tracking
  initAiderTracking(context, isPaused);

  // Git commit activity tracking
  initGitCommitTracking(context, isPaused);

  updateStatusBar(context);
}

function stopTracking(): void {
  if (!trackingStarted) {
    console.log('[BuildersHQ] stopTracking() — not started, skipping');
    return;
  }
  console.log('[BuildersHQ] stopTracking() — stopping heartbeats and watchers');
  trackingStarted = false;

  heartbeatService?.stop();
  claudeWatcher?.stop();
  codexWatcher?.stop();
  opencodeWatcher?.stop();
  geminiWatcher?.stop();
  aiderWatcher?.stop();
  gitWatcher?.stop();
  roomWatcher?.stop();
}

async function promptLogin(context: vscode.ExtensionContext): Promise<void> {
  console.log('[BuildersHQ] promptLogin() — opening browser for login');
  updateStatusBar(context);

  // Auto-open the browser for a full-page login experience
  const user = await githubAuthService!.loginViaBrowser(serverBaseUrl);
  if (user) {
    console.log(`[BuildersHQ] Browser login succeeded: ${user.githubLogin}`);
    vscode.window.showInformationMessage(`BuildersHQ: Logged in as ${user.githubLogin}`);
    startTracking(context);
    updateStatusBar(context);
    return;
  }

  // Fallback: show notification for manual login
  console.log('[BuildersHQ] Browser login timed out — showing notification fallback');
  vscode.window.showInformationMessage(
    'BuildersHQ requires GitHub login to track your presence.',
    'Login with GitHub',
  ).then((choice) => {
    if (choice === 'Login with GitHub') {
      vscode.commands.executeCommand('buildershq.loginWithGitHub');
    }
  });
}

function initClaudeCodeTracking(
  context: vscode.ExtensionContext,
  isPaused: boolean,
): void {
  const config = vscode.workspace.getConfiguration('buildershq');
  if (!config.get<boolean>('claudeCode.enabled', true)) {
    return;
  }

  claudeWatcher = new ClaudeCodeWatcher();

  claudeWatcher.onActivityBatch((events) => {
    if (context.globalState.get<boolean>(PAUSE_STATE_KEY, false)) { return; }
    for (const event of events) {
      heartbeatService!.setActivity(event);
    }
    // Claude activity counts as user presence — keep status active
    presenceTracker!.recordExternalActivity('task_start', false);
    heartbeatService!.flushActivity();
  });

  if (!isPaused) {
    claudeWatcher.start();
  }

  context.subscriptions.push(claudeWatcher);
}

function handleClaudeCodeConfigChange(
  context: vscode.ExtensionContext,
): void {
  const config = vscode.workspace.getConfiguration('buildershq');
  const enabled = config.get<boolean>('claudeCode.enabled', true);
  const isPaused = context.globalState.get<boolean>(PAUSE_STATE_KEY, false);

  if (enabled && !claudeWatcher) {
    // Turning on
    claudeWatcher = new ClaudeCodeWatcher();

    claudeWatcher.onActivityBatch((events) => {
      if (context.globalState.get<boolean>(PAUSE_STATE_KEY, false)) { return; }
      for (const event of events) {
        heartbeatService!.setActivity(event);
      }
      presenceTracker!.recordExternalActivity('task_start', false);
      heartbeatService!.flushActivity();
    });

    if (!isPaused) {
      claudeWatcher.start();
    }

    context.subscriptions.push(claudeWatcher);
  } else if (!enabled && claudeWatcher) {
    // Turning off
    claudeWatcher.dispose();
    claudeWatcher = undefined;
  } else if (enabled && claudeWatcher) {
    // Config changed (e.g. transcriptPath) — restart watcher
    claudeWatcher.stop();
    if (!isPaused) {
      claudeWatcher.start();
    }
  }

  updateStatusBar(context);
}

function initCodexTracking(
  context: vscode.ExtensionContext,
  isPaused: boolean,
): void {
  const config = vscode.workspace.getConfiguration('buildershq');
  if (!config.get<boolean>('codex.enabled', true)) {
    return;
  }

  codexWatcher = new CodexSessionWatcher();

  codexWatcher.onActivityBatch((events) => {
    if (context.globalState.get<boolean>(PAUSE_STATE_KEY, false)) { return; }
    for (const event of events) {
      heartbeatService!.setActivity(event, 'codex');
    }
    // Codex activity counts as user presence - keep status active
    presenceTracker!.recordExternalActivity('task_start', false);
    heartbeatService!.flushActivity();
  });

  if (!isPaused) {
    codexWatcher.start();
  }

  context.subscriptions.push(codexWatcher);
}

function handleCodexConfigChange(
  context: vscode.ExtensionContext,
): void {
  const config = vscode.workspace.getConfiguration('buildershq');
  const enabled = config.get<boolean>('codex.enabled', true);
  const isPaused = context.globalState.get<boolean>(PAUSE_STATE_KEY, false);

  if (enabled && !codexWatcher) {
    // Turning on
    codexWatcher = new CodexSessionWatcher();

    codexWatcher.onActivityBatch((events) => {
      if (context.globalState.get<boolean>(PAUSE_STATE_KEY, false)) { return; }
      for (const event of events) {
        heartbeatService!.setActivity(event, 'codex');
      }
      presenceTracker!.recordExternalActivity('task_start', false);
      heartbeatService!.flushActivity();
    });

    if (!isPaused) {
      codexWatcher.start();
    }

    context.subscriptions.push(codexWatcher);
  } else if (!enabled && codexWatcher) {
    // Turning off
    codexWatcher.dispose();
    codexWatcher = undefined;
  } else if (enabled && codexWatcher) {
    // Config changed (e.g. transcriptPath) - restart watcher
    codexWatcher.stop();
    if (!isPaused) {
      codexWatcher.start();
    }
  }

  updateStatusBar(context);
}

function initOpencodeTracking(
  context: vscode.ExtensionContext,
  isPaused: boolean,
): void {
  const config = vscode.workspace.getConfiguration('buildershq');
  if (!config.get<boolean>('opencode.enabled', true)) {
    return;
  }

  opencodeWatcher = new OpencodeSessionWatcher();

  opencodeWatcher.onActivityBatch((events) => {
    if (context.globalState.get<boolean>(PAUSE_STATE_KEY, false)) { return; }
    for (const event of events) {
      heartbeatService!.setActivity(event, 'opencode');
    }
    presenceTracker!.recordExternalActivity('task_start', false);
    heartbeatService!.flushActivity();
  });

  if (!isPaused) {
    opencodeWatcher.start();
  }

  context.subscriptions.push(opencodeWatcher);
}

function handleOpencodeConfigChange(
  context: vscode.ExtensionContext,
): void {
  const config = vscode.workspace.getConfiguration('buildershq');
  const enabled = config.get<boolean>('opencode.enabled', true);
  const isPaused = context.globalState.get<boolean>(PAUSE_STATE_KEY, false);

  if (enabled && !opencodeWatcher) {
    initOpencodeTracking(context, isPaused);
  } else if (!enabled && opencodeWatcher) {
    opencodeWatcher.dispose();
    opencodeWatcher = undefined;
  } else if (enabled && opencodeWatcher) {
    opencodeWatcher.stop();
    if (!isPaused) {
      opencodeWatcher.start();
    }
  }

  updateStatusBar(context);
}

function initGeminiTracking(
  context: vscode.ExtensionContext,
  isPaused: boolean,
): void {
  const config = vscode.workspace.getConfiguration('buildershq');
  if (!config.get<boolean>('gemini.enabled', true)) {
    return;
  }

  geminiWatcher = new GeminiSessionWatcher();

  geminiWatcher.onActivityBatch((events) => {
    if (context.globalState.get<boolean>(PAUSE_STATE_KEY, false)) { return; }
    for (const event of events) {
      heartbeatService!.setActivity(event, 'gemini');
    }
    presenceTracker!.recordExternalActivity('task_start', false);
    heartbeatService!.flushActivity();
  });

  if (!isPaused) {
    geminiWatcher.start();
  }

  context.subscriptions.push(geminiWatcher);
}

function handleGeminiConfigChange(
  context: vscode.ExtensionContext,
): void {
  const config = vscode.workspace.getConfiguration('buildershq');
  const enabled = config.get<boolean>('gemini.enabled', true);
  const isPaused = context.globalState.get<boolean>(PAUSE_STATE_KEY, false);

  if (enabled && !geminiWatcher) {
    initGeminiTracking(context, isPaused);
  } else if (!enabled && geminiWatcher) {
    geminiWatcher.dispose();
    geminiWatcher = undefined;
  } else if (enabled && geminiWatcher) {
    geminiWatcher.stop();
    if (!isPaused) {
      geminiWatcher.start();
    }
  }

  updateStatusBar(context);
}

function initAiderTracking(
  context: vscode.ExtensionContext,
  isPaused: boolean,
): void {
  const config = vscode.workspace.getConfiguration('buildershq');
  if (!config.get<boolean>('aider.enabled', true)) {
    return;
  }

  aiderWatcher = new AiderWatcher();

  aiderWatcher.onActivityBatch((events) => {
    if (context.globalState.get<boolean>(PAUSE_STATE_KEY, false)) { return; }
    for (const event of events) {
      heartbeatService!.setActivity(event, 'aider');
    }
    presenceTracker!.recordExternalActivity('task_start', false);
    heartbeatService!.flushActivity();
  });

  if (!isPaused) {
    aiderWatcher.start();
  }

  context.subscriptions.push(aiderWatcher);
}

function handleAiderConfigChange(
  context: vscode.ExtensionContext,
): void {
  const config = vscode.workspace.getConfiguration('buildershq');
  const enabled = config.get<boolean>('aider.enabled', true);
  const isPaused = context.globalState.get<boolean>(PAUSE_STATE_KEY, false);

  if (enabled && !aiderWatcher) {
    initAiderTracking(context, isPaused);
  } else if (!enabled && aiderWatcher) {
    aiderWatcher.dispose();
    aiderWatcher = undefined;
  } else if (enabled && aiderWatcher) {
    aiderWatcher.stop();
    if (!isPaused) {
      aiderWatcher.start();
    }
  }

  updateStatusBar(context);
}

function initGitCommitTracking(
  context: vscode.ExtensionContext,
  isPaused: boolean,
): void {
  const config = vscode.workspace.getConfiguration('buildershq');
  if (!config.get<boolean>('gitCommits.enabled', true)) {
    return;
  }

  gitWatcher = new GitCommitWatcher();

  gitWatcher.onCommit((event) => {
    if (context.globalState.get<boolean>(PAUSE_STATE_KEY, false)) { return; }
    heartbeatService!.setActivity({
      timestamp: event.timestamp,
      claudeSessionId: 'git',
      activityType: 'editing',
      tool: null,
      filePath: null,
      command: null,
      summary: `Committed: ${event.subject}`,
      gitBranch: event.branch ?? undefined,
      gitCommitHash: event.shortHash,
    }, 'git');
    presenceTracker!.recordExternalActivity('save', false);
    heartbeatService!.flushActivity();
  });

  if (!isPaused) {
    gitWatcher.start();
  }

  context.subscriptions.push(gitWatcher);
}

function handleGitCommitsConfigChange(
  context: vscode.ExtensionContext,
): void {
  const config = vscode.workspace.getConfiguration('buildershq');
  const enabled = config.get<boolean>('gitCommits.enabled', true);
  const isPaused = context.globalState.get<boolean>(PAUSE_STATE_KEY, false);

  if (enabled && !gitWatcher) {
    initGitCommitTracking(context, isPaused);
  } else if (!enabled && gitWatcher) {
    gitWatcher.dispose();
    gitWatcher = undefined;
  }
}

function getHeartbeatUser(): HeartbeatUser | undefined {
  const user = githubAuthService?.getUserProfile();
  if (!user) {
    return undefined;
  }

  return {
    githubUserId: user.githubUserId,
    githubLogin: user.githubLogin,
    email: user.email,
    name: user.name,
    avatarUrl: user.avatarUrl,
  };
}

function updateStatusBar(context: vscode.ExtensionContext): void {
  if (!presenceTracker || !heartbeatService || !statusBarManager) {
    return;
  }
  const paused = context.globalState.get<boolean>(PAUSE_STATE_KEY, false);
  const status = presenceTracker.getStatus();
  const connected = heartbeatService.isConnected();
  const authenticated = githubAuthService?.isFullyAuthenticated() ?? false;
  const claudeActive = claudeWatcher?.isWatching() ?? false;
  const codexActive = codexWatcher?.isWatching() ?? false;
  const opencodeActive = opencodeWatcher?.isWatching() ?? false;
  const geminiActive = geminiWatcher?.isWatching() ?? false;
  const aiderActive = aiderWatcher?.isWatching() ?? false;
  statusBarManager.update(status, paused, connected, authenticated, claudeActive, codexActive, opencodeActive, geminiActive, aiderActive);
}

export async function deactivate(): Promise<void> {
  if (heartbeatService) {
    await heartbeatService.sendDeactivate();
  }
  await mongoStore?.dispose();
  heartbeatService?.dispose();
  githubAuthService?.dispose();
  claudeWatcher?.dispose();
  codexWatcher?.dispose();
  opencodeWatcher?.dispose();
  geminiWatcher?.dispose();
  aiderWatcher?.dispose();
  gitWatcher?.dispose();
  roomWatcher?.dispose();
  presenceTracker = undefined;
  heartbeatService = undefined;
  statusBarManager = undefined;
  claudeWatcher = undefined;
  codexWatcher = undefined;
  opencodeWatcher = undefined;
  geminiWatcher = undefined;
  aiderWatcher = undefined;
  gitWatcher = undefined;
  githubAuthService = undefined;
  mongoStore = undefined;
  roomWatcher = undefined;
  trackingStarted = false;
}
