import { z } from "zod";
import { Fastify } from "../types";
import { FeedBodySchema } from "@/app/feed/types";
import { feedGet } from "@/app/feed/feedGet";
import { feedPost } from "@/app/feed/feedPost";
import { Context } from "@/context";
import { db } from "@/storage/db";
import { inTx } from "@/storage/inTx";
import { afterTx } from "@/storage/inTx";
import { allocateUserSeq } from "@/storage/seq";
import { eventRouter, buildDeleteFeedPostUpdate } from "@/app/events/eventRouter";
import { randomKeyNaked } from "@/utils/randomKeyNaked";

export function feedRoutes(app: Fastify) {
    app.get('/v1/feed', {
        preHandler: app.authenticate,
        schema: {
            querystring: z.object({
                before: z.string().optional(),
                after: z.string().optional(),
                limit: z.coerce.number().int().min(1).max(200).default(50)
            }).optional(),
            response: {
                200: z.object({
                    items: z.array(z.object({
                        id: z.string(),
                        body: FeedBodySchema,
                        repeatKey: z.string().nullable(),
                        cursor: z.string(),
                        createdAt: z.number()
                    })),
                    hasMore: z.boolean()
                })
            }
        }
    }, async (request, reply) => {
        const items = await feedGet(db, Context.create(request.userId), {
            cursor: {
                before: request.query?.before,
                after: request.query?.after
            },
            limit: request.query?.limit
        });
        return reply.send({ items: items.items, hasMore: items.hasMore });
    });

    app.post('/v1/feed', {
        preHandler: app.authenticate,
        schema: {
            body: z.object({
                body: FeedBodySchema,
                repeatKey: z.string().nullable().optional()
            }),
            response: {
                200: z.object({
                    id: z.string(),
                    body: FeedBodySchema,
                    repeatKey: z.string().nullable(),
                    cursor: z.string(),
                    createdAt: z.number()
                })
            }
        }
    }, async (request, reply) => {
        const ctx = Context.create(request.userId);
        const item = await inTx(async (tx) => {
            const result = await feedPost(tx, ctx, request.body.body, request.body.repeatKey ?? null);
            if (!result) {
                // Item was dismissed, return 204 No Content
                return null;
            }
            return result;
        });
        if (!item) {
            return reply.code(204).send();
        }
        return reply.send(item);
    });

    app.delete('/v1/feed/:id', {
        preHandler: app.authenticate,
        schema: {
            params: z.object({
                id: z.string()
            }),
            response: {
                200: z.object({
                    success: z.literal(true)
                }),
                404: z.object({
                    error: z.string()
                })
            }
        }
    }, async (request, reply) => {
        const ctx = Context.create(request.userId);
        const { id } = request.params;

        await inTx(async (tx) => {
            // Check if item exists and belongs to user
            const item = await tx.userFeedItem.findFirst({
                where: {
                    id,
                    userId: ctx.uid
                },
                select: { repeatKey: true }
            });

            if (!item) {
                return reply.code(404).send({ error: 'Feed item not found' });
            }

            // If item has a repeatKey, track it as dismissed
            if (item.repeatKey) {
                const account = await tx.account.findUnique({
                    where: { id: ctx.uid },
                    select: { settings: true }
                });

                let dismissedKeys: string[] = [];
                if (account?.settings) {
                    try {
                        const settings = JSON.parse(account.settings);
                        dismissedKeys = settings.dismissedFeedRepeatKeys || [];
                    } catch {
                        // Invalid JSON, start fresh
                    }
                }

                // Add repeatKey to dismissed list if not already there
                if (!dismissedKeys.includes(item.repeatKey)) {
                    dismissedKeys.push(item.repeatKey);
                    
                    let updatedSettings: any = {};
                    if (account?.settings) {
                        try {
                            updatedSettings = JSON.parse(account.settings);
                        } catch {
                            // Invalid JSON, start fresh
                            updatedSettings = {};
                        }
                    }
                    
                    updatedSettings.dismissedFeedRepeatKeys = dismissedKeys;

                    await tx.account.update({
                        where: { id: ctx.uid },
                        data: {
                            settings: JSON.stringify(updatedSettings),
                            settingsVersion: { increment: 1 }
                        }
                    });
                    
                    console.log(`[feedRoutes] Added ${item.repeatKey} to dismissed list. Total dismissed: ${dismissedKeys.length}`);
                } else {
                    console.log(`[feedRoutes] ${item.repeatKey} already in dismissed list`);
                }
            }

            // Delete the item
            await tx.userFeedItem.delete({
                where: { id }
            });

            // Emit delete event after transaction completes
            afterTx(tx, async () => {
                const updateSeq = await allocateUserSeq(ctx.uid);
                const updatePayload = buildDeleteFeedPostUpdate(id, updateSeq, randomKeyNaked(12));

                eventRouter.emitUpdate({
                    userId: ctx.uid,
                    payload: updatePayload,
                    recipientFilter: { type: 'all-user-authenticated-connections' }
                });
            });
        });

        return reply.send({ success: true });
    });
}