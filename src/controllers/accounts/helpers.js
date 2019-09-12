'use strict';

const validator = require('validator');
const winston = require('winston');
const nconf = require('nconf');

const user = require('../../user');
const groups = require('../../groups');
const plugins = require('../../plugins');
const meta = require('../../meta');
const utils = require('../../utils');
const privileges = require('../../privileges');
const translator = require('../../translator');

const helpers = module.exports;

helpers.getUserDataByUserSlug = async function (userslug, callerUID) {
	const uid = await user.getUidByUserslug(userslug);
	if (!uid) {
		return null;
	}

	const results = await getAllData(uid, callerUID);
	if (!results.userData) {
		throw new Error('[[error:invalid-uid]]');
	}
	await parseAboutMe(results.userData);

	const userData = results.userData;
	const userSettings = results.userSettings;
	const isAdmin = results.isAdmin;
	const isGlobalModerator = results.isGlobalModerator;
	const isModerator = results.isModerator;
	const isSelf = parseInt(callerUID, 10) === parseInt(userData.uid, 10);

	userData.age = Math.max(0, userData.birthday ? Math.floor((new Date().getTime() - new Date(userData.birthday).getTime()) / 31536000000) : 0);

	userData.emailClass = 'hide';

	if (!isAdmin && !isGlobalModerator && !isSelf && (!userSettings.showemail || meta.config.hideEmail)) {
		userData.email = '';
	} else if (!userSettings.showemail) {
		userData.emailClass = '';
	}

	if (!isAdmin && !isGlobalModerator && !isSelf && (!userSettings.showfullname || meta.config.hideFullname)) {
		userData.fullname = '';
	}

	if (isAdmin || isSelf || ((isGlobalModerator || isModerator) && !results.isTargetAdmin)) {
		userData.ips = results.ips;
	}

	if (!isAdmin && !isGlobalModerator && !isModerator) {
		userData.moderationNote = undefined;
	}

	userData.isBlocked = results.isBlocked;
	if (isAdmin || isSelf) {
		userData.blocksCount = parseInt(userData.blocksCount, 10) || 0;
	}

	userData.yourid = callerUID;
	userData.theirid = userData.uid;
	userData.isTargetAdmin = results.isTargetAdmin;
	userData.isAdmin = isAdmin;
	userData.isGlobalModerator = isGlobalModerator;
	userData.isModerator = isModerator;
	userData.isAdminOrGlobalModerator = isAdmin || isGlobalModerator;
	userData.isAdminOrGlobalModeratorOrModerator = isAdmin || isGlobalModerator || isModerator;
	userData.isSelfOrAdminOrGlobalModerator = isSelf || isAdmin || isGlobalModerator;
	userData.canEdit = results.canEdit;
	userData.canBan = results.canBanUser;
	userData.canChangePassword = isAdmin || (isSelf && !meta.config['password:disableEdit']);
	userData.isSelf = isSelf;
	userData.isFollowing = results.isFollowing;
	userData.showHidden = isSelf || isAdmin || (isGlobalModerator && !results.isTargetAdmin);
	userData.groups = Array.isArray(results.groups) && results.groups.length ? results.groups[0] : [];
	userData.disableSignatures = meta.config.disableSignatures === 1;
	userData['reputation:disabled'] = meta.config['reputation:disabled'] === 1;
	userData['downvote:disabled'] = meta.config['downvote:disabled'] === 1;
	userData['email:confirmed'] = !!userData['email:confirmed'];
	userData.profile_links = filterLinks(results.profile_menu.links, {
		self: isSelf,
		other: !isSelf,
		moderator: isModerator,
		globalMod: isGlobalModerator,
		admin: isAdmin,
	});

	userData.sso = results.sso.associations;
	userData.banned = userData.banned === 1;
	userData.website = validator.escape(String(userData.website || ''));
	userData.websiteLink = !userData.website.startsWith('http') ? 'http://' + userData.website : userData.website;
	userData.websiteName = userData.website.replace(validator.escape('http://'), '').replace(validator.escape('https://'), '');

	userData.fullname = validator.escape(String(userData.fullname || ''));
	userData.location = validator.escape(String(userData.location || ''));
	userData.signature = validator.escape(String(userData.signature || ''));
	userData.birthday = validator.escape(String(userData.birthday || ''));
	userData.moderationNote = validator.escape(String(userData.moderationNote || ''));

	if (userData['cover:url']) {
		userData['cover:url'] = userData['cover:url'].startsWith('http') ? userData['cover:url'] : (nconf.get('relative_path') + userData['cover:url']);
	} else {
		userData['cover:url'] = require('../../coverPhoto').getDefaultProfileCover(userData.uid);
	}

	userData['cover:position'] = validator.escape(String(userData['cover:position'] || '50% 50%'));
	userData['username:disableEdit'] = !userData.isAdmin && meta.config['username:disableEdit'];
	userData['email:disableEdit'] = !userData.isAdmin && meta.config['email:disableEdit'];

	return userData;
};

async function getAllData(uid, callerUID) {
	return await utils.promiseParallel({
		userData: user.getUserData(uid),
		isTargetAdmin: user.isAdministrator(uid),
		userSettings: user.getSettings(uid),
		isAdmin: user.isAdministrator(callerUID),
		isGlobalModerator: user.isGlobalModerator(callerUID),
		isModerator: user.isModeratorOfAnyCategory(callerUID),
		isFollowing: user.isFollowing(callerUID, uid),
		ips: user.getIPs(uid, 4),
		profile_menu: getProfileMenu(uid, callerUID),
		groups: groups.getUserGroups([uid]),
		sso: plugins.fireHook('filter:auth.list', { uid: uid, associations: [] }),
		canEdit: privileges.users.canEdit(callerUID, uid),
		canBanUser: privileges.users.canBanUser(callerUID, uid),
		isBlocked: user.blocks.is(uid, callerUID),
	});
}

async function getProfileMenu(uid, callerUID) {
	const links = [{
		id: 'info',
		route: 'info',
		name: '[[user:account_info]]',
		visibility: {
			self: false,
			other: false,
			moderator: true,
			globalMod: true,
			admin: true,
		},
	}, {
		id: 'sessions',
		route: 'sessions',
		name: '[[pages:account/sessions]]',
		visibility: {
			self: true,
			other: false,
			moderator: false,
			globalMod: false,
			admin: false,
		},
	}];

	if (meta.config.gdpr_enabled) {
		links.push({
			id: 'consent',
			route: 'consent',
			name: '[[user:consent.title]]',
			visibility: {
				self: true,
				other: false,
				moderator: false,
				globalMod: false,
				admin: false,
			},
		});
	}

	return await plugins.fireHook('filter:user.profileMenu', {
		uid: uid,
		callerUID: callerUID,
		links: links,
	});
}

async function parseAboutMe(userData) {
	if (!userData.aboutme) {
		return;
	}
	userData.aboutme = validator.escape(String(userData.aboutme || ''));
	const parsed = await plugins.fireHook('filter:parse.aboutme', userData.aboutme);
	userData.aboutmeParsed = translator.escape(parsed);
}

function filterLinks(links, states) {
	return links.filter(function (link, index) {
		// "public" is the old property, if visibility is defined, discard `public`
		if (link.hasOwnProperty('public') && !link.hasOwnProperty('visibility')) {
			winston.warn('[account/profileMenu (' + link.id + ')] Use of the `.public` property is deprecated, use `visibility` now');
			return link && (link.public || states.self);
		}

		// Default visibility
		link.visibility = { self: true,
			other: true,
			moderator: true,
			globalMod: true,
			admin: true,
			...link.visibility };

		var permit = Object.keys(states).some(function (state) {
			return states[state] && link.visibility[state];
		});

		links[index].public = permit;
		return permit;
	});
}

require('../../promisify')(helpers);
