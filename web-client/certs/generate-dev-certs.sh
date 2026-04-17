#!/bin/bash
# Generate self-signed certificate for development HTTPS

if [ ! -f "dev-cert.pem" ] || [ ! -f "dev-key.pem" ]; then
    echo "Generating development SSL certificates..."
    openssl req -x509 -newkey rsa:4096 -keyout dev-key.pem -out dev-cert.pem -days 365 -nodes -subj "/C=US/ST=Dev/L=Dev/O=Dev/CN=localhost"
    echo "Certificates generated: dev-cert.pem, dev-key.pem"
else
    echo "Development certificates already exist"
fi