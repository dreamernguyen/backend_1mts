const express = require('express');
const router = express.Router();
const receiptController = require('../controllers/receipt.controller');


// Cấu hình endpoint tiếp nhận gói tin bóc tách hóa đơn
// Đầu URL đầy đủ sẽ là: POST http://localhost:5000/api/receipt/process
router.post('/process', receiptController.processReceiptOCR);

module.exports = router;

