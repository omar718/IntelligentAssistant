import * as vscode from "vscode";
import { AxiosInstance } from "axios";

interface CachedProject {
  id: string;
  name: string;
  status: string;
  type: string | null;
  port: number | null;
}

const STATUS_ICONS: Record<string, string> = {
  running: "$(play-circle)",
  installing: "$(sync~spin)",
  stopped: "$(stop-circle)",
  failed: "$(error)",
  analyzing: "$(search)",
  queued: "$(clock)",
};

export class ProjectItem extends vscode.TreeItem {
  constructor(public readonly project: CachedProject) {
    super(project.name, vscode.TreeItemCollapsibleState.None);

    const icon = STATUS_ICONS[project.status] ?? "$(circle-outline)";
    this.label = `${icon} ${project.name}`;
    this.description = project.status;
    this.tooltip = [
      `Status: ${project.status}`,
      project.type ? `Type: ${project.type}` : null,
      project.port ? `Port: ${project.port}` : null,
    ]
      .filter(Boolean)
      .join("\n");

    this.contextValue = `project-${project.status}`;
  }
}

export class ProjectsTreeProvider implements vscode.TreeDataProvider<ProjectItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<ProjectItem | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private projects: CachedProject[] = [];
  private readonly CACHE_KEY = "projects.cache";

  constructor(private readonly context: vscode.ExtensionContext) {}

  getTreeItem(element: ProjectItem): vscode.TreeItem {
    return element;
  }

  getChildren(): ProjectItem[] {
    return this.projects.map((p) => new ProjectItem(p));
  }

  // ---------------------------------------------------------------------------
  // Load from API (online)
  // ---------------------------------------------------------------------------

  async loadFromApi(apiClient: AxiosInstance): Promise<void> {
    try {
      const { data } = await apiClient.get<{ items: CachedProject[] }>(
        "/api/users/me/projects",
        { params: { per_page: 50 } }
      );
      this.projects = data.items;
      // Persist non-sensitive fields for offline use
      await this.context.globalState.update(this.CACHE_KEY, this.projects);
      this._onDidChangeTreeData.fire(undefined);
    } catch (err: any) {
      if (err?.response?.status === 401) {
        this.projects = [];
        this._onDidChangeTreeData.fire(undefined);
        return;
      }
      console.error("[ProjectsTreeProvider] Failed to load projects:", err);
    }
  }

  // ---------------------------------------------------------------------------
  // Load from cache (offline)
  // ---------------------------------------------------------------------------

  loadFromCache(): void {
    const cached = this.context.globalState.get<CachedProject[]>(this.CACHE_KEY, []);
    this.projects = cached;
    this._onDidChangeTreeData.fire(undefined);
  }

  async clearProjects(clearCache: boolean = true): Promise<void> {
    this.projects = [];

    if (clearCache) {
      await this.context.globalState.update(this.CACHE_KEY, []);
    }

    this._onDidChangeTreeData.fire(undefined);
  }

  // ---------------------------------------------------------------------------
  // Real-time update from WebSocket (update single item in-place)
  // ---------------------------------------------------------------------------

  updateProjectStatus(projectId: string, newStatus: string): void {
    const project = this.projects.find((p) => p.id === projectId);
    if (project) {
      project.status = newStatus;
      this._onDidChangeTreeData.fire(undefined);
    }
  }
}