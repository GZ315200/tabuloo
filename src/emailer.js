'use strict';

var async = require('async');
var winston = require('winston');
var nconf = require('nconf');
var Benchpress = require('benchpressjs');
var nodemailer = require('nodemailer');
var wellKnownServices = require('nodemailer/lib/well-known/services');
var htmlToText = require('html-to-text');
var url = require('url');
var path = require('path');
var fs = require('fs');
var _ = require('lodash');
var jwt = require('jsonwebtoken');

var User = require('./user');
var Plugins = require('./plugins');
var meta = require('./meta');
var translator = require('./translator');
var pubsub = require('./pubsub');
var file = require('./file');

var Emailer = module.exports;

Emailer.transports = {
	sendmail: nodemailer.createTransport({
		sendmail: true,
		newline: 'unix',
		pool: true,
		rateLimit: meta.config['email:sendmail:rateLimit'],
		rateDelta: meta.config['email:sendmail:rateDelta'],
	}),
	smtp: undefined,
};

var app;

var viewsDir = nconf.get('views_dir');

Emailer.getTemplates = function (config, callback) {
	var emailsPath = path.join(viewsDir, 'emails');
	async.waterfall([
		function (next) {
			file.walk(emailsPath, next);
		},
		function (emails, next) {
			// exclude .js files
			emails = emails.filter(function (email) {
				return !email.endsWith('.js');
			});

			async.map(emails, function (email, next) {
				var path = email.replace(emailsPath, '').substr(1).replace('.tpl', '');

				async.waterfall([
					function (next) {
						fs.readFile(email, 'utf8', next);
					},
					function (original, next) {
						var isCustom = !!config['email:custom:' + path];
						var text = config['email:custom:' + path] || original;

						next(null, {
							path: path,
							fullpath: email,
							text: text,
							original: original,
							isCustom: isCustom,
						});
					},
				], next);
			}, next);
		},
	], callback);
};

Emailer.listServices = function (callback) {
	var services = Object.keys(wellKnownServices);
	setImmediate(callback, null, services);
};

Emailer._defaultPayload = {};

Emailer.setupFallbackTransport = function (config) {
	winston.verbose('[emailer] Setting up SMTP fallback transport');
	// Enable Gmail transport if enabled in ACP
	if (parseInt(config['email:smtpTransport:enabled'], 10) === 1) {
		var smtpOptions = {};

		if (config['email:smtpTransport:user'] || config['email:smtpTransport:pass']) {
			smtpOptions.auth = {
				user: config['email:smtpTransport:user'],
				pass: config['email:smtpTransport:pass'],
			};
		}

		if (config['email:smtpTransport:service'] === 'nodebb-custom-smtp') {
			smtpOptions.port = config['email:smtpTransport:port'];
			smtpOptions.host = config['email:smtpTransport:host'];

			if (config['email:smtpTransport:security'] === 'NONE') {
				smtpOptions.secure = false;
				smtpOptions.requireTLS = false;
				smtpOptions.ignoreTLS = true;
			} else if (config['email:smtpTransport:security'] === 'STARTTLS') {
				smtpOptions.secure = false;
				smtpOptions.requireTLS = true;
				smtpOptions.ignoreTLS = false;
			} else {
				// meta.config['email:smtpTransport:security'] === 'ENCRYPTED' or undefined
				smtpOptions.secure = true;
				smtpOptions.requireTLS = true;
				smtpOptions.ignoreTLS = false;
			}
		} else {
			smtpOptions.service = String(config['email:smtpTransport:service']);
		}

		Emailer.transports.smtp = nodemailer.createTransport(smtpOptions);
		Emailer.fallbackTransport = Emailer.transports.smtp;
	} else {
		Emailer.fallbackTransport = Emailer.transports.sendmail;
	}
};

var prevConfig = meta.config;
function smtpSettingsChanged(config) {
	var settings = [
		'email:smtpTransport:enabled',
		'email:smtpTransport:user',
		'email:smtpTransport:pass',
		'email:smtpTransport:service',
		'email:smtpTransport:port',
		'email:smtpTransport:host',
		'email:smtpTransport:security',
	];

	return settings.some(function (key) {
		return config[key] !== prevConfig[key];
	});
}

Emailer.registerApp = function (expressApp) {
	app = expressApp;

	var logo = null;
	if (meta.config.hasOwnProperty('brand:emailLogo')) {
		logo = (!meta.config['brand:emailLogo'].startsWith('http') ? nconf.get('url') : '') + meta.config['brand:emailLogo'];
	}

	Emailer._defaultPayload = {
		url: nconf.get('url'),
		site_title: meta.config.title || 'NodeBB',
		logo: {
			src: logo,
			height: meta.config['brand:emailLogo:height'],
			width: meta.config['brand:emailLogo:width'],
		},
	};

	Emailer.setupFallbackTransport(meta.config);
	buildCustomTemplates(meta.config);

	// Update default payload if new logo is uploaded
	pubsub.on('config:update', function (config) {
		if (config) {
			if (config['brand:emailLogo']) {
				Emailer._defaultPayload.logo.src = config['brand:emailLogo'];
			}
			if (config['brand:emailLogo:height']) {
				Emailer._defaultPayload.logo.height = config['brand:emailLogo:height'];
			}
			if (config['brand:emailLogo:width']) {
				Emailer._defaultPayload.logo.width = config['brand:emailLogo:width'];
			}

			if (smtpSettingsChanged(config)) {
				Emailer.setupFallbackTransport(config);
			}
			buildCustomTemplates(config);

			prevConfig = config;
		}
	});

	return Emailer;
};

Emailer.send = function (template, uid, params, callback) {
	callback = callback || function () {};
	if (!app) {
		winston.warn('[emailer] App not ready!');
		return callback();
	}

	// Combined passed-in payload with default values
	params = { ...Emailer._defaultPayload, ...params };

	async.waterfall([
		function (next) {
			async.parallel({
				userData: async.apply(User.getUserFields, uid, ['email', 'username']),
				settings: async.apply(User.getSettings, uid),
			}, next);
		},
		async function (results) {
			if (!results.userData || !results.userData.email) {
				winston.warn('uid : ' + uid + ' has no email, not sending.');
				return;
			}
			params.uid = uid;
			params.username = results.userData.username;
			params.rtl = await translator.translate('[[language:dir]]', results.settings.userLang) === 'rtl';
			Emailer.sendToEmail(template, results.userData.email, results.settings.userLang, params, function (err) {
				if (err) {
					winston.error(err);
				}
			});
		},
	], function (err) {
		return callback(err);
	});
};

Emailer.sendToEmail = function (template, email, language, params, callback) {
	callback = callback || function () {};

	var lang = language || meta.config.defaultLang || 'en-GB';

	// Add some default email headers based on local configuration
	params.headers = { 'List-Id': '<' + [template, params.uid, getHostname()].join('.') + '>',
		'List-Unsubscribe': '<' + [nconf.get('url'), 'uid', params.uid, 'settings'].join('/') + '>',
		...params.headers };

	// Digests and notifications can be one-click unsubbed
	let payload = {
		template: template,
		uid: params.uid,
	};

	switch (template) {
	case 'digest':
		payload = jwt.sign(payload, nconf.get('secret'), {
			expiresIn: '30d',
		});
		params.headers['List-Unsubscribe'] = '<' + [nconf.get('url'), 'email', 'unsubscribe', payload].join('/') + '>';
		params.headers['List-Unsubscribe-Post'] = 'List-Unsubscribe=One-Click';
		break;

	case 'notification':
		payload.type = params.notification.type;
		payload = jwt.sign(payload, nconf.get('secret'), {
			expiresIn: '30d',
		});
		params.headers['List-Unsubscribe'] = '<' + [nconf.get('url'), 'email', 'unsubscribe', payload].join('/') + '>';
		params.headers['List-Unsubscribe-Post'] = 'List-Unsubscribe=One-Click';
		break;
	}

	async.waterfall([
		function (next) {
			Plugins.fireHook('filter:email.params', {
				template: template,
				email: email,
				language: lang,
				params: params,
			}, next);
		},
		function (result, next) {
			template = result.template;
			email = result.email;
			params = result.params;
			async.parallel({
				html: function (next) {
					Emailer.renderAndTranslate(template, params, result.language, next);
				},
				subject: function (next) {
					translator.translate(params.subject, result.language, function (translated) {
						next(null, translated);
					});
				},
			}, next);
		},
		function (results, next) {
			var data = {
				_raw: params,
				to: email,
				from: meta.config['email:from'] || 'no-reply@' + getHostname(),
				from_name: meta.config['email:from_name'] || 'NodeBB',
				subject: '[' + meta.config.title + '] ' + _.unescape(results.subject),
				html: results.html,
				plaintext: htmlToText.fromString(results.html, {
					ignoreImage: true,
				}),
				template: template,
				uid: params.uid,
				pid: params.pid,
				fromUid: params.fromUid,
				headers: params.headers,
				rtl: params.rtl,
			};
			Plugins.fireHook('filter:email.modify', data, next);
		},
		function (data, next) {
			if (Plugins.hasListeners('filter:email.send')) {
				Plugins.fireHook('filter:email.send', data, next);
			} else {
				Emailer.sendViaFallback(data, next);
			}
		},
	], function (err) {
		if (err && err.code === 'ENOENT') {
			callback(new Error('[[error:sendmail-not-found]]'));
		} else {
			callback(err);
		}
	});
};

Emailer.sendViaFallback = function (data, callback) {
	// Some minor alterations to the data to conform to nodemailer standard
	data.text = data.plaintext;
	delete data.plaintext;

	// NodeMailer uses a combined "from"
	data.from = data.from_name + '<' + data.from + '>';
	delete data.from_name;

	winston.verbose('[emailer] Sending email to uid ' + data.uid + ' (' + data.to + ')');
	Emailer.fallbackTransport.sendMail(data, function (err) {
		if (err) {
			winston.error(err);
		}
		callback();
	});
};

function buildCustomTemplates(config) {
	async.waterfall([
		function (next) {
			async.parallel({
				templates: function (cb) {
					Emailer.getTemplates(config, cb);
				},
				paths: function (cb) {
					file.walk(viewsDir, cb);
				},
			}, next);
		},
		function (result, next) {
			// If the new config contains any email override values, re-compile those templates
			var toBuild = Object
				.keys(config)
				.filter(prop => prop.startsWith('email:custom:'))
				.map(key => key.split(':')[2]);

			var templates = result.templates.filter(template => toBuild.includes(template.path));
			var paths = _.fromPairs(result.paths.map(function (p) {
				var relative = path.relative(viewsDir, p).replace(/\\/g, '/');
				return [relative, p];
			}));
			async.each(templates, function (template, next) {
				async.waterfall([
					function (next) {
						meta.templates.processImports(paths, template.path, template.text, next);
					},
					function (source, next) {
						Benchpress.precompile(source, {
							minify: global.env !== 'development',
						}, next);
					},
					function (compiled, next) {
						fs.writeFile(template.fullpath.replace(/\.tpl$/, '.js'), compiled, next);
					},
				], next);
			}, next);
		},
		function (next) {
			Benchpress.flush();
			next();
		},
	], function (err) {
		if (err) {
			winston.error('[emailer] Failed to build custom email templates', err);
			return;
		}

		winston.verbose('[emailer] Built custom email templates');
	});
}

Emailer.renderAndTranslate = function (template, params, lang, callback) {
	app.render('emails/' + template, params, function (err, html) {
		if (err) {
			return callback(err);
		}
		translator.translate(html, lang, function (translated) {
			callback(null, translated);
		});
	});
};

function getHostname() {
	var configUrl = nconf.get('url');
	var parsed = url.parse(configUrl);

	return parsed.hostname;
}

require('./promisify')(Emailer, ['transports']);
