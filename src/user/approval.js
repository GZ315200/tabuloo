'use strict';

var async = require('async');
var validator = require('validator');

var db = require('../database');
var meta = require('../meta');
var emailer = require('../emailer');
var notifications = require('../notifications');
var groups = require('../groups');
var utils = require('../utils');
var plugins = require('../plugins');

module.exports = function (User) {
	User.addToApprovalQueue = async function (userData) {
		userData.userslug = utils.slugify(userData.username);
		await canQueue(userData);
		const hashedPassword = await User.hashPassword(userData.password);
		var data = {
			username: userData.username,
			email: userData.email,
			ip: userData.ip,
			hashedPassword: hashedPassword,
		};
		const results = await plugins.fireHook('filter:user.addToApprovalQueue', { data: data, userData: userData });
		await db.setObject('registration:queue:name:' + userData.username, results.data);
		await db.sortedSetAdd('registration:queue', Date.now(), userData.username);
		await sendNotificationToAdmins(userData.username);
	};

	async function canQueue(userData) {
		await User.isDataValid(userData);
		const usernames = await db.getSortedSetRange('registration:queue', 0, -1);
		if (usernames.includes(userData.username)) {
			throw new Error('[[error:username-taken]]');
		}
		const keys = usernames.filter(Boolean).map(username => 'registration:queue:name:' + username);
		const data = await db.getObjectsFields(keys, ['email']);
		const emails = data.map(data => data && data.email);
		if (emails.includes(userData.email)) {
			throw new Error('[[error:email-taken]]');
		}
	}

	async function sendNotificationToAdmins(username) {
		const notifObj = await notifications.create({
			type: 'new-register',
			bodyShort: '[[notifications:new_register, ' + username + ']]',
			nid: 'new_register:' + username,
			path: '/admin/manage/registration',
			mergeId: 'new_register',
		});
		await notifications.pushGroup(notifObj, 'administrators');
	}

	User.acceptRegistration = async function (username) {
		const userData = await db.getObject('registration:queue:name:' + username);
		if (!userData) {
			throw new Error('[[error:invalid-data]]');
		}

		const uid = await User.create(userData);
		await User.setUserField(uid, 'password', userData.hashedPassword);
		await removeFromQueue(username);
		await markNotificationRead(username);
		await plugins.fireHook('filter:register.complete', { uid: uid });
		await emailer.send('registration_accepted', uid, {
			username: username,
			subject: '[[email:welcome-to, ' + (meta.config.title || meta.config.browserTitle || 'NodeBB') + ']]',
			template: 'registration_accepted',
			uid: uid,
		});
		return uid;
	};

	async function markNotificationRead(username) {
		const nid = 'new_register:' + username;
		const uids = await groups.getMembers('administrators', 0, -1);
		const promises = uids.map(uid => notifications.markRead(nid, uid));
		await Promise.all(promises);
	}

	User.rejectRegistration = async function (username) {
		await removeFromQueue(username);
		await markNotificationRead(username);
	};

	async function removeFromQueue(username) {
		await Promise.all([
			db.sortedSetRemove('registration:queue', username),
			db.delete('registration:queue:name:' + username),
		]);
	}

	User.shouldQueueUser = async function (ip) {
		const registrationApprovalType = meta.config.registrationApprovalType;
		if (registrationApprovalType === 'admin-approval') {
			return true;
		} else if (registrationApprovalType === 'admin-approval-ip') {
			const count = await db.sortedSetCard('ip:' + ip + ':uid');
			return !!count;
		}
		return false;
	};

	User.getRegistrationQueue = async function (start, stop) {
		const data = await db.getSortedSetRevRangeWithScores('registration:queue', start, stop);
		const keys = data.filter(Boolean).map(user => 'registration:queue:name:' + user.value);
		let users = await db.getObjects(keys);
		users = users.filter(Boolean).map(function (user, index) {
			user.timestampISO = utils.toISOString(data[index].score);
			user.email = validator.escape(String(user.email));
			delete user.hashedPassword;
			return user;
		});

		users = await async.map(users, async function (user) {
			// temporary: see http://www.stopforumspam.com/forum/viewtopic.php?id=6392
			// need to keep this for getIPMatchedUsers
			user.ip = user.ip.replace('::ffff:', '');
			await getIPMatchedUsers(user);
			user.customActions = [].concat(user.customActions);
			return user;
			/*
				// then spam prevention plugins, using the "filter:user.getRegistrationQueue" hook can be like:
				user.customActions.push({
					title: '[[spam-be-gone:report-user]]',
					id: 'report-spam-user-' + user.username,
					class: 'btn-warning report-spam-user',
					icon: 'fa-flag'
				});
			 */
		});
		const results = await plugins.fireHook('filter:user.getRegistrationQueue', { users: users });
		return results.users;
	};

	async function getIPMatchedUsers(user) {
		const uids = await User.getUidsFromSet('ip:' + user.ip + ':uid', 0, -1);
		user.ipMatch = await User.getUsersFields(uids, ['uid', 'username', 'picture']);
	}
};
