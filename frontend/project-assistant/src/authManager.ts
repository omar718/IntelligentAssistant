import * as vscode from "vscode";
import axios, { AxiosInstance } from "axios";

const TOKEN_KEY = "auth.token";
const HEALTH_POLL_INTERVAL_MS = 30_000;

/**
 * AuthManager handles all authentication concerns for the VS Code extension.
 *
 * Security requirements (§3.3):
 *  - JWT stored in context.secrets (OS keychain) — NEVER in settings.json
 *  - Anthropic API key: never in the extension; all Claude calls go through the backend
 *  - Auto-reconnect: poll /health every 30s when backend is offline
 */
export class AuthManager {
  private token: string | undefined;
  private apiClient: AxiosInstance;
  private healthPollTimer: NodeJS.Timeout | undefined;
  private isOnline = false;
  private isSessionVerified = false;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly statusBar: vscode.StatusBarItem,
    private readonly onOnline: () => void,
    private readonly onOffline: () => void
  ) {
    const apiUrl =
      vscode.workspace.getConfiguration("projectAssistant").get<string>("apiUrl") ??
      "http://localhost:8000";

    this.apiClient = axios.create({
      baseURL: apiUrl,
      withCredentials: true,
      timeout: 5_000,
    });

    // Inject Bearer token on every request
    this.apiClient.interceptors.request.use((config) => {
      if (this.token) {
        config.headers["Authorization"] = `Bearer ${this.token}`;
      }
      return config;
    });

    // 401 → clear token, show "session expired"
    this.apiClient.interceptors.response.use(
      (res) => res,
      async (error) => {
        if (error.response?.status === 401) {
          await this.clearToken();
          await this.setAuthContext(false);
          this.showSessionExpired();
        }
        return Promise.reject(error);
      }
    );
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  async activate(): Promise<void> {
    // Restore token from secure storage
    this.token = await this.context.secrets.get(TOKEN_KEY);
    await this.setAuthContext(false);

    // Check backend availability with 2-second timeout
    const online = await this.checkHealth();

    if (online) {
      if (this.token) {
        const valid = await this.validateStoredToken();
        if (!valid) {
          await this.clearToken();
        }
      }

      this.isOnline = true;
      this.onOnline();
    } else {
      this.isOnline = false;
      this.showOffline();
      this.startHealthPolling();
    }
  }

  deactivate(): void {
    this.stopHealthPolling();
  }

  // ---------------------------------------------------------------------------
  // Authentication
  // ---------------------------------------------------------------------------

  async login(email: string, password: string): Promise<void> {
    const response = await this.apiClient.post<{
      access_token: string;
      user: { id: string; email: string; role: string };
    }>("/auth/login", { email, password });

    const { access_token } = response.data;
    await this.storeToken(access_token);
    this.isSessionVerified = true;
    await this.setAuthContext(true);
    vscode.window.showInformationMessage(`Signed in as ${response.data.user.email}`);
  }

  async logout(): Promise<void> {
    let logoutError: unknown;
    try {
      await this.apiClient.post("/auth/logout");
    } catch (error) {
      logoutError = error;
    } finally {
      await this.clearToken();
      await this.setAuthContext(false);
      this.statusBar.text = "$(account) Sign in to Intelligent Assistant";
      this.statusBar.command = "project-assistant.login";
      this.statusBar.show();
    }

    if (axios.isAxiosError(logoutError)) {
      const status = logoutError.response?.status;
      if (!status || status === 401 || status === 403 || status === 404) {
        return;
      }
    }

    if (logoutError) {
      throw logoutError;
    }
  }

  isAuthenticated(): boolean {
    return !!this.token;
  }

  async hasStoredToken(): Promise<boolean> {
    const storedToken = await this.context.secrets.get(TOKEN_KEY);
    return !!storedToken;
  }

  getApiClient(): AxiosInstance {
    return this.apiClient;
  }

  // ---------------------------------------------------------------------------
  // Token storage (OS keychain via SecretStorage)
  // ---------------------------------------------------------------------------

  private async storeToken(token: string): Promise<void> {
    this.token = token;
    await this.context.secrets.store(TOKEN_KEY, token);
  }

  private async clearToken(): Promise<void> {
    this.token = undefined;
    this.isSessionVerified = false;
    await this.context.secrets.delete(TOKEN_KEY);
  }

  private async validateStoredToken(): Promise<boolean> {
    try {
      await this.apiClient.get("/api/users/me");
      this.isSessionVerified = true;
      await this.setAuthContext(true);
      return true;
    } catch {
      this.isSessionVerified = false;
      await this.setAuthContext(false);
      return false;
    }
  }

  private async setAuthContext(authenticated: boolean): Promise<void> {
    await vscode.commands.executeCommand(
      "setContext",
      "projectAssistant.authenticated",
      authenticated
    );
  }

  // ---------------------------------------------------------------------------
  // Health check & offline handling
  // ---------------------------------------------------------------------------

  async checkHealth(): Promise<boolean> {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 2_000);
      await this.apiClient.get("/health", {
        signal: controller.signal,
        validateStatus: () => true,
      });
      clearTimeout(timeout);
      return true;
    } catch {
      return false;
    }
  }

  private startHealthPolling(): void {
    this.stopHealthPolling();
    this.healthPollTimer = setInterval(async () => {
      const online = await this.checkHealth();
      if (online && !this.isOnline) {
        this.isOnline = true;
        this.stopHealthPolling();
        this.onOnline();
      }
    }, HEALTH_POLL_INTERVAL_MS);
  }

  private stopHealthPolling(): void {
    if (this.healthPollTimer) {
      clearInterval(this.healthPollTimer);
      this.healthPollTimer = undefined;
    }
  }

  // ---------------------------------------------------------------------------
  // Status bar messages
  // ---------------------------------------------------------------------------

  private showOffline(): void {
    this.onOffline();
    this.statusBar.text = "$(warning) Backend offline — Start server to continue";
    this.statusBar.tooltip = "Click to retry connection";
    this.statusBar.command = "project-assistant.retryConnection";
    this.statusBar.backgroundColor = new vscode.ThemeColor(
      "statusBarItem.warningBackground"
    );
    this.statusBar.show();
  }

  private showSessionExpired(): void {
    this.statusBar.text = "$(lock) Session expired — Click to sign in";
    this.statusBar.command = "project-assistant.login";
    this.statusBar.backgroundColor = new vscode.ThemeColor(
      "statusBarItem.warningBackground"
    );
    this.statusBar.show();

    vscode.window
      .showWarningMessage(
        "Your session has expired. Please sign in again.",
        "Sign In"
      )
      .then((action) => {
        if (action === "Sign In") {
          vscode.commands.executeCommand("project-assistant.login");
        }
      });
  }
}