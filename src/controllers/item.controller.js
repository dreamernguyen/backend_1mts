const mongoose = require('mongoose');
const Item = require('../models/item.model');
const { asyncHandler } = require('../middleware/errorHandler.middleware');

// Thêm vật phẩm mới vào kho
exports.addItem = asyncHandler(async (req, res) => {
    // lấy data từ client
    const {
        userId, transactionId, 
        rawName, itemName, brand, category, subCategory,
        quantity, originalQuantity, unit, standardQuantity, standardUnit,
        isSingleUse, purchasePrice, expiryDate
    } = req.body;

    // check quyền sở hữu
    if (req.user.userId.toString() !== userId?.toString()) {
        return res.status(403).json({
            success: false,
            message: 'Bạn không thể thêm đồ cho tài khoản khác!'
        });
    }

    // tính Base Unit Price
    const calcQty = quantity > 0 ? quantity : 1;
    const calcStdQty = standardQuantity > 0 ? standardQuantity : 1;
    const baseUnitPrice = purchasePrice > 0 ? Math.round(purchasePrice / (calcQty * calcStdQty)) : 0;

    const newItem = await Item.create({
        userId, transactionId,
        rawName, itemName, brand, category, subCategory,
        quantity,
        originalQuantity: originalQuantity ?? quantity, // Fallback: ban đầu = số lượng mua
        unit, standardQuantity, standardUnit,
        isSingleUse, purchasePrice, baseUnitPrice, expiryDate,
        usageStatus: 'ACTIVE'
    });

    console.log(`[API] ${req.method} ${req.originalUrl} - Add item success (User: ${userId}, Item: ${newItem._id})`);
    return res.status(201).json({ success: true, message: 'Thêm đồ thành công!', data: newItem });
});

// Lấy danh sách đồ (Gom nhóm + lọc theo fridge/pantry)
exports.getItems = asyncHandler(async (req, res) => {
    const { userId } = req.params;
    const { type } = req.query; // ?type=fridge | ?type=pantry | không truyền = tất cả

    // Bộ lọc danh mục theo tab UI
    let categoryFilter;
    if (type === 'fridge') {
        categoryFilter = { $in: ['MEAT', 'SEAFOOD', 'VEGETABLE', 'FRUIT', 'EGG', 'DRINK'] };
    } else if (type === 'pantry') {
        categoryFilter = { $in: ['DRY_FOOD', 'SPICE', 'COSMETIC', 'SUPPLEMENT', 'OTHER'] };
    } else {
        categoryFilter = { $in: ['MEAT', 'SEAFOOD', 'VEGETABLE', 'FRUIT', 'EGG', 'DRY_FOOD', 'DRINK', 'SPICE', 'COSMETIC', 'SUPPLEMENT', 'OTHER'] };
    }

    // aggregate gom trùng itemName+brand, đưa lô cận hạn lên đầu (FIFO)
    const data = await Item.aggregate([
        {
            $match: {
                userId: new mongoose.Types.ObjectId(userId),
                usageStatus: 'ACTIVE',
                quantity: { $gt: 0 },
                category: categoryFilter
            }
        },
        { $sort: { expiryDate: 1 } }, // sort trước để lấy lô cận hạn nhất
        {
            $group: {
                _id: { 
                    itemName: { $toLower: '$itemName' }, 
                    brand: { $toLower: '$brand' } 
                },
                id: { $first: '$_id' },
                itemName: { $first: '$itemName' },
                brand: { $first: '$brand' },
                totalQuantity: { $sum: '$quantity' },
                totalStandardQuantity: { $sum: '$standardQuantity' },
                unit: { $first: '$unit' },
                standardUnit: { $first: '$standardUnit' },
                category: { $first: '$category' },
                subCategory: { $first: '$subCategory' },
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

// Trừ kho hàng loạt theo công thức nấu ăn (FIFO)
exports.consumeRecipe = asyncHandler(async (req, res) => {
    const { userId } = req.params;
    const { ingredients } = req.body; // [{ itemName, brand, amount }]

    if (!Array.isArray(ingredients) || ingredients.length === 0) {
        return res.status(400).json({
            success: false,
            message: 'Danh sách nguyên liệu không hợp lệ hoặc bị rỗng!'
        });
    }

    const bulkOps = [];

    for (const ing of ingredients) {
        // lấy lô ACTIVE, ưu tiên hết hạn trước
        const activeBatches = await Item.find({
            userId,
            itemName: ing.itemName,
            brand: ing.brand,
            usageStatus: 'ACTIVE',
            quantity: { $gt: 0 }
        }).sort({ expiryDate: 1 });

        let neededAmount = ing.amount;

        for (const batch of activeBatches) {
            if (neededAmount <= 0) break;

            if (batch.standardQuantity <= neededAmount) {
                // dùng hết lô này
                neededAmount -= batch.standardQuantity;
                bulkOps.push({
                    updateOne: {
                        filter: { _id: batch._id },
                        update: { $set: { quantity: 0, standardQuantity: 0, usageStatus: 'CONSUMED' } }
                    }
                });
            } else {
                // trừ một phần lô
                const ratio = batch.quantity / batch.standardQuantity;
                const newStandardQty = batch.standardQuantity - neededAmount;
                const newQty = Number((newStandardQty * ratio).toFixed(2));
                neededAmount = 0;

                bulkOps.push({
                    updateOne: {
                        filter: { _id: batch._id },
                        update: { $set: { quantity: newQty, standardQuantity: newStandardQty } }
                    }
                });
            }
        }
    }

    if (bulkOps.length === 0) {
        return res.status(400).json({
            success: false,
            message: 'Không tìm thấy nguyên liệu phù hợp trong kho!'
        });
    }

    // bulkWrite để tối ưu performance
    await Item.bulkWrite(bulkOps);

    console.log(`[API] ${req.method} ${req.originalUrl} - Consume recipe success (User: ${userId})`);
    return res.status(200).json({
        success: true,
        message: 'Đã trừ kho hàng loạt theo công thức thành công!'
    });
});

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
    const { itemName, brand } = req.query;

    if (!itemName) {
        return res.status(400).json({ success: false, message: 'Thiếu tham số itemName!' });
    }

    // 1. match lô ACTIVE của nhóm
    const matchCondition = {
        userId: new mongoose.Types.ObjectId(userId),
        usageStatus: 'ACTIVE',
        quantity: { $gt: 0 },
        itemName: { $regex: new RegExp(`^${itemName}$`, 'i') }, // Case-insensitive exact match
    };
    if (brand && brand !== '') {
        matchCondition.brand = { $regex: new RegExp(`^${brand}$`, 'i') };
    }

    // 2. aggregate gom lô
    const data = await Item.aggregate([
        { $match: matchCondition },
        { $sort: { expiryDate: 1, createdAt: 1 } }, // Hạn gần nhất trước, lô cũ nhất trước
        {
            $group: {
                _id: {
                    // Nếu rawName có giá trị → gom theo rawName+expiryDate
                    // Nếu rỗng → gom theo itemName+expiryDate
                    groupKey: {
                        $cond: {
                            if: { $and: [{ $ne: ['$rawName', ''] }, { $ne: ['$rawName', null] }] },
                            then: { $concat: [{ $toLower: '$rawName' }, '|', { $ifNull: [{ $dateToString: { format: '%Y-%m-%d', date: '$expiryDate' } }, 'no-expiry'] }] },
                            else: { $concat: [{ $toLower: '$itemName' }, '|', { $ifNull: [{ $dateToString: { format: '%Y-%m-%d', date: '$expiryDate' } }, 'no-expiry'] }] }
                        }
                    }
                },
                // Lấy thông tin hiển thị từ lô đầu tiên
                rawName: { $first: '$rawName' },
                itemName: { $first: '$itemName' },
                brand: { $first: '$brand' },
                expiryDate: { $first: '$expiryDate' },
                unit: { $first: '$unit' },
                standardUnit: { $first: '$standardUnit' },
                category: { $first: '$category' },
                isSingleUse: { $first: '$isSingleUse' },
                // Cộng dồn qty các lô
                totalQuantity: { $sum: '$quantity' },
                totalStandardQuantity: { $sum: '$standardQuantity' },
                purchasePrice: { $first: '$purchasePrice' }, // Giá tham khảo từ lô đầu tiên
                baseUnitPrice: { $first: '$baseUnitPrice' }, // Lấy đơn giá chuẩn
                // Mảng id để consume manual
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
    const { groupMetadata, consumptions } = req.body;
    
    if (!groupMetadata || !Array.isArray(consumptions)) {
        return res.status(400).json({ success: false, message: 'Dữ liệu không hợp lệ!' });
    }

    const session = await mongoose.startSession();
    try {
        session.startTransaction();
        const bulkOps = [];

        // 1. Cập nhật metadata
        if (groupMetadata.newItemName || groupMetadata.newBrand || groupMetadata.newCategory || groupMetadata.newSubCategory) {
            const updateFields = {};
            if (groupMetadata.newItemName) updateFields.itemName = groupMetadata.newItemName;
            if (groupMetadata.newBrand) updateFields.brand = groupMetadata.newBrand;
            if (groupMetadata.newCategory) updateFields.category = groupMetadata.newCategory;
            if (groupMetadata.newSubCategory !== undefined) updateFields.subCategory = groupMetadata.newSubCategory;

            if (Object.keys(updateFields).length > 0) {
                bulkOps.push({
                    updateMany: {
                        filter: { 
                            userId: new mongoose.Types.ObjectId(userId),
                            itemName: { $regex: new RegExp(`^${groupMetadata.targetItemName}$`, 'i') },
                            brand: { $regex: new RegExp(`^${groupMetadata.targetBrand}$`, 'i') },
                            usageStatus: 'ACTIVE'
                        },
                        update: { $set: updateFields }
                    }
                });
            }
        }

        // 2. Trừ kho (Consumptions)
        for (const consume of consumptions) {
            if (!consume.batchIds || consume.batchIds.length === 0) continue;
            
            // tìm batch hợp lệ (FIFO)
            const activeBatches = await Item.find({
                _id: { $in: consume.batchIds },
                usageStatus: 'ACTIVE',
                quantity: { $gt: 0 }
            }).sort({ expiryDate: 1, createdAt: 1 }).session(session);

            let neededQty = consume.consumeQuantity || 0;
            let neededStdQty = consume.consumeStandardQuantity || 0;

            for (const batch of activeBatches) {
                if (neededQty <= 0 && neededStdQty <= 0) break;

                // Tùy theo món dùng 1 lần/nhiều lần
                const isSingle = batch.isSingleUse;
                const ratio = batch.quantity / batch.standardQuantity;

                if (isSingle) {
                    // Trừ theo quantity (VD: số lượng lon)
                    if (batch.quantity <= neededQty) {
                        neededQty -= batch.quantity;
                        neededStdQty -= batch.standardQuantity; // Cũng trừ stdQty tương ứng
                        bulkOps.push({
                            updateOne: {
                                filter: { _id: batch._id },
                                update: { $set: { quantity: 0, standardQuantity: 0, usageStatus: 'CONSUMED' } }
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
                    if (batch.standardQuantity <= neededStdQty) {
                        neededStdQty -= batch.standardQuantity;
                        neededQty -= batch.quantity;
                        bulkOps.push({
                            updateOne: {
                                filter: { _id: batch._id },
                                update: { $set: { quantity: 0, standardQuantity: 0, usageStatus: 'CONSUMED' } }
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
        }

        if (bulkOps.length > 0) {
            await Item.bulkWrite(bulkOps, { session });
        }

        await session.commitTransaction();
        console.log(`[API] ${req.method} ${req.originalUrl} - Batch update success (User: ${userId})`);
        return res.status(200).json({ success: true, message: 'Cập nhật lô hàng thành công!' });
    } catch (err) {
        await session.abortTransaction();
        throw err;
    } finally {
        session.endSession();
    }
});
