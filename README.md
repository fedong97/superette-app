# Superette Gestion

Logiciel de gestion de superette pour le Cameroun (FCFA, TVA 19,25 %, MTN Mobile Money, Orange Money), inspiré de Sage 100.
Application de bureau Windows (installateur `.exe`), base locale hors ligne, multi-magasins et multi-caisses.

Ce dépôt couvre la **phase 1 : caisse et stock**, et le **serveur central** qui relie les caisses et les magasins.

## Ce qui fonctionne

**Caisse**
- Scan douchette (EAN-13, EAN-8, UPC), recherche par nom, touches rapides, `3*code` pour multiplier.
- Conditionnements (un code-barres « carton de 24 » sort 24 unités).
- Articles au poids : saisie du poids ou étiquette balance à prix ou poids intégré (préfixes 21/22 paramétrables).
- Paiements mixtes : espèces avec rendu monnaie, MTN Mobile Money et Orange Money (référence obligatoire), carte, bon d'achat.
- Remises par ligne, validées par le code d'un gérant si le caissier n'en a pas le droit.
- Tickets en attente, annulation et retour client sous code gérant, apports et prélèvements d'espèces.
- Ouverture avec fond de caisse, clôture Z avec comptage par coupure FCFA et écart, rapport X/Z réimprimable.
- Ticket 80 mm imprimé par le pilote Windows de l'imprimante.

**Stock**
- Fiches articles : rayon/famille, marque, unité, TVA, prix d'achat, prix de vente TTC, marge, prix propre à un magasin, historique des prix, plusieurs codes-barres, codes internes générés (préfixe 20).
- Import du catalogue depuis Excel (CSV).
- Dépôts par magasin (surface de vente, réserve, chambre froide), réceptions avec lot et date limite (obligatoire pour les périssables).
- Valorisation au CMUP, sortie en FEFO, pertes (casse, vol, péremption, consommation interne) avec motif, transferts entre dépôts avec dates conservées.
- Inventaire tournant sans fermer le magasin : chaque comptage est horodaté, les ventes passées depuis sont déduites.
- Alertes de péremption (J-7, J-3, J-1, périmé), niveaux rupture/alerte/surstock.

**Pilotage et administration**
- Tableau de bord du jour : CA, tickets, panier moyen, marge par rayon, ventes par heure, meilleures ventes.
- Export CSV des ventes pour le comptable (en attendant le module Comptabilité).
- Magasins, caisses (code d'activation), dépôts, utilisateurs et rôles (administrateur, gérant, caissier, magasinier, comptable), paramètres, journal d'audit.

**Serveur central et plusieurs PC**
- Chaque PC garde sa propre base et vend sans réseau ; les opérations partent au serveur toutes les 20 secondes dès que la connexion revient.
- Le premier PC se relie au serveur avec la clé d'enrôlement (Administration › Serveur central) et envoie tout son historique.
- Un nouveau PC choisit « Rejoindre un magasin existant » au premier démarrage, avec le code d'activation d'une caisse : il récupère catalogue, utilisateurs, ventes et stock du magasin.
- Le stock n'est jamais copié d'un PC à l'autre : il est recalculé à partir des mouvements, donc identique sur toutes les caisses (CMUP compris), quel que soit l'ordre d'arrivée.
- Un autre magasin reçoit le catalogue commun mais pas les ventes ni le stock des autres magasins. Les conflits (code-barres déjà pris…) sont listés sans bloquer la caisse.

## Organisation

```
packages/core     Règles métier pures : FCFA, TVA, codes-barres, ticket, paiements, CMUP, FEFO, clôture Z
packages/db       Base SQLite locale, migrations et services (admin, catalogue, stock, caisse, rapports)
apps/desktop      Application Electron : processus principal, impression, synchronisation, interface React
apps/server       Serveur central NestJS + PostgreSQL : enrôlement des PC, journal des opérations
```

Montants en FCFA entiers, quantités en millièmes (1 pièce = 1000, 1,250 kg = 1250), identifiants UUID pour fusionner sans collision les données de plusieurs magasins.

## Développer

Prérequis : Node.js 22, et sous Windows les outils de compilation si `better-sqlite3` doit être recompilé.

```bash
npm install
npm test                 # règles métier et services sur une vraie base SQLite
npm run typecheck
npm run dev              # lance l'application de bureau en mode développement
```

Les tests de bout en bout du serveur (deux PC, deux magasins) tournent si `TEST_DATABASE_URL` pointe vers une base PostgreSQL de test, vidée à chaque lancement :

```bash
TEST_DATABASE_URL=postgres://superette:superette@localhost:5432/superette_test npm test
```

`npm test` recompile `better-sqlite3` pour Node, `npm run dev` le recompile pour Electron : c'est normal que le premier lancement de chacun prenne quelques secondes.

## Construire l'installateur Windows

Sur un PC Windows :

```bash
npm install
npm run build:win        # produit apps/desktop/release/SuperetteGestion-Setup-<version>.exe
```

La mise à jour automatique lit les nouvelles versions à l'adresse `publish.url` de `apps/desktop/electron-builder.yml` (à remplacer par celle du serveur central).

## Installer le serveur central

Sur un serveur Linux (VPS) ou un PC toujours allumé, avec Node.js 22 et PostgreSQL 14 ou plus :

```bash
npm install
npm run build -w @superette/server
DATABASE_URL=postgres://utilisateur:motdepasse@localhost:5432/superette \
ENROLLMENT_KEY=une-longue-phrase-secrete \
PORT=3000 \
npm start -w @superette/server
```

Les tables sont créées au premier démarrage. `ENROLLMENT_KEY` (12 caractères minimum) protège l'enrôlement du premier PC ; les PC suivants n'en ont pas besoin, le code d'activation de leur caisse suffit. Sur Internet, placez le serveur derrière un proxy HTTPS (Caddy, Nginx).

## Données

La base est dans `%APPDATA%\Superette Gestion\superette.db` (variable `SUPERETTE_DB` pour en utiliser une autre).

## Prochaines étapes

1. Impression ESC/POS directe et ouverture du tiroir-caisse sans pilote.
2. Phase 2 : fournisseurs et achats (commande, réception, facture, réapprovisionnement automatique).
