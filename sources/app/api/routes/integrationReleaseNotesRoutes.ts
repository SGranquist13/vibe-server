import { z } from "zod";
import { Fastify } from "../types";
import { fetchAllIntegrationReleases } from "@/app/feed/integrationReleaseNotes";
import { feedPost } from "@/app/feed/feedPost";
import { Context } from "@/context";
import { db } from "@/storage/db";
import { inTx } from "@/storage/inTx";

/**
 * Routes for managing integration release notes
 */
export function integrationReleaseNotesRoutes(app: Fastify) {
    // Fetch and populate recent integration releases for the authenticated user
    app.post('/v1/integration-releases/populate', {
        preHandler: app.authenticate,
        schema: {
            querystring: z.object({
                days: z.coerce.number().int().min(1).max(90).default(30).optional()
            }),
            response: {
                200: z.object({
                    created: z.number(),
                    releases: z.array(z.object({
                        integration: z.string(),
                        version: z.string()
                    }))
                })
            }
        }
    }, async (request, reply) => {
        const ctx = Context.create(request.userId);
        const days = (request.query as { days?: number })?.days ?? 30;
        const cutoffDate = new Date();
        cutoffDate.setDate(cutoffDate.getDate() - days);

        // Fetch all integration releases
        const releases = await fetchAllIntegrationReleases();

        // Filter to recent releases
        const recentReleases = releases.filter(release => {
            if (!release.publishedAt) return true; // Include if no date
            return release.publishedAt >= cutoffDate;
        });

        // Create feed items for each release
        let created = 0;
        const createdReleases: Array<{ integration: string; version: string }> = [];

        await inTx(async (tx) => {
            for (const release of recentReleases) {
                try {
                    // Use repeatKey to avoid duplicates
                    const repeatKey = `integration_update_${release.integration.toLowerCase().replace(/\s+/g, '_')}_${release.version}`;
                    
                    const item = await feedPost(
                        tx,
                        ctx,
                        {
                            kind: 'integration_update',
                            integration: release.integration,
                            version: release.version,
                            message: release.message,
                            type: release.type,
                            releaseUrl: release.releaseUrl
                        },
                        repeatKey
                    );

                    // Only count if item was actually created (not dismissed)
                    if (item) {
                        created++;
                        createdReleases.push({
                            integration: release.integration,
                            version: release.version
                        });
                    }
                } catch (error) {
                    console.error(`[IntegrationReleaseNotes] Error creating feed item for ${release.integration}:`, error);
                }
            }
        });

        return reply.send({
            created,
            releases: createdReleases
        });
    });

    // Get available integration releases (without creating feed items)
    app.get('/v1/integration-releases', {
        preHandler: app.authenticate,
        schema: {
            response: {
                200: z.object({
                    releases: z.array(z.object({
                        integration: z.string(),
                        version: z.string(),
                        message: z.string(),
                        type: z.enum(['update', 'issue', 'deprecation', 'feature']),
                        releaseUrl: z.string().optional(),
                        publishedAt: z.number().optional()
                    }))
                })
            }
        }
    }, async (request, reply) => {
        const releases = await fetchAllIntegrationReleases();
        
        return reply.send({
            releases: releases.map(release => ({
                integration: release.integration,
                version: release.version,
                message: release.message,
                type: release.type,
                releaseUrl: release.releaseUrl,
                publishedAt: release.publishedAt?.getTime()
            }))
        });
    });
}

