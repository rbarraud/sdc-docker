/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2018, Joyent, Inc.
 */

var assert = require('assert-plus');
var drc = require('docker-registry-client');
var format = require('util').format;
var fs = require('fs');
var restify = require('restify');
var vasync = require('vasync');

var common = require('../common');
var errors = require('../errors');


// --- globals

var p = console.log; //XXX


// --- endpoint handlers

/**
 * GET /images/json
 */
function imageList(req, res, next) {
    var log = req.log;
    var options = {};

    options.log = req.log;
    options.req_id = req.getId();
    options.app = req.app;
    options.all = common.boolFromQueryParam(req.query.all);
    options.clientApiVersion = req.clientApiVersion;
    options.filters = req.query.filters;
    options.skip_smartos = true;
    options.account = req.account;

    req.backend.listImages(options, function (err, images) {
        if (err) {
            log.error({err: err}, 'Problem loading images');
            next(new errors.DockerError(err, 'problem loading images'));
            return;
        }

        res.send(images);
        next();
    });
}


/**
 * `POST /images/create`, i.e. `docker pull` or `docker import`
 *
 * TODO actual validation: check image data on moray
 * TODO error handling
 */
function imageCreate(req, res, next) {
    // `docker import` is not supported yet
    if (req.query.fromSrc !== undefined) {
        return next(new errors.NotImplementedError('image create'));
    }

    var log = req.log;

    /*
     * Node's default HTTP timeout is two minutes, add a little longer in case
     * another component times out after 2 minutes - which should give enough
     * time to report any timeout errors before closing the connection.
     */
    req.connection.setTimeout(150 * 1000);

    /*
     * docker pull -a foo     ->  fromImage=foo
     * docker pull foo        ->  fromImage=foo:latest
     * docker pull foo@DIGEST ->  fromImage=foo@DIGEST
     * docker pull ???        ->  fromImage=???&tag=???  # When is 'tag' used?
     *
     * `parseRepoAndRef` will default tag="latest" if no tag is given, so
     * we unwind that to detect 'docker pull -a ...'.
     */
    try {
        var rat = drc.parseRepoAndRef(req.query.fromImage);
    } catch (e) {
        next(new errors.DockerError(e, e.toString()));
        return;
    }
    // TODO(DOCKER-587): is this `all = ...` accurate with digest in play?
    var all = (!req.query.tag
        && rat.tag && rat.tag === 'latest'
        && req.query.fromImage.slice(-':latest'.length) !== ':latest');
    if (all) {
        next(new errors.NotImplementedError('docker pull -a'));
        return;
    }
    if (req.query.tag) {
        if (req.query.tag.substr(0, 7) === 'sha256:') {
            rat.digest = req.query.tag;
            rat.tag = '';
        } else {
            rat.tag = req.query.tag;
        }
    }


    res.status(200);
    res.header('Content-Type', 'application/json');

    req.backend.pullImage({
        app: req.app,
        log: log,
        rat: rat,
        req: req,
        req_id: req.getId(),
        res: res,
        wfapi: req.wfapi,
        account: req.account
    }, function () {
        // XXX NOTHING returned from this??? No 'err'?
        req.app.sockets.removeSocket('job', rat.canonicalName);
        res.end();
        next(false); // XXX need this early abort?
    });
}


/**
 * `GET /images/:name/json`, called eventually from `docker inspect ...`
 *
 * `:name` can be name[:tag] (tag defaults to "latest") or id.
 */
function imageInspect(req, res, next) {
    req.backend.inspectImage({
        app: req.app,
        account: req.account,
        name: req.params.name,
        log: req.log
    }, function (err, image) {
        if (err) {
            next(err);
            return;
        }
        res.send(image);
        next();
    });
}


/**
 * `GET /images/:name/history`, `docker history`
 *
 * Note: req.image is already populated by the reqImage() handler.
 */
function imageHistory(req, res, next) {
    req.backend.getImageHistory({
        app: req.app,
        account: req.account,
        img: req.image,
        log: req.log
    }, function (histErr, history) {
        if (histErr) {
            next(histErr);
            return;
        }
        res.send(history);
        next();
    });
}


/**
 * POST /images/:name/push
 *
 * Push image (or multiple multiple images in the same repo) to the registry.
 *
 * Note: req.images and req.imageTags get populated by the reqImagesAndTags()
 * handler.
 */
function imagePush(req, res, next) {
    assert.arrayOfObject(req.images, 'req.images');
    assert.arrayOfObject(req.imageTags, 'req.imageTags');

    try {
        var rat = drc.parseRepoAndTag(req.params.name);
    } catch (e) {
        next(new errors.DockerError(e, e.message));
        return;
    }

    // At this point, all messages will be passed back to client using a JSON
    // stream.
    res.status(200);
    res.header('Content-Type', 'application/json');

    var msgPayload = {
        status: format('The push refers to a repository [%s]',
            rat.canonicalName)
    };
    res.write(JSON.stringify(msgPayload) + '\r\n');

    var idx = 0;

    vasync.forEachPipeline({
        inputs: req.images,
        func: function _pushOneImage(img, cb) {
            rat.tag = req.imageTags[idx].tag;
            idx += 1;

            var repoAndTag = rat.canonicalName + ':' + rat.tag;
            req.log.debug({rat:rat, repoAndTag: repoAndTag}, 'imagePush');

            req.backend.pushImage({
                image: img,
                rat: rat,
                repoAndTag: repoAndTag,
                req: req,
                res: res
            }, cb);
        }
    }, function _vasyncPipelinePushCb(err) {
        if (err) {
            req.log.error({err: err}, 'backend.pushImage failed');
            // Note that err will have already been sent back to the client
            // in the req.backend.pushImage method.
        }
        res.end();
        next();
    });
}


/**
 * GET /images/:name/changes
 */
function imageChanges(req, res, next) {
    return next(new errors.NotImplementedError('image changes'));
}


/**
 * GET /images/:name/tag
 *
 * Note: req.image is already populated by the reqImage() handler.
 */
function imageTag(req, res, next) {
    // Create name string in format 'repo:tag'
    var repoAndTag = req.query.repo || '';
    if (req.query.tag) {
        repoAndTag += ':' + req.query.tag;
    }

    // Ensure the tag name is valid.
    try {
        drc.parseRepoAndTag(repoAndTag);
    } catch (e) {
        next(new errors.DockerError(e, e.message));
        return;
    }

    req.backend.tagImage({
        img: req.image,
        name: repoAndTag,
        req: req
    }, function (err, history) {
        if (err) {
            req.log.error({err: err}, 'backend.imageTag failed');
            next(err);
            return;
        }
        res.status(201);  // Okay - tag was created.
        res.end();
        next();
    });
}


/**
 * DELETE /images/:name
 */
function imageDelete(req, res, next) {
    req.backend.deleteImage({
        app: req.app,
        log: req.log,
        req_id: req.getId(),
        account: req.account,
        name: req.params.name,
        force: common.boolFromQueryParam(req.query.force)
    }, function (err, history) {
        if (err) {
            req.log.error({err: err}, 'backend.imageDelete failed');
            next(err);
            return;
        }
        res.send(history);
        next();
    });
}


/**
 * `GET /images/search?term=TERM`, `docker search`.
 *
 * Examples for TERM (optionally includes a registry):
 *      busybox
 *      quay.io/foo
 *      localhost:5000/blah/bling
 */
function imageSearch(req, res, next) {
    var log = req.log;

    try {
        var repo = drc.parseRepo(req.query.term);
    } catch (parseErr) {
        return next(new errors.ValidationError(parseErr, parseErr.message));
    }

    /*
     * Per docker.git:registry/config.go#RepositoryInfo.GetSearchTerm()
     * avoid the "library/" auto-prefixing done for the "official" index.
     * Basically using `parseRepo` for the search arg is a light
     * hack because the term isn't a "repo" string.
     */
    var term = repo.index.official ? repo.localName : repo.remoteName;

    var regClient = drc.createClientV1(common.httpClientOpts({
        name: repo.canonicalName,
        log: log,
        insecure: req.app.config.dockerRegistryInsecure,
        username: req.regAuth && req.regAuth.username,
        password: req.regAuth && req.regAuth.password
    }, req));
    regClient.search({term: term}, function (err, body) {
        regClient.close();
        log.info({repo: repo.canonicalName, term: term, err: err,
            num_results: body && body.num_results}, 'search results');
        if (err) {
            next(err);
            return;
        }
        res.send(body.results);
        next();
    });
}


/**
 * GET /images/:name/get
 */
function imageGet(req, res, next) {
    return next(new errors.NotImplementedError('image get'));
}


/**
 * POST /images/:name/load
 */
function imageLoad(req, res, next) {
    return next(new errors.NotImplementedError('image load'));
}



// --- exports

/**
 * Register all endpoints with the restify server
 */
function register(config, http, before) {

    function reqParamsName(req, res, next) {
        req.params.name = unescape(req.params[1]);
        next();
    }

    function reqImage(req, res, next) {
        req.backend.imgFromName({
            app: req.app,
            account: req.account,
            log: req.log,
            name: req.params.name
        }, function (err, img) {
            if (err) {
                next(err);
                return;
            }
            if (!img) {
                next(new errors.ResourceNotFoundError(
                    'No such image: ' + req.params.name));
                return;
            }
            req.image = img;
            next();
        });
    }

    function reqImagesAndTags(req, res, next) {
        req.backend.tagsFromRepoName({
            req: req,
            repo: req.params.name,
            tag: req.query.tag
        }, function (err, imgTags) {
            if (err) {
                next(err);
                return;
            }
            if (imgTags.length === 0) {
                next(new errors.ResourceNotFoundError(format(
                    'An image does not exist locally with the tag: %s',
                    req.params.name)));
                return;
            }

            // Lookup all the matching Image objects.
            var images = [];

            vasync.forEachPipeline({
                inputs: imgTags,
                func: _getImageFromImgTag
            }, function (getErr) {
                req.images = images;
                req.imageTags = imgTags;
                next(getErr);
            });

            function _getImageFromImgTag(imgTag, cb) {
                var getDigestOpts = {
                    account: req.account,
                    app: req.app,
                    config_digest: imgTag.config_digest,
                    log: req.log
                };
                req.backend.imgFromConfigDigest(getDigestOpts,
                        function _imgFromConfigDigestCb(err2, img) {
                    if (err2) {
                        cb(err2);
                        return;
                    }
                    images.push(img);
                    cb();
                });
            }
        });
    }

    http.get({ path: /^(\/v[^\/]+)?\/images\/json$/, name: 'ImageList' },
        before, restify.queryParser({mapParams: false}), imageList);

    http.post({ path: /^(\/v[^\/]+)?\/images\/create$/, name: 'ImageCreate' },
            before, common.checkApprovedForProvisioning,
            restify.queryParser({mapParams: false}), imageCreate);

    /*
     * Match '/:apiversion/images/:name/json' where ':name' can have one
     * or more '/'. IIUC, Docker registry V2 allows multiple '/'s in a
     * repo name.
     */
    http.get(
        { path: /^(\/v[^\/]+)?\/images\/(.*?)\/json$/, name: 'ImageInspect' },
        reqParamsName, before, imageInspect);

    // Match '/:apiversion/images/:name/history' where ':name' can include '/'.
    http.get(
        { path: /^(\/v[^\/]+)?\/images\/(.*?)\/history$/,
            name: 'ImageHistory' },
        reqParamsName, before, reqImage, imageHistory);

    // Match '/:apiversion/images/:name/push' where ':name' can include '/'.
    http.post(
        { path: /^(\/v[^\/]+)?\/images\/(.*?)\/push$/, name: 'ImagePush' },
        reqParamsName, before, restify.queryParser({mapParams: false}),
        reqImagesAndTags, imagePush);

    // Match '/:apiversion/images/:name/tag' where ':name' can include '/'.
    http.post(
        { path: /^(\/v[^\/]+)?\/images\/(.*?)\/tag$/, name: 'ImageTag' },
        reqParamsName, before, reqImage,
        restify.queryParser({mapParams: false}), imageTag);

    // Match '/:apiversion/images/:name' where ':name' can include '/'.
    http.del(
        { path: /^(\/v[^\/]+)?\/images\/(.*?)$/, name: 'ImageDelete' },
        reqParamsName, before,
        restify.queryParser({mapParams: false}), imageDelete);

    http.get({ path: /^(\/v[^\/]+)?\/images\/search$/, name: 'ImageSearch' },
        before, restify.queryParser({mapParams: false}),
        common.reqRegAuth, imageSearch);

    // Match '/:apiversion/images/:name/get' where ':name' can include '/'.
    http.get(
        { path: /^(\/v[^\/]+)?\/images\/(.*?)\/get$/, name: 'ImageGet' },
        reqParamsName, before, imageGet);

    // Match '/:apiversion/images/:name/load' where ':name' can include '/'.
    http.post(
        { path: /^(\/v[^\/]+)?\/images\/(.*?)\/load$/, name: 'ImageLoad' },
        reqParamsName, before, imageLoad);
}



module.exports = {
    register: register
};
