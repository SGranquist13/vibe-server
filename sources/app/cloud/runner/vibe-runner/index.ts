/**
 * Vibe Cloud Runner
 * 
 * Runs inside E2B sandbox to execute Claude Code/Codex sessions.
 * Connects to vibe-server via Socket.IO and handles session lifecycle.
 */

import { io, Socket } from 'socket.io-client';
import { spawn, ChildProcess } from 'child_process';
import { randomBytes } from 'crypto';
import * as os from 'os';
import * as path from 'path';

interface Session {
  sessionId: string;
  process?: ChildProcess;
  status: 'starting' | 'running' | 'ended' | 'error';
  agentType: 'claude' | 'codex';
  workingDirectory?: string;
}

class CloudRunner {
  private socket: Socket | null = null;
  private endpointId: string;
  private authToken: string;
  private serverUrl: string;
  private maxConcurrentSessions: number;
  private activeSessions: Map<string, Session> = new Map();
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 10;

  constructor() {
    // Get configuration from environment variables
    this.endpointId = process.env.VIBE_ENDPOINT_ID || `e2b-${randomBytes(8).toString('hex')}`;
    this.authToken = process.env.VIBE_AUTH_TOKEN || '';
    this.serverUrl = process.env.VIBE_SERVER_URL || 'http://localhost:3005';
    this.maxConcurrentSessions = parseInt(process.env.MAX_CONCURRENT_SESSIONS || '1', 10);

    if (!this.authToken) {
      throw new Error('VIBE_AUTH_TOKEN environment variable is required');
    }

    console.log('[CloudRunner] Initializing', {
      endpointId: this.endpointId,
      serverUrl: this.serverUrl,
      maxConcurrentSessions: this.maxConcurrentSessions,
    });
  }

  /**
   * Connect to vibe-server
   */
  async connect(): Promise<void> {
    console.log('[CloudRunner] Connecting to server', { serverUrl: this.serverUrl });

    this.socket = io(this.serverUrl, {
      auth: {
        token: this.authToken,
        clientType: 'cloud-endpoint',
      },
      path: '/v1/updates',
      reconnection: true,
      reconnectionAttempts: this.maxReconnectAttempts,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
      transports: ['websocket'],
      autoConnect: true,
    });

    this.socket.on('connect', () => {
      console.log('[CloudRunner] Connected to server', { socketId: this.socket?.id });
      this.reconnectAttempts = 0;
      this.registerEndpoint();
      this.setupHandlers();
    });

    this.socket.on('disconnect', (reason) => {
      console.log('[CloudRunner] Disconnected from server', { reason });
    });

    this.socket.on('connect_error', (error) => {
      console.error('[CloudRunner] Connection error', {
        error: error.message,
        type: error.type,
        description: error.description,
        context: error.context,
        attempts: this.reconnectAttempts + 1,
        maxAttempts: this.maxReconnectAttempts,
      });
      this.reconnectAttempts++;
      
      if (this.reconnectAttempts >= this.maxReconnectAttempts) {
        console.error('[CloudRunner] Max reconnection attempts reached, exiting');
        process.exit(1);
      }
    });

    // Send heartbeat every 30 seconds
    setInterval(() => {
      if (this.socket?.connected) {
        this.socket.emit('endpoint:heartbeat', {
          endpointId: this.endpointId,
        });
      }
    }, 30000);
  }

  /**
   * Register this endpoint with the server
   */
  private registerEndpoint(): void {
    if (!this.socket?.connected) {
      console.error('[CloudRunner] Cannot register endpoint: not connected');
      return;
    }

    console.log('[CloudRunner] Registering endpoint', { endpointId: this.endpointId });

    this.socket.emit('endpoint:register', {
      endpointId: this.endpointId,
      type: 'cloud-e2b',
      capabilities: {
        maxSessions: this.maxConcurrentSessions,
        supportedAgents: ['claude', 'codex'],
      },
      metadata: {
        nodeVersion: process.version,
        platform: os.platform(),
        arch: os.arch(),
      },
      authToken: this.authToken,
    });

    this.socket.once('endpoint:registered', (data) => {
      console.log('[CloudRunner] Endpoint registered', data);
    });
  }

  /**
   * Set up Socket.IO event handlers
   */
  private setupHandlers(): void {
    if (!this.socket) return;

    // Handle session start requests
    this.socket.on('session:start', async (data: {
      sessionId: string;
      agentType: 'claude' | 'codex';
      workingDirectory?: string;
      initialMessage?: string;
    }) => {
      console.log('[CloudRunner] Session start requested', data);
      await this.startSession(data);
    });

    // Handle messages to send to agent
    this.socket.on('message:send', async (data: {
      sessionId: string;
      message: any;
    }) => {
      console.log('[CloudRunner] Message received for session', {
        sessionId: data.sessionId,
      });
      await this.sendMessageToAgent(data.sessionId, data.message);
    });

    // Handle session stop requests
    this.socket.on('session:stop', async (data: { sessionId: string }) => {
      console.log('[CloudRunner] Session stop requested', data);
      await this.stopSession(data.sessionId);
    });
  }

  /**
   * Start a new agent session
   */
  private async startSession(data: {
    sessionId: string;
    agentType: 'claude' | 'codex';
    workingDirectory?: string;
    initialMessage?: string;
  }): Promise<void> {
    // Check if we have capacity
    if (this.activeSessions.size >= this.maxConcurrentSessions) {
      console.error('[CloudRunner] Max concurrent sessions reached', {
        current: this.activeSessions.size,
        max: this.maxConcurrentSessions,
      });
      this.socket?.emit('session:error', {
        sessionId: data.sessionId,
        error: 'Max concurrent sessions reached',
      });
      return;
    }

    // Check if session already exists
    if (this.activeSessions.has(data.sessionId)) {
      console.warn('[CloudRunner] Session already exists', { sessionId: data.sessionId });
      return;
    }

    const session: Session = {
      sessionId: data.sessionId,
      status: 'starting',
      agentType: data.agentType,
      workingDirectory: data.workingDirectory || '/home/user',
    };

    this.activeSessions.set(data.sessionId, session);

    try {
      // Start the agent process
      const process = await this.spawnAgent(data);
      session.process = process;
      session.status = 'running';

      // Notify server that session started
      this.socket?.emit('session:started', {
        sessionId: data.sessionId,
        endpointId: this.endpointId,
      });

      console.log('[CloudRunner] Session started', { sessionId: data.sessionId });
    } catch (error) {
      console.error('[CloudRunner] Failed to start session', {
        sessionId: data.sessionId,
        error: error instanceof Error ? error.message : String(error),
      });

      session.status = 'error';
      this.activeSessions.delete(data.sessionId);

      this.socket?.emit('session:error', {
        sessionId: data.sessionId,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  /**
   * Spawn agent process (Claude Code or Codex)
   */
  private async spawnAgent(data: {
    sessionId: string;
    agentType: 'claude' | 'codex';
    workingDirectory?: string;
    initialMessage?: string;
  }): Promise<ChildProcess> {
    const workingDir = data.workingDirectory || '/home/user';
    const agentCommand = data.agentType === 'claude' ? 'claude' : 'codex';

    console.log('[CloudRunner] Spawning agent', {
      sessionId: data.sessionId,
      agentType: data.agentType,
      workingDir,
      command: agentCommand,
    });

    // Build command arguments
    const args: string[] = [];
    
    if (data.initialMessage) {
      args.push('--print');
      args.push('--output-format', 'stream-json');
      args.push('--verbose');
      args.push(data.initialMessage);
    }

    // Spawn the agent process
    const agentProcess = spawn(agentCommand, args, {
      cwd: workingDir,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        // Pass session context to agent if needed
        VIBE_SESSION_ID: data.sessionId,
        VIBE_ENDPOINT_ID: this.endpointId,
      },
    });

    // Handle stdout (agent messages)
    agentProcess.stdout?.on('data', (chunk: Buffer) => {
      const output = chunk.toString();
      console.log(`[CloudRunner:${data.sessionId}] Agent stdout:`, output);

      // Parse and forward messages to server
      this.forwardAgentOutput(data.sessionId, output, 'stdout');
    });

    // Handle stderr (agent errors)
    agentProcess.stderr?.on('data', (chunk: Buffer) => {
      const output = chunk.toString();
      console.error(`[CloudRunner:${data.sessionId}] Agent stderr:`, output);

      // Forward errors to server
      this.forwardAgentOutput(data.sessionId, output, 'stderr');
    });

    // Handle process exit
    agentProcess.on('exit', (code, signal) => {
      console.log('[CloudRunner] Agent process exited', {
        sessionId: data.sessionId,
        code,
        signal,
      });

      const session = this.activeSessions.get(data.sessionId);
      if (session) {
        session.status = code === 0 ? 'ended' : 'error';
        session.process = undefined;
      }

      // Notify server
      if (code === 0) {
        this.socket?.emit('session:ended', {
          sessionId: data.sessionId,
          endpointId: this.endpointId,
        });
      } else {
        this.socket?.emit('session:error', {
          sessionId: data.sessionId,
          error: `Process exited with code ${code}`,
        });
      }

      // Clean up session after a delay
      setTimeout(() => {
        this.activeSessions.delete(data.sessionId);
      }, 5000);
    });

    // Handle process errors
    agentProcess.on('error', (error) => {
      console.error('[CloudRunner] Agent process error', {
        sessionId: data.sessionId,
        error: error.message,
      });

      this.socket?.emit('session:error', {
        sessionId: data.sessionId,
        error: error.message,
      });

      const session = this.activeSessions.get(data.sessionId);
      if (session) {
        session.status = 'error';
      }
    });

    return agentProcess;
  }

  /**
   * Forward agent output to server
   */
  private forwardAgentOutput(
    sessionId: string,
    output: string,
    type: 'stdout' | 'stderr'
  ): void {
    // Parse JSON lines if it's stream-json format
    const lines = output.split('\n').filter((line) => line.trim());
    
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line);
        
        // Forward parsed message to server
        this.socket?.emit('message:from-claude', {
          sessionId,
          message: parsed,
          type,
        });
      } catch {
        // If not JSON, forward as text
        this.socket?.emit('message:from-claude', {
          sessionId,
          message: {
            type: 'text',
            content: line,
            source: type,
          },
          type,
        });
      }
    }
  }

  /**
   * Send message to agent (via stdin)
   */
  private async sendMessageToAgent(sessionId: string, message: any): Promise<void> {
    const session = this.activeSessions.get(sessionId);
    if (!session || !session.process) {
      console.error('[CloudRunner] Session not found or not running', { sessionId });
      return;
    }

    if (session.status !== 'running') {
      console.error('[CloudRunner] Session not in running state', {
        sessionId,
        status: session.status,
      });
      return;
    }

    // Convert message to string and send to agent stdin
    const messageStr = typeof message === 'string' ? message : JSON.stringify(message);
    
    if (session.process.stdin) {
      session.process.stdin.write(messageStr + '\n');
      console.log('[CloudRunner] Message sent to agent', { sessionId });
    } else {
      console.error('[CloudRunner] Agent process stdin not available', { sessionId });
    }
  }

  /**
   * Stop a session
   */
  private async stopSession(sessionId: string): Promise<void> {
    const session = this.activeSessions.get(sessionId);
    if (!session) {
      console.warn('[CloudRunner] Session not found', { sessionId });
      return;
    }

    console.log('[CloudRunner] Stopping session', { sessionId });

    if (session.process) {
      // Kill the agent process
      session.process.kill('SIGTERM');
      
      // Force kill after 5 seconds if still running
      setTimeout(() => {
        if (session.process && !session.process.killed) {
          session.process.kill('SIGKILL');
        }
      }, 5000);
    }

    session.status = 'ended';
    this.activeSessions.delete(sessionId);

    // Notify server
    this.socket?.emit('session:ended', {
      sessionId,
      endpointId: this.endpointId,
    });
  }

  /**
   * Cleanup on shutdown
   */
  async cleanup(): Promise<void> {
    console.log('[CloudRunner] Cleaning up', {
      activeSessions: this.activeSessions.size,
    });

    // Stop all sessions
    for (const [sessionId] of this.activeSessions) {
      await this.stopSession(sessionId);
    }

    // Unregister endpoint
    if (this.socket?.connected) {
      this.socket.emit('endpoint:unregister', {
        endpointId: this.endpointId,
      });
    }

    // Disconnect socket
    if (this.socket) {
      this.socket.disconnect();
    }
  }
}

// Main entry point
async function main() {
  const runner = new CloudRunner();

  // Handle graceful shutdown
  process.on('SIGTERM', async () => {
    console.log('[CloudRunner] Received SIGTERM, shutting down gracefully');
    await runner.cleanup();
    process.exit(0);
  });

  process.on('SIGINT', async () => {
    console.log('[CloudRunner] Received SIGINT, shutting down gracefully');
    await runner.cleanup();
    process.exit(0);
  });

  // Connect to server
  await runner.connect();

  console.log('[CloudRunner] Cloud runner started and connected');
}

// Start the runner
main().catch((error) => {
  console.error('[CloudRunner] Fatal error', error);
  process.exit(1);
});

