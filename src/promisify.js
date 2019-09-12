'use strict';

var util = require('util');
var _ = require('lodash');

module.exports = function (theModule, ignoreKeys) {
	ignoreKeys = ignoreKeys || [];
	function isCallbackedFunction(func) {
		if (typeof func !== 'function') {
			return false;
		}
		var str = func.toString().split('\n')[0];
		return str.includes('callback)');
	}

	function isAsyncFunction(fn) {
		return fn && fn.constructor && fn.constructor.name === 'AsyncFunction';
	}


	function promisifyRecursive(module) {
		if (!module) {
			return;
		}

		var keys = Object.keys(module);
		keys.forEach(function (key) {
			if (ignoreKeys.includes(key)) {
				return;
			}
			if (isAsyncFunction(module[key])) {
				module[key] = wrapCallback(module[key], util.callbackify(module[key]));
			} else if (isCallbackedFunction(module[key])) {
				module[key] = wrapPromise(module[key], util.promisify(module[key]));
			} else if (typeof module[key] === 'object') {
				promisifyRecursive(module[key]);
			}
		});
	}

	function wrapCallback(origFn, callbackFn) {
		return async function wrapperCallback(...args) {
			if (arguments.length && typeof arguments[arguments.length - 1] === 'function') {
				const cb = args.pop();
				args.push(function (err, res) {
					return res !== undefined ? cb(err, res) : cb(err);
				});
				return callbackFn.apply(null, args);
			}
			return origFn.apply(null, arguments);
		};
	}

	function wrapPromise(origFn, promiseFn) {
		return function wrapperPromise(...args) {
			if (arguments.length && typeof arguments[arguments.length - 1] === 'function') {
				return origFn.apply(null, args);
			}

			return promiseFn.apply(null, arguments);
		};
	}

	var parts = [];
	function deprecateRecursive(module, key) {
		if (!module) {
			return;
		}
		if (key) {
			parts.push(key);
		}
		var keys = Object.keys(module);
		keys.forEach(function (key) {
			if (ignoreKeys.includes(key)) {
				return;
			}

			if (typeof module[key] === 'object') {
				deprecateRecursive(module[key], key);
			}

			if (typeof module[key] === 'function') {
				module[key] = require('util').deprecate(module[key], '.async.' + (parts.concat([key]).join('.')) + ' usage is deprecated use .' + (parts.concat([key]).join('.')) + ' directly!');
			}
		});
		parts.pop();
	}

	promisifyRecursive(theModule);
	const asyncModule = _.cloneDeep(theModule);
	deprecateRecursive(asyncModule);

	return asyncModule;
};
