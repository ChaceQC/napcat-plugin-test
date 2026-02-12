
/**
 * 全局状态管理模块（单例模式）
 *
 * 封装插件的配置持久化和运行时状态，提供在项目任意位置访问
 * ctx、config、logger 等对象的能力，无需逐层传递参数。
 *
 * 使用方法：
 *   import { pluginState } from '../core/state';
 *   pluginState.config.enabled;       // 读取配置
 *   pluginState.ctx.logger.info(...); // 使用日志
 */

import fs from 'fs';
import path from 'path';
import type { NapCatPluginContext, PluginLogger } from 'napcat-types/napcat-onebot/network/plugin/types';
import { DEFAULT_CONFIG } from '../config';
import type { PluginConfig, GroupConfig } from '../types';

// ==================== 配置清洗工具 ====================

function isObject(v: unknown): v is Record<string, unknown> {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/**
 * 配置清洗函数
 * 确保从文件读取的配置符合预期类型，防止运行时错误
 */
function sanitizeConfig(raw: unknown): PluginConfig {
    if (!isObject(raw)) return { ...DEFAULT_CONFIG };

    const out: PluginConfig = { ...DEFAULT_CONFIG };

    if (typeof raw.enabled === 'boolean') out.enabled = raw.enabled;
    if (typeof raw.debug === 'boolean') out.debug = raw.debug;

    if (typeof raw.autoLikeEnabled === 'boolean') out.autoLikeEnabled = raw.autoLikeEnabled;
    if (typeof raw.vipLikeLimit === 'number') out.vipLikeLimit = raw.vipLikeLimit;
    
    if (Array.isArray(raw.blacklist)) {
        out.blacklist = raw.blacklist.filter((id): id is number => typeof id === 'number');
    } else if (typeof raw.blacklist === 'string') {
        // Handle string input from UI (comma separated)
        out.blacklist = raw.blacklist.split(',')
            .map(s => parseInt(s.trim(), 10))
            .filter(n => !isNaN(n));
    }

    // 自动赞某人配置
    if (typeof raw.autoLikeSomeoneEnabled === 'boolean') out.autoLikeSomeoneEnabled = raw.autoLikeSomeoneEnabled;
    if (typeof raw.autoLikeInterval === 'number') out.autoLikeInterval = raw.autoLikeInterval;
    if (typeof raw.autoLikeTimes === 'number') out.autoLikeTimes = raw.autoLikeTimes;
    
    if (Array.isArray(raw.autoLikeUsers)) {
        out.autoLikeUsers = raw.autoLikeUsers.filter((id): id is number => typeof id === 'number');
    } else if (typeof raw.autoLikeUsers === 'string') {
        // Handle string input from UI (comma separated)
        out.autoLikeUsers = raw.autoLikeUsers.split(',')
            .map(s => parseInt(s.trim(), 10))
            .filter(n => !isNaN(n));
    }

    return out;
}

// ==================== 插件全局状态类 ====================

class PluginState {
    /** NapCat 插件上下文（init 后可用） */
    private _ctx: NapCatPluginContext | null = null;

    /** 插件配置 */
    config: PluginConfig = { ...DEFAULT_CONFIG };

    /** 插件启动时间戳 */
    startTime: number = 0;

    /** 机器人自身 QQ 号 */
    selfId: string = '';

    /** 活跃的定时器 Map: jobId -> NodeJS.Timeout */
    timers: Map<string, ReturnType<typeof setInterval>> = new Map();

    /** 运行时统计 */
    stats = {
        processed: 0,
        todayProcessed: 0,
        lastUpdateDay: new Date().toDateString(),
    };

    /** VIP 用户点赞计数 (每日重置) */
    vipLikeCounts: Record<number, number> = {};
    lastVipLikeResetDay: string = new Date().toDateString();

    /** 获取上下文（确保已初始化） */
    get ctx(): NapCatPluginContext {
        if (!this._ctx) throw new Error('PluginState 尚未初始化，请先调用 init()');
        return this._ctx;
    }

    /** 获取日志器的快捷方式 */
    get logger(): PluginLogger {
        return this.ctx.logger;
    }

    // ==================== 生命周期 ====================

    /**
     * 初始化（在 plugin_init 中调用）
     */
    init(ctx: NapCatPluginContext): void {
        this._ctx = ctx;
        this.startTime = Date.now();
        this.loadConfig();
        this.ensureDataDir();
        this.fetchSelfId();
        
        // Load VIP like counts if persisted, or just init
        this.vipLikeCounts = this.loadDataFile('vip_likes.json', {});
        this.checkVipLikeReset();
        
        // 启动自动赞定时器
        this.startAutoLikeTimer();
    }

    /**
     * 获取机器人自身 QQ 号（异步，init 时自动调用）
     */
    private async fetchSelfId(): Promise<void> {
        try {
            const res = await this.ctx.actions.call(
                'get_login_info', {}, this.ctx.adapterName, this.ctx.pluginManager.config
            ) as { user_id?: number | string };
            if (res?.user_id) {
                this.selfId = String(res.user_id);
                this.logger.debug("(｡·ω·｡) 机器人 QQ: " + this.selfId);
            }
        } catch (e) {
            this.logger.warn("(；′⌒`) 获取机器人 QQ 号失败:", e);
        }
    }

    /**
     * 清理（在 plugin_cleanup 中调用）
     */
    cleanup(): void {
        // 清理所有定时器
        for (const [jobId, timer] of this.timers) {
            clearInterval(timer);
            this.logger.debug(`(｡-ω-) 清理定时器: ${jobId}`);
        }
        this.timers.clear();
        this.saveConfig();
        this.saveDataFile('vip_likes.json', this.vipLikeCounts);
        this._ctx = null;
    }

    // ==================== 数据目录 ====================

    /** 确保数据目录存在 */
    private ensureDataDir(): void {
        const dataPath = this.ctx.dataPath;
        if (!fs.existsSync(dataPath)) {
            fs.mkdirSync(dataPath, { recursive: true });
        }
    }

    /** 获取数据文件完整路径 */
    getDataFilePath(filename: string): string {
        return path.join(this.ctx.dataPath, filename);
    }

    // ==================== 通用数据文件读写 ====================

    /**
     * 读取 JSON 数据文件
     * 常用于订阅数据、定时任务配置、推送历史等持久化数据
     * @param filename 数据文件名（如 'subscriptions.json'）
     * @param defaultValue 文件不存在或解析失败时的默认值
     */
    loadDataFile<T>(filename: string, defaultValue: T): T {
        const filePath = this.getDataFilePath(filename);
        try {
            if (fs.existsSync(filePath)) {
                return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
            }
        } catch (e) {
            this.logger.warn("(；′⌒`) 读取数据文件 " + filename + " 失败:", e);
        }
        return defaultValue;
    }

    /**
     * 保存 JSON 数据文件
     * @param filename 数据文件名
     * @param data 要保存的数据
     */
    saveDataFile<T>(filename: string, data: T): void {
        const filePath = this.getDataFilePath(filename);
        try {
            fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
        } catch (e) {
            this.logger.error("(╥﹏╥) 保存数据文件 " + filename + " 失败:", e);
        }
    }

    // ==================== 配置管理 ====================

    /**
     * 从磁盘加载配置
     */
    loadConfig(): void {
        const configPath = this.ctx.configPath;
        try {
            if (configPath && fs.existsSync(configPath)) {
                const raw = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
                this.config = sanitizeConfig(raw);
                // 加载统计信息
                if (isObject(raw) && isObject(raw.stats)) {
                    Object.assign(this.stats, raw.stats);
                }
                this.ctx.logger.debug('已加载本地配置');
            } else {
                this.config = { ...DEFAULT_CONFIG };
                this.saveConfig();
                this.ctx.logger.debug('配置文件不存在，已创建默认配置');
            }
        } catch (error) {
            this.ctx.logger.error('加载配置失败，使用默认配置:', error);
            this.config = { ...DEFAULT_CONFIG };
        }
    }

    /**
     * 保存配置到磁盘
     */
    saveConfig(): void {
        if (!this._ctx) return;
        const configPath = this._ctx.configPath;
        try {
            const configDir = path.dirname(configPath);
            if (!fs.existsSync(configDir)) {
                fs.mkdirSync(configDir, { recursive: true });
            }
            const data = { ...this.config, stats: this.stats };
            fs.writeFileSync(configPath, JSON.stringify(data, null, 2), 'utf-8');
        } catch (error) {
            this._ctx.logger.error('保存配置失败:', error);
        }
    }

    /**
     * 合并更新配置
     */
    updateConfig(partial: Partial<PluginConfig>): void {
        // Handle blacklist string update from UI
        if ('blacklist' in partial && typeof partial.blacklist === 'string') {
             const str = partial.blacklist as string;
             partial.blacklist = str.split(',')
                .map(s => parseInt(s.trim(), 10))
                .filter(n => !isNaN(n));
        }
        
        // Handle autoLikeUsers string update from UI
        if ('autoLikeUsers' in partial && typeof partial.autoLikeUsers === 'string') {
            const str = partial.autoLikeUsers as string;
            partial.autoLikeUsers = str.split(',')
                .map(s => parseInt(s.trim(), 10))
                .filter(n => !isNaN(n));
        }
        
        this.config = { ...this.config, ...partial };
        this.saveConfig();
        
        // 重新启动自动赞定时器
        this.restartAutoLikeTimer();
    }

    /**
     * 完整替换配置
     */
    replaceConfig(config: PluginConfig): void {
        this.config = sanitizeConfig(config);
        this.saveConfig();
    }

    // ==================== 统计 ====================

    /**
     * 增加处理计数
     */
    incrementProcessed(): void {
        const today = new Date().toDateString();
        if (this.stats.lastUpdateDay !== today) {
            this.stats.todayProcessed = 0;
            this.stats.lastUpdateDay = today;
        }
        this.stats.todayProcessed++;
        this.stats.processed++;
    }

    // ==================== VIP Like Management ====================

    private checkVipLikeReset() {
        const today = new Date().toDateString();
        if (this.lastVipLikeResetDay !== today) {
            this.vipLikeCounts = {};
            this.lastVipLikeResetDay = today;
            this.saveDataFile('vip_likes.json', this.vipLikeCounts);
        }
    }

    getVipLikeCount(userId: number): number {
        this.checkVipLikeReset();
        return this.vipLikeCounts[userId] || 0;
    }

    incrementVipLikeCount(userId: number): void {
        this.checkVipLikeReset();
        this.vipLikeCounts[userId] = (this.vipLikeCounts[userId] || 0) + 1;
        this.saveDataFile('vip_likes.json', this.vipLikeCounts);
    }

    // ==================== API Helper ====================
    
    async callApi(action: string, params: any): Promise<any> {
        // @ts-ignore
        return this.ctx.actions.call(action, params, this.ctx.adapterName, this.ctx.pluginManager.config);
    }

    // ==================== 工具方法 ====================

    /** 获取运行时长（毫秒） */
    getUptime(): number {
        return Date.now() - this.startTime;
    }

    /** 获取格式化的运行时长 */
    getUptimeFormatted(): string {
        const ms = this.getUptime();
        const s = Math.floor(ms / 1000);
        const m = Math.floor(s / 60);
        const h = Math.floor(m / 60);
        const d = Math.floor(h / 24);

        if (d > 0) return `${d}天${h % 24}小时`;
        if (h > 0) return `${h}小时${m % 60}分钟`;
        if (m > 0) return `${m}分钟${s % 60}秒`;
        return `${s}秒`;
    }

    // ==================== 自动赞某人 ====================

    /**
     * 启动自动赞定时器
     */
    startAutoLikeTimer(): void {
        // 先停止现有定时器
        this.stopAutoLikeTimer();
        
        // 检查是否启用自动赞某人
        if (!this.config.autoLikeSomeoneEnabled || this.config.autoLikeUsers.length === 0) {
            return;
        }
        
        // 设置定时器
        const interval = this.config.autoLikeInterval * 60 * 1000; // 转换为毫秒
        const timer = setInterval(() => {
            this.executeAutoLike();
        }, interval);
        
        this.timers.set('autoLike', timer);
        this.logger.info(`自动赞定时器已启动，间隔 ${this.config.autoLikeInterval} 分钟`);
    }

    /**
     * 停止自动赞定时器
     */
    stopAutoLikeTimer(): void {
        if (this.timers.has('autoLike')) {
            clearInterval(this.timers.get('autoLike')!);
            this.timers.delete('autoLike');
            this.logger.info('自动赞定时器已停止');
        }
    }

    /**
     * 重新启动自动赞定时器
     */
    restartAutoLikeTimer(): void {
        this.startAutoLikeTimer();
    }

    /**
     * 执行自动赞
     */
    private async executeAutoLike(): Promise<void> {
        if (!this.config.autoLikeSomeoneEnabled || this.config.autoLikeUsers.length === 0) {
            return;
        }
        
        const times = this.config.autoLikeTimes;
        
        for (const userId of this.config.autoLikeUsers) {
            try {
                await this.callApi('send_like', { user_id: String(userId), times });
                this.logger.info(`已自动赞用户 ${userId} ${times} 次`);
                
                // 增加处理计数
                this.incrementProcessed();
                
                // 避免频繁调用API被限制，每次赞后暂停1秒
                await new Promise(resolve => setTimeout(resolve, 1000));
            } catch (error: any) {
                const errMsg = error?.message || String(error);
                if (errMsg.includes('No data returned')) {
                    this.logger.info(`已自动赞用户 ${userId} ${times} 次 (API无返回值，视为成功)`);
                    this.incrementProcessed();
                } else {
                    this.logger.error(`自动赞用户 ${userId} 失败:`, error);
                }
            }
        }
    }

    /**
     * 立即执行一次自动赞
     */
    async executeAutoLikeNow(): Promise<void> {
        await this.executeAutoLike();
    }
}

/** 导出全局单例 */
export const pluginState = new PluginState();
