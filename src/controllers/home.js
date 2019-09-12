'use strict';

const url = require('url');

const plugins = require('../plugins');
const meta = require('../meta');
const user = require('../user');

function adminHomePageRoute() {
	return (meta.config.homePageRoute || meta.config.homePageCustom || '').replace(/^\/+/, '') || 'categories';
}

async function getUserHomeRoute(uid) {
	const settings = await user.getSettings(uid);
	let route = adminHomePageRoute();

	if (settings.homePageRoute !== 'undefined' && settings.homePageRoute !== 'none') {
		route = (settings.homePageRoute || route).replace(/^\/+/, '');
	}

	return route;
}

async function rewrite(req, res, next) {
	if (req.path !== '/' && req.path !== '/api/' && req.path !== '/api') {
		return next();
	}
	let route = adminHomePageRoute();
	if (meta.config.allowUserHomePage) {
		route = await getUserHomeRoute(req.uid, next);
	}

	let parsedUrl;
	try {
		parsedUrl = url.parse(route, true);
	} catch (err) {
		return next(err);
	}

	const pathname = parsedUrl.pathname;
	const hook = 'action:homepage.get:' + pathname;
	if (!plugins.hasListeners(hook)) {
		req.url = req.path + (!req.path.endsWith('/') ? '/' : '') + pathname;
	} else {
		res.locals.homePageRoute = pathname;
	}
	req.query = Object.assign(parsedUrl.query, req.query);

	next();
}

exports.rewrite = rewrite;

function pluginHook(req, res, next) {
	var hook = 'action:homepage.get:' + res.locals.homePageRoute;

	plugins.fireHook(hook, {
		req: req,
		res: res,
		next: next,
	});
}

exports.pluginHook = pluginHook;
