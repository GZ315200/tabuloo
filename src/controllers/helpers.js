'use strict';

const nconf = require('nconf');
const validator = require('validator');
const winston = require('winston');
const querystring = require('querystring');

const user = require('../user');
const privileges = require('../privileges');
const categories = require('../categories');
const plugins = require('../plugins');
const meta = require('../meta');
const middleware = require('../middleware');
const utils = require('../utils');

const helpers = module.exports;

helpers.noScriptErrors = function (req, res, error, httpStatus) {
	if (req.body.noscript !== 'true') {
		return res.status(httpStatus).send(error);
	}

	const middleware = require('../middleware');
	const httpStatusString = httpStatus.toString();
	middleware.buildHeader(req, res, function () {
		res.status(httpStatus).render(httpStatusString, {
			path: req.path,
			loggedIn: req.loggedIn,
			error: error,
			returnLink: true,
			title: '[[global:' + httpStatusString + '.title]]',
		});
	});
};

helpers.validFilters = { '': true, new: true, watched: true, unreplied: true };

helpers.terms = {
	daily: 'day',
	weekly: 'week',
	monthly: 'month',
};

helpers.buildQueryString = function (cid, filter, term) {
	const qs = {};
	if (cid) {
		qs.cid = cid;
	}
	if (filter) {
		qs.filter = filter;
	}
	if (term) {
		qs.term = term;
	}

	return Object.keys(qs).length ? '?' + querystring.stringify(qs) : '';
};

helpers.buildFilters = function (url, filter, query) {
	return [{
		name: '[[unread:all-topics]]',
		url: url + helpers.buildQueryString(query.cid, '', query.term),
		selected: filter === '',
		filter: '',
	}, {
		name: '[[unread:new-topics]]',
		url: url + helpers.buildQueryString(query.cid, 'new', query.term),
		selected: filter === 'new',
		filter: 'new',
	}, {
		name: '[[unread:watched-topics]]',
		url: url + helpers.buildQueryString(query.cid, 'watched', query.term),
		selected: filter === 'watched',
		filter: 'watched',
	}, {
		name: '[[unread:unreplied-topics]]',
		url: url + helpers.buildQueryString(query.cid, 'unreplied', query.term),
		selected: filter === 'unreplied',
		filter: 'unreplied',
	}];
};

helpers.buildTerms = function (url, term, query) {
	return [{
		name: '[[recent:alltime]]',
		url: url + helpers.buildQueryString(query.cid, query.filter, ''),
		selected: term === 'alltime',
		term: 'alltime',
	}, {
		name: '[[recent:day]]',
		url: url + helpers.buildQueryString(query.cid, query.filter, 'daily'),
		selected: term === 'day',
		term: 'day',
	}, {
		name: '[[recent:week]]',
		url: url + helpers.buildQueryString(query.cid, query.filter, 'weekly'),
		selected: term === 'week',
		term: 'week',
	}, {
		name: '[[recent:month]]',
		url: url + helpers.buildQueryString(query.cid, query.filter, 'monthly'),
		selected: term === 'month',
		term: 'month',
	}];
};

helpers.notAllowed = function (req, res, error) {
	plugins.fireHook('filter:helpers.notAllowed', {
		req: req,
		res: res,
		error: error,
	}, function (err) {
		if (err) {
			return winston.error(err);
		}
		if (req.loggedIn || req.uid === -1) {
			if (res.locals.isAPI) {
				res.status(403).json({
					path: req.path.replace(/^\/api/, ''),
					loggedIn: req.loggedIn,
					error: error,
					title: '[[global:403.title]]',
				});
			} else {
				middleware.buildHeader(req, res, function () {
					res.status(403).render('403', {
						path: req.path,
						loggedIn: req.loggedIn,
						error: error,
						title: '[[global:403.title]]',
					});
				});
			}
		} else if (res.locals.isAPI) {
			req.session.returnTo = req.url.replace(/^\/api/, '');
			res.status(401).json('not-authorized');
		} else {
			req.session.returnTo = req.url;
			res.redirect(nconf.get('relative_path') + '/login');
		}
	});
};

helpers.redirect = function (res, url) {
	if (res.locals.isAPI) {
		res.set('X-Redirect', encodeURI(url)).status(200).json(url);
	} else {
		res.redirect(nconf.get('relative_path') + encodeURI(url));
	}
};

helpers.buildCategoryBreadcrumbs = async function (cid) {
	const breadcrumbs = [];

	while (parseInt(cid, 10)) {
		/* eslint-disable no-await-in-loop */
		const data = await categories.getCategoryFields(cid, ['name', 'slug', 'parentCid', 'disabled', 'isSection']);
		if (!data.disabled && !data.isSection) {
			breadcrumbs.unshift({
				text: String(data.name),
				url: nconf.get('relative_path') + '/category/' + data.slug,
			});
		}
		cid = data.parentCid;
	}
	if (meta.config.homePageRoute && meta.config.homePageRoute !== 'categories') {
		breadcrumbs.unshift({
			text: '[[global:header.categories]]',
			url: nconf.get('relative_path') + '/categories',
		});
	}

	breadcrumbs.unshift({
		text: '[[global:home]]',
		url: nconf.get('relative_path') + '/',
	});

	return breadcrumbs;
};

helpers.buildBreadcrumbs = function (crumbs) {
	const breadcrumbs = [
		{
			text: '[[global:home]]',
			url: nconf.get('relative_path') + '/',
		},
	];

	crumbs.forEach(function (crumb) {
		if (crumb) {
			if (crumb.url) {
				crumb.url = nconf.get('relative_path') + crumb.url;
			}
			breadcrumbs.push(crumb);
		}
	});

	return breadcrumbs;
};

helpers.buildTitle = function (pageTitle) {
	const titleLayout = meta.config.titleLayout || '{pageTitle} | {browserTitle}';

	const browserTitle = validator.escape(String(meta.config.browserTitle || meta.config.title || 'NodeBB'));
	pageTitle = pageTitle || '';
	const title = titleLayout.replace('{pageTitle}', () => pageTitle).replace('{browserTitle}', () => browserTitle);
	return title;
};

helpers.getCategories = async function (set, uid, privilege, selectedCid) {
	const cids = await categories.getCidsByPrivilege(set, uid, privilege);
	return await getCategoryData(cids, uid, selectedCid);
};

helpers.getCategoriesByStates = async function (uid, selectedCid, states) {
	let cids = await user.getCategoriesByStates(uid, states);
	cids = await privileges.categories.filterCids('read', cids, uid);
	return await getCategoryData(cids, uid, selectedCid);
};

helpers.getWatchedCategories = async function (uid, selectedCid) {
	let cids = await user.getWatchedCategories(uid);
	cids = await privileges.categories.filterCids('read', cids, uid);
	return await getCategoryData(cids, uid, selectedCid);
};

async function getCategoryData(cids, uid, selectedCid) {
	if (selectedCid && !Array.isArray(selectedCid)) {
		selectedCid = [selectedCid];
	}
	let categoryData = await categories.getCategoriesFields(cids, ['cid', 'order', 'name', 'slug', 'icon', 'link', 'color', 'bgColor', 'parentCid', 'image', 'imageClass']);
	categoryData = categoryData.filter(category => category && !category.link);

	let selectedCategory = [];
	const selectedCids = [];
	categoryData.forEach(function (category) {
		category.selected = selectedCid ? selectedCid.includes(String(category.cid)) : false;
		category.parentCid = category.hasOwnProperty('parentCid') && utils.isNumber(category.parentCid) ? category.parentCid : 0;
		if (category.selected) {
			selectedCategory.push(category);
			selectedCids.push(category.cid);
		}
	});
	selectedCids.sort((a, b) => a - b);

	if (selectedCategory.length > 1) {
		selectedCategory = {
			icon: 'fa-plus',
			name: '[[unread:multiple-categories-selected]]',
			bgColor: '#ddd',
		};
	} else if (selectedCategory.length === 1) {
		selectedCategory = selectedCategory[0];
	} else {
		selectedCategory = undefined;
	}

	const categoriesData = [];
	const tree = categories.getTree(categoryData);

	tree.forEach(category => recursive(category, categoriesData, ''));

	return { categories: categoriesData, selectedCategory: selectedCategory, selectedCids: selectedCids };
}

function recursive(category, categoriesData, level) {
	category.level = level;
	categoriesData.push(category);
	if (Array.isArray(category.children)) {
		category.children.forEach(function (child) {
			recursive(child, categoriesData, '&nbsp;&nbsp;&nbsp;&nbsp;' + level);
		});
	}
}

helpers.getHomePageRoutes = async function (uid) {
	let cids = await categories.getAllCidsFromSet('categories:cid');
	cids = await privileges.categories.filterCids('find', cids, uid);
	const categoryData = await categories.getCategoriesFields(cids, ['name', 'slug']);

	const categoryRoutes = categoryData.map(function (category) {
		return {
			route: 'category/' + category.slug,
			name: 'Category: ' + category.name,
		};
	});
	const routes = [
		{
			route: 'categories',
			name: 'Categories',
		},
		{
			route: 'unread',
			name: 'Unread',
		},
		{
			route: 'recent',
			name: 'Recent',
		},
		{
			route: 'top',
			name: 'Top',
		},
		{
			route: 'popular',
			name: 'Popular',
		},
	].concat(categoryRoutes, [
		{
			route: 'custom',
			name: 'Custom',
		},
	]);
	const data = await plugins.fireHook('filter:homepage.get', { routes: routes });
	return data.routes;
};

require('../promisify')(helpers);
