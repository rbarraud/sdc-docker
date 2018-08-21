/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2017, Joyent, Inc.
 */

/*
 * Regression test for DOCKER-880: https://smartos.org/bugview/DOCKER-880.
 *
 * This test makes sure that when deleting a volume in state === 'ready' that
 * has the same name as at least one volume in a state !== 'ready', the "docker
 * volume rm" command will actually delete the volume in state === 'ready'.
 *
 * Put differently, if there's no exiting volume for a given sdc-docker account,
 * the following sequence of commands:
 *
 * 1. docker volume create --name foo
 * 2. docker volume rm foo
 * 3. docker volume create --name foo
 * 4. docker volume rm foo
 * 5. docker volume ls
 *
 * will produce no output for the last command.
 */

var assert = require('assert-plus');
var vasync = require('vasync');

var cli = require('../lib/cli');
var common = require('../lib/common');
var log = require('../lib/log');
var mod_testVolumes = require('../lib/volumes');
var volumesCli = require('../lib/volumes-cli');

var test = mod_testVolumes.createTestFunc({
    checkTritonSupportsNfsVols: true,
    checkDockerClientSupportsNfsVols: true
});

var VOLAPI_CLIENT = mod_testVolumes.getVolapiClient();

var NFS_SHARED_VOLUMES_DRIVER_NAME =
    mod_testVolumes.getNfsSharedVolumesDriverName();
var NFS_SHARED_VOLUME_NAMES_PREFIX =
    mod_testVolumes.getNfsSharedVolumesNamePrefix();

var ALICE_USER;


function makeKeepVolumeWithNameFn(volumeName) {
    assert.string(volumeName, 'volumeName');

    return function keepVolumeWithName(dockerVolumeLsOutputLine) {
        assert.string(dockerVolumeLsOutputLine, 'dockerVolumeLsOutputLine');

        var driverAndName = dockerVolumeLsOutputLine.trim().split(/\s+/);
        var name = driverAndName[1];

        if (name === volumeName) {
            return true;
        }

        return false;
    };
}

test('setup', function (tt) {
    tt.test('DockerEnv: alice init', function (t) {
        cli.init(t, function onCliInit(err, env) {
            t.ifErr(err, 'Docker environment initialization should not err');
            if (env) {
                ALICE_USER = env.user;
            }
        });
    });

    // Ensure the busybox image is around.
    tt.test('pull busybox image', function (t) {
        cli.pull(t, {
            image: 'busybox:latest'
        });
    });
});


test('cleanup leftover resources from previous tests run', function (tt) {

    tt.test('leftover volumes should be cleaned up', function (t) {
        volumesCli.deleteAllVolumes(ALICE_USER, function done(err, errMsg) {
            t.ifErr(err, 'deleting leftover volumes should succeed');
            t.end();
        });
    });
});

test('DOCKER-880', function (tt) {
    var testVolumeName =
        common.makeResourceName(NFS_SHARED_VOLUME_NAMES_PREFIX);
    var filterTestVolumesFn = makeKeepVolumeWithNameFn(testVolumeName);
    var firstVolumeUuid;

    tt.test('creating volume with name ' + testVolumeName + ' should succeed',
        function (t) {
            volumesCli.createTestVolume(ALICE_USER, {
                name: testVolumeName
            }, function volumeCreated(err, stdout, stderr) {
                t.ifErr(err,
                    'volume should have been created successfully');
                t.equal(stdout, testVolumeName + '\n',
                    'output is newly created volume\'s name');

                t.end();
            });
        }
    );

    tt.test('listing volumes should output one volume with name: '
        + testVolumeName, function (t) {
            volumesCli.listVolumes({
                user: ALICE_USER
            }, function onVolumesListed(err, stdout, stderr) {
                var outputLines;
                var testVolumes;

                t.ifErr(err, 'listing volumes should not error');
                outputLines = stdout.trim().split(/\n/);
                // Remove header from docker volume ls' output.
                outputLines = outputLines.slice(1);

                testVolumes = outputLines.filter(filterTestVolumesFn);

                t.equal(testVolumes.length, 1, 'only one volume with name '
                    + testVolumeName + ' should be listed');

                t.end();
            });
        });

    tt.test('getting first created volume\'s UUID should succeed',
        function (t) {
            VOLAPI_CLIENT.listVolumes({
                name: testVolumeName,
                predicate: JSON.stringify({
                    eq: ['state', 'ready']
                })
            }, function volumesListed(err, volumes) {
                t.ifErr(err, 'list volumes should not error');
                t.equal(volumes.length, 1, 'only one volume with name '
                    + testVolumeName + ' should be in state \'ready\'');
                firstVolumeUuid = volumes[0].uuid;

                t.end();
            });
        });

    tt.test('removing volume with name ' + testVolumeName + ' should succeed',
        function (t) {
            volumesCli.rmVolume({
                user: ALICE_USER,
                args: testVolumeName
            }, function onVolumeDeleted(err, stdout, stderr) {
                var dockerVolumeOutput;
                dockerVolumeOutput = stdout;

                t.ifErr(err,
                    'Removing an existing shared volume should not '
                        + 'error');
                t.equal(dockerVolumeOutput, testVolumeName + '\n',
                    'Output should be shared volume\'s name');

                t.end();
            });
        });

    tt.test('listing volumes should output no volume with name: '
        + testVolumeName, function (t) {
            volumesCli.listVolumes({
                user: ALICE_USER
            }, function onVolumesListed(err, stdout, stderr) {
                var outputLines;
                var testVolumes;

                t.ifErr(err, 'listing volumes should not error');
                outputLines = stdout.trim().split(/\n/);
                // Remove header from docker volume ls' output.
                outputLines = outputLines.slice(1);

                testVolumes = outputLines.filter(filterTestVolumesFn);

                t.equal(testVolumes.length, 0, 'no volume with name '
                    + testVolumeName + ' should be listed');

                t.end();
            });
        });

    tt.test('creating second volume with name ' + testVolumeName + ' should '
        + 'succeed', function (t) {
            volumesCli.createTestVolume(ALICE_USER, {
                name: testVolumeName
            }, function volumeCreated(err, stdout, stderr) {
                t.ifErr(err,
                    'volume should have been created successfully');
                t.equal(stdout, testVolumeName + '\n',
                    'output is newly created volume\'s name');

                t.end();
            });
        }
    );

    tt.test('getting second created volume\'s UUID should succeed',
        function (t) {
            VOLAPI_CLIENT.listVolumes({
                name: testVolumeName,
                predicate: JSON.stringify({
                    eq: ['state', 'ready']
                })
            }, function volumesListed(err, volumes) {
                var volumeUuid;

                t.ifErr(err, 'list volumes should not error');
                t.equal(volumes.length, 1, 'only one volume with name '
                    + testVolumeName + ' should be in state \'ready\'');

                volumeUuid = volumes[0].uuid;
                t.notEqual(volumeUuid, firstVolumeUuid,
                    'UUID of volume with name ' + testVolumeName
                        + ' should be different than the first created '
                        + 'volume ('+ firstVolumeUuid + ')');
                t.end();
            });
        });

    tt.test('listing volumes with name ' + testVolumeName + ' after second '
        + 'volume created should output only one volume', function (t) {
            volumesCli.listVolumes({
                user: ALICE_USER
            }, function onVolumesListed(err, stdout, stderr) {
                var outputLines;
                var testVolumes;

                t.ifErr(err, 'listing volumes should not error');
                outputLines = stdout.trim().split(/\n/);
                // Remove header from docker volume ls' output.
                outputLines = outputLines.slice(1);

                testVolumes = outputLines.filter(filterTestVolumesFn);

                t.equal(testVolumes.length, 1, 'only one volume with name '
                    + testVolumeName + ' should be listed');

                t.end();
            });
        });

    tt.test('removing second volume with name ' + testVolumeName + ' should '
        + 'succeed', function (t) {
            volumesCli.rmVolume({
                user: ALICE_USER,
                args: testVolumeName
            }, function onVolumeDeleted(err, stdout, stderr) {
                var dockerVolumeOutput;

                dockerVolumeOutput = stdout;

                t.ifErr(err,
                    'Removing an existing shared volume should not '
                        + 'error');
                t.equal(dockerVolumeOutput, testVolumeName + '\n',
                    'Output should be shared volume\'s name');

                t.end();
            });
        });

    tt.test('listing volumes should output no volume with name after second '
        + 'volume with name ' + testVolumeName + ' is deleted: ', function (t) {
            volumesCli.listVolumes({
                user: ALICE_USER
            }, function onVolumesListed(err, stdout, stderr) {
                var outputLines;
                var testVolumes;

                t.ifErr(err, 'listing volumes should not error');
                outputLines = stdout.trim().split(/\n/);
                // Remove header from docker volume ls' output.
                outputLines = outputLines.slice(1);

                testVolumes = outputLines.filter(filterTestVolumesFn);

                t.equal(testVolumes.length, 0, 'no volume with name '
                    + testVolumeName + ' should be listed');

                t.end();
            });
        });
});
