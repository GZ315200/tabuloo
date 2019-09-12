'use strict';

var async = require('async');

var db = require('../database');
var meta = require('../meta');
var utils = require('../utils');
var translator = require('../translator');
var plugins = require('../plugins');
var cache = require('../cache');

module.exports = function (Categories) {
	Categories.update = async function (modified) {
		var cids = Object.keys(modified);
		await Promise.all(cids.map(cid => updateCategory(cid, modified[cid])));
		return cids;
	};

	async function updateCategory(cid, modifiedFields) {
		const exists = await Categories.exists(cid);
		if (!exists) {
			return;
		}

		if (modifiedFields.hasOwnProperty('name')) {
			const translated = await translator.translate(modifiedFields.name);
			modifiedFields.slug = cid + '/' + utils.slugify(translated);
		}
		const result = await plugins.fireHook('filter:category.update', { cid: cid, category: modifiedFields });

		const category = result.category;
		var fields = Object.keys(category);
		// move parent to front, so its updated first
		var parentCidIndex = fields.indexOf('parentCid');
		if (parentCidIndex !== -1 && fields.length > 1) {
			fields.splice(0, 0, fields.splice(parentCidIndex, 1)[0]);
		}

		await async.eachSeries(fields, async function (key) {
			await updateCategoryField(cid, key, category[key]);
		});
		plugins.fireHook('action:category.update', { cid: cid, modified: category });
	}

	async function updateCategoryField(cid, key, value) {
		if (key === 'parentCid') {
			return await updateParent(cid, value);
		} else if (key === 'tagWhitelist') {
			return await updateTagWhitelist(cid, value);
		}
		await db.setObjectField('category:' + cid, key, value);
		if (key === 'order') {
			await updateOrder(cid, value);
		} else if (key === 'description') {
			await Categories.parseDescription(cid, value);
		}
	}

	async function updateParent(cid, newParent) {
		newParent = parseInt(newParent, 10) || 0;
		if (parseInt(cid, 10) === newParent) {
			throw new Error('[[error:cant-set-self-as-parent]]');
		}
		const childrenCids = await Categories.getChildrenCids(cid);
		if (childrenCids.includes(newParent)) {
			throw new Error('[[error:cant-set-child-as-parent]]');
		}
		const oldParent = await Categories.getCategoryField(cid, 'parentCid');
		await Promise.all([
			db.sortedSetRemove('cid:' + oldParent + ':children', cid),
			db.sortedSetAdd('cid:' + newParent + ':children', cid, cid),
			db.setObjectField('category:' + cid, 'parentCid', newParent),
		]);

		cache.del(['cid:' + oldParent + ':children', 'cid:' + newParent + ':children']);
	}

	async function updateTagWhitelist(cid, tags) {
		tags = tags.split(',').map(tag => utils.cleanUpTag(tag, meta.config.maximumTagLength))
			.filter(Boolean);
		await db.delete('cid:' + cid + ':tag:whitelist');
		const scores = tags.map((tag, index) => index);
		await db.sortedSetAdd('cid:' + cid + ':tag:whitelist', scores, tags);
		cache.del('cid:' + cid + ':tag:whitelist');
	}

	async function updateOrder(cid, order) {
		const parentCid = await Categories.getCategoryField(cid, 'parentCid');
		await db.sortedSetsAdd(['categories:cid', 'cid:' + parentCid + ':children'], order, cid);
		cache.del(['categories:cid', 'cid:' + parentCid + ':children']);
	}

	Categories.parseDescription = async function (cid, description) {
		const parsedDescription = await plugins.fireHook('filter:parse.raw', description);
		await Categories.setCategoryField(cid, 'descriptionParsed', parsedDescription);
	};
};
