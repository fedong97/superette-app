#!/usr/bin/env bash
# Installe FEDONIX 360 Serveur sur un serveur loué (Ubuntu ou Debian), à lancer en root
# dans le dossier décompressé : sudo bash installer.sh
# Relancé plus tard avec une nouvelle image, il met le serveur à jour sans toucher aux données.
set -euo pipefail
cd "$(dirname "$0")"

if ! command -v docker >/dev/null 2>&1; then
  echo "Installation de Docker…"
  curl -fsSL https://get.docker.com | sh
fi

image=$(ls fedonix360-serveur-*.tar.gz 2>/dev/null | sort -V | tail -1 || true)
if [ -z "$image" ]; then
  echo "Fichier fedonix360-serveur-<version>.tar.gz introuvable dans ce dossier." >&2
  exit 1
fi
version=${image#fedonix360-serveur-}
version=${version%.tar.gz}
echo "Chargement de FEDONIX 360 Serveur $version…"
gunzip -c "$image" | docker load

if [ ! -f .env ]; then
  read -rp "Nom de domaine du serveur (ex. fedonix.mamaboutique.cm) : " domaine
  read -rsp "Mot de passe de l'interface du serveur : " mdp
  echo
  cle=$(tr -dc 'A-Za-z0-9' </dev/urandom | head -c 24)
  cat > .env <<CONF
DOMAINE=$domaine
MOT_DE_PASSE=$mdp
CLE_ENROLEMENT=$cle
VERSION=$version
CONF
  chmod 600 .env
  echo "Clé d'enrôlement du premier PC : $cle (gardée dans .env)"
else
  sed -i "s/^VERSION=.*/VERSION=$version/" .env
fi

mkdir -p donnees caddy
chown -R 1000:1000 donnees
docker compose up -d
. ./.env
echo
echo "FEDONIX 360 Serveur $version démarré : https://$DOMAINE/"
echo "Sur chaque PC : Administration › Serveur central, adresse https://$DOMAINE"
echo "Page du gérant sur téléphone : https://$DOMAINE/gerant"
