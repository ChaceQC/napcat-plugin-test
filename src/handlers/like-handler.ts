
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
    | (NoticeEvent & { notice_type: 'notify'; sub_type: 'profile_like'; target_id: number; user_id: number; })
    | (NoticeEvent & { notice_type: 'thumb_up'; user_id: number; target_id: number; count?: number; });

export async function handleLike(ctx: NapCatPluginContext, event: any) {
    const { logger } = ctx;

    // 调试日志：打印收到的事件
    logger.debug(`[LikeHandler] 收到事件: ${JSON.stringify(event)}`);
    
    const isThumbUp = event.notice_type === 'thumb_up';
    const isPoke = event.notice_type === 'notify' && event.sub_type === 'poke';
    const isProfileLike = event.notice_type === 'notify' && event.sub_type === 'profile_like';

    if (!isThumbUp && !isPoke && !isProfileLike) return;

    const user_id = event.user_id;
    // profile_like usually doesn't have count, assume 1 if missing
    const times = event.count || 1;

    // 检查目标是否为机器人自己
    // 注意：使用 != 而不是 !== 以允许 string 和 number 的比较
    if (event.target_id != pluginState.selfId) {
        // 如果 selfId 为空（尚未初始化），也会导致这里返回
        if (!pluginState.selfId) {
            logger.warn('[LikeHandler] 机器人 SelfId 尚未初始化，跳过处理。');
        }
        return;
    }

    if (!pluginState.config.autoLikeEnabled) {
        return;
    }

    const actionName = isPoke ? '戳一戳' : '点赞';
    logger.info(`收到来自 ${user_id} 的 ${times} 个${actionName}`);

    // 2. 检查黑名单
    if (pluginState.config.blacklist?.includes(Number(user_id))) {
        logger.info(`用户 ${user_id} 在黑名单中，不回应。`);
        return;
    }

    // 3. 检查好友状态
    try {
        const result = await pluginState.callApi('get_friend_list', {});
        
        let friends: any[] = [];
        if (Array.isArray(result)) {
            friends = result;
        } else if (result && Array.isArray(result.data)) {
            friends = result.data;
        } else {
            logger.warn('[LikeHandler] 获取好友列表返回格式异常:', result);
            return;
        }

        const isFriend = friends.some((friend: any) => friend.user_id == user_id);
        if (!isFriend) {
            logger.info(`用户 ${user_id} 不是好友，不回应。`);
            return;
        }
    } catch (error) {
        logger.error('[LikeHandler] 获取好友列表失败:', error);
        return;
    }

    // 4. VIP 规则检查
    try {
        const userInfo = await pluginState.callApi('get_stranger_info', { user_id });
        const isVip = userInfo?.data?.vip || false; 

        if (isVip) {
             const currentLikes = pluginState.getVipLikeCount(Number(user_id));
             if (currentLikes >= pluginState.config.vipLikeLimit) {
                 logger.info(`用户 ${user_id} 是会员，今日已回应 ${currentLikes} 次，达到限制 (${pluginState.config.vipLikeLimit})。`);
                 return;
             }
        }
    } catch (error) {
        logger.warn(`获取用户 ${user_id} 信息失败，无法检查会员状态。`, error);
    }

    // 5. 执行回赞/回戳
    try {
        if (isThumbUp || isProfileLike) {
            // 点赞事件 -> 回戳 (因为没有 send_like API)
            await pluginState.callApi('friend_poke', { user_id });
            logger.info(`收到用户 ${user_id} 的点赞，已回戳。`);
        } else if (isPoke) {
            // 戳一戳事件 -> 回戳
            if (event.group_id) {
                await pluginState.callApi('group_poke', { group_id: event.group_id, user_id });
                logger.info(`收到群 ${event.group_id} 内用户 ${user_id} 的戳一戳，已回戳。`);
            } else {
                await pluginState.callApi('friend_poke', { user_id });
                logger.info(`收到用户 ${user_id} 的戳一戳，已回戳。`);
            }
        }

        // 6. 更新计数
        pluginState.incrementVipLikeCount(Number(user_id));

    } catch (error) {
        logger.error(`回戳/回赞用户 ${user_id} 失败:`, error);
    }
}
