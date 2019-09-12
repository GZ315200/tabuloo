'use strict';

const plugins = require('../plugins');
const utils = require('../utils');
const db = require('./../database');
const batch = require('../batch');

module.exports = function (Groups) {
	Groups.destroy = async function (groupNames) {
		if (!Array.isArray(groupNames)) {
			groupNames = [groupNames];
		}

		let groupsData = await Groups.getGroupsData(groupNames);
		groupsData = groupsData.filter(Boolean);
		if (!groupsData.length) {
			return;
		}
		const keys = [];
		groupNames.forEach(function (groupName) {
			keys.push('group:' + groupName,
				'group:' + groupName + ':members',
				'group:' + groupName + ':pending',
				'group:' + groupName + ':invited',
				'group:' + groupName + ':owners',
				'group:' + groupName + ':member:pids'
			);
		});
		const sets = groupNames.map(groupName => groupName.toLowerCase() + ':' + groupName);
		const fields = groupNames.map(groupName => utils.slugify(groupName));

		await Promise.all([
			db.deleteAll(keys),
			db.sortedSetRemove([
				'groups:createtime',
				'groups:visible:createtime',
				'groups:visible:memberCount',
			], groupNames),
			db.sortedSetRemove('groups:visible:name', sets),
			db.deleteObjectFields('groupslug:groupname', fields),
			removeGroupsFromPrivilegeGroups(groupNames),
		]);
		Groups.resetCache();
		plugins.fireHook('action:groups.destroy', { groups: groupsData });
	};

	async function removeGroupsFromPrivilegeGroups(groupNames) {
		await batch.processSortedSet('groups:createtime', async function (otherGroups) {
			const privilegeGroups = otherGroups.filter(group => Groups.isPrivilegeGroup(group));
			const keys = privilegeGroups.map(group => 'group:' + group + ':members');
			await db.sortedSetRemove(keys, groupNames);
		}, {
			batch: 500,
		});
	}
};
