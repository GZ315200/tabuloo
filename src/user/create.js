'use strict';

var zxcvbn = require('zxcvbn');
var db = require('../database');
var utils = require('../utils');
var plugins = require('../plugins');
var groups = require('../groups');
var meta = require('../meta');


module.exports = function (User) {
	User.create = async function (data) {
		data.username = data.username.trim();
		data.userslug = utils.slugify(data.username);
		if (data.email !== undefined) {
			data.email = String(data.email).trim();
		}
		const timestamp = data.timestamp || Date.now();

		await User.isDataValid(data);

		let userData = {
			username: data.username,
			userslug: data.userslug,
			email: data.email || '',
			joindate: timestamp,
			lastonline: timestamp,
			picture: data.picture || '',
			fullname: data.fullname || '',
			location: data.location || '',
			birthday: data.birthday || '',
			website: '',
			signature: '',
			uploadedpicture: '',
			profileviews: 0,
			reputation: 0,
			postcount: 0,
			topiccount: 0,
			lastposttime: 0,
			banned: 0,
			status: 'online',
			gdpr_consent: data.gdpr_consent === true ? 1 : 0,
			acceptTos: data.acceptTos === true ? 1 : 0,
		};
		const renamedUsername = await User.uniqueUsername(userData);
		const userNameChanged = !!renamedUsername;
		if (userNameChanged) {
			userData.username = renamedUsername;
			userData.userslug = utils.slugify(renamedUsername);
		}

		const results = await plugins.fireHook('filter:user.create', { user: userData, data: data });
		userData = results.user;

		const uid = await db.incrObjectField('global', 'nextUid');
		userData.uid = uid;

		await db.setObject('user:' + uid, userData);

		const bulkAdd = [
			['username:uid', userData.uid, userData.username],
			['user:' + userData.uid + ':usernames', timestamp, userData.username],
			['username:sorted', 0, userData.username.toLowerCase() + ':' + userData.uid],
			['userslug:uid', userData.uid, userData.userslug],
			['users:joindate', timestamp, userData.uid],
			['users:online', timestamp, userData.uid],
			['users:postcount', 0, userData.uid],
			['users:reputation', 0, userData.uid],
		];

		if (parseInt(userData.uid, 10) !== 1) {
			bulkAdd.push(['users:notvalidated', timestamp, userData.uid]);
		}
		if (userData.email) {
			bulkAdd.push(['email:uid', userData.uid, userData.email.toLowerCase()]);
			bulkAdd.push(['email:sorted', 0, userData.email.toLowerCase() + ':' + userData.uid]);
			bulkAdd.push(['user:' + userData.uid + ':emails', timestamp, userData.email]);
		}

		await Promise.all([
			db.incrObjectField('global', 'userCount'),
			db.sortedSetAddBulk(bulkAdd),
			groups.join('registered-users', userData.uid),
			User.notifications.sendWelcomeNotification(userData.uid),
			storePassword(userData.uid, data.password),
			User.updateDigestSetting(userData.uid, meta.config.dailyDigestFreq),
		]);

		if (userData.email && userData.uid > 1 && meta.config.requireEmailConfirmation) {
			User.email.sendValidationEmail(userData.uid, {
				email: userData.email,
			});
		}
		if (userNameChanged) {
			await User.notifications.sendNameChangeNotification(userData.uid, userData.username);
		}
		plugins.fireHook('action:user.create', { user: userData, data: data });
		return userData.uid;
	};

	async function storePassword(uid, password) {
		if (!password) {
			return;
		}
		const hash = await User.hashPassword(password);
		await Promise.all([
			User.setUserField(uid, 'password', hash),
			User.reset.updateExpiry(uid),
		]);
	}

	User.isDataValid = async function (userData) {
		if (userData.email && !utils.isEmailValid(userData.email)) {
			throw new Error('[[error:invalid-email]]');
		}

		if (!utils.isUserNameValid(userData.username) || !userData.userslug) {
			throw new Error('[[error:invalid-username, ' + userData.username + ']]');
		}

		if (userData.password) {
			await User.isPasswordValid(userData.password);
		}

		if (userData.email) {
			const available = await User.email.available(userData.email);
			if (!available) {
				throw new Error('[[error:email-taken]]');
			}
		}
	};

	// this function doesnt need to be async, but there is exising code that uses it
	// with a callback so it is marked async otherwise it breaks the callback code
	User.isPasswordValid = async function (password, minStrength) {
		minStrength = minStrength || meta.config.minimumPasswordStrength;

		// Sanity checks: Checks if defined and is string
		if (!password || !utils.isPasswordValid(password)) {
			throw new Error('[[error:invalid-password]]');
		}

		if (password.length < meta.config.minimumPasswordLength) {
			throw new Error('[[reset_password:password_too_short]]');
		}

		if (password.length > 512) {
			throw new Error('[[error:password-too-long]]');
		}

		var strength = zxcvbn(password);
		if (strength.score < minStrength) {
			throw new Error('[[user:weak_password]]');
		}
	};

	User.uniqueUsername = async function (userData) {
		let numTries = 0;
		let username = userData.username;
		while (true) {
			/* eslint-disable no-await-in-loop */
			const exists = await meta.userOrGroupExists(username);
			if (!exists) {
				return numTries ? username : null;
			}
			username = userData.username + ' ' + numTries.toString(32);
			numTries += 1;
		}
	};
};
