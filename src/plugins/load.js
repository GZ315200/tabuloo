'use strict';

const path = require('path');
const semver = require('semver');
const async = require('async');
const winston = require('winston');
const nconf = require('nconf');
const _ = require('lodash');

const meta = require('../meta');

module.exports = function (Plugins) {
	async function registerPluginAssets(pluginData, fields) {
		function add(dest, arr) {
			dest.push.apply(dest, arr || []);
		}

		const handlers = {
			staticDirs: function (next) {
				Plugins.data.getStaticDirectories(pluginData, next);
			},
			cssFiles: function (next) {
				Plugins.data.getFiles(pluginData, 'css', next);
			},
			lessFiles: function (next) {
				Plugins.data.getFiles(pluginData, 'less', next);
			},
			acpLessFiles: function (next) {
				Plugins.data.getFiles(pluginData, 'acpLess', next);
			},
			clientScripts: function (next) {
				Plugins.data.getScripts(pluginData, 'client', next);
			},
			acpScripts: function (next) {
				Plugins.data.getScripts(pluginData, 'acp', next);
			},
			modules: function (next) {
				Plugins.data.getModules(pluginData, next);
			},
			soundpack: function (next) {
				Plugins.data.getSoundpack(pluginData, next);
			},
			languageData: function (next) {
				Plugins.data.getLanguageData(pluginData, next);
			},
		};

		var methods = {};
		if (Array.isArray(fields)) {
			fields.forEach(function (field) {
				methods[field] = handlers[field];
			});
		} else {
			methods = handlers;
		}

		const results = await async.parallel(methods);

		Object.assign(Plugins.staticDirs, results.staticDirs || {});
		add(Plugins.cssFiles, results.cssFiles);
		add(Plugins.lessFiles, results.lessFiles);
		add(Plugins.acpLessFiles, results.acpLessFiles);
		add(Plugins.clientScripts, results.clientScripts);
		add(Plugins.acpScripts, results.acpScripts);
		Object.assign(meta.js.scripts.modules, results.modules || {});
		if (results.soundpack) {
			Plugins.soundpacks.push(results.soundpack);
		}
		if (results.languageData) {
			Plugins.languageData.languages = _.union(Plugins.languageData.languages, results.languageData.languages);
			Plugins.languageData.namespaces = _.union(Plugins.languageData.namespaces, results.languageData.namespaces);
		}
		Plugins.pluginsData[pluginData.id] = pluginData;
	}

	Plugins.prepareForBuild = async function (targets) {
		const map = {
			'plugin static dirs': ['staticDirs'],
			'requirejs modules': ['modules'],
			'client js bundle': ['clientScripts'],
			'admin js bundle': ['acpScripts'],
			'client side styles': ['cssFiles', 'lessFiles'],
			'admin control panel styles': ['cssFiles', 'lessFiles', 'acpLessFiles'],
			sounds: ['soundpack'],
			languages: ['languageData'],
		};

		const fields = _.uniq(_.flatMap(targets, target => map[target] || []));

		// clear old data before build
		fields.forEach((field) => {
			switch (field) {
			case 'clientScripts':
			case 'acpScripts':
			case 'cssFiles':
			case 'lessFiles':
			case 'acpLessFiles':
				Plugins[field].length = 0;
				break;
			case 'soundpack':
				Plugins.soundpacks.length = 0;
				break;
			case 'languageData':
				Plugins.languageData.languages = [];
				Plugins.languageData.namespaces = [];
				break;
			// do nothing for modules and staticDirs
			}
		});

		winston.verbose('[plugins] loading the following fields from plugin data: ' + fields.join(', '));
		const plugins = await Plugins.data.getActive();
		await Promise.all(plugins.map(p => registerPluginAssets(p, fields)));
	};

	const themeNamePattern = /(@.*?\/)?nodebb-theme-.*$/;

	Plugins.loadPlugin = async function (pluginPath) {
		let pluginData;
		try {
			pluginData = await Plugins.data.loadPluginInfo(pluginPath);
		} catch (err) {
			if (err.message === '[[error:parse-error]]') {
				return;
			}
			if (!themeNamePattern.test(pluginPath)) {
				throw err;
			}
			return;
		}
		checkVersion(pluginData);

		try {
			registerHooks(pluginData);
			await registerPluginAssets(pluginData, ['soundpack']);
		} catch (err) {
			winston.error(err.stack);
			winston.verbose('[plugins] Could not load plugin : ' + pluginData.id);
			return;
		}

		if (!pluginData.private) {
			Plugins.loadedPlugins.push({
				id: pluginData.id,
				version: pluginData.version,
			});
		}

		winston.verbose('[plugins] Loaded plugin: ' + pluginData.id);
	};

	function checkVersion(pluginData) {
		function add() {
			if (!Plugins.versionWarning.includes(pluginData.id)) {
				Plugins.versionWarning.push(pluginData.id);
			}
		}

		if (pluginData.nbbpm && pluginData.nbbpm.compatibility && semver.validRange(pluginData.nbbpm.compatibility)) {
			if (!semver.satisfies(nconf.get('version'), pluginData.nbbpm.compatibility)) {
				add();
			}
		} else {
			add();
		}
	}

	function registerHooks(pluginData) {
		if (!pluginData.library) {
			return;
		}

		const libraryPath = path.join(pluginData.path, pluginData.library);

		try {
			if (!Plugins.libraries[pluginData.id]) {
				Plugins.requireLibrary(pluginData.id, libraryPath);
			}

			if (Array.isArray(pluginData.hooks)) {
				pluginData.hooks.forEach(hook => Plugins.registerHook(pluginData.id, hook));
			}
		} catch (err) {
			winston.warn('[plugins] Unable to parse library for: ' + pluginData.id);
			throw err;
		}
	}
};
