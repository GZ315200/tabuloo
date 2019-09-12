'use strict';

const mkdirp = require('mkdirp');
const rimraf = require('rimraf');
const winston = require('winston');
const path = require('path');

const util = require('util');
const fs = require('fs');
const fsReadFile = util.promisify(fs.readFile);
const fsWriteFile = util.promisify(fs.writeFile);

const nconf = require('nconf');
const _ = require('lodash');
const Benchpress = require('benchpressjs');

const plugins = require('../plugins');
const file = require('../file');
const db = require('../database');

const viewsPath = nconf.get('views_dir');

const Templates = module.exports;

async function processImports(paths, templatePath, source) {
	var regex = /<!-- IMPORT (.+?) -->/;

	var matches = source.match(regex);

	if (!matches) {
		return source;
	}

	var partial = matches[1];
	if (paths[partial] && templatePath !== partial) {
		const partialSource = await fsReadFile(paths[partial], 'utf8');
		source = source.replace(regex, partialSource);
		return await processImports(paths, templatePath, source);
	}

	winston.warn('[meta/templates] Partial not loaded: ' + matches[1]);
	source = source.replace(regex, '');

	return await processImports(paths, templatePath, source);
}
Templates.processImports = processImports;

const themeNamePattern = /^(@.*?\/)?nodebb-theme-.*$/;

async function getTemplateDirs(activePlugins) {
	const pluginTemplates = activePlugins.map(function (id) {
		if (themeNamePattern.test(id)) {
			return nconf.get('theme_templates_path');
		}
		if (!plugins.pluginsData[id]) {
			return '';
		}
		return path.join(__dirname, '../../node_modules/', id, plugins.pluginsData[id].templates || 'templates');
	}).filter(Boolean);

	let themeConfig = require(nconf.get('theme_config'));
	let theme = themeConfig.baseTheme;

	let themePath;
	let themeTemplates = [];
	while (theme) {
		themePath = path.join(nconf.get('themes_path'), theme);
		themeConfig = require(path.join(themePath, 'theme.json'));

		themeTemplates.push(path.join(themePath, themeConfig.templates || 'templates'));
		theme = themeConfig.baseTheme;
	}

	themeTemplates.push(nconf.get('base_templates_path'));
	themeTemplates = _.uniq(themeTemplates.reverse());

	var coreTemplatesPath = nconf.get('core_templates_path');

	var templateDirs = _.uniq([coreTemplatesPath].concat(themeTemplates, pluginTemplates));

	templateDirs = await Promise.all(templateDirs.map(async path => (await file.exists(path) ? path : false)));
	return templateDirs.filter(Boolean);
}

async function getTemplateFiles(dirs) {
	const buckets = await Promise.all(dirs.map(async (dir) => {
		let files = await file.walk(dir);
		files = files.filter(function (path) {
			return path.endsWith('.tpl');
		}).map(function (file) {
			return {
				name: path.relative(dir, file).replace(/\\/g, '/'),
				path: file,
			};
		});
		return files;
	}));

	var dict = {};
	buckets.forEach(function (files) {
		files.forEach(function (file) {
			dict[file.name] = file.path;
		});
	});

	return dict;
}

async function compileTemplate(filename, source) {
	let paths = await file.walk(viewsPath);
	paths = _.fromPairs(paths.map(function (p) {
		var relative = path.relative(viewsPath, p).replace(/\\/g, '/');
		return [relative, p];
	}));

	source = await processImports(paths, filename, source);
	const compiled = await Benchpress.precompile(source, {
		minify: global.env !== 'development',
	});
	return await fsWriteFile(path.join(viewsPath, filename.replace(/\.tpl$/, '.js')), compiled);
}
Templates.compileTemplate = compileTemplate;

async function compile() {
	const _rimraf = util.promisify(rimraf);
	const _mkdirp = util.promisify(mkdirp);

	await _rimraf(viewsPath);
	await _mkdirp(viewsPath);

	let files = await db.getSortedSetRange('plugins:active', 0, -1);
	files = await getTemplateDirs(files);
	files = await getTemplateFiles(files);

	await Promise.all(Object.keys(files).map(async (name) => {
		const filePath = files[name];
		let imported = await fsReadFile(filePath, 'utf8');
		imported = await processImports(files, name, imported);

		await _mkdirp(path.join(viewsPath, path.dirname(name)));

		await fsWriteFile(path.join(viewsPath, name), imported);
		const compiled = await Benchpress.precompile(imported, { minify: global.env !== 'development' });
		await fsWriteFile(path.join(viewsPath, name.replace(/\.tpl$/, '.js')), compiled);
	}));

	winston.verbose('[meta/templates] Successfully compiled templates.');
}
Templates.compile = compile;
