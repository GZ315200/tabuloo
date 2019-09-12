'use strict';

const fs = require('fs');
const path = require('path');

const util = require('util');
const readFileAsync = util.promisify(fs.readFile);

const Languages = module.exports;
const languagesPath = path.join(__dirname, '../build/public/language');

const files = fs.readdirSync(path.join(__dirname, '../public/vendor/jquery/timeago/locales'));
Languages.timeagoCodes = files.filter(f => f.startsWith('jquery.timeago')).map(f => f.split('.')[2]);

Languages.get = async function (language, namespace) {
	const data = await readFileAsync(path.join(languagesPath, language, namespace + '.json'), 'utf8');
	return JSON.parse(data) || {};
};

let codeCache = null;
Languages.listCodes = async function () {
	if (codeCache && codeCache.length) {
		return codeCache;
	}
	try {
		const file = await readFileAsync(path.join(languagesPath, 'metadata.json'), 'utf8');
		const parsed = JSON.parse(file);

		codeCache = parsed.languages;
		return parsed.languages;
	} catch (err) {
		if (err.code === 'ENOENT') {
			return [];
		}
		throw err;
	}
};

let listCache = null;
Languages.list = async function () {
	if (listCache && listCache.length) {
		return listCache;
	}

	const codes = await Languages.listCodes();

	let languages = await Promise.all(codes.map(async function (folder) {
		try {
			const configPath = path.join(languagesPath, folder, 'language.json');
			const file = await readFileAsync(configPath, 'utf8');
			const lang = JSON.parse(file);
			return lang;
		} catch (err) {
			if (err.code === 'ENOENT') {
				return;
			}
			throw err;
		}
	}));

	// filter out invalid ones
	languages = languages.filter(lang => lang && lang.code && lang.name && lang.dir);

	listCache = languages;
	return languages;
};

require('./promisify')(Languages);
