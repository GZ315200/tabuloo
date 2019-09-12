'use strict';

const user = require('../../user');
const helpers = require('../helpers');
const plugins = require('../../plugins');
const pagination = require('../../pagination');

const notificationsController = module.exports;

notificationsController.get = async function (req, res, next) {
	const regularFilters = [
		{ name: '[[notifications:all]]', filter: '' },
		{ name: '[[global:topics]]', filter: 'new-topic' },
		{ name: '[[notifications:replies]]', filter: 'new-reply' },
		{ name: '[[notifications:chat]]', filter: 'new-chat' },
		{ name: '[[notifications:follows]]', filter: 'follow' },
		{ name: '[[notifications:upvote]]', filter: 'upvote' },
	];

	const moderatorFilters = [
		{ name: '[[notifications:new-flags]]', filter: 'new-post-flag' },
		{ name: '[[notifications:my-flags]]', filter: 'my-flags' },
		{ name: '[[notifications:bans]]', filter: 'ban' },
	];

	const filter = req.query.filter || '';
	const page = Math.max(1, req.query.page || 1);
	const itemsPerPage = 20;
	const start = (page - 1) * itemsPerPage;
	const stop = start + itemsPerPage - 1;

	const [filters, isPrivileged] = await Promise.all([
		plugins.fireHook('filter:notifications.addFilters', {
			regularFilters: regularFilters,
			moderatorFilters: moderatorFilters,
			uid: req.uid,
		}),
		user.isPrivileged(req.uid),
	]);

	let allFilters = filters.regularFilters;
	if (isPrivileged) {
		allFilters = allFilters.concat([
			{ separator: true },
		]).concat(filters.moderatorFilters);
	}
	const selectedFilter = allFilters.find(function (filterData) {
		filterData.selected = filterData.filter === filter;
		return filterData.selected;
	});
	if (!selectedFilter) {
		return next();
	}
	let nids = await user.notifications.getAll(req.uid, selectedFilter.filter);
	const pageCount = Math.max(1, Math.ceil(nids.length / itemsPerPage));
	nids = nids.slice(start, stop + 1);

	const notifications = await user.notifications.getNotifications(nids, req.uid);
	const data = await plugins.fireHook('filter:notifications.get', {
		notifications: notifications,
	});
	res.render('notifications', {
		notifications: data.notifications,
		pagination: pagination.create(page, pageCount, req.query),
		filters: allFilters,
		regularFilters: regularFilters,
		moderatorFilters: moderatorFilters,
		selectedFilter: selectedFilter,
		title: '[[pages:notifications]]',
		breadcrumbs: helpers.buildBreadcrumbs([{ text: '[[pages:notifications]]' }]),
	});
};
