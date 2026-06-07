const express = require('express');
const router = express.Router();
const txController = require('../controllers/transaction.controller');
const { verifyToken, checkOwnership } = require('../middleware/auth.middleware');
const { requireBody, validateObjectId } = require('../middleware/validate.middleware');

// Gọi AI bóc tách hóa đơn - POST /api/transactions/parse
router.post('/parse',
    verifyToken,
    txController.parseDocument
);

// Lưu giao dịch chính thức - POST /api/transactions
router.post('/',
    verifyToken,
    requireBody('userId', 'transactionType', 'amount', 'note', 'category'),
    txController.addTransaction
);

// Lấy lịch sử thu chi - GET /api/transactions/user/:userId?mode=compact
router.get('/user/:userId',
    verifyToken, checkOwnership, validateObjectId('userId'),
    txController.getHistory
);

// Lấy chi tiết một giao dịch - GET /api/transactions/:id
router.get('/:id',
    verifyToken, validateObjectId('id'),
    txController.getTransactionById
);

// Xóa giao dịch (cascade xóa items liên quan) - DELETE /api/transactions/:id
router.delete('/:id',
    verifyToken, validateObjectId('id'),
    txController.deleteTransaction
);

module.exports = router;
