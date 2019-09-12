'use strict';

module.exports = function (module) {
	module.sortedSetUnionCard = async function (keys) {
		if (!Array.isArray(keys) || !keys.length) {
			return 0;
		}

		const data = await module.client.collection('objects').aggregate([
			{ $match: { _key: { $in: keys } } },
			{ $group: { _id: { value: '$value' } } },
			{ $group: { _id: null, count: { $sum: 1 } } },
			{ $project: { _id: 0, count: '$count' } },
		]).toArray();
		return Array.isArray(data) && data.length ? data[0].count : 0;
	};

	module.getSortedSetUnion = async function (params) {
		params.sort = 1;
		return await getSortedSetUnion(params);
	};

	module.getSortedSetRevUnion = async function (params) {
		params.sort = -1;
		return await getSortedSetUnion(params);
	};

	async function getSortedSetUnion(params) {
		if (!Array.isArray(params.sets) || !params.sets.length) {
			return;
		}
		var limit = params.stop - params.start + 1;
		if (limit <= 0) {
			limit = 0;
		}

		var aggregate = {};
		if (params.aggregate) {
			aggregate['$' + params.aggregate.toLowerCase()] = '$score';
		} else {
			aggregate.$sum = '$score';
		}

		var pipeline = [
			{ $match: { _key: { $in: params.sets } } },
			{ $group: { _id: { value: '$value' }, totalScore: aggregate } },
			{ $sort: { totalScore: params.sort } },
		];

		if (params.start) {
			pipeline.push({ $skip: params.start });
		}

		if (limit > 0) {
			pipeline.push({ $limit: limit });
		}

		var project = { _id: 0, value: '$_id.value' };
		if (params.withScores) {
			project.score = '$totalScore';
		}
		pipeline.push({	$project: project });

		let data = await module.client.collection('objects').aggregate(pipeline).toArray();
		if (!params.withScores) {
			data = data.map(item => item.value);
		}
		return data;
	}
};
