const express = require('express');
const router = express.Router();
const itemController = require('../controllers/item.controller');
const { verifyToken, checkOwnership } = require('../middleware/auth.middleware');
const { requireBody, validateObjectId } = require('../middleware/validate.middleware');

// Thêm đồ mới vào kho - POST /api/items/essential-items/add
router.post('/essential-items/add',
    verifyToken,
    requireBody('userId', 'itemName', 'quantity', 'unit', 'standardQuantity', 'standardUnit', 'purchasePrice'),
    itemController.addItem
);

// Lấy danh sách đồ theo User - GET /api/items/essential-items/user/:userId?type=fridge|pantry
router.get('/essential-items/user/:userId',
    verifyToken, checkOwnership, validateObjectId('userId'),
    itemController.getItems
);

// Tìm kiếm đồ trong kho - GET /api/items/essential-items/user/:userId/search?q=...
router.get('/essential-items/user/:userId/search',
    verifyToken, checkOwnership, validateObjectId('userId'),
    itemController.searchItems
);

// Lấy đồ cận hạn/hết hạn (context cho AI gợi ý món) - GET /api/items/essential-items/user/:userId/expiring
router.get('/essential-items/user/:userId/expiring',
    verifyToken, checkOwnership, validateObjectId('userId'),
    itemController.getListExpiring
);

// Chi tiết nhóm item - gom theo rawName+expiryDate - GET /api/items/essential-items/user/:userId/detail?itemName=...&brand=...
router.get('/essential-items/user/:userId/detail',
    verifyToken, checkOwnership, validateObjectId('userId'),
    itemController.getItemDetail
);

// Cập nhật hàng loạt (Batch Update Form Detail) - PUT /api/items/essential-items/user/:userId/batch-update
router.put('/essential-items/user/:userId/batch-update',
    verifyToken, checkOwnership, validateObjectId('userId'),
    requireBody('groupMetadata', 'consumptions'),
    itemController.batchUpdate
);

// Trừ kho thủ công - PUT /api/items/essential-items/:id/consume-manual
router.put('/essential-items/:id/consume-manual',
    verifyToken, validateObjectId('id'),
    requireBody('consumeQuantity'),
    itemController.consumeManual
);

// Trừ kho hàng loạt theo công thức nấu ăn - POST /api/items/essential-items/user/:userId/consume-recipe
router.post('/essential-items/user/:userId/consume-recipe',
    verifyToken, checkOwnership, validateObjectId('userId'),
    requireBody('ingredients'),
    itemController.consumeRecipe
);

// Xóa cứng vật phẩm (khi nhập nhầm) - DELETE /api/items/essential-items/:id
router.delete('/essential-items/:id',
    verifyToken, validateObjectId('id'),
    itemController.deleteItem
);

module.exports = router;