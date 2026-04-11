FROM nginx:alpine
RUN rm /usr/share/nginx/html/index.html
COPY src/index.html /usr/share/nginx/html/index.html
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]