# Debug viewer: berkas statis disalin ke dalam image (tanpa bind mount dari Windows)
FROM nginx:1.27-alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY index.html DESIGN.md /usr/share/nginx/html/
COPY vendor /usr/share/nginx/html/vendor
