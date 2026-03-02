import * as vscode from 'vscode';
import { MongoStore } from './mongoStore';
import { RuntimeConfig } from './env';

const ACCESS_TOKEN_SECRET_KEY = 'buildershq.github.accessToken';
const BUILDERSHQ_ACCESS_TOKEN_KEY = 'buildershq.api.accessToken';
const BUILDERSHQ_REFRESH_TOKEN_KEY = 'buildershq.api.refreshToken';
const MACHINE_TOKEN_KEY = 'buildershq.machineToken';
const LOGIN_SCOPES = 'read:user user:email';
const VSCODE_GITHUB_PROVIDER = 'github';
const VSCODE_GITHUB_SCOPES = ['read:user', 'user:email'];

type DeviceCodeResponse = {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete?: string;
  expires_in: number;
  interval: number;
};

type DeviceTokenResponse = {
  access_token?: string;
  scope?: string;
  error?: string;
  error_description?: string;
};

type GitHubUserApiResponse = {
  id: number;
  login: string;
  name: string | null;
  email: string | null;
  avatar_url: string | null;
};

type GitHubEmailApiResponse = {
  email: string;
  primary: boolean;
  verified: boolean;
};

export interface GitHubUserProfile {
  githubUserId: number;
  githubLogin: string;
  name: string | null;
  email: string | null;
  avatarUrl: string | null;
}

export interface GitHubAuthState {
  user: GitHubUserProfile;
  accessToken: string;
  scopes: string[];
}

type TokenExchangeResponse = {
  ok: boolean;
  accessToken?: string;
  refreshToken?: string;
  expiresIn?: number;
  user?: {
    githubUserId: number;
    githubLogin: string;
    name: string | null;
    email: string | null;
    avatarUrl: string | null;
  };
  error?: string;
};

export interface ClaimToken {
  accessToken: string;
  refreshToken: string;
  user: {
    githubUserId: number;
    githubLogin: string;
    name: string | null;
    email: string | null;
    avatarUrl: string | null;
  };
}

export class GitHubAuthService implements vscode.Disposable {
  private authState: GitHubAuthState | undefined;
  private buildershqAccessToken: string | undefined;
  private machineToken: string | undefined;
  private readonly disposables: vscode.Disposable[] = [];
  private pendingBrowserLogin: {
    resolve: (profile: GitHubUserProfile | undefined) => void;
    timeoutId: ReturnType<typeof setTimeout>;
  } | undefined;
  private onIdentifiedCallback: ((user: GitHubUserProfile) => void) | undefined;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly getConfig: () => RuntimeConfig,
    private readonly mongoStore?: MongoStore,
  ) {}

  onIdentified(callback: (user: GitHubUserProfile) => void): void {
    this.onIdentifiedCallback = callback;
  }

  getUserProfile(): GitHubUserProfile | undefined {
    return this.authState?.user;
  }

  isAuthenticated(): boolean {
    return Boolean(this.authState);
  }

  getBuildersHQAccessToken(): string | undefined {
    return this.buildershqAccessToken;
  }

  isFullyAuthenticated(): boolean {
    return Boolean(this.authState) && Boolean(this.buildershqAccessToken);
  }

  /** Returns a persistent random token that identifies this machine. */
  getMachineToken(): string | undefined {
    return this.machineToken;
  }

  /** Restore or generate the machineToken (call once during activation). */
  async initMachineToken(): Promise<string> {
    const stored = await this.context.secrets.get(MACHINE_TOKEN_KEY);
    if (stored) {
      this.machineToken = stored;
      return stored;
    }
    // Generate a new random token and persist it.
    // crypto.randomUUID() is available in Node 19+ and VS Code's Electron.
    const token = (await import('crypto')).randomUUID();
    await this.context.secrets.store(MACHINE_TOKEN_KEY, token);
    this.machineToken = token;
    console.log('[BuildersHQ Auth] Generated new machineToken');
    return token;
  }

  /**
   * Accept a claim token delivered via heartbeat response.
   * Returns true if the claim was accepted (extension was anonymous).
   */
  async acceptClaimToken(claim: ClaimToken): Promise<boolean> {
    if (this.isFullyAuthenticated()) {
      console.log('[BuildersHQ Auth] acceptClaimToken() — already authenticated, ignoring');
      return false;
    }

    console.log(`[BuildersHQ Auth] acceptClaimToken() — claiming as @${claim.user.githubLogin}`);

    this.buildershqAccessToken = claim.accessToken;
    await this.context.secrets.store(BUILDERSHQ_ACCESS_TOKEN_KEY, claim.accessToken);
    await this.context.secrets.store(BUILDERSHQ_REFRESH_TOKEN_KEY, claim.refreshToken);

    this.authState = {
      user: {
        githubUserId: claim.user.githubUserId,
        githubLogin: claim.user.githubLogin,
        name: claim.user.name,
        email: claim.user.email,
        avatarUrl: claim.user.avatarUrl,
      },
      accessToken: '',
      scopes: [],
    };

    await this.mongoStore?.upsertUser(this.authState.user);
    console.log(`[BuildersHQ Auth] acceptClaimToken() complete: user=${claim.user.githubLogin}`);
    return true;
  }

  async restoreSession(): Promise<void> {
    console.log('[BuildersHQ Auth] restoreSession() — checking for existing GitHub session');
    // Prefer the account already connected in VS Code.
    const vscodeSession = await this.getVsCodeSession({ createIfNone: false, silent: true });
    if (vscodeSession) {
      console.log('[BuildersHQ Auth] Found VS Code GitHub session, setting auth state');
      try {
        await this.setAuthState(vscodeSession.accessToken, vscodeSession.scopes);
        // Restore BuildersHQ token from SecretStorage
        this.buildershqAccessToken = await this.context.secrets.get(BUILDERSHQ_ACCESS_TOKEN_KEY);
        console.log(`[BuildersHQ Auth] Session restored: user=${this.authState?.user.githubLogin}, hasApiToken=${Boolean(this.buildershqAccessToken)}`);
        return;
      } catch (err) {
        console.log(`[BuildersHQ Auth] Failed to set auth state from VS Code session: ${err instanceof Error ? err.message : String(err)}`);
        this.authState = undefined;
      }
    } else {
      console.log('[BuildersHQ Auth] No VS Code GitHub session found');
    }

    // Fallback to extension-stored token (device flow path).
    const token = await this.context.secrets.get(ACCESS_TOKEN_SECRET_KEY);
    if (token) {
      console.log('[BuildersHQ Auth] Found stored device-flow token, setting auth state');
      try {
        await this.setAuthState(token, []);
        // Restore BuildersHQ token from SecretStorage
        this.buildershqAccessToken = await this.context.secrets.get(BUILDERSHQ_ACCESS_TOKEN_KEY);
        console.log(`[BuildersHQ Auth] Device-flow session restored: user=${this.authState?.user.githubLogin}, hasApiToken=${Boolean(this.buildershqAccessToken)}`);
        return;
      } catch (err) {
        console.log(`[BuildersHQ Auth] Device-flow token invalid: ${err instanceof Error ? err.message : String(err)}`);
        await this.context.secrets.delete(ACCESS_TOKEN_SECRET_KEY);
        this.authState = undefined;
      }
    }

    // Fallback: restore from BuildersHQ tokens only (browser-flow path).
    // The browser flow doesn't give us a GitHub access token, so we only have
    // the BuildersHQ JWT. We can't call setAuthState (no GitHub token) but we
    // can still be "authenticated" if we have a valid API token.
    this.buildershqAccessToken = await this.context.secrets.get(BUILDERSHQ_ACCESS_TOKEN_KEY);
    if (this.buildershqAccessToken) {
      console.log('[BuildersHQ Auth] Found stored BuildersHQ API token (browser-flow user) — restoring minimal auth state');
      // We don't have a user profile cached locally — set a minimal placeholder.
      // The server has the real profile; for display we use what the JWT gave us.
      // On next token refresh we could update this, but for now it's sufficient.
      this.authState = {
        user: {
          githubUserId: 0,
          githubLogin: 'authenticated',
          name: null,
          email: null,
          avatarUrl: null,
        },
        accessToken: '',
        scopes: [],
      };
      return;
    }

    console.log('[BuildersHQ Auth] No stored tokens — user is not authenticated');
  }

  async exchangeForBuildersHQToken(serverBaseUrl: string): Promise<boolean> {
    if (!this.authState) {
      console.log('[BuildersHQ Auth] exchangeForBuildersHQToken() — no auth state, skipping');
      return false;
    }

    console.log(`[BuildersHQ Auth] exchangeForBuildersHQToken() — POSTing to ${serverBaseUrl}/api/auth/token/exchange`);
    try {
      const res = await fetch(`${serverBaseUrl}/api/auth/token/exchange`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ githubAccessToken: this.authState.accessToken }),
      });

      if (!res.ok) {
        const body = await res.text().catch(() => '');
        console.log(`[BuildersHQ Auth] Token exchange failed: HTTP ${res.status} — ${body}`);
        return false;
      }

      const json = (await res.json()) as TokenExchangeResponse;
      if (!json.ok || !json.accessToken || !json.refreshToken) {
        return false;
      }

      this.buildershqAccessToken = json.accessToken;
      await this.context.secrets.store(BUILDERSHQ_ACCESS_TOKEN_KEY, json.accessToken);
      await this.context.secrets.store(BUILDERSHQ_REFRESH_TOKEN_KEY, json.refreshToken);

      console.log('[BuildersHQ] Token exchange successful');
      return true;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.log(`[BuildersHQ] Token exchange error: ${msg}`);
      return false;
    }
  }

  async refreshBuildersHQToken(serverBaseUrl: string): Promise<boolean> {
    const refreshToken = await this.context.secrets.get(BUILDERSHQ_REFRESH_TOKEN_KEY);
    if (!refreshToken) {
      console.log('[BuildersHQ Auth] refreshBuildersHQToken() — no refresh token stored, skipping');
      return false;
    }
    console.log(`[BuildersHQ Auth] refreshBuildersHQToken() — POSTing to ${serverBaseUrl}/api/auth/token/refresh`);

    try {
      const res = await fetch(`${serverBaseUrl}/api/auth/token/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken }),
      });

      if (!res.ok) {
        console.log(`[BuildersHQ] Token refresh failed: ${res.status}`);
        return false;
      }

      const json = (await res.json()) as TokenExchangeResponse;
      if (!json.ok || !json.accessToken || !json.refreshToken) {
        return false;
      }

      this.buildershqAccessToken = json.accessToken;
      await this.context.secrets.store(BUILDERSHQ_ACCESS_TOKEN_KEY, json.accessToken);
      await this.context.secrets.store(BUILDERSHQ_REFRESH_TOKEN_KEY, json.refreshToken);

      console.log('[BuildersHQ] Token refresh successful');
      return true;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.log(`[BuildersHQ] Token refresh error: ${msg}`);
      return false;
    }
  }

  async login(): Promise<GitHubUserProfile | undefined> {
    console.log('[BuildersHQ Auth] login() — starting GitHub login flow');
    // First choice: use VS Code's built-in GitHub auth account/session.
    const vscodeSession = await this.getVsCodeSession({ createIfNone: true });
    if (vscodeSession) {
      console.log('[BuildersHQ Auth] Got VS Code GitHub session via createIfNone');
      await this.setAuthState(vscodeSession.accessToken, vscodeSession.scopes);
      await this.context.secrets.delete(ACCESS_TOKEN_SECRET_KEY);
      console.log(`[BuildersHQ Auth] login() complete: user=${this.authState?.user.githubLogin}`);
      return this.authState?.user;
    }
    console.log('[BuildersHQ Auth] VS Code GitHub session unavailable, falling back to device flow');

    // Fallback: explicit device flow using shared .env values.
    const config = this.getConfig();
    if (!config.githubClientId) {
      vscode.window.showErrorMessage(
        `BuildersHQ login failed: missing GITHUB_CLIENT_ID in ${config.envPath}`,
      );
      return undefined;
    }

    const deviceCode = await this.requestDeviceCode(config.githubClientId);
    const openUrl = deviceCode.verification_uri_complete ?? deviceCode.verification_uri;

    const action = await vscode.window.showInformationMessage(
      `GitHub login code: ${deviceCode.user_code}`,
      'Open GitHub Verification',
      'Cancel',
    );
    if (action !== 'Open GitHub Verification') {
      return undefined;
    }

    await vscode.env.openExternal(vscode.Uri.parse(openUrl));

    const authResult = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: 'BuildersHQ: Waiting for GitHub authorization...',
        cancellable: true,
      },
      async (_progress, token) => {
        return this.pollForAccessToken(
          config.githubClientId,
          config.githubClientSecret,
          deviceCode,
          () => token.isCancellationRequested,
        );
      },
    );

    await this.context.secrets.store(ACCESS_TOKEN_SECRET_KEY, authResult.accessToken);
    await this.setAuthState(authResult.accessToken, authResult.scopes);
    return this.authState?.user;
  }

  async logout(): Promise<void> {
    console.log('[BuildersHQ Auth] logout() — clearing all stored tokens and auth state');
    await this.context.secrets.delete(ACCESS_TOKEN_SECRET_KEY);
    await this.context.secrets.delete(BUILDERSHQ_ACCESS_TOKEN_KEY);
    await this.context.secrets.delete(BUILDERSHQ_REFRESH_TOKEN_KEY);
    await this.clearVsCodeSessionPreference();
    this.authState = undefined;
    this.buildershqAccessToken = undefined;
    console.log('[BuildersHQ Auth] logout() complete');
  }

  registerUriHandler(serverBaseUrl: string): vscode.Disposable {
    return vscode.window.registerUriHandler({
      handleUri: async (uri: vscode.Uri) => {
        console.log(`[BuildersHQ Auth] URI handler invoked: ${uri.path}`);
        if (uri.path === '/auth-callback') {
          await this.handleAuthCallback(uri, serverBaseUrl);
        }
      },
    });
  }

  async loginViaBrowser(serverBaseUrl: string): Promise<GitHubUserProfile | undefined> {
    const scheme = vscode.env.uriScheme;
    const loginUrl = `${serverBaseUrl}/api/auth/github/start-vscode?scheme=${encodeURIComponent(scheme)}`;

    console.log(`[BuildersHQ Auth] loginViaBrowser() — opening ${loginUrl}`);
    await vscode.env.openExternal(vscode.Uri.parse(loginUrl));

    return new Promise<GitHubUserProfile | undefined>((resolve) => {
      // Cancel any previous pending login
      if (this.pendingBrowserLogin) {
        clearTimeout(this.pendingBrowserLogin.timeoutId);
        this.pendingBrowserLogin.resolve(undefined);
      }

      const timeoutId = setTimeout(() => {
        console.log('[BuildersHQ Auth] Browser login timed out (5 min)');
        this.pendingBrowserLogin = undefined;
        resolve(undefined);
      }, 5 * 60 * 1000);

      this.pendingBrowserLogin = { resolve, timeoutId };
    });
  }

  private async handleAuthCallback(uri: vscode.Uri, serverBaseUrl: string): Promise<void> {
    const params = new URLSearchParams(uri.query);
    const code = params.get('code');

    if (!code) {
      console.log('[BuildersHQ Auth] auth-callback missing code parameter');
      vscode.window.showErrorMessage('BuildersHQ: Login callback missing authorization code.');
      this.pendingBrowserLogin?.resolve(undefined);
      this.pendingBrowserLogin = undefined;
      return;
    }

    console.log(`[BuildersHQ Auth] Redeeming auth code via ${serverBaseUrl}/api/auth/vscode/redeem`);
    try {
      const res = await fetch(`${serverBaseUrl}/api/auth/vscode/redeem`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code }),
      });

      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`Redeem failed: HTTP ${res.status} — ${body}`);
      }

      const json = (await res.json()) as TokenExchangeResponse;
      if (!json.ok || !json.accessToken || !json.refreshToken || !json.user) {
        throw new Error(json.error || 'Invalid redeem response');
      }

      // Store BuildersHQ tokens
      this.buildershqAccessToken = json.accessToken;
      await this.context.secrets.store(BUILDERSHQ_ACCESS_TOKEN_KEY, json.accessToken);
      await this.context.secrets.store(BUILDERSHQ_REFRESH_TOKEN_KEY, json.refreshToken);

      // Set auth state from the server-provided user profile
      // (no GitHub access token needed in the browser flow)
      this.authState = {
        user: json.user,
        accessToken: '',
        scopes: [],
      };

      await this.mongoStore?.upsertUser(json.user);

      console.log(`[BuildersHQ Auth] Browser login complete: user=${json.user.githubLogin}`);

      // Resolve the pending login promise, or fire the identified callback
      // for website-initiated logins (no pending promise).
      if (this.pendingBrowserLogin) {
        clearTimeout(this.pendingBrowserLogin.timeoutId);
        this.pendingBrowserLogin.resolve(json.user);
        this.pendingBrowserLogin = undefined;
      } else {
        // Website-initiated: user logged in on buildershq.net and clicked
        // "Connect VS Code" — no promise to resolve, notify via callback.
        this.onIdentifiedCallback?.(json.user);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`[BuildersHQ Auth] Browser login callback error: ${msg}`);
      vscode.window.showErrorMessage(`BuildersHQ login failed: ${msg}`);
      if (this.pendingBrowserLogin) {
        clearTimeout(this.pendingBrowserLogin.timeoutId);
        this.pendingBrowserLogin.resolve(undefined);
        this.pendingBrowserLogin = undefined;
      }
    }
  }

  dispose(): void {
    if (this.pendingBrowserLogin) {
      clearTimeout(this.pendingBrowserLogin.timeoutId);
      this.pendingBrowserLogin = undefined;
    }
    this.disposables.forEach((d) => d.dispose());
    this.disposables.length = 0;
  }

  private async requestDeviceCode(clientId: string): Promise<DeviceCodeResponse> {
    const body = new URLSearchParams({
      client_id: clientId,
      scope: LOGIN_SCOPES,
    });

    const response = await fetch('https://github.com/login/device/code', {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body,
    });

    const json = (await response.json()) as DeviceCodeResponse & {
      error?: string;
      error_description?: string;
    };

    if (!response.ok || json.error) {
      throw new Error(json.error_description ?? json.error ?? 'Failed to request GitHub device code.');
    }

    return json;
  }

  private async pollForAccessToken(
    clientId: string,
    clientSecret: string,
    deviceCode: DeviceCodeResponse,
    isCancelled: () => boolean,
  ): Promise<{ accessToken: string; scopes: string[] }> {
    const expiresAt = Date.now() + deviceCode.expires_in * 1000;
    let intervalMs = Math.max(deviceCode.interval, 1) * 1000;

    while (Date.now() < expiresAt) {
      if (isCancelled()) {
        throw new Error('Login cancelled.');
      }

      await sleep(intervalMs);

      const body = new URLSearchParams({
        client_id: clientId,
        device_code: deviceCode.device_code,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      });

      if (clientSecret) {
        body.set('client_secret', clientSecret);
      }

      const response = await fetch('https://github.com/login/oauth/access_token', {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body,
      });

      const json = (await response.json()) as DeviceTokenResponse;

      if (json.access_token) {
        const scopes = (json.scope ?? '')
          .split(/[, ]+/)
          .map((scope) => scope.trim())
          .filter(Boolean);

        return {
          accessToken: json.access_token,
          scopes,
        };
      }

      if (!json.error) {
        throw new Error('GitHub login failed without an explicit error.');
      }

      if (json.error === 'authorization_pending') {
        continue;
      }

      if (json.error === 'slow_down') {
        intervalMs += 5_000;
        continue;
      }

      if (json.error === 'expired_token') {
        throw new Error('GitHub device code expired.');
      }

      if (json.error === 'access_denied') {
        throw new Error('GitHub authorization was denied.');
      }

      throw new Error(json.error_description ?? json.error);
    }

    throw new Error('GitHub login timed out.');
  }

  private async fetchGitHubUser(accessToken: string): Promise<GitHubUserProfile> {
    const response = await fetch('https://api.github.com/user', {
      headers: this.githubHeaders(accessToken),
    });

    if (!response.ok) {
      throw new Error(`GitHub user fetch failed (${response.status}).`);
    }

    const json = (await response.json()) as GitHubUserApiResponse;
    const email = json.email ?? await this.fetchPrimaryEmail(accessToken);

    return {
      githubUserId: json.id,
      githubLogin: json.login,
      name: json.name ?? null,
      email,
      avatarUrl: json.avatar_url ?? null,
    };
  }

  private async fetchPrimaryEmail(accessToken: string): Promise<string | null> {
    const response = await fetch('https://api.github.com/user/emails', {
      headers: this.githubHeaders(accessToken),
    });

    if (!response.ok) {
      return null;
    }

    const emails = (await response.json()) as GitHubEmailApiResponse[];
    const primary = emails.find((email) => email.primary && email.verified);
    return primary?.email ?? null;
  }

  private githubHeaders(accessToken: string): Record<string, string> {
    return {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${accessToken}`,
      'User-Agent': 'buildershq-vscode',
    };
  }

  private async setAuthState(accessToken: string, scopes: readonly string[]): Promise<void> {
    const user = await this.fetchGitHubUser(accessToken);
    this.authState = {
      user,
      accessToken,
      scopes: Array.from(scopes),
    };
    await this.mongoStore?.upsertUser(user);
  }

  private async getVsCodeSession(
    options: vscode.AuthenticationGetSessionOptions,
  ): Promise<vscode.AuthenticationSession | undefined> {
    try {
      return await vscode.authentication.getSession(
        VSCODE_GITHUB_PROVIDER,
        VSCODE_GITHUB_SCOPES,
        options,
      );
    } catch (error) {
      if (this.isMissingProviderError(error)) {
        return undefined;
      }

      if (this.isCancellationError(error)) {
        return undefined;
      }

      throw error;
    }
  }

  private async clearVsCodeSessionPreference(): Promise<void> {
    try {
      await vscode.authentication.getSession(
        VSCODE_GITHUB_PROVIDER,
        VSCODE_GITHUB_SCOPES,
        { createIfNone: false, clearSessionPreference: true },
      );
    } catch {
      // Best effort only.
    }
  }

  private isMissingProviderError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return message.toLowerCase().includes('no authentication provider');
  }

  private isCancellationError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return message.toLowerCase().includes('cancel');
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
