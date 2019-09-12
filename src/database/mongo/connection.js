'use strict';

const nconf = require('nconf');

const winston = require('winston');
const _ = require('lodash');

const connection = module.exports;

connection.getConnectionString = function (mongo) {
	mongo = mongo || nconf.get('mongo');
	var usernamePassword = '';
	var uri = mongo.uri || '';
	if (mongo.username && mongo.password) {
		usernamePassword = nconf.get('mongo:username') + ':' + encodeURIComponent(nconf.get('mongo:password')) + '@';
	} else if (!uri.includes('@') || !uri.slice(uri.indexOf('://') + 3, uri.indexOf('@'))) {
		winston.warn('You have no mongo username/password setup!');
	}

	// Sensible defaults for Mongo, if not set
	if (!mongo.host) {
		mongo.host = '127.0.0.1';
	}
	if (!mongo.port) {
		mongo.port = 27017;
	}
	const dbName = mongo.database;
	if (dbName === undefined || dbName === '') {
		winston.warn('You have no database name, using "nodebb"');
		mongo.database = 'nodebb';
	}

	var hosts = mongo.host.split(',');
	var ports = mongo.port.toString().split(',');
	var servers = [];

	for (var i = 0; i < hosts.length; i += 1) {
		servers.push(hosts[i] + ':' + ports[i]);
	}

	return uri || 'mongodb://' + usernamePassword + servers.join() + '/' + mongo.database;
};

connection.getConnectionOptions = function (mongo) {
	mongo = mongo || nconf.get('mongo');
	var connOptions = {
		poolSize: 10,
		reconnectTries: 3600,
		reconnectInterval: 1000,
		autoReconnect: true,
		connectTimeoutMS: 90000,
		useNewUrlParser: true,
	};

	return _.merge(connOptions, mongo.options || {});
};

connection.connect = function (options, callback) {
	callback = callback || function () { };

	const mongoClient = require('mongodb').MongoClient;

	const connString = connection.getConnectionString(options);
	const connOptions = connection.getConnectionOptions(options);

	mongoClient.connect(connString, connOptions, callback);
};
