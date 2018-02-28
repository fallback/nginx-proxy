FROM nginx:stable
MAINTAINER Grzegorz Godlewski gg@gitgis.com

# Install wget and install/updates certificates
RUN apt-get update
RUN apt-get install -y -q --no-install-recommends ca-certificates gnupg wget curl

RUN curl -sL https://deb.nodesource.com/setup_8.x | bash -
RUN apt-get install -y -q nodejs npm

# Configure Nginx and apply fix for long server names
ADD build/nginx.conf /etc/nginx/nginx.conf
ADD build/default.conf /etc/nginx/conf.d/default.conf

COPY build /app/
WORKDIR /app/

VOLUME ["/etc/nginx/certs", "/etc/nginx/conf.d", "/etc/nginx/conf.docker", "/var/log"]

# Install Forego
RUN wget https://bin.equinox.io/c/ekMN3bCZFUn/forego-stable-linux-amd64.tgz
RUN tar xvf forego-stable-linux-amd64.tgz -C /usr/local/bin

RUN apt-get remove -y -q gnupg wget curl
RUN apt-get clean && rm -r /var/lib/apt/lists/*

# Install docker-watcher
RUN cd /app/docker-watcher && npm install

EXPOSE 80
EXPOSE 443

CMD ["forego", "start"]
