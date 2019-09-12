'use strict';

var nconf = require('nconf');
var util = require('util');
var winston = require('winston');
var EventEmitter = require('events').EventEmitter;
const connection = require('./connection');

var channelName;
var PubSub = function () {
	var self = this;
	var subClient = connection.connect();
	this.pubClient = connection.connect();

	channelName = 'db:' + nconf.get('redis:database') + ':pubsub_channel';
	subClient.subscribe(channelName);

	subClient.on('message', function (channel, message) {
		if (channel !== channelName) {
			return;
		}

		try {
			var msg = JSON.parse(message);
			self.emit(msg.event, msg.data);
		} catch (err) {
			winston.error(err.stack);
		}
	});
};

util.inherits(PubSub, EventEmitter);

PubSub.prototype.publish = function (event, data) {
	this.pubClient.publish(channelName, JSON.stringify({ event: event, data: data }));
};

module.exports = new PubSub();
