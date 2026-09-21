const mongoose = require('mongoose');

const dailyQuestItemSchema = new mongoose.Schema({
  questId: { type: mongoose.Schema.Types.ObjectId, ref: 'Quest', required: true },
  progress: { type: Number, default: 0 },
  target: { type: Number, required: true },
  isCompleted: { type: Boolean, default: false },
  isClaimed: { type: Boolean, default: false },
  completedAt: { type: Date }
}, { _id: false });

const userDailyQuestSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  dateString: { type: String, required: true }, 
  quests: [dailyQuestItemSchema],
  isPerfectDayClaimed: { type: Boolean, default: false }
}, { timestamps: true });

userDailyQuestSchema.index({ userId: 1, dateString: 1 }, { unique: true });

module.exports = mongoose.model('UserDailyQuest', userDailyQuestSchema);
