const express = require('express');
const router = express.Router();
const meterController = require('../controllers/meter.controller');
const { verifyToken } = require('../middleware/auth.middleware');
const { validateObjectId } = require('../middleware/validate.middleware');

router.use(verifyToken);

router.get('/meters', meterController.getMeters);
router.get('/meters/:type', meterController.getMeter);
router.put('/meters/:type', meterController.saveMeter);

// Gemini OCR luôn đi qua backend để không lộ API key trên ứng dụng khách.
router.post('/meter-readings/recognize', meterController.recognizeReading);
router.post('/meter-readings/preview', meterController.previewReading);
router.post('/meter-readings/pay-month', meterController.payMonth);
router.get('/meter-readings/statistics', meterController.getStatistics);
router.get('/meter-readings', meterController.getReadings);
router.post('/meter-readings', meterController.createReading);
router.get('/meter-readings/:id/image', validateObjectId('id'), meterController.getReadingImage);
router.delete('/meter-readings/reset/:type', meterController.resetReadings);
router.get('/meter-readings/:id', validateObjectId('id'), meterController.getReading);
router.delete('/meter-readings/:id', validateObjectId('id'), meterController.deleteReading);

module.exports = router;
