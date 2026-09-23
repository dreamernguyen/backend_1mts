const finance = require('../services/finance.service');
const crypto = require('crypto');
const mongoose = require('mongoose');
const moment = require('moment-timezone');
const Meter = require('../models/meter.model');
const MeterReading = require('../models/meterReading.model');
const Transaction = require('../models/transaction.model');
const rpgService = require('../services/rpg.service');
const questService = require('../services/quest.service');
const geminiService = require('../services/gemini.service');
const { asyncHandler } = require('../middleware/errorHandler.middleware');
const {
    meterUnit,
    parseMeterType,
    parseNonNegativeNumber,
    parseDateNotFuture,
    calculateReading,
    comparePayment,
    allocatePayment,
    validateMeterImage
} = require('../services/meter.service');
const aiMetricsService = require('../services/aiMetrics.service');

const PAYMENT_METHODS = new Set(['CASH', 'MOMO', 'VNPAY', 'BANK_TRANSFER', 'CREDIT_CARD']);

const findLatestReading = (userId, meterId, session = null) => {
    const query = MeterReading.findOne({ userId, meterId }).sort({ readingDate: -1, createdAt: -1 });
    return session ? query.session(session) : query;
};

const readingMonthRange = readingDate => {
    const localDate = moment.tz(readingDate, 'Asia/Ho_Chi_Minh');
    return {
        startDate: localDate.clone().startOf('month').toDate(),
        endDate: localDate.clone().endOf('month').toDate()
    };
};

const serializeReading = reading => {
    const data = reading.toObject ? reading.toObject() : { ...reading };
    delete data.meterImage;
    return data;
};

const getIdempotencyKey = req => {
    const key = String(req.get('Idempotency-Key') || req.body?.idempotencyKey || '').trim();
    if (!key || key.length > 120) {
        const error = new Error('Idempotency-Key là bắt buộc và không được dài quá 120 ký tự.');
        error.statusCode = 400;
        throw error;
    }
    return key;
};

const getMeterOrThrow = async (userId, meterType, session = null) => {
    const query = Meter.findOne({ userId, meterType });
    const meter = await (session ? query.session(session) : query);
    if (!meter) {
        const error = new Error(`Bạn chưa thiết lập giá cho công tơ ${meterType === 'POWER' ? 'điện' : 'nước'}.`);
        error.statusCode = 404;
        error.appCode = 'METER_NOT_CONFIGURED';
        throw error;
    }
    return meter;
};

const parseMeterAiResponse = text => {
    try {
        const normalized = String(text || '')
            .replace(/```json/gi, '')
            .replace(/```/g, '')
            .trim();
        const value = JSON.parse(normalized)?.reading;
        if (value === null || value === undefined || value === '') return null;
        const number = typeof value === 'number' ? value : Number(value);
        return Number.isFinite(number) && number >= 0 ? number : null;
    } catch (_) {
        return null;
    }
};

// Export nhỏ để kiểm thử parser response AI không cần gọi Gemini hay MongoDB.
exports.parseMeterAiResponse = parseMeterAiResponse;

exports.recognizeReading = asyncHandler(async (req, res) => {
    const meterType = parseMeterType(req.body?.meterType);
    const mimeType = String(req.body?.mimeType || 'image/jpeg').toLowerCase();
    const imageBase64 = String(req.body?.imageBase64 || '')
        .replace(/^data:image\/(?:jpeg|jpg|png);base64,/i, '')
        .replace(/\s/g, '');
    if (!['image/jpeg', 'image/jpg', 'image/png'].includes(mimeType) || !imageBase64) {
        return res.status(400).json({ success: false, message: 'Ảnh công tơ không hợp lệ.' });
    }
    const imageBytes = Buffer.from(imageBase64, 'base64');
    if (!imageBytes.length || imageBytes.length > 4 * 1024 * 1024) {
        return res.status(413).json({ success: false, message: 'Ảnh công tơ phải nhỏ hơn hoặc bằng 4 MB.' });
    }

    const unit = meterType === 'POWER' ? 'kWh' : 'm³ hoặc m3';
    const { text, metadata } = await geminiService.generateStructuredReceipt({
        requestId: req.get('X-Request-Id') || 'meter-ocr',
        inputMode: 'meter_image',
        systemInstruction: 'Bạn là bộ đọc chỉ số công tơ. Chỉ trích xuất số nhìn thấy, không suy đoán.',
        promptParts: [
            {
                text: `Đọc chỉ số công tơ ${meterType === 'POWER' ? 'điện' : 'nước'} trong ảnh. Đơn vị mong đợi: ${unit}. Bỏ qua serial, điện áp, vòng/kWh, mã thiết bị và năm. Trả về đúng JSON {"reading": number|null}. Nếu không chắc chắn, trả {"reading": null}.`
            },
            { inlineData: { mimeType, data: imageBase64 } }
        ]
    });
    const value = parseMeterAiResponse(text);
    // Ghi chỉ số AI công tơ — fire-and-forget
    aiMetricsService.logMeterAiResponse({
        userId: req.user?.userId,
        sessionId: req.get('X-Request-Id') || `meter-ocr-${Date.now()}`,
        latencyMs: metadata?.durationMs ?? null,
        aiModel: metadata?.model ?? null,
        aiReadingValue: value
    });
    return res.status(200).json({
        success: true,
        data: { value, source: 'GEMINI_AI', metadata }
    });
});

exports.getMeters = asyncHandler(async (req, res) => {
    const meters = await Meter.find({ userId: req.user.userId }).sort({ meterType: 1 });
    const data = await Promise.all(meters.map(async meter => {
        const latest = await findLatestReading(req.user.userId, meter._id);
        return { ...meter.toObject(), latestReading: latest ? serializeReading(latest) : null };
    }));
    return res.status(200).json({ success: true, data });
});

exports.getMeter = asyncHandler(async (req, res) => {
    const meterType = parseMeterType(req.params.type);
    const meter = await getMeterOrThrow(req.user.userId, meterType);
    const latest = await findLatestReading(req.user.userId, meter._id);
    return res.status(200).json({
        success: true,
        data: { ...meter.toObject(), latestReading: latest ? serializeReading(latest) : null }
    });
});

exports.saveMeter = asyncHandler(async (req, res) => {
    const meterType = parseMeterType(req.params.type);
    const unitPrice = parseNonNegativeNumber(req.body.unitPrice, 'Đơn giá');
    const name = String(req.body.name || (meterType === 'POWER' ? 'Công tơ điện' : 'Công tơ nước')).trim();
    if (!name || name.length > 80) {
        return res.status(400).json({ success: false, message: 'Tên công tơ phải có từ 1 đến 80 ký tự.' });
    }
    const meter = await Meter.findOneAndUpdate(
        { userId: req.user.userId, meterType },
        { $set: { name, unit: meterUnit(meterType), unitPrice } },
        { new: true, upsert: true, runValidators: true, setDefaultsOnInsert: true }
    );
    const latest = await findLatestReading(req.user.userId, meter._id);
    return res.status(200).json({
        success: true,
        message: 'Đã lưu giá công tơ.',
        data: { ...meter.toObject(), latestReading: latest ? serializeReading(latest) : null }
    });
});

exports.previewReading = asyncHandler(async (req, res) => {
    const meterType = parseMeterType(req.body.meterType);
    const readingDate = parseDateNotFuture(req.body.readingDate);
    const meter = await getMeterOrThrow(req.user.userId, meterType);
    const { startDate, endDate } = readingMonthRange(readingDate);
    const [sameMonth, previous, next] = await Promise.all([
        MeterReading.findOne({ userId: req.user.userId, meterId: meter._id, readingDate: { $gte: startDate, $lte: endDate } }),
        MeterReading.findOne({ userId: req.user.userId, meterId: meter._id, readingDate: { $lt: startDate } }).sort({ readingDate: -1 }),
        MeterReading.findOne({ userId: req.user.userId, meterId: meter._id, readingDate: { $gt: endDate } }).sort({ readingDate: 1 })
    ]);
    if (sameMonth?.transactionId) {
        return res.status(422).json({
            success: false,
            code: 'METER_MONTH_ALREADY_PAID',
            message: 'Tháng này đã thanh toán nên không thể ghi đè chỉ số.'
        });
    }
    const result = calculateReading({
        previousValue: previous?.currentValue ?? null,
        currentValue: req.body.currentValue,
        unitPrice: meter.unitPrice
    });
    if (next && result.currentValue > next.currentValue) {
        return res.status(422).json({
            success: false,
            code: 'READING_GREATER_THAN_NEXT',
            message: 'Chỉ số tháng này không được lớn hơn chỉ số của tháng kế tiếp.'
        });
    }
    return res.status(200).json({
        success: true,
        data: {
            ...result,
            meterType,
            meterId: meter._id,
            unit: meter.unit,
            unitPrice: meter.unitPrice,
            readingDate,
            readingId: sameMonth?._id ?? null,
            willUpdate: Boolean(sameMonth)
        }
    });
});

exports.createReading = asyncHandler(async (req, res) => {
    const userId = req.user.userId;
    const meterType = parseMeterType(req.body.meterType);
    const readingDate = parseDateNotFuture(req.body.readingDate);
    const idempotencyKey = getIdempotencyKey(req);
    const existing = await MeterReading.findOne({ userId, meterType, idempotencyKey });
    if (existing) {
        return res.status(200).json({ success: true, replayed: true, data: serializeReading(existing) });
    }

    const image = validateMeterImage(req.body.meterImage);
    const inputSource = String(req.body.inputSource || '').toUpperCase();
    if (!['OCR', 'MANUAL'].includes(inputSource)) {
        return res.status(400).json({ success: false, message: 'Nguồn chỉ số chỉ nhận OCR hoặc MANUAL.' });
    }
    const ocrText = String(req.body.ocrText || '').trim();
    const ocrValue = req.body.ocrValue === null || req.body.ocrValue === undefined
        ? null
        : parseNonNegativeNumber(req.body.ocrValue, 'Chỉ số OCR');
    const ocrWarnings = Array.isArray(req.body.ocrWarnings)
        ? req.body.ocrWarnings.slice(0, 10).map(value => String(value).slice(0, 250))
        : [];
    const aiLatencyMs = typeof req.body.aiLatencyMs === 'number' && req.body.aiLatencyMs >= 0 
        ? Math.round(req.body.aiLatencyMs) 
        : null;
    const aiIsValueEdited = req.body.aiIsValueEdited === true || req.body.aiIsValueEdited === false 
        ? req.body.aiIsValueEdited 
        : null;
    const aiFallbackUsed = req.body.aiFallbackUsed === true || req.body.aiFallbackUsed === false 
        ? req.body.aiFallbackUsed 
        : null;

    const session = await mongoose.startSession();
    let reading;
    let updatedExisting = false;
    try {
        session.startTransaction();
        const meter = await getMeterOrThrow(userId, meterType, session);
        const { startDate, endDate } = readingMonthRange(readingDate);
        const sameMonthReadings = await MeterReading.find({
            userId,
            meterId: meter._id,
            readingDate: { $gte: startDate, $lte: endDate }
        }).sort({ readingDate: -1, createdAt: -1 }).session(session);
        const previous = await MeterReading.findOne({
            userId,
            meterId: meter._id,
            readingDate: { $lt: startDate }
        }).sort({ readingDate: -1, createdAt: -1 }).session(session);
        const next = await MeterReading.findOne({
            userId,
            meterId: meter._id,
            readingDate: { $gt: endDate }
        }).sort({ readingDate: 1, createdAt: 1 }).session(session);

        if (sameMonthReadings.some(item => item.transactionId)) {
            const error = new Error('Tháng này đã thanh toán nên không thể ghi đè chỉ số.');
            error.statusCode = 422;
            error.appCode = 'METER_MONTH_ALREADY_PAID';
            throw error;
        }
        const result = calculateReading({
            previousValue: previous?.currentValue ?? null,
            currentValue: req.body.currentValue,
            unitPrice: meter.unitPrice
        });
        if (next && result.currentValue > next.currentValue) {
            const error = new Error('Chỉ số tháng này không được lớn hơn chỉ số của tháng kế tiếp.');
            error.statusCode = 422;
            error.appCode = 'READING_GREATER_THAN_NEXT';
            throw error;
        }
        if (next?.transactionId) {
            const error = new Error('Không thể sửa tháng này vì tháng kế tiếp đã thanh toán.');
            error.statusCode = 422;
            error.appCode = 'NEXT_METER_MONTH_ALREADY_PAID';
            throw error;
        }

        if (sameMonthReadings.length === 0 && next) {
            const nextResult = calculateReading({
                previousValue: result.currentValue,
                currentValue: next.currentValue,
                unitPrice: next.unitPrice
            });
            Object.assign(next, nextResult, { previousReadingId: null });
            await next.save({ session });
        }

        reading = sameMonthReadings[0] || null;
        if (reading) {
            updatedExisting = true;
            const duplicateIds = sameMonthReadings.slice(1).map(item => item._id);
            if (duplicateIds.length > 0) {
                await MeterReading.deleteMany({ _id: { $in: duplicateIds }, userId }, { session });
            }
            Object.assign(reading, {
                previousReadingId: previous?._id ?? null,
                readingDate,
                ...result,
                unit: meter.unit,
                unitPrice: meter.unitPrice,
                inputSource,
                ocrText,
                ocrWarnings,
                aiLatencyMs,
                aiIsValueEdited,
                aiFallbackUsed,
                ...image,
                idempotencyKey
            });
            await reading.save({ session });
        } else {
            [reading] = await MeterReading.create([{
                userId,
                meterId: meter._id,
                meterType,
                previousReadingId: previous?._id ?? null,
                readingDate,
                ...result,
                unit: meter.unit,
                unitPrice: meter.unitPrice,
                inputSource,
                ocrText,
                ocrWarnings,
                aiLatencyMs,
                aiIsValueEdited,
                aiFallbackUsed,
                ...image,
                idempotencyKey
            }], { session });
        }

        if (next) {
            const nextResult = calculateReading({
                previousValue: reading.currentValue,
                currentValue: next.currentValue,
                unitPrice: next.unitPrice
            });
            Object.assign(next, nextResult, {
                previousReadingId: reading._id
            });
            await next.save({ session });
        }
        await session.commitTransaction();

        // Ghi USER_CONFIRMED công tơ — fire-and-forget, sau khi commit an toàn
        // Chỉ ghi khi nguồn là OCR (có AI trước đó), MANUAL không cần đo AI
        if (inputSource === 'OCR') {
            aiMetricsService.logMeterUserConfirmed({
                userId,
                sessionId: req.get('X-Request-Id') || idempotencyKey,
                aiReadingValue: ocrValue,
                userReadingValue: reading.currentValue ?? null,
                wasEdited: aiIsValueEdited,
                inputSource
            });
        }
    } catch (error) {
        if (session.inTransaction()) await session.abortTransaction();
        if (error.code === 11000) {
            const replay = await MeterReading.findOne({ userId, meterType, idempotencyKey });
            if (replay) {
                return res.status(200).json({ success: true, replayed: true, data: serializeReading(replay) });
            }
            error.statusCode = 409;
            error.message = 'Đã có một lần ghi khác sử dụng cùng mốc chỉ số. Vui lòng tải lại lịch sử.';
        }
        throw error;
    } finally {
        await session.endSession();
    }
    return res.status(updatedExisting ? 200 : 201).json({
        success: true,
        replayed: false,
        updatedExisting,
        message: updatedExisting ? 'Đã cập nhật chỉ số công tơ của tháng.' : 'Đã lưu chỉ số công tơ.',
        data: serializeReading(reading)
    });
});

exports.getReadings = asyncHandler(async (req, res) => {
    const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
    const limit = Math.min(50, Math.max(1, Number.parseInt(req.query.limit, 10) || 20));
    const filter = { userId: req.user.userId };
    if (req.query.type) filter.meterType = parseMeterType(req.query.type);
    const [data, total] = await Promise.all([
        MeterReading.find(filter).sort({ readingDate: -1, createdAt: -1 }).skip((page - 1) * limit).limit(limit),
        MeterReading.countDocuments(filter)
    ]);
    return res.status(200).json({
        success: true,
        data: data.map(serializeReading),
        page,
        hasMore: page * limit < total,
        total
    });
});

exports.getReading = asyncHandler(async (req, res) => {
    const reading = await MeterReading.findOne({ _id: req.params.id, userId: req.user.userId });
    if (!reading) return res.status(404).json({ success: false, message: 'Không tìm thấy lần ghi công tơ.' });
    return res.status(200).json({ success: true, data: serializeReading(reading) });
});

exports.getReadingImage = asyncHandler(async (req, res) => {
    const reading = await MeterReading.findOne({ _id: req.params.id, userId: req.user.userId }).select('+meterImage');
    if (!reading) return res.status(404).json({ success: false, message: 'Không tìm thấy lần ghi công tơ.' });
    if (!reading.meterImage) return res.status(404).json({ success: false, message: 'Lần ghi này không có ảnh công tơ.' });
    return res.status(200).json({ success: true, data: { meterImage: reading.meterImage, imageMimeType: reading.imageMimeType } });
});

exports.payMonth = asyncHandler(async (req, res) => {
    const userId = req.user.userId;
    const meterType = parseMeterType(req.body.meterType);
    const month = String(req.body.month || '').trim();
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
        return res.status(400).json({ success: false, message: 'Tháng thanh toán phải có dạng YYYY-MM.' });
    }
    const idempotencyKey = getIdempotencyKey(req);
    const paymentMethod = String(req.body.paymentMethod || 'CASH').toUpperCase();
    if (!PAYMENT_METHODS.has(paymentMethod)) {
        return res.status(400).json({ success: false, message: 'Phương thức thanh toán không hợp lệ.' });
    }
    const transactionDate = parseDateNotFuture(req.body.transactionDate, 'Ngày giao dịch');
    const startDate = moment.tz(`${month}-01`, 'YYYY-MM-DD', 'Asia/Ho_Chi_Minh').startOf('month').toDate();
    const endDate = moment.tz(startDate, 'Asia/Ho_Chi_Minh').endOf('month').toDate();
    const session = await mongoose.startSession();
    let transaction;
    let readings = [];
    let replayed = false;
    let paymentSummary;
    try {
        session.startTransaction();
        const financeUser = await finance.lockUser(userId, session);
        const replayReading = await MeterReading.findOne({ userId, paymentIdempotencyKey: idempotencyKey }).session(session);
        if (replayReading?.transactionId) {
            replayed = true;
            transaction = await Transaction.findById(replayReading.transactionId).session(session);
            readings = await MeterReading.find({ userId, transactionId: replayReading.transactionId }).session(session);
            paymentSummary = comparePayment(
                readings.reduce((sum, item) => sum + item.estimatedCost, 0),
                transaction?.amount || 0
            );
            await session.abortTransaction();
        } else {
            readings = await MeterReading.find({
                userId,
                meterType,
                readingDate: { $gte: startDate, $lte: endDate },
                isFirstReading: false,
                transactionId: null
            }).sort({ readingDate: 1, createdAt: 1 }).session(session);
            if (readings.length === 0) {
                const error = new Error('Tháng này không có khoản điện nước nào đang chờ thanh toán.');
                error.statusCode = 409;
                throw error;
            }
            const estimatedTotal = readings.reduce((sum, item) => sum + item.estimatedCost, 0);
            paymentSummary = comparePayment(estimatedTotal, req.body.paidAmount);
            const txIdempotencyKey = `meter_${crypto.createHash('sha256').update(`${userId}:${idempotencyKey}`).digest('hex')}`;
            const utilityLabel = meterType === 'POWER' ? 'điện' : 'nước';
            const utilityNote = `Thanh toán tiền ${utilityLabel} tháng ${month}`;
            const balanceFields = await finance.transactionFields(financeUser, {
                transactionType: 'EXPENSE', amount: paymentSummary.paidAmount, date: transactionDate,
                category: 'HOUSING', note: utilityNote, merchantName: `Tiền ${utilityLabel}`,
                fixedPayment: req.body.fixedPayment
            }, session);
            [transaction] = await Transaction.create([{
                ...balanceFields,
                userId,
                transactionType: 'EXPENSE',
                amount: paymentSummary.paidAmount,
                discount: 0,
                note: utilityNote,
                date: transactionDate,
                category: 'HOUSING',
                paymentMethod,
                merchantName: `Tiền ${utilityLabel}`,
                idempotencyKey: txIdempotencyKey,
                items: []
            }], { session });

            const paymentShares = allocatePayment(
                readings.map(item => item.estimatedCost),
                paymentSummary.paidAmount
            );
            for (let index = 0; index < readings.length; index += 1) {
                const reading = readings[index];
                const share = paymentShares[index];
                const itemComparison = comparePayment(reading.estimatedCost, share);
                Object.assign(reading, itemComparison, {
                    hasLargeDifference: paymentSummary.hasLargeDifference,
                    paidAt: new Date(),
                    transactionDate,
                    transactionId: transaction._id,
                    paymentIdempotencyKey: index === 0 ? idempotencyKey : null
                });
                await reading.save({ session });
            }
            await session.commitTransaction();
        }
    } catch (error) {
        if (session.inTransaction()) await session.abortTransaction();
        throw error;
    } finally {
        await session.endSession();
    }

    if (!replayed) {
        try {
            await rpgService.calculateUserStats(userId);
            await questService.triggerDailyQuest(userId, 'CREATE_TRANSACTION', 1);
        } catch (error) {
            console.error('[Meter] Không thể cập nhật chỉ số sau thanh toán tháng:', error.message);
        }
    }
    return res.status(replayed ? 200 : 201).json({
        success: true,
        replayed,
        message: replayed ? 'Giao dịch tháng này đã được tạo trước đó.' : 'Đã tạo giao dịch thanh toán theo tháng.',
        data: {
            month,
            readingIds: readings.map(item => item._id),
            estimatedCost: readings.reduce((sum, item) => sum + item.estimatedCost, 0),
            ...paymentSummary,
            transaction
        }
    });
});

exports.getStatistics = asyncHandler(async (req, res) => {
    const meterType = parseMeterType(req.query.type);
    const match = { userId: new mongoose.Types.ObjectId(req.user.userId), meterType, isFirstReading: false };
    const data = await MeterReading.aggregate([
        { $match: match },
        { $group: {
            _id: { $dateToString: { format: '%Y-%m', date: '$readingDate', timezone: 'Asia/Ho_Chi_Minh' } },
            usage: { $sum: '$usage' },
            estimatedCost: { $sum: '$estimatedCost' },
            paidAmount: { $sum: { $ifNull: ['$paidAmount', 0] } },
            readingCount: { $sum: 1 }
        } },
        { $sort: { _id: -1 } },
        { $limit: 24 },
        { $sort: { _id: 1 } },
        { $project: { _id: 0, month: '$_id', usage: 1, estimatedCost: 1, paidAmount: 1, readingCount: 1 } }
    ]);
    return res.status(200).json({ success: true, data });
});

exports.resetReadings = asyncHandler(async (req, res) => {
    const userId = req.user.userId;
    const meterType = parseMeterType(req.params.type);
    const newStartValue = parseNonNegativeNumber(req.body.newStartValue, 'Chỉ số mốc mới');
    const meter = await getMeterOrThrow(userId, meterType);
    const session = await mongoose.startSession();
    let reading;
    try {
        await session.withTransaction(async () => {
            await MeterReading.deleteMany({ userId, meterType }, { session });
            const result = calculateReading({
                previousValue: null,
                currentValue: newStartValue,
                unitPrice: meter.unitPrice
            });
            [reading] = await MeterReading.create([{
                userId,
                meterId: meter._id,
                meterType,
                previousReadingId: null,
                readingDate: new Date(),
                ...result,
                unit: meter.unit,
                unitPrice: meter.unitPrice,
                inputSource: 'MANUAL',
                idempotencyKey: `reset_${crypto.randomUUID()}`
            }], { session });
        });
    } finally {
        await session.endSession();
    }
    return res.status(200).json({
        success: true,
        message: 'Đã reset lịch sử và tạo mốc công tơ mới.',
        data: serializeReading(reading)
    });
});

exports.deleteReading = asyncHandler(async (req, res) => {
    const userId = req.user.userId;
    const session = await mongoose.startSession();
    try {
        await session.withTransaction(async () => {
            const reading = await MeterReading.findOne({ _id: req.params.id, userId }).session(session);
            if (!reading) {
                const error = new Error('Không tìm thấy lần ghi công tơ.');
                error.statusCode = 404;
                throw error;
            }
            if (reading.transactionId) {
                const error = new Error('Không thể xóa tháng đã thanh toán. Hãy xóa giao dịch trước.');
                error.statusCode = 422;
                throw error;
            }
            const [previous, next] = await Promise.all([
                MeterReading.findOne({
                    userId,
                    meterId: reading.meterId,
                    readingDate: { $lt: reading.readingDate }
                }).sort({ readingDate: -1, createdAt: -1 }).session(session),
                MeterReading.findOne({
                    userId,
                    meterId: reading.meterId,
                    readingDate: { $gt: reading.readingDate }
                }).sort({ readingDate: 1, createdAt: 1 }).session(session)
            ]);
            if (next?.transactionId) {
                const error = new Error('Không thể xóa vì tháng kế tiếp đã thanh toán. Hãy xóa giao dịch đó trước.');
                error.statusCode = 422;
                throw error;
            }
            await MeterReading.deleteOne({ _id: reading._id, userId }, { session });
            if (next) {
                const result = calculateReading({
                    previousValue: previous?.currentValue ?? null,
                    currentValue: next.currentValue,
                    unitPrice: next.unitPrice
                });
                Object.assign(next, result, { previousReadingId: previous?._id ?? null });
                await next.save({ session });
            }
        });
    } finally {
        await session.endSession();
    }
    return res.status(200).json({ success: true, message: 'Đã xóa lần ghi và tính lại tháng kế tiếp.' });
});
