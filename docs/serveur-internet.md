# Mettre FEDONIX 360 Serveur sur internet

Avec le serveur central sur internet, les PC de chaque magasin se synchronisent de partout, la page du gérant marche sur son téléphone hors du magasin, et la base est sauvegardée chaque jour hors de la boutique.

## Ce qu'il faut

1. **Un serveur loué (VPS)** sous Ubuntu 24.04 ou Debian 12 : 1 processeur, 2 Go de mémoire et 25 Go de disque suffisent pour plusieurs magasins. Comptez quelques milliers de FCFA par mois chez un hébergeur (Hetzner, OVHcloud, Contabo, DigitalOcean…). L'hébergeur vous donne l'adresse IP du serveur et un accès `root`.
2. **Un nom de domaine** (ex. `fedonix.mamaboutique.cm`) dont l'enregistrement **A** pointe vers l'adresse IP du serveur. Il se règle chez le vendeur du nom de domaine, en quelques minutes.
3. **Le paquet `FEDONIX-360-serveur-internet-<version>`**, fourni avec les installateurs. Il contient l'image du serveur, `installer.sh`, `docker-compose.yml`, `Caddyfile` et ce guide.

## Installation (10 minutes)

1. Copiez le dossier du paquet sur le serveur, par exemple avec WinSCP ou :

   ```bash
   scp -r FEDONIX-360-serveur-internet-0.64.0 root@ADRESSE_IP:/opt/fedonix
   ```

2. Connectez-vous au serveur (`ssh root@ADRESSE_IP`, ou PuTTY sous Windows) et lancez :

   ```bash
   cd /opt/fedonix
   sudo bash installer.sh
   ```

   Le script installe Docker s'il manque, charge le serveur, puis demande :
   - le **nom de domaine** ;
   - le **mot de passe** de l'interface du serveur.

   Il crée la **clé d'enrôlement** du premier PC et l'affiche : notez-la. Tout est gardé dans le fichier `.env`.

3. Ouvrez `https://votre-domaine/` dans un navigateur : l'interface du serveur s'affiche, avec son cadenas HTTPS (le certificat est obtenu et renouvelé tout seul).

## Relier les PC et le téléphone du gérant

- Sur chaque PC : **Administration › Serveur central**, adresse `https://votre-domaine`. Le premier PC demande la clé d'enrôlement ; les suivants, le code d'activation de leur caisse.
- Sur le téléphone du gérant : ouvrez `https://votre-domaine/gerant`, puis « Ajouter à l'écran d'accueil ».

## Sauvegardes

- La base est sauvegardée chaque jour dans `/opt/fedonix/donnees/sauvegardes` (les 30 dernières sont gardées). Elles se téléchargent aussi depuis l'interface du serveur, onglet Sauvegardes.
- Pour une copie hors du serveur, activez en plus la sauvegarde automatique proposée par l'hébergeur.

## Mettre à jour

Copiez le nouveau fichier `fedonix360-serveur-<version>.tar.gz` dans `/opt/fedonix`, puis relancez `sudo bash installer.sh`. Les données et les réglages sont gardés. Comme toujours, mettez le serveur à jour **avant** les PC.

## En cas de souci

- `docker compose ps` montre si les deux services (`fedonix` et `caddy`) tournent ; `docker compose logs fedonix` affiche le journal du serveur.
- Pas de cadenas HTTPS : vérifiez que le nom de domaine pointe bien vers l'adresse IP du serveur et que les ports 80 et 443 sont ouverts dans le pare-feu de l'hébergeur.
