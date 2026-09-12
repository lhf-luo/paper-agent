#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 2 ]]; then
	echo "Usage: $0 <server-ip> <output-directory> [extra-san ...]" >&2
	echo "  extra-san examples: DNS:team.example.com  IP:10.0.0.5" >&2
	exit 2
fi

server_ip="$1"
output_directory="$2"
shift 2
extra_sans=("$@")
mkdir -p "$output_directory"
umask 077

# Reuse an existing CA when one is already in place. Rotating the CA invalidates every
# distributed access string (`pateam1.` embeds the CA), so it must be a deliberate
# decision: delete ca.crt/ca.key first if you really want a fresh CA.
if [[ -s "$output_directory/ca.crt" && -s "$output_directory/ca.key" ]]; then
	echo "Reusing the existing CA in $output_directory"
else
	openssl req -x509 -newkey rsa:3072 -sha256 -days 3650 -nodes \
		-keyout "$output_directory/ca.key" -out "$output_directory/ca.crt" \
		-subj "/CN=Paper Agent Team CA"
fi

openssl req -newkey rsa:3072 -nodes \
	-keyout "$output_directory/server.key" -out "$output_directory/server.csr" \
	-subj "/CN=$server_ip"

# Loopback SANs are part of the default set: operators, backup jobs and health checks
# must be able to reach the service from the host itself without disabling TLS
# verification (never use -k) or resorting to curl --resolve.
san_list="IP:$server_ip,IP:127.0.0.1,IP:::1,DNS:localhost"
if ((${#extra_sans[@]})); then
	for san in "${extra_sans[@]}"; do san_list="$san_list,$san"; done
fi

cat > "$output_directory/server.ext" <<EOF
subjectAltName=$san_list
basicConstraints=CA:FALSE
keyUsage=digitalSignature,keyEncipherment
extendedKeyUsage=serverAuth
EOF

openssl x509 -req -in "$output_directory/server.csr" \
	-CA "$output_directory/ca.crt" -CAkey "$output_directory/ca.key" -CAcreateserial \
	-out "$output_directory/server.crt" -days 825 -sha256 -extfile "$output_directory/server.ext"
# Keep ca.srl: deleting it would let a reused CA hand out duplicate serial numbers.
rm -f "$output_directory/server.csr" "$output_directory/server.ext"
chmod 600 "$output_directory/ca.key" "$output_directory/server.key"
chmod 644 "$output_directory/ca.crt" "$output_directory/server.crt"
echo "Created an IP certificate for $server_ip in $output_directory"
echo "SANs: $san_list"
