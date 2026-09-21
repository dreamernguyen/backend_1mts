const mongoose = require('mongoose');
const Item = require('../models/item.model');
const Transaction = require('../models/transaction.model');
const Notification = require('../models/notification.model');
const RpgLog = require('../models/rpgLog.model');
const { asyncHandler } = require('../middleware/errorHandler.middleware');
const {
    calculateBaseUnitPrice,
    hasBlockingWarnings,
    isValidCategorySubCategory,
    normalizeIngredientIdentity,
    normalizeReceiptItem,
    resolveStorageLocation,
    resolveExpiry
} = require('../services/receipt-normalizer.service');

function escapeRegExp(value) {
    return String(value ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function exactNameRegex(value) {
    return new RegExp(`^${escapeRegExp(value)}$`, 'i');
}

// Thêm vật phẩm mới vào kho
exports.addItem = asyncHandler(async (req, res) => {
    // lấy data từ client
    const {
        userId, transactionId, 
        rawName, itemName, brand, category, subCategory,
        quantity, originalQuantity, unit, standardQuantity, standardUnit,
        isSingleUse, purchasePrice, expiryDate,
        storageLocation, expirySource, expiryRuleCode
    } = req.body;

    // check quyền sở hữu
    if (req.user.userId.toString() !== userId?.toString()) {
        return res.status(403).json({
            success: false,
            message: 'Bạn không thể thêm đồ cho tài khoản khác!'
        });
    }

    if (!isValidCategorySubCategory(category, subCategory)) {
        return res.status(400).json({
            success: false,
            code: 'INVALID_CATEGORY_PAIR',
            message: 'Danh mục phụ không thuộc danh mục đã chọn.'
        });
    }

    const normalized = normalizeReceiptItem({
        rawName, itemName, brand, category, subCategory,
        quantity, originalQuantity, unit, standardQuantity, standardUnit,
        isSingleUse, purchasePrice, expiryDate,
        storageLocation, expirySource, expiryRuleCode
    }, { purchaseDate: new Date() });

    if (hasBlockingWarnings({ warnings: normalized.warnings })) {
        return res.status(422).json({
            success: false,
            message: 'Vật phẩm còn dữ liệu bắt buộc chưa hợp lệ. Vui lòng kiểm tra lại.',
            warnings: normalized.warnings
        });
    }

    const newItem = await Item.create({
        userId, transactionId,
        ...normalized,
        baseUnitPrice: calculateBaseUnitPrice(normalized),
        usageStatus: 'ACTIVE'
    });

    console.log(`[API] ${req.method} ${req.originalUrl} - Add item success (User: ${userId}, Item: ${newItem._id})`);
    return res.status(201).json({ success: true, message: 'Thêm đồ thành công!', data: newItem });
});

// Lấy danh sách đồ (Gom nhóm + lọc theo fridge/pantry)
exports.getItems = asyncHandler(async (req, res) => {
    const { userId } = req.params;
    const { type } = req.query; // ?type=fridge | ?type=pantry | không truyền = tất cả

    const storageMatch = type === 'fridge'
        ? { $in: ['FRIDGE', 'FREEZER'] }
        : type === 'pantry' ? 'PANTRY' : { $in: ['FRIDGE', 'FREEZER', 'PANTRY'] };

    // Danh tính cấp kho là itemName chuẩn. Brand thuộc metadata của từng lô,
    // không được làm phát sinh một nhóm nguyên liệu mới.
    const data = await Item.aggregate([
        {
            $match: {
                userId: new mongoose.Types.ObjectId(userId),
                usageStatus: 'ACTIVE',
                quantity: { $gt: 0 }
            }
        },
        {
            $addFields: {
                resolvedStorageLocation: {
                    $ifNull: [
                        '$storageLocation',
                        {
                            $cond: [
                                { $in: ['$category', ['MEAT', 'SEAFOOD', 'VEGETABLE', 'FRUIT', 'EGG']] },
                                'FRIDGE',
                                { $cond: [{ $eq: ['$subCategory', 'MILK'] }, 'FRIDGE', 'PANTRY'] }
                            ]
                        }
                    ]
                },
                expirySortDate: { $ifNull: ['$expiryDate', new Date('9999-12-31T23:59:59.999Z')] }
            }
        },
        { $match: { resolvedStorageLocation: storageMatch } },
        { $sort: { expirySortDate: 1 } }, // FEFO; lô không theo dõi hạn nằm cuối
        {
            $group: {
                _id: {
                    itemName: { $toLower: '$itemName' },
                    standardUnit: { $toUpper: '$standardUnit' },
                    storageLocation: '$resolvedStorageLocation'
                },
                id: { $first: '$_id' },
                itemName: { $first: '$itemName' },
                brand: { $first: '$brand' },
                brands: { $addToSet: '$brand' },
                totalQuantity: { $sum: '$quantity' },
                totalStandardQuantity: { $sum: '$standardQuantity' },
                unit: { $first: '$unit' },
                standardUnit: { $first: '$standardUnit' },
                category: { $first: '$category' },
                subCategory: { $first: '$subCategory' },
                storageLocation: { $first: '$resolvedStorageLocation' },
                expirySource: { $first: '$expirySource' },
                expiryRuleCode: { $first: '$expiryRuleCode' },
                nearestExpiryDate: { $first: '$expiryDate' }, 
                batches: { $push: '$$ROOT' } // Đẩy tất cả lô vào mảng để hiển thị chi tiết khi cần
            }
        },
        { $sort: { nearestExpiryDate: 1 } } // Nhóm cận hạn nhất lên đầu danh sách
    ]);

    console.log(`[API] ${req.method} ${req.originalUrl} - Get items success (User: ${userId}, Total groups: ${data.length})`);
    return res.status(200).json({ success: true, count: data.length, data });
});

// Tìm kiếm item theo text search
exports.searchItems = asyncHandler(async (req, res) => {
    const { userId } = req.params;
    const { q } = req.query;

    if (!q?.trim()) {
        return res.status(400).json({ success: false, message: 'Từ khóa tìm kiếm không được để trống!' });
    }

    const results = await Item.find({
        userId: new mongoose.Types.ObjectId(userId), // ép kiểu để match aggregation
        usageStatus: 'ACTIVE',
        quantity: { $gt: 0 },
        $text: { $search: q.trim() }
    }).sort({ expiryDate: 1 });

    console.log(`[API] ${req.method} ${req.originalUrl} - Search items success (User: ${userId}, Found: ${results.length})`);
    return res.status(200).json({ success: true, count: results.length, data: results });
});

// Lấy đồ cận hạn / hết hạn để AI gợi ý món ăn
exports.getListExpiring = asyncHandler(async (req, res) => {
    const { userId } = req.params;
    const daysThreshold = 2; // Ngưỡng cảnh báo: ≤ 2 ngày còn lại

    // Tính mốc cuối ngày thứ 2 kể từ hôm nay
    const targetDate = new Date();
    targetDate.setDate(targetDate.getDate() + daysThreshold);
    targetDate.setHours(23, 59, 59, 999);

    const items = await Item.find({
        userId: new mongoose.Types.ObjectId(userId), 
        usageStatus: 'ACTIVE',
        category: { $in: ['MEAT', 'SEAFOOD', 'VEGETABLE', 'FRUIT', 'EGG', 'DRINK'] }, // Chỉ thực phẩm ăn được
        expiryDate: { $lte: targetDate } // Bao gồm cả đồ đã hết hạn (âm ngày)
    }).sort({ expiryDate: 1 });

    console.log(`[API] ${req.method} ${req.originalUrl} - Get expiring items success (User: ${userId}, Count: ${items.length})`);
    return res.status(200).json({ success: true, count: items.length, data: items });
});

// Endpoint cũ không có preflight/idempotency. Giữ phản hồi rõ ràng để client
// cũ không vô tình trừ kho bằng luồng kém an toàn hơn POST /api/recipes/cook.
exports.consumeRecipe = asyncHandler(async (_req, res) => res.status(410).json({
    success: false,
    code: 'LEGACY_COOK_ENDPOINT_DISABLED',
    message: 'Endpoint này đã ngừng dùng. Hãy nấu qua /api/recipes/cook.'
}));

// Trừ kho thủ công
exports.consumeManual = asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { consumeQuantity } = req.body;

    const item = await Item.findById(id);

    if (!item || item.usageStatus !== 'ACTIVE' || item.quantity <= 0) {
        return res.status(404).json({ success: false, message: 'Vật phẩm không tồn tại hoặc đã hết!' });
    }

    // check quyền sở hữu
    if (req.user.userId.toString() !== item.userId.toString()) {
        return res.status(403).json({
            success: false,
            message: 'Bạn không có quyền thao tác với vật phẩm này!'
        });
    }

    // quy đổi lượng cần trừ
    const unitRatio = item.standardQuantity / item.quantity;
    const standardConsume = consumeQuantity * unitRatio;

    // bọc $set/$inc tránh lỗi document replacement
    let updateFields;
    if (item.quantity <= consumeQuantity) {
        // trừ quá kho -> thành CONSUMED
        updateFields = { $set: { quantity: 0, standardQuantity: 0, usageStatus: 'CONSUMED' } };
    } else {
        // trừ 1 phần bằng $inc
        updateFields = { $inc: { quantity: -consumeQuantity, standardQuantity: -standardConsume } };
    }

    const updatedData = await Item.findByIdAndUpdate(id, updateFields, { new: true });

    console.log(`[API] ${req.method} ${req.originalUrl} - Consume manual success (Item: ${id})`);
    return res.status(200).json({
        success: true,
        message: 'Cập nhật định lượng thành công!',
        data: updatedData
    });
});

// Xóa cứng vật phẩm
exports.deleteItem = asyncHandler(async (req, res) => {
    const { id } = req.params;

    const item = await Item.findById(id);
    if (!item) {
        return res.status(404).json({ success: false, message: 'Không tìm thấy vật phẩm cần xóa!' });
    }

    // check quyền sở hữu
    if (req.user.userId.toString() !== item.userId.toString()) {
        return res.status(403).json({
            success: false,
            message: 'Bạn không có quyền xóa vật phẩm này!'
        });
    }

    await item.deleteOne();

    console.log(`[API] ${req.method} ${req.originalUrl} - Delete item success (Item: ${id})`);
    return res.status(200).json({ success: true, message: 'Đã xóa vật phẩm ra khỏi hệ thống!' });
});

// Chi tiết nhóm vật phẩm (gom theo rawName/itemName + expiryDate)
exports.getItemDetail = asyncHandler(async (req, res) => {
    const { userId } = req.params;
    const { itemName, standardUnit, storageLocation } = req.query;

    if (!itemName) {
        return res.status(400).json({ success: false, message: 'Thiếu tham số itemName!' });
    }

    // Chỉ trả lô còn dùng được để tổng nhóm không lẫn lịch sử tiêu thụ.
    const matchCondition = {
        userId: new mongoose.Types.ObjectId(userId),
        usageStatus: 'ACTIVE',
        quantity: { $gt: 0 },
        itemName: { $regex: exactNameRegex(itemName) },
    };
    if (standardUnit) matchCondition.standardUnit = String(standardUnit).toUpperCase();
    const requestedStorage = storageLocation ? String(storageLocation).toUpperCase() : null;

    // Giữ lô khác hạn hoặc khác nguồn để vẫn truy vết được khi chỉnh sửa.
    const data = await Item.aggregate([
        { $match: matchCondition },
        {
            $addFields: {
                resolvedStorageLocation: {
                    $ifNull: [
                        '$storageLocation',
                        {
                            $cond: [
                                { $in: ['$category', ['MEAT', 'SEAFOOD', 'VEGETABLE', 'FRUIT', 'EGG']] },
                                'FRIDGE',
                                { $cond: [{ $eq: ['$subCategory', 'MILK'] }, 'FRIDGE', 'PANTRY'] }
                            ]
                        }
                    ]
                }
            }
        },
        ...(requestedStorage ? [{ $match: { resolvedStorageLocation: requestedStorage } }] : []),
        { $sort: { expiryDate: 1, createdAt: 1 } }, // Hạn gần nhất trước, lô cũ nhất trước
        {
            $group: {
                _id: {
                    // Nếu rawName có giá trị -> gom theo rawName+expiryDate
                    // Nếu rỗng -> gom theo itemName+expiryDate
                    groupKey: {
                        $cond: {
                            if: { $and: [{ $ne: ['$rawName', ''] }, { $ne: ['$rawName', null] }] },
                            then: { $concat: [
                                { $toLower: '$rawName' }, '|',
                                { $toLower: { $ifNull: ['$brand', 'No name'] } }, '|',
                                { $ifNull: [{ $dateToString: { format: '%Y-%m-%d', date: '$expiryDate' } }, 'no-expiry'] }, '|',
                                { $ifNull: [{ $toString: '$transactionId' }, { $toString: '$_id' }] }
                            ] },
                            else: { $concat: [
                                { $toLower: '$itemName' }, '|',
                                { $toLower: { $ifNull: ['$brand', 'No name'] } }, '|',
                                { $ifNull: [{ $dateToString: { format: '%Y-%m-%d', date: '$expiryDate' } }, 'no-expiry'] }, '|',
                                { $ifNull: [{ $toString: '$transactionId' }, { $toString: '$_id' }] }
                            ] }
                        }
                    }
                },
                rawName: { $first: '$rawName' },
                itemName: { $first: '$itemName' },
                brand: { $first: '$brand' },
                expiryDate: { $first: '$expiryDate' },
                unit: { $first: '$unit' },
                standardUnit: { $first: '$standardUnit' },
                category: { $first: '$category' },
                storageLocation: { $first: '$resolvedStorageLocation' },
                expirySource: { $first: '$expirySource' },
                expiryRuleCode: { $first: '$expiryRuleCode' },
                isSingleUse: { $first: '$isSingleUse' },
                totalQuantity: { $sum: '$quantity' },
                totalStandardQuantity: { $sum: '$standardQuantity' },
                purchasePrice: { $first: '$purchasePrice' },
                baseUnitPrice: { $first: '$baseUnitPrice' },
                batchIds: { $push: '$_id' },
                batchCount: { $sum: 1 }
            }
        },
        { $sort: { expiryDate: 1 } } // Hạn gần nhất lên đầu
    ]);

    return res.status(200).json({ success: true, count: data.length, data });
});

// Cập nhật hàng loạt và trừ kho (Batch Update)
exports.batchUpdate = asyncHandler(async (req, res) => {
    const { userId } = req.params;
    const {
        groupMetadata,
        consumptions,
        batchExpiryUpdates = [],
        batchMetadataUpdates = []
    } = req.body;
    
    if (!groupMetadata || !Array.isArray(consumptions)
        || !Array.isArray(batchExpiryUpdates) || !Array.isArray(batchMetadataUpdates)) {
        return res.status(400).json({ success: false, message: 'Dữ liệu không hợp lệ!' });
    }

    const session = await mongoose.startSession();
    try {
        session.startTransaction();
        const bulkOps = [];
        const targetFilter = {
            userId: new mongoose.Types.ObjectId(userId),
            itemName: { $regex: exactNameRegex(groupMetadata.targetItemName) },
            usageStatus: 'ACTIVE'
        };
        const targetBatches = await Item.find(targetFilter).session(session);
        const currentItem = targetBatches[0];

        if (!currentItem) {
            const error = new Error('Không tìm thấy nhóm vật phẩm cần cập nhật.');
            error.statusCode = 404;
            throw error;
        }

        const nextCategory = groupMetadata.newCategory || currentItem.category;
        const nextSubCategory = groupMetadata.newSubCategory !== undefined
            ? groupMetadata.newSubCategory
            : currentItem.subCategory;

        if (groupMetadata.newCategory || groupMetadata.newSubCategory !== undefined) {
            if (!isValidCategorySubCategory(nextCategory, nextSubCategory)) {
                const error = new Error('Danh mục phụ không thuộc danh mục đã chọn.');
                error.statusCode = 400;
                error.appCode = 'INVALID_CATEGORY_PAIR';
                throw error;
            }
        }

        // Tên/danh mục là cấp nhóm; brand chỉ đổi ở các lô được chọn.
        if (groupMetadata.newBrand) {
            bulkOps.push({
                updateMany: {
                    filter: {
                        userId: new mongoose.Types.ObjectId(userId),
                        itemName: { $regex: exactNameRegex(groupMetadata.targetItemName) },
                        brand: { $regex: exactNameRegex(groupMetadata.targetBrand || 'No name') },
                        usageStatus: 'ACTIVE'
                    },
                    update: { $set: { brand: groupMetadata.newBrand } }
                }
            });
        }

        const groupUpdateFields = {};
        if (groupMetadata.newItemName) {
            const normalizedName = normalizeIngredientIdentity({
                itemName: groupMetadata.newItemName,
                category: nextCategory,
                subCategory: nextSubCategory
            });
            if (!normalizedName) {
                const error = new Error('Tên nhóm vật phẩm không hợp lệ.');
                error.statusCode = 400;
                error.appCode = 'INVALID_ITEM_NAME';
                throw error;
            }
            groupUpdateFields.itemName = normalizedName;
        }
        if (groupMetadata.newCategory) groupUpdateFields.category = groupMetadata.newCategory;
        if (groupMetadata.newSubCategory !== undefined) {
            groupUpdateFields.subCategory = groupMetadata.newSubCategory;
        }
        if (Object.keys(groupUpdateFields).length > 0) {
            bulkOps.push({
                updateMany: {
                    filter: {
                        userId: new mongoose.Types.ObjectId(userId),
                        itemName: { $regex: exactNameRegex(groupMetadata.targetItemName) },
                        usageStatus: 'ACTIVE'
                    },
                    update: { $set: groupUpdateFields }
                }
            });
        }

        // Category/subCategory đổi có thể làm rule hạn dùng thay đổi. Giữ nguyên
        // hạn USER, còn hạn ước lượng được tính lại trên đúng nơi chứa của từng lô.
        if (groupMetadata.newCategory || groupMetadata.newSubCategory !== undefined) {
            for (const batch of targetBatches) {
                if (batch.expirySource === 'USER') continue;
                const sourceTransaction = batch.transactionId
                    ? await Transaction.findOne({
                        _id: batch.transactionId,
                        userId: new mongoose.Types.ObjectId(userId)
                    }).select('date').session(session)
                    : null;
                const purchaseDate = sourceTransaction?.date || batch.createdAt || new Date();
                const location = resolveStorageLocation(
                    batch.toObject(),
                    nextCategory,
                    nextSubCategory
                );
                bulkOps.push({
                    updateOne: {
                        filter: { _id: batch._id, userId: new mongoose.Types.ObjectId(userId) },
                        update: {
                            $set: {
                                storageLocation: location,
                                ...resolveExpiry({}, { purchaseDate }, nextCategory, nextSubCategory, location)
                            }
                        }
                    }
                });
            }
        }

        // Metadata thuộc từng lô: brand và nơi chứa không phải danh tính nhóm.
        for (const metadataUpdate of batchMetadataUpdates) {
            if (!Array.isArray(metadataUpdate.batchIds) || metadataUpdate.batchIds.length === 0) continue;
            const requestedStorage = metadataUpdate.storageLocation == null
                ? null
                : String(metadataUpdate.storageLocation).toUpperCase();
            if (requestedStorage && !['FRIDGE', 'FREEZER', 'PANTRY'].includes(requestedStorage)) {
                const error = new Error('Nơi chứa của lô không hợp lệ.');
                error.statusCode = 400;
                error.appCode = 'INVALID_STORAGE_LOCATION';
                throw error;
            }
            const ownedBatches = targetBatches.filter(batch =>
                metadataUpdate.batchIds.map(String).includes(String(batch._id))
            );
            for (const batch of ownedBatches) {
                const fields = {};
                if (metadataUpdate.brand !== undefined) {
                    fields.brand = String(metadataUpdate.brand).trim() || 'No name';
                }
                if (requestedStorage) {
                    fields.storageLocation = requestedStorage;
                    if (batch.expirySource !== 'USER') {
                        const sourceTransaction = batch.transactionId
                            ? await Transaction.findOne({
                                _id: batch.transactionId,
                                userId: new mongoose.Types.ObjectId(userId)
                            }).select('date').session(session)
                            : null;
                        const purchaseDate = sourceTransaction?.date || batch.createdAt || new Date();
                        Object.assign(fields, resolveExpiry(
                            {},
                            { purchaseDate },
                            nextCategory,
                            nextSubCategory,
                            requestedStorage
                        ));
                    }
                }
                if (Object.keys(fields).length > 0) {
                    bulkOps.push({
                        updateOne: {
                            filter: {
                                _id: batch._id,
                                userId: new mongoose.Types.ObjectId(userId),
                                usageStatus: 'ACTIVE'
                            },
                            update: { $set: fields }
                        }
                    });
                }
            }
        }

        // Hạn dùng là dữ liệu từng lô, không được gộp theo nhóm.
        for (const expiryUpdate of batchExpiryUpdates) {
            if (!Array.isArray(expiryUpdate.batchIds) || expiryUpdate.batchIds.length === 0) continue;
            const mode = String(expiryUpdate.mode || '').toUpperCase();
            if (!['USER', 'AUTO'].includes(mode)) {
                const error = new Error('Chế độ cập nhật hạn dùng không hợp lệ.');
                error.statusCode = 400;
                throw error;
            }

            let userExpiryDate = null;
            if (mode === 'USER') {
                userExpiryDate = new Date(expiryUpdate.expiryDate);
                if (!expiryUpdate.expiryDate || Number.isNaN(userExpiryDate.getTime())) {
                    const error = new Error('Ngày hết hạn được chọn không hợp lệ.');
                    error.statusCode = 400;
                    throw error;
                }
                userExpiryDate.setHours(23, 59, 59, 999);
            }

            const ownedBatches = await Item.find({
                _id: { $in: expiryUpdate.batchIds },
                userId: new mongoose.Types.ObjectId(userId),
                usageStatus: 'ACTIVE'
            }).session(session);

            for (const batch of ownedBatches) {
                let expiryFields;
                if (mode === 'USER') {
                    expiryFields = { expiryDate: userExpiryDate, expirySource: 'USER', expiryRuleCode: null };
                } else {
                    const sourceTransaction = batch.transactionId
                        ? await Transaction.findOne({
                            _id: batch.transactionId,
                            userId: new mongoose.Types.ObjectId(userId)
                        }).select('date').session(session)
                        : null;
                    const purchaseDate = sourceTransaction?.date || batch.createdAt || new Date();
                    const requestedStorage = String(expiryUpdate.storageLocation || '').toUpperCase();
                    const storageLocation = ['FRIDGE', 'FREEZER', 'PANTRY'].includes(requestedStorage)
                        ? requestedStorage
                        : resolveStorageLocation(batch.toObject(), nextCategory, nextSubCategory);
                    expiryFields = {
                        storageLocation,
                        ...resolveExpiry({}, { purchaseDate }, nextCategory, nextSubCategory, storageLocation)
                    };
                }
                bulkOps.push({
                    updateOne: {
                        filter: {
                            _id: batch._id,
                            userId: new mongoose.Types.ObjectId(userId),
                            usageStatus: 'ACTIVE'
                        },
                        update: { $set: expiryFields }
                    }
                });
            }
        }

        // Luôn kiểm tra lại lượng trên backend trước khi giảm lô.
        let totalWastedValue = 0;
        let wastedItemName = currentItem.itemName;
        let hasWasted = false;

        for (const consume of consumptions) {
            if (!consume.batchIds || consume.batchIds.length === 0) continue;

            const requestedQty = Number(consume.consumeQuantity || 0);
            const requestedStdQty = Number(consume.consumeStandardQuantity || 0);
            if (!Number.isFinite(requestedQty) || !Number.isFinite(requestedStdQty)
                || requestedQty < 0 || requestedStdQty < 0
                || (requestedQty <= 0 && requestedStdQty <= 0)) {
                const error = new Error('Số lượng cần dùng không hợp lệ.');
                error.statusCode = 400;
                error.appCode = 'INVALID_CONSUMPTION';
                throw error;
            }
            
            // Sắp FEFO để lô gần hết hạn được dùng trước.
            const activeBatches = await Item.find({
                _id: { $in: consume.batchIds },
                userId: new mongoose.Types.ObjectId(userId),
                usageStatus: 'ACTIVE',
                quantity: { $gt: 0 }
            }).sort({ expiryDate: 1, createdAt: 1 }).session(session);

            if (activeBatches.length > 0) {
                const firstIsSingle = activeBatches[0].standardUnit === 'PIECE';
                if ((firstIsSingle && requestedQty <= 0) || (!firstIsSingle && requestedStdQty <= 0)) {
                    const error = new Error(firstIsSingle
                        ? 'Vật phẩm dùng một lần cần số lượng sản phẩm lớn hơn 0.'
                        : 'Vật phẩm chia nhỏ cần định lượng chuẩn lớn hơn 0.');
                    error.statusCode = 400;
                    error.appCode = 'INVALID_CONSUMPTION';
                    throw error;
                }
            }

            let neededQty = requestedQty;
            let neededStdQty = requestedStdQty;
            let consumptionMode = null;

            for (const batch of activeBatches) {
                if (neededQty <= 0 && neededStdQty <= 0) break;

                // Suy ra cách trừ từ đơn vị chuẩn; isSingleUse chỉ còn là dữ liệu tương thích cũ.
                const isSingle = batch.standardUnit === 'PIECE';
                consumptionMode ??= isSingle ? 'QUANTITY' : 'STANDARD_QUANTITY';
                const ratio = batch.quantity / batch.standardQuantity;

                if (isSingle) {
                    // Trừ theo quantity (VD: số lượng lon)
                    const deductedQty = Math.min(batch.quantity, neededQty);
                    if (consume.isWasted && deductedQty > 0) {
                        totalWastedValue += (deductedQty / batch.originalQuantity) * batch.purchasePrice;
                        hasWasted = true;
                    }

                    const finalStatus = consume.isWasted ? 'WASTED' : 'CONSUMED';
                    if (batch.quantity <= neededQty) {
                        neededQty -= batch.quantity;
                        neededStdQty -= batch.standardQuantity; // Cũng trừ stdQty tương ứng
                        
                        const updateObj = consume.isWasted 
                            ? { $set: { usageStatus: 'WASTED' } }
                            : { $set: { quantity: 0, standardQuantity: 0, usageStatus: 'CONSUMED' } };
                            
                        bulkOps.push({
                            updateOne: {
                                filter: { _id: batch._id },
                                update: updateObj
                            }
                        });
                    } else {
                        const newQty = batch.quantity - neededQty;
                        const newStdQty = newQty / ratio;
                        neededQty = 0;
                        neededStdQty = 0;
                        bulkOps.push({
                            updateOne: {
                                filter: { _id: batch._id },
                                update: { $set: { quantity: newQty, standardQuantity: newStdQty } }
                            }
                        });
                    }
                } else {
                    // Trừ theo standardQuantity (VD: số ml sữa)
                    const deductedQty = Math.min(batch.quantity, neededQty); // still can use quantity for value ratio
                    if (consume.isWasted && deductedQty > 0) {
                        totalWastedValue += (deductedQty / batch.originalQuantity) * batch.purchasePrice;
                        hasWasted = true;
                    }

                    const finalStatus = consume.isWasted ? 'WASTED' : 'CONSUMED';
                    if (batch.standardQuantity <= neededStdQty) {
                        neededStdQty -= batch.standardQuantity;
                        neededQty -= batch.quantity;
                        
                        const updateObj = consume.isWasted 
                            ? { $set: { usageStatus: 'WASTED' } }
                            : { $set: { quantity: 0, standardQuantity: 0, usageStatus: 'CONSUMED' } };
                            
                        bulkOps.push({
                            updateOne: {
                                filter: { _id: batch._id },
                                update: updateObj
                            }
                        });
                    } else {
                        const newStdQty = batch.standardQuantity - neededStdQty;
                        const newQty = Number((newStdQty * ratio).toFixed(2));
                        neededStdQty = 0;
                        neededQty = 0;
                        bulkOps.push({
                            updateOne: {
                                filter: { _id: batch._id },
                                update: { $set: { quantity: newQty, standardQuantity: newStdQty } }
                            }
                        });
                    }
                }
            }

            const epsilon = 1e-8;
            const stillMissing = consumptionMode === 'QUANTITY'
                ? neededQty > epsilon
                : neededStdQty > epsilon;
            if (!consumptionMode || stillMissing) {
                const error = new Error('Kho không còn đủ số lượng đã yêu cầu. Vui lòng tải lại dữ liệu.');
                error.statusCode = 409;
                error.appCode = 'INSUFFICIENT_INVENTORY';
                throw error;
            }
        }

        if (bulkOps.length > 0) {
            await Item.bulkWrite(bulkOps, { session });
        }

        let createdRpgLogId = null;

        if (hasWasted && totalWastedValue > 0) {
            const formattedValue = Math.round(totalWastedValue).toLocaleString('vi-VN');
            const message = `Bạn đã lãng phí ${wastedItemName}, thiệt hại khoảng ${formattedValue}đ. Hãy chú ý sử dụng nguyên liệu tốt hơn nhé!`;
            
            await Notification.create([{
                userId: new mongoose.Types.ObjectId(userId),
                title: 'Cảnh báo Lãng phí',
                message,
                type: 'GAMIFICATION'
            }], { session });

            const logs = await RpgLog.create([{
                userId: new mongoose.Types.ObjectId(userId),
                type: 'EXPIRY',
                title: `Lãng phí: ${wastedItemName}`,
                metadata: {
                    itemName: wastedItemName,
                    financialWaste: totalWastedValue
                }
            }], { session });
            createdRpgLogId = logs[0]._id;
        }

        await session.commitTransaction();
        
        let finalWisDelta = 0;
        if (hasWasted && totalWastedValue > 0) {
            // Recalculate RPG stats to immediately reflect WIS penalty if items were wasted
            try {
                const User = require('../models/user.model');
                const rpgService = require('../services/rpg.service');
                
                const oldUser = await User.findById(userId);
                const oldWis = oldUser?.rpgStats?.wis ?? rpgService.WIS_BASELINE;

                await rpgService.calculateUserStats(userId);
                
                const newUser = await User.findById(userId);
                const newWis = newUser?.rpgStats?.wis ?? rpgService.WIS_BASELINE;
                finalWisDelta = newWis - oldWis;
                
                if (finalWisDelta >= 0) {
                    const budget = (oldUser?.essentialBudget && oldUser.essentialBudget > 0) ? oldUser.essentialBudget : 630000;
                    finalWisDelta = -Math.max(1, Math.min(25, Math.round((totalWastedValue / budget) * 100) || 2));
                    if (newUser) {
                        newUser.rpgStats ||= {};
                        newUser.rpgStats.wis = Math.max(0, (newUser.rpgStats.wis ?? 50) + finalWisDelta);
                        await newUser.save();
                    }
                }

                if (createdRpgLogId) {
                    await RpgLog.findByIdAndUpdate(createdRpgLogId, { 
                        wisChange: finalWisDelta,
                        'metadata.financialWaste': totalWastedValue,
                        'metadata.wastedValue': totalWastedValue
                    });
                }
            } catch (rpgErr) {
                console.error('[API] Lỗi khi tính lại chỉ số RPG sau batchUpdate:', rpgErr);
            }
        }

        console.log(`[API] ${req.method} ${req.originalUrl} - Batch update success (User: ${userId}, wisDelta: ${finalWisDelta})`);
        return res.status(200).json({ success: true, message: 'Cập nhật lô hàng thành công!', wisDelta: finalWisDelta });
    } catch (err) {
        await session.abortTransaction();
        throw err;
    } finally {
        session.endSession();
    }
});
