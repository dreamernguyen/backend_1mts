const mongoose = require('mongoose');

const meterSchema = new mongoose.Schema({
    userId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true,
        index: true
    },
    meterType: {
        type: String,
        enum: ['POWER', 'WATER'],
        required: true
    },
    name: {
        type: String,
        trim: true,
        maxlength: 80,
        default: ''
    },
    unit: {
        type: String,
        enum: ['KWH', 'M3'],
        required: true
    },
    unitPrice: {
        type: Number,
        required: true,
        min: 0
    }
}, { timestamps: true });

meterSchema.index({ userId: 1, meterType: 1 }, { unique: true });

module.exports = mongoose.model('Meter', meterSchema);
