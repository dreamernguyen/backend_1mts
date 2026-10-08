const mongoose = require('mongoose');
const schema = new mongoose.Schema({
    _id: { type: String },
    enabled: { type: Boolean, default: false },
    version: { type: String, default: 'guest-v1' }
}, { timestamps: true });
module.exports = mongoose.model('DemoSetting', schema, 'demo_settings');
