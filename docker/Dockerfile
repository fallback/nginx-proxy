FROM nginx:1.9.1
MAINTAINER Grzegorz Godlewski gg@gitgis.com

# Install wget and install/updates certificates
RUN apt-get update && \
  apt-get install -y -q --no-install-recommends ca-certificates wget nodejs npm

# Configure Nginx and apply fix for long server names
ADD build/nginx.conf /etc/nginx/nginx.conf
ADD build/default.conf /etc/nginx/conf.d/default.conf

COPY build /app/
WORKDIR /app/

VOLUME ["/etc/nginx/certs", "/etc/nginx/conf.d", "/var/log"]

# Install Forego
RUN wget -P /usr/local/bin https://godist.herokuapp.com/projects/ddollar/forego/releases/current/linux-amd64/forego \
 && chmod u+x /usr/local/bin/forego

RUN cd /app/docker-watcher && npm install

RUN apt-get clean && rm -r /var/lib/apt/lists/*

CMD ["forego", "start", "-r"]
