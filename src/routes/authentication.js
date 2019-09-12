'use strict';

var async = require('async');
var passport = require('passport');
var passportLocal = require('passport-local').Strategy;
var winston = require('winston');

var controllers = require('../controllers');
var helpers = require('../controllers/helpers');
var plugins = require('../plugins');

var loginStrategies = [];

var Auth = module.exports;

Auth.initialize = function (app, middleware) {
	const passportInitMiddleware = passport.initialize();
	app.use(function passportInitialize(req, res, next) {
		passportInitMiddleware(req, res, next);
	});
	const passportSessionMiddleware = passport.session();
	app.use(function passportSession(req, res, next) {
		passportSessionMiddleware(req, res, next);
	});

	app.use(Auth.setAuthVars);

	Auth.app = app;
	Auth.middleware = middleware;
};

Auth.setAuthVars = function setAuthVars(req, res, next) {
	var isSpider = req.isSpider();
	req.loggedIn = !isSpider && !!req.user;
	if (req.user) {
		req.uid = parseInt(req.user.uid, 10);
	} else if (isSpider) {
		req.uid = -1;
	} else {
		req.uid = 0;
	}
	next();
};

Auth.getLoginStrategies = function () {
	return loginStrategies;
};

Auth.reloadRoutes = async function (params) {
	loginStrategies.length = 0;
	const router = params.router;
	if (plugins.hasListeners('action:auth.overrideLogin')) {
		winston.warn('[authentication] Login override detected, skipping local login strategy.');
		plugins.fireHook('action:auth.overrideLogin');
	} else {
		passport.use(new passportLocal({ passReqToCallback: true }, controllers.authentication.localLogin));
	}
	try {
		loginStrategies = await plugins.fireHook('filter:auth.init', loginStrategies);
	} catch (err) {
		winston.error('[authentication] ' + err.stack);
	}

	loginStrategies = loginStrategies || [];
	loginStrategies.forEach(function (strategy) {
		if (strategy.url) {
			router.get(strategy.url, Auth.middleware.applyCSRF, function (req, res, next) {
				req.session.ssoState = req.csrfToken();
				passport.authenticate(strategy.name, {
					scope: strategy.scope,
					prompt: strategy.prompt || undefined,
					state: req.session.ssoState,
				})(req, res, next);
			});
		}

		router[strategy.callbackMethod || 'get'](strategy.callbackURL, function (req, res, next) {
			// Ensure the passed-back state value is identical to the saved ssoState (unless explicitly skipped)
			if (strategy.checkState === false) {
				return next();
			}

			next(req.query.state !== req.session.ssoState ? new Error('[[error:csrf-invalid]]') : null);
		}, function (req, res, next) {
			// Trigger registration interstitial checks
			req.session.registration = req.session.registration || {};
			// save returnTo for later usage in /register/complete
			// passport seems to remove `req.session.returnTo` after it redirects
			req.session.registration.returnTo = req.session.returnTo;
			next();
		}, function (req, res, next) {
			passport.authenticate(strategy.name, function (err, user) {
				if (err) {
					delete req.session.registration;
					return next(err);
				}

				if (!user) {
					delete req.session.registration;
					return helpers.redirect(res, strategy.failureUrl !== undefined ? strategy.failureUrl : '/login');
				}

				res.locals.user = user;
				res.locals.strategy = strategy;
				next();
			})(req, res, next);
		},
		Auth.middleware.validateAuth,
		(req, res, next) => {
			async.waterfall([
				async.apply(req.login.bind(req), res.locals.user),
				async.apply(controllers.authentication.onSuccessfulLogin, req, req.uid),
			], function (err) {
				if (err) {
					return next(err);
				}

				helpers.redirect(res, strategy.successUrl !== undefined ? strategy.successUrl : '/');
			});
		});
	});

	var multipart = require('connect-multiparty');
	var multipartMiddleware = multipart();
	var middlewares = [multipartMiddleware, Auth.middleware.applyCSRF, Auth.middleware.applyBlacklist];

	router.post('/register', middlewares, controllers.authentication.register);
	router.post('/register/complete', middlewares, controllers.authentication.registerComplete);
	router.post('/register/abort', controllers.authentication.registerAbort);
	router.post('/login', Auth.middleware.applyCSRF, Auth.middleware.applyBlacklist, controllers.authentication.login);
	router.post('/logout', Auth.middleware.applyCSRF, controllers.authentication.logout);
};

passport.serializeUser(function (user, done) {
	done(null, user.uid);
});

passport.deserializeUser(function (uid, done) {
	done(null, {
		uid: uid,
	});
});
