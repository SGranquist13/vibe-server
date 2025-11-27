import * as z from "zod";

export const FeedBodySchema = z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('friend_request'), uid: z.string() }),
    z.object({ kind: z.literal('friend_accepted'), uid: z.string() }),
    z.object({ kind: z.literal('text'), text: z.string() }),
    z.object({
        kind: z.literal('integration_update'),
        integration: z.string(),
        version: z.string().optional(),
        message: z.string(),
        type: z.enum(['update', 'issue', 'deprecation', 'feature']),
        releaseUrl: z.string().optional()
    }),
    z.object({
        kind: z.literal('system_notification'),
        title: z.string(),
        message: z.string(),
        severity: z.enum(['info', 'warning', 'error', 'success']),
        actionUrl: z.string().optional()
    })
]);

export type FeedBody = z.infer<typeof FeedBodySchema>;

export interface UserFeedItem {
    id: string;
    userId: string;
    repeatKey: string | null;
    body: FeedBody;
    createdAt: number;
    cursor: string;
}

export interface FeedCursor {
    before?: string;
    after?: string;
}

export interface FeedOptions {
    limit?: number;
    cursor?: FeedCursor;
}

export interface FeedResult {
    items: UserFeedItem[];
    hasMore: boolean;
}