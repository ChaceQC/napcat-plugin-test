
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
    | (NoticeEvent & { notice_type: 'notify'; sub_type: 'profile_like'; operator_id: number; times?: number; })
    | (NoticeEvent & { notice_type: 'thumb_up'; user_id: number; target_id: number; count?: number; });

export async function handleLike(ctx: NapCatPluginContext, event: any) {
    const { logger } = ctx;

    // 调试日志：打印收到的事件
    logger.debug(`[LikeHandler] 收到事件: ${JSON.stringify(event)}`);
    
    const isThumbUp = event.notice_type === 'thumb_up';
    const isPoke = event.notice_type === 'notify' && event.sub_type === 'poke';
    const isProfileLike = event.notice_type === 'notify' && event.sub_type === 'profile_like';

    if (!isThumbUp && !isPoke && !isProfileLike) return;

    // 提取 user_id (操作者) 和 次数
    let user_id: number;
    let times = 1;

    if (isProfileLike) {
        // 根据提供的 payload: { operator_id: ..., times: ... }
        user_id = event.operator_id;
        times = event.times || 1;
        
        // profile_like 事件通常发给被点赞的人（也就是机器人自己）
        // 所以不需要像 poke 那样检查 target_id，只要收到这个事件就说明是给我们的
    } else {
        // thumb_up 和 poke 通常有 user_id 和 target_id
        user_id = event.user_id;
        times = event.count || 1;

        // 检查目标是否为机器人自己
        // 注意：使用 != 而不是 !== 以允许 string 和 number 的比较
        if (event.target_id != pluginState.selfId) {
            // 如果 selfId 为空（尚未初始化），也会导致这里返回
            if (!pluginState.selfId) {
                logger.warn('[LikeHandler] 机器人 SelfId 尚未初始化，跳过处理。');
            }
            return;
        }
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
            // 用户确认 send_like 是正确的 API
            // send_like payload: { user_id, times }
            await pluginState.callApi('send_like', { user_id: String(user_id), times });
            logger.info(`收到用户 ${user_id} 的点赞，已回赞 ${times} 次。`);
        } else if (isPoke) {
            // 戳一戳事件 -> 回戳
            if (event.group_id) {
                await pluginState.callApi('group_poke', { group_id: String(event.group_id), user_id: String(user_id) });
                logger.info(`收到群 ${event.group_id} 内用户 ${user_id} 的戳一戳，已回戳。`);
            } else {
                // 用户反馈 "poke只有群poke"，意味着私聊戳一戳可能不支持或不应处理
                logger.info(`收到用户 ${user_id} 的私聊戳一戳，但仅支持群聊回戳，忽略。`);
            }
        }

        // 6. 更新计数
        pluginState.incrementVipLikeCount(Number(user_id));

    } catch (error: any) {
        const errMsg = error?.message || String(error);
        
        // 特殊处理 "No data returned" 错误 (send_like 成功但无返回)
        if (errMsg.includes('No data returned')) {
            logger.info(`已回赞用户 ${user_id} ${times} 次 (API无返回值，视为成功)`);
            pluginState.incrementVipLikeCount(Number(user_id));
        } 
        // 特殊处理 "packetBackend不可用" 错误 (group_poke 失败)
        else if (errMsg.includes('packetBackend不可用')) {
            logger.warn(`回戳失败: NapCat packetBackend 未配置或不可用。请检查 NapCat 配置以启用戳一戳功能。`);
            // 不更新计数，因为实际上失败了
        }
        else {
            logger.error(`回戳/回赞用户 ${user_id} 失败:`, error);
        }
    }
}
