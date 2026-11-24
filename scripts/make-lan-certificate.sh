#!/usr/bin/env bash
# Makes the https certificate of a .lan site, signed by a local CA that may sign only names under .lan and no IP
# address. Even a stolen CA key cannot fake any other site. Run on the laptop; add-site.sh copies the certificate to
# the mini. The CA is made once and kept; the certificate is made again on every run.
# Usage: scripts/make-lan-certificate.sh <host>, e.g. budzet.lan
# Trust the CA once on every Mac that opens the site (asks for the password):
#   sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain ~/.config/opsbuf-sites/lan-ca/ca.pem
set -euo pipefail

[[ $# -eq 1 && "$1" == *.lan ]] || { echo "Usage: scripts/make-lan-certificate.sh <host ending in .lan>" >&2; exit 2; }
host=$1
ca_dir=$HOME/.config/opsbuf-sites/lan-ca
tls_dir=$HOME/.config/opsbuf-sites/$host/tls
ca_days=1825              # 5 years
certificate_days=825      # about 2 years 3 months, the most Apple accepts for a TLS server certificate

make_ca_if_missing() {
  if [[ -s "$ca_dir/ca.pem" && -s "$ca_dir/ca-key.pem" ]]; then
    echo "== CA kept: $ca_dir/ca.pem"
    return
  fi
  echo "== make the CA in $ca_dir"
  mkdir -p "$ca_dir" && chmod 700 "$ca_dir"
  openssl ecparam -name prime256v1 -genkey -noout -out "$ca_dir/ca-key.pem"
  chmod 600 "$ca_dir/ca-key.pem"
  # without the excluded IP ranges, a name constraint on DNS alone would let the CA sign any IP address
  openssl req -new -x509 -sha256 -days "$ca_days" -key "$ca_dir/ca-key.pem" -out "$ca_dir/ca.pem" \
    -subj "/O=opsbuf sites/CN=opsbuf .lan CA (.lan names only)" \
    -addext "basicConstraints=critical,CA:TRUE,pathlen:0" \
    -addext "keyUsage=critical,keyCertSign,cRLSign" \
    -addext "subjectKeyIdentifier=hash" \
    -addext "nameConstraints=critical,permitted;DNS:lan,excluded;IP:0.0.0.0/0.0.0.0,excluded;IP:0:0:0:0:0:0:0:0/0:0:0:0:0:0:0:0"
}

make_certificate() {
  echo "== make the certificate in $tls_dir"
  mkdir -p "$tls_dir" && chmod 700 "$tls_dir"
  openssl ecparam -name prime256v1 -genkey -noout -out "$tls_dir/key.pem"
  chmod 600 "$tls_dir/key.pem"
  openssl req -new -sha256 -key "$tls_dir/key.pem" -subj "/O=opsbuf sites/CN=$host" -out "$tls_dir/request.csr"
  openssl x509 -req -sha256 -days "$certificate_days" -in "$tls_dir/request.csr" \
    -CA "$ca_dir/ca.pem" -CAkey "$ca_dir/ca-key.pem" -CAcreateserial -CAserial "$ca_dir/ca.srl" -out "$tls_dir/cert.pem" \
    -extfile <(printf '%s\n' \
      "basicConstraints=critical,CA:FALSE" \
      "keyUsage=critical,digitalSignature" \
      "extendedKeyUsage=serverAuth" \
      "authorityKeyIdentifier=keyid" \
      "subjectAltName=DNS:$host")
  rm -f "$tls_dir/request.csr"
  openssl verify -CAfile "$ca_dir/ca.pem" "$tls_dir/cert.pem"
}

make_ca_if_missing
make_certificate
openssl x509 -in "$tls_dir/cert.pem" -noout -subject -enddate
openssl x509 -in "$ca_dir/ca.pem" -noout -subject -enddate -fingerprint -sha256
