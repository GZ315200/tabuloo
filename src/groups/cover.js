'use strict';

const path = require('path');

const db = require('../database');
const image = require('../image');
const file = require('../file');

module.exports = function (Groups) {
	Groups.updateCoverPosition = async function (groupName, position) {
		if (!groupName) {
			throw new Error('[[error:invalid-data]]');
		}
		await Groups.setGroupField(groupName, 'cover:position', position);
	};

	Groups.updateCover = async function (uid, data) {
		let tempPath = data.file ? data.file : '';
		try {
			// Position only? That's fine
			if (!data.imageData && !data.file && data.position) {
				return await Groups.updateCoverPosition(data.groupName, data.position);
			}
			if (!tempPath) {
				tempPath = await image.writeImageDataToTempFile(data.imageData);
			}
			const filename = 'groupCover-' + data.groupName + path.extname(tempPath);
			const uploadData = await image.uploadImage(filename, 'files', {
				path: tempPath,
				uid: uid,
				name: 'groupCover',
			});
			const url = uploadData.url;
			await Groups.setGroupField(data.groupName, 'cover:url', url);

			await image.resizeImage({
				path: tempPath,
				width: 358,
			});
			const thumbUploadData = await image.uploadImage('groupCoverThumb-' + data.groupName + path.extname(tempPath), 'files', {
				path: tempPath,
				uid: uid,
				name: 'groupCover',
			});
			await Groups.setGroupField(data.groupName, 'cover:thumb:url', thumbUploadData.url);

			if (data.position) {
				await Groups.updateCoverPosition(data.groupName, data.position);
			}

			return { url: url };
		} finally {
			file.delete(tempPath);
		}
	};

	Groups.removeCover = async function (data) {
		await db.deleteObjectFields('group:' + data.groupName, ['cover:url', 'cover:thumb:url', 'cover:position']);
	};
};
