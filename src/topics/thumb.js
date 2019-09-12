
'use strict';

var nconf = require('nconf');
var path = require('path');
var fs = require('fs');
var request = require('request');
var mime = require('mime');
var validator = require('validator');
var util = require('util');

var meta = require('../meta');
var image = require('../image');
var file = require('../file');
var plugins = require('../plugins');

module.exports = function (Topics) {
	const getHead = util.promisify(request.head);

	function pipeToFile(source, destination, callback) {
		request(source).pipe(fs.createWriteStream(destination)).on('close', callback);
	}
	const pipeToFileAsync = util.promisify(pipeToFile);

	Topics.resizeAndUploadThumb = async function (data) {
		if (!data.thumb || !validator.isURL(data.thumb)) {
			return;
		}
		var pathToUpload;
		const res = await getHead(data.thumb);

		try {
			const type = res.headers['content-type'];
			if (!type.match(/image./)) {
				throw new Error('[[error:invalid-file]]');
			}

			var extension = path.extname(data.thumb);
			if (!extension) {
				extension = '.' + mime.getExtension(type);
			}
			const filename = Date.now() + '-topic-thumb' + extension;
			pathToUpload = path.join(nconf.get('upload_path'), 'files', filename);

			await pipeToFileAsync(data.thumb, pathToUpload);

			await file.isFileTypeAllowed(pathToUpload);

			await image.resizeImage({
				path: pathToUpload,
				width: meta.config.topicThumbSize,
				height: meta.config.topicThumbSize,
			});

			if (!plugins.hasListeners('filter:uploadImage')) {
				data.thumb = '/assets/uploads/files/' + filename;
				return;
			}

			const uploadedFile = await plugins.fireHook('filter:uploadImage', { image: { path: pathToUpload, name: '' }, uid: data.uid });
			file.delete(pathToUpload);
			data.thumb = uploadedFile.url;
		} catch (err) {
			file.delete(pathToUpload);
			throw err;
		}
	};
};
