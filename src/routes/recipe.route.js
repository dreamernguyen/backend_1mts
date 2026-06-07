const express = require('express');
const router = express.Router();
const recipeController = require('../controllers/recipe.controller');
const { verifyToken } = require('../middleware/auth.middleware');

// Áp dụng middleware verifyToken cho tất cả các route
router.use(verifyToken);

router.get('/search', recipeController.searchRecipes);
router.get('/recommendations', recipeController.getRecommendations);
router.post('/ai-search', recipeController.aiSearchRecipe);
router.post('/cook', recipeController.cookRecipe);
router.get('/suggest-today', recipeController.suggestTodayRecipe);
router.get('/:id/details', recipeController.getRecipeDetails);

module.exports = router;
