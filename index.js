/**
 * 晨昏之线 - 时间感知与整点主动问候插件
 *
 * 职能一：被动工具 —— 提供时间查询和问候语时间检查（取代 beijingTimeServer1.js）
 * 职能二：主动问候 —— 在设定整点智能发起问候，根据对话活跃度选择策略
 *
 * 作者：爱熬夜的人形兔
 * 版本：1.0.0
 */

const { Plugin } = require('../../../js/core/plugin-base.js');

const PATCH_ID = 'dawn-dusk-line-greeting';

// 注入系统提示词用：引导 AI 在下次回复中自然融入问候
const GREETING_PROMPTS = {
    0:  '现在是午夜12点了，夜深了。如果你接下来要回复用户，请自然地提醒对方注意休息、早点睡觉，语气温柔关切，不要生硬地报时。',
    8:  '现在是早上8点，新的一天开始了。如果你接下来要回复用户，请自然地说一句早安问候，可以提到早晨的感觉，语气活泼温暖，不要生硬地报时。',
    12: '现在是中午12点，该吃午饭了。如果你接下来要回复用户，请自然地提醒对方吃午饭、休息一下，语气轻松日常，不要生硬地报时。',
    18: '现在是傍晚6点，一天快结束了。如果你接下来要回复用户，请自然地说一句傍晚的问候，可以关心对方今天过得怎么样，语气温和，不要生硬地报时。'
};

// 直接发送用：给 AI 一个情景提示让它自由发挥
const DIRECT_GREETING_HINTS = {
    0:  '（现在是午夜12点，夜深了，关心一下对方是否还没睡，温柔地提醒早点休息）',
    8:  '（现在是早上8点，新的一天，元气满满地跟对方说早安吧）',
    12: '（现在是中午12点了，提醒对方该吃午饭了，关心一下）',
    18: '（现在是傍晚6点，一天快结束了，问问对方今天过得怎么样）'
};

class DawnDuskLinePlugin extends Plugin {

    // ==================== 生命周期 ====================

    async onInit() {
        const cfg = this.context.getPluginFileConfig();

        const hoursStr = cfg.greetingHours ?? '0,8,12,18';
        this._greetingHours = hoursStr.split(',').map(h => parseInt(h.trim(), 10)).filter(h => !isNaN(h));
        this._quietThreshold  = (cfg.quietThreshold  ?? 10) * 60 * 1000;
        this._activeThreshold = (cfg.activeThreshold  ?? 3)  * 60 * 1000;
        this._deferTimeout    = (cfg.deferTimeout     ?? 30) * 60 * 1000;
        this._checkInterval   = (cfg.checkInterval    ?? 30) * 1000;

        this._lastInteractionTime = Date.now();
        this._firedHours = new Set();
        this._checkTimer = null;
        this._deferredGreeting = null;
        this._deferTimer = null;
        this._patchApplied = false;
    }

    async onStart() {
        this._onInteraction = () => {
            this._lastInteractionTime = Date.now();
        };

        this.context.on('interaction:updated', this._onInteraction);
        this.context.on('user:message:received', this._onInteraction);

        this._onTTSEnd = () => this._tryFlushDeferred();
        this.context.on('tts:end', this._onTTSEnd);

        this._checkTimer = setInterval(() => this._tick(), this._checkInterval);

        this.context.log('info',
            `晨昏之线已启动 | 问候时刻: ${this._greetingHours.join(',')}点 | 检查间隔: ${this._checkInterval / 1000}s`);
    }

    async onStop() {
        if (this._checkTimer) { clearInterval(this._checkTimer); this._checkTimer = null; }
        if (this._deferTimer) { clearInterval(this._deferTimer); this._deferTimer = null; }
        if (this._onInteraction) {
            this.context.off('interaction:updated', this._onInteraction);
            this.context.off('user:message:received', this._onInteraction);
        }
        if (this._onTTSEnd) {
            this.context.off('tts:end', this._onTTSEnd);
        }
        this._removePatch();
    }

    // ==================== 工具注册（取代 FC 工具） ====================

    getTools() {
        return [
            {
                type: 'function',
                function: {
                    name: 'dawn_dusk_get_time',
                    description: '当用户明确询问当前时间、日期或星期时调用此工具。例如："现在几点？", "今天星期几？"',
                    parameters: {
                        type: 'object',
                        properties: {
                            timezone: {
                                type: 'string',
                                description: '时区（可选，如 Asia/Shanghai，默认北京时间）'
                            }
                        },
                        required: []
                    }
                }
            },
            {
                type: 'function',
                function: {
                    name: 'dawn_dusk_greeting_check',
                    description: '当用户使用与时间相关的问候语或道别语时自动调用。例如："早上好", "晚上好", "晚安", "晚上见"',
                    parameters: {
                        type: 'object',
                        properties: {},
                        required: []
                    }
                }
            }
        ];
    }

    async executeTool(name, params) {
        switch (name) {
            case 'dawn_dusk_get_time':
            case 'dawn_dusk_greeting_check':
                return this._getCurrentTime(params && params.timezone);
            default:
                throw new Error(`晨昏之线：不支持的工具 ${name}`);
        }
    }

    _getCurrentTime(timezone) {
        const tz = timezone || 'Asia/Shanghai';
        const now = new Date();

        const formattedTime = now.toLocaleString('zh-CN', {
            timeZone: tz,
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
            hour12: false
        });

        return `当前${tz}时间：${formattedTime}`;
    }

    // ==================== 主动问候系统 ====================

    _tick() {
        const now = new Date();
        const hour = now.getHours();
        const minute = now.getMinutes();
        const dateKey = `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}-${hour}`;

        // 清理过期的 key，只保留当天的条目
        const todayPrefix = `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}-`;
        for (const key of this._firedHours) {
            if (!key.startsWith(todayPrefix)) {
                this._firedHours.delete(key);
            }
        }

        // 只在整点后 5 分钟内有效
        if (minute > 5) return;

        if (!this._greetingHours.includes(hour)) return;
        if (this._firedHours.has(dateKey)) return;

        this._firedHours.add(dateKey);
        this._initiateGreeting(hour);
    }

    _initiateGreeting(hour) {
        const elapsed = Date.now() - this._lastInteractionTime;

        // 先检查 AI 是否正在说话或处理中
        try {
            const { appState } = require('../../../js/core/app-state.js');
            if (appState.isPlayingTTS() || appState.isProcessingUserInput()) {
                this.context.log('info', `[晨昏之线] ${hour}点问候 → AI正在说话/处理中，注入提示词`);
                this._injectPatch(hour);
                return;
            }
        } catch (_) {}

        if (elapsed < this._activeThreshold) {
            // 对话活跃中，不直接打招呼，注入提示词让 AI 下次回复时自然融入
            this.context.log('info', `[晨昏之线] ${hour}点问候 → 对话活跃中(${Math.round(elapsed / 1000)}s前)，注入提示词`);
            this._injectPatch(hour);
        } else if (elapsed >= this._quietThreshold) {
            // 静默状态，直接主动问候
            this.context.log('info', `[晨昏之线] ${hour}点问候 → 静默状态(${Math.round(elapsed / 1000)}s前)，直接主动问候`);
            this._sendDirectGreeting(hour);
        } else {
            // 半活跃状态，延迟等待
            this.context.log('info', `[晨昏之线] ${hour}点问候 → 半活跃状态，进入延迟等待`);
            this._deferGreeting(hour);
        }
    }

    async _sendDirectGreeting(hour) {
        const hint = DIRECT_GREETING_HINTS[hour] || `（现在是${hour}点，自然地打个招呼）`;
        try {
            await this.context.sendMessage(hint);
        } catch (e) {
            this.context.log('error', `[晨昏之线] 主动问候发送失败: ${e.message}`);
        }
    }

    _injectPatch(hour) {
        const prompt = GREETING_PROMPTS[hour] || `现在是${hour}点，请在下次回复中自然地融入一句应景的问候。`;
        this.context.addSystemPromptPatch(PATCH_ID, prompt);
        this._patchApplied = true;
    }

    _removePatch() {
        if (this._patchApplied) {
            this.context.removeSystemPromptPatch(PATCH_ID);
            this._patchApplied = false;
        }
    }

    _deferGreeting(hour) {
        if (this._deferredGreeting) return;
        this._deferredGreeting = { hour, startTime: Date.now() };

        this._deferTimer = setInterval(() => {
            if (!this._deferredGreeting) {
                clearInterval(this._deferTimer);
                this._deferTimer = null;
                return;
            }

            const waitedMs = Date.now() - this._deferredGreeting.startTime;
            if (waitedMs > this._deferTimeout) {
                this.context.log('info', `[晨昏之线] 延迟等待超时(${Math.round(waitedMs / 60000)}min)，放弃本次问候`);
                this._deferredGreeting = null;
                clearInterval(this._deferTimer);
                this._deferTimer = null;
                return;
            }

            const elapsed = Date.now() - this._lastInteractionTime;
            if (elapsed >= this._quietThreshold) {
                const h = this._deferredGreeting.hour;
                this._deferredGreeting = null;
                clearInterval(this._deferTimer);
                this._deferTimer = null;
                this.context.log('info', `[晨昏之线] 检测到对话间隙，发送延迟问候`);
                this._sendDirectGreeting(h);
            }
        }, 15000);
    }

    _tryFlushDeferred() {
        // TTS 结束时，如果有延迟问候且已进入静默，触发检查
        if (!this._deferredGreeting) return;
        const elapsed = Date.now() - this._lastInteractionTime;
        if (elapsed >= this._quietThreshold) {
            const h = this._deferredGreeting.hour;
            this._deferredGreeting = null;
            if (this._deferTimer) { clearInterval(this._deferTimer); this._deferTimer = null; }
            this.context.log('info', `[晨昏之线] TTS结束后检测到静默，发送延迟问候`);
            this._sendDirectGreeting(h);
        }
    }

    // ==================== 消息钩子 ====================

    async onLLMResponse(response) {
        // AI 回复后，自动清除已注入的一次性提示词
        if (this._patchApplied) {
            this._removePatch();
        }
    }
}

module.exports = DawnDuskLinePlugin;
