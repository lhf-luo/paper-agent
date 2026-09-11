#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 2 ]]; then
	echo "Usage: $0 <server-ip> <output-directory>" >&2
	exit 2
fi

server_ip="$1"
output_directory="$2"
mkdir -p "$output_directory"
umask 077

openssl req -x509 -newkey rsa:3072 -sha256 -days 3650 -nodes \
	-keyout "$output_directory/ca.key" -out "$output_directory/ca.crt" \
	-subj "/CN=Paper Agent Team CA"
openssl req -newkey rsa:3072 -nodes \
	-keyout "$output_directory/server.key" -out "$output_directory/server.csr" \
	-subj "/CN=$server_ip"
cat > "$output_directory/server.ext" <<EOF
subjectAltName=IP:$server_ip
basicConstraints=CA:FALSE
keyUsage=digitalSignature,keyEncipherment
extendedKeyUsage=serverAuth
EOF
openssl x509 -req -in "$output_directory/server.csr" \
	-CA "$output_directory/ca.crt" -CAkey "$output_directory/ca.key" -CAcreateserial \
	-out "$output_directory/server.crt" -days 825 -sha256 -extfile "$output_directory/server.ext"
rm -f "$output_directory/server.csr" "$output_directory/server.ext" "$output_directory/ca.srl"
chmod 600 "$output_directory/ca.key" "$output_directory/server.key"
chmod 644 "$output_directory/ca.crt" "$output_directory/server.crt"
echo "Created an IP certificate for $server_ip in $output_directory"
