const mongoose = require('mongoose');

const rpgLogSchema = new mongoose.Schema(
    {
        userId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User',
            required: true
        },
        type: {
            type: String,
            enum: ['QUEST', 'TRANSACTION', 'EXPIRY', 'OTHER'],
            default: 'OTHER'
        },
        title: {
            type: String,
            required: true
        },
        xpChange: { type: Number, default: 0 },
        hpChange: { type: Number, default: 0 },
        manaChange: { type: Number, default: 0 },
        defChange: { type: Number, default: 0 },
        wisChange: { type: Number, default: 0 },
        metadata: {
            type: mongoose.Schema.Types.Mixed
        }
    },
    {
        timestamps: true
    }
);

// Tạo index để query theo user nhanh hơn và sort theo thời gian
rpgLogSchema.index({ userId: 1, createdAt: -1 });

const RpgLog = mongoose.model('RpgLog', rpgLogSchema);
module.exports = RpgLog;
