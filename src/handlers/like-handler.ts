
import type { NapCatPluginContext } from 'napcat-types/napcat-onebot/network/plugin/types';
import { pluginState } from '../core/state';

// Define minimal interfaces for the events we handle
interface BaseEvent {
    post_type: string;
    [key: string]: any;
}

interface NoticeEvent extends BaseEvent {
    post_type: 'notice';
    notice_type: string;
}

// Define a union type for potential like events
type LikeEvent = 
    | (NoticeEvent & { notice_type: 'notify'; sub_type: 'poke'; target_id: number; user_id: number; group_id?: number; })
    | (NoticeEvent & { notice_type: 'thumb_up'; user_id: number; target_id: number; count?: number; });

export async function handleLike(ctx: NapCatPluginContext, event: LikeEvent) {
    const { logger } = ctx;
    
    const isLikeOrPoke = (event.notice_type === 'thumb_up') || 
                         (event.notice_type === 'notify' && event.sub_type === 'poke');

    if (!isLikeOrPoke) return;

    const user_id = event.user_id;
    const times = 'count' in event ? event.count || 1 : 1;

    if (event.target_id !== parseInt(pluginState.selfId)) {
        return;
    }

    if (!pluginState.config.autoLikeEnabled) {
        return;
    }

    logger.info(`收到来自 ${user_id} 的 ${event.notice_type === 'thumb_up' ? `${times} 个赞` : '戳一戳'}`);

    if (pluginState.config.blacklist?.includes(user_id)) {
        logger.info(`用户 ${user_id} 在黑名单中，不回应。`);
        return;
    }

    try {
        const friendList = await pluginState.callApi('get_friend_list', {});
        const isFriend = friendList.data.some((friend: any) => friend.user_id === user_id);
        if (!isFriend) {
            logger.info(`用户 ${user_id} 不是好友，不回应。`);
            return;
        }
    } catch (error) {
        logger.error('获取好友列表失败:', error);
        return;
    }

    try {
        const userInfo = await pluginState.callApi('get_stranger_info', { user_id });
        const isVip = userInfo.data.vip || false; 

        if (isVip) {
             const currentLikes = pluginState.getVipLikeCount(user_id);
             if (currentLikes >= pluginState.config.vipLikeLimit) {
                 logger.info(`用户 ${user_id} 是会员，今日已回应 ${currentLikes} 次，达到限制 (${pluginState.config.vipLikeLimit})。`);
                 return;
             }
        }
    } catch (error) {
        logger.warn(`获取用户 ${user_id} 信息失败，无法检查会员状态。`, error);
    }

    // 5. Perform action
    try {
        // NapCat API does not have 'send_like' for profile liking.
        // We will poke back for both pokes and likes as an acknowledgement.
        
        if (event.notice_type === 'thumb_up') {
            // For a profile like, poke the user back in private.
            await pluginState.callApi('friend_poke', { user_id });
            logger.info(`收到用户 ${user_id} 的 ${times} 个赞，已回戳。`);
        } else if (event.sub_type === 'poke') {
            // For a poke, poke back.
            if (event.group_id) {
                await pluginState.callApi('group_poke', { group_id: event.group_id, user_id });
                logger.info(`收到群 ${event.group_id} 内用户 ${user_id} 的戳一戳，已回戳。`);
            } else {
                await pluginState.callApi('friend_poke', { user_id });
                logger.info(`收到用户 ${user_id} 的戳一戳，已回戳。`);
            }
        }

        // 6. Update state
        pluginState.incrementVipLikeCount(user_id);

    } catch (error) {
        logger.error(`回戳/回赞用户 ${user_id} 失败:`, error);
    }
}
