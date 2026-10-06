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

**Fournisseurs et achats**
- Fiches fournisseurs (NIU, délais de paiement et de livraison, franco), articles référencés avec référence fournisseur, prix négocié, colisage et fournisseur principal.
- Bons de commande numérotés (BC-…), brouillon puis envoyé, impression A4, réception en une ou plusieurs fois avec reliquat, écart de prix signalé, solde ou annulation.
- Réception libre sans commande toujours possible depuis le Stock ; chaque réception produit un bon de réception (BR-…).
- Factures et avoirs fournisseurs (FF-…/AF-…) rapprochés des bons de réception, refus des doublons, échéance calculée sur le délai de paiement.
- Règlements en espèces, virement, chèque, MTN Mobile Money ou Orange Money (référence obligatoire hors espèces), échéancier avec retards, solde dû par fournisseur.
- Proposition de commande : ventes moyennes des 4 dernières semaines, délai de livraison, stock d'alerte et colisage ; un bon par fournisseur en un clic.
- Commandes, réceptions et factures se synchronisent entre les PC du magasin ; les fiches fournisseurs sont communes à tous les magasins.

**Clients et vente à crédit**
- Fiches clients (NIU, téléphone, plafond de crédit, délai de paiement), communes à tous les magasins ; création rapide depuis la caisse.
- Fiche « V. crédit » : choix du client (F8), acompte en espèces avec les billets, le reste va au compte du client avec son échéance. Au-delà du plafond, le code d'un gérant est demandé et tracé.
- Facture A4 de n'importe quel ticket (F9), avec le client, la TVA par taux et l'échéance.
- Règlements clients à la caisse (menu Action) ou au bureau : espèces, MoMo, Orange Money, virement, chèque, carte. Les espèces reçues à la caisse entrent dans le Z. Reçu imprimé.
- Les règlements soldent automatiquement les ventes les plus anciennes ; retour d'un ticket au compte du client.
- Compte client, relevé imprimable sur une période, balance âgée (non échu, 1-30, 31-60, 61-90, plus de 90 jours).

**Comptabilité SYSCOHADA et TVA**
- Plan comptable SYSCOHADA révisé prérempli (caisse 571, banque 521, MTN 5521, Orange Money 5522, TVA 4431/4452, clients 411, fournisseurs 401…), modifiable ; chaque usage automatique (caisse, ventes, TVA…) peut être confié à un autre compte.
- Écritures passées toutes seules, sans double saisie : ventes par Z (une écriture par caisse et par jour, crédit client sur 411 avec le tiers), apports et prélèvements, écarts de caisse (658/758), règlements clients, factures et avoirs fournisseurs, paiements fournisseurs.
- Journaux VE, AC, CA, BQ, MM, OD, AN ; saisie d'écritures manuelles équilibrées (à-nouveaux, loyer, électricité, frais bancaires, dépôt à la banque).
- Grand livre par compte, racine (41, 5…) ou tiers, avec solde progressif ; balance générale cliquable ; trésorerie (caisse, banques, Mobile Money).
- Déclaration de TVA du mois : chiffre d'affaires par taux, exonéré, TVA collectée et déductible, crédit reporté d'un mois sur l'autre, document A4 pour remplir la déclaration DGI. Les acomptes d'IR et les précomptes restent à ajouter par le comptable.
- Impression A4 des journaux, de la balance et de la déclaration ; export CSV des écritures pour le cabinet comptable.
- Les écritures sont recalculées à partir des pièces : elles restent justes quel que soit l'ordre dans lequel les PC se synchronisent. Plan comptable et écritures manuelles se synchronisent.

**États financiers et DSF**
- Bilan (actif brut, amortissements, net ; passif) et compte de résultat du SYSCOHADA révisé, système normal, avec les références officielles (AD… BZ, CA… DZ, TA… XI) et la colonne de l'exercice précédent (Comptabilité › États financiers, ou Fiscal › États financiers et DSF).
- Stock de fin d'exercice valorisé au CMUP d'après les mouvements de stock : l'écart avec le compte 311 passe en variation de stock (6031), comme l'écriture d'inventaire. Les résultats des exercices précédents apparaissent en report à nouveau.
- Tableau des flux de trésorerie (TFT) par la méthode indirecte : capacité d'autofinancement, variations du bilan, investissements, capitaux propres et emprunts (références ZA… ZH), avec contrôle de la trésorerie finale contre le bilan. Les à-nouveaux de reprise comptent comme trésorerie de départ.
- Impression A4 (bilan actif, bilan passif, compte de résultat, tableau des flux) et export CSV des postes pour la saisie de la DSF. Les comptes qu'aucun poste ne reprend sont signalés.
- Notes annexes calculées à partir des écritures (bouton Notes annexes) : immobilisations et amortissements (3A, 3C), stocks (6), clients (7), autres créances (8), disponibilités (11), capital (13), dettes financières (16A), fournisseurs (17), dettes fiscales et sociales (18), autres dettes (19), découverts (20), chiffre d'affaires et charges par compte (21 à 30), fiche de synthèse (34) et passage au résultat fiscal. Impression A4 et export CSV. Les notes déclaratives (engagements, effectifs, informations sociales) restent à rédiger par le comptable.

**Impôt sur le résultat**
- Fiscal › Impôt sur le résultat : forme (société à l'IS ou entreprise individuelle à l'IRPP), régime (réel ou simplifié) et taux, exercice par exercice. Taux du CGI par défaut, modifiables : IS 30 % (25 % jusqu'à 3 milliards de chiffre d'affaires), minimum de perception 2 % au réel et 5 % au simplifié, barème IRPP 10 / 15 / 25 / 35 %, centimes additionnels communaux de 10 %.
- Acompte mensuel calculé sur le chiffre d'affaires HT et ajouté à la déclaration de TVA du mois (total à verser à la DGI).
- Liquidation annuelle : résultat comptable, réintégrations et déductions, déficits antérieurs, impôt calculé comparé au minimum de perception, solde après acomptes, déficit reportable. Impression A4 et écriture de fin d'exercice (débit 891, crédit 441).

**Rapprochement bancaire**
- Comptabilité › Rapprochement bancaire (ou Trésorerie › Rapprochement bancaire), pour chaque compte de banque, MoMo ou Orange Money (classe 52 à 55).
- Import du relevé en CSV tel que la banque ou l'opérateur le fournit : colonnes reconnues automatiquement (date, libellé, référence, débit/crédit ou montant signé, frais), séparateur `;`, `,` ou tabulation, fichiers Excel enregistrés en CSV acceptés. Un relevé importé deux fois, ou sur deux PC, ne crée pas de doublon.
- Pointage automatique : même montant, dates proches de 10 jours au plus, la référence citée sur le relevé départage. Pointage et dépointage à la main pour le reste.
- Frais, agios, intérêts présents seulement sur le relevé : « Comptabiliser » passe l'écriture (journal BQ ou MM) et la pointe.
- Solde attendu sur le relevé, écart avec le solde affiché, et état de rapprochement A4 à signer. Le pointage se synchronise entre les PC.

**Dépenses**
- Loyer, ENEO, salaires, CNPS, transport, sacs, entretien… classés par catégorie, chaque catégorie passant sur son compte de charges (modifiable).
- Payées par espèces, MoMo, Orange Money, virement, chèque ou carte (référence obligatoire hors espèces), avec la TVA récupérable de la facture (calcul 19,25 % en un clic).
- Dépense payée avec les espèces du tiroir depuis la caisse (Action › Dépense payée en caisse) : bon de sortie imprimé pour signature, montant déduit des espèces attendues et listé sur le Z. Un caissier a besoin du code d'un gérant.
- Écritures comptables automatiques, TVA des dépenses reprise dans la déclaration du mois, annulation motivée (impossible après le Z pour une sortie de caisse), totaux par catégorie, par mode de paiement et par mois.

**Recherche de produits**
- Dès 2 lettres tapées, à la caisse comme dans les devis, achats et stock, une liste propose les produits correspondants avec leur prix : flèches pour choisir, Entrée pour ajouter, Échap pour fermer. Plusieurs mots se combinent (« riz 25 »), sans tenir compte des accents ni des majuscules (« creme » trouve « Crème fraîche »), et la marque compte aussi. « 3*riz » ajoute 3 fois le produit choisi. Un code-barres scanné passe directement.

**Devis et factures proforma**
- Devis (DV-) ou facture proforma (PF-) pour un client enregistré ou un simple prospect, avec durée de validité, remises par ligne (code du gérant pour un caissier) et conditions.
- Impression A4 avec le montant en lettres (« Arrêtée la présente facture proforma à la somme de cent-cinquante-cinq-mille francs CFA »), la date de validité et le « Bon pour accord » du client.
- Facturation depuis la caisse (Action › Facturer un devis / proforma) : les lignes et le client sont repris, et les prix du document sont garantis jusqu'à sa date de validité même si le tarif a augmenté entre-temps, sans code gérant. Le document passe « facturé » sur tous les PC ; un devis expiré ou annulé ne se facture plus.

**Pilotage et administration**
- Tableau de bord du jour : CA, tickets, panier moyen, marge par rayon, ventes par heure, meilleures ventes.
- Export CSV des ventes.
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
2. Notes déclaratives de la DSF (engagements, effectifs), à saisir dans l'application.
