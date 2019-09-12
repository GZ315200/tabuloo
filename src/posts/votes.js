'use strict';

var meta = require('../meta');
var db = require('../database');
var user = require('../user');
var topics = require('../topics');
var plugins = require('../plugins');
var privileges = require('../privileges');

module.exports = function (Posts) {
	var votesInProgress = {};

	Posts.upvote = async function (pid, uid) {
		if (meta.config['reputation:disabled']) {
			throw new Error('[[error:reputation-system-disabled]]');
		}
		const canUpvote = await privileges.posts.can('posts:upvote', pid, uid);
		if (!canUpvote) {
			throw new Error('[[error:no-privileges]]');
		}

		if (voteInProgress(pid, uid)) {
			throw new Error('[[error:already-voting-for-this-post]]');
		}
		putVoteInProgress(pid, uid);

		try {
			const data = await toggleVote('upvote', pid, uid);
			return data;
		} finally {
			clearVoteProgress(pid, uid);
		}
	};

	Posts.downvote = async function (pid, uid) {
		if (meta.config['reputation:disabled']) {
			throw new Error('[[error:reputation-system-disabled]]');
		}

		if (meta.config['downvote:disabled']) {
			throw new Error('[[error:downvoting-disabled]]');
		}
		const canDownvote = await privileges.posts.can('posts:downvote', pid, uid);
		if (!canDownvote) {
			throw new Error('[[error:no-privileges]]');
		}

		if (voteInProgress(pid, uid)) {
			throw new Error('[[error:already-voting-for-this-post]]');
		}

		putVoteInProgress(pid, uid);
		try {
			const data = toggleVote('downvote', pid, uid);
			return data;
		} finally {
			clearVoteProgress(pid, uid);
		}
	};

	Posts.unvote = async function (pid, uid) {
		if (voteInProgress(pid, uid)) {
			throw new Error('[[error:already-voting-for-this-post]]');
		}

		putVoteInProgress(pid, uid);
		try {
			const data = await unvote(pid, uid, 'unvote');
			return data;
		} finally {
			clearVoteProgress(pid, uid);
		}
	};

	Posts.hasVoted = async function (pid, uid) {
		if (parseInt(uid, 10) <= 0) {
			return { upvoted: false, downvoted: false };
		}
		const hasVoted = await db.isMemberOfSets(['pid:' + pid + ':upvote', 'pid:' + pid + ':downvote'], uid);
		return { upvoted: hasVoted[0], downvoted: hasVoted[1] };
	};

	Posts.getVoteStatusByPostIDs = async function (pids, uid) {
		if (parseInt(uid, 10) <= 0) {
			const data = pids.map(() => false);
			return { upvotes: data, downvotes: data };
		}
		var upvoteSets = [];
		var downvoteSets = [];

		for (var i = 0; i < pids.length; i += 1) {
			upvoteSets.push('pid:' + pids[i] + ':upvote');
			downvoteSets.push('pid:' + pids[i] + ':downvote');
		}
		const data = await db.isMemberOfSets(upvoteSets.concat(downvoteSets), uid);
		return {
			upvotes: data.slice(0, pids.length),
			downvotes: data.slice(pids.length, pids.length * 2),
		};
	};

	Posts.getUpvotedUidsByPids = async function (pids) {
		return await db.getSetsMembers(pids.map(pid => 'pid:' + pid + ':upvote'));
	};

	function voteInProgress(pid, uid) {
		return Array.isArray(votesInProgress[uid]) && votesInProgress[uid].includes(parseInt(pid, 10));
	}

	function putVoteInProgress(pid, uid) {
		votesInProgress[uid] = votesInProgress[uid] || [];
		votesInProgress[uid].push(parseInt(pid, 10));
	}

	function clearVoteProgress(pid, uid) {
		if (Array.isArray(votesInProgress[uid])) {
			var index = votesInProgress[uid].indexOf(parseInt(pid, 10));
			if (index !== -1) {
				votesInProgress[uid].splice(index, 1);
			}
		}
	}

	async function toggleVote(type, pid, uid) {
		await unvote(pid, uid, type);
		return await vote(type, false, pid, uid);
	}

	async function unvote(pid, uid, command) {
		const [owner, voteStatus, reputation] = await Promise.all([
			Posts.getPostField(pid, 'uid'),
			Posts.hasVoted(pid, uid),
			user.getUserField(uid, 'reputation'),
		]);

		if (parseInt(uid, 10) === parseInt(owner, 10)) {
			throw new Error('[[error:self-vote]]');
		}

		if (command === 'downvote' && reputation < meta.config['min:rep:downvote']) {
			throw new Error('[[error:not-enough-reputation-to-downvote]]');
		}

		var hook;
		var current = voteStatus.upvoted ? 'upvote' : 'downvote';

		if ((voteStatus.upvoted && command === 'downvote') || (voteStatus.downvoted && command === 'upvote')) {	// e.g. User *has* upvoted, and clicks downvote
			hook = command;
		} else if (voteStatus.upvoted || voteStatus.downvoted) {	// e.g. User *has* upvoted, clicks upvote (so we "unvote")
			hook = 'unvote';
		} else {	// e.g. User *has not* voted, clicks upvote
			hook = command;
			current = 'unvote';
		}

		plugins.fireHook('action:post.' + hook, {
			pid: pid,
			uid: uid,
			owner: owner,
			current: current,
		});

		if (!voteStatus || (!voteStatus.upvoted && !voteStatus.downvoted)) {
			return;
		}

		return await vote(voteStatus.upvoted ? 'downvote' : 'upvote', true, pid, uid);
	}

	async function vote(type, unvote, pid, uid) {
		uid = parseInt(uid, 10);
		if (uid <= 0) {
			throw new Error('[[error:not-logged-in]]');
		}
		const postData = await Posts.getPostFields(pid, ['pid', 'uid', 'tid']);

		var now = Date.now();

		if (type === 'upvote' && !unvote) {
			db.sortedSetAdd('uid:' + uid + ':upvote', now, pid);
		} else {
			db.sortedSetRemove('uid:' + uid + ':upvote', pid);
		}

		if (type === 'upvote' || unvote) {
			db.sortedSetRemove('uid:' + uid + ':downvote', pid);
		} else {
			db.sortedSetAdd('uid:' + uid + ':downvote', now, pid);
		}

		const newReputation = await user[type === 'upvote' ? 'incrementUserFieldBy' : 'decrementUserFieldBy'](postData.uid, 'reputation', 1);
		if (parseInt(postData.uid, 10)) {
			db.sortedSetAdd('users:reputation', newReputation, postData.uid);
		}

		await adjustPostVotes(postData, uid, type, unvote);

		return {
			user: {
				reputation: newReputation,
			},
			fromuid: uid,
			post: postData,
			upvote: type === 'upvote' && !unvote,
			downvote: type === 'downvote' && !unvote,
		};
	}

	async function adjustPostVotes(postData, uid, type, unvote) {
		var notType = (type === 'upvote' ? 'downvote' : 'upvote');
		if (unvote) {
			await db.setRemove('pid:' + postData.pid + ':' + type, uid);
		} else {
			await db.setAdd('pid:' + postData.pid + ':' + type, uid);
		}
		await db.setRemove('pid:' + postData.pid + ':' + notType, uid);

		const [upvotes, downvotes] = await Promise.all([
			db.setCount('pid:' + postData.pid + ':upvote'),
			db.setCount('pid:' + postData.pid + ':downvote'),
		]);
		postData.upvotes = upvotes;
		postData.downvotes = downvotes;
		postData.votes = postData.upvotes - postData.downvotes;
		await Posts.updatePostVoteCount(postData);
	}

	Posts.updatePostVoteCount = async function (postData) {
		if (!postData || !postData.pid || !postData.tid) {
			return;
		}
		await Promise.all([
			updateTopicVoteCount(postData),
			db.sortedSetAdd('posts:votes', postData.votes, postData.pid),
			Posts.setPostFields(postData.pid, {
				upvotes: postData.upvotes,
				downvotes: postData.downvotes,
			}),
		]);
	};

	async function updateTopicVoteCount(postData) {
		const topicData = await topics.getTopicFields(postData.tid, ['mainPid', 'cid', 'pinned']);

		if (postData.uid) {
			if (postData.votes > 0) {
				await db.sortedSetAdd('cid:' + topicData.cid + ':uid:' + postData.uid + ':pids:votes', postData.votes, postData.pid);
			} else {
				await db.sortedSetRemove('cid:' + topicData.cid + ':uid:' + postData.uid + ':pids:votes', postData.pid);
			}
		}

		if (parseInt(topicData.mainPid, 10) !== parseInt(postData.pid, 10)) {
			return await db.sortedSetAdd('tid:' + postData.tid + ':posts:votes', postData.votes, postData.pid);
		}
		const promises = [
			topics.setTopicFields(postData.tid, {
				upvotes: postData.upvotes,
				downvotes: postData.downvotes,
			}),
			db.sortedSetAdd('topics:votes', postData.votes, postData.tid),
		];
		if (!topicData.pinned) {
			promises.push(db.sortedSetAdd('cid:' + topicData.cid + ':tids:votes', postData.votes, postData.tid));
		}
		await Promise.all(promises);
	}
};
