#!/usr/bin/nodejs
'use strict';

var config = require('./config');

var fs = require('fs');
var Q = require('q');
var DockerEvents = require('docker-events');
var Docker = require('dockerode');
var nunjucks = require('nunjucks');
var child_process = require('child_process');

var docker = new Docker({socketPath: '/tmp/docker.sock'});
var emitter = new DockerEvents({
    docker: docker
});

nunjucks.configure(config['tmpl_dir'], { autoescape: true });

var generateNginx = function (config, virtuals) {

    fs.createReadStream(config['tmpl_dir']+'/default.conf').pipe(fs.createWriteStream(config['conf_dir']+'/default.conf'));


    for (var virtualKey in virtuals) {
        console.log("Generating: "+config['conf_dir']+'/'+virtual['host']+'.generated.conf');
        var virtual = virtuals[virtualKey];
        fs.writeFileSync(
            config['conf_dir']+'/'+virtual['host']+'.generated.conf',
            nunjucks.render('virtual.conf.twig', {'virtual': virtual})
        );
    }

    console.log("Restarting nginx");
    child_process.exec('nginx -s reload', function(error, stdout, stderr){

        if (error) {
            console.error(error);
        }
        console.log(stdout);
    });
};

var getVirtuals = function () {
    var deferred = Q.defer();

    docker.listContainers(function (err, containers) {
        var promises = [];

        if (err) {
            return deferred.reject(err);
        }

        containers.forEach(function (container) {
            var container = docker.getContainer(container.Id);

            var deferred = Q.defer();

            container.inspect(function (err, container) {
                if (err) {
                    return deferred.reject(err);
                }

                deferred.resolve(container);
            });

            promises.push(deferred.promise);
        });

        Q
            .all(promises)
            .then(function (containers) {

                var virtuals = [];
                containers.forEach(function (container) {
                    var env = {};

                    container.Config.Env.forEach(function (row) {
                        var idx = row.indexOf('=');
                        env[row.substr(0, idx)] = row.substr(idx + 1);
                    });

                    if (env['VIRTUAL_URL']) {
                        var host, path;
                        var idx = ['VIRTUAL_URL'].indexOf('/');
                        if (idx == -1) {
                            host = env['VIRTUAL_URL'];
                            path = '/';
                        } else {
                            host = env['VIRTUAL_URL'].substr(0, idx);
                            path = env['VIRTUAL_URL'].substr(idx);
                        }

                        if (!virtuals[host]) {
                            virtuals[host] = {};
                            virtuals[host]['host'] = host;
                            virtuals[host]['containers'] = [];
                            virtuals[host]['paths'] = {};
                        }

                        if (env['CERT_NAME']) {
                            try {
                                var stats = fs.lstatSync('/etc/nginx/certs/'+env['CERT_NAME']+'.crt');
                                if (stats.isFile()) {
                                    virtuals[host]['CERT_NAME'] = env['CERT_NAME'];
                                }
                            } catch (err) {
                            }
                        }

                        if (!env['VIRTUAL_PORT']) {
                            var ports = [];

                            for (var key in container.Config.ExposedPorts) {
                                key = key.split('/');
                                if (key[1] != 'tcp') continue;
                                ports.push({
                                    PublicPort: key[0]
                                })
                            }
                            if (1 == ports.length && (ports[0]['PublicPort'])) {
                                env['VIRTUAL_PORT'] = ports[0]['PublicPort'];
                            }
                        }
                        if (!env['VIRTUAL_PORT']) {
                            env['VIRTUAL_PORT'] = 80;
                        }

                        env['VIRTUAL_PATH'] = path;
                        if (!virtuals[host]['paths'][path]) {
                            virtuals[host]['paths'][path] = [];
                        }
                        container.Env = env;

                        virtuals[host]['paths'][path].push(container);
                        virtuals[host]['containers'].push(container);
                    }

                });

                deferred.resolve(virtuals);
            })
            .catch(function (err) {
                deferred.reject(err);
            })

    });

    return deferred.promise;
};

var regenerate = function () {
    console.log("Regenerate");
    getVirtuals()
        .then(function (virtuals) {
            generateNginx(config, virtuals);
        })
        .catch(function (err) {
            console.error(err);
        });
};

regenerate();

emitter.on("create", function(message) {
    regenerate();
});
emitter.on("start", function(message) {
    regenerate();
});
emitter.on("stop", function(message) {
    regenerate();
});
emitter.on("die", function(message) {
    regenerate();
});
emitter.on("destroy", function(message) {
    regenerate();
});

emitter.start();
