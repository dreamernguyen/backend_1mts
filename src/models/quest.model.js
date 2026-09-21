const mongoose = require('mongoose');

const questSchema = new mongoose.Schema({
  code: { 
    type: String, 
    required: true, 
    unique: true,
    uppercase: true 
  },
  name: { 
    type: String, 
    required: true 
  },
  description: { 
    type: String, 
    required: true 
  },
  type: { 
    type: String, 
    enum: ['DAILY', 'ACHIEVEMENT', 'HIDDEN'], 
    required: true 
  },
  category: { 
    type: String, 
    enum: ['BUDGET', 'INVENTORY', 'COOKING', 'HEALTH', 'SURVIVAL'],
    required: true
  },
  condition: {
    actionType: { type: String, required: true }, 
    targetValue: { type: Number, default: 1 }     
  },
  rewards: {
    xp: { type: Number, default: 0 },
    hp: { type: Number, default: 0 },
    mana: { type: Number, default: 0 },
    def: { type: Number, default: 0 },
    wis: { type: Number, default: 0 },
    titleUnlock: { type: String, default: null } 
  },
  rewardDescription: { 
    type: String, 
    required: true 
  },
  uiConfig: {
    iconName: { type: String, default: null }, 
    iconUrl: { type: String, default: null },  
    colorHex: { type: String, default: '#FFFFFF' } 
  },
  isActive: { 
    type: Boolean, 
    default: true 
  }
}, { timestamps: true });

module.exports = mongoose.model('Quest', questSchema);
