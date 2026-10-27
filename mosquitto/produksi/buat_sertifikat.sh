#!/bin/sh
# CA sendiri + sertifikat server untuk broker (dipakai bila TIDAK memakai Let's Encrypt).
#   sh mosquitto/produksi/buat_sertifikat.sh broker.contoh.id        # nama domain
#   sh mosquitto/produksi/buat_sertifikat.sh 203.0.113.7             # atau IP publik
# Hasil: certs/server.crt + server.key (di-mount ke broker) dan ca/ca.crt + ca.key (TIDAK di-mount).
# Isi ca/ca.crt disalin ke firmware/cardiovest_esp32/ca_cert.h. ca/ca.key simpan di tempat aman,
# jangan dikirim, jangan di-commit, dan sebaiknya jangan ditinggal di server.
set -eu
cd "$(dirname "$0")"
[ $# -eq 1 ] || { echo "pakai: sh buat_sertifikat.sh <domain-atau-IP>"; exit 1; }
NAMA=$1
case "$NAMA" in *[!0-9.]*) SAN="DNS:$NAMA";; *) SAN="IP:$NAMA";; esac
mkdir -p certs ca
umask 077
[ -f ca/ca.key ] || openssl req -x509 -newkey rsa:2048 -nodes -days 3650 -keyout ca/ca.key -out ca/ca.crt \
  -subj "/CN=CardioVest CA"
openssl req -newkey rsa:2048 -nodes -keyout certs/server.key -out certs/server.csr -subj "/CN=$NAMA"
printf 'subjectAltName=%s\nextendedKeyUsage=serverAuth\n' "$SAN" > certs/san.ext
openssl x509 -req -in certs/server.csr -CA ca/ca.crt -CAkey ca/ca.key -CAserial ca/ca.srl -CAcreateserial \
  -days 825 -extfile certs/san.ext -out certs/server.crt
rm -f certs/server.csr certs/san.ext
chmod 0644 certs/server.crt ca/ca.crt; chmod 0640 certs/server.key
docker run --rm -v "$PWD/certs:/c" eclipse-mosquitto:2.0.20 chown 1883:1883 /c/server.key /c/server.crt 2>/dev/null || true
echo "selesai: certs/server.crt untuk $SAN"
echo "salin isi $(pwd)/ca/ca.crt ke firmware/cardiovest_esp32/ca_cert.h (dan MQTT_CA untuk klien Python)"
