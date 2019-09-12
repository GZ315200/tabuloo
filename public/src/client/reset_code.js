'use strict';


define('forum/reset_code', ['zxcvbn'], function (zxcvbn) {
	var	ResetCode = {};

	ResetCode.init = function () {
		var reset_code = ajaxify.data.code;

		var resetEl = $('#reset');
		var password = $('#password');
		var repeat = $('#repeat');

		resetEl.on('click', function () {
			var strength = zxcvbn(password.val());
			if (password.val().length < ajaxify.data.minimumPasswordLength) {
				$('#notice').removeClass('hidden');
				$('#notice strong').translateText('[[reset_password:password_too_short]]');
			} else if (password.val().length > 512) {
				$('#notice').removeClass('hidden');
				$('#notice strong').translateText('[[error:password-too-long]]');
			} else if (password.val() !== repeat.val()) {
				$('#notice').removeClass('hidden');
				$('#notice strong').translateText('[[reset_password:passwords_do_not_match]]');
			} else if (strength.score < ajaxify.data.minimumPasswordStrength) {
				$('#notice').removeClass('hidden');
				$('#notice strong').translateText('[[user:weak_password]]');
			} else {
				resetEl.prop('disabled', true).html('<i class="fa fa-spin fa-refresh"></i> Changing Password');
				socket.emit('user.reset.commit', {
					code: reset_code,
					password: password.val(),
				}, function (err) {
					if (err) {
						ajaxify.refresh();
						return app.alertError(err.message);
					}

					window.location.href = config.relative_path + '/login';
				});
			}
			return false;
		});
	};

	return ResetCode;
});
