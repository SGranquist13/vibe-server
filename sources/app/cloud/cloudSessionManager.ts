/**
 * Cloud Session Manager
 *
 * Orchestrates cloud session creation using E2B provider and endpoint registry.
 * Handles the full lifecycle of cloud-based Claude Code sessions.
 */

import { E2BProvider, CloudEndpoint } from './e2bProvider.js';
import { EndpointRegistry } from './endpointRegistry.js';
import { randomBytes } from 'crypto';
import { Server as SocketIOServer } from 'socket.io';
import { db } from '@/storage/db';
import { allocateUserSeq } from '@/storage/seq';
import { eventRouter, buildNewSessionUpdate } from '@/app/events/eventRouter';
import { randomKeyNaked } from '@/utils/randomKeyNaked';
import { log } from '@/utils/log';

export interface CreateCloudSessionOptions {
  userId: string;
  sessionId?: string;
  workingDirectory?: string;
  initialMessage?: string;
  agentType?: 'claude' | 'codex';
}

export interface CloudSession {
  sessionId: string;
  userId: string;
  endpointId: string;
  status: 'pending' | 'starting' | 'running' | 'ended' | 'error';
  createdAt: Date;
  startedAt?: Date;
  endedAt?: Date;
  options?: {
    agentType: 'claude' | 'codex';
    workingDirectory?: string;
    initialMessage?: string;
  };
}

export class CloudSessionManager {
  private e2bProvider: E2BProvider;
  private endpointRegistry: EndpointRegistry;
  private sessions: Map<string, CloudSession> = new Map();
  private pendingEndpoints: Map<string, string> = new Map(); // endpointId -> authToken
  private serverUrl: string;
  private io: SocketIOServer | null = null;

  constructor(e2bApiKey: string, serverUrl: string) {
    this.e2bProvider = new E2BProvider(e2bApiKey);
    this.endpointRegistry = new EndpointRegistry();
    this.serverUrl = serverUrl;
  }

  /**
   * Set Socket.IO server instance for sending events
   */
  setSocketIOServer(io: SocketIOServer): void {
    this.io = io;
  }

  /**
   * Create a new cloud session
   */
  async createCloudSession(options: CreateCloudSessionOptions): Promise<CloudSession> {
    const sessionId = options.sessionId || this.generateSessionId();
    const tag = `cloud-${sessionId}`;

    console.log('[CloudSessionManager] Creating cloud session', {
      sessionId,
      userId: options.userId,
    });

    // Check if we have an available endpoint
    let endpoint = this.endpointRegistry.findAvailableEndpoint(options.agentType);

    // If no endpoint available, spawn a new one
    if (!endpoint) {
      console.log('[CloudSessionManager] No available endpoints, spawning new one');

      endpoint = await this.spawnNewEndpoint();
    }

    // Create database session so it appears in mobile app
    // Use sessionId as tag to ensure uniqueness
    const updSeq = await allocateUserSeq(options.userId);
    
    // For cloud sessions, we can't encrypt the data encryption key with the user's master key
    // (zero-knowledge architecture). So we create the session without a data encryption key initially.
    // The cloud runner will update the session with proper encryption when it connects.
    // Create proper metadata so the UI can display the session name
    const workingDir = options.workingDirectory || '/home/user';
    const endpointShortId = endpoint.id.length >= 8 ? endpoint.id.substring(0, 8) : endpoint.id;
    const metadataObj = {
      path: workingDir,
      host: `cloud-${endpointShortId}`,
      version: 'cloud',
      os: 'linux',
      machineId: `cloud-${endpoint.id}`,
      homeDir: '/home/user',
      startedBy: 'cloud',
      lifecycleState: 'running',
      lifecycleStateSince: Date.now(),
      flavor: options.agentType || 'claude',
    };
    const metadata = JSON.stringify(metadataObj);
    
    log({ module: 'cloud-session-create', userId: options.userId, sessionId, tag }, 
      `Creating database session for cloud session ${sessionId}`);
    
    const dbSession = await db.session.create({
      data: {
        accountId: options.userId,
        tag: tag,
        metadata: metadata,
        dataEncryptionKey: null // No data encryption key initially - cloud runner will set it
      }
    });
    
    log({ module: 'cloud-session-create', sessionId: dbSession.id, userId: options.userId }, 
      `Database session created: ${dbSession.id}`);

    // Emit new session update so mobile clients are notified
    const updatePayload = buildNewSessionUpdate(dbSession, updSeq, randomKeyNaked(12));
    log({
      module: 'cloud-session-create',
      userId: options.userId,
      sessionId: dbSession.id,
      updateType: 'new-session',
    }, `Emitting new-session update to all user connections`);
    
    eventRouter.emitUpdate({
      userId: options.userId,
      payload: updatePayload,
      recipientFilter: { type: 'all-user-authenticated-connections' }
    });

    // Create in-memory session record
    const session: CloudSession = {
      sessionId: dbSession.id, // Use database session ID
      userId: options.userId,
      endpointId: endpoint.id,
      status: 'pending',
      createdAt: new Date(),
      options: {
        agentType: options.agentType || 'claude',
        workingDirectory: options.workingDirectory,
        initialMessage: options.initialMessage,
      },
    };

    this.sessions.set(dbSession.id, session);

    // Assign session to endpoint
    this.endpointRegistry.assignSession(dbSession.id, endpoint.id);

    console.log('[CloudSessionManager] Cloud session created', {
      sessionId: dbSession.id,
      endpointId: endpoint.id,
    });

    // Try to start the session immediately if endpoint is online
    const endpointInfo = this.endpointRegistry.getEndpoint(endpoint.id);
    if (endpointInfo && endpointInfo.status === 'online' && this.io) {
      this.startSessionOnEndpoint(dbSession.id, options);
    }

    return session;
  }

  /**
   * Start a session on an endpoint
   */
  private startSessionOnEndpoint(
    sessionId: string,
    options: CreateCloudSessionOptions
  ): void {
    const session = this.sessions.get(sessionId);
    if (!session || !this.io) {
      return;
    }

    console.log('[CloudSessionManager] Starting session on endpoint', {
      sessionId,
      endpointId: session.endpointId,
    });

    // Send session:start event to endpoint
    this.io.to(`endpoint:${session.endpointId}`).emit('session:start', {
      sessionId,
      agentType: options.agentType || 'claude',
      workingDirectory: options.workingDirectory,
      initialMessage: options.initialMessage,
    });

    // Update session status
    session.status = 'starting';
  }

  /**
   * Start pending sessions for an endpoint (called when endpoint registers)
   */
  startPendingSessionsForEndpoint(endpointId: string): void {
    const pendingSessions = Array.from(this.sessions.values()).filter(
      (s) => s.endpointId === endpointId && s.status === 'pending'
    );

    console.log('[CloudSessionManager] Starting pending sessions', {
      endpointId,
      count: pendingSessions.length,
    });

    for (const session of pendingSessions) {
      if (!this.io || !session.options) {
        continue;
      }

      this.io.to(`endpoint:${endpointId}`).emit('session:start', {
        sessionId: session.sessionId,
        agentType: session.options.agentType,
        workingDirectory: session.options.workingDirectory,
        initialMessage: session.options.initialMessage,
      });
    }
  }

  /**
   * Spawn a new E2B endpoint
   */
  private async spawnNewEndpoint(): Promise<CloudEndpoint> {
    const authToken = this.generateAuthToken();

    const endpoint = await this.e2bProvider.spawnEndpoint({
      authToken,
      serverUrl: this.serverUrl,
      maxConcurrentSessions: 1,
      timeoutMs: 3600000, // 1 hour
    });

    // Store token for validation
    this.pendingEndpoints.set(endpoint.id, authToken);

    // Endpoint will register itself when cloud runner connects
    // We return it immediately for assignment

    return endpoint;
  }

  /**
   * Mark session as started
   */
  sessionStarted(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.status = 'running';
      session.startedAt = new Date();

      console.log('[CloudSessionManager] Session started', { sessionId });
    }
  }

  /**
   * Mark session as ended
   */
  sessionEnded(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.status = 'ended';
      session.endedAt = new Date();

      // Unassign from endpoint
      this.endpointRegistry.unassignSession(sessionId);

      console.log('[CloudSessionManager] Session ended', { sessionId });

      // Optionally: clean up endpoint if no more sessions
      this.cleanupIdleEndpoints();
    }
  }

  /**
   * Mark session as error
   */
  sessionError(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.status = 'error';
      session.endedAt = new Date();

      this.endpointRegistry.unassignSession(sessionId);

      console.log('[CloudSessionManager] Session error', { sessionId });
    }
  }

  /**
   * Get session by ID
   */
  getSession(sessionId: string): CloudSession | undefined {
    return this.sessions.get(sessionId);
  }

  /**
   * Get endpoint registry (for Socket.IO handlers)
   */
  getEndpointRegistry(): EndpointRegistry {
    return this.endpointRegistry;
  }

  /**
   * Get E2B provider (for manual operations)
   */
  getE2BProvider(): E2BProvider {
    return this.e2bProvider;
  }

  /**
   * Clean up idle endpoints (no active sessions)
   */
  private async cleanupIdleEndpoints(): Promise<void> {
    const endpoints = this.endpointRegistry.getAllEndpoints();

    for (const endpoint of endpoints) {
      const assignment = Array.from(this.sessions.values()).find(
        (s) => s.endpointId === endpoint.id && s.status === 'running'
      );

      // If endpoint has no running sessions, consider shutting it down
      if (!assignment) {
        console.log('[CloudSessionManager] Endpoint idle, could cleanup', {
          endpointId: endpoint.id,
        });

        // TODO: Implement cleanup delay (e.g., keep warm for 5 minutes)
        // For now, we keep endpoints alive for potential reuse
      }
    }
  }

  /**
   * Generate session ID
   */
  private generateSessionId(): string {
    return randomBytes(16).toString('hex');
  }

  /**
   * Generate auth token for cloud runner
   */
  private generateAuthToken(): string {
    return randomBytes(32).toString('hex');
  }

  /**
   * Validate endpoint auth token
   */
  validateEndpointToken(endpointId: string, token: string): boolean {
    const expected = this.pendingEndpoints.get(endpointId);
    if (expected && expected === token) {
      // Token valid, remove from pending (or keep if we need re-auth?)
      // Keeping it allows reconnection
      return true;
    }
    return false;
  }

  /**
   * Find endpoint ID by validating token
   */
  findEndpointByToken(token: string): string | null {
    for (const [endpointId, expectedToken] of this.pendingEndpoints.entries()) {
      if (expectedToken === token) {
        return endpointId;
      }
    }
    return null;
  }

  /**
   * Get statistics
   */
  getStats(): {
    totalSessions: number;
    activeSessions: number;
    endpoints: ReturnType<EndpointRegistry['getStats']>;
  } {
    const activeSessions = Array.from(this.sessions.values()).filter(
      (s) => s.status === 'running'
    ).length;

    return {
      totalSessions: this.sessions.size,
      activeSessions,
      endpoints: this.endpointRegistry.getStats(),
    };
  }
}
