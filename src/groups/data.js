'use strict';

const validator = require('validator');
const nconf = require('nconf');

const db = require('../database');
const plugins = require('../plugins');
const utils = require('../utils');

const intFields = [
	'createtime', 'memberCount', 'hidden', 'system', 'private',
	'userTitleEnabled', 'disableJoinRequests',
];

module.exports = function (Groups) {
	Groups.getGroupsFields = async function (groupNames, fields) {
		if (!Array.isArray(groupNames) || !groupNames.length) {
			return [];
		}

		const ephemeralIdx = groupNames.reduce(function (memo, cur, idx) {
			if (Groups.ephemeralGroups.includes(cur)) {
				memo.push(idx);
			}
			return memo;
		}, []);

		let groupData;
		const keys = groupNames.map(groupName => 'group:' + groupName);
		if (fields.length) {
			groupData = await db.getObjectsFields(keys, fields);
		} else {
			groupData = await db.getObjects(keys);
		}
		if (ephemeralIdx.length) {
			ephemeralIdx.forEach(function (idx) {
				groupData[idx] = Groups.getEphemeralGroup(groupNames[idx]);
			});
		}

		groupData.forEach(group => modifyGroup(group, fields));

		const results = await plugins.fireHook('filter:groups.get', { groups: groupData });
		return results.groups;
	};

	Groups.getGroupsData = async function (groupNames) {
		return await Groups.getGroupsFields(groupNames, []);
	};

	Groups.getGroupData = async function (groupName) {
		const groupsData = await Groups.getGroupsData([groupName]);
		return Array.isArray(groupsData) && groupsData[0] ? groupsData[0] : null;
	};

	Groups.getGroupFields = async function (groupName, fields) {
		const groups = await Groups.getGroupsFields([groupName], fields);
		return groups ? groups[0] : null;
	};

	Groups.setGroupField = async function (groupName, field, value) {
		await db.setObjectField('group:' + groupName, field, value);
		plugins.fireHook('action:group.set', { field: field, value: value, type: 'set' });
	};
};

function modifyGroup(group, fields) {
	if (group) {
		db.parseIntFields(group, intFields, fields);

		escapeGroupData(group);
		group.userTitleEnabled = ([null, undefined].includes(group.userTitleEnabled)) ? 1 : group.userTitleEnabled;
		group.labelColor = validator.escape(String(group.labelColor || '#000000'));
		group.textColor = validator.escape(String(group.textColor || '#ffffff'));
		group.icon = validator.escape(String(group.icon || ''));
		group.createtimeISO = utils.toISOString(group.createtime);
		group.private = ([null, undefined].includes(group.private)) ? 1 : group.private;

		group['cover:thumb:url'] = group['cover:thumb:url'] || group['cover:url'];

		if (group['cover:url']) {
			group['cover:url'] = group['cover:url'].startsWith('http') ? group['cover:url'] : (nconf.get('relative_path') + group['cover:url']);
		} else {
			group['cover:url'] = require('../coverPhoto').getDefaultGroupCover(group.name);
		}

		if (group['cover:thumb:url']) {
			group['cover:thumb:url'] = group['cover:thumb:url'].startsWith('http') ? group['cover:thumb:url'] : (nconf.get('relative_path') + group['cover:thumb:url']);
		} else {
			group['cover:thumb:url'] = require('../coverPhoto').getDefaultGroupCover(group.name);
		}

		group['cover:position'] = validator.escape(String(group['cover:position'] || '50% 50%'));
	}
}

function escapeGroupData(group) {
	if (group) {
		group.nameEncoded = encodeURIComponent(group.name);
		group.displayName = validator.escape(String(group.name));
		group.description = validator.escape(String(group.description || ''));
		group.userTitle = validator.escape(String(group.userTitle || '')) || group.displayName;
	}
}
