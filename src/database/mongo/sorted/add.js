'use strict';

module.exports = function (module) {
	var helpers = require('../helpers');
	var utils = require('../../../utils');

	module.sortedSetAdd = async function (key, score, value) {
		if (!key) {
			return;
		}
		if (Array.isArray(score) && Array.isArray(value)) {
			return await sortedSetAddBulk(key, score, value);
		}
		if (!utils.isNumber(score)) {
			throw new Error('[[error:invalid-score, ' + score + ']]');
		}
		value = helpers.valueToString(value);

		try {
			await module.client.collection('objects').updateOne({ _key: key, value: value }, { $set: { score: parseFloat(score) } }, { upsert: true, w: 1 });
		} catch (err) {
			if (err && err.message.startsWith('E11000 duplicate key error')) {
				return await module.sortedSetAdd(key, score, value);
			}
			throw err;
		}
	};

	async function sortedSetAddBulk(key, scores, values) {
		if (!scores.length || !values.length) {
			return;
		}
		if (scores.length !== values.length) {
			throw new Error('[[error:invalid-data]]');
		}
		for (let i = 0; i < scores.length; i += 1) {
			if (!utils.isNumber(scores[i])) {
				throw new Error('[[error:invalid-score, ' + scores[i] + ']]');
			}
		}
		values = values.map(helpers.valueToString);

		var bulk = module.client.collection('objects').initializeUnorderedBulkOp();
		for (var i = 0; i < scores.length; i += 1) {
			bulk.find({ _key: key, value: values[i] }).upsert().updateOne({ $set: { score: parseFloat(scores[i]) } });
		}
		await bulk.execute();
	}

	module.sortedSetsAdd = async function (keys, scores, value) {
		if (!Array.isArray(keys) || !keys.length) {
			return;
		}
		const isArrayOfScores = Array.isArray(scores);
		if (!isArrayOfScores && !utils.isNumber(scores)) {
			throw new Error('[[error:invalid-score, ' + scores + ']]');
		}

		if (isArrayOfScores && scores.length !== keys.length) {
			throw new Error('[[error:invalid-data]]');
		}

		value = helpers.valueToString(value);

		var bulk = module.client.collection('objects').initializeUnorderedBulkOp();
		for (var i = 0; i < keys.length; i += 1) {
			bulk.find({ _key: keys[i], value: value }).upsert().updateOne({ $set: { score: parseFloat(isArrayOfScores ? scores[i] : scores) } });
		}
		await bulk.execute();
	};

	module.sortedSetAddBulk = async function (data) {
		if (!Array.isArray(data) || !data.length) {
			return;
		}
		var bulk = module.client.collection('objects').initializeUnorderedBulkOp();
		data.forEach(function (item) {
			bulk.find({ _key: item[0], value: String(item[2]) }).upsert().updateOne({ $set: { score: parseFloat(item[1]) } });
		});
		await bulk.execute();
	};
};
