'use strict';

const winston = require('winston');
const async = require('async');
const utils = require('../utils');

module.exports = function (Plugins) {
	Plugins.deprecatedHooks = {
		'filter:controllers.topic.get': 'filter:topic.build',
		'filter:user.account': 'filter:account/profile.build',
		'filter:user.account.edit': 'filter:account/edit.build',
		'filter:notifications.get': 'filter:notifications.build',
	};

	Plugins.internals = {
		_register: function (data) {
			Plugins.loadedHooks[data.hook] = Plugins.loadedHooks[data.hook] || [];
			Plugins.loadedHooks[data.hook].push(data);
		},
	};

	const hookTypeToMethod = {
		filter: fireFilterHook,
		action: fireActionHook,
		static: fireStaticHook,
		response: fireResponseHook,
	};

	/*
		`data` is an object consisting of (* is required):
			`data.hook`*, the name of the NodeBB hook
			`data.method`*, the method called in that plugin (can be an array of functions)
			`data.priority`, the relative priority of the method when it is eventually called (default: 10)
	*/
	Plugins.registerHook = function (id, data) {
		if (!data.hook || !data.method) {
			winston.warn('[plugins/' + id + '] registerHook called with invalid data.hook/method', data);
			return;
		}

		if (Plugins.deprecatedHooks[data.hook]) {
			winston.warn('[plugins/' + id + '] Hook `' + data.hook + '` is deprecated, ' +
				(Plugins.deprecatedHooks[data.hook] ?
					'please use `' + Plugins.deprecatedHooks[data.hook] + '` instead.' :
					'there is no alternative.'
				));
		}

		data.id = id;
		if (!data.priority) {
			data.priority = 10;
		}

		if (Array.isArray(data.method) && data.method.every(method => typeof method === 'function' || typeof method === 'string')) {
			// Go go gadget recursion!
			data.method.forEach(function (method) {
				const singularData = { ...data, method: method };
				Plugins.registerHook(id, singularData);
			});
		} else if (typeof data.method === 'string' && data.method.length > 0) {
			const method = data.method.split('.').reduce(function (memo, prop) {
				if (memo && memo[prop]) {
					return memo[prop];
				}
				// Couldn't find method by path, aborting
				return null;
			}, Plugins.libraries[data.id]);

			// Write the actual method reference to the hookObj
			data.method = method;

			Plugins.internals._register(data);
		} else if (typeof data.method === 'function') {
			Plugins.internals._register(data);
		} else {
			winston.warn('[plugins/' + id + '] Hook method mismatch: ' + data.hook + ' => ' + data.method);
		}
	};

	Plugins.unregisterHook = function (id, hook, method) {
		var hooks = Plugins.loadedHooks[hook] || [];
		Plugins.loadedHooks[hook] = hooks.filter(function (hookData) {
			return hookData && hookData.id !== id && hookData.method !== method;
		});
	};

	Plugins.fireHook = async function (hook, params) {
		const hookList = Plugins.loadedHooks[hook];
		const hookType = hook.split(':')[0];
		if (hook !== 'action:plugins.firehook') {
			winston.verbose('[plugins/fireHook] ' + hook);
		}

		if (!hookTypeToMethod[hookType]) {
			winston.warn('[plugins] Unknown hookType: ' + hookType + ', hook : ' + hook);
			return;
		}
		const result = await hookTypeToMethod[hookType](hook, hookList, params);

		if (hook !== 'action:plugins.firehook') {
			Plugins.fireHook('action:plugins.firehook', { hook: hook, params: params });
		}
		if (result !== undefined) {
			return result;
		}
	};

	async function fireFilterHook(hook, hookList, params) {
		if (!Array.isArray(hookList) || !hookList.length) {
			return params;
		}

		return await async.reduce(hookList, params, function (params, hookObj, next) {
			if (typeof hookObj.method !== 'function') {
				if (global.env === 'development') {
					winston.warn('[plugins] Expected method for hook \'' + hook + '\' in plugin \'' + hookObj.id + '\' not found, skipping.');
				}
				return next(null, params);
			}
			const returned = hookObj.method(params, next);
			if (utils.isPromise(returned)) {
				returned.then(
					payload => setImmediate(next, null, payload),
					err => setImmediate(next, err)
				);
			}
		});
	}

	async function fireActionHook(hook, hookList, params) {
		if (!Array.isArray(hookList) || !hookList.length) {
			return;
		}
		await async.each(hookList, function (hookObj, next) {
			if (typeof hookObj.method !== 'function') {
				if (global.env === 'development') {
					winston.warn('[plugins] Expected method for hook \'' + hook + '\' in plugin \'' + hookObj.id + '\' not found, skipping.');
				}
				return next();
			}

			hookObj.method(params);
			next();
		});
	}

	async function fireStaticHook(hook, hookList, params) {
		if (!Array.isArray(hookList) || !hookList.length) {
			return;
		}
		await async.each(hookList, function (hookObj, next) {
			if (typeof hookObj.method === 'function') {
				let timedOut = false;
				const timeoutId = setTimeout(function () {
					winston.warn('[plugins] Callback timed out, hook \'' + hook + '\' in plugin \'' + hookObj.id + '\'');
					timedOut = true;
					next();
				}, 5000);

				const onError = (err) => {
					winston.error('[plugins] Error executing \'' + hook + '\' in plugin \'' + hookObj.id + '\'');
					winston.error(err);
					clearTimeout(timeoutId);
					next();
				};
				const callback = (...args) => {
					clearTimeout(timeoutId);
					if (!timedOut) {
						next(...args);
					}
				};
				try {
					const returned = hookObj.method(params, callback);
					if (utils.isPromise(returned)) {
						returned.then(
							payload => setImmediate(callback, null, payload),
							err => setImmediate(onError, err)
						);
					}
				} catch (err) {
					onError(err);
				}
			} else {
				next();
			}
		});
	}

	async function fireResponseHook(hook, hookList, params) {
		if (!Array.isArray(hookList) || !hookList.length) {
			return;
		}
		await async.eachSeries(hookList, function (hookObj, next) {
			if (typeof hookObj.method !== 'function') {
				if (global.env === 'development') {
					winston.warn('[plugins] Expected method for hook \'' + hook + '\' in plugin \'' + hookObj.id + '\' not found, skipping.');
				}
				return next();
			}

			// Skip remaining hooks if headers have been sent
			if (params.res.headersSent) {
				return next();
			}

			hookObj.method(params);
			next();
		});
	}

	Plugins.hasListeners = function (hook) {
		return !!(Plugins.loadedHooks[hook] && Plugins.loadedHooks[hook].length > 0);
	};
};
