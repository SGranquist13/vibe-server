/**
 * Example vibe-server integration with E2B cloud endpoints
 *
 * This demonstrates how to integrate the E2B provider into vibe-server.
 * Add this to your actual vibe-server codebase.
 */

import { Server as SocketIOServer } from 'socket.io';
import { CloudSessionManager } from './cloudSessionManager.js';

// Initialize cloud session manager
let cloudSessionManager: CloudSessionManager;
let ioInstance: SocketIOServer | null = null;

export function getCloudSessionManager(): CloudSessionManager {
  if (!cloudSessionManager) {
    cloudSessionManager = new CloudSessionManager(
      process.env.E2B_API_KEY || '',
      process.env.VIBE_SERVER_URL || 'http://localhost:3005'
    );
  }
  return cloudSessionManager;
}

/**
 * Set up Socket.IO handlers for cloud endpoints
 */
export function setupCloudEndpointHandlers(io: SocketIOServer): void {
  ioInstance = io;
  const cloudSessionManager = getCloudSessionManager();
  cloudSessionManager.setSocketIOServer(io);
  const endpointRegistry = cloudSessionManager.getEndpointRegistry();

  io.on('connection', (socket) => {
    console.log('[Server] Socket connected', { socketId: socket.id });

    // Endpoint registration (from cloud runner)
    socket.on('endpoint:register', (data) => {
      console.log('[Server] Endpoint registering', data);

      // Validate auth token if provided
      const isValid = cloudSessionManager.validateEndpointToken(
        data.endpointId,
        data.authToken || ''
      );

      if (!isValid && data.authToken) {
        console.warn('[Server] Invalid auth token for endpoint', {
          endpointId: data.endpointId,
        });
        socket.emit('error', { message: 'Invalid auth token' });
        return;
      }

      endpointRegistry.registerEndpoint(data);

      // Join endpoint room for targeted messaging
      socket.join(`endpoint:${data.endpointId}`);

      socket.emit('endpoint:registered', {
        endpointId: data.endpointId,
      });

      // Check if there are pending sessions for this endpoint
      cloudSessionManager.startPendingSessionsForEndpoint(data.endpointId);
    });

    // Endpoint unregistration
    socket.on('endpoint:unregister', (data) => {
      console.log('[Server] Endpoint unregistering', data);

      endpointRegistry.unregisterEndpoint(data.endpointId);
    });

    // Session started (from cloud runner)
    socket.on('session:started', (data) => {
      console.log('[Server] Session started', data);

      cloudSessionManager.sessionStarted(data.sessionId);

      // Notify mobile client
      io.to(`session:${data.sessionId}`).emit('session:status', {
        sessionId: data.sessionId,
        status: 'running',
      });
    });

    // Session ended (from cloud runner)
    socket.on('session:ended', (data) => {
      console.log('[Server] Session ended', data);

      cloudSessionManager.sessionEnded(data.sessionId);

      // Notify mobile client
      io.to(`session:${data.sessionId}`).emit('session:status', {
        sessionId: data.sessionId,
        status: 'ended',
      });
    });

    // Session error (from cloud runner)
    socket.on('session:error', (data) => {
      console.log('[Server] Session error', data);

      cloudSessionManager.sessionError(data.sessionId);

      // Notify mobile client
      io.to(`session:${data.sessionId}`).emit('session:error', {
        sessionId: data.sessionId,
        error: data.error,
      });
    });

    // Messages from Claude (cloud runner → mobile)
    socket.on('message:from-claude', (data) => {
      console.log('[Server] Message from Claude', {
        sessionId: data.sessionId,
      });

      // Forward to mobile client
      io.to(`session:${data.sessionId}`).emit('message:from-agent', {
        sessionId: data.sessionId,
        message: data.message,
      });
    });

    // Messages to Claude (mobile → cloud runner)
    socket.on('message:to-claude', (data) => {
      console.log('[Server] Message to Claude', {
        sessionId: data.sessionId,
      });

      const assignment = endpointRegistry.getSessionAssignment(data.sessionId);
      if (!assignment) {
        socket.emit('error', {
          message: 'Session not found or not assigned to endpoint',
        });
        return;
      }

      // Forward to cloud runner endpoint
      io.to(`endpoint:${assignment.endpointId}`).emit('message:send', {
        sessionId: data.sessionId,
        message: data.message,
      });
    });

    // Heartbeat from endpoints
    socket.on('endpoint:heartbeat', (data) => {
      endpointRegistry.updateLastSeen(data.endpointId);
    });

    // Disconnect handler
    socket.on('disconnect', () => {
      console.log('[Server] Socket disconnected', { socketId: socket.id });

      // Find and unregister endpoints that were registered by this socket
      // We track this by storing endpointId -> socketId mapping
      // For now, we'll iterate through all endpoints and check if they're still connected
      // In a production system, you'd want to track socket -> endpoint mappings
      const allEndpoints = endpointRegistry.getAllEndpoints();
      for (const endpoint of allEndpoints) {
        // Check if this socket was handling this endpoint
        // Since we don't have direct mapping, we'll rely on the endpoint to reconnect
        // and re-register if needed
      }
    });
  });
}

/**
 * API endpoint to create a cloud session
 */
export async function createCloudSessionHandler(req: any, res: any): Promise<void> {
  try {
    const { userId, initialMessage, agentType } = req.body;

    console.log('[API] Creating cloud session', { userId });

    const session = await cloudSessionManager.createCloudSession({
      userId,
      initialMessage,
      agentType: agentType || 'claude',
    });

    res.json({
      success: true,
      session: {
        sessionId: session.sessionId,
        endpointId: session.endpointId,
        status: session.status,
        createdAt: session.createdAt,
      },
    });
  } catch (error) {
    console.error('[API] Failed to create cloud session', {
      error: error instanceof Error ? error.message : String(error),
    });

    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
}

/**
 * API endpoint to get cloud session stats
 */
export function getCloudStatsHandler(req: any, res: any): void {
  const stats = cloudSessionManager.getStats();

  res.json({
    success: true,
    stats,
  });
}
