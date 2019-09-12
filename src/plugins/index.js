'use strict';

const fs = require('fs');
const path = require('path');
const async = require('async');
const winston = require('winston');
const semver = require('semver');
const nconf = require('nconf');
const util = require('util');

const user = require('../user');

const readdirAsync = util.promisify(fs.readdir);

var app;
var middleware;

const Plugins = module.exports;

require('./install')(Plugins);
require('./load')(Plugins);
require('./hooks')(Plugins);
require('./usage')(Plugins);
Plugins.data = require('./data');

Plugins.getPluginPaths = Plugins.data.getPluginPaths;
Plugins.loadPluginInfo = Plugins.data.loadPluginInfo;

Plugins.pluginsData = {};
Plugins.libraries = {};
Plugins.loadedHooks = {};
Plugins.staticDirs = {};
Plugins.cssFiles = [];
Plugins.lessFiles = [];
Plugins.acpLessFiles = [];
Plugins.clientScripts = [];
Plugins.acpScripts = [];
Plugins.libraryPaths = [];
Plugins.versionWarning = [];
Plugins.soundpacks = [];
Plugins.languageData = {};
Plugins.loadedPlugins = [];

Plugins.initialized = false;

var defaultRequire = module.require;

module.require = function (p) {
	try {
		return defaultRequire.apply(module, arguments);
	} catch (err) {
		// if we can't find the module try in parent directory
		// since plugins.js moved into plugins folder
		if (err.code === 'MODULE_NOT_FOUND') {
			let stackLine = err.stack.split('\n');
			stackLine = stackLine.find(line => line.includes('nodebb-plugin') || line.includes('nodebb-theme'));
			var deprecatedPath = err.message.replace('Cannot find module ', '');
			winston.warn('[deprecated] requiring core modules with `module.parent.require(' + deprecatedPath + ')` is deprecated. Please use `require.main.require("./src/<module_name>")` instead.\n' + stackLine);
			if (path.isAbsolute(p)) {
				throw err;
			}
			return defaultRequire.apply(module, [path.join('../', p)]);
		}
		throw err;
	}
};

Plugins.requireLibrary = function (pluginID, libraryPath) {
	Plugins.libraries[pluginID] = require(libraryPath);
	Plugins.libraryPaths.push(libraryPath);
};

Plugins.init = async function (nbbApp, nbbMiddleware) {
	if (Plugins.initialized) {
		return;
	}

	if (nbbApp) {
		app = nbbApp;
		middleware = nbbMiddleware;
	}

	if (global.env === 'development') {
		winston.verbose('[plugins] Initializing plugins system');
	}

	await Plugins.reload();
	if (global.env === 'development') {
		winston.info('[plugins] Plugins OK');
	}

	Plugins.initialized = true;
};

Plugins.reload = async function () {
	// Resetting all local plugin data
	Plugins.libraries = {};
	Plugins.loadedHooks = {};
	Plugins.staticDirs = {};
	Plugins.versionWarning = [];
	Plugins.cssFiles.length = 0;
	Plugins.lessFiles.length = 0;
	Plugins.acpLessFiles.length = 0;
	Plugins.clientScripts.length = 0;
	Plugins.acpScripts.length = 0;
	Plugins.libraryPaths.length = 0;
	Plugins.loadedPlugins.length = 0;

	await user.addInterstitials();

	const paths = await Plugins.getPluginPaths();
	for (const path of paths) {
		/* eslint-disable no-await-in-loop */
		await Plugins.loadPlugin(path);
	}

	// If some plugins are incompatible, throw the warning here
	if (Plugins.versionWarning.length && nconf.get('isPrimary') === 'true') {
		console.log('');
		winston.warn('[plugins/load] The following plugins may not be compatible with your version of NodeBB. This may cause unintended behaviour or crashing. In the event of an unresponsive NodeBB caused by this plugin, run `./nodebb reset -p PLUGINNAME` to disable it.');
		for (var x = 0, numPlugins = Plugins.versionWarning.length; x < numPlugins; x += 1) {
			console.log('  * '.yellow + Plugins.versionWarning[x]);
		}
		console.log('');
	}

	Object.keys(Plugins.loadedHooks).forEach(function (hook) {
		Plugins.loadedHooks[hook].sort((a, b) => a.priority - b.priority);
	});
};

Plugins.reloadRoutes = async function (params) {
	var controllers = require('../controllers');
	await Plugins.fireHook('static:app.load', { app: app, router: params.router, middleware: middleware, controllers: controllers });
	winston.verbose('[plugins] All plugins reloaded and rerouted');
};

function request(url, callback) {
	require('request')(url, {
		json: true,
	}, function (err, res, body) {
		if (res.statusCode === 404 || !body) {
			return callback(err, {});
		}
		callback(err, body);
	});
}
const requestAsync = util.promisify(request);

Plugins.get = async function (id) {
	const url = (nconf.get('registry') || 'https://packages.nodebb.org') + '/api/v1/plugins/' + id;
	const body = await requestAsync(url);

	let normalised = await Plugins.normalise([body ? body.payload : {}]);
	normalised = normalised.filter(plugin => plugin.id === id);
	return normalised.length ? normalised[0] : undefined;
};

Plugins.list = async function (matching) {
	if (matching === undefined) {
		matching = true;
	}
	const version = require(path.join(nconf.get('base_dir'), 'package.json')).version;
	const url = (nconf.get('registry') || 'https://packages.nodebb.org') + '/api/v1/plugins' + (matching !== false ? '?version=' + version : '');
	try {
		const body = await requestAsync(url);
		return await Plugins.normalise(body);
	} catch (err) {
		winston.error('Error loading ' + url, err);
		return await Plugins.normalise([]);
	}
};

Plugins.normalise = async function (apiReturn) {
	const themeNamePattern = /^(@.*?\/)?nodebb-theme-.*$/;
	const pluginMap = {};
	const dependencies = require(path.join(nconf.get('base_dir'), 'package.json')).dependencies;
	apiReturn = Array.isArray(apiReturn) ? apiReturn : [];
	apiReturn.forEach(function (packageData) {
		packageData.id = packageData.name;
		packageData.installed = false;
		packageData.active = false;
		packageData.url = packageData.url || (packageData.repository ? packageData.repository.url : '');
		pluginMap[packageData.name] = packageData;
	});

	let installedPlugins = await Plugins.showInstalled();
	installedPlugins = installedPlugins.filter(plugin => plugin && !plugin.system);

	installedPlugins.forEach(function (plugin) {
		// If it errored out because a package.json or plugin.json couldn't be read, no need to do this stuff
		if (plugin.error) {
			pluginMap[plugin.id] = pluginMap[plugin.id] || {};
			pluginMap[plugin.id].installed = true;
			pluginMap[plugin.id].error = true;
			return;
		}

		pluginMap[plugin.id] = pluginMap[plugin.id] || {};
		pluginMap[plugin.id].id = pluginMap[plugin.id].id || plugin.id;
		pluginMap[plugin.id].name = plugin.name || pluginMap[plugin.id].name;
		pluginMap[plugin.id].description = plugin.description;
		pluginMap[plugin.id].url = pluginMap[plugin.id].url || plugin.url;
		pluginMap[plugin.id].installed = true;
		pluginMap[plugin.id].isTheme = themeNamePattern.test(plugin.id);
		pluginMap[plugin.id].error = plugin.error || false;
		pluginMap[plugin.id].active = plugin.active;
		pluginMap[plugin.id].version = plugin.version;
		pluginMap[plugin.id].settingsRoute = plugin.settingsRoute;
		pluginMap[plugin.id].license = plugin.license;

		// If package.json defines a version to use, stick to that
		if (dependencies.hasOwnProperty(plugin.id) && semver.valid(dependencies[plugin.id])) {
			pluginMap[plugin.id].latest = dependencies[plugin.id];
		} else {
			pluginMap[plugin.id].latest = pluginMap[plugin.id].latest || plugin.version;
		}
		pluginMap[plugin.id].outdated = semver.gt(pluginMap[plugin.id].latest, pluginMap[plugin.id].version);
	});

	const pluginArray = [];

	for (var key in pluginMap) {
		if (pluginMap.hasOwnProperty(key)) {
			pluginArray.push(pluginMap[key]);
		}
	}

	pluginArray.sort(function (a, b) {
		if (a.name > b.name) {
			return 1;
		} else if (a.name < b.name) {
			return -1;
		}
		return 0;
	});

	return pluginArray;
};

Plugins.nodeModulesPath = path.join(__dirname, '../../node_modules');

Plugins.showInstalled = async function () {
	const dirs = await readdirAsync(Plugins.nodeModulesPath);

	let pluginPaths = await findNodeBBModules(dirs);
	pluginPaths = pluginPaths.map(dir => path.join(Plugins.nodeModulesPath, dir));

	async function load(file) {
		try {
			const pluginData = await Plugins.loadPluginInfo(file);
			const isActive = await Plugins.isActive(pluginData.name);
			delete pluginData.hooks;
			delete pluginData.library;
			pluginData.active = isActive;
			pluginData.installed = true;
			pluginData.error = false;
			return pluginData;
		} catch (err) {
			winston.error(err);
		}
	}
	const plugins = await Promise.all(pluginPaths.map(file => load(file)));
	return plugins.filter(Boolean);
};

async function findNodeBBModules(dirs) {
	const pluginNamePattern = /^(@.*?\/)?nodebb-(theme|plugin|widget|rewards)-.*$/;
	const pluginPaths = [];
	await async.each(dirs, function (dirname, next) {
		var dirPath = path.join(Plugins.nodeModulesPath, dirname);

		async.waterfall([
			function (cb) {
				fs.stat(dirPath, function (err, stats) {
					if (err && err.code !== 'ENOENT') {
						return cb(err);
					}
					if (err || !stats.isDirectory()) {
						return next();
					}

					if (pluginNamePattern.test(dirname)) {
						pluginPaths.push(dirname);
						return next();
					}

					if (dirname[0] !== '@') {
						return next();
					}
					fs.readdir(dirPath, cb);
				});
			},
			function (subdirs, cb) {
				async.each(subdirs, function (subdir, next) {
					if (!pluginNamePattern.test(subdir)) {
						return next();
					}

					var subdirPath = path.join(dirPath, subdir);
					fs.stat(subdirPath, function (err, stats) {
						if (err && err.code !== 'ENOENT') {
							return next(err);
						}

						if (err || !stats.isDirectory()) {
							return next();
						}

						pluginPaths.push(dirname + '/' + subdir);
						next();
					});
				}, cb);
			},
		], next);
	});
	return pluginPaths;
}

Plugins.async = require('../promisify')(Plugins);
