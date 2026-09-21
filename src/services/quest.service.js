const Quest = require('../models/quest.model');
const UserDailyQuest = require('../models/userDailyQuest.model');
const User = require('../models/user.model');
const mongoose = require('mongoose');
const moment = require('moment-timezone');
// Chỉ đưa vào pool các hành động đã có event thật trong source. WATER_INTAKE
// sẽ được bật lại cùng endpoint check-in, cooldown và giới hạn theo ngày.
const SUPPORTED_DAILY_ACTIONS = ['LOGIN', 'COOK_FROM_INVENTORY', 'CREATE_TRANSACTION', 'SCAN_RECEIPT'];

const getVietnamDateString = (date = new Date()) => {
    const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Ho_Chi_Minh', year: 'numeric', month: '2-digit', day: '2-digit'
    }).formatToParts(date);
    const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
    return `${values.year}-${values.month}-${values.day}`;
};

const getVietnamDayBounds = (date = new Date()) => {
    const today = moment.tz(date, 'Asia/Ho_Chi_Minh').startOf('day');
    return {
        todayStart: today.toDate(),
        tomorrowStart: today.clone().add(1, 'day').toDate(),
        yesterdayStart: today.clone().subtract(1, 'day').toDate()
    };
};

const applyXp = (levelInput, xpInput, rewardInput) => {
    let level = Math.max(1, Number(levelInput) || 1);
    let xp = Math.max(0, Number(xpInput) || 0) + Math.max(0, Number(rewardInput) || 0);
    while (xp >= level * 100) {
        xp -= level * 100;
        level += 1;
    }
    return { level, xp };
};

const ensureDailyRecord = async userId => {
    const dateString = getVietnamDateString();
    const existing = await UserDailyQuest.findOne({ userId, dateString });
    if (existing) return existing;

    const available = await Quest.find({
        type: 'DAILY',
        isActive: true,
        'condition.actionType': { $in: SUPPORTED_DAILY_ACTIONS }
    }).lean();

    const loginQuest = available.find(q => q.condition.actionType === 'LOGIN');
    const otherQuests = available.filter(q => q.condition.actionType !== 'LOGIN');
    
    // Pick up to 4 other random quests (so total 5 with LOGIN)
    const randomOthers = otherQuests.sort(() => 0.5 - Math.random()).slice(0, 4);
    
    const selectedQuests = [];
    if (loginQuest) selectedQuests.push(loginQuest);
    selectedQuests.push(...randomOthers);

    const quests = selectedQuests.map(quest => {
        let target = Math.max(1, Number(quest.condition?.targetValue) || 1);
        
        // Nhiệm vụ quét hóa đơn và nấu ăn ngẫu nhiên số lượng cần thực hiện (ví dụ từ 1 đến 3)
        if (quest.condition.actionType === 'SCAN_RECEIPT' || quest.condition.actionType === 'COOK_FROM_INVENTORY') {
            target = Math.floor(Math.random() * 3) + 1;
        }

        return {
            questId: quest._id,
            progress: 0,
            target: target,
            isCompleted: false,
            isClaimed: false
        };
    });

    try {
        return await UserDailyQuest.findOneAndUpdate(
            { userId, dateString },
            { $setOnInsert: { userId, dateString, quests } },
            { new: true, upsert: true, setDefaultsOnInsert: true }
        );
    } catch (error) {
        if (error.code === 11000) return UserDailyQuest.findOne({ userId, dateString });
        throw error;
    }
};

exports.triggerDailyQuest = async (userId, actionType, count = 1) => {
    const increment = Number(count);
    if (!userId || !actionType || !Number.isFinite(increment) || increment <= 0) return false;
    try {
        await ensureDailyRecord(userId);
        const quests = await Quest.find({
            type: 'DAILY', isActive: true, 'condition.actionType': actionType
        }).select('_id').lean();
        if (quests.length === 0) return false;
        const questIds = quests.map(quest => quest._id.toString());
        
        const record = await UserDailyQuest.findOne({ userId, dateString: getVietnamDateString() });
        if (!record) return false;
        
        let modified = false;
        for (const q of record.quests) {
            if (questIds.includes(q.questId.toString()) && !q.isCompleted) {
                q.progress = Math.min(q.target, q.progress + increment);
                if (q.progress >= q.target) {
                    q.isCompleted = true;
                }
                modified = true;
            }
        }
        
        if (modified) {
            await record.save();
        }
        return modified;
    } catch (error) {
        console.error('[QuestService] Lỗi khi trigger nhiệm vụ:', error.message);
        return false;
    }
};

exports.triggerAchievement = async (userId, actionType, count = 1) => {
    const increment = Number(count);
    if (!userId || !actionType || !Number.isFinite(increment) || increment <= 0) return [];
    let definitions;
    try {
        definitions = await Quest.find({
            type: 'ACHIEVEMENT', isActive: true, 'condition.actionType': actionType
        }).lean();
    } catch (error) {
        console.error('[QuestService] Không thể tải thành tựu:', error.message);
        return [];
    }
    const unlocked = [];

    for (const quest of definitions) {
        const session = await mongoose.startSession();
        let didUnlock = false;
        try {
            await session.withTransaction(async () => {
                const user = await User.findById(userId).session(session);
                if (!user || user.achievements.some(item =>
                    item.questId && item.questId.toString() === quest._id.toString())) return;

                let progress = user.achievementProgress.find(item =>
                    item.questId && item.questId.toString() === quest._id.toString());
                if (!progress) {
                    user.achievementProgress.push({ questId: quest._id, progress: 0 });
                    progress = user.achievementProgress[user.achievementProgress.length - 1];
                }
                const target = Math.max(1, Number(quest.condition?.targetValue) || 1);
                progress.progress = Math.min(target, progress.progress + increment);
                if (progress.progress >= target) {
                    user.achievements.push({ questId: quest._id, unlockedAt: new Date() });
                    const nextXp = applyXp(user.rpgStats.level, user.rpgStats.xp, quest.rewards?.xp || 0);
                    user.rpgStats.level = nextXp.level;
                    user.rpgStats.xp = nextXp.xp;
                    const title = quest.rewards?.titleUnlock;
                    if (title && !user.unlockedTitles.includes(title)) user.unlockedTitles.push(title);
                    didUnlock = true;
                }
                await user.save({ session });
            });
            if (didUnlock) unlocked.push(quest.code);
        } catch (error) {
            console.error(`[QuestService] Không thể cập nhật thành tựu ${quest.code}:`, error.message);
        } finally {
            await session.endSession();
        }
    }
    return unlocked;
};

exports.getVietnamDateString = getVietnamDateString;
exports.getVietnamDayBounds = getVietnamDayBounds;
exports.applyXp = applyXp;
exports.ensureDailyRecord = ensureDailyRecord;
