'use strict';

const nconf = require('nconf');
const winston = require('winston');

const plugins = require('../plugins');
const Meta = require('../meta');
const utils = require('../utils');

const Tags = module.exports;

Tags.parse = async (req, data, meta, link) => {
	// Meta tags
	const defaultTags = [{
		name: 'viewport',
		content: 'width=device-width, initial-scale=1.0',
	}, {
		name: 'content-type',
		content: 'text/html; charset=UTF-8',
		noEscape: true,
	}, {
		name: 'apple-mobile-web-app-capable',
		content: 'yes',
	}, {
		name: 'mobile-web-app-capable',
		content: 'yes',
	}, {
		property: 'og:site_name',
		content: Meta.config.title || 'NodeBB',
	}, {
		name: 'msapplication-badge',
		content: 'frequency=30; polling-uri=' + nconf.get('url') + '/sitemap.xml',
		noEscape: true,
	}];

	if (Meta.config.keywords) {
		defaultTags.push({
			name: 'keywords',
			content: Meta.config.keywords,
		});
	}

	if (Meta.config['brand:logo']) {
		defaultTags.push({
			name: 'msapplication-square150x150logo',
			content: Meta.config['brand:logo'],
			noEscape: true,
		});
	}

	// Link Tags
	var defaultLinks = [{
		rel: 'icon',
		type: 'image/x-icon',
		href: nconf.get('relative_path') + nconf.get('upload_url') + '/system/favicon.ico' + (Meta.config['cache-buster'] ? '?' + Meta.config['cache-buster'] : ''),
	}, {
		rel: 'manifest',
		href: nconf.get('relative_path') + '/manifest.json',
	}];

	if (plugins.hasListeners('filter:search.query')) {
		defaultLinks.push({
			rel: 'search',
			type: 'application/opensearchdescription+xml',
			title: utils.escapeHTML(String(Meta.config.title || Meta.config.browserTitle || 'NodeBB')),
			href: nconf.get('relative_path') + '/osd.xml',
		});
	}

	// Touch icons for mobile-devices
	if (Meta.config['brand:touchIcon']) {
		defaultLinks.push({
			rel: 'apple-touch-icon',
			href: nconf.get('relative_path') + nconf.get('upload_url') + '/system/touchicon-orig.png',
		}, {
			rel: 'icon',
			sizes: '36x36',
			href: nconf.get('relative_path') + nconf.get('upload_url') + '/system/touchicon-36.png',
		}, {
			rel: 'icon',
			sizes: '48x48',
			href: nconf.get('relative_path') + nconf.get('upload_url') + '/system/touchicon-48.png',
		}, {
			rel: 'icon',
			sizes: '72x72',
			href: nconf.get('relative_path') + nconf.get('upload_url') + '/system/touchicon-72.png',
		}, {
			rel: 'icon',
			sizes: '96x96',
			href: nconf.get('relative_path') + nconf.get('upload_url') + '/system/touchicon-96.png',
		}, {
			rel: 'icon',
			sizes: '144x144',
			href: nconf.get('relative_path') + nconf.get('upload_url') + '/system/touchicon-144.png',
		}, {
			rel: 'icon',
			sizes: '192x192',
			href: nconf.get('relative_path') + nconf.get('upload_url') + '/system/touchicon-192.png',
		});
	}

	const results = await utils.promiseParallel({
		tags: plugins.fireHook('filter:meta.getMetaTags', { req: req, data: data, tags: defaultTags }),
		links: plugins.fireHook('filter:meta.getLinkTags', { req: req, data: data, links: defaultLinks }),
	});

	meta = results.tags.tags.concat(meta || []).map(function (tag) {
		if (!tag || typeof tag.content !== 'string') {
			winston.warn('Invalid meta tag. ', tag);
			return tag;
		}

		if (!tag.noEscape) {
			tag.content = utils.escapeHTML(String(tag.content));
		}

		return tag;
	});

	addSiteOGImage(meta);

	addIfNotExists(meta, 'property', 'og:title', Meta.config.title || 'NodeBB');
	var ogUrl = nconf.get('url') + (req.originalUrl !== '/' ? stripRelativePath(req.originalUrl) : '');
	addIfNotExists(meta, 'property', 'og:url', ogUrl);
	addIfNotExists(meta, 'name', 'description', Meta.config.description);
	addIfNotExists(meta, 'property', 'og:description', Meta.config.description);

	link = results.links.links.concat(link || []);

	return {
		meta: meta,
		link: link,
	};
};

function addIfNotExists(meta, keyName, tagName, value) {
	var exists = false;
	meta.forEach(function (tag) {
		if (tag[keyName] === tagName) {
			exists = true;
		}
	});

	if (!exists && value) {
		var data = {
			content: utils.escapeHTML(String(value)),
		};
		data[keyName] = tagName;
		meta.push(data);
	}
}

function stripRelativePath(url) {
	if (url.startsWith(nconf.get('relative_path'))) {
		return url.slice(nconf.get('relative_path').length);
	}

	return url;
}

function addSiteOGImage(meta) {
	const key = Meta.config['og:image'] ? 'og:image' : 'brand:logo';
	var ogImage = stripRelativePath(Meta.config[key] || '');
	if (ogImage && !ogImage.startsWith('http')) {
		ogImage = nconf.get('url') + ogImage;
	}

	if (ogImage) {
		meta.push({
			property: 'og:image',
			content: ogImage,
			noEscape: true,
		}, {
			property: 'og:image:url',
			content: ogImage,
			noEscape: true,
		});

		if (Meta.config[key + ':width'] && Meta.config[key + ':height']) {
			meta.push({
				property: 'og:image:width',
				content: String(Meta.config[key + ':width']),
			}, {
				property: 'og:image:height',
				content: String(Meta.config[key + ':height']),
			});
		}
	} else {
		// Push fallback logo
		meta.push({
			property: 'og:image',
			content: nconf.get('url') + '/assets/logo.png',
			noEscape: true,
		}, {
			property: 'og:image:url',
			content: nconf.get('url') + '/assets/logo.png',
			noEscape: true,
		}, {
			property: 'og:image:width',
			content: '128',
		}, {
			property: 'og:image:height',
			content: '128',
		});
	}
}
