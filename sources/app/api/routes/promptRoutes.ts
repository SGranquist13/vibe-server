import { type Fastify } from "../types";
import { z } from "zod";
import { db } from "@/storage/db";
import { eventRouter } from "@/app/events/eventRouter";
import { Server as SocketIOServer } from "socket.io";

// Get Socket.IO instance - will be set by socket.ts
let ioInstance: SocketIOServer | null = null;

export function setSocketIOInstance(io: SocketIOServer) {
    ioInstance = io;
}

export function promptRoutes(app: Fastify) {
    // Test route to verify registration
    app.get('/v1/improve-prompt/test', async (request, reply) => {
        return reply.send({ message: 'Prompt routes are registered' });
    });

    // Improve prompt using selected agent via local machine CLI
    app.post('/v1/improve-prompt', {
        preHandler: app.authenticate,
        schema: {
            body: z.object({
                prompt: z.string().min(1),
                agentType: z.enum(['claude', 'codex', 'gemini', 'cursor']),
            }),
            response: {
                200: z.object({
                    success: z.boolean(),
                    improvedPrompt: z.string().optional(),
                    error: z.string().optional(),
                }),
            },
        },
    }, async (request, reply) => {
        const userId = request.userId;
        const { prompt, agentType } = request.body;
        
        console.log(`[PROMPT ROUTES] Received improve-prompt request for agent: ${agentType}`);

        if (!ioInstance) {
            return reply.status(500).send({
                success: false,
                error: 'Socket.IO not initialized',
            });
        }

        try {
            // Find an available machine for this user
            const machines = await db.machine.findMany({
                where: { accountId: userId },
                select: { id: true },
            });

            if (machines.length === 0) {
                return reply.status(400).send({
                    success: false,
                    error: 'No machines available. Please start the vibe daemon on a machine first.',
                });
            }

            // Get machine connections to find an online machine
            const connections = eventRouter.getConnections(userId);
            let machineConnection: { socket: any; machineId: string } | null = null;

            if (connections) {
                for (const connection of connections) {
                    if (connection.connectionType === 'machine-scoped') {
                        // Check if socket is still connected
                        const socket = ioInstance.sockets.sockets.get(connection.socket.id);
                        if (socket && socket.connected) {
                            machineConnection = { socket, machineId: connection.machineId };
                            break;
                        }
                    }
                }
            }

            if (!machineConnection) {
                return reply.status(400).send({
                    success: false,
                    error: 'No online machines available. Please ensure the vibe daemon is running on a machine.',
                });
            }

            // Create improvement prompt
            const improvementPrompt = `Please improve and enhance the following prompt to be more clear, specific, and effective while maintaining the original intent. Return only the improved prompt, without any additional explanation or commentary:\n\n${prompt}`;

            // Call machine to improve prompt using a custom socket event
            // The CLI will listen for 'improve-prompt-request' and respond with 'improve-prompt-response'
            const result = await new Promise<any>((resolve, reject) => {
                const timeout = setTimeout(() => {
                    reject(new Error('Timeout waiting for prompt improvement'));
                }, 35000); // 35 second timeout (slightly longer than CLI's 30s)

                // Set up one-time listener for the response
                const responseHandler = (response: any) => {
                    clearTimeout(timeout);
                    machineConnection!.socket.off('improve-prompt-response', responseHandler);
                    resolve(response);
                };

                const errorHandler = (error: any) => {
                    clearTimeout(timeout);
                    machineConnection!.socket.off('improve-prompt-error', errorHandler);
                    machineConnection!.socket.off('improve-prompt-response', responseHandler);
                    reject(new Error(error.message || 'Failed to improve prompt'));
                };

                machineConnection!.socket.once('improve-prompt-response', responseHandler);
                machineConnection!.socket.once('improve-prompt-error', errorHandler);

                // Send the request
                console.log(`[PROMPT ROUTES] Sending improve-prompt-request to machine ${machineConnection!.machineId}`);
                machineConnection!.socket.emit('improve-prompt-request', {
                    prompt: improvementPrompt,
                    agentType: agentType,
                });
                console.log(`[PROMPT ROUTES] Request sent, waiting for response...`);
            });

            // Handle RPC response
            if (result && result.success && result.improvedPrompt) {
                return reply.send({
                    success: true,
                    improvedPrompt: result.improvedPrompt,
                });
            } else {
                return reply.status(500).send({
                    success: false,
                    error: result?.error || 'Failed to improve prompt',
                });
            }

        } catch (error) {
            console.error('Error improving prompt:', error);
            return reply.status(500).send({
                success: false,
                error: error instanceof Error ? error.message : 'Unknown error occurred while improving prompt',
            });
        }
    });
}
