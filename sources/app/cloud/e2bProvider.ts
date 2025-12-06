/**
 * E2B Cloud Provider
 *
 * Manages E2B sandboxes for cloud-based Claude Code sessions.
 * Spawns sandboxes on demand and manages their lifecycle.
 * 
 * Note: E2B SDK v2.8.1 requires E2B_API_KEY to be set as an environment variable.
 * We use dynamic import to ensure the SDK reads the env var after we set it.
 */

export interface CloudEndpoint {
  id: string;
  type: 'cloud-e2b';
  sandboxId: string;
  status: 'spawning' | 'online' | 'offline' | 'error';
  capabilities: {
    maxSessions: number;
    supportedAgents: string[];
  };
  metadata: {
    nodeVersion?: string;
    spawnedAt: Date;
    lastSeen?: Date;
  };
}

export interface SpawnOptions {
  authToken: string;
  serverUrl: string;
  maxConcurrentSessions?: number;
  timeoutMs?: number;
  startRunner?: boolean;
}

export class E2BProvider {
  private e2bApiKey: string;
  private sandboxTemplate: string;
  private activeSandboxes: Map<string, any> = new Map(); // E2B Sandbox instance

  constructor(apiKey: string, template: string = 'vibe-runner') {
    this.e2bApiKey = apiKey;
    this.sandboxTemplate = template;
  }

  /**
   * Validate that API key is set
   */
  private validateApiKey(): void {
    if (!this.e2bApiKey || this.e2bApiKey.trim() === '') {
      throw new Error('E2B_API_KEY is required for cloud sessions. Please set it in your .env file or as an environment variable.');
    }
  }

  /**
   * Spawn a new E2B sandbox running vibe-cloud-runner
   */
  async spawnEndpoint(options: SpawnOptions): Promise<CloudEndpoint> {
    // Validate API key is set
    this.validateApiKey();

    // Validate server URL - E2B sandboxes cannot connect to localhost
    // According to E2B docs: sandboxes are isolated and cannot reach localhost on the host machine
    // Recommended solutions:
    // 1. Use a tunnel service (ngrok, localtunnel) for local development
    // 2. Use the host machine's public IP if server is publicly accessible
    // 3. Deploy the server publicly for production use
    const serverUrl = options.serverUrl;
    if (serverUrl.includes('localhost') || serverUrl.includes('127.0.0.1')) {
      console.warn('[E2BProvider] WARNING: Server URL contains localhost/127.0.0.1');
      console.warn('[E2BProvider] E2B sandboxes cannot connect to localhost on the host machine.');
      console.warn('[E2BProvider]');
      console.warn('[E2BProvider] Recommended solutions:');
      console.warn('[E2BProvider] 1. Use a tunnel service (recommended for local dev):');
      console.warn('[E2BProvider]    - ngrok: ngrok http 3005');
      console.warn('[E2BProvider]    - localtunnel: lt --port 3005');
      console.warn('[E2BProvider]    Then set VIBE_SERVER_URL to the tunnel URL');
      console.warn('[E2BProvider]');
      console.warn('[E2BProvider] 2. Use host machine public IP (if server is publicly accessible)');
      console.warn('[E2BProvider] 3. Deploy server publicly (for production)');
      throw new Error(
        'Cannot use localhost with E2B sandboxes. E2B sandboxes are isolated and cannot reach ' +
        'localhost on the host machine. Use a tunnel service (ngrok/localtunnel) for local development, ' +
        'or deploy the server publicly. See server logs for detailed instructions.'
      );
    }

    console.log('[E2BProvider] Spawning new sandbox', {
      template: this.sandboxTemplate,
      apiKeyPresent: !!this.e2bApiKey,
      apiKeyLength: this.e2bApiKey?.length || 0,
      apiKeyPrefix: this.e2bApiKey?.substring(0, 10) || 'none',
    });

    try {
      // E2B SDK v2.8.1 requires API key to be set as environment variable
      // Store original value to restore later
      const originalApiKey = process.env.E2B_API_KEY;
      
      // Set the API key in environment - SDK reads this at runtime
      process.env.E2B_API_KEY = this.e2bApiKey;
      
      // Verify it was set correctly
      if (process.env.E2B_API_KEY !== this.e2bApiKey) {
        throw new Error('Failed to set E2B_API_KEY environment variable');
      }
      
      console.log('[E2BProvider] E2B_API_KEY environment variable set', {
        wasSet: !!process.env.E2B_API_KEY,
        length: process.env.E2B_API_KEY?.length || 0,
      });

      try {
        // Dynamically import E2B SDK after setting environment variable
        // This ensures the SDK reads E2B_API_KEY from the environment
        const { Sandbox: E2BSandbox } = await import('e2b');
        
        // Create E2B sandbox
        // E2B SDK v2.8.1 reads from E2B_API_KEY env var
        const sandbox = await E2BSandbox.create(this.sandboxTemplate, {
          timeoutMs: options.timeoutMs || 3600000, // 1 hour default
          envs: {
            VIBE_SERVER_URL: options.serverUrl,
            VIBE_AUTH_TOKEN: options.authToken,
            MAX_CONCURRENT_SESSIONS: (options.maxConcurrentSessions || 1).toString(),
          },
        });

        console.log('[E2BProvider] Sandbox created', {
          sandboxId: sandbox.sandboxId,
        });

        // Store sandbox reference
        this.activeSandboxes.set(sandbox.sandboxId, sandbox);

        if (options.startRunner !== false) {
          // Start vibe-cloud-runner inside sandbox using 'commands' module
          const cmd = await sandbox.commands.run('npm start', {
            background: true,
            cwd: '/home/user/app',
            envs: {
              NODE_ENV: 'production',
              VIBE_ENDPOINT_ID: `e2b-${sandbox.sandboxId}`,
            },
            onStdout: (data) => console.log(`[E2B:${sandbox.sandboxId}] ${data}`),
            onStderr: (data) => console.error(`[E2B:${sandbox.sandboxId}] ERROR: ${data}`),
          });

          console.log('[E2BProvider] Cloud runner started in sandbox', {
            sandboxId: sandbox.sandboxId,
            processId: cmd.pid,
          });
        } else {
          console.log('[E2BProvider] Skipping cloud runner start');
        }

        const endpoint: CloudEndpoint = {
          id: `e2b-${sandbox.sandboxId}`,
          type: 'cloud-e2b',
          sandboxId: sandbox.sandboxId,
          status: 'online',
          capabilities: {
            maxSessions: options.maxConcurrentSessions || 1,
            supportedAgents: ['claude'],
          },
          metadata: {
            spawnedAt: new Date(),
          },
        };

        // Restore original E2B_API_KEY if it existed
        if (originalApiKey !== undefined) {
          process.env.E2B_API_KEY = originalApiKey;
        } else {
          delete process.env.E2B_API_KEY;
        }

        return endpoint;
      } finally {
        // Ensure we restore the original API key even if there's an error
        if (originalApiKey !== undefined) {
          process.env.E2B_API_KEY = originalApiKey;
        } else {
          delete process.env.E2B_API_KEY;
        }
      }
    } catch (error) {
      console.error('[E2BProvider] Failed to spawn sandbox', {
        error: error instanceof Error ? error.message : String(error),
      });

      throw new Error(`Failed to spawn E2B sandbox: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Kill an E2B sandbox
   */
  async killEndpoint(sandboxId: string): Promise<void> {
    console.log('[E2BProvider] Killing sandbox', { sandboxId });

    const sandbox = this.activeSandboxes.get(sandboxId);
    if (!sandbox) {
      console.warn('[E2BProvider] Sandbox not found', { sandboxId });
      return;
    }

    try {
      // In SDK v1, sandbox.close() might be renamed or removed.
      // Checking if kill exists or if we should use static method.
      if ('kill' in sandbox && typeof sandbox.kill === 'function') {
          await (sandbox as any).kill();
      } else if ('close' in sandbox && typeof sandbox.close === 'function') {
          await sandbox.close();
      } else {
          // Try static method if available
          const { Sandbox: E2BSandbox } = await import('e2b');
          await E2BSandbox.kill(sandboxId);
      }
      
      this.activeSandboxes.delete(sandboxId);

      console.log('[E2BProvider] Sandbox killed', { sandboxId });
    } catch (error) {
      console.error('[E2BProvider] Failed to kill sandbox', {
        sandboxId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Get sandbox status
   */
  async getSandboxStatus(sandboxId: string): Promise<'running' | 'stopped' | 'unknown'> {
    const sandbox = this.activeSandboxes.get(sandboxId);
    if (!sandbox) {
      return 'unknown';
    }

    // E2B sandboxes don't have a direct status check,
    // but we can try a simple command to verify it's alive
    try {
      await sandbox.commands.run('echo "ping"', { timeoutMs: 5000 });
      return 'running';
    } catch {
      return 'stopped';
    }
  }

  /**
   * Clean up all sandboxes (for shutdown)
   */
  async cleanup(): Promise<void> {
    console.log('[E2BProvider] Cleaning up all sandboxes', {
      count: this.activeSandboxes.size,
    });

    const promises = Array.from(this.activeSandboxes.keys()).map(
      (sandboxId) => this.killEndpoint(sandboxId)
    );

    await Promise.allSettled(promises);

    console.log('[E2BProvider] Cleanup complete');
  }
}
