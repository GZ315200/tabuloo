
'use strict';

const meta = require('../meta');
const plugins = require('../plugins');
const db = require('../database');

module.exports = function (User) {
	User.search = async function (data) {
		const query = data.query || '';
		const searchBy = data.searchBy || 'username';
		const page = data.page || 1;
		const uid = data.uid || 0;
		const paginate = data.hasOwnProperty('paginate') ? data.paginate : true;

		const startTime = process.hrtime();

		let uids = [];
		if (searchBy === 'ip') {
			uids = await searchByIP(query);
		} else if (searchBy === 'uid') {
			uids = [query];
		} else {
			const searchMethod = data.findUids || findUids;
			uids = await searchMethod(query, searchBy, data.hardCap);
		}

		uids = await filterAndSortUids(uids, data);
		const result = await plugins.fireHook('filter:users.search', { uids: uids, uid: uid });
		uids = result.uids;

		const searchResult = {
			matchCount: uids.length,
		};

		if (paginate) {
			var resultsPerPage = meta.config.userSearchResultsPerPage;
			var start = Math.max(0, page - 1) * resultsPerPage;
			var stop = start + resultsPerPage;
			searchResult.pageCount = Math.ceil(uids.length / resultsPerPage);
			uids = uids.slice(start, stop);
		}

		const userData = await User.getUsers(uids, uid);
		searchResult.timing = (process.elapsedTimeSince(startTime) / 1000).toFixed(2);
		searchResult.users = userData;
		return searchResult;
	};

	async function findUids(query, searchBy, hardCap) {
		if (!query) {
			return [];
		}
		query = String(query).toLowerCase();
		const min = query;
		const max = query.substr(0, query.length - 1) + String.fromCharCode(query.charCodeAt(query.length - 1) + 1);

		const resultsPerPage = meta.config.userSearchResultsPerPage;
		hardCap = hardCap || resultsPerPage * 10;

		const data = await db.getSortedSetRangeByLex(searchBy + ':sorted', min, max, 0, hardCap);
		const uids = data.map(data => data.split(':')[1]);
		return uids;
	}

	async function filterAndSortUids(uids, data) {
		uids = uids.filter(uid => parseInt(uid, 10));

		const fields = [];

		if (data.sortBy) {
			fields.push(data.sortBy);
		}
		if (data.onlineOnly) {
			fields.push('status', 'lastonline');
		}
		if (data.bannedOnly) {
			fields.push('banned');
		}
		if (data.flaggedOnly) {
			fields.push('flags');
		}

		if (!fields.length) {
			return uids;
		}

		fields.push('uid');
		let userData = await User.getUsersFields(uids, fields);
		userData = userData.filter(Boolean);
		if (data.onlineOnly) {
			userData = userData.filter(user => user.status !== 'offline' && (Date.now() - user.lastonline < 300000));
		}

		if (data.bannedOnly) {
			userData = userData.filter(user => user.banned);
		}

		if (data.flaggedOnly) {
			userData = userData.filter(user => parseInt(user.flags, 10) > 0);
		}

		if (data.sortBy) {
			sortUsers(userData, data.sortBy);
		}

		return userData.map(user => user.uid);
	}

	function sortUsers(userData, sortBy) {
		if (sortBy === 'joindate' || sortBy === 'postcount' || sortBy === 'reputation') {
			userData.sort((u1, u2) => u2[sortBy] - u1[sortBy]);
		} else {
			userData.sort(function (u1, u2) {
				if (u1[sortBy] < u2[sortBy]) {
					return -1;
				} else if (u1[sortBy] > u2[sortBy]) {
					return 1;
				}
				return 0;
			});
		}
	}

	async function searchByIP(ip) {
		return await db.getSortedSetRevRange('ip:' + ip + ':uid', 0, -1);
	}
};
