const PantryItem = require('../models/pantry.model');

/**
 * 1. LẤY DANH SÁCH THỰC PHẨM TRONG TỦ LẠNH (Có tự động tính trạng thái ảo storageStatus)
 */
exports.getPantryItems = async (req, res) => {
    try {
        const { userId } = req.query; // Nhận userId gửi từ client lên

        if (!userId) {
            return res.status(400).json({
                success: false,
                message: "Tham số userId là bắt buộc để tải dữ liệu tủ lạnh!"
            });
        }

        // Tìm toàn bộ thực phẩm của User, sắp xếp theo thứ tự hạn sử dụng gần nhất lên đầu
        const items = await PantryItem.find({ userId: userId }).sort({ expiryDate: 1 });

        return res.status(200).json({
            success: true,
            count: items.length,
            message: "Tải danh sách kho thực phẩm thành công!",
            data: items // Client nhận được sẽ có thêm trường ảo 'storageStatus' tự tính
        });

    } catch (error) {
        console.error(`[Pantry Error - Get]: ${error.message}`);
        return res.status(500).json({
            success: false,
            message: "Lỗi máy chủ khi tải kho thực phẩm!",
            error: error.message
        });
    }
};

/**
 * 2. THÊM THỦ CÔNG MỘT THỰC PHẨM (Khi được bố mẹ gửi đồ ở quê lên, không có bill)
 */
exports.addPantryItemManually = async (req, res) => {
    try {
        const { userId, itemName, category, quantity, unit, expiryDate, purchasePrice, isSingleUse } = req.body;

        // Kiểm tra các ràng buộc bắt buộc
        if (!userId || !itemName || !expiryDate) {
            return res.status(400).json({
                success: false,
                message: "Thiếu thông tin bắt buộc (userId, itemName, expiryDate)!"
            });
        }

        // Tạo bản ghi thực phẩm mới vào tủ lạnh
        const newItem = await PantryItem.create({
            userId,
            itemName,
            rawName: itemName, // Nhập tay thì tên gốc trùng tên chuẩn
            category: category || 'OTHERS',
            quantity: quantity || 1,
            originalQuantity: quantity || 1,
            unit: unit || 'cái',
            isSingleUse: isSingleUse || false,
            purchasePrice: purchasePrice || 0,
            expiryDate: new Date(expiryDate)
        });

        return res.status(201).json({
            success: true,
            message: "Đã thêm thực phẩm vào tủ lạnh thành công!",
            data: newItem
        });

    } catch (error) {
        console.error(`[Pantry Error - Add]: ${error.message}`);
        return res.status(500).json({
            success: false,
            message: "Lỗi máy chủ khi thêm thực phẩm thủ công!",
            error: error.message
        });
    }
};

/**
 * 3. SỬ DỤNG HOẶC TIÊU HAO THỰC PHẨM (Trừ dần định lượng)
 */
exports.consumePantryItem = async (req, res) => {
    try {
        const { itemId } = req.params;
        const { amountConsumed } = req.body; // Lượng tiêu hao (Ví dụ: dùng 200ml sữa, ăn 2 quả trứng)

        const item = await PantryItem.findById(itemId);

        if (!item) {
            return res.status(404).json({
                success: false,
                message: "Không tìm thấy thực phẩm này trong tủ lạnh!"
            });
        }

        // Xử lý logic tiêu thụ
        if (item.isSingleUse || !amountConsumed || amountConsumed >= item.quantity) {
            // Nếu là đồ dùng 1 lần (như trứng, sữa hộp nhỏ) hoặc lượng dùng vượt quá tồn kho
            // Tiến hành xóa món hàng khỏi tủ lạnh (được coi là đã dùng hết)
            await PantryItem.findByIdAndDelete(itemId);
            return res.status(200).json({
                success: true,
                message: `Đã dùng hết món '${item.itemName}' và dọn sạch khỏi tủ lạnh!`,
                data: { ...item.toObject(), quantity: 0 }
            });
        } else {
            // Đối với đồ dùng nhiều lần (Chai sữa 1L, bì gạo, túi muối), tiến hành trừ dần tồn kho
            item.quantity = item.quantity - amountConsumed;
            await item.save();

            return res.status(200).json({
                success: true,
                message: `Đã dùng ${amountConsumed} ${item.unit}. Lượng tồn kho còn lại: ${item.quantity} ${item.unit}`,
                data: item
            });
        }

    } catch (error) {
        console.error(`[Pantry Error - Consume]: ${error.message}`);
        return res.status(500).json({
            success: false,
            message: "Lỗi máy chủ khi thực hiện tiêu thụ thực phẩm!",
            error: error.message
        });
    }
};

/**
 * 4. VỨT BỎ ĐỒ HỎNG HOẶC QUÁ HẠN (Xóa trực tiếp khỏi tủ lạnh)
 */
exports.deletePantryItem = async (req, res) => {
    try {
        const { itemId } = req.params;

        const deletedItem = await PantryItem.findByIdAndDelete(itemId);

        if (!deletedItem) {
            return res.status(404).json({
                success: false,
                message: "Không tìm thấy thực phẩm cần xóa!"
            });
        }

        return res.status(200).json({
            success: true,
            message: `Đã dọn dẹp món '${deletedItem.itemName}' khỏi tủ lạnh thành công!`,
            data: deletedItem
        });

    } catch (error) {
        console.error(`[Pantry Error - Delete]: ${error.message}`);
        return res.status(500).json({
            success: false,
            message: "Lỗi máy chủ khi xóa thực phẩm!",
            error: error.message
        });
    }
};