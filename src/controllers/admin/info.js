'use strict';

const os = require('os');
const winston = require('winston');
const nconf = require('nconf');
const exec = require('child_process').exec;

const pubsub = require('../../pubsub');
const rooms = require('../../socket.io/admin/rooms');

const infoController = module.exports;

let info = {};

infoController.get = function (req, res) {
	info = {};
	pubsub.publish('sync:node:info:start');
	const timeoutMS = 1000;
	setTimeout(function () {
		const data = [];
		Object.keys(info).forEach(key => data.push(info[key]));
		data.sort(function (a, b) {
			if (a.id < b.id) {
				return -1;
			}
			if (a.id > b.id) {
				return 1;
			}
			return 0;
		});
		res.render('admin/development/info', {
			info: data,
			infoJSON: JSON.stringify(data, null, 4),
			host: os.hostname(),
			port: nconf.get('port'),
			nodeCount: data.length,
			timeout: timeoutMS,
		});
	}, timeoutMS);
};

pubsub.on('sync:node:info:start', async function () {
	try {
		const data = await getNodeInfo();
		data.id = os.hostname() + ':' + nconf.get('port');
		pubsub.publish('sync:node:info:end', { data: data, id: data.id });
	} catch (err) {
		winston.error(err);
	}
});

pubsub.on('sync:node:info:end', function (data) {
	info[data.id] = data.data;
});

async function getNodeInfo() {
	const data = {
		process: {
			port: nconf.get('port'),
			pid: process.pid,
			title: process.title,
			version: process.version,
			memoryUsage: process.memoryUsage(),
			uptime: process.uptime(),
			cpuUsage: process.cpuUsage(),
		},
		os: {
			hostname: os.hostname(),
			type: os.type(),
			platform: os.platform(),
			arch: os.arch(),
			release: os.release(),
			load: os.loadavg().map(function (load) { return load.toFixed(2); }).join(', '),
		},
	};
	data.process.cpuUsage.user /= 1000000;
	data.process.cpuUsage.user = data.process.cpuUsage.user.toFixed(2);
	data.process.cpuUsage.system /= 1000000;
	data.process.cpuUsage.system = data.process.cpuUsage.system.toFixed(2);
	data.process.memoryUsage.humanReadable = (data.process.memoryUsage.rss / (1024 * 1024)).toFixed(2);

	const [stats, gitInfo] = await Promise.all([
		rooms.getLocalStats(),
		getGitInfo(),
	]);
	data.git = gitInfo;
	data.stats = stats;
	return data;
}

async function getGitInfo() {
	function get(cmd, callback) {
		exec(cmd, function (err, stdout) {
			if (err) {
				winston.error(err);
			}
			callback(null, stdout ? stdout.replace(/\n$/, '') : 'no-git-info');
		});
	}
	const getAsync = require('util').promisify(get);
	const [hash, branch] = await Promise.all([
		getAsync('git rev-parse HEAD'),
		getAsync('git rev-parse --abbrev-ref HEAD'),
	]);
	return { hash: hash, branch: branch };
}
