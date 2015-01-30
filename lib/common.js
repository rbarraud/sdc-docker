/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2014, Joyent, Inc.
 */

var assert = require('assert-plus');
var restify = require('restify');
var sprintf = require('sprintf').sprintf;
var UUID = require('node-uuid');

var SERVER_VERSION = '1.16';


/**
 * Given a duration in seconds, return a human-friendly string.
 */

function humanDuration(seconds) {
    var minutes = seconds / 60;
    var hours = minutes / 60;
    var days = hours / 24;
    var weeks = days / 7;
    var months = days / 30;
    var years = days / 365;

    if (seconds < 1) {
        return 'Less than a second';
    } else if (seconds < 60) {
        return sprintf('%d seconds', seconds);
    } else if (Math.floor(minutes) === 1) {
        return 'About a minute';
    } else if (minutes < 60) {
        return sprintf('%d minutes', minutes);
    } else if (Math.floor(hours) === 1) {
        return 'About an hour';
    } else if (hours < 48) {
        return sprintf('%d hours', hours);
    } else if (weeks < 2) {
        return sprintf('%d days', days);
    } else if (months < 3) {
        return sprintf('%d weeks', weeks);
    } else if (years < 2) {
        return sprintf('%d months', months);
    }

    return sprintf('%0.6f years', years);
}

var STREAM_TYPES = {
    stdin: 0,
    stdout: 1,
    stderr: 2
};

/**
 * Write to docker-raw compatible streams
 */
function writeToDockerRawStream(type, stream, data) {
    var streamType = STREAM_TYPES[type];
    var messageSize = data.length;
    var message = new Buffer(8 + messageSize);

    message.writeUInt8(streamType, 0);
    message[1] = 0;
    message[2] = 0;
    message[3] = 0;
    message.writeUInt32BE(messageSize, 4);
    message.write(data.toString(), 8);
    stream.write(message);
}

/**
 * Generate a random docker Id. For now just use uuid()+uuid(). Need to verify
 * the rules docker use for generating these Ids
 */
function generateDockerId() {
    return (UUID.v4() + UUID.v4()).replace(/-/g, '');
}


/**
 * Helps formatting a JSON progress message that a docker client will understand
 * and properly format when running docker pull or docker import
 */
function formatProgress(args) {
    var progress = {};
    progress.id = (args.id && args.id.substr(0, 12)) || '';
    progress.status = args.status;
    progress.progressDetail = args.progressDetail;

    return progress;
}


/**
 * Writes a JSON progress object to an HTTP response object. Docker
 * expects a progressDetail object even if it's empty
 */
function writeProgress(res, progress) {
    if (!progress.progressDetail) {
        progress.progressDetail = {};
    }
    res.write(JSON.stringify(formatProgress(progress)));
}

/**
 * Writes a JSON status object to an HTTP response object
 */
function writeStatus(res, progress) {
    res.write(JSON.stringify(formatProgress(progress)));
}


/*
 * Wait for a job to complete.  Returns an error if the job fails with an error
 * other than the (optional) list of expected errors. Taken from SAPI and
 * adapted to use a wf-client
 */
function waitForJob(wfClient, job_uuid, cb) {
    assert.string(job_uuid, 'job_uuid');
    assert.func(cb, 'cb');

    pollJob(wfClient, job_uuid, function (err, job) {
        if (err)
            return cb(err);
        var result = job.chain_results.pop();
        if (result.error) {
            var errmsg = result.error.message || JSON.stringify(result.error);
            return cb(new Error(errmsg));
        } else {
            return cb();
        }
    });
}


/*
 * Poll a job until it reaches either the succeeded or failed state.
 * Taken from SAPI.
 *
 * Note: if a job fails, it's the caller's responsibility to check for a failed
 * job.  The error object will be null even if the job fails.
 */
function pollJob(client, job_uuid, cb) {
    var attempts = 0;
    var errors = 0;

    var timeout = 1000;  // 1 second
    var limit = 720;     // 1 hour

    var poll = function () {
        client.getJob(job_uuid, function (err, job) {
            attempts++;

            if (err) {
                errors++;
                if (errors >= 5) {
                    return cb(err);
                } else {
                    return setTimeout(poll, timeout);
                }
            }

            if (job && job.execution === 'succeeded') {
                return cb(null, job);
            } else if (job && job.execution === 'failed') {
                return cb(null, job);
            } else if (attempts > limit) {
                return cb(new Error('polling for job timed out'), job);
            }

            return setTimeout(poll, timeout);
        });
    };

    poll();
}


/*
 * Returns a handler that will prevent logging successful GET requests
 * because their response bodies can be too big in many cases
 */
function filteredAuditLog(req, res, route, err) {
    restify.auditLogger({
        log: req.log.child({
            component: 'audit',
            route: route && route.name
        }, true),

        // Successful GET res bodies are uninteresting and *big*.
        body: !((req.method === 'GET')
            && Math.floor(res.statusCode/100) === 2)
    })(req, res, route, err);
}


/*
 * Returns a handler that will log uncaught exceptions properly
 */
function uncaughtHandler(req, res, route, err) {
    res.send(new restify.InternalError(err, 'Internal error'));
    /**
     * We don't bother logging the `res` here because it always looks like
     * the following, no added info to the log.
     *
     *      HTTP/1.1 500 Internal Server Error
     *      Content-Type: application/json
     *      Content-Length: 51
     *      Date: Wed, 29 Oct 2014 17:33:02 GMT
     *      x-request-id: a1fb11c0-5f91-11e4-92c7-3755959764aa
     *      x-response-time: 9
     *      Connection: keep-alive
     *
     *      {"code":"InternalError","message":"Internal error"}
     */
    req.log.error({err: err, route: route && route.name,
        req: req}, 'Uncaught exception');
}


/*
 * Handler for checking if the required servics are online before serving
 * any request
 */
function checkServices(req, res, next) {
    if (!req.app.moray) {
        return next(new restify.ServiceUnavailableError(
            'Moray client not initialized'));
    }

    return next();
}

/*
 * Handler for checking if the API version is reasonale before serving
 * any request
 */
function checkApiVersion(req, res, next) {
    var apiversion = req.params.apiversion;
    var log = req.log;
    var versionless;

    // list of endpoints which don't need a version
    versionless = [
        'CreateImageTag',
        'ListImageTags',
        'ping'
    ];

    if (versionless.indexOf(req.route.name) !== -1) {
        log.trace({path: req.route.name}, 'request doesn\'t need version');
        return next();
    }

    if (!apiversion) {
        return next(new restify.InvalidVersionError(
            'client request is missing version'));
    }

    if (apiversion.match(/^v[0-9\.]+$/)) {
        apiversion = Number(apiversion.slice(1));
        if ((apiversion !== NaN) && (apiversion >= 1.15)) {
            log.trace({apiversion: apiversion}, 'request has ok API version');
            return next();
        }
    }

    log.warn({apiversion: apiversion, req: req},
        'request has invalid API version');

    return next(new restify.InvalidVersionError(
        'client and server don\'t have same version '
        + '(client : ' + apiversion + ', server: ' + SERVER_VERSION + ')'));
}


module.exports = {
    checkApiVersion: checkApiVersion,
    checkServices: checkServices,
    filteredAuditLog: filteredAuditLog,
    humanDuration: humanDuration,
    writeToDockerRawStream: writeToDockerRawStream,
    generateDockerId: generateDockerId,
    formatProgress: formatProgress,
    uncaughtHandler: uncaughtHandler,
    waitForJob: waitForJob,
    writeProgress: writeProgress,
    writeStatus: writeStatus,
    SERVER_VERSION: SERVER_VERSION
};
