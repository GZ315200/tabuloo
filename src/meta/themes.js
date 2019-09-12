'use strict';

const path = require('path');
const nconf = require('nconf');
const winston = require('winston');
const _ = require('lodash');

const util = require('util');
const fs = require('fs');
const fsReaddir = util.promisify(fs.readdir);
const fsStat = util.promisify(fs.stat);
const fsReadfile = util.promisify(fs.readFile);


const file = require('../file');
const db = require('../database');
const Meta = require('../meta');
const events = require('../events');
const utils = require('../../public/src/utils');

const Themes = module.exports;

const themeNamePattern = /^(@.*?\/)?nodebb-theme-.*$/;

Themes.get = async () => {
	const themePath = nconf.get('themes_path');
	if (typeof themePath !== 'string') {
		return [];
	}

	let themes = await getThemes(themePath);
	themes = _.flatten(themes).filter(Boolean);
	themes = await Promise.all(themes.map(async (theme) => {
		const config = path.join(themePath, theme, 'theme.json');
		try {
			const file = await fsReadfile(config, 'utf8');
			const configObj = JSON.parse(file);

			// Minor adjustments for API output
			configObj.type = 'local';
			if (configObj.screenshot) {
				configObj.screenshot_url = nconf.get('relative_path') + '/css/previews/' + encodeURIComponent(configObj.id);
			} else {
				configObj.screenshot_url = nconf.get('relative_path') + '/assets/images/themes/default.png';
			}

			return configObj;
		} catch (err) {
			if (err.code === 'ENOENT') {
				return false;
			}

			winston.error('[themes] Unable to parse theme.json ' + theme);
			return false;
		}
	}));

	return themes.filter(Boolean);
};

async function getThemes(themePath) {
	let dirs = await fsReaddir(themePath);
	dirs = dirs.filter(dir => themeNamePattern.test(dir) || dir.startsWith('@'));
	return await Promise.all(dirs.map(async (dir) => {
		try {
			const dirpath = path.join(themePath, dir);
			const stat = await fsStat(dirpath);
			if (!stat.isDirectory()) {
				return false;
			}

			if (!dir.startsWith('@')) {
				return dir;
			}

			const themes = await getThemes(path.join(themePath, dir));
			return themes.map(theme => path.join(dir, theme));
		} catch (err) {
			if (err.code === 'ENOENT') {
				return false;
			}

			throw err;
		}
	}));
}

Themes.set = async (data) => {
	const themeData = {
		'theme:type': data.type,
		'theme:id': data.id,
		'theme:staticDir': '',
		'theme:templates': '',
		'theme:src': '',
	};

	switch (data.type) {
	case 'local': {
		const current = await Meta.configs.get('theme:id');
		var config = await fsReadfile(path.join(nconf.get('themes_path'), data.id, 'theme.json'), 'utf8');
		config = JSON.parse(config);
		await db.sortedSetRemove('plugins:active', current);
		await db.sortedSetAdd('plugins:active', 0, data.id);

		// Re-set the themes path (for when NodeBB is reloaded)
		Themes.setPath(config);

		themeData['theme:staticDir'] = config.staticDir ? config.staticDir : '';
		themeData['theme:templates'] = config.templates ? config.templates : '';
		themeData['theme:src'] = '';
		themeData.bootswatchSkin = '';

		await Meta.configs.setMultiple(themeData);
		await events.log({
			type: 'theme-set',
			uid: parseInt(data.uid, 10) || 0,
			ip: data.ip || '127.0.0.1',
			text: data.id,
		});

		Meta.reloadRequired = true;
		break;
	}
	case 'bootswatch':
		await Meta.configs.setMultiple({
			'theme:src': data.src,
			bootswatchSkin: data.id.toLowerCase(),
		});
		break;
	}
};

Themes.setupPaths = async () => {
	const data = await utils.promiseParallel({
		themesData: Themes.get(),
		currentThemeId: Meta.configs.get('theme:id'),
	});

	var themeId = data.currentThemeId || 'nodebb-theme-persona';

	if (process.env.NODE_ENV === 'development') {
		winston.info('[themes] Using theme ' + themeId);
	}

	var themeObj = data.themesData.find(function (themeObj) {
		return themeObj.id === themeId;
	});

	if (!themeObj) {
		throw new Error('[[error:theme-not-found]]');
	}

	Themes.setPath(themeObj);
};

Themes.setPath = function (themeObj) {
	// Theme's templates path
	var themePath = nconf.get('base_templates_path');
	var fallback = path.join(nconf.get('themes_path'), themeObj.id, 'templates');

	if (themeObj.templates) {
		themePath = path.join(nconf.get('themes_path'), themeObj.id, themeObj.templates);
	} else if (file.existsSync(fallback)) {
		themePath = fallback;
	}

	nconf.set('theme_templates_path', themePath);
	nconf.set('theme_config', path.join(nconf.get('themes_path'), themeObj.id, 'theme.json'));
};
