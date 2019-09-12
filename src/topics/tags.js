
'use strict';

var async = require('async');
var validator = require('validator');

var _ = require('lodash');
var db = require('../database');
var meta = require('../meta');
var categories = require('../categories');
var plugins = require('../plugins');
var utils = require('../utils');
var batch = require('../batch');

module.exports = function (Topics) {
	Topics.createTags = async function (tags, tid, timestamp) {
		if (!Array.isArray(tags) || !tags.length) {
			return;
		}
		const result = await plugins.fireHook('filter:tags.filter', { tags: tags, tid: tid });
		tags = _.uniq(result.tags).slice(0, meta.config.maximumTagsPerTopic || 5)
			.map(tag => utils.cleanUpTag(tag, meta.config.maximumTagLength))
			.filter(tag => tag && tag.length >= (meta.config.minimumTagLength || 3));

		tags = await filterCategoryTags(tags, tid);
		await Promise.all([
			db.setAdd('topic:' + tid + ':tags', tags),
			db.sortedSetsAdd(tags.map(tag => 'tag:' + tag + ':topics'), timestamp, tid),
		]);

		await Promise.all(tags.map(tag => updateTagCount(tag)));
	};

	async function filterCategoryTags(tags, tid) {
		const cid = await Topics.getTopicField(tid, 'cid');
		const tagWhitelist = await categories.getTagWhitelist([cid]);
		if (!Array.isArray(tagWhitelist[0]) || !tagWhitelist[0].length) {
			return tags;
		}
		const whitelistSet = new Set(tagWhitelist[0]);
		return tags.filter(tag => whitelistSet.has(tag));
	}

	Topics.createEmptyTag = async function (tag) {
		if (!tag) {
			throw new Error('[[error:invalid-tag]]');
		}

		tag = utils.cleanUpTag(tag, meta.config.maximumTagLength);
		if (tag.length < (meta.config.minimumTagLength || 3)) {
			throw new Error('[[error:tag-too-short]]');
		}
		const isMember = await db.isSortedSetMember('tags:topic:count', tag);
		if (!isMember) {
			await db.sortedSetAdd('tags:topic:count', 0, tag);
		}
	};

	Topics.updateTags = async function (data) {
		await async.eachSeries(data, async function (tagData) {
			await db.setObject('tag:' + tagData.value, {
				color: tagData.color,
				bgColor: tagData.bgColor,
			});
		});
	};

	Topics.renameTags = async function (data) {
		await async.eachSeries(data, async function (tagData) {
			await renameTag(tagData.value, tagData.newName);
		});
	};

	async function renameTag(tag, newTagName) {
		if (!newTagName || tag === newTagName) {
			return;
		}
		await Topics.createEmptyTag(newTagName);
		await batch.processSortedSet('tag:' + tag + ':topics', async function (tids) {
			const scores = await db.sortedSetScores('tag:' + tag + ':topics', tids);
			await db.sortedSetAdd('tag:' + newTagName + ':topics', scores, tids);
			const keys = tids.map(tid => 'topic:' + tid + ':tags');
			await db.sortedSetRemove('tag:' + tag + ':topics', tids);
			await db.setsRemove(keys, tag);
			await db.setsAdd(keys, newTagName);
		}, {});
		await Topics.deleteTag(tag);
		await updateTagCount(newTagName);
	}

	async function updateTagCount(tag) {
		const count = await Topics.getTagTopicCount(tag);
		await db.sortedSetAdd('tags:topic:count', count || 0, tag);
	}

	Topics.getTagTids = async function (tag, start, stop) {
		return await db.getSortedSetRevRange('tag:' + tag + ':topics', start, stop);
	};

	Topics.getTagTopicCount = async function (tag) {
		return await db.sortedSetCard('tag:' + tag + ':topics');
	};

	Topics.deleteTags = async function (tags) {
		if (!Array.isArray(tags) || !tags.length) {
			return;
		}
		await removeTagsFromTopics(tags);
		const keys = tags.map(tag => 'tag:' + tag + ':topics');
		await db.deleteAll(keys);
		await db.sortedSetRemove('tags:topic:count', tags);
		await db.deleteAll(tags.map(tag => 'tag:' + tag));
	};

	async function removeTagsFromTopics(tags) {
		await async.eachLimit(tags, 50, async function (tag) {
			const tids = await db.getSortedSetRange('tag:' + tag + ':topics', 0, -1);
			if (!tids.length) {
				return;
			}
			const keys = tids.map(tid => 'topic:' + tid + ':tags');
			await db.setsRemove(keys, tag);
		});
	}

	Topics.deleteTag = async function (tag) {
		await Topics.deleteTags([tag]);
	};

	Topics.getTags = async function (start, stop) {
		const tags = await db.getSortedSetRevRangeWithScores('tags:topic:count', start, stop);
		const payload = await plugins.fireHook('filter:tags.getAll', {
			tags: tags,
		});
		return await Topics.getTagData(payload.tags);
	};

	Topics.getTagData = async function (tags) {
		if (!tags.length) {
			return [];
		}
		const tagData = await db.getObjects(tags.map(tag => 'tag:' + tag.value));
		tags.forEach(function (tag, index) {
			tag.valueEscaped = validator.escape(String(tag.value));
			tag.color = tagData[index] ? tagData[index].color : '';
			tag.bgColor = tagData[index] ? tagData[index].bgColor : '';
		});
		return tags;
	};

	Topics.getTopicTags = async function (tid) {
		return await db.getSetMembers('topic:' + tid + ':tags');
	};

	Topics.getTopicsTags = async function (tids) {
		const keys = tids.map(tid => 'topic:' + tid + ':tags');
		return await db.getSetsMembers(keys);
	};

	Topics.getTopicTagsObjects = async function (tid) {
		const data = await Topics.getTopicsTagsObjects([tid]);
		return Array.isArray(data) && data.length ? data[0] : [];
	};

	Topics.getTopicsTagsObjects = async function (tids) {
		const topicTags = await Topics.getTopicsTags(tids);
		const uniqueTopicTags = _.uniq(_.flatten(topicTags));

		var tags = uniqueTopicTags.map(tag => ({ value: tag }));

		const [tagData, counts] = await Promise.all([
			Topics.getTagData(tags),
			db.sortedSetScores('tags:topic:count', uniqueTopicTags),
		]);

		tagData.forEach(function (tag, index) {
			tag.score = counts[index] ? counts[index] : 0;
		});

		var tagDataMap = _.zipObject(uniqueTopicTags, tagData);

		topicTags.forEach(function (tags, index) {
			if (Array.isArray(tags)) {
				topicTags[index] = tags.map(tag => tagDataMap[tag]);
				topicTags[index].sort((tag1, tag2) => tag2.score - tag1.score);
			}
		});

		return topicTags;
	};

	Topics.updateTopicTags = async function (tid, tags) {
		await Topics.deleteTopicTags(tid);
		const timestamp = await Topics.getTopicField(tid, 'timestamp');
		await Topics.createTags(tags, tid, timestamp);
	};

	Topics.deleteTopicTags = async function (tid) {
		const tags = await Topics.getTopicTags(tid);
		await db.delete('topic:' + tid + ':tags');
		const sets = tags.map(tag => 'tag:' + tag + ':topics');
		await db.sortedSetsRemove(sets, tid);
		await Promise.all(tags.map(tag => updateTagCount(tag)));
	};

	Topics.searchTags = async function (data) {
		if (!data || !data.query) {
			return [];
		}
		let result;
		if (plugins.hasListeners('filter:topics.searchTags')) {
			result = await plugins.fireHook('filter:topics.searchTags', { data: data });
		} else {
			result = await findMatches(data.query, 0);
		}
		result = await plugins.fireHook('filter:tags.search', { data: data, matches: result.matches });
		return result.matches;
	};

	Topics.autocompleteTags = async function (data) {
		if (!data || !data.query) {
			return [];
		}
		let result;
		if (plugins.hasListeners('filter:topics.autocompleteTags')) {
			result = await plugins.fireHook('filter:topics.autocompleteTags', { data: data });
		} else {
			result = await findMatches(data.query, data.cid);
		}
		return result.matches;
	};

	async function findMatches(query, cid) {
		let tagWhitelist = [];
		if (parseInt(cid, 10)) {
			tagWhitelist = await categories.getTagWhitelist([cid]);
		}
		let tags = [];
		if (Array.isArray(tagWhitelist[0]) && tagWhitelist[0].length) {
			tags = tagWhitelist[0];
		} else {
			tags = await db.getSortedSetRevRange('tags:topic:count', 0, -1);
		}

		query = query.toLowerCase();

		var matches = [];
		for (var i = 0; i < tags.length; i += 1) {
			if (tags[i].toLowerCase().startsWith(query)) {
				matches.push(tags[i]);
				if (matches.length > 19) {
					break;
				}
			}
		}

		matches.sort();
		return { matches: matches };
	}

	Topics.searchAndLoadTags = async function (data) {
		var searchResult = {
			tags: [],
			matchCount: 0,
			pageCount: 1,
		};

		if (!data || !data.query || !data.query.length) {
			return searchResult;
		}
		const tags = await Topics.searchTags(data);
		const [counts, tagData] = await Promise.all([
			db.sortedSetScores('tags:topic:count', tags),
			Topics.getTagData(tags.map(tag => ({ value: tag }))),
		]);
		tagData.forEach(function (tag, index) {
			tag.score = counts[index];
		});
		tagData.sort((a, b) => b.score - a.score);
		searchResult.tags = tagData;
		searchResult.matchCount = tagData.length;
		searchResult.pageCount = 1;
		return searchResult;
	};

	Topics.getRelatedTopics = async function (topicData, uid) {
		if (plugins.hasListeners('filter:topic.getRelatedTopics')) {
			return await plugins.fireHook('filter:topic.getRelatedTopics', { topic: topicData, uid: uid });
		}

		var maximumTopics = meta.config.maximumRelatedTopics;
		if (maximumTopics === 0 || !topicData.tags || !topicData.tags.length) {
			return [];
		}

		maximumTopics = maximumTopics || 5;
		let tids = await async.map(topicData.tags, async function (tag) {
			return await Topics.getTagTids(tag.value, 0, 5);
		});
		tids = _.shuffle(_.uniq(_.flatten(tids))).slice(0, maximumTopics);
		const topics = await Topics.getTopics(tids, uid);
		return topics.filter(t => t && !t.deleted && parseInt(t.uid, 10) !== parseInt(uid, 10));
	};
};
