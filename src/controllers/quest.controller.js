const mongoose = require('mongoose');
const Quest = require('../models/quest.model');
const UserDailyQuest = require('../models/userDailyQuest.model');
const User = require('../models/user.model');
const RpgLog = require('../models/rpgLog.model');
const questService = require('../services/quest.service');

exports.getDailyQuests = async (req, res, next) => {
  try {
    const userId = req.user.userId;
    const dateString = questService.getVietnamDateString();
    await questService.ensureDailyRecord(userId);
    
    // Trigger login quest immediately when fetching daily quests
    await questService.triggerDailyQuest(userId, 'LOGIN', 1);
    
    const record = await UserDailyQuest.findOne({ userId, dateString }).populate('quests.questId');
    const user = await User.findById(userId).select('rpgStats.loginStreak').lean();
    
    return res.status(200).json({
      success: true,
      data: record,
      loginStreak: user?.rpgStats?.loginStreak || 0
    });
  } catch (error) {
    next(error);
  }
};

exports.claimQuestReward = async (req, res, next) => {
  const session = await mongoose.startSession();
  try {
    const userId = req.user.userId;
    const { questId } = req.params;
    const dateString = questService.getVietnamDateString();
    let responseData;

    await session.withTransaction(async () => {
      const claimed = await UserDailyQuest.findOneAndUpdate(
        { userId, dateString, quests: { $elemMatch: { questId, isCompleted: true, isClaimed: false } } },
        { $set: { 'quests.$.isClaimed': true, 'quests.$.completedAt': new Date() } },
        { new: true, session }
      );
      if (!claimed) {
        const record = await UserDailyQuest.findOne({ userId, dateString }).session(session);
        const item = record?.quests.find(entry => entry.questId.toString() === questId);
        const error = new Error(!record
          ? 'Không tìm thấy danh sách nhiệm vụ hôm nay.'
          : !item
            ? 'Nhiệm vụ này không có trong danh sách hôm nay.'
            : item.isClaimed
              ? 'Phần thưởng của nhiệm vụ này đã được nhận.'
              : 'Nhiệm vụ chưa hoàn thành.');
        error.statusCode = !record || !item ? 404 : 409;
        throw error;
      }

      const quest = await Quest.findById(questId).session(session).lean();
      if (!quest || !quest.isActive) {
        const error = new Error('Nhiệm vụ không còn khả dụng.');
        error.statusCode = 409;
        throw error;
      }
      const user = await User.findById(userId).session(session);
      if (!user) {
        const error = new Error('Không tìm thấy người dùng.');
        error.statusCode = 404;
        throw error;
      }

      const xp = Math.max(0, Number(quest.rewards?.xp) || 0);
      const nextXp = questService.applyXp(user.rpgStats.level, user.rpgStats.xp, xp);
      user.rpgStats.level = nextXp.level;
      user.rpgStats.xp = nextXp.xp;
      
      // Update streak if this is the LOGIN quest
      if (quest.condition?.actionType === 'LOGIN') {
        const { todayStart, yesterdayStart } = questService.getVietnamDayBounds(new Date());
        if (!user.rpgStats.lastLoginDate || user.rpgStats.lastLoginDate < yesterdayStart) {
          user.rpgStats.loginStreak = 1;
        } else if (user.rpgStats.lastLoginDate >= yesterdayStart && user.rpgStats.lastLoginDate < todayStart) {
          user.rpgStats.loginStreak = (user.rpgStats.loginStreak || 0) + 1;
        } else {
          user.rpgStats.loginStreak = Math.max(1, user.rpgStats.loginStreak || 1);
        }
        user.rpgStats.lastLoginDate = new Date();
      }

      const titleUnlock = quest.rewards?.titleUnlock;
      if (titleUnlock && !user.unlockedTitles.includes(titleUnlock)) user.unlockedTitles.push(titleUnlock);
      await user.save({ session });
      
      // Ghi log
      await RpgLog.create([{
          userId,
          type: 'QUEST',
          title: `Hoàn thành: ${quest.name}`,
          xpChange: xp,
          metadata: { questId: quest._id }
      }], { session });
      
      responseData = {
        rewards: { xp, titleUnlock: titleUnlock || null },
        rpgStats: user.rpgStats
      };
    });

    return res.status(200).json({
      success: true,
      message: 'Nhận thưởng thành công!',
      rewards: responseData.rewards,
      rpgStats: responseData.rpgStats
    });
  } catch (error) {
    next(error);
  } finally {
    await session.endSession();
  }
};

exports.getAchievements = async (req, res, next) => {
  try {
    const user = await User.findById(req.user.userId).populate('achievements.questId');
    if (!user) return res.status(404).json({ success: false, message: 'Không tìm thấy người dùng.' });
    const achievements = await Quest.find({ type: 'ACHIEVEMENT', isActive: true });
    const result = achievements.map(achievement => {
      const unlocked = user.achievements.find(item =>
        item.questId && item.questId._id.toString() === achievement._id.toString());
      const progress = user.achievementProgress.find(item =>
        item.questId && item.questId.toString() === achievement._id.toString());
      return {
        ...achievement.toObject(),
        progress: progress?.progress || 0,
        target: Math.max(1, Number(achievement.condition?.targetValue) || 1),
        isUnlocked: Boolean(unlocked),
        unlockedAt: unlocked?.unlockedAt || null
      };
    });
    return res.status(200).json({ success: true, data: result });
  } catch (error) {
    next(error);
  }
};
