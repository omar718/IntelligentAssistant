import * as cp from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import axios, { AxiosInstance } from 'axios';

export type TroubleshootMode = 'auto' | 'guided';

export interface InstallContext {
  projectId: string;
  hostPath: string;
  projectType: string;
  detectedPm: string;
  runCommand?: string;
  launchPort?: number;
  envVars?: Record<string, string>;
  versionConstraints?: Record<string, string>;
  troubleshootMode?: TroubleshootMode;
}

export interface RuntimeMissingInfo {
  tool: string;
  installUrl: string;
  projectType: string;
  message: string;
}

export type ConflictResolutionChoice =
  | 'docker'
  | 'manual'
  | { action: 'specifyFile'; value: string };

export interface ConflictResolutionInfo {
  component: string;
  projectType: string;
  message: string;
  installUrl?: string;
  allowFileInput?: boolean;
}

class DockerFallbackRequestedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DockerFallbackRequestedError';
  }
}

// ── Types ─────────────────────────────────────────────────────────────────────

interface ComposePortMapping {
  hostPort: number;
  containerPort: number;
  service: string;
}

interface PortRemapPlan {
  [service: string]: Array<{ hostPort: number; containerPort: number }>;
}

export class LocalInstaller {
  private proc: cp.ChildProcess | null = null;
  private cancelled = false;
  private lastLaunchPort: number | undefined;
  private mappedWebserverPort: number | null = null;
  private lastCommandOutput = '';
  private troubleshootMode: TroubleshootMode = 'guided';

  constructor(
    private readonly apiClient: AxiosInstance,
    private readonly publicApiClient: AxiosInstance,
    private readonly onLog: (msg: string, level?: string) => void,
    private readonly onRuntimeMissing?: (info: RuntimeMissingInfo) => Promise<void> | void,
    private readonly onConflictResolution?: (
      info: ConflictResolutionInfo,
    ) => Promise<ConflictResolutionChoice> | ConflictResolutionChoice,
    private readonly onDockerImagePullApproval?: (
      image: string,
    ) => Promise<boolean> | boolean,
  ) {}

  // ── Public API ───────────────────────────────────────────────────

  async install(ctx: InstallContext): Promise<boolean> {
    this.cancelled = false;
    this.lastLaunchPort = undefined;
    this.troubleshootMode = ctx.troubleshootMode ?? 'guided';

    try {
      await this.reportProgress(ctx.projectId, 10, 'Checking environment');
      const useVenv = await this.checkConflicts(ctx);

      await this.reportProgress(ctx.projectId, 30, 'Installing dependencies');
      const installOk = await this.runInstall(ctx, useVenv);
      if (!installOk) return false;

      await this.reportProgress(ctx.projectId, 80, 'Writing configuration');
      await this.writeEnvFile(ctx);

      await this.reportProgress(ctx.projectId, 90, 'Launching application');
      const port = await this.launch(ctx, useVenv);
      this.lastLaunchPort = port;

      await this.reportComplete(ctx.projectId, true, port);
      return true;

    } catch (err: any) {
      if (err instanceof DockerFallbackRequestedError) {
        try {
          this.onLog('[Docker] Conflict redirected to Docker fallback. Launching containerized project...');
          const dockerPort = await this.runDockerFallback(ctx);
          this.lastLaunchPort = dockerPort;
          await this.reportComplete(ctx.projectId, true, dockerPort);
          return true;
        } catch (dockerErr: any) {
          this.onLog(`[Error] Docker fallback failed: ${dockerErr?.message ?? dockerErr}`, 'error');
          await this.reportComplete(ctx.projectId, false, undefined, dockerErr?.message ?? 'Docker fallback failed');
          return false;
        }
      }

      this.onLog(`[Error] ${err?.message ?? err}`, 'error');
      await this.reportComplete(ctx.projectId, false, undefined, err?.message);
      return false;
    }
  }

  cancel(): void {
    this.cancelled = true;
    if (this.proc && !this.proc.killed) {
      this.proc.kill('SIGTERM');
    }
  }

  getLastLaunchPort(): number | undefined {
    return this.lastLaunchPort;
  }

  wasCancelled(): boolean {
    return this.cancelled;
  }

  // ── Private: conflict check ──────────────────────────────────────

  private async checkConflicts(ctx: InstallContext): Promise<boolean> {
    let useVenv = false;
    const requestedPort = ctx.launchPort ?? this.defaultPort(ctx.projectType);

    const toolChecks: Record<string, { cmd: string; install: string }> = {
      nodejs: { cmd: 'node', install: 'https://nodejs.org' },
      python: { cmd: 'python', install: 'https://python.org' },
      php: { cmd: 'php', install: 'https://php.net' },
      java: { cmd: 'java', install: 'https://adoptium.net' },
      ruby: { cmd: 'ruby', install: 'https://www.ruby-lang.org' },
      go: { cmd: 'go', install: 'https://go.dev' },
    };

    const toolCheck = toolChecks[ctx.projectType];
    if (toolCheck) {
      while (true) {
        const version = await this.getVersion(toolCheck.cmd, '--version');
        if (version) {
          this.onLog(`[Info] ${toolCheck.cmd} ${version} detected`);
          break;
        }

        const message =
          `${toolCheck.cmd} is not installed or not in PATH. Install it from ${toolCheck.install} then try again.`;
        const choice = await this.resolveConflict({
          component: toolCheck.cmd,
          projectType: ctx.projectType,
          message,
          installUrl: toolCheck.install,
        });

        if (choice === 'docker') {
          throw new DockerFallbackRequestedError(`User chose Docker for ${ctx.projectType}.`);
        }

        this.onLog(`[Info] Retrying ${toolCheck.cmd} check after user resolution...`);
      }
    }

    if (ctx.projectType === 'python') {
      const localVersion = await this.getVersion('python', '--version');
      const required = ctx.versionConstraints?.python;
      if (required && localVersion) {
        const localMajor = parseInt(localVersion.split('.')[0]);
        const reqMajor = parseInt(required.replace(/[^0-9.]/g, '').split('.')[0]);
        if (localMajor < reqMajor) {
          this.onLog(`[Warning] Python ${localVersion} found, ${required} required — using venv`);
          useVenv = true;
        }
      }
      useVenv = true;
    }

    if (ctx.projectType === 'nodejs') {
      await this.checkNodePmAvailable(ctx.hostPath);
    }

    if (ctx.projectType === 'java') {
      const mvnOrGradle = await this.resolveJavaBuildTool(ctx.hostPath);
      if (!mvnOrGradle) {
        const choice = await this.resolveConflict({
          component: 'mvn/gradle',
          projectType: ctx.projectType,
          message: 'Neither Maven (mvn) nor Gradle was found. Install one and retry.',
          installUrl: 'https://maven.apache.org',
        });

        if (choice === 'docker') {
          throw new DockerFallbackRequestedError('User chose Docker for java project.');
        }

        const retryTool = await this.resolveJavaBuildTool(ctx.hostPath);
        if (!retryTool) {
          throw new Error('Neither Maven (mvn) nor Gradle was found after retry.');
        }
      }
    }

    if (ctx.projectType === 'ruby') {
      const bundler = await this.commandExists('bundle');
      if (!bundler) {
        if (await this.commandExists('gem')) {
          this.onLog('[Info] bundler not found, installing...');
          const bundlerOk = await this.runCommand('gem install bundler', ctx.hostPath, ctx.projectId);
          if (!bundlerOk) {
            throw new Error('Failed to install bundler. Install Ruby bundler manually and try again.');
          }
        } else {
          const choice = await this.resolveConflict({
            component: 'bundler',
            projectType: ctx.projectType,
            message: 'bundler is not installed and gem is unavailable. Install Ruby Bundler and retry.',
            installUrl: 'https://bundler.io',
          });

          if (choice === 'docker') {
            throw new DockerFallbackRequestedError('User chose Docker for ruby project.');
          }

          if (!(await this.commandExists('bundle'))) {
            throw new Error('bundler is still unavailable after retry.');
          }
        }
      }
    }

    const requestedPortAvailable = await this.isPortAvailable(requestedPort);
    if (!requestedPortAvailable) {
      const fallbackPort = await this.findAvailablePort(requestedPort + 1);
      if (fallbackPort) {
        ctx.launchPort = fallbackPort;
        this.onLog(`[Conflict] Port ${requestedPort} is already in use. Reassigned launch port to ${fallbackPort}`);
      } else {
        throw new Error(`Port ${requestedPort} is already in use and no fallback port could be reserved`);
      }
    } else {
      ctx.launchPort = requestedPort;
      this.onLog(`[Info] Port ${requestedPort} is available for launch`);
    }

    return useVenv;
  }

  // ── Private: install dependencies ───────────────────────────────

  private async runInstall(ctx: InstallContext, useVenv: boolean): Promise<boolean> {
    const cwd = ctx.hostPath;

    if (ctx.projectType === 'nodejs') {
      if (!fs.existsSync(path.join(cwd, 'package.json'))) {
        this.onLog('[Warning] No package.json found, skipping npm install');
        return true;
      }
      const pm = await this.resolveNodePackageManager(cwd);
      this.onLog(`[Info] Package manager: ${pm}`);
      const hasNpmLock = fs.existsSync(path.join(cwd, 'package-lock.json'));
      const baseInstallCmd = pm === 'npm' && hasNpmLock ? 'npm ci' : `${pm} install`;

      const primaryOk = await this.runCommand(baseInstallCmd, cwd, ctx.projectId);
      if (primaryOk) return true;

      if (pm === 'npm') {
        this.onLog('[Warning] npm dependency resolution failed. Retrying with --legacy-peer-deps...', 'warning');
        const legacyCmd = hasNpmLock ? 'npm ci --legacy-peer-deps' : 'npm install --legacy-peer-deps';
        const legacyOk = await this.runCommand(legacyCmd, cwd, ctx.projectId);
        if (legacyOk) return true;

        this.onLog('[Warning] npm legacy peer-deps retry failed. Retrying with --force as last resort...', 'warning');
        const forceOk = await this.runCommand('npm install --force', cwd, ctx.projectId);
        if (forceOk) return true;
      }

      return await this.handleNodeInstallFailure(ctx, cwd, hasNpmLock);
    }

    if (ctx.projectType === 'python') {
      const hasPyproject = fs.existsSync(path.join(cwd, 'pyproject.toml')) || 
                           fs.existsSync(path.join(cwd, 'src', 'pyproject.toml'));
      const hasPipfile   = fs.existsSync(path.join(cwd, 'Pipfile')) || 
                           fs.existsSync(path.join(cwd, 'src', 'Pipfile'));
      const hasReqs      = fs.existsSync(path.join(cwd, 'requirements.txt')) || 
                           fs.existsSync(path.join(cwd, 'src', 'requirements.txt'));

      if (!hasPyproject && !hasPipfile && !hasReqs) {
        this.onLog('[Warning] No dependency file found. Skipping install.');
        return true;
      }

      if (hasPyproject) {
        const poetryOk = await this.commandExists('poetry');
        if (poetryOk) {
          this.onLog('[Info] Package manager: poetry');
          return await this.runCommand('poetry install', cwd, ctx.projectId);
        }
        this.onLog('[Warning] pyproject.toml found but poetry not installed, falling back to pip');
      }

      if (hasPipfile) {
        const pipenvOk = await this.commandExists('pipenv');
        if (pipenvOk) {
          this.onLog('[Info] Package manager: pipenv');
          return await this.runCommand('pipenv install', cwd, ctx.projectId);
        }
        this.onLog('[Warning] Pipfile found but pipenv not installed, falling back to pip');
      }

      if (useVenv) {
        const venvOk = await this.runCommand(
          `${this.resolvePythonBin(cwd, false)} -m venv .venv`,
          cwd,
          ctx.projectId,
        );
        if (!venvOk) return false;
      }

      if (hasReqs) {
        return await this.pipInstallWithFallback(cwd, ctx.projectId);
      }

      return true;
    }

    if (ctx.projectType === 'php') {
      if (!fs.existsSync(path.join(cwd, 'composer.json'))) {
        this.onLog('[Warning] No composer.json found, skipping composer install');
        return true;
      }
      if (!(await this.commandExists('composer'))) {
        throw new Error('composer is not installed. Install it from https://getcomposer.org then try again.');
      }
      this.onLog('[Info] Package manager: composer');
      const composerOk = await this.runCommand('composer install', cwd, ctx.projectId);
      if (composerOk) return true;

      return await this.handlePhpInstallFailure(ctx, cwd);
    }

    if (ctx.projectType === 'java') {
      const tool = await this.resolveJavaBuildTool(cwd);
      if (!tool) {
        throw new Error('No Java build tool found. Install Maven or Gradle and try again.');
      }

      this.onLog(`[Info] Build tool: ${tool}`);

      if (tool === 'gradle') {
        const javaVersion = await this.getVersion('java', '--version');
        const gradleVersion = await this.getGradleVersion(cwd);
        this.onLog(`[Info] Gradle preflight: wrapper ${gradleVersion ?? 'unknown'}, java ${javaVersion ?? 'unknown'}`);

        if (this.isGradleJavaIncompatible(gradleVersion, javaVersion)) {
          const incompatMessage =
            `Gradle ${gradleVersion ?? 'unknown'} is incompatible with Java ${javaVersion ?? 'unknown'}. ` +
            `Use Java 11 for this project, or upgrade Gradle wrapper to 7.3+ (8+ recommended).`;

          const choice = await this.resolveConflict({
            component: 'gradle/java',
            projectType: ctx.projectType,
            message: incompatMessage,
            installUrl: 'https://docs.gradle.org/current/userguide/compatibility.html',
          });

          if (choice === 'docker') {
            throw new DockerFallbackRequestedError('User chose Docker for gradle/java incompatibility.');
          }

          const javaRetry = await this.getVersion('java', '--version');
          const gradleRetry = await this.getGradleVersion(cwd);
          if (this.isGradleJavaIncompatible(gradleRetry, javaRetry)) {
            throw new Error(incompatMessage);
          }
        }
      }

      if (tool === 'maven') {
        return await this.runCommand('mvn dependency:resolve -q', cwd, ctx.projectId);
      }

      const gradlew = this.gradleWrapper(cwd);
      return await this.runCommand(`${gradlew} dependencies --configuration runtimeClasspath -q`, cwd, ctx.projectId);
    }

    if (ctx.projectType === 'ruby') {
      if (!fs.existsSync(path.join(cwd, 'Gemfile'))) {
        this.onLog('[Warning] No Gemfile found, skipping bundler install');
        return true;
      }
      this.onLog('[Info] Package manager: bundler');
      return await this.runCommand('bundle install', cwd, ctx.projectId);
    }

    if (ctx.projectType === 'go') {
      if (!fs.existsSync(path.join(cwd, 'go.mod'))) {
        this.onLog('[Warning] No go.mod found, skipping go mod download');
        return true;
      }
      this.onLog('[Info] Package manager: go modules');
      return await this.runCommand('go mod download', cwd, ctx.projectId);
    }

    return true;
  }

  private async pipInstallWithFallback(cwd: string, projectId: string): Promise<boolean> {
    let reqFile = path.join(cwd, 'requirements.txt');
    if (!fs.existsSync(reqFile)) {
      reqFile = path.join(cwd, 'src', 'requirements.txt');
      if (!fs.existsSync(reqFile)) {
        this.onLog('[Warning] No requirements.txt found, skipping pip install');
        return true;
      }
    }

    const pip = this.getPipCmd(cwd);
    const ok = await this.runCommand(`${pip} install -r "${reqFile}"`, cwd, projectId);
    if (ok) return true;

    this.onLog('[Info] Retrying with individual package installs...');
    const lines = fs.readFileSync(reqFile, 'utf8').split('\n');
    for (const line of lines) {
      const pkg = line.trim();
      if (!pkg || pkg.startsWith('#')) continue;

      const pinOk = await this.runCommand(`${pip} install "${pkg}"`, cwd, projectId);
      if (!pinOk) {
        const name = pkg.split(/[>=<!~[]/)[0].trim();
        this.onLog(`[Fallback] ${pkg} failed, trying unpinned: ${name}`);
        await this.runCommand(`${pip} install "${name}"`, cwd, projectId);
      }
    }
    return true;
  }

  // ── Private: .env writing ────────────────────────────────────────

  private async writeEnvFile(ctx: InstallContext): Promise<void> {
    if (!ctx.envVars || Object.keys(ctx.envVars).length === 0) return;

    const envPath = path.join(ctx.hostPath, '.env');
    const examplePath = path.join(ctx.hostPath, '.env.example');

    let existing: Record<string, string> = {};
    if (fs.existsSync(examplePath)) {
      const lines = fs.readFileSync(examplePath, 'utf8').split('\n');
      for (const line of lines) {
        const match = line.match(/^([^=]+)=(.*)$/);
        if (match) existing[match[1].trim()] = match[2].trim();
      }
    }

    const merged = { ...existing, ...ctx.envVars };
    const content = Object.entries(merged).map(([k, v]) => `${k}=${v}`).join('\n');
    fs.writeFileSync(envPath, content, 'utf8');
    this.onLog(`[Info] Written .env (${Object.keys(merged).length} variables)`);
  }

  // ── Private: launch ──────────────────────────────────────────────

  private async launch(ctx: InstallContext, useVenv: boolean): Promise<number> {
    const cwd = ctx.hostPath;
    let cmd: string;
    try {
      cmd = await this.resolveRunCommand(ctx, useVenv);
    } catch (err: any) { 
      const errorMessage = err?.message ?? String(err);
      this.onLog(`[!] [Error] ${errorMessage}`, 'stderr');
      await this.reportComplete(ctx.projectId, false, undefined, errorMessage);
      throw err;
    }
    const port = await this.resolvePort(ctx);

    this.onLog(`[Launch] Starting: ${cmd}`);
    this.onLog(`[Launch] cwd: ${cwd}`);
    this.onLog(`[Launch] port: ${port}`);

    const launchEnv: NodeJS.ProcessEnv = { ...process.env, PORT: String(port) };

    if (await this.shouldSkipCraPreflight(cwd, cmd)) {
      launchEnv.SKIP_PREFLIGHT_CHECK = 'true';
      this.onLog('[Info] Enabled CRA preflight bypass for this launch');
    }

    if (await this.shouldEnableLegacyOpenSsl(cwd, cmd)) {
      launchEnv.NODE_OPTIONS = `${launchEnv.NODE_OPTIONS ?? ''} --openssl-legacy-provider`.trim();
      this.onLog('[Info] Enabled legacy OpenSSL provider for this launch');
    }

    this.proc = cp.spawn(cmd, [], {
      cwd,
      shell: true,
      detached: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: launchEnv,
    });

    this.proc.stdout?.on('data', (d: Buffer) =>
      d.toString().split('\n').filter(Boolean).forEach(line => this.onLog(line.trim()))
    );
    this.proc.stderr?.on('data', (d: Buffer) =>
      d.toString().split('\n').filter(Boolean).forEach(line => this.onLog(line.trim(), 'stderr'))
    );

    await new Promise(r => setTimeout(r, 2000));
    if (this.proc.exitCode !== null && this.proc.exitCode !== 0) {
      throw new Error(`Process exited immediately with code ${this.proc.exitCode}.`);
    }

    const shouldWaitForPort = this.shouldWaitForPort(ctx.projectType, cmd);
    if (!shouldWaitForPort) {
      this.onLog('[Info] Skipping port readiness check for non-server command.');
      return port;
    }

    const waitTimeoutMs = (ctx.projectType === 'java' || ctx.projectType === 'go') ? 60_000 : 30_000;
    const bound = await this.waitForPort(port, waitTimeoutMs);
    if (!bound) {
      if (this.proc.exitCode !== null && this.proc.exitCode !== 0) {
        throw new Error(`Process exited with code ${this.proc.exitCode}`);
      }
      this.onLog(`[Warning] Port ${port} not responding after ${Math.round(waitTimeoutMs / 1000)}s`);
    }

    return port;
  }

  private async resolveRunCommand(ctx: InstallContext, useVenv: boolean, specifiedFile?: string): Promise<string> {
    const cwd = ctx.hostPath;
    const normalizedRunCommand = (ctx.runCommand ?? '').trim();

    if (normalizedRunCommand.length > 0) {
      if (ctx.projectType === 'nodejs') {
        const pkg = path.join(cwd, 'package.json');
        if (fs.existsSync(pkg)) {
          const scripts = JSON.parse(fs.readFileSync(pkg, 'utf8')).scripts ?? {};
          const scriptMatch = normalizedRunCommand.match(/^(?:npm|pnpm|yarn)\s+(?:run\s+)?([\w:-]+)$/i);
          if (scriptMatch) {
            const scriptName = scriptMatch[1];
            if (!scripts[scriptName]) {
              this.onLog(`[Warning] Backend run command "${normalizedRunCommand}" references missing script "${scriptName}". Falling back.`);
            } else {
              return normalizedRunCommand;
            }
          } else {
            return normalizedRunCommand;
          }
        } else {
          return normalizedRunCommand;
        }
      }

      // If user provided a runCommand for a Python project, attempt to rewrite any relative .py path to an absolute path.
      if (ctx.projectType === 'python') {
        try {
          const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          const pyMatch = normalizedRunCommand.match(/(?:^|\s)(?:['\"])?([^'\"\s]+\.py)(?:['\"])?/i);
          if (pyMatch && pyMatch[1]) {
            const rel = pyMatch[1];
            const abs = path.resolve(cwd, rel);
            // Verify the script actually exists before using the rewritten command
            if (fs.existsSync(abs)) {
              const replaced = normalizedRunCommand.replace(new RegExp(escapeRegExp(rel), 'g'), `"${abs}"`);
              this.onLog(`[Launch] Rewrote run command to use absolute Python script path: ${replaced}`);
              return replaced;
            } else {
              this.onLog(`[Warning] Backend run command references Python script "${rel}" which doesn't exist at "${abs}". Falling back to auto-detection.`);
              // Fall through to auto-detection below
            }
          }
        } catch (e) {
          // fall through and use auto-detection
        }
      } else {
        return normalizedRunCommand;
      }
    }

    if (ctx.projectType === 'nodejs') {
      const pm = await this.resolveNodePackageManager(cwd);
      const pkg = path.join(cwd, 'package.json');
      if (fs.existsSync(pkg)) {
        const scripts = JSON.parse(fs.readFileSync(pkg, 'utf8')).scripts ?? {};
        if (scripts.start) return `${pm} start`;
        if (scripts.dev) return `${pm} run dev`;
        if (scripts.serve) return `${pm} run serve`;
        if (scripts.preview) return `${pm} run preview`;
        const scriptNames = Object.keys(scripts);
        throw new Error(`No runnable Node script found. Expected one of start/dev/serve/preview, but found: ${scriptNames.length ? scriptNames.join(', ') : 'none'}`);
      }
      throw new Error('No package.json found to determine Node launch command.');
    }

    if (ctx.projectType === 'python') {
      const pythonBin = this.resolvePythonBin(cwd, useVenv);

      if (specifiedFile) {
        const normalizedSpecifiedFile = this.normalizeSpecifiedPythonFile(specifiedFile);
        const specifiedPath = path.isAbsolute(normalizedSpecifiedFile)
          ? normalizedSpecifiedFile
          : path.join(cwd, normalizedSpecifiedFile);

        if (!normalizedSpecifiedFile.toLowerCase().endsWith('.py')) {
          throw new Error(`"${normalizedSpecifiedFile}" is not a Python file. Please provide a .py entry file path.`);
        }

        if (fs.existsSync(specifiedPath)) {
          return `${pythonBin} "${specifiedPath}"`;
        }

        const hasPathSeparator = normalizedSpecifiedFile.includes('/') || normalizedSpecifiedFile.includes('\\');
        if (!path.isAbsolute(normalizedSpecifiedFile) && !hasPathSeparator) {
          const discovered = await this.findFileRecursive(cwd, normalizedSpecifiedFile, 5);
          if (discovered) {
            return `${pythonBin} "${path.join(cwd, discovered)}"`;
          }
        }

        throw new Error(`Specified Python entry file not found: ${normalizedSpecifiedFile} (looked in ${specifiedPath})`);
      }

      const managePy = await this.findFileWithSrcFallback(cwd, 'manage.py', ctx);
      if (managePy) {
        const port = await this.resolvePort(ctx);
        const scriptPath = path.resolve(cwd, managePy);
        return `${pythonBin} "${scriptPath}" runserver 0.0.0.0:${port}`;
      }
      for (const f of ['app.py', 'main.py', 'run.py', 'server.py', 'wsgi.py']) {
        const found = await this.findFileWithSrcFallback(cwd, f, ctx);
        if (found) {
          const scriptPath = path.resolve(cwd, found);
          return `${pythonBin} "${scriptPath}"`;
        }
      }
      for (const f of ['asgi.py', 'application.py']) {
        const found = await this.findFileWithSrcFallback(cwd, f, ctx);
        if (found) {
          const port = await this.resolvePort(ctx);
          const module = found.replace(/\.py$/, '').replace(/[\\/]/g, '.');
          return `${pythonBin} -m uvicorn ${module}:app --host 0.0.0.0 --port ${port}`;
        }
      }
      if (await this.requirementsMentions(cwd, 'flask')) {
        const port = await this.resolvePort(ctx);
        return `${pythonBin} -m flask run --host=0.0.0.0 --port=${port}`;
      }

      return await this.promptUserToAddPythonEntryPoint(ctx, useVenv, `Cannot determine how to start this Python project. No manage.py, app.py, main.py, or run.py found in ${cwd} or subdirectories.`);
    }

    if (ctx.projectType === 'php') {
      if (fs.existsSync(path.join(cwd, 'artisan'))) {
        return `php artisan serve --port=${await this.resolvePort(ctx)}`;
      }
      if (fs.existsSync(path.join(cwd, 'bin', 'console'))) {
        return `php -S 0.0.0.0:${await this.resolvePort(ctx)} -t public`;
      }
      const entry = this.findPhpEntry(cwd);
      return `php -S 0.0.0.0:${await this.resolvePort(ctx)} ${entry}`;
    }

    if (ctx.projectType === 'java') {
      const tool = await this.resolveJavaBuildTool(cwd);
      if (!tool) throw new Error('No Java build tool found for this project');
      if (tool === 'maven') return 'mvn spring-boot:run -q';
      const gradlew = this.gradleWrapper(cwd);
      if (await this.fileContains(cwd, 'build.gradle', 'spring-boot') || await this.fileContains(cwd, 'build.gradle.kts', 'spring-boot')) {
        return `${gradlew} bootRun`;
      }
      return `${gradlew} run`;
    }

    if (ctx.projectType === 'ruby') {
      const port = await this.resolvePort(ctx);
      if (fs.existsSync(path.join(cwd, 'config', 'application.rb'))) return `bundle exec rails server -p ${port}`;
      for (const f of ['app.rb', 'main.rb', 'server.rb', 'config.ru']) {
        if (fs.existsSync(path.join(cwd, f))) {
          if (f === 'config.ru') return `bundle exec rackup --port ${port}`;
          return `bundle exec ruby ${f}`;
        }
      }
      throw new Error('Cannot determine Ruby entry point');
    }

    if (ctx.projectType === 'go') {
      const mainFile = this.findGoMain(cwd);
      return mainFile ? `go run ${mainFile}` : 'go run .';
    }

    throw new Error(`Unsupported project type: ${ctx.projectType}`);
  }

  // ── Docker Compose: port scanning ────────────────────────────────
  //
  // Read all host:container port mappings from the compose file BEFORE
  // running docker compose up, so we can remap any that are already in use.

  private parseComposePorts(cwd: string, composeFile: string): ComposePortMapping[] {
    const filePath = path.join(cwd, composeFile);
    if (!fs.existsSync(filePath)) return [];

    const content = fs.readFileSync(filePath, 'utf8');
    const mappings: ComposePortMapping[] = [];

    // Match service blocks and their ports sections
    // Handles both "host:container" string format and long-form mapping objects
    const servicePattern = /^(\s{2})(\w[\w-]*):/gm;
    let serviceMatch: RegExpExecArray | null;
    const lines = content.split('\n');

    let currentService = '';
    let inPortsSection = false;
    let serviceIndent = '';

    for (const line of lines) {
      // Detect service name (2-space indent, word chars)
      const serviceLineMatch = line.match(/^  ([\w][\w-]*):\s*$/);
      if (serviceLineMatch) {
        currentService = serviceLineMatch[1];
        inPortsSection = false;
        serviceIndent = '  ';
        continue;
      }

      // Detect ports: section under a service
      if (currentService && line.match(/^    ports:\s*$/)) {
        inPortsSection = true;
        continue;
      }

      // Exit ports section when we hit another key at same indent
      if (inPortsSection && line.match(/^    \w/) && !line.match(/^      /)) {
        inPortsSection = false;
        continue;
      }

      // Parse port entries like:  - "8000:80" or  - 8000:80
      if (inPortsSection && currentService) {
        const portEntryMatch = line.match(/^\s+-\s+["']?(\d+):(\d+)["']?/);
        if (portEntryMatch) {
          mappings.push({
            hostPort: parseInt(portEntryMatch[1], 10),
            containerPort: parseInt(portEntryMatch[2], 10),
            service: currentService,
          });
        }
      }
    }

    return mappings;
  }

  private async buildPortRemapPlan(
    mappings: ComposePortMapping[],
  ): Promise<{ plan: PortRemapPlan; hasConflicts: boolean }> {
    const plan: PortRemapPlan = {};
    let hasConflicts = false;

    for (const mapping of mappings) {
      const inUse = !(await this.isPortAvailable(mapping.hostPort));
      if (inUse) {
        hasConflicts = true;
        const freePort = await this.findAvailablePort(mapping.hostPort + 1, 200);
        if (!freePort) {
          this.onLog(`[Docker] Warning: No free port found near ${mapping.hostPort} for service ${mapping.service}`, 'warning');
          continue;
        }
        this.onLog(`[Docker] Port ${mapping.hostPort} in use — remapping ${mapping.service} to ${freePort}:${mapping.containerPort}`);
        if (!plan[mapping.service]) plan[mapping.service] = [];
        plan[mapping.service].push({ hostPort: freePort, containerPort: mapping.containerPort });
      }
    }

    return { plan, hasConflicts };
  }

  private writePortRemapOverride(cwd: string, plan: PortRemapPlan): string {
    const overrideFileName = '.project-assistant.port-remap-override.yml';
    const overridePath = path.join(cwd, overrideFileName);

    const lines: string[] = ['services:'];
    for (const [service, portMappings] of Object.entries(plan)) {
      lines.push(`  ${service}:`);
      lines.push(`    ports: !override [`);
      for (const pm of portMappings) {
        lines.push(`      "${pm.hostPort}:${pm.containerPort}",`);
      }
      lines.push(`    ]`);
    }
    lines.push('');

    fs.writeFileSync(overridePath, lines.join('\n'), 'utf8');
    return overrideFileName;
  }

  // ── Docker: runDockerFallback ────────────────────────────────────

  private async runDockerFallback(ctx: InstallContext): Promise<number> {
    await this.reportProgress(ctx.projectId, 35, 'Preparing Docker fallback');
    this.mappedWebserverPort = null;

    const hasDocker = await this.commandExists('docker');
    if (!hasDocker) {
      throw new Error('Docker is not installed or not in PATH. Install Docker Desktop and retry.');
    }

    const cwd = ctx.hostPath;
    let containerPort = ctx.launchPort ?? this.defaultPort(ctx.projectType);

    // ── FIX 1: Try Docker Compose for ANY project type that has a compose file,
    //           not just PHP. Laracom is detected as php, but this also handles
    //           Node, Python, Ruby etc. projects that ship with docker-compose.yml
    const composeContext = this.findDockerComposeContext(cwd);
    if (composeContext) {
      this.onLog(`[Docker] Found compose file: ${composeContext.dir}/${composeContext.file}`);
      return await this.runComposeFallback(ctx, composeContext.dir, composeContext.file);
    }

    // ── No compose file — fall back to single-container docker run ──
    let port = await this.resolvePort(ctx);
    if (ctx.projectType === 'nodejs') {
      const inferredContainerPort = await this.inferNodeLaunchPort(cwd);
      if (inferredContainerPort) {
        containerPort = inferredContainerPort;
      }
    }
    const normalizedPath = cwd.replace(/\\/g, '/');
    const containerBaseName = `pa-${ctx.projectId.slice(-8)}-${Date.now()}`;
    const image = await this.resolveDockerImage(ctx, cwd);

    const hasImage = await this.dockerImageExists(image, cwd);
    if (!hasImage) {
      const approved = this.onDockerImagePullApproval ? await this.onDockerImagePullApproval(image) : false;
      if (!approved) throw new Error(`Docker image ${image} is not available locally and pull was not approved.`);
      this.onLog(`[Docker] Pulling image ${image}...`);
      const pullResult = await this.execAndCaptureResult(`docker pull ${image}`, cwd);
      if (!pullResult.ok) throw new Error(`Failed to pull Docker image ${image}. ${pullResult.errorOutput || pullResult.output}`);
      this.onLog(`[Docker] Image ready: ${image}`);
    }

    let containerName = '';
    let containerId = '';
    let lastDockerError = '';

    for (let attempt = 1; attempt <= 6; attempt += 1) {
      containerName = `${containerBaseName}-${attempt}`;
      const containerScript = await this.resolveDockerScript(ctx, cwd, containerPort);
      const escapedScript = containerScript.replace(/"/g, '\\"');
      await this.execAndCapture(`docker rm -f ${containerName}`, cwd);

      const dockerRunCmd =
        `docker run -d --name ${containerName} --rm --entrypoint sh ` +
        `-p ${port}:${containerPort} -w /workspace ` +
        `-v "${normalizedPath}:/workspace" -e PORT=${containerPort} ` +
        `${image} -lc "${escapedScript}"`;

      this.onLog(`[Docker] Starting container on host:${port} -> container:${containerPort} (attempt ${attempt}/6)`);
      const dockerRun = await this.execAndCaptureResult(dockerRunCmd, cwd);
      containerId = dockerRun.output;

      if (dockerRun.ok && containerId) break;

      const details = dockerRun.errorOutput || 'No stderr from docker command.';
      lastDockerError = details;

      const portBusy = /port is already allocated|bind for 0\.0\.0\.0:\d+ failed/i.test(details);
      if (!portBusy || attempt === 6) throw new Error(`Failed to start Docker container. ${details}`);

      const nextPort = await this.findAvailablePort(port + 1, 100);
      if (!nextPort) throw new Error(`Failed to start Docker container. ${details}`);

      this.onLog(`[Docker] Port ${port} is busy. Retrying on port ${nextPort}.`, 'warning');
      port = nextPort;
    }

    if (!containerId) throw new Error(`Failed to start Docker container. ${lastDockerError}`);

    this.onLog(`[Docker] Container started: ${containerName}`);
    await this.reportProgress(ctx.projectId, 90, 'Launching application in Docker');
    const waitMs = ctx.projectType === 'java' ? 180_000 : 90_000;
    const bound = await this.waitForPort(port, waitMs);
    if (!bound) {
      const running = await this.isContainerRunning(containerName, cwd);
      const recentLogs = await this.execAndCapture(`docker logs --tail 80 ${containerName}`, cwd);
      if (!running) throw new Error(`Docker container exited before becoming ready on port ${port}.\n${recentLogs}`);
      throw new Error(`Docker container running but port ${port} not responding after ${Math.round(waitMs / 1000)}s.\n${recentLogs}`);
    }

    if (this.shouldRequireHttpReadiness(ctx.projectType)) {
      const httpTimeoutMs = this.getDockerHttpReadinessTimeoutMs(ctx.projectType);
      const httpReady = await this.waitForHttpReady(port, httpTimeoutMs);
      if (!httpReady) {
        const recentLogs = await this.execAndCapture(`docker logs --tail 80 ${containerName}`, cwd);
        if (/missingsecret/i.test(recentLogs)) {
          throw new Error(
            'Auth.js reported MissingSecret inside Docker. Set AUTH_SECRET or NEXTAUTH_SECRET for this project. '
            + 'The installer now injects a development default for NextAuth-like projects; retry installation so the updated Docker fallback script is used.\n'
            + recentLogs,
          );
        }
        throw new Error(`Docker container bound port ${port} but did not return HTTP responses in time.\n${recentLogs}`);
      }
    }

    return port;
  }

  // ── Docker Compose: unified fallback for all project types ───────

  private async runComposeFallback(ctx: InstallContext, cwd: string, composeFile: string): Promise<number> {
    await this.reportProgress(ctx.projectId, 40, 'Starting Docker Compose stack');

    // ── FIX 2: Pre-flight port scan — remap conflicting ports BEFORE running up ──
    const mappings = this.parseComposePorts(cwd, composeFile);
    this.onLog(`[Docker] Compose port scan: found ${mappings.length} host port binding(s)`);

    const { plan, hasConflicts } = await this.buildPortRemapPlan(mappings);

    let upResult: { ok: boolean; output: string; errorOutput: string };
    let portOverrideFile: string | null = null;

    if (hasConflicts && Object.keys(plan).length > 0) {
      // Write a compose override with remapped ports and use it
      portOverrideFile = this.writePortRemapOverride(cwd, plan);
      this.onLog(`[Docker] Pre-flight: remapping conflicting ports via override file`);

      try {
        upResult = await this.execAndCaptureResult(
          `docker compose -f "${composeFile}" -f "${portOverrideFile}" up -d --build`,
          cwd,
        );
      } finally {
        // Always clean up override file
        try { fs.unlinkSync(path.join(cwd, portOverrideFile)); } catch { }
        portOverrideFile = null;
      }
    } else {
      // No pre-flight conflicts detected — run normally
      upResult = await this.runComposeUpWithFallback(cwd, composeFile);
    }

    if (!upResult.ok) {
      // ── FIX 3: If compose still failed after our pre-flight remap, try
      //           the full fallback chain one more time with fresh port scan ──
      const failText = this.composeResultText(upResult);
      const conflictPort = this.extractDockerPortConflict(failText);

      if (conflictPort) {
        this.onLog(`[Docker] Post-run port conflict on ${conflictPort} — attempting emergency remap`, 'warning');
        const emergencyResult = await this.runComposeUpWithFallback(cwd, composeFile);
        if (!emergencyResult.ok) {
          const details = emergencyResult.errorOutput || emergencyResult.output || 'No output from docker compose up.';
          throw new Error(`Failed to start Docker Compose stack. ${details}`);
        }
        upResult = emergencyResult;
      } else {
        const details = upResult.errorOutput || upResult.output || 'No output from docker compose up.';
        throw new Error(`Failed to start Docker Compose stack. ${details}`);
      }
    }

    // ── Resolve which port to poll ─────────────────────────────────
    const serviceName = await this.detectComposeServiceName(cwd, composeFile);
    let resolvedPort = await this.resolveComposeHostPort(cwd, composeFile, serviceName);

    // If port was remapped by pre-flight, use the remapped port
    if (!resolvedPort && Object.keys(plan).length > 0) {
      const webserverPlan = plan['webserver'] || plan['app'] || plan[serviceName];
      if (webserverPlan && webserverPlan.length > 0) {
        resolvedPort = webserverPlan[0].hostPort;
        this.onLog(`[Docker] Using pre-flight remapped port: ${resolvedPort}`);
      }
    }

    const port = resolvedPort ?? this.mappedWebserverPort ?? (ctx.launchPort ?? this.defaultPort(ctx.projectType));

    await this.reportProgress(ctx.projectId, 90, 'Waiting for Docker Compose stack to be ready');
    const bound = await this.waitForPort(port, 120_000);
    if (!bound) {
      throw new Error(`Docker Compose stack started but port ${port} did not become ready within 120s.`);
    }

    this.onLog(`[Docker] Stack ready on port ${port}`);
    return port;
  }

  // ── Docker Compose: helpers ──────────────────────────────────────

  private findDockerComposeFile(cwd: string): string | null {
    for (const candidate of ['docker-compose.yaml', 'docker-compose.yml', 'compose.yaml', 'compose.yml']) {
      if (fs.existsSync(path.join(cwd, candidate))) return candidate;
    }
    return null;
  }

  private findDockerComposeContext(cwd: string): { dir: string; file: string } | null {
    const rootCompose = this.findDockerComposeFile(cwd);
    if (rootCompose) {
      return { dir: cwd, file: rootCompose };
    }

    let current = cwd;
    for (let depth = 0; depth < 3; depth += 1) {
      const parent = path.dirname(current);
      if (parent === current) break;

      // Only climb to parent folders if they look like an actual monorepo root.
      // This prevents accidentally picking an unrelated docker-compose.yml above the project.
      if (!this.isLikelyMonorepoRoot(parent)) {
        break;
      }

      const parentCompose = this.findDockerComposeFile(parent);
      if (parentCompose) {
        return { dir: parent, file: parentCompose };
      }
      current = parent;
    }

    return null;
  }

  private isLikelyMonorepoRoot(dir: string): boolean {
    const markers = [
      'pnpm-workspace.yaml',
      'turbo.json',
      'nx.json',
      'lerna.json',
      'rush.json',
      '.yarnrc.yml',
    ];

    if (markers.some((marker) => fs.existsSync(path.join(dir, marker)))) {
      return true;
    }

    const packageJsonPath = path.join(dir, 'package.json');
    if (!fs.existsSync(packageJsonPath)) {
      return false;
    }

    try {
      const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
      return Boolean(pkg?.workspaces);
    } catch {
      return false;
    }
  }

  private composeResultText(result: { output: string; errorOutput: string }): string {
    return `${result.output || ''}\n${result.errorOutput || ''}`;
  }

  private extractDockerPortConflict(text: string): number | undefined {
    const normalized = String(text ?? '');
    if (!normalized) return undefined;
    const m = normalized.match(
      /Bind for 0\.0\.0\.0:(\d+)|port (\d+) .* failed|bind.*:(\d+)|:(\d+).*already allocated|Ports are not available: exposing port TCP 0\.0\.0\.0:(\d+)/i,
    );
    if (!m) return undefined;
    const conflictPort = m[1] || m[2] || m[3] || m[4] || m[5];
    if (!conflictPort) return undefined;
    const parsed = parseInt(conflictPort, 10);
    return Number.isFinite(parsed) ? parsed : undefined;
  }

  private async getComposeServices(cwd: string, composeFile: string): Promise<string[]> {
    const result = await this.execAndCaptureResult(`docker compose -f "${composeFile}" config --services`, cwd);
    const cliServices = result.ok
      ? result.output
        .split(/\r?\n/)
        .map(l => l.trim())
        .filter(s => /^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(s))
      : [];

    // Fallback parser: compose config can fail on partially broken user files.
    const fileServices = this.parseComposeServiceNames(cwd, composeFile);
    return Array.from(new Set([...cliServices, ...fileServices]));
  }

  private parseComposeServiceNames(cwd: string, composeFile: string): string[] {
    const filePath = path.join(cwd, composeFile);
    if (!fs.existsSync(filePath)) return [];

    const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);
    const services: string[] = [];
    let inServicesBlock = false;
    let serviceIndent: number | null = null;

    for (const line of lines) {
      if (!inServicesBlock) {
        if (/^\s*services:\s*$/.test(line)) inServicesBlock = true;
        continue;
      }

      if (!line.trim() || /^\s*#/.test(line)) continue;

      const keyMatch = line.match(/^\s*([A-Za-z0-9][A-Za-z0-9_.-]*):\s*(?:#.*)?$/);
      if (!keyMatch) continue;

      const indent = line.match(/^\s*/)?.[0].length ?? 0;

      // Reached next top-level key (e.g. volumes/networks) after services block.
      if (indent === 0) break;

      if (serviceIndent === null) {
        serviceIndent = indent;
      }

      // Collect only direct children of services:
      if (indent === serviceIndent) {
        services.push(keyMatch[1]);
      } else if (indent < serviceIndent) {
        break;
      }
    }

    return services;
  }

  private async runComposeUpWithFallback(
    cwd: string,
    composeFile: string,
  ): Promise<{ ok: boolean; output: string; errorOutput: string }> {
    this.mappedWebserverPort = null;
    const primaryUp = await this.execAndCaptureResult(`docker compose -f "${composeFile}" up -d --build`, cwd);
    if (primaryUp.ok) return primaryUp;

    const primaryText = this.composeResultText(primaryUp);
    const allServices = await this.getComposeServices(cwd, composeFile);

    // ── Mailhog build failure ──────────────────────────────────────
    const hasMailhogBuildFailure = /mailhog/i.test(primaryText);
    const coreServiceNames = allServices.filter(s => !/mailhog/i.test(s));

    if (hasMailhogBuildFailure && coreServiceNames.length > 0) {
      this.onLog(`[Docker] Mailhog build failure — retrying without mailhog`, 'warning');
      const coreUp = await this.execAndCaptureResult(
        `docker compose -f "${composeFile}" up -d --build --no-deps ${coreServiceNames.join(' ')}`, cwd,
      );
      if (coreUp.ok) return coreUp;

      const coreNoBuild = await this.execAndCaptureResult(
        `docker compose -f "${composeFile}" up -d --no-build --no-deps ${coreServiceNames.join(' ')}`, cwd,
      );
      if (coreNoBuild.ok) return coreNoBuild;

      return await this.retryComposeWithoutDbHostPort(cwd, composeFile, coreServiceNames);
    }

    // ── Any port conflict ──────────────────────────────────────────
    const conflictPort = this.extractDockerPortConflict(primaryText);
    if (conflictPort && conflictPort > 1000) {
      this.onLog(`[Docker] Port ${conflictPort} conflict after compose up — trying db port removal + alternate ports`);
      return await this.retryComposeWithoutDbHostPort(cwd, composeFile, allServices);
    }

    return primaryUp;
  }

  private async retryComposeWithoutDbHostPort(
    cwd: string,
    composeFile: string,
    services: string[],
  ): Promise<{ ok: boolean; output: string; errorOutput: string }> {
    this.onLog('[Docker] Attempting to start without DB host port binding...');

    const overrideFileName = '.project-assistant.db-port-override.yml';
    const overridePath = path.join(cwd, overrideFileName);
    const overrideContent = [
      'services:',
      '  db:',
      '    expose:',
      '      - "3306"',
      '    ports: !override []',
      '',
    ].join('\n');

    fs.writeFileSync(overridePath, overrideContent, 'utf8');

    try {
      const cmd = `docker compose -f "${composeFile}" -f "${overrideFileName}" up -d --no-build --force-recreate ${services.join(' ')}`;
      const result = await this.execAndCaptureResult(cmd, cwd);
      const resultText = this.composeResultText(result);

      if (result.ok) return result;

      // Still conflicting — try alternate ports for webserver/app
      const conflictPort = this.extractDockerPortConflict(resultText);
      if (conflictPort && conflictPort > 1000) {
        const appWebOnly = services.filter(s => s !== 'db');
        if (appWebOnly.length > 0) {
          return await this.retryComposeWithAlternatePorts(cwd, composeFile, overrideFileName, appWebOnly, conflictPort);
        }
      }

      return result;
    } finally {
      try { fs.unlinkSync(overridePath); } catch { }
    }
  }

  private async retryComposeWithAlternatePorts(
    cwd: string,
    composeFile: string,
    dbOverrideFileName: string,
    services: string[],
    conflictPort: number,
  ): Promise<{ ok: boolean; output: string; errorOutput: string }> {
    // Build a list of candidate alternate ports, starting from conflictPort+1
    const candidates: number[] = [];
    for (let p = conflictPort + 1; p <= conflictPort + 20; p++) {
      if (await this.isPortAvailable(p)) {
        candidates.push(p);
        if (candidates.length >= 6) break;
      }
    }
    // Also try some well-known alternates
    for (const p of [8888, 9000, 9001, 8080, 5000]) {
      if (!candidates.includes(p) && await this.isPortAvailable(p)) {
        candidates.push(p);
        if (candidates.length >= 8) break;
      }
    }

    for (const altPort of candidates) {
      const portOverrideFileName = `.project-assistant.port-${altPort}-override.yml`;
      const portOverridePath = path.join(cwd, portOverrideFileName);

      this.onLog(`[Docker] Trying alternate port ${altPort} for services: ${services.join(', ')}`);

      const overrideLines: string[] = [
        'services:',
        '  db:',
        '    expose:',
        '      - "3306"',
        '    ports: !override []',
      ];

      if (services.includes('webserver')) {
        overrideLines.push('  webserver:', `    ports: !override ["${altPort}:80"]`);
      }
      if (services.includes('app')) {
        const appPort = altPort + 1;
        if (await this.isPortAvailable(appPort)) {
          overrideLines.push('  app:', `    ports: !override ["${appPort}:8000"]`);
        }
      }

      fs.writeFileSync(portOverridePath, `${overrideLines.join('\n')}\n`, 'utf8');

      try {
        await this.execAndCaptureResult(
          `docker compose -f "${composeFile}" -f "${dbOverrideFileName}" -f "${portOverrideFileName}" down`, cwd,
        );

        const cmd = `docker compose -f "${composeFile}" -f "${dbOverrideFileName}" -f "${portOverrideFileName}" up -d --no-build ${services.join(' ')}`;
        const result = await this.execAndCaptureResult(cmd, cwd);

        if (result.ok) {
          this.mappedWebserverPort = altPort;
          return result;
        }

        const failedPort = this.extractDockerPortConflict(this.composeResultText(result));
        if (!failedPort) return result; // non-port error — return as-is
        // port still busy — try next candidate
      } finally {
        try { fs.unlinkSync(portOverridePath); } catch { }
      }
    }

    return { ok: false, output: '', errorOutput: 'All alternate ports exhausted — no available port found.' };
  }

  private async detectComposeServiceName(cwd: string, composeFile: string): Promise<string> {
    const services = await this.getComposeServices(cwd, composeFile);
    for (const preferred of ['webserver', 'app', 'php', 'backend', 'laravel', 'web']) {
      const match = services.find(s => s.toLowerCase() === preferred);
      if (match) return match;
    }
    return services[0] ?? 'app';
  }

  private async resolveComposeHostPort(cwd: string, composeFile: string, serviceName: string): Promise<number | undefined> {
    if (this.mappedWebserverPort && this.mappedWebserverPort > 0) return this.mappedWebserverPort;

    for (const containerPort of [80, 8000, 8080]) {
      const portResult = await this.execAndCaptureResult(
        `docker compose -f "${composeFile}" port ${serviceName} ${containerPort}`, cwd,
      );
      const output = (portResult.output || '').trim();
      if (!output) continue;
      const match = output.match(/:(\d+)\s*$/);
      if (match) {
        const parsed = Number(match[1]);
        if (Number.isFinite(parsed) && parsed > 0) return parsed;
      }
    }

    return undefined;
  }

  // ── Remaining helpers (unchanged) ───────────────────────────────

  private shouldWaitForPort(projectType: string, cmd: string): boolean {
    const normalized = cmd.toLowerCase();
    if (projectType === 'java') {
      return normalized.includes('spring-boot:run') || normalized.includes('bootrun') ||
        normalized.includes('quarkus') || normalized.includes('micronaut') || normalized.includes('java -jar');
    }
    return true;
  }

  private resolvePythonBin(cwd: string, useVenv: boolean): string {
    if (useVenv) {
      const win = path.join(cwd, '.venv', 'Scripts', 'python.exe');
      if (fs.existsSync(win)) return `"${win}"`;
      const unix = path.join(cwd, '.venv', 'bin', 'python');
      if (fs.existsSync(unix)) return unix;
    }
    return process.platform === 'win32' ? 'python' : 'python3';
  }

  private async resolvePort(ctx: InstallContext): Promise<number> {
    let intended = ctx.launchPort ?? this.defaultPort(ctx.projectType);

    // Only infer port from app config if no port was explicitly configured by the user.
    if (ctx.projectType === 'nodejs' && !ctx.launchPort) {
      const inferred = await this.inferNodeLaunchPort(ctx.hostPath);
      if (inferred) {
        this.onLog(`[Info] Detected Node app default port ${inferred}; using it for launch`);
        intended = inferred;
      }
    }

    if (!this.isPortInUse(intended)) return intended;
    for (let p = intended + 1; p < intended + 100; p++) {
      if (!this.isPortInUse(p)) {
        this.onLog(`[Conflict] Port ${intended} is in use. Using port ${p} instead`);
        return p;
      }
    }
    return intended;
  }

  private defaultPort(projectType: string): number {
    const ports: Record<string, number> = { nodejs: 3000, python: 8000, php: 8000, java: 8080, ruby: 3000, go: 8080 };
    return ports[projectType] ?? 3000;
  }

  private async inferNodeLaunchPort(cwd: string): Promise<number | null> {
    const packageJsonPath = path.join(cwd, 'package.json');
    if (!fs.existsSync(packageJsonPath)) return null;

    try {
      const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
      const scripts = pkg.scripts ?? {};
      const scriptText = [scripts.start, scripts.dev, scripts.serve, scripts.preview]
        .filter((value): value is string => typeof value === 'string')
        .join(' ')
        .toLowerCase();
      const depText = JSON.stringify({ ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) }).toLowerCase();

      const explicitPortMatch = scriptText.match(/--port(?:=|\s+)(\d{2,5})/i);
      if (explicitPortMatch) {
        const parsed = Number(explicitPortMatch[1]);
        if (Number.isFinite(parsed)) return parsed;
      }

      // Prefer actual run scripts over dependency hints to avoid false positives
      // in monorepos (for example, a Next app with a Vite-based subpackage).
      if (scriptText.includes('next')) return 3000;
      if (scriptText.includes('nuxt')) return 3000;
      if (scriptText.includes('react-scripts')) return 3000;
      if (scriptText.includes('astro')) return 4321;
      if (scriptText.includes('vite preview')) return 4173;
      if (scriptText.includes('vite')) return 5173;
      if (scriptText.includes('webpack-dev-server')) return 8080;

      // Only use dependency heuristics if scripts provide no recognizable server hint.
      if (!scriptText.trim()) {
        if (depText.includes('"next"')) return 3000;
        if (depText.includes('"nuxt"')) return 3000;
        if (depText.includes('"astro"')) return 4321;
        if (depText.includes('"vite"')) return 5173;
      }
    } catch {
      return null;
    }

    return null;
  }

  private isPortInUse(port: number): boolean {
    const net = require('net');
    const server = net.createServer();
    try { server.listen(port, '127.0.0.1'); server.close(); return false; } catch { return true; }
  }

  private async requirementsMentions(cwd: string, pkg: string): Promise<boolean> {
    const req = path.join(cwd, 'requirements.txt');
    if (!fs.existsSync(req)) return false;
    return fs.readFileSync(req, 'utf8').toLowerCase().includes(pkg.toLowerCase());
  }

  private async checkNodePmAvailable(cwd: string): Promise<void> {
    await this.resolveNodePackageManager(cwd);
  }

  private async resolveNodePackageManager(cwd: string): Promise<'npm' | 'pnpm' | 'yarn'> {
    const pm = this.detectNodePm(cwd);
    if (pm === 'npm') return 'npm';

    const exists = await this.commandExists(pm);
    if (exists) return pm as 'pnpm' | 'yarn';

    this.onLog(`[Warning] ${pm} not found, falling back to npm`);
    return 'npm';
  }

  private async handleNodeInstallFailure(ctx: InstallContext, cwd: string, hasNpmLock: boolean): Promise<boolean> {
    const output = String(this.lastCommandOutput || '').toLowerCase();
    const hasDocker = await this.commandExists('docker');

    const guidance = this.buildNodeConflictGuidance(output, hasDocker);

    const choice = await this.resolveConflict({
      component: 'node-dependencies',
      projectType: ctx.projectType,
      message: guidance,
      installUrl: 'https://docs.npmjs.com/cli/v10/using-npm/workspaces',
    });

    if (choice === 'docker') {
      throw new DockerFallbackRequestedError('User chose Docker for Node dependency conflict.');
    }

    const retryPm = await this.resolveNodePackageManager(cwd);
    const retryCmd = retryPm === 'npm' && hasNpmLock ? 'npm ci' : `${retryPm} install`;
    this.onLog('[Info] Retrying dependency install after user-guided conflict resolution...');
    return await this.runCommand(retryCmd, cwd, ctx.projectId);
  }

  private buildNodeConflictGuidance(output: string, hasDocker: boolean): string {
    if (output.includes('eunsupportedprotocol') && output.includes('workspace:')) {
      return [
        'npm cannot install this project because it uses workspace:* dependencies.',
        'Primary suggestion: enable pnpm with corepack, then retry from the monorepo root.',
        'Command: corepack enable ; corepack prepare pnpm@latest --activate',
        hasDocker ? 'Docker is available. Use Docker to bypass the workspace/tooling conflict.' : '',
      ].filter(Boolean).join('\n');
    }

    if (output.includes('eresolve')) {
      return [
        'npm failed because of a peer dependency conflict (ERESOLVE).',
        'Primary suggestion: align the conflicting package versions, then retry.',
        'Example: eslint 9 is incompatible with @typescript-eslint/parser 6.x; either downgrade eslint or upgrade the parser/plugin pair.',
        hasDocker ? 'Docker is available. Use Docker to bypass the local dependency-tree conflict.' : '',
      ].filter(Boolean).join('\n');
    }

    if (hasDocker) {
      return [
        'Dependency installation failed.',
        'Primary suggestion: use Docker to bypass the local Node/package-manager conflict.',
        'If you prefer local install, fix the package manager or dependency tree, then retry.',
      ].join('\n');
    }

    return [
      'Dependency installation failed.',
      'Primary suggestion: inspect the install log, fix the first reported issue, then retry.',
    ].join('\n');
  }

  private async handlePhpInstallFailure(ctx: InstallContext, cwd: string): Promise<boolean> {
    const output = String(this.lastCommandOutput || '').toLowerCase();
    const hasDocker = await this.commandExists('docker');

    const guidance = this.buildPhpConflictGuidance(output, hasDocker);

    const choice = await this.resolveConflict({
      component: 'php-dependencies',
      projectType: ctx.projectType,
      message: guidance,
      installUrl: 'https://getcomposer.org/doc/',
    });

    if (choice === 'docker') {
      throw new DockerFallbackRequestedError('User chose Docker for PHP dependency conflict.');
    }

    this.onLog('[Info] Retrying composer install after user-guided conflict resolution...');
    return await this.runCommand('composer install', cwd, ctx.projectId);
  }

  private buildPhpConflictGuidance(output: string, hasDocker: boolean): string {
    if (
      output.includes('your php version')
      && output.includes('does not satisfy that requirement')
    ) {
      return [
        'Composer failed because the project dependencies require a newer PHP version than the current runtime.',
        'Primary suggestion: upgrade your PHP runtime/container to the version required by composer.lock (commonly PHP 8.1+).',
        'Then run: composer install',
        hasDocker ? 'Docker is available. Use Docker with a PHP 8.1/8.2 image to bypass local PHP mismatch.' : '',
      ].filter(Boolean).join('\n');
    }

    if (output.includes('failed opening required') && output.includes('vendor/autoload.php')) {
      return [
        'Application failed because vendor/autoload.php is missing (dependencies not installed).',
        'Primary suggestion: run composer install in the project root, then relaunch.',
        hasDocker ? 'Docker is available. You can run composer install inside the app container and retry.' : '',
      ].filter(Boolean).join('\n');
    }

    if (output.includes('your requirements could not be resolved')) {
      return [
        'Composer could not resolve dependency constraints.',
        'Primary suggestion: inspect the first reported package conflict and align version constraints, then retry composer install.',
        hasDocker ? 'Docker is available. Use Docker if your local PHP/extensions differ from project requirements.' : '',
      ].filter(Boolean).join('\n');
    }

    return [
      'Composer install failed.',
      'Primary suggestion: inspect the first composer error, apply the fix, then retry.',
      hasDocker ? 'Docker is available. Use Docker to bypass local PHP/runtime differences.' : '',
    ].filter(Boolean).join('\n');
  }

  private async resolveJavaBuildTool(cwd: string): Promise<'maven' | 'gradle' | null> {
    if (fs.existsSync(path.join(cwd, 'pom.xml')) && await this.commandExists('mvn')) return 'maven';
    const hasGradleFile = fs.existsSync(path.join(cwd, 'build.gradle')) || fs.existsSync(path.join(cwd, 'build.gradle.kts'));
    if (hasGradleFile && (fs.existsSync(path.join(cwd, 'gradlew')) || fs.existsSync(path.join(cwd, 'gradlew.bat')) || await this.commandExists('gradle'))) return 'gradle';
    return null;
  }

  private async resolveJavaBuildToolForDocker(cwd: string): Promise<'maven' | 'gradle' | null> {
    const pom = await this.findFileRecursive(cwd, 'pom.xml', 3);
    if (pom) return 'maven';
    const gradle = await this.findFileRecursive(cwd, 'build.gradle', 3) || await this.findFileRecursive(cwd, 'build.gradle.kts', 3);
    if (gradle) return 'gradle';
    return null;
  }

  private gradleWrapper(cwd: string): string {
    if (process.platform === 'win32' && fs.existsSync(path.join(cwd, 'gradlew.bat'))) return 'gradlew.bat';
    if (fs.existsSync(path.join(cwd, 'gradlew'))) return './gradlew';
    return 'gradle';
  }

  private async getGradleVersion(cwd: string): Promise<string | null> {
    const wrapperVersion = this.getGradleVersionFromWrapper(cwd);
    if (wrapperVersion) return wrapperVersion;
    const output = await this.execAndCapture(`${this.gradleWrapper(cwd)} --version`, cwd);
    if (!output) return null;
    const match = output.match(/Gradle\s+(\d+(?:\.\d+){0,2})/i);
    return match ? match[1] : null;
  }

  private getGradleVersionFromWrapper(cwd: string): string | null {
    const wrapperPropsPath = path.join(cwd, 'gradle', 'wrapper', 'gradle-wrapper.properties');
    if (!fs.existsSync(wrapperPropsPath)) return null;
    try {
      const content = fs.readFileSync(wrapperPropsPath, 'utf8');
      const match = content.match(/distributionUrl=.*gradle-(\d+(?:\.\d+){0,2})-(?:bin|all)\.zip/i);
      return match ? match[1] : null;
    } catch { return null; }
  }

  private isGradleJavaIncompatible(gradleVersion: string | null, javaVersion: string | null): boolean {
    if (!gradleVersion || !javaVersion) return false;
    const gradleMajor = parseInt(gradleVersion.split('.')[0], 10);
    const javaMajor = parseInt(javaVersion.split('.')[0], 10);
    if (Number.isNaN(gradleMajor) || Number.isNaN(javaMajor)) return false;
    if (javaMajor >= 17 && gradleMajor < 7) return true;
    if (javaMajor >= 21 && gradleMajor < 8) return true;
    return false;
  }

  private findPhpEntry(cwd: string): string {
    for (const f of ['index.php', 'public/index.php', 'public_html/index.php', 'src/index.php', 'app/index.php', 'www/index.php']) {
      if (fs.existsSync(path.join(cwd, f))) return f;
    }
    const rootPhp = fs.readdirSync(cwd).find(f => f.endsWith('.php'));
    return rootPhp ?? 'index.php';
  }

  private findGoMain(cwd: string): string | null {
    if (fs.existsSync(path.join(cwd, 'main.go'))) return 'main.go';
    const cmdDir = path.join(cwd, 'cmd');
    if (fs.existsSync(cmdDir)) {
      const subdirs = fs.readdirSync(cmdDir, { withFileTypes: true }).filter(e => e.isDirectory());
      if (subdirs.length > 0) return `./cmd/${subdirs[0].name}`;
    }
    return null;
  }

  private async fileContains(cwd: string, file: string, text: string): Promise<boolean> {
    const fullPath = path.join(cwd, file);
    if (!fs.existsSync(fullPath)) return false;
    return fs.readFileSync(fullPath, 'utf8').includes(text);
  }

  private async shouldSkipCraPreflight(cwd: string, cmd: string): Promise<boolean> {
    if (!cmd.includes('npm start') && !cmd.includes('react-scripts start')) return false;
    const packageJsonPath = path.join(cwd, 'package.json');
    if (!fs.existsSync(packageJsonPath)) return false;
    try {
      const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
      const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
      return Boolean(String(pkg.scripts?.start ?? '').includes('react-scripts') || deps['react-scripts']);
    } catch { return false; }
  }

  private async shouldEnableLegacyOpenSsl(cwd: string, cmd: string): Promise<boolean> {
    const packageJsonPath = path.join(cwd, 'package.json');
    if (!fs.existsSync(packageJsonPath)) return false;
    try {
      const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
      const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
      const usesReactScripts = String(pkg.scripts?.start ?? '').includes('react-scripts') || Boolean(deps['react-scripts']);
      const usesWebpack4 = /^4\./.test(String(deps.webpack ?? ''));
      const launchesFrontendDev = /npm\s+start|react-scripts\s+start|webpack-dev-server/.test(cmd);
      return launchesFrontendDev && (usesReactScripts || usesWebpack4);
    } catch { return false; }
  }

  private async findFileRecursive(cwd: string, filename: string, maxDepth: number = 3, currentDepth: number = 0): Promise<string | null> {
    if (currentDepth > maxDepth) return null;
    if (fs.existsSync(path.join(cwd, filename))) return filename;
    try {
      const entries = fs.readdirSync(cwd, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory() && !entry.name.startsWith('.')) {
          const result = await this.findFileRecursive(path.join(cwd, entry.name), filename, maxDepth, currentDepth + 1);
          if (result) return path.join(entry.name, result).replace(/\\/g, '/');
        }
      }
    } catch { }
    return null;
  }

  /**
   * Find a file, first checking in the src folder, then recursively in subdirectories.
   * If not found and user callback is available, asks user to specify the file location.
   */
  private async findFileWithSrcFallback(
    cwd: string,
    filename: string,
    ctx?: InstallContext
  ): Promise<string | null> {
    // Check in src folder first
    const srcPath = path.join(cwd, 'src', filename);
    if (fs.existsSync(srcPath)) {
      return `src/${filename}`;
    }

    // Try recursive search in other folders
    const found = await this.findFileRecursive(cwd, filename);
    if (found) {
      return found;
    }

    // File not found, ask user to specify location
    if (ctx && this.onConflictResolution) {
      this.onLog(`[File] Could not find ${filename} in src folder or subdirectories.`);
      const choice = await this.resolveConflict({
        component: `Python entry point (${filename})`,
        projectType: ctx.projectType,
        message: `Could not automatically locate ${filename}. You can specify its location (e.g., src/${filename}, services/${filename}, or just ${filename} if in project root).`,
        allowFileInput: true,
      });

      if (typeof choice === 'object' && choice.action === 'specifyFile' && choice.value) {
        const specifiedPath = choice.value.trim();
        // Verify the specified file exists
        if (fs.existsSync(path.join(cwd, specifiedPath))) {
          this.onLog(`[File] Using user-specified file: ${specifiedPath}`);
          return specifiedPath;
        } else {
          this.onLog(`[File] Specified file not found at: ${specifiedPath}`);
          throw new Error(`Specified file not found: ${specifiedPath}`);
        }
      }
    }

    return null;
  }

  private normalizeSpecifiedPythonFile(specifiedFile: string): string {
    return specifiedFile.trim().replace(/^['"]|['"]$/g, '');
  }

  private async promptUserToAddPythonEntryPoint(ctx: InstallContext, useVenv: boolean, errorMessage: string): Promise<string> {
    this.onLog('[Launch] Python entry file is missing. Waiting for user to provide a location.');

    let lastValidationError = errorMessage;
    while (true) {
      const basePrompt = 'Python entry file was not found in src or subdirectories. Enter a valid entry file path such as src/main.py, app.py, or manage.py, then choose "I Fixed It, Retry".';
      const choice = await this.resolveConflict({
        component: 'python-entrypoint',
        projectType: ctx.projectType,
        message: lastValidationError ? `${basePrompt} Last input error: ${lastValidationError}` : basePrompt,
        installUrl: undefined,
        allowFileInput: true,
      });

      if (choice === 'docker') {
        throw new DockerFallbackRequestedError('User chose Docker while fixing missing Python entry point.');
      }

      if (typeof choice === 'object' && choice.action === 'specifyFile') {
        try {
          const runCommand = await this.resolveRunCommand(ctx, useVenv, choice.value);
          this.onLog(`[Launch] Using user-specified Python entry file: ${this.normalizeSpecifiedPythonFile(choice.value)}`);
          return runCommand;
        } catch (verifyErr: any) {
          lastValidationError = String(verifyErr?.message ?? errorMessage);
          this.onLog(`[Launch] Entry-point check failed: ${lastValidationError}`, 'warning');
          continue;
        }
      }

      lastValidationError = errorMessage;
    }
  }

  private detectNodePm(cwd: string): 'npm' | 'pnpm' | 'yarn' {
    if (fs.existsSync(path.join(cwd, 'pnpm-lock.yaml'))) return 'pnpm';
    if (fs.existsSync(path.join(cwd, 'yarn.lock'))) return 'yarn';
    return 'npm';
  }

  private getPipCmd(cwd: string): string {
    const win = path.join(cwd, '.venv', 'Scripts', 'pip.exe');
    const unix = path.join(cwd, '.venv', 'bin', 'pip');
    if (fs.existsSync(win)) return `"${win}"`;
    if (fs.existsSync(unix)) return unix;
    return 'pip';
  }

  private async commandExists(cmd: string): Promise<boolean> {
    return new Promise(resolve => {
      cp.exec(`${process.platform === 'win32' ? 'where' : 'which'} ${cmd}`, (err) => resolve(!err));
    });
  }

  private async getVersion(cmd: string, flag: string): Promise<string | null> {
    return new Promise(resolve => {
      cp.exec(`${cmd} ${flag}`, (err, stdout, stderr) => {
        if (err) { resolve(null); return; }
        const output = (stdout || stderr).trim();
        const match = output.match(/(\d+\.\d+[\.\d]*)/);
        resolve(match ? match[1] : output);
      });
    });
  }

  private async execAndCapture(cmd: string, cwd: string): Promise<string> {
    return new Promise(resolve => {
      cp.exec(cmd, { cwd }, (err, stdout, stderr) => {
        if (err) { resolve(''); return; }
        resolve((stdout || stderr || '').trim());
      });
    });
  }

  private async execAndCaptureResult(cmd: string, cwd: string): Promise<{ ok: boolean; output: string; errorOutput: string }> {
    return new Promise(resolve => {
      cp.exec(cmd, { cwd }, (err, stdout, stderr) => {
        const output = (stdout || '').trim();
        const errorOutput = (stderr || err?.message || '').trim();
        if (err) { resolve({ ok: false, output, errorOutput }); return; }
        const combinedOutput = `${output}\n${errorOutput}`;
        const hasDockerError = /Error response from daemon|Bind for|port.*already allocated/i.test(combinedOutput);
        resolve({ ok: !hasDockerError, output, errorOutput: hasDockerError ? combinedOutput : '' });
      });
    });
  }

  private async resolveConflict(info: ConflictResolutionInfo): Promise<ConflictResolutionChoice> {
    const missingRuntimePattern = /(not\s+installed|not\s+found|missing|unavailable)/i;

    if (this.troubleshootMode === 'auto') {
      if (info.allowFileInput) {
        this.onLog('[Auto] Could not infer a file path automatically; falling back to manual handling.');
        return 'manual';
      }

      const hasDocker = await this.commandExists('docker');
      if (hasDocker) {
        this.onLog(`[Auto] Resolving ${info.component} conflict with Docker.`);
        return 'docker';
      }

      this.onLog(`[Auto] Docker is unavailable, so ${info.component} will be retried manually.`);
      return 'manual';
    }

    if (this.onRuntimeMissing && info.installUrl && missingRuntimePattern.test(info.message)) {
      await this.onRuntimeMissing({ tool: info.component, installUrl: info.installUrl, projectType: info.projectType, message: info.message });
    }
    this.onLog('[Paused] Installation is waiting for your conflict resolution choice in the extension panel.');
    if (this.onConflictResolution) return await this.onConflictResolution(info);
    return 'manual';
  }

  private async dockerImageExists(image: string, cwd: string): Promise<boolean> {
    const inspect = await this.execAndCaptureResult(`docker image inspect ${image}`, cwd);
    return inspect.ok;
  }

  private async isContainerRunning(containerName: string, cwd: string): Promise<boolean> {
    const result = await this.execAndCapture(`docker inspect -f "{{.State.Running}}" ${containerName}`, cwd);
    return result.trim().toLowerCase() === 'true';
  }

  private async resolveDockerImage(ctx: InstallContext, cwd: string): Promise<string> {
    if (ctx.projectType === 'nodejs') return 'node:20-bookworm';
    if (ctx.projectType === 'python') return 'python:3.11-bookworm';
    if (ctx.projectType === 'php') return fs.existsSync(path.join(cwd, 'composer.json')) ? 'composer:2' : 'php:8.2-cli';
    if (ctx.projectType === 'java') {
      const tool = await this.resolveJavaBuildToolForDocker(cwd);
      return tool === 'gradle' ? 'gradle:8.7-jdk17' : 'maven:3.9-eclipse-temurin-17';
    }
    if (ctx.projectType === 'ruby') return 'ruby:3.3';
    if (ctx.projectType === 'go') return 'golang:1.22';
    return 'ubuntu:24.04';
  }

  private async resolveDockerScript(ctx: InstallContext, cwd: string, port: number): Promise<string> {
    if (ctx.projectType === 'nodejs') {
      const pm = this.detectNodePm(cwd);
      const rawRunCmd = this.resolveNodeRunCommandForDocker(ctx, cwd, pm);
      const runCmd = this.normalizeNodeRunCommandForPackageManager(rawRunCmd, pm);
      const authEnvBootstrap = this.buildNodeDockerAuthEnvBootstrap(cwd, port, runCmd);

      if (pm === 'pnpm') {
        const install = 'corepack enable && corepack prepare pnpm@latest --activate && pnpm install';
        return `${install} && ${authEnvBootstrap}${runCmd}`;
      }

      if (pm === 'yarn') {
        const install = 'corepack enable && corepack prepare yarn@stable --activate && yarn install';
        return `${install} && ${authEnvBootstrap}${runCmd}`;
      }

      const install = fs.existsSync(path.join(cwd, 'package-lock.json')) ? 'npm ci' : 'npm install';
      return `${install} && ${authEnvBootstrap}${runCmd}`;
    }
    if (ctx.projectType === 'python') {
      const install = fs.existsSync(path.join(cwd, 'requirements.txt')) ? 'pip install -r requirements.txt && ' : '';
      const runCmd = (await this.resolveRunCommand(ctx, false)).replace(/^"?[A-Za-z]:[^\s"]*python(?:\.exe)?"?\s+/i, 'python ');
      return `${install}${runCmd}`;
    }
    if (ctx.projectType === 'php') {
      const composerInstall = fs.existsSync(path.join(cwd, 'composer.json')) ? 'composer install && ' : '';
      if (fs.existsSync(path.join(cwd, 'artisan'))) return `${composerInstall}php artisan serve --host=0.0.0.0 --port=${port}`;
      if (fs.existsSync(path.join(cwd, 'public', 'index.php'))) return `${composerInstall}php -S 0.0.0.0:${port} -t public public/index.php`;
      if (fs.existsSync(path.join(cwd, 'index.php'))) return `${composerInstall}php -S 0.0.0.0:${port} -t . index.php`;
      const entry = this.findPhpEntry(cwd);
      return `${composerInstall}php -S 0.0.0.0:${port} -t ${path.dirname(entry) === '.' ? '.' : path.dirname(entry)} ${entry}`;
    }
    if (ctx.projectType === 'java') {
      const tool = await this.resolveJavaBuildToolForDocker(cwd);
      if (!tool || tool === 'maven') return `mvn spring-boot:run -q -Dspring-boot.run.arguments=--server.port=${port}`;
      const hasSpring = await this.fileContains(cwd, 'build.gradle', 'spring-boot') || await this.fileContains(cwd, 'build.gradle.kts', 'spring-boot');
      return hasSpring ? `gradle bootRun --no-daemon --args='--server.port=${port}'` : 'gradle run --no-daemon';
    }
    if (ctx.projectType === 'ruby') {
      if (fs.existsSync(path.join(cwd, 'Gemfile'))) {
        const rails = fs.existsSync(path.join(cwd, 'config', 'application.rb'));
        return rails ? `bundle install && bundle exec rails server -b 0.0.0.0 -p ${port}` : `bundle install && bundle exec ruby ${this.findRubyEntry(cwd)}`;
      }
      return `ruby ${this.findRubyEntry(cwd)}`;
    }
    if (ctx.projectType === 'go') {
      const mainFile = this.findGoMain(cwd);
      return mainFile ? `go run ${mainFile}` : 'go run .';
    }
    return 'sleep infinity';
  }

  private resolveNodeRunCommandForDocker(
    ctx: InstallContext,
    cwd: string,
    pm: 'npm' | 'pnpm' | 'yarn',
  ): string {
    const packageJsonPath = path.join(cwd, 'package.json');
    const scripts = fs.existsSync(packageJsonPath)
      ? (JSON.parse(fs.readFileSync(packageJsonPath, 'utf8')).scripts ?? {})
      : {};

    const normalizedRunCommand = (ctx.runCommand ?? '').trim();
    if (normalizedRunCommand.length > 0) {
      const scriptMatch = normalizedRunCommand.match(/^(?:npm|pnpm|yarn)\s+(?:run\s+)?([\w:-]+)$/i);
      if (!scriptMatch) {
        return normalizedRunCommand;
      }

      const scriptName = scriptMatch[1];
      if (scripts[scriptName]) {
        return `${pm} run ${scriptName}`;
      }

      this.onLog(`[Warning] Backend run command "${normalizedRunCommand}" references missing script "${scriptName}". Falling back.`);
    }

    if (scripts.start) return `${pm} start`;
    if (scripts.dev) return `${pm} run dev`;
    if (scripts.serve) return `${pm} run serve`;
    if (scripts.preview) return `${pm} run preview`;

    return `${pm} run dev`;
  }

  private buildNodeDockerAuthEnvBootstrap(cwd: string, port: number, runCmd: string): string {
    if (!this.isLikelyNextAuthProject(cwd, runCmd)) {
      return '';
    }

    return [
      'if [ -z "$AUTH_SECRET" ]; then export AUTH_SECRET="project-assistant-dev-secret"; fi',
      'if [ -z "$NEXTAUTH_SECRET" ]; then export NEXTAUTH_SECRET="$AUTH_SECRET"; fi',
      `if [ -z "$NEXTAUTH_URL" ]; then export NEXTAUTH_URL="http://localhost:${port}"; fi`,
    ].join(' && ') + ' && ';
  }

  private isLikelyNextAuthProject(cwd: string, runCmd: string): boolean {
    const normalizedCmd = (runCmd || '').toLowerCase();
    if (normalizedCmd.includes('next')) {
      return true;
    }

    const packageJsonPath = path.join(cwd, 'package.json');
    if (!fs.existsSync(packageJsonPath)) {
      return false;
    }

    try {
      const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
      const combinedText = JSON.stringify({
        name: pkg.name,
        dependencies: pkg.dependencies ?? {},
        devDependencies: pkg.devDependencies ?? {},
      }).toLowerCase();

      return (
        combinedText.includes('next-auth')
        || combinedText.includes('@auth/core')
        || combinedText.includes('@auth/')
      );
    } catch {
      return false;
    }
  }

  private normalizeNodeRunCommandForPackageManager(cmd: string, pm: 'npm' | 'pnpm' | 'yarn'): string {
    const trimmed = (cmd || '').trim();
    if (!trimmed) return trimmed;

    if (pm === 'pnpm') {
      return trimmed
        .replace(/^npm\s+run\s+/i, 'pnpm run ')
        .replace(/^npm\s+/i, 'pnpm ')
        .replace(/^yarn\s+run\s+/i, 'pnpm run ')
        .replace(/^yarn\s+/i, 'pnpm ');
    }

    if (pm === 'yarn') {
      return trimmed
        .replace(/^npm\s+run\s+/i, 'yarn ')
        .replace(/^npm\s+/i, 'yarn ')
        .replace(/^pnpm\s+run\s+/i, 'yarn ')
        .replace(/^pnpm\s+/i, 'yarn ');
    }

    return trimmed
      .replace(/^pnpm\s+run\s+/i, 'npm run ')
      .replace(/^pnpm\s+/i, 'npm ')
      .replace(/^yarn\s+run\s+/i, 'npm run ')
      .replace(/^yarn\s+/i, 'npm ');
  }

  private findRubyEntry(cwd: string): string {
    for (const f of ['app.rb', 'main.rb', 'server.rb']) { if (fs.existsSync(path.join(cwd, f))) return f; }
    return 'main.rb';
  }

  private runCommand(cmd: string, cwd: string, projectId: string): Promise<boolean> {
    return new Promise(resolve => {
      if (this.cancelled) { resolve(false); return; }
      this.onLog(`[Run] ${cmd}`);
      const commandOutput: string[] = [];
      const proc = cp.spawn(cmd, [], { cwd, shell: true, stdio: ['ignore', 'pipe', 'pipe'] });
      proc.stdout?.on('data', (d: Buffer) => d.toString().split('\n').filter(Boolean).forEach(l => {
        const msg = l.trim();
        commandOutput.push(msg);
        this.onLog(msg);
      }));
      proc.stderr?.on('data', (d: Buffer) => d.toString().split('\n').filter(Boolean).forEach(l => {
        const msg = l.trim();
        commandOutput.push(msg);
        this.onLog(msg, 'stderr');
      }));
      proc.on('close', code => {
        this.lastCommandOutput = commandOutput.join('\n');
        resolve(code === 0);
      });
      proc.on('error', err => {
        this.lastCommandOutput = `${commandOutput.join('\n')}\n${err.message}`;
        this.onLog(`[Error] ${err.message}`, 'error');
        resolve(false);
      });
    });
  }

  private waitForPort(port: number, timeoutMs: number): Promise<boolean> {
    return new Promise(resolve => {
      const start = Date.now();
      const net = require('net');
      const check = () => {
        if (Date.now() - start > timeoutMs) { resolve(false); return; }
        const sock = new net.Socket();
        sock.setTimeout(500);
        sock.on('connect', () => { sock.destroy(); resolve(true); });
        sock.on('error', () => { sock.destroy(); setTimeout(check, 1000); });
        sock.on('timeout', () => { sock.destroy(); setTimeout(check, 1000); });
        sock.connect(port, '127.0.0.1');
      };
      check();
    });
  }

  private shouldRequireHttpReadiness(projectType: string): boolean {
    return ['nodejs', 'python', 'php', 'ruby', 'go', 'java'].includes(projectType);
  }

  private getDockerHttpReadinessTimeoutMs(projectType: string): number {
    if (projectType === 'nodejs') {
      // Monorepos can spend several minutes on first pnpm install before app boot.
      return 8 * 60_000;
    }
    if (projectType === 'python') {
      // Older Django apps can take longer to import settings, run startup hooks, and warm caches.
      return 4 * 60_000;
    }
    if (projectType === 'java') {
      return 4 * 60_000;
    }
    return 60_000;
  }

  private waitForHttpReady(port: number, timeoutMs: number): Promise<boolean> {
    return new Promise(resolve => {
      const start = Date.now();
      const http = require('http');

      const probe = () => {
        if (Date.now() - start > timeoutMs) {
          resolve(false);
          return;
        }

        const req = http.get({
          host: '127.0.0.1',
          port,
          path: '/',
          timeout: 1500,
        }, (res: any) => {
          res.resume();
          resolve(true);
        });

        req.on('error', () => setTimeout(probe, 1000));
        req.on('timeout', () => {
          req.destroy();
          setTimeout(probe, 1000);
        });
      };

      probe();
    });
  }

  private async isPortAvailable(port: number): Promise<boolean> {
    const hasActiveListener = (await this.canConnectToPort(port, '127.0.0.1')) || (await this.canConnectToPort(port, '::1'));
    if (hasActiveListener) return false;
    return (await this.canBindPort(port, '0.0.0.0')) || (await this.canBindPort(port, '::'));
  }

  private canConnectToPort(port: number, host: string): Promise<boolean> {
    return new Promise(resolve => {
      const net = require('net');
      const socket = new net.Socket();
      let resolved = false;
      const finish = (v: boolean) => { if (!resolved) { resolved = true; socket.destroy(); resolve(v); } };
      socket.setTimeout(400);
      socket.once('connect', () => finish(true));
      socket.once('timeout', () => finish(false));
      socket.once('error', () => finish(false));
      socket.connect(port, host);
    });
  }

  private canBindPort(port: number, host: string): Promise<boolean> {
    return new Promise(resolve => {
      const net = require('net');
      const server = net.createServer();
      let resolved = false;
      const finish = (v: boolean) => { if (!resolved) { resolved = true; resolve(v); } };
      server.once('error', () => finish(false));
      server.once('listening', () => { server.close(() => finish(true)); });
      server.listen(port, host);
    });
  }

  private async findAvailablePort(startPort: number, maxAttempts: number = 50): Promise<number | null> {
    for (let i = 0; i < maxAttempts; i++) {
      const candidate = startPort + i;
      if (await this.isPortAvailable(candidate)) return candidate;
    }
    return null;
  }

  private async reportProgress(projectId: string, progress: number, step: string): Promise<void> {
    this.onLog(`[${progress}%] ${step}`);
    try {
      await this.apiClient.post(`/api/projects/${projectId}/install-progress`, { progress, step });
    } catch (err: any) {
      if (err?.response?.status === 401) this.onLog('[Warning] Session expired — progress will not sync to dashboard', 'stderr');
    }
  }

  private async reportComplete(projectId: string, success: boolean, port?: number, error?: string): Promise<void> {
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        await this.publicApiClient.post(`/api/projects/${projectId}/install-complete`, { success, port, error });
        return;
      } catch (err: any) {
        if (attempt === 3) this.onLog(`[Warning] Could not report completion to backend after ${attempt} attempts`, 'stderr');
        else await new Promise(r => setTimeout(r, attempt * 1000));
      }
    }
  }
}