const mongoose = require('mongoose');

const meterReadingSchema = new mongoose.Schema({
    userId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true,
        index: true
    },
    meterId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Meter',
        required: true,
        index: true
    },
    meterType: {
        type: String,
        enum: ['POWER', 'WATER'],
        required: true
    },
    previousReadingId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'MeterReading',
        default: null
    },
    readingDate: { type: Date, required: true },
    previousValue: { type: Number, default: null, min: 0 },
    currentValue: { type: Number, required: true, min: 0 },
    usage: { type: Number, required: true, min: 0 },
    unit: { type: String, enum: ['KWH', 'M3'], required: true },
    unitPrice: { type: Number, required: true, min: 0 },
    estimatedCost: { type: Number, required: true, min: 0 },
    isFirstReading: { type: Boolean, default: false },
    inputSource: { type: String, enum: ['OCR', 'MANUAL'], required: true },
    ocrText: { type: String, trim: true, maxlength: 2000, default: '' },
    ocrValue: { type: Number, min: 0, default: null },
    ocrWarnings: [{ type: String, trim: true, maxlength: 250 }],
    aiLatencyMs: { type: Number, min: 0, default: null },
    aiIsValueEdited: { type: Boolean, default: null },
    aiFallbackUsed: { type: Boolean, default: null },
    hasImage: { type: Boolean, default: false },
    imageMimeType: {
        type: String,
        enum: ['image/jpeg', 'image/png', 'image/webp'],
        default: null
    },
    meterImage: { type: String, select: false, default: null },
    paidAmount: { type: Number, min: 0, default: null },
    differenceAmount: { type: Number, default: null },
    differencePercent: { type: Number, min: 0, default: null },
    hasLargeDifference: { type: Boolean, default: false },
    paidAt: { type: Date, default: null },
    transactionDate: { type: Date, default: null },
    transactionId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Transaction',
        default: null
    },
    idempotencyKey: { type: String, required: true, trim: true, maxlength: 120 },
    paymentIdempotencyKey: { type: String, trim: true, maxlength: 120, default: null }
}, { timestamps: true });

meterReadingSchema.index({ userId: 1, meterType: 1, readingDate: -1 });
meterReadingSchema.index({ userId: 1, meterId: 1, idempotencyKey: 1 }, { unique: true });
meterReadingSchema.index(
    { meterId: 1, previousReadingId: 1 },
    { unique: true, partialFilterExpression: { previousReadingId: { $type: 'objectId' } } }
);
meterReadingSchema.index(
    { meterId: 1, isFirstReading: 1 },
    { unique: true, partialFilterExpression: { isFirstReading: true } }
);
meterReadingSchema.index(
    { userId: 1, paymentIdempotencyKey: 1 },
    { unique: true, partialFilterExpression: { paymentIdempotencyKey: { $type: 'string' } } }
);

module.exports = mongoose.model('MeterReading', meterReadingSchema);
