
'use strict';

var db = require('../database');
var posts = require('../posts');
var notifications = require('../notifications');
var privileges = require('../privileges');
var plugins = require('../plugins');
var utils = require('../utils');

module.exports = function (Topics) {
	Topics.toggleFollow = async function (tid, uid) {
		const exists = await Topics.exists(tid);
		if (!exists) {
			throw new Error('[[error:no-topic]]');
		}
		const isFollowing = await Topics.isFollowing([tid], uid);
		if (isFollowing[0]) {
			await Topics.unfollow(tid, uid);
		} else {
			await Topics.follow(tid, uid);
		}
		return !isFollowing[0];
	};

	Topics.follow = async function (tid, uid) {
		await setWatching(follow, unignore, 'action:topic.follow', tid, uid);
	};

	Topics.unfollow = async function (tid, uid) {
		await setWatching(unfollow, unignore, 'action:topic.unfollow', tid, uid);
	};

	Topics.ignore = async function (tid, uid) {
		await setWatching(ignore, unfollow, 'action:topic.ignore', tid, uid);
	};

	async function setWatching(method1, method2, hook, tid, uid) {
		if (parseInt(uid, 10) <= 0) {
			return;
		}
		const exists = await Topics.exists(tid);
		if (!exists) {
			throw new Error('[[error:no-topic]]');
		}
		await method1(tid, uid);
		await method2(tid, uid);
		plugins.fireHook(hook, { uid: uid, tid: tid });
	}

	async function follow(tid, uid) {
		await addToSets('tid:' + tid + ':followers', 'uid:' + uid + ':followed_tids', tid, uid);
	}

	async function unfollow(tid, uid) {
		await removeFromSets('tid:' + tid + ':followers', 'uid:' + uid + ':followed_tids', tid, uid);
	}

	async function ignore(tid, uid) {
		await addToSets('tid:' + tid + ':ignorers', 'uid:' + uid + ':ignored_tids', tid, uid);
	}

	async function unignore(tid, uid) {
		await removeFromSets('tid:' + tid + ':ignorers', 'uid:' + uid + ':ignored_tids', tid, uid);
	}

	async function addToSets(set1, set2, tid, uid) {
		await db.setAdd(set1, uid);
		await db.sortedSetAdd(set2, Date.now(), tid);
	}

	async function removeFromSets(set1, set2, tid, uid) {
		await db.setRemove(set1, uid);
		await db.sortedSetRemove(set2, tid);
	}

	Topics.isFollowing = async function (tids, uid) {
		return await isIgnoringOrFollowing('followers', tids, uid);
	};

	Topics.isIgnoring = async function (tids, uid) {
		return await isIgnoringOrFollowing('ignorers', tids, uid);
	};

	Topics.getFollowData = async function (tids, uid) {
		if (!Array.isArray(tids)) {
			return;
		}
		if (parseInt(uid, 10) <= 0) {
			return tids.map(() => ({ following: false, ignoring: false }));
		}
		const keys = [];
		tids.forEach((tid) => {
			keys.push('tid:' + tid + ':followers', 'tid:' + tid + ':ignorers');
		});

		const data = await db.isMemberOfSets(keys, uid);

		const followData = [];
		for (let i = 0; i < data.length; i += 2) {
			followData.push({
				following: data[i],
				ignoring: data[i + 1],
			});
		}
		return followData;
	};

	async function isIgnoringOrFollowing(set, tids, uid) {
		if (!Array.isArray(tids)) {
			return;
		}
		if (parseInt(uid, 10) <= 0) {
			return tids.map(() => false);
		}
		var keys = tids.map(tid => 'tid:' + tid + ':' + set);
		return await db.isMemberOfSets(keys, uid);
	}

	Topics.getFollowers = async function (tid) {
		return await db.getSetMembers('tid:' + tid + ':followers');
	};

	Topics.getIgnorers = async function (tid) {
		return await db.getSetMembers('tid:' + tid + ':ignorers');
	};

	Topics.filterIgnoringUids = async function (tid, uids) {
		const isIgnoring = await db.isSetMembers('tid:' + tid + ':ignorers', uids);
		const readingUids = uids.filter((uid, index) => uid && !isIgnoring[index]);
		return readingUids;
	};

	Topics.filterWatchedTids = async function (tids, uid) {
		if (parseInt(uid, 10) <= 0) {
			return [];
		}
		const scores = await db.sortedSetScores('uid:' + uid + ':followed_tids', tids);
		tids = tids.filter((tid, index) => tid && !!scores[index]);
		return tids;
	};

	Topics.filterNotIgnoredTids = async function (tids, uid) {
		if (parseInt(uid, 10) <= 0) {
			return tids;
		}
		const scores = await db.sortedSetScores('uid:' + uid + ':ignored_tids', tids);
		tids = tids.filter((tid, index) => tid && !scores[index]);
		return tids;
	};

	Topics.notifyFollowers = async function (postData, exceptUid) {
		var title;
		var titleEscaped;

		let followers = await Topics.getFollowers(postData.topic.tid);

		var index = followers.indexOf(exceptUid.toString());
		if (index !== -1) {
			followers.splice(index, 1);
		}

		followers = await privileges.topics.filterUids('topics:read', postData.topic.tid, followers);

		if (!followers.length) {
			return;
		}
		title = postData.topic.title;

		if (title) {
			title = utils.decodeHTMLEntities(title);
			titleEscaped = title.replace(/%/g, '&#37;').replace(/,/g, '&#44;');
		}

		postData.content = posts.relativeToAbsolute(postData.content, posts.urlRegex);
		postData.content = posts.relativeToAbsolute(postData.content, posts.imgRegex);

		const notification = await notifications.create({
			type: 'new-reply',
			subject: title,
			bodyShort: '[[notifications:user_posted_to, ' + postData.user.username + ', ' + titleEscaped + ']]',
			bodyLong: postData.content,
			pid: postData.pid,
			path: '/post/' + postData.pid,
			nid: 'new_post:tid:' + postData.topic.tid + ':pid:' + postData.pid + ':uid:' + exceptUid,
			tid: postData.topic.tid,
			from: exceptUid,
			mergeId: 'notifications:user_posted_to|' + postData.topic.tid,
			topicTitle: title,
		});
		if (notification) {
			notifications.push(notification, followers);
		}
	};
};
