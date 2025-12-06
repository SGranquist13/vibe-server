import { type Fastify } from "../types";
import { getCloudSessionManager } from "@/app/cloud/handlers";
import { z } from "zod";

export function cloudRoutes(app: Fastify) {
    // Create cloud session
    app.post('/v1/cloud-session', {
        preHandler: app.authenticate,
        schema: {
            body: z.object({
                initialMessage: z.string().optional(),
                agentType: z.enum(['claude', 'codex']).optional().default('claude'),
                workingDirectory: z.string().optional(),
            }).optional()
        }
    }, async (request, reply) => {
        const userId = request.userId;
        
        const body = request.body as {
            initialMessage?: string;
            agentType?: 'claude' | 'codex';
            workingDirectory?: string;
        } | undefined;

        try {
            const manager = getCloudSessionManager();
            const session = await manager.createCloudSession({
                userId,
                initialMessage: body?.initialMessage,
                agentType: body?.agentType || 'claude',
                workingDirectory: body?.workingDirectory,
            });

            return reply.send({
                success: true,
                session: {
                    sessionId: session.sessionId,
                    endpointId: session.endpointId,
                    status: session.status,
                    createdAt: session.createdAt.toISOString(),
                },
            });
        } catch (error) {
            return reply.status(500).send({
                success: false,
                error: error instanceof Error ? error.message : 'Unknown error',
            });
        }
    });

    // Get cloud session stats
    app.get('/v1/cloud-stats', {
        preHandler: app.authenticate,
    }, async (request, reply) => {
        const manager = getCloudSessionManager();
        const stats = manager.getStats();
        return reply.send({
            success: true,
            stats,
        });
    });
}

