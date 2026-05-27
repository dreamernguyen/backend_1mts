const express = require('express');
const router = express.Router();
const pantryController = require('../controllers/pantry.controller');

// 1. Cổng tải danh sách thực phẩm trong tủ lạnh: GET http://localhost:5000/api/pantry?userId=xxx
router.get('/', pantryController.getPantryItems);

// 2. Cổng thêm thực phẩm thủ công không qua quét bill: POST http://localhost:5000/api/pantry
router.post('/', pantryController.addPantryItemManually);

// 3. Cổng tiêu thụ/trừ bớt lượng thực phẩm trong kho: PUT http://localhost:5000/api/pantry/consume/itemId
router.put('/consume/:itemId', pantryController.consumePantryItem);

// 4. Cổng xóa bỏ thực phẩm hỏng khỏi tủ lạnh: DELETE http://localhost:5000/api/pantry/itemId
router.delete('/:itemId', pantryController.deletePantryItem);

module.exports = router;