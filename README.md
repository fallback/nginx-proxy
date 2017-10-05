Yet another nginx-proxy
=====

Nginx container acting as a reverse proxy for docker containers.

Usage
-----

Run nginx-proxy with ansible
```
ansible-playbook ansible/main.yml # change hosts line
```

or

Run nginx-proxy with docker
```
docker run -d -p 80:80 -v /var/run/docker.sock:/tmp/docker.sock -v /data/ssl_cert:/etc/nginx/certs gitgis/nginx-proxy
```

Run container you want to proxy with env VIRTUAL_URL=example.com

```
docker run -e VIRTUAL_URL=example.com ... #container_with_main_page
docker run -e VIRTUAL_URL=example.com/gfx ... #container_with_static_images
docker run -e VIRTUAL_URL=example.com/api VIRTUAL_PORT=8080 ... #container_with_api with exposed port 8080
```

SSL certificates
-----

Put certificates into:
```
/data/ssl_cert/example.com.crt
/data/ssl_cert/example.com.key
```

Run container you want to proxy with:
```
docker run -e VIRTUAL_URL=example.com -e CERT_NAME=example.com
```
