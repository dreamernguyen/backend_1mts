
const express = require('express');
const router = express.Router();
const authController = require('../controllers/auth.controller');

// Cổng tiếp nhận login Google: POST http://localhost:5000/api/auth/google
router.post('/google', authController.loginWithGoogle);

// Cổng tiếp nhận login Khách: POST http://localhost:5000/api/auth/guest
router.post('/guest', authController.loginAsGuest);

module.exports = router;