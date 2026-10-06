# Superette Gestion

Logiciel de gestion de superette pour le Cameroun (FCFA, TVA 19,25 %, MTN Mobile Money, Orange Money), inspiré de Sage 100.
Application de bureau Windows (installateur `.exe`), base locale hors ligne, multi-magasins et multi-caisses.

Ce dépôt couvre la **phase 1 : caisse et stock**.

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

Chaque opération est aussi écrite dans une file d'envoi (`outbox`) prête pour la synchronisation avec le serveur central.

## Organisation

```
packages/core     Règles métier pures : FCFA, TVA, codes-barres, ticket, paiements, CMUP, FEFO, clôture Z
packages/db       Base SQLite locale, migrations et services (admin, catalogue, stock, caisse, rapports)
apps/desktop      Application Electron : processus principal, impression, interface React
```

Montants en FCFA entiers, quantités en millièmes (1 pièce = 1000, 1,250 kg = 1250), identifiants UUID pour fusionner sans collision les données de plusieurs magasins.

## Développer

Prérequis : Node.js 22, et sous Windows les outils de compilation si `better-sqlite3` doit être recompilé.

```bash
npm install
npm test                 # 32 tests (règles métier et services sur une vraie base SQLite)
npm run typecheck
npm run dev              # lance l'application de bureau en mode développement
```

`npm test` recompile `better-sqlite3` pour Node, `npm run dev` le recompile pour Electron : c'est normal que le premier lancement de chacun prenne quelques secondes.

## Construire l'installateur Windows

Sur un PC Windows :

```bash
npm install
npm run build:win        # produit apps/desktop/release/SuperetteGestion-Setup-<version>.exe
```

La mise à jour automatique lit les nouvelles versions à l'adresse `publish.url` de `apps/desktop/electron-builder.yml` (à remplacer par celle du serveur central).

## Données

La base est dans `%APPDATA%\Superette Gestion\superette.db` (variable `SUPERETTE_DB` pour en utiliser une autre).

## Prochaines étapes

1. Serveur central (NestJS + PostgreSQL) et synchronisation de la file d'envoi : activation d'une caisse sur un autre PC, consolidation multi-magasins.
2. Impression ESC/POS directe et ouverture du tiroir-caisse sans pilote.
3. Phase 2 : fournisseurs et achats (commande, réception, facture, réapprovisionnement automatique).
