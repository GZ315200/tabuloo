'use strict';

const user = require('../../user');
const categories = require('../../categories');
const accountHelpers = require('./helpers');

const categoriesController = module.exports;

categoriesController.get = async function (req, res, next) {
	const userData = await accountHelpers.getUserDataByUserSlug(req.params.userslug, req.uid);
	if (!userData) {
		return next();
	}
	const [states, categoriesData] = await Promise.all([
		user.getCategoryWatchState(userData.uid),
		categories.buildForSelect(userData.uid, 'find'),
	]);

	categoriesData.forEach(function (category) {
		if (category) {
			category.isIgnored = states[category.cid] === categories.watchStates.ignoring;
			category.isWatched = states[category.cid] === categories.watchStates.watching;
			category.isNotWatched = states[category.cid] === categories.watchStates.notwatching;
		}
	});
	userData.categories = categoriesData;
	userData.title = '[[pages:account/watched_categories, ' + userData.username + ']]';
	res.render('account/categories', userData);
};
