'use strict';

const path = require('path');
const fs = require('fs');
const mkdirp = require('mkdirp');
const rimraf = require('rimraf');
const _ = require('lodash');

const util = require('util');
const mkdirpAsync = util.promisify(mkdirp);
const rimrafAsync = util.promisify(rimraf);
const writeFileAsync = util.promisify(fs.writeFile);
const readFileAsync = util.promisify(fs.readFile);

const file = require('../file');
const Plugins = require('../plugins');

const buildLanguagesPath = path.join(__dirname, '../../build/public/language');
const coreLanguagesPath = path.join(__dirname, '../../public/language');

async function getTranslationMetadata() {
	const paths = await file.walk(coreLanguagesPath);
	let languages = [];
	let namespaces = [];

	paths.forEach(function (p) {
		if (!p.endsWith('.json')) {
			return;
		}

		var rel = path.relative(coreLanguagesPath, p).split(/[/\\]/);
		var language = rel.shift().replace('_', '-').replace('@', '-x-');
		var namespace = rel.join('/').replace(/\.json$/, '');

		if (!language || !namespace) {
			return;
		}

		languages.push(language);
		namespaces.push(namespace);
	});


	languages = _.union(languages, Plugins.languageData.languages).sort().filter(Boolean);
	namespaces = _.union(namespaces, Plugins.languageData.namespaces).sort().filter(Boolean);

	// save a list of languages to `${buildLanguagesPath}/metadata.json`
	// avoids readdirs later on
	await mkdirpAsync(buildLanguagesPath);
	const result = {
		languages: languages,
		namespaces: namespaces,
	};
	await writeFileAsync(path.join(buildLanguagesPath, 'metadata.json'), JSON.stringify(result));
	return result;
}

async function writeLanguageFile(language, namespace, translations) {
	const dev = global.env === 'development';
	const filePath = path.join(buildLanguagesPath, language, namespace + '.json');

	await mkdirpAsync(path.dirname(filePath));
	await writeFileAsync(filePath, JSON.stringify(translations, null, dev ? 2 : 0));
}

// for each language and namespace combination,
// run through core and all plugins to generate
// a full translation hash
async function buildTranslations(ref) {
	const namespaces = ref.namespaces;
	const languages = ref.languages;
	const plugins = _.values(Plugins.pluginsData).filter(function (plugin) {
		return typeof plugin.languages === 'string';
	});

	const promises = [];

	namespaces.forEach(function (namespace) {
		languages.forEach(function (language) {
			promises.push(buildNamespaceLanguage(language, namespace, plugins));
		});
	});

	await Promise.all(promises);
}

async function buildNamespaceLanguage(lang, namespace, plugins) {
	const translations = {};
	// core first
	await assignFileToTranslations(translations, path.join(coreLanguagesPath, lang, namespace + '.json'));

	await Promise.all(plugins.map(pluginData => addPlugin(translations, pluginData, lang, namespace)));

	if (Object.keys(translations).length) {
		await writeLanguageFile(lang, namespace, translations);
	}
}

async function addPlugin(translations, pluginData, lang, namespace) {
	const pluginLanguages = path.join(__dirname, '../../node_modules/', pluginData.id, pluginData.languages);
	const defaultLang = pluginData.defaultLang || 'en-GB';

	// for each plugin, fallback in this order:
	//  1. correct language string (en-GB)
	//  2. old language string (en_GB)
	//  3. corrected plugin defaultLang (en-US)
	//  4. old plugin defaultLang (en_US)
	const langs = [
		defaultLang.replace('-', '_').replace('-x-', '@'),
		defaultLang.replace('_', '-').replace('@', '-x-'),
		lang.replace('-', '_').replace('-x-', '@'),
		lang,
	];

	for (const language of langs) {
		/* eslint-disable no-await-in-loop */
		await assignFileToTranslations(translations, path.join(pluginLanguages, language, namespace + '.json'));
	}
}

async function assignFileToTranslations(translations, path) {
	try {
		const fileData = await readFileAsync(path, 'utf8');
		Object.assign(translations, JSON.parse(fileData));
	} catch (err) {
		if (err.code !== 'ENOENT') {
			throw err;
		}
	}
}

exports.build = async function buildLanguages() {
	await rimrafAsync(buildLanguagesPath);
	const data = await getTranslationMetadata();
	await buildTranslations(data);
};
