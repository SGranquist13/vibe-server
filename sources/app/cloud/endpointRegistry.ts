/**
 * Cloud Endpoint Registry
 *
 * Manages available cloud endpoints and assigns sessions to them.
 * Handles endpoint health checking and load balancing.
 */

import { CloudEndpoint } from './e2bProvider.js';

export interface EndpointRegistration {
  endpointId: string;
  type: 'local' | 'cloud-e2b';
  capabilities: {
    maxSessions: number;
    supportedAgents: string[];
  };
  metadata?: Record<string, any>;
}

export interface SessionAssignment {
  endpointId: string;
  sessionId: string;
  assignedAt: Date;
}

export class EndpointRegistry {
  private endpoints: Map<string, CloudEndpoint> = new Map();
  private sessionAssignments: Map<string, SessionAssignment> = new Map();
  private endpointSessions: Map<string, Set<string>> = new Map(); // endpointId -> sessionIds

  /**
   * Register a new endpoint (called when cloud runner connects)
   */
  registerEndpoint(registration: EndpointRegistration): void {
    console.log('[EndpointRegistry] Registering endpoint', {
      endpointId: registration.endpointId,
      type: registration.type,
    });

    const endpoint: CloudEndpoint = {
      id: registration.endpointId,
      type: registration.type as 'cloud-e2b',
      sandboxId: registration.endpointId.replace('e2b-', ''),
      status: 'online',
      capabilities: registration.capabilities,
      metadata: {
        ...registration.metadata,
        spawnedAt: new Date(),
        lastSeen: new Date(),
      },
    };

    this.endpoints.set(registration.endpointId, endpoint);
    this.endpointSessions.set(registration.endpointId, new Set());
  }

  /**
   * Unregister an endpoint (called when cloud runner disconnects)
   */
  unregisterEndpoint(endpointId: string): void {
    console.log('[EndpointRegistry] Unregistering endpoint', { endpointId });

    this.endpoints.delete(endpointId);

    // Cleanup session assignments
    const sessions = this.endpointSessions.get(endpointId);
    if (sessions) {
      sessions.forEach((sessionId) => {
        this.sessionAssignments.delete(sessionId);
      });
    }

    this.endpointSessions.delete(endpointId);
  }

  /**
   * Update endpoint last seen timestamp (heartbeat)
   */
  updateLastSeen(endpointId: string): void {
    const endpoint = this.endpoints.get(endpointId);
    if (endpoint) {
      endpoint.metadata.lastSeen = new Date();
    }
  }

  /**
   * Find best available endpoint for a new session
   */
  findAvailableEndpoint(agentType: 'claude' | 'codex' = 'claude'): CloudEndpoint | null {
    const availableEndpoints = Array.from(this.endpoints.values()).filter((endpoint) => {
      // Must be online
      if (endpoint.status !== 'online') return false;

      // Must support the agent type
      if (!endpoint.capabilities.supportedAgents.includes(agentType)) return false;

      // Must have capacity
      const currentSessions = this.endpointSessions.get(endpoint.id)?.size || 0;
      return currentSessions < endpoint.capabilities.maxSessions;
    });

    if (availableEndpoints.length === 0) {
      return null;
    }

    // Load balancing: choose endpoint with least sessions
    availableEndpoints.sort((a, b) => {
      const aLoad = this.endpointSessions.get(a.id)?.size || 0;
      const bLoad = this.endpointSessions.get(b.id)?.size || 0;
      return aLoad - bLoad;
    });

    return availableEndpoints[0];
  }

  /**
   * Assign a session to an endpoint
   */
  assignSession(sessionId: string, endpointId: string): SessionAssignment {
    console.log('[EndpointRegistry] Assigning session', {
      sessionId,
      endpointId,
    });

    const assignment: SessionAssignment = {
      endpointId,
      sessionId,
      assignedAt: new Date(),
    };

    this.sessionAssignments.set(sessionId, assignment);

    const sessions = this.endpointSessions.get(endpointId);
    if (sessions) {
      sessions.add(sessionId);
    }

    return assignment;
  }

  /**
   * Unassign a session from its endpoint
   */
  unassignSession(sessionId: string): void {
    console.log('[EndpointRegistry] Unassigning session', { sessionId });

    const assignment = this.sessionAssignments.get(sessionId);
    if (assignment) {
      const sessions = this.endpointSessions.get(assignment.endpointId);
      if (sessions) {
        sessions.delete(sessionId);
      }

      this.sessionAssignments.delete(sessionId);
    }
  }

  /**
   * Get assignment for a session
   */
  getSessionAssignment(sessionId: string): SessionAssignment | undefined {
    return this.sessionAssignments.get(sessionId);
  }

  /**
   * Get all endpoints
   */
  getAllEndpoints(): CloudEndpoint[] {
    return Array.from(this.endpoints.values());
  }

  /**
   * Get endpoint by ID
   */
  getEndpoint(endpointId: string): CloudEndpoint | undefined {
    return this.endpoints.get(endpointId);
  }

  /**
   * Get endpoint statistics
   */
  getStats(): {
    totalEndpoints: number;
    onlineEndpoints: number;
    totalSessions: number;
    capacity: number;
    utilization: number;
  } {
    const endpoints = Array.from(this.endpoints.values());
    const onlineEndpoints = endpoints.filter((e) => e.status === 'online');

    const totalCapacity = onlineEndpoints.reduce(
      (sum, e) => sum + e.capabilities.maxSessions,
      0
    );

    const totalSessions = this.sessionAssignments.size;

    return {
      totalEndpoints: endpoints.length,
      onlineEndpoints: onlineEndpoints.length,
      totalSessions,
      capacity: totalCapacity,
      utilization: totalCapacity > 0 ? (totalSessions / totalCapacity) * 100 : 0,
    };
  }
}
