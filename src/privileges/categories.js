
'use strict';

const _ = require('lodash');

const categories = require('../categories');
const user = require('../user');
const groups = require('../groups');
const helpers = require('./helpers');
const plugins = require('../plugins');
const utils = require('../utils');

module.exports = function (privileges) {
	privileges.categories = {};

	// Method used in admin/category controller to show all users/groups with privs in that given cid
	privileges.categories.list = async function (cid) {
		async function getLabels() {
			return await utils.promiseParallel({
				users: plugins.fireHook('filter:privileges.list_human', privileges.privilegeLabels.slice()),
				groups: plugins.fireHook('filter:privileges.groups.list_human', privileges.privilegeLabels.slice()),
			});
		}

		const payload = await utils.promiseParallel({
			labels: getLabels(),
			users: helpers.getUserPrivileges(cid, 'filter:privileges.list', privileges.userPrivilegeList),
			groups: helpers.getGroupPrivileges(cid, 'filter:privileges.groups.list', privileges.groupPrivilegeList),
		});

		// This is a hack because I can't do {labels.users.length} to echo the count in templates.js
		payload.columnCountUser = payload.labels.users.length + 2;
		payload.columnCountUserOther = payload.labels.users.length - privileges.privilegeLabels.length;
		payload.columnCountGroup = payload.labels.groups.length + 2;
		payload.columnCountGroupOther = payload.labels.groups.length - privileges.privilegeLabels.length;
		return payload;
	};

	privileges.categories.get = async function (cid, uid) {
		const privs = ['topics:create', 'topics:read', 'topics:tag', 'read'];

		const [userPrivileges, isAdministrator, isModerator] = await Promise.all([
			helpers.isUserAllowedTo(privs, uid, cid),
			user.isAdministrator(uid),
			user.isModerator(uid, cid),
		]);

		const privData = _.zipObject(privs, userPrivileges);
		const isAdminOrMod = isAdministrator || isModerator;

		return await plugins.fireHook('filter:privileges.categories.get', {
			'topics:create': privData['topics:create'] || isAdministrator,
			'topics:read': privData['topics:read'] || isAdministrator,
			'topics:tag': privData['topics:tag'] || isAdministrator,
			read: privData.read || isAdministrator,
			cid: cid,
			uid: uid,
			editable: isAdminOrMod,
			view_deleted: isAdminOrMod,
			isAdminOrMod: isAdminOrMod,
		});
	};

	privileges.categories.isAdminOrMod = async function (cid, uid) {
		if (parseInt(uid, 10) <= 0) {
			return false;
		}
		const [isAdmin, isMod] = await Promise.all([
			user.isAdministrator(uid),
			user.isModerator(uid, cid),
		]);
		return isAdmin || isMod;
	};

	privileges.categories.isUserAllowedTo = async function (privilege, cid, uid) {
		if (!cid) {
			return false;
		}
		const results = await helpers.isUserAllowedTo(privilege, uid, Array.isArray(cid) ? cid : [cid]);

		if (Array.isArray(results) && results.length) {
			return Array.isArray(cid) ? results : results[0];
		}
		return false;
	};

	privileges.categories.can = async function (privilege, cid, uid) {
		if (!cid) {
			return false;
		}
		const [disabled, isAdmin, isAllowed] = await Promise.all([
			categories.getCategoryField(cid, 'disabled'),
			user.isAdministrator(uid),
			privileges.categories.isUserAllowedTo(privilege, cid, uid),
		]);
		return !disabled && (isAllowed || isAdmin);
	};

	privileges.categories.filterCids = async function (privilege, cids, uid) {
		if (!Array.isArray(cids) || !cids.length) {
			return [];
		}

		cids = _.uniq(cids);
		const results = await privileges.categories.getBase(privilege, cids, uid);
		return cids.filter(function (cid, index) {
			return !!cid && !results.categories[index].disabled && (results.allowedTo[index] || results.isAdmin);
		});
	};

	privileges.categories.getBase = async function (privilege, cids, uid) {
		return await utils.promiseParallel({
			categories: categories.getCategoriesFields(cids, ['disabled']),
			allowedTo: helpers.isUserAllowedTo(privilege, uid, cids),
			isAdmin: user.isAdministrator(uid),
		});
	};

	privileges.categories.filterUids = async function (privilege, cid, uids) {
		if (!uids.length) {
			return [];
		}

		uids = _.uniq(uids);

		const [allowedTo, isAdmins] = await Promise.all([
			helpers.isUsersAllowedTo(privilege, uids, cid),
			user.isAdministrator(uids),
		]);
		return uids.filter((uid, index) => allowedTo[index] || isAdmins[index]);
	};

	privileges.categories.give = async function (privileges, cid, groupName) {
		await helpers.giveOrRescind(groups.join, privileges, cid, groupName);
	};

	privileges.categories.rescind = async function (privileges, cid, groupName) {
		await helpers.giveOrRescind(groups.leave, privileges, cid, groupName);
	};

	privileges.categories.canMoveAllTopics = async function (currentCid, targetCid, uid) {
		const [isAdmin, isModerators] = await Promise.all([
			user.isAdministrator(uid),
			user.isModerator(uid, [currentCid, targetCid]),
		]);
		return isAdmin || !isModerators.includes(false);
	};

	privileges.categories.userPrivileges = async function (cid, uid) {
		const tasks = {};
		privileges.userPrivilegeList.forEach(function (privilege) {
			tasks[privilege] = groups.isMember(uid, 'cid:' + cid + ':privileges:' + privilege);
		});
		return await utils.promiseParallel(tasks);
	};

	privileges.categories.groupPrivileges = async function (cid, groupName) {
		const tasks = {};
		privileges.groupPrivilegeList.forEach(function (privilege) {
			tasks[privilege] = groups.isMember(groupName, 'cid:' + cid + ':privileges:' + privilege);
		});
		return await utils.promiseParallel(tasks);
	};
};
