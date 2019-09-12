'use strict';

var plugins = require('./plugins');
var db = require('./database');

var social = module.exports;

social.postSharing = null;

social.getPostSharing = async function () {
	if (social.postSharing) {
		return social.postSharing;
	}

	var networks = [
		{
			id: 'facebook',
			name: 'Facebook',
			class: 'fa-facebook',
		},
		{
			id: 'twitter',
			name: 'Twitter',
			class: 'fa-twitter',
		},
	];
	networks = await plugins.fireHook('filter:social.posts', networks);
	const activated = await db.getSetMembers('social:posts.activated');
	networks.forEach(function (network) {
		network.activated = activated.includes(network.id);
	});

	social.postSharing = networks;
	return networks;
};

social.getActivePostSharing = async function () {
	const networks = await social.getPostSharing();
	return networks.filter(network => network && network.activated);
};

social.setActivePostSharingNetworks = async function (networkIDs) {
	await db.delete('social:posts.activated');
	if (!networkIDs.length) {
		return;
	}
	await db.setAdd('social:posts.activated', networkIDs);
	social.postSharing = null;
};

require('./promisify')(social);
