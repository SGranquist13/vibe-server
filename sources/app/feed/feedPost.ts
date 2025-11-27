import { Context } from "@/context";
import { FeedBody, UserFeedItem } from "./types";
import { afterTx, Tx } from "@/storage/inTx";
import { allocateUserSeq } from "@/storage/seq";
import { eventRouter, buildNewFeedPostUpdate } from "@/app/events/eventRouter";
import { randomKeyNaked } from "@/utils/randomKeyNaked";

/**
 * Add a post to user's feed.
 * If repeatKey is provided and exists, the post will be updated in-place.
 * Otherwise, a new post is created with an incremented counter.
 * 
 * If repeatKey was previously dismissed by the user, the item will not be created.
 */
export async function feedPost(
    tx: Tx,
    ctx: Context,
    body: FeedBody,
    repeatKey?: string | null
): Promise<UserFeedItem | null> {

    // Check if this repeatKey was previously dismissed
    if (repeatKey) {
        const account = await tx.account.findUnique({
            where: { id: ctx.uid },
            select: { settings: true }
        });

        if (account?.settings) {
            try {
                const settings = JSON.parse(account.settings);
                const dismissedKeys: string[] = settings.dismissedFeedRepeatKeys || [];
                console.log(`[feedPost] Checking repeatKey: ${repeatKey}, dismissed keys:`, dismissedKeys);
                if (dismissedKeys.includes(repeatKey)) {
                    // This item was dismissed, don't create it
                    console.log(`[feedPost] Skipping dismissed item with repeatKey: ${repeatKey}`);
                    return null;
                }
            } catch (error) {
                // Invalid JSON, continue
                console.error('[feedPost] Error parsing account settings:', error);
            }
        } else {
            console.log(`[feedPost] No settings found for user ${ctx.uid}`);
        }

        // Delete existing items with the same repeatKey
        await tx.userFeedItem.deleteMany({
            where: {
                userId: ctx.uid,
                repeatKey: repeatKey
            }
        });
    }

    // Allocate new counter
    const user = await tx.account.update({
        where: { id: ctx.uid },
        select: { feedSeq: true },
        data: { feedSeq: { increment: 1 } }
    });

    // Create new item
    const item = await tx.userFeedItem.create({
        data: {
            counter: user.feedSeq,
            userId: ctx.uid,
            repeatKey: repeatKey,
            body: body
        }
    });

    const result = {
        ...item,
        createdAt: item.createdAt.getTime(),
        cursor: '0-' + item.counter.toString(10),
        repeatKey: item.repeatKey
    };

    // Emit socket event after transaction completes
    afterTx(tx, async () => {
        const updateSeq = await allocateUserSeq(ctx.uid);
        const updatePayload = buildNewFeedPostUpdate(result, updateSeq, randomKeyNaked(12));

        eventRouter.emitUpdate({
            userId: ctx.uid,
            payload: updatePayload,
            recipientFilter: { type: 'all-user-authenticated-connections' }
        });
    });

    return result;
}