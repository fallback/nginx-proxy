#!/usr/bin/nodejs
'use strict';

// TODO ping upstream to check if exists (Error: nginx: [emerg] host not found in upstream ...)

const config = {
    'tmpl_dir': process.env.TMPL_DIR || '/app',
    'conf_dir': process.env.NGINX_CONF_DIR || '/etc/nginx/conf.docker',
    'network': process.env.NETWORK || ''
};

const fs = require('fs');
const DockerEvents = require('docker-events');
const Docker = require('dockerode');
const nunjucks = require('nunjucks');
const child_process = require('child_process');
const glob = require("glob");

const socketPath = fs.existsSync('/var/run/docker.sock') ? '/var/run/docker.sock': '/tmp/docker.sock';

const docker = new Docker({socketPath: socketPath});
const emitter = new DockerEvents({
    docker: docker
});

nunjucks.configure(config['tmpl_dir'], { autoescape: true });

function createVirtual(host) {
    const virtual = {};
    virtual['host'] = host;
    virtual['upstreams'] = {};
    virtual['paths'] = {};
    return virtual;
}

function renderVirtual(virtual) {
    if (virtual['CERT_PATH']) {
        return nunjucks.render('virtual.ssl.conf.nunjucks', {'virtual': virtual, 'cert_path': virtual['CERT_PATH']});
    } else {
        return nunjucks.render('virtual.conf.nunjucks', {'virtual': virtual})
    }
}

function generateNginx(config, virtuals) {
    glob(config['conf_dir']+'/*.generated.conf', function (er, files) {
        files.forEach((fileName) => {
            fs.unlinkSync(fileName);
        });

        for (let virtualKey in virtuals) {
            const virtual = virtuals[virtualKey];
            const generatedConfig = config['conf_dir']+'/'+virtual['host'].replace(/\//gi, '_')+'.generated.conf';
            console.log("Generating: "+generatedConfig);
            fs.writeFileSync(generatedConfig, renderVirtual(virtual));
        }

        console.log("Restarting nginx");
        child_process.exec('nginx -s reload', function(error, stdout, stderr) {

            if (error) {
                console.error(error);
            }
            console.log(stdout);
        });
    });
}

function containerToEnv(inspectedContainer) {
    const env = {};

    inspectedContainer.Config.Env.forEach((row) => {
        const idx = row.indexOf('=');
        env[row.substr(0, idx)] = row.substr(idx + 1);
    });

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

    env['IP'] = inspectedContainer.NetworkSettings.IPAddress;

    return {
        ID: inspectedContainer.Id,
        UPSTREAM: 'container_'+inspectedContainer.Id,
        VIRTUAL_PROTO: env['VIRTUAL_PROTO'] || 'http',
        IP: env['IP'],
        CERT_NAME: env['CERT_NAME'],
        VIRTUAL_URL: env['VIRTUAL_URL'],
        VIRTUAL_PORT: env['VIRTUAL_PORT']
    };
}

function serviceToEnv(inspectedService) {
    const env = {};

    if (!inspectedService.Spec.TaskTemplate.ContainerSpec.Env) {
        return {};
    }

    inspectedService.Spec.TaskTemplate.ContainerSpec.Env.forEach((row) => {
        const idx = row.indexOf('=');
        env[row.substr(0, idx)] = row.substr(idx + 1);
    });

    return {
        ID: inspectedService.ID,
        UPSTREAM: 'service_'+inspectedService.ID,
        VIRTUAL_PROTO: env['VIRTUAL_PROTO'] || 'http',
        IP: inspectedService.Spec.Name,
        CERT_NAME: env['CERT_NAME'],
        VIRTUAL_URL: env['VIRTUAL_URL'],
        VIRTUAL_PORT: env['VIRTUAL_PORT'] || 80
    };
}

function addUrlContainer(virtuals, url, env) {
    const idx = url.indexOf('/');
    const host = (idx < 0) ? url : url.substr(0, idx);
    const path = (idx < 0) ? '/' : url.substr(idx);

    if (!virtuals[host]) {
        virtuals[host] = createVirtual(host);
    }

    const upstream = {
        proto: env['VIRTUAL_PROTO'],
        ip: env['IP'],
        port: env['VIRTUAL_PORT'],
        name: env['UPSTREAM']+"_"+host.replace('.', '_')
    };
    virtuals[host].upstreams[env['UPSTREAM']] = upstream;

    if (env['CERT_NAME']) {
        try {
            if (fs.lstatSync('/run/secrets/'+env['CERT_NAME']+'.crt').isFile()) {
                virtuals[host]['CERT_PATH'] = '/run/secrets/'+env['CERT_NAME'];
            } else
            if (fs.lstatSync('/etc/nginx/certs/'+env['CERT_NAME']+'.crt').isFile()) {
                virtuals[host]['CERT_PATH'] = '/etc/nginx/certs/'+env['CERT_NAME'];
            }
        } catch (err) {
        }
    }

    if (!virtuals[host]['paths'][path]) {
        virtuals[host]['paths'][path] = [];
    }

    if (env['IP']) {
        virtuals[host]['paths'][path].push({
            path: path,
            proto: env['VIRTUAL_PROTO'],
            upstream: upstream.name
        });
    }

}

function getVirtuals() {
    return new Promise((resolve, reject) => {
        docker.listServices((err, listedServices) => {
            if (err) {
                return reject(err);
            }

            const promises = [];

            listedServices.forEach((listedService) => {
                const dockerService = docker.getService(listedService.ID);

                promises.push(new Promise((resolve, reject) => {
                    dockerService.inspect((err, inspectedService) => {
                        if (err) {
                            return reject(err);
                        }

                        resolve(serviceToEnv(inspectedService));
                    });
                }));
            });

            docker.listContainers((err, listedContainers) => {
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

                            if (inspectedContainer.Config.Labels && inspectedContainer.Config.Labels['com.docker.swarm.service.name']) {
                                resolve({});
                                return;
                            }

                            resolve(containerToEnv(inspectedContainer));
                        });
                    }));
                });

                Promise
                    .all(promises)
                    .then((envs) => {

                        const virtuals = {};
                        envs.forEach((env) => {
                            if (!env['VIRTUAL_URL']) return;
                            if (!env['VIRTUAL_PORT']) return;

                            const virtualUrls = env['VIRTUAL_URL'].split(',');
                            virtualUrls.forEach((virtualUrl) => {
                                addUrlContainer(virtuals, virtualUrl.trim(), env);
                            });

                        });

                        resolve(virtuals);
                    })
                    .catch((err) => {
                        reject(err);
                    })

            });
        });

    });

};

const args = process.argv.slice(2);

if (args.length > 0) {
    switch (args[0]) {
        case 'list':
            getVirtuals()
                .then((virtuals) => {
                    for (let host in virtuals) {
                        console.log(host);
                    }
                });
            break;

        case 'virtual':
            getVirtuals()
                .then((virtuals) => {
                    for (let host in virtuals) {
                        if (host != args[1]) continue;
                        const virtual = virtuals[host];
                        console.log('HOST', virtual.host);
                        console.log('paths', virtual['paths']);
                        console.log('upstreams', virtual['upstreams']);
                    }
                });
            break;

        case 'container':
            getVirtuals()
                .then((virtuals) => {
                    for (let host in virtuals) {
                        if (host != args[1]) continue;
                        const virtual = virtuals[host];
                        console.log(renderVirtual(virtual));
                    }
                });
            break;
    }
} else {
    const regenerate = () => {
        getVirtuals()
            .then((virtuals) => {
                generateNginx(config, virtuals);
            })
            .catch((err) => {
                console.error(err);
            });
    };

    regenerate();

    emitter.on("_message", (data) => {
        if (process.env.DEBUG_EVENTS) console.log(data);
    });
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
}
