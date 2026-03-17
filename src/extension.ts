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
import { GitHubPrWatcher } from './githubPrWatcher';
import { GitBranchWatcher } from './gitBranchWatcher';
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
let githubPrWatcher: GitHubPrWatcher | undefined;
let gitBranchWatcher: GitBranchWatcher | undefined;
let mongoStore: MongoStore | undefined;
let githubAuthService: GitHubAuthService | undefined;
let roomWatcher: RoomWatcher | undefined;
let trackingStarted = false;
let serverBaseUrl = '';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const sessionId = randomUUID();
  const isDev = context.extensionMode !== vscode.ExtensionMode.Production;
  const runtimeConfigProvider = () => loadRuntimeConfig(isDev);

  mongoStore = new MongoStore(runtimeConfigProvider);
  githubAuthService = new GitHubAuthService(context, runtimeConfigProvider, mongoStore);
  await githubAuthService.restoreSession();

  presenceTracker = new PresenceTracker();
  const cfg = vscode.workspace.getConfiguration('buildershq');
  const runtimeCfg = loadRuntimeConfig(isDev);
  const endpointUrl = runtimeCfg.presenceServerUrl ||
    cfg.get<string>('serverUrl', 'https://buildershq.net/api/presence');
  // Auth always uses the VS Code setting (not .env override) so it hits production
  const authEndpointUrl = cfg.get<string>('serverUrl', 'https://buildershq.net/api/presence');
  serverBaseUrl = authEndpointUrl.replace(/\/api\/presence\/?$/, '');

  // Register URI handler for browser-based login callback
  const uriHandlerDisposable = githubAuthService.registerUriHandler(serverBaseUrl);

  // Initialize machineToken before creating HeartbeatService so
  // the getter is available from the first heartbeat.
  await githubAuthService.initMachineToken();

  const machineToken = githubAuthService.getMachineToken() ?? '';
  const userProfile = githubAuthService.getUserProfile();
  const workspaceId = getWorkspaceId();
  console.log(
    `[BuildersHQ] ── Startup ──────────────────────────\n` +
    `  mode:          ${isDev ? 'Development' : 'Production'}\n` +
    `  endpointUrl:   ${endpointUrl}\n` +
    `  serverBaseUrl: ${serverBaseUrl}\n` +
    `  .env path:     ${runtimeCfg.envPath}\n` +
    `  .env active:   ${isDev}\n` +
    `  computerName:  ${os.hostname()}\n` +
    `  machineToken:  ${machineToken.slice(0, 8) || '(none)'}...\n` +
    `  authenticated: ${githubAuthService.isAuthenticated()}\n` +
    `  apiToken:      ${Boolean(githubAuthService.getBuildersHQAccessToken())}\n` +
    `  user:          ${userProfile ? `@${userProfile.githubLogin}` : '(anonymous)'}\n` +
    `  sessionId:     ${sessionId}\n` +
    `  workspaceId:   ${workspaceId ?? '(none)'}\n` +
    `[BuildersHQ] ─────────────────────────────────────`,
  );

  heartbeatService = new HeartbeatService(sessionId, () => presenceTracker!.isFocused(), {
    endpointUrl,
    getUser: () => getHeartbeatUser(),
    getAccessToken: () => githubAuthService?.getBuildersHQAccessToken(),
    getMachineToken: () => githubAuthService?.getMachineToken(),
    persistPayload: async (payload) => {
      await mongoStore?.saveHeartbeat(payload);
    },
  });
  heartbeatService.resolveRepoInfo().catch(() => { /* repoUrl stays null */ });
  statusBarManager = new StatusBarManager();

  // Room presence: play a door sound when a new person joins the workspace
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

  // Wire auth failure → try refresh, re-exchange, or fall back to anonymous
  heartbeatService.onAuthFailure(async () => {
    console.log('[BuildersHQ] Handling auth failure — attempting token refresh');
    const refreshed = await githubAuthService!.refreshBuildersHQToken(serverBaseUrl);
    if (refreshed) {
      console.log('[BuildersHQ] Token refreshed successfully');
      updateStatusBar(context);
      return;
    }

    console.log('[BuildersHQ] Refresh failed — attempting re-exchange');
    const exchanged = await githubAuthService!.exchangeForBuildersHQToken(serverBaseUrl);
    if (exchanged) {
      console.log('[BuildersHQ] Token re-exchanged successfully');
      updateStatusBar(context);
      return;
    }

    // Don't stop tracking — fall back to anonymous mode.
    // The server accepts unauthenticated heartbeats keyed by computerName.
    console.log('[BuildersHQ] All token recovery failed — continuing in anonymous mode');
    await githubAuthService!.logout();
    updateStatusBar(context);
  });

  // Wire reverse-identification via heartbeat response: when the server
  // delivers a claim token (user logged in on website for this machineToken),
  // automatically upgrade from anonymous to authenticated mode.
  heartbeatService.onClaimToken(async (claim) => {
    try {
      console.log(`[BuildersHQ] Received claim token for @${claim.user.githubLogin}`);
      const accepted = await githubAuthService!.acceptClaimToken(claim);
      if (!accepted) { return; }

      vscode.window.showInformationMessage(
        `BuildersHQ: You've been identified as @${claim.user.githubLogin}`,
      );
      heartbeatService!.forceHeartbeat('activate');
      updateStatusBar(context);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`[BuildersHQ] Failed to process claim token: ${msg}`);
    }
  });

  // Wire website-initiated identification via vscode:// URI redirect.
  // When the user logs in on buildershq.net and clicks "Connect VS Code",
  // the URI handler fires handleAuthCallback without a pending browser login.
  githubAuthService.onIdentified((user) => {
    console.log(`[BuildersHQ] Website-initiated identification: @${user.githubLogin}`);
    vscode.window.showInformationMessage(
      `BuildersHQ: You've been identified as @${user.githubLogin}`,
    );
    startTracking(context);
    heartbeatService!.forceHeartbeat('activate');
    updateStatusBar(context);
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
    gitBranchWatcher?.stop();
    githubPrWatcher?.stop();
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
      if (gitBranchWatcher) {
        gitBranchWatcher.start();
      }
      if (githubPrWatcher) {
        githubPrWatcher.start();
      }
      roomWatcher?.start();
    }
    updateStatusBar(context);
  });

  const loginCmd = vscode.commands.registerCommand('buildershq.loginWithGitHub', async () => {
    console.log('[BuildersHQ] Login command invoked - trying VS Code auth first');
    try {
      // Primary: VS Code built-in GitHub auth + device flow fallback
      const user = await githubAuthService!.login();
      if (user) {
        console.log(`[BuildersHQ] VS Code login succeeded: ${user.githubLogin}`);
        vscode.window.showInformationMessage(`BuildersHQ: Logged in as ${user.githubLogin}`);
        // Tracking is already running — just ensure it's started and force a heartbeat
        // so the server immediately sees the identified user for this computerName.
        startTracking(context);
        heartbeatService!.forceHeartbeat('activate');
        updateStatusBar(context);
        return;
      }

      // Fallback: browser-based login
      console.log('[BuildersHQ] VS Code login did not complete - falling back to browser auth');
      const fallbackUser = await githubAuthService!.loginViaBrowser(serverBaseUrl);
      if (fallbackUser) {
        console.log(`[BuildersHQ] Fallback login succeeded: ${fallbackUser.githubLogin}`);
        vscode.window.showInformationMessage(`BuildersHQ: Logged in as ${fallbackUser.githubLogin}`);
        startTracking(context);
        heartbeatService!.forceHeartbeat('activate');
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
        const newRuntime = loadRuntimeConfig(isDev);
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

      // Handle GitHub PR tracking enabled/disabled toggle
      if (e.affectsConfiguration('buildershq.githubPr')) {
        handleGithubPrConfigChange(context);
      }
    }
  });

  // Start presence tracker always (needed for status tracking)
  presenceTracker.start();

  // Always start tracking — anonymous heartbeats use computerName as the
  // machine identifier.  When the user later logs in (from the extension or
  // the BuildersHQ website on the same machine) the server can retroactively
  // associate these events with the authenticated GitHub identity.
  if (githubAuthService.isAuthenticated() && !githubAuthService.getBuildersHQAccessToken()) {
    // Has GitHub token but no BuildersHQ JWT — try to exchange
    console.log('[BuildersHQ] Has GitHub auth but no API token — exchanging');
    await githubAuthService.exchangeForBuildersHQToken(serverBaseUrl);
  }

  // Start tracking regardless of auth state
  console.log('[BuildersHQ] Starting tracking (anonymous mode supported)');
  startTracking(context);

  // Only suggest login when we have no GitHub identity at all.
  // If restoreSession() silently picked up a VS Code GitHub session, the
  // user profile is already included in heartbeats alongside machineToken —
  // no need to nag them.
  if (!githubAuthService.isAuthenticated()) {
    suggestLogin();
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

  // Git branch activity tracking
  initGitBranchTracking(context, isPaused);

  // GitHub PR activity tracking
  initGithubPrTracking(context, isPaused);

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
  gitBranchWatcher?.stop();
  githubPrWatcher?.stop();
  roomWatcher?.stop();
}

function suggestLogin(): void {
  console.log('[BuildersHQ] suggestLogin() — showing non-blocking login suggestion');
  // Non-intrusive notification — tracking is already running in anonymous mode
  vscode.window.showInformationMessage(
    'BuildersHQ is tracking your activity. Log in with GitHub to claim your events.',
    'Login with GitHub',
    'Later',
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
    console.log(`[BuildersHQ][Extension] Commit event callback fired: ${event.shortHash} "${event.subject}" on ${event.branch ?? 'detached'}`);
    if (context.globalState.get<boolean>(PAUSE_STATE_KEY, false)) {
      console.log(`[BuildersHQ][Extension] Commit event SKIPPED (paused)`);
      return;
    }
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

function initGitBranchTracking(
  context: vscode.ExtensionContext,
  isPaused: boolean,
): void {
  const config = vscode.workspace.getConfiguration('buildershq');
  if (!config.get<boolean>('gitCommits.enabled', true)) {
    return;
  }

  gitBranchWatcher = new GitBranchWatcher();

  gitBranchWatcher.onBranchEvent((event) => {
    console.log(`[BuildersHQ][Extension] Branch event callback fired: ${event.eventType} ${event.branchName}`);
    if (context.globalState.get<boolean>(PAUSE_STATE_KEY, false)) {
      console.log(`[BuildersHQ][Extension] Branch event SKIPPED (paused)`);
      return;
    }
    const label = event.eventType === 'branch_created' ? 'Created branch' : 'Deleted branch';
    heartbeatService!.setActivity({
      timestamp: event.timestamp,
      claudeSessionId: `git:branch:${event.branchName}`,
      activityType: event.eventType,
      tool: null,
      filePath: null,
      command: null,
      summary: `${label}: ${event.branchName}`,
      gitBranch: event.branchName,
    }, 'git');
    presenceTracker!.recordExternalActivity('task_start', false);
    heartbeatService!.flushActivity();
  });

  if (!isPaused) {
    console.log(`[BuildersHQ][Extension] Starting gitBranchWatcher`);
    gitBranchWatcher.start();
  } else {
    console.log(`[BuildersHQ][Extension] gitBranchWatcher NOT started (paused)`);
  }

  context.subscriptions.push(gitBranchWatcher);
}

function initGithubPrTracking(
  context: vscode.ExtensionContext,
  isPaused: boolean,
): void {
  const config = vscode.workspace.getConfiguration('buildershq');
  if (!config.get<boolean>('githubPr.enabled', true)) {
    return;
  }

  githubPrWatcher = new GitHubPrWatcher();

  githubPrWatcher.onPrEvent((event) => {
    console.log(`[BuildersHQ][Extension] PR event callback fired: ${event.eventType} #${event.prNumber} "${event.prTitle}"`);
    if (context.globalState.get<boolean>(PAUSE_STATE_KEY, false)) {
      console.log(`[BuildersHQ][Extension] PR event SKIPPED (paused)`);
      return;
    }
    const labelMap: Record<string, string> = { pr_opened: 'Opened', pr_merged: 'Merged', pr_closed: 'Closed' };
    const label = labelMap[event.eventType] ?? event.eventType;
    heartbeatService!.setActivity({
      timestamp: event.timestamp,
      claudeSessionId: `github:pr:${event.prNumber}`,
      activityType: event.eventType,
      tool: null,
      filePath: null,
      command: null,
      summary: `${label} PR #${event.prNumber}: ${event.prTitle}`,
      gitBranch: event.branch ?? undefined,
    }, 'github');
    presenceTracker!.recordExternalActivity('task_start', false);
    heartbeatService!.flushActivity();
  });

  if (!isPaused) {
    console.log(`[BuildersHQ][Extension] Starting githubPrWatcher`);
    githubPrWatcher.start();
  } else {
    console.log(`[BuildersHQ][Extension] githubPrWatcher NOT started (paused)`);
  }

  context.subscriptions.push(githubPrWatcher);
}

function handleGithubPrConfigChange(
  context: vscode.ExtensionContext,
): void {
  const config = vscode.workspace.getConfiguration('buildershq');
  const enabled = config.get<boolean>('githubPr.enabled', true);
  const isPaused = context.globalState.get<boolean>(PAUSE_STATE_KEY, false);

  if (enabled && !githubPrWatcher) {
    initGithubPrTracking(context, isPaused);
  } else if (!enabled && githubPrWatcher) {
    githubPrWatcher.dispose();
    githubPrWatcher = undefined;
  }
}

function getHeartbeatUser(): HeartbeatUser | undefined {
  const user = githubAuthService?.getUserProfile();
  // Skip placeholder profiles (githubUserId 0) created during browser-flow
  // restore — the server requires a positive integer.
  if (!user || !user.githubUserId) {
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
  statusBarManager.update(status, paused, connected, authenticated, trackingStarted, claudeActive, codexActive, opencodeActive, geminiActive, aiderActive);
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
  gitBranchWatcher?.dispose();
  githubPrWatcher?.dispose();
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
  gitBranchWatcher = undefined;
  githubPrWatcher = undefined;
  githubAuthService = undefined;
  mongoStore = undefined;
  roomWatcher = undefined;
  trackingStarted = false;
}
