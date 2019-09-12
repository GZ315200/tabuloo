
'use strict';

const validator = require('validator');

const meta = require('../meta');
const plugins = require('../plugins');
const search = require('../search');
const categories = require('../categories');
const pagination = require('../pagination');
const privileges = require('../privileges');
const helpers = require('./helpers');

const searchController = module.exports;

searchController.search = async function (req, res, next) {
	if (!plugins.hasListeners('filter:search.query')) {
		return next();
	}
	const page = Math.max(1, parseInt(req.query.page, 10)) || 1;

	const searchOnly = parseInt(req.query.searchOnly, 10) === 1;

	const allowed = await privileges.global.can('search:content', req.uid);
	if (!allowed) {
		return helpers.notAllowed(req, res);
	}

	if (req.query.categories && !Array.isArray(req.query.categories)) {
		req.query.categories = [req.query.categories];
	}
	if (req.query.hasTags && !Array.isArray(req.query.hasTags)) {
		req.query.hasTags = [req.query.hasTags];
	}

	const data = {
		query: req.query.term,
		searchIn: req.query.in || 'posts',
		matchWords: req.query.matchWords || 'all',
		postedBy: req.query.by,
		categories: req.query.categories,
		searchChildren: req.query.searchChildren,
		hasTags: req.query.hasTags,
		replies: req.query.replies,
		repliesFilter: req.query.repliesFilter,
		timeRange: req.query.timeRange,
		timeFilter: req.query.timeFilter,
		sortBy: req.query.sortBy || meta.config.searchDefaultSortBy || '',
		sortDirection: req.query.sortDirection,
		page: page,
		itemsPerPage: req.query.itemsPerPage,
		uid: req.uid,
		qs: req.query,
	};

	const [searchData, categoriesData] = await Promise.all([
		search.search(data),
		buildCategories(req.uid, searchOnly),
	]);

	searchData.pagination = pagination.create(page, searchData.pageCount, req.query);
	searchData.multiplePages = searchData.pageCount > 1;
	searchData.search_query = validator.escape(String(req.query.term || ''));
	searchData.term = req.query.term;

	if (searchOnly) {
		return res.json(searchData);
	}

	searchData.categories = categoriesData;
	searchData.categoriesCount = Math.max(10, Math.min(20, categoriesData.length));
	searchData.breadcrumbs = helpers.buildBreadcrumbs([{ text: '[[global:search]]' }]);
	searchData.expandSearch = !req.query.term;

	searchData.showAsPosts = !req.query.showAs || req.query.showAs === 'posts';
	searchData.showAsTopics = req.query.showAs === 'topics';
	searchData.title = '[[global:header.search]]';

	searchData.searchDefaultSortBy = meta.config.searchDefaultSortBy || '';
	res.render('search', searchData);
};

async function buildCategories(uid, searchOnly) {
	if (searchOnly) {
		return [];
	}
	let categoriesData = await categories.buildForSelect(uid, 'read');
	categoriesData = categoriesData.filter(category => category && !category.link);
	return [
		{ value: 'all', text: '[[unread:all_categories]]' },
		{ value: 'watched', text: '[[category:watched-categories]]' },
	].concat(categoriesData);
}
