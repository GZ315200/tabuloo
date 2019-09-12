'use strict';

const user = require('../user');
const db = require('../database');
const plugins = require('../plugins');
const utils = require('../utils');

const Groups = module.exports;

require('./data')(Groups);
require('./create')(Groups);
require('./delete')(Groups);
require('./update')(Groups);
require('./invite')(Groups);
require('./membership')(Groups);
require('./ownership')(Groups);
require('./search')(Groups);
require('./cover')(Groups);
require('./posts')(Groups);
require('./user')(Groups);
require('./join')(Groups);
require('./leave')(Groups);
require('./cache')(Groups);


Groups.ephemeralGroups = ['guests', 'spiders'];

Groups.getEphemeralGroup = function (groupName) {
	return {
		name: groupName,
		slug: utils.slugify(groupName),
		description: '',
		deleted: '0',
		hidden: '0',
		system: '1',
	};
};

Groups.removeEphemeralGroups = function (groups) {
	for (var x = groups.length; x >= 0; x -= 1) {
		if (Groups.ephemeralGroups.includes(groups[x])) {
			groups.splice(x, 1);
		}
	}

	return groups;
};

var isPrivilegeGroupRegex = /^cid:\d+:privileges:[\w:]+$/;
Groups.isPrivilegeGroup = function (groupName) {
	return isPrivilegeGroupRegex.test(groupName);
};

Groups.getGroupsFromSet = async function (set, start, stop) {
	let groupNames;
	if (set === 'groups:visible:name') {
		groupNames = await db.getSortedSetRangeByLex(set, '-', '+', start, stop - start + 1);
	} else {
		groupNames = await db.getSortedSetRevRange(set, start, stop);
	}
	if (set === 'groups:visible:name') {
		groupNames = groupNames.map(name => name.split(':')[1]);
	}

	return await Groups.getGroupsAndMembers(groupNames);
};

Groups.getGroupsBySort = async function (sort, start, stop) {
	let set = 'groups:visible:name';
	if (sort === 'count') {
		set = 'groups:visible:memberCount';
	} else if (sort === 'date') {
		set = 'groups:visible:createtime';
	}
	return await Groups.getGroupsFromSet(set, start, stop);
};

Groups.getNonPrivilegeGroups = async function (set, start, stop) {
	let groupNames = await db.getSortedSetRevRange(set, start, stop);
	groupNames = groupNames.concat(Groups.ephemeralGroups).filter(groupName => !Groups.isPrivilegeGroup(groupName));
	return await Groups.getGroupsData(groupNames);
};

Groups.getGroups = async function (set, start, stop) {
	return await db.getSortedSetRevRange(set, start, stop);
};

Groups.getGroupsAndMembers = async function (groupNames) {
	const [groups, members] = await Promise.all([
		Groups.getGroupsData(groupNames),
		Groups.getMemberUsers(groupNames, 0, 3),
	]);
	groups.forEach(function (group, index) {
		if (group) {
			group.members = members[index] || [];
			group.truncated = group.memberCount > group.members.length;
		}
	});
	return groups;
};

Groups.get = async function (groupName, options) {
	if (!groupName) {
		throw new Error('[[error:invalid-group]]');
	}

	let stop = -1;

	if (options.truncateUserList) {
		stop = (parseInt(options.userListCount, 10) || 4) - 1;
	}

	const [groupData, members, pending, invited, isMember, isPending, isInvited, isOwner] = await Promise.all([
		Groups.getGroupData(groupName),
		Groups.getOwnersAndMembers(groupName, options.uid, 0, stop),
		Groups.getUsersFromSet('group:' + groupName + ':pending', ['username', 'userslug', 'picture']),
		Groups.getUsersFromSet('group:' + groupName + ':invited', ['username', 'userslug', 'picture']),
		Groups.isMember(options.uid, groupName),
		Groups.isPending(options.uid, groupName),
		Groups.isInvited(options.uid, groupName),
		Groups.ownership.isOwner(options.uid, groupName),
	]);

	if (!groupData) {
		return null;
	}
	const descriptionParsed = await plugins.fireHook('filter:parse.raw', groupData.description);
	groupData.descriptionParsed = descriptionParsed;
	groupData.members = members;
	groupData.membersNextStart = stop + 1;
	groupData.pending = pending.filter(Boolean);
	groupData.invited = invited.filter(Boolean);
	groupData.isMember = isMember;
	groupData.isPending = isPending;
	groupData.isInvited = isInvited;
	groupData.isOwner = isOwner;
	const results = await plugins.fireHook('filter:group.get', { group: groupData });
	return results.group;
};

Groups.getOwners = async function (groupName) {
	return await db.getSetMembers('group:' + groupName + ':owners');
};

Groups.getOwnersAndMembers = async function (groupName, uid, start, stop) {
	const ownerUids = await db.getSetMembers('group:' + groupName + ':owners');
	const [owners, members] = await Promise.all([
		user.getUsers(ownerUids, uid),
		user.getUsersFromSet('group:' + groupName + ':members', uid, start, stop),
	]);
	owners.forEach(function (user) {
		if (user) {
			user.isOwner = true;
		}
	});

	const nonOwners = members.filter(user => user && user.uid && !ownerUids.includes(user.uid.toString()));
	return owners.concat(nonOwners);
};

Groups.getByGroupslug = async function (slug, options) {
	const groupName = await db.getObjectField('groupslug:groupname', slug);
	if (!groupName) {
		throw new Error('[[error:no-group]]');
	}
	return await Groups.get(groupName, options);
};

Groups.getGroupNameByGroupSlug = async function (slug) {
	return await db.getObjectField('groupslug:groupname', slug);
};

Groups.isPrivate = async function (groupName) {
	return await isFieldOn(groupName, 'private');
};

Groups.isHidden = async function (groupName) {
	return await isFieldOn(groupName, 'hidden');
};

async function isFieldOn(groupName, field) {
	const value = await db.getObjectField('group:' + groupName, field);
	return parseInt(value, 10) === 1;
}

Groups.exists = async function (name) {
	if (Array.isArray(name)) {
		const slugs = name.map(groupName => utils.slugify(groupName));
		const isMembersOfRealGroups = await db.isSortedSetMembers('groups:createtime', name);
		const isMembersOfEphemeralGroups = slugs.map(slug => Groups.ephemeralGroups.includes(slug));
		return name.map((n, index) => isMembersOfRealGroups[index] || isMembersOfEphemeralGroups[index]);
	}
	const slug = utils.slugify(name);
	const isMemberOfRealGroups = await db.isSortedSetMember('groups:createtime', name);
	const isMemberOfEphemeralGroups = Groups.ephemeralGroups.includes(slug);
	return isMemberOfRealGroups || isMemberOfEphemeralGroups;
};

Groups.existsBySlug = async function (slug) {
	if (Array.isArray(slug)) {
		return await db.isObjectFields('groupslug:groupname', slug);
	}
	return await db.isObjectField('groupslug:groupname', slug);
};

Groups.async = require('../promisify')(Groups);
