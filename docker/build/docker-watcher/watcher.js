#!/usr/bin/nodejs
'use strict';

const config = {
    'tmpl_dir': process.env.TMPL_DIR || '/app',
    'conf_dir': process.env.NGINX_CONF_DIR || '/etc/nginx/conf.d'
};

const fs = require('fs');
const DockerEvents = require('docker-events');
const Docker = require('dockerode');
const nunjucks = require('nunjucks');
const child_process = require('child_process');
const glob = require("glob");

const docker = new Docker({socketPath: '/tmp/docker.sock'});
const emitter = new DockerEvents({
    docker: docker
});

nunjucks.configure(config['tmpl_dir'], { autoescape: true });

const generateNginx = (config, virtuals) => {
    fs.createReadStream(config['tmpl_dir']+'/default.conf').pipe(fs.createWriteStream(config['conf_dir']+'/default.conf'));

    glob(config['conf_dir']+'/*.generated.conf', function (er, files) {
        files.forEach((fileName) => {
            fs.unlinkSync(fileName);
        })
    });

    for (let virtualKey in virtuals) {
        const virtual = virtuals[virtualKey];

        const generatedConfig = config['conf_dir']+'/'+virtual['host'].replace(/\//gi, '_')+'.generated.conf';

        console.log("Generating: "+generatedConfig);
        // console.log("Generating: "+generatedConfig, virtual['host'], virtual['paths']);

        if (virtual['CERT_NAME']) {
            fs.writeFileSync(
                generatedConfig,
                nunjucks.render('virtual.ssl.conf.nunjucks', {'virtual': virtual})
            );
        } else {
            fs.writeFileSync(
                generatedConfig,
                nunjucks.render('virtual.conf.nunjucks', {'virtual': virtual})
            );
        }
    }

    console.log("Restarting nginx");
    child_process.exec('nginx -s reload', function(error, stdout, stderr){

        if (error) {
            console.error(error);
        }
        console.log(stdout);
    });
};

const getVirtuals = () => {
    return new Promise((resolve, reject) => {
        docker.listContainers((err, listedContainers) => {
            const promises = [];

            if (err) {
                return reject(err);
            }

            listedContainers.forEach((listedContainer) => {
                const dockerContainer = docker.getContainer(listedContainer.Id);

                promises.push(new Promise((resolve, reject) => {
                    dockerContainer.inspect((err, inspectedContainer) => {
                        if (err) {
                            return reject(err);
                        }

                        resolve(inspectedContainer);
                    });
                }));
            });

            Promise
                .all(promises)
                .then((inspectedContainers) => {

                    const virtuals = {};
                    inspectedContainers.forEach((inspectedContainer) => {
                        const env = {};

                        inspectedContainer.Config.Env.forEach((row) => {
                            const idx = row.indexOf('=');
                            env[row.substr(0, idx)] = row.substr(idx + 1);
                        });

                        if (env['VIRTUAL_URL']) {
                            let host, path;
                            let idx = env['VIRTUAL_URL'].indexOf('/');
                            if (idx < 0) {
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
                                    const stats = fs.lstatSync('/etc/nginx/certs/'+env['CERT_NAME']+'.crt');
                                    if (stats.isFile()) {
                                        virtuals[host]['CERT_NAME'] = env['CERT_NAME'];
                                    }
                                } catch (err) {
                                }
                            }

                            if (!env['VIRTUAL_PORT']) {
                                const ports = [];

                                for (let key in inspectedContainer.Config.ExposedPorts) {
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

                            if (!virtuals[host]['paths'][path]) {
                                virtuals[host]['paths'][path] = [];
                            }
                            inspectedContainer.Env = env;

                            virtuals[host]['paths'][path].push(inspectedContainer);
                            virtuals[host]['containers'].push(inspectedContainer);
                        }

                    });

                    resolve(virtuals);
                })
                .catch((err) => {
                    reject(err);
                })

        });
    });
};

const regenerate = () => {
    console.log("Regenerate");
    getVirtuals()
        .then((virtuals) => {
            generateNginx(config, virtuals);
        })
        .catch((err) => {
            console.error(err);
        });
};

regenerate();

emitter.on("create", () => {
    regenerate();
});
emitter.on("start", () => {
    regenerate();
});
emitter.on("stop", () => {
    regenerate();
});
emitter.on("die", () => {
    regenerate();
});
emitter.on("destroy", () => {
    regenerate();
});

emitter.start();
