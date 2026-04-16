import * as cp from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import axios, { AxiosInstance } from 'axios';

export interface InstallContext {
  projectId: string;
  hostPath: string;
  projectType: string;
  detectedPm: string;
  runCommand?: string;
  launchPort?: number;
  envVars?: Record<string, string>;
  versionConstraints?: Record<string, string>;
}

export interface RuntimeMissingInfo {
  tool: string;
  installUrl: string;
  projectType: string;
  message: string;
}

export type ConflictResolutionChoice = 'docker' | 'manual';

export interface ConflictResolutionInfo {
  component: string;
  projectType: string;
  message: string;
  installUrl?: string;
}

class DockerFallbackRequestedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DockerFallbackRequestedError';
  }
}

export class LocalInstaller {
  private proc: cp.ChildProcess | null = null;
  private cancelled = false;
  private lastLaunchPort: number | undefined;

  constructor(
    private readonly apiClient: AxiosInstance,
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

    try {
      // Step 1: detect conflicts (local version check)
      await this.reportProgress(ctx.projectId, 10, 'Checking environment');
      const useVenv = await this.checkConflicts(ctx);

      // Step 2: install dependencies
      await this.reportProgress(ctx.projectId, 30, 'Installing dependencies');
      const installOk = await this.runInstall(ctx, useVenv);
      if (!installOk) return false;

      // Step 3: write .env if needed
      await this.reportProgress(ctx.projectId, 80, 'Writing configuration');
      await this.writeEnvFile(ctx);

      // Step 4: launch
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
      useVenv = true; // always use venv for Python — best practice
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
      // Only install if package.json exists
      if (!fs.existsSync(path.join(cwd, 'package.json'))) {
        this.onLog('[Warning] No package.json found, skipping npm install');
        return true;
      }
      const pm = this.detectNodePm(cwd);
      this.onLog(`[Info] Package manager: ${pm}`);
      return await this.runCommand(`${pm} install`, cwd, ctx.projectId);
    }

    if (ctx.projectType === 'python') {
      const hasPyproject = fs.existsSync(path.join(cwd, 'pyproject.toml'));
      const hasPipfile   = fs.existsSync(path.join(cwd, 'Pipfile'));
      const hasReqs      = fs.existsSync(path.join(cwd, 'requirements.txt'));

      if (!hasPyproject && !hasPipfile && !hasReqs) {
        this.onLog('[Warning] No dependency file found (requirements.txt / pyproject.toml / Pipfile). Skipping install.');
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

      // pip path
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
      return await this.runCommand('composer install', cwd, ctx.projectId);
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
    const reqFile = path.join(cwd, 'requirements.txt');
    if (!fs.existsSync(reqFile)) {
      this.onLog('[Warning] No requirements.txt found, skipping pip install');
      return true;
    }

    // First attempt: pinned versions
    const pip = this.getPipCmd(cwd);
    const ok = await this.runCommand(`${pip} install -r requirements.txt`, cwd, projectId);
    if (ok) return true;

    // Second attempt: each package individually with unpinned fallback
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
        // continue even if fallback fails — some packages are optional
      }
    }
    return true;
  }

  // ── Private: .env writing ────────────────────────────────────────

  private async writeEnvFile(ctx: InstallContext): Promise<void> {
    if (!ctx.envVars || Object.keys(ctx.envVars).length === 0) return;

    const envPath = path.join(ctx.hostPath, '.env');
    const examplePath = path.join(ctx.hostPath, '.env.example');

    // Start from .env.example if it exists
    let existing: Record<string, string> = {};
    if (fs.existsSync(examplePath)) {
      const lines = fs.readFileSync(examplePath, 'utf8').split('\n');
      for (const line of lines) {
        const match = line.match(/^([^=]+)=(.*)$/);
        if (match) existing[match[1].trim()] = match[2].trim();
      }
    }

    // Merge with NLP-extracted env vars
    const merged = { ...existing, ...ctx.envVars };
    const content = Object.entries(merged)
      .map(([k, v]) => `${k}=${v}`)
      .join('\n');

    fs.writeFileSync(envPath, content, 'utf8');
    this.onLog(`[Info] Written .env (${Object.keys(merged).length} variables)`);
  }

  // ── Private: launch ──────────────────────────────────────────────

  private async launch(ctx: InstallContext, useVenv: boolean): Promise<number> {
    const cwd = ctx.hostPath;

    // ── Always re-derive the command from what's actually on disk ──
    // Never trust ctx.runCommand from NLP — it may reference tools
    // that aren't installed (poetry, pipenv, etc.)
    const cmd = await this.resolveRunCommand(ctx, useVenv);
    const port = await this.resolvePort(ctx);

    this.onLog(`[Launch] Starting: ${cmd}`);
    this.onLog(`[Launch] cwd: ${cwd}`);
    this.onLog(`[Launch] port: ${port}`);

    const launchEnv: NodeJS.ProcessEnv = {
      ...process.env,
      PORT: String(port),
    };

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
      d.toString().split('\n').filter(Boolean)
        .forEach(line => this.onLog(line.trim()))
    );
    this.proc.stderr?.on('data', (d: Buffer) =>
      d.toString().split('\n').filter(Boolean)
        .forEach(line => this.onLog(line.trim(), 'stderr'))
    );

    // Give process 2s to crash before checking port
    await new Promise(r => setTimeout(r, 2000));
    if (this.proc.exitCode !== null && this.proc.exitCode !== 0) {
      throw new Error(
        `Process exited immediately with code ${this.proc.exitCode}. ` +
        `Check the output above for errors.`
      );
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


  private async resolveRunCommand(
    ctx: InstallContext,
    useVenv: boolean,
  ): Promise<string> {
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
              this.onLog(
                `[Warning] Backend run command "${normalizedRunCommand}" references missing script "${scriptName}". Falling back to detected scripts.`
              );
            } else {
              return normalizedRunCommand;
            }
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

    // ── Node.js ───────────────────────────────────────────────────
    if (ctx.projectType === 'nodejs') {
      const pm = this.detectNodePm(cwd);
      const pkg = path.join(cwd, 'package.json');
      if (fs.existsSync(pkg)) {
        const scripts = JSON.parse(fs.readFileSync(pkg, 'utf8')).scripts ?? {};
        if (scripts.start) return `${pm} start`;
        if (scripts.dev)   return `${pm} run dev`;
        if (scripts.serve) return `${pm} run serve`;
        if (scripts.preview) return `${pm} run preview`;

        const scriptNames = Object.keys(scripts);
        throw new Error(
          `No runnable Node script found. Expected one of start/dev/serve/preview, but found: ` +
          (scriptNames.length ? scriptNames.join(', ') : 'none')
        );
      }
      throw new Error('No package.json found to determine Node launch command.');
    }

    // ── Python ────────────────────────────────────────────────────
    if (ctx.projectType === 'python') {

      // Find the actual python binary to use
      const pythonBin = this.resolvePythonBin(cwd, useVenv);

      // Priority 1: manage.py → Django (search recursively)
      const managePy = await this.findFileRecursive(cwd, 'manage.py');
      if (managePy) {
        const port = await this.resolvePort(ctx);
        return `${pythonBin} ${managePy} runserver 0.0.0.0:${port}`;
      }

      // Priority 2: known entry points (search recursively)
      for (const f of ['app.py', 'main.py', 'run.py', 'server.py', 'wsgi.py']) {
        const found = await this.findFileRecursive(cwd, f);
        if (found) {
          return `${pythonBin} ${found}`;
        }
      }

      // Priority 3: check if uvicorn is installed and there's an asgi app (search recursively)
      for (const f of ['asgi.py', 'application.py']) {
        const found = await this.findFileRecursive(cwd, f);
        if (found) {
          const port = await this.resolvePort(ctx);
          const module = found.replace(/\.py$/, '').replace(/[\\/]/g, '.');
          return `${pythonBin} -m uvicorn ${module}:app --host 0.0.0.0 --port ${port}`;
        }
      }

      // Priority 4: fall back to flask run if flask is in requirements
      if (await this.requirementsMentions(cwd, 'flask')) {
        const port = await this.resolvePort(ctx);
        return `${pythonBin} -m flask run --host=0.0.0.0 --port=${port}`;
      }

      // Priority 5: nothing found — tell the user clearly
      throw new Error(
        `Cannot determine how to start this Python project. ` +
        `No manage.py, app.py, main.py, or run.py found in ${cwd} or subdirectories.`
      );
    }

    // ── PHP ───────────────────────────────────────────────────────
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

    // ── Java ─────────────────────────────────────────────────────
    if (ctx.projectType === 'java') {
      const tool = await this.resolveJavaBuildTool(cwd);
      if (!tool) {
        throw new Error('No Java build tool found for this project');
      }

      if (tool === 'maven') {
        if (await this.fileContains(cwd, 'pom.xml', 'spring-boot')) {
          return 'mvn spring-boot:run -q';
        }
        return 'mvn spring-boot:run -q';
      }

      const gradlew = this.gradleWrapper(cwd);
      if (await this.fileContains(cwd, 'build.gradle', 'spring-boot') || await this.fileContains(cwd, 'build.gradle.kts', 'spring-boot')) {
        return `${gradlew} bootRun`;
      }
      return `${gradlew} run`;
    }

    // ── Ruby ─────────────────────────────────────────────────────
    if (ctx.projectType === 'ruby') {
      const port = await this.resolvePort(ctx);

      if (fs.existsSync(path.join(cwd, 'config', 'application.rb'))) {
        return `bundle exec rails server -p ${port}`;
      }

      for (const f of ['app.rb', 'main.rb', 'server.rb', 'config.ru']) {
        if (fs.existsSync(path.join(cwd, f))) {
          if (f === 'config.ru') return `bundle exec rackup --port ${port}`;
          return `bundle exec ruby ${f}`;
        }
      }

      throw new Error('Cannot determine Ruby entry point');
    }

    // ── Go ───────────────────────────────────────────────────────
    if (ctx.projectType === 'go') {
      const mainFile = this.findGoMain(cwd);
      if (mainFile) {
        return `go run ${mainFile}`;
      }
      return 'go run .';
    }

    throw new Error(`Unsupported project type: ${ctx.projectType}`);
  }

  private shouldWaitForPort(projectType: string, cmd: string): boolean {
    const normalized = cmd.toLowerCase();

    if (projectType === 'java') {
      // For Java, only block on port readiness for likely web/server commands.
      return (
        normalized.includes('spring-boot:run') ||
        normalized.includes('bootrun') ||
        normalized.includes('quarkus') ||
        normalized.includes('micronaut') ||
        normalized.includes('java -jar')
      );
    }

    // Keep current behavior for other ecosystems.
    return true;
  }


  private resolvePythonBin(cwd: string, useVenv: boolean): string {
    if (useVenv) {
      // Windows venv
      const win = path.join(cwd, '.venv', 'Scripts', 'python.exe');
      if (fs.existsSync(win)) return `"${win}"`;
      // Unix venv
      const unix = path.join(cwd, '.venv', 'bin', 'python');
      if (fs.existsSync(unix)) return unix;
    }
    // System python
    return process.platform === 'win32' ? 'python' : 'python3';
  }


  private async resolvePort(ctx: InstallContext): Promise<number> {
    // Check if the originally intended port is free
    const intended = ctx.launchPort ?? this.defaultPort(ctx.projectType);
    if (!this.isPortInUse(intended)) return intended;

    // Find next free port
    for (let p = intended + 1; p < intended + 100; p++) {
      if (!this.isPortInUse(p)) {
        this.onLog(`[Conflict] Port ${intended} is in use. Using port ${p} instead`);
        return p;
      }
    }
    return intended;
  }

  private defaultPort(projectType: string): number {
    const ports: Record<string, number> = {
      nodejs: 3000,
      python: 8000,
      php: 8000,
      java: 8080,
      ruby: 3000,
      go: 8080,
    };

    return ports[projectType] ?? 3000;
  }


  private isPortInUse(port: number): boolean {
    // Synchronous check using net
    const net = require('net');
    const server = net.createServer();
    try {
      server.listen(port, '127.0.0.1');
      server.close();
      return false;
    } catch {
      return true;
    }
  }


  private async requirementsMentions(cwd: string, pkg: string): Promise<boolean> {
    const req = path.join(cwd, 'requirements.txt');
    if (!fs.existsSync(req)) return false;
    return fs.readFileSync(req, 'utf8').toLowerCase().includes(pkg.toLowerCase());
  }

  private async checkNodePmAvailable(cwd: string): Promise<void> {
    const pm = this.detectNodePm(cwd);
    if (pm === 'npm') {
      return;
    }

    const exists = await this.commandExists(pm);
    if (!exists) {
      this.onLog(`[Warning] ${pm} not found, falling back to npm`);
    }
  }

  private async resolveJavaBuildTool(cwd: string): Promise<'maven' | 'gradle' | null> {
    if (fs.existsSync(path.join(cwd, 'pom.xml')) && await this.commandExists('mvn')) {
      return 'maven';
    }

    const hasGradleFile = fs.existsSync(path.join(cwd, 'build.gradle')) || fs.existsSync(path.join(cwd, 'build.gradle.kts'));
    if (hasGradleFile && (fs.existsSync(path.join(cwd, 'gradlew')) || fs.existsSync(path.join(cwd, 'gradlew.bat')) || await this.commandExists('gradle'))) {
      return 'gradle';
    }

    return null;
  }

  private async resolveJavaBuildToolForDocker(cwd: string): Promise<'maven' | 'gradle' | null> {
    const pom = await this.findFileRecursive(cwd, 'pom.xml', 3);
    if (pom) {
      return 'maven';
    }

    const gradle = await this.findFileRecursive(cwd, 'build.gradle', 3)
      || await this.findFileRecursive(cwd, 'build.gradle.kts', 3);
    if (gradle) {
      return 'gradle';
    }

    return null;
  }

  private gradleWrapper(cwd: string): string {
    const win = path.join(cwd, 'gradlew.bat');
    const unix = path.join(cwd, 'gradlew');
    if (process.platform === 'win32' && fs.existsSync(win)) return 'gradlew.bat';
    if (fs.existsSync(unix)) return './gradlew';
    return 'gradle';
  }

  private async getGradleVersion(cwd: string): Promise<string | null> {
    const wrapperVersion = this.getGradleVersionFromWrapper(cwd);
    if (wrapperVersion) {
      return wrapperVersion;
    }

    const cmd = `${this.gradleWrapper(cwd)} --version`;
    const output = await this.execAndCapture(cmd, cwd);
    if (!output) {
      return null;
    }

    const match = output.match(/Gradle\s+(\d+(?:\.\d+){0,2})/i);
    return match ? match[1] : null;
  }

  private getGradleVersionFromWrapper(cwd: string): string | null {
    const wrapperPropsPath = path.join(cwd, 'gradle', 'wrapper', 'gradle-wrapper.properties');
    if (!fs.existsSync(wrapperPropsPath)) {
      return null;
    }

    try {
      const content = fs.readFileSync(wrapperPropsPath, 'utf8');
      const match = content.match(/distributionUrl=.*gradle-(\d+(?:\.\d+){0,2})-(?:bin|all)\.zip/i);
      return match ? match[1] : null;
    } catch {
      return null;
    }
  }

  private isGradleJavaIncompatible(gradleVersion: string | null, javaVersion: string | null): boolean {
    if (!gradleVersion || !javaVersion) {
      return false;
    }

    const gradleMajor = parseInt(gradleVersion.split('.')[0], 10);
    const javaMajor = parseInt(javaVersion.split('.')[0], 10);
    if (Number.isNaN(gradleMajor) || Number.isNaN(javaMajor)) {
      return false;
    }

    if (javaMajor >= 17 && gradleMajor < 7) {
      return true;
    }

    if (javaMajor >= 21 && gradleMajor < 8) {
      return true;
    }

    return false;
  }

    private findPhpEntry(cwd: string): string {
      // Common entry points in order of priority
      const candidates = [
        'index.php',
        'public/index.php',
        'public_html/index.php',
        'src/index.php',
        'app/index.php',
        'www/index.php',
      ];

      for (const f of candidates) {
        if (fs.existsSync(path.join(cwd, f))) return f;
      }

      // Last resort — find any .php file in root
      const rootPhp = fs.readdirSync(cwd).find(f => f.endsWith('.php'));
      return rootPhp ?? 'index.php';
    }

  private findGoMain(cwd: string): string | null {
    if (fs.existsSync(path.join(cwd, 'main.go'))) {
      return 'main.go';
    }

    const cmdDir = path.join(cwd, 'cmd');
    if (fs.existsSync(cmdDir)) {
      const subdirs = fs.readdirSync(cmdDir, { withFileTypes: true }).filter((entry) => entry.isDirectory());
      if (subdirs.length > 0) {
        return `./cmd/${subdirs[0].name}`;
      }
    }

    return null;
  }

  private async fileContains(cwd: string, file: string, text: string): Promise<boolean> {
    const fullPath = path.join(cwd, file);
    if (!fs.existsSync(fullPath)) return false;
    return fs.readFileSync(fullPath, 'utf8').includes(text);
  }
  private inferRunCommand(ctx: InstallContext, useVenv: boolean): string {
    if (ctx.projectType === 'nodejs') {
      const pm = this.detectNodePm(ctx.hostPath);
      return `${pm} start`;
    }
    if (ctx.projectType === 'python') {
      // Check for common entry points
      const candidates = ['manage.py', 'app.py', 'main.py', 'run.py', 'wsgi.py'];
      for (const f of candidates) {
        if (fs.existsSync(path.join(ctx.hostPath, f))) {
          if (f === 'manage.py') return 'python manage.py runserver';
          return `python ${f}`;
        }
      }
      return 'python app.py';
    }
    return '';
  }

  private async shouldSkipCraPreflight(cwd: string, cmd: string): Promise<boolean> {
    if (!cmd.includes('npm start') && !cmd.includes('react-scripts start')) {
      return false;
    }

    const packageJsonPath = path.join(cwd, 'package.json');
    if (!fs.existsSync(packageJsonPath)) {
      return false;
    }

    try {
      const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
      const scripts = packageJson.scripts ?? {};
      const dependencies = {
        ...(packageJson.dependencies ?? {}),
        ...(packageJson.devDependencies ?? {}),
      };

      return Boolean(
        String(scripts.start ?? '').includes('react-scripts') ||
        dependencies['react-scripts']
      );
    } catch {
      return false;
    }
  }

  private async shouldEnableLegacyOpenSsl(cwd: string, cmd: string): Promise<boolean> {
    const packageJsonPath = path.join(cwd, 'package.json');
    if (!fs.existsSync(packageJsonPath)) {
      return false;
    }

    try {
      const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
      const scripts = packageJson.scripts ?? {};
      const dependencies = {
        ...(packageJson.dependencies ?? {}),
        ...(packageJson.devDependencies ?? {}),
      };

      const startScript = String(scripts.start ?? '');
      const usesReactScripts = startScript.includes('react-scripts') || Boolean(dependencies['react-scripts']);
      const usesWebpack4 = /^4\./.test(String(dependencies.webpack ?? ''));
      const launchesFrontendDev = /npm\s+start|react-scripts\s+start|webpack-dev-server/.test(cmd);

      return launchesFrontendDev && (usesReactScripts || usesWebpack4);
    } catch {
      return false;
    }
  }

  // ── Private: helpers ─────────────────────────────────────────────

  private async findFileRecursive(cwd: string, filename: string, maxDepth: number = 3, currentDepth: number = 0): Promise<string | null> {
    if (currentDepth > maxDepth) return null;

    const fullPath = path.join(cwd, filename);
    if (fs.existsSync(fullPath)) {
      return filename;
    }

    try {
      const entries = fs.readdirSync(cwd, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory() && !entry.name.startsWith('.')) {
          const subPath = path.join(cwd, entry.name);
          const result = await this.findFileRecursive(subPath, filename, maxDepth, currentDepth + 1);
          if (result) {
            return path.join(entry.name, result).replace(/\\/g, '/');
          }
        }
      }
    } catch {
      // If directory read fails, continue
    }

    return null;
  }

  private detectNodePm(cwd: string): string {
    if (fs.existsSync(path.join(cwd, 'pnpm-lock.yaml'))) return 'pnpm';
    if (fs.existsSync(path.join(cwd, 'yarn.lock'))) return 'yarn';
    return 'npm';
  }

  private detectPythonPm(cwd: string): string {
    if (fs.existsSync(path.join(cwd, 'pyproject.toml'))) return 'poetry';
    if (fs.existsSync(path.join(cwd, 'Pipfile'))) return 'pipenv';
    return 'pip';
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
      cp.exec(`${process.platform === 'win32' ? 'where' : 'which'} ${cmd}`,
        (err) => resolve(!err)
      );
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
    return new Promise((resolve) => {
      cp.exec(cmd, { cwd }, (err: cp.ExecException | null, stdout: string, stderr: string) => {
        if (err) {
          resolve('');
          return;
        }
        resolve((stdout || stderr || '').trim());
      });
    });
  }

  private async execAndCaptureResult(
    cmd: string,
    cwd: string,
  ): Promise<{ ok: boolean; output: string; errorOutput: string }> {
    return new Promise((resolve) => {
      cp.exec(cmd, { cwd }, (err: cp.ExecException | null, stdout: string, stderr: string) => {
        const output = (stdout || '').trim();
        const errorOutput = (stderr || err?.message || '').trim();
        if (err) {
          resolve({ ok: false, output, errorOutput });
          return;
        }
        resolve({ ok: true, output: output || errorOutput, errorOutput: '' });
      });
    });
  }

  private async resolveConflict(info: ConflictResolutionInfo): Promise<ConflictResolutionChoice> {
    const missingRuntimePattern = /(not\s+installed|not\s+found|missing|unavailable)/i;
    if (this.onRuntimeMissing && info.installUrl && missingRuntimePattern.test(info.message)) {
      await this.onRuntimeMissing({
        tool: info.component,
        installUrl: info.installUrl,
        projectType: info.projectType,
        message: info.message,
      });
    }

    this.onLog('[Paused] Installation is waiting for your conflict resolution choice in the extension panel.');

    if (this.onConflictResolution) {
      return await this.onConflictResolution(info);
    }

    return 'manual';
  }

  private async runDockerFallback(ctx: InstallContext): Promise<number> {
    await this.reportProgress(ctx.projectId, 35, 'Preparing Docker fallback');

    const hasDocker = await this.commandExists('docker');
    if (!hasDocker) {
      throw new Error('Docker is not installed or not in PATH. Install Docker Desktop and retry.');
    }

    const cwd = ctx.hostPath;
    let port = await this.resolvePort(ctx);
    const normalizedPath = cwd.replace(/\\/g, '/');
    const containerBaseName = `pa-${ctx.projectId.slice(-8)}-${Date.now()}`;

    const image = await this.resolveDockerImage(ctx, cwd);

    const hasImage = await this.dockerImageExists(image, cwd);
    if (!hasImage) {
      const approved = this.onDockerImagePullApproval
        ? await this.onDockerImagePullApproval(image)
        : false;

      if (!approved) {
        throw new Error(`Docker image ${image} is not available locally and pull was not approved.`);
      }

      this.onLog(`[Docker] Pulling image ${image}...`);
      const pullResult = await this.execAndCaptureResult(`docker pull ${image}`, cwd);
      if (!pullResult.ok) {
        const details = pullResult.errorOutput || pullResult.output || 'No output from docker pull.';
        this.onLog(`[Docker] docker pull failed: ${details}`, 'error');
        throw new Error(`Failed to pull Docker image ${image}. ${details}`);
      }
      this.onLog(`[Docker] Image ready: ${image}`);
    }

    let containerName = '';
    let containerId = '';
    let lastDockerError = '';

    for (let attempt = 1; attempt <= 6; attempt += 1) {
      containerName = `${containerBaseName}-${attempt}`;

      const containerScript = await this.resolveDockerScript(ctx, cwd, port);
      const escapedScript = containerScript.replace(/"/g, '\\"');

      await this.execAndCapture(`docker rm -f ${containerName}`, cwd);

      const dockerRunCmd =
        `docker run -d --name ${containerName} --rm ` +
        `--entrypoint sh ` +
        `-p ${port}:${port} -w /workspace ` +
        `-v "${normalizedPath}:/workspace" -e PORT=${port} ` +
        `${image} -lc "${escapedScript}"`;

      this.onLog(`[Docker] Starting container with image ${image} on port ${port} (attempt ${attempt}/6)`);
      const dockerRun = await this.execAndCaptureResult(dockerRunCmd, cwd);
      containerId = dockerRun.output;

      if (dockerRun.ok && containerId) {
        break;
      }

      const details = dockerRun.errorOutput || 'No stderr output from docker command.';
      lastDockerError = details;

      const portBusy = /port is already allocated|bind for 0\.0\.0\.0:\d+ failed/i.test(details);
      if (!portBusy || attempt === 6) {
        this.onLog(`[Docker] docker run failed: ${details}`, 'error');
        throw new Error(`Failed to start Docker container. ${details}`);
      }

      const nextPort = await this.findAvailablePort(port + 1, 100);
      if (!nextPort) {
        this.onLog(`[Docker] docker run failed: ${details}`, 'error');
        throw new Error(`Failed to start Docker container. ${details}`);
      }

      this.onLog(`[Docker] Port ${port} is busy. Retrying on port ${nextPort}.`, 'warning');
      port = nextPort;
    }

    if (!containerId) {
      const details = lastDockerError || 'Unknown docker run error.';
      this.onLog(`[Docker] docker run failed: ${details}`, 'error');
      throw new Error(`Failed to start Docker container. ${details}`);
    }

    this.onLog(`[Docker] Container started: ${containerName}`);
    this.onLog(`[Docker] Logs: docker logs -f ${containerName}`);

    await this.reportProgress(ctx.projectId, 90, 'Launching application in Docker');
    const waitMs = ctx.projectType === 'java' ? 180_000 : 90_000;
    const bound = await this.waitForPort(port, waitMs);
    if (!bound) {
      const running = await this.isContainerRunning(containerName, cwd);
      const recentLogs = await this.execAndCapture(`docker logs --tail 80 ${containerName}`, cwd);

      if (!running) {
        throw new Error(
          `Docker container exited before becoming ready on port ${port}. ` +
          `Recent logs:\n${recentLogs || 'No container logs available.'}`
        );
      }

      throw new Error(
        `Docker container is running but port ${port} is not responding after ${Math.round(waitMs / 1000)}s. ` +
        `Recent logs:\n${recentLogs || 'No container logs available.'}`
      );
    }

    return port;
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
    if (ctx.projectType === 'php') {
      return fs.existsSync(path.join(cwd, 'composer.json')) ? 'composer:2' : 'php:8.2-cli';
    }
    if (ctx.projectType === 'java') {
      const tool = await this.resolveJavaBuildToolForDocker(cwd);
      if (!tool) {
        this.onLog('[Warning] Could not detect pom.xml/build.gradle. Defaulting Java Docker image to Maven.', 'warning');
      }
      return tool === 'gradle' ? 'gradle:8.7-jdk17' : 'maven:3.9-eclipse-temurin-17';
    }
    if (ctx.projectType === 'ruby') return 'ruby:3.3';
    if (ctx.projectType === 'go') return 'golang:1.22';
    return 'ubuntu:24.04';
  }

  private async resolveDockerScript(ctx: InstallContext, cwd: string, port: number): Promise<string> {
    if (ctx.projectType === 'nodejs') {
      const install = fs.existsSync(path.join(cwd, 'package-lock.json')) ? 'npm ci' : 'npm install';
      const runCmd = (await this.resolveRunCommand(ctx, false)).replace(/^pnpm\s+|^yarn\s+/, 'npm ');
      return `${install} && ${runCmd}`;
    }

    if (ctx.projectType === 'python') {
      const install = fs.existsSync(path.join(cwd, 'requirements.txt')) ? 'pip install -r requirements.txt && ' : '';
      const runCmd = (await this.resolveRunCommand(ctx, false)).replace(/^"?[A-Za-z]:[^\s"]*python(?:\.exe)?"?\s+/i, 'python ');
      return `${install}${runCmd}`;
    }

    if (ctx.projectType === 'php') {
      const composerInstall = fs.existsSync(path.join(cwd, 'composer.json')) ? 'composer install && ' : '';
      if (fs.existsSync(path.join(cwd, 'artisan'))) {
        return `${composerInstall}php artisan serve --host=0.0.0.0 --port=${port}`;
      }
      const publicIndex = path.join(cwd, 'public', 'index.php');
      if (fs.existsSync(publicIndex)) {
        return `${composerInstall}php -S 0.0.0.0:${port} -t public public/index.php`;
      }

      const rootIndex = path.join(cwd, 'index.php');
      if (fs.existsSync(rootIndex)) {
        return `${composerInstall}php -S 0.0.0.0:${port} -t . index.php`;
      }

      const entry = this.findPhpEntry(cwd);
      return `${composerInstall}php -S 0.0.0.0:${port} -t ${path.dirname(entry) === '.' ? '.' : path.dirname(entry)} ${entry}`;
    }

    if (ctx.projectType === 'java') {
      const tool = await this.resolveJavaBuildToolForDocker(cwd);
      if (!tool || tool === 'maven') {
        return `mvn spring-boot:run -q -Dspring-boot.run.arguments=--server.port=${port}`;
      }

      const hasSpring = await this.fileContains(cwd, 'build.gradle', 'spring-boot')
        || await this.fileContains(cwd, 'build.gradle.kts', 'spring-boot');
      return hasSpring
        ? `gradle bootRun --no-daemon --args='--server.port=${port}'`
        : 'gradle run --no-daemon';
    }

    if (ctx.projectType === 'ruby') {
      if (fs.existsSync(path.join(cwd, 'Gemfile'))) {
        const rails = fs.existsSync(path.join(cwd, 'config', 'application.rb'));
        return rails
          ? `bundle install && bundle exec rails server -b 0.0.0.0 -p ${port}`
          : `bundle install && bundle exec ruby ${this.findRubyEntry(cwd)}`;
      }
      return `ruby ${this.findRubyEntry(cwd)}`;
    }

    if (ctx.projectType === 'go') {
      const mainFile = this.findGoMain(cwd);
      return mainFile ? `go run ${mainFile}` : 'go run .';
    }

    return 'sleep infinity';
  }

  private findRubyEntry(cwd: string): string {
    for (const f of ['app.rb', 'main.rb', 'server.rb']) {
      if (fs.existsSync(path.join(cwd, f))) {
        return f;
      }
    }
    return 'main.rb';
  }

  private runCommand(
    cmd: string,
    cwd: string,
    projectId: string,
  ): Promise<boolean> {
    return new Promise(resolve => {
      if (this.cancelled) { resolve(false); return; }

      this.onLog(`[Run] ${cmd}`);
      const proc = cp.spawn(cmd, [], {
        cwd,
        shell: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      proc.stdout?.on('data', (d: Buffer) =>
        d.toString().split('\n').filter(Boolean)
          .forEach(line => this.onLog(line.trim()))
      );
      proc.stderr?.on('data', (d: Buffer) =>
        d.toString().split('\n').filter(Boolean)
          .forEach(line => this.onLog(line.trim(), 'stderr'))
      );

      proc.on('close', code => resolve(code === 0));
      proc.on('error', err => {
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

  private async isPortAvailable(port: number): Promise<boolean> {
    const hasActiveListener =
      (await this.canConnectToPort(port, '127.0.0.1')) ||
      (await this.canConnectToPort(port, '::1'));

    if (hasActiveListener) {
      return false;
    }

    const canBindV4 = await this.canBindPort(port, '0.0.0.0');
    const canBindV6 = await this.canBindPort(port, '::');
    return canBindV4 || canBindV6;
  }

  private canConnectToPort(port: number, host: string): Promise<boolean> {
    return new Promise(resolve => {
      const net = require('net');
      const socket = new net.Socket();
      let resolved = false;

      const finish = (value: boolean) => {
        if (!resolved) {
          resolved = true;
          socket.destroy();
          resolve(value);
        }
      };

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

      const finish = (value: boolean) => {
        if (!resolved) {
          resolved = true;
          resolve(value);
        }
      };

      server.once('error', () => finish(false));
      server.once('listening', () => {
        server.close(() => finish(true));
      });

      server.listen(port, host);
    });
  }

  private async findAvailablePort(startPort: number, maxAttempts: number = 50): Promise<number | null> {
    for (let i = 0; i < maxAttempts; i += 1) {
      const candidate = startPort + i;
      if (await this.isPortAvailable(candidate)) {
        return candidate;
      }
    }
    return null;
  }

  // ── Backend reporting ────────────────────────────────────────────

  private async reportProgress(projectId: string, progress: number, step: string): Promise<void> {
    this.onLog(`[${progress}%] ${step}`);
    try {
      await this.apiClient.post(`/api/projects/${projectId}/install-progress`, {
        progress, step,
      });
    } catch (err: any) {
      // Non-fatal — installation continues even if backend reporting fails
      if (err?.response?.status === 401) {
        this.onLog('[Warning] Session expired — progress will not sync to dashboard', 'stderr');
      }
      // Swallow all other errors silently
    }
  }

  private async reportComplete(
    projectId: string,
    success: boolean,
    port?: number,
    error?: string,
  ): Promise<void> {
    // Retry up to 3 times with backoff — this one matters
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        await this.apiClient.post(`/api/projects/${projectId}/install-complete`, {
          success, port, error,
        });
        return;
      } catch (err: any) {
        if (attempt === 3) {
          this.onLog(
            `[Warning] Could not report completion to backend after ${attempt} attempts`,
            'stderr'
          );
        } else {
          await new Promise(r => setTimeout(r, attempt * 1000));
        }
      }
    }
  }
}