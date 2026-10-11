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
- Tickets en attente (F10 rappelle un ticket, le nombre en attente s'affiche sur le bouton), annulation et retour client sous code gérant, apports et prélèvements d'espèces.
- Aucune vente tant que la caisse n'est pas ouverte. Ouverture et clôture dans Trésorerie › Opérations de trésorerie (comme KONTROL) : choix de la caisse, journée en cours, entrées et sorties d'espèces avec heure, montant, nature, motif et tiers, ventes à crédit, attendu, relevé et différentiel à la clôture, historique des journées.
- Fond de caisse : à l'ouverture, le fond laissé la veille est proposé ; un complément vient de la caisse centrale, un surplus y retourne. L'ouverture demande le code du gérant (droit « Ouvrir une caisse »).
- Clôture à l'aveugle : le caissier compte par coupure avant de voir l'attendu ; au-delà du seuil d'écart (500 FCFA par défaut, Administration › Paramètres) il faut un motif et le code du gérant, et le premier comptage reste tracé. Le caissier choisit le fond laissé dans le tiroir ; le reste est versé à la caisse centrale avec un bon de versement à signer. Rapport Z et rapport de clôture A4 (entrées, sorties, historique des ventes, signatures) réimprimables. Une caisse restée ouverte d'un jour sur l'autre est signalée.
- Caissier sans les montants : sans le droit « Voir les montants de la caisse » (donné par défaut au gérant et au comptable), le caissier ou le vendeur ne voit dans Trésorerie que l'état de sa caisse, l'ouverture, la clôture et les sorties d'espèces qu'il a faites lui-même : ni entrées, ni ventes, ni attendu, ni historique des journées, ni Z. Il compte à l'aveugle et ne reçoit que le bon de versement ; un écart au-delà du seuil est validé sur place par le gérant, qui saisit son code, voit l'écart et en donne le motif. Sans le droit « Voir tout le registre des factures », Mes factures et Registre montrent ses trois dernières factures, à réimprimer. Le serveur de l'application applique ces règles, pas seulement l'écran.
- Dépenses et écarts de caisse : une dépense en espèces saisie par un caissier ou un vendeur sort toujours de sa caisse (fenêtre Dépenses comme fiche de facturation) et apparaît dans ses sorties ; le gérant choisit entre la caisse centrale (par défaut) et sa caisse. Le caissier clôture sans code du gérant : son comptage est enregistré tel quel. Un écart au-delà du seuil reste « à justifier » : le gérant le voit dans la barre d'état et l'historique des journées, interpelle le caissier puis saisit le motif (« Justifier l'écart »).
- Caisse centrale (99) : reçoit la recette de chaque caisse, donne les fonds et apports, paie au bureau en espèces (fournisseurs, dépenses, règlements reçus) ; entrées et sorties (banque, exploitant) avec bon imprimé, livre avec solde progressif. Compte 5712, mouvements entre caisses par le 585.
- TVA facultative : à la création du magasin, la case « assujetti à la TVA » est décochée (régime simplifié). Sans TVA, ventes, devis, factures, achats et dépenses sont sans TVA et les tickets et factures portent « TVA non applicable ». Un administrateur peut l'activer ensuite (Administration › Paramètres).
- Ignorer la gestion des stocks (Administration › Paramètres, droit du gérant) : la caisse vend même si le stock en machine est épuisé ; la prochaine réception régularise automatiquement le stock négatif.
- Ticket, rapport Z, reçu de règlement et bon de sortie de caisse imprimés au choix par le pilote Windows ou en ESC/POS direct : imprimante USB installée sous Windows (envoi brut par le spouleur) ou imprimante réseau (IP, port 9100). Papier 80 mm (48 ou 42 caractères) ou 58 mm (32), accents français (tables PC850, PC858 ou WPC1252), coupe automatique.
- Tiroir-caisse branché sur l'imprimante : ouverture à chaque encaissement en espèces ou à chaque vente, bouton Tiroir (F5) tracé dans le journal d'audit, page de test dans Administration › Paramètres.

**Stock**
- Fiches articles : rayon/famille, marque, unité, TVA, prix d'achat, prix de vente TTC, marge, prix propre à un magasin, historique des prix, plusieurs codes-barres, codes internes générés (préfixe 20).
- Import du catalogue depuis Excel (CSV).
- Dépôts par magasin (surface de vente, réserve, chambre froide), réceptions avec lot et date limite (obligatoire pour les périssables).
- Valorisation au CMUP, sortie en FEFO, pertes (casse, vol, péremption, consommation interne) avec motif, transferts entre dépôts avec dates conservées.
- Inventaires enregistrés (Stock › Inventaires), sans fermer le magasin : inventaire global (tous les produits du dépôt) ou partiel (des rayons, ou des produits ajoutés un par un). La liste des produits s'affiche dès la création ; on tape les quantités, Entrée passe à la ligne suivante. Chaque saisie est enregistrée et horodatée, les ventes passées depuis sont déduites, et l'on peut reprendre plus tard.
- Fiche de comptage au choix (comme KONTROL) : modèle classique sans stock, avec le stock attendu, compté + attendu (contrôle) ou compté seulement ; en A4, ticket 80 mm, PDF ou fichier Excel à remplir puis réimporter (Excel ou CSV, en conditionnements et unités).
- Bons de transfert entre dépôts comme KONTROL : n°, statut Brouillon › Expédié › Réceptionné, bon de route et bon de réception, saisie du produit en Cond. et Qté, somme, impression A4 des bons avec signatures, quantité reçue et écart à la réception, mouvements des marchandises du bon. Les lots et dates de péremption suivent la marchandise.
- Monitoring de l'évolution du stock (Stock › Monitoring) : pour un produit, une période et un dépôt, chaque modification effective avec le stock avant, après, le delta, le motif et le login. Le magasinier demande une correction de stock avec un motif ; le stock ne bouge qu'après la validation du gérant.
- Fiche d'inventaire : stock à l'ouverture, mouvements de la période, stock attendu, compté, écart, CMUP, montant de l'écart et valeur comptée, en rose les déficitaires, en bleu les excédentaires, en vert les produits sans écart. Filtres, historique des saisies, export Excel et CSV, import d'un CSV de comptage, impression du résultat A4 avec signatures.
- Date d'inventaire antidatée possible (31/12) : le stock est arrêté à la fin de ce jour. La clôture corrige le stock (mouvements « Inventaire n° X ») ; dans un inventaire global les produits non comptés passent à zéro après confirmation, dans un partiel ils ne changent pas. Droits séparés « compter » (magasinier) et « créer, clôturer, annuler » (gérant).
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
- Solde du client affiché en couleur sur la fiche de facturation dès qu'il est choisi : vert s'il a un avoir, rouge s'il doit, gris à zéro ; le bouton « J.. » ouvre son extrait de compte. En tapant un nom, les clients existants qui y ressemblent sont proposés.
- Ristournes des clients spécifiques (Client › Ristournes), comme KONTROL : réglage de base par famille d'articles (taux du montant acheté, montant par unité, quantité minimale sur la période, frais d'enlèvement par unité déduits quand la superette livre le client), réglage propre à un client qui remplace la base. État des ristournes sur une période (report, calculée, constatée, accordée, reste), constatation d'une période terminée (jamais deux fois), ristourne accordée en avoir sur le compte du client ou en espèces depuis la caisse centrale avec bon de ristourne à signer, régularisations avec motif, reports à nouveau. Écritures : 7019 / 4198 à la constatation, 4198 / 411 pour l'avoir, 4198 / 5712 pour les espèces.

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
- Notes annexes calculées à partir des écritures (bouton Notes annexes) : immobilisations et amortissements (3A, 3C), stocks (6), clients (7), autres créances (8), disponibilités (11), capital (13), dettes financières (16A), fournisseurs (17), dettes fiscales et sociales (18), autres dettes (19), découverts (20), chiffre d'affaires et charges par compte (21 à 30), fiche de synthèse (34) et passage au résultat fiscal. Impression A4 et export CSV.
- Notes déclaratives saisies par exercice (Fiscal › Notes déclaratives de la DSF) et imprimées avec les autres :
  - dettes garanties par des sûretés et engagements donnés ou reçus (1) ;
  - informations obligatoires, avec des textes proposés qui décrivent les méthodes de l'application (2) ;
  - répartition du capital entre associés, comparée au capital du bilan (13B) ;
  - effectifs par catégorie, origine et sexe et masse salariale, comparée aux comptes 661 à 663 (27B) ;
  - informations sociales et environnementales (35).
  La saisie est partagée entre les PC du magasin.

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

**Promotions**
- Prix promotionnel (à l'unité ou au kg), offre « N achetés, M payés » (3 pour 2) ou lot à prix fixe (3 savons pour 1 000 FCFA), sur une période, pour tous les magasins ou un seul (Vente › Promotions ou Produit › Promotions).
- La caisse applique d'elle-même la meilleure promotion de chaque article, sans code gérant : l'écran affiche « Promo −X » sur la ligne et le total des promotions, le ticket détaille chaque promotion et « Vous avez économisé ». Les offres par quantité comptent les pièces sur toutes les lignes du même article.
- Arrêt ou relance d'une promotion à tout moment, suivi des quantités vendues et de l'économie accordée, total des promotions au rapport Z. Les promotions circulent vers tous les PC.

**Conditionnements et tarifs de gros**
- Fiche « Ajouter / paramétrer une marchandise » comme sur KONTROL : ligne 1, le conditionnement d'achat (PALETTE) avec ses prix d'achat, de revient, de vente, de gros et de super gros ; lignes 2 à 4, à cocher, les conditionnements de vente du plus grand au plus petit avec leur diviseur par rapport au conditionnement d'achat (CANETTE : 24). Leur achat et leur revient se calculent (17 000 / 24 = 708), leur prix de vente est proposé puis se modifie. Le dernier conditionnement coché est l'unité de stock.
- Les prix d'achat et de revient restent exacts au conditionnement d'achat ; une réception met à jour l'achat, le revient garde son écart (transport, manutention). La fiche affiche la marge sur le revient de chaque ligne et signale un conditionnement plus cher que ses unités vendues au détail. Champ « Autre réf. » cherché en caisse.
- Une fois l'article mouvementé, son unité de stock ne change plus (la CANETTE ne devient pas un conditionnement) : on peut ajouter un conditionnement plus grand, pas un plus petit.
- À la caisse, taper le début du nom (« mut ») liste chaque conditionnement sur sa ligne : MUTZIG 50CL PALETTE 24 000, MUTZIG 50CL CANETTE 1 000, avec le stock. Les produits sans stock restent listés, marqués « Épuisé », et ne peuvent pas être vendus (la vente est refusée aussi par le serveur de la caisse si le stock ne suffit pas). Choisir une ligne demande tout de suite la quantité et le prix : le caissier peut changer le prix, jamais sous le coût de revient du conditionnement ; la quantité reste modifiable dans la grille. F1 ouvre « Rechercher / Facturer des marchandises » : code, réf., produit, stock, conditionnement, dépôt, prix au tarif du client et dernier prix, case « Masquer les lignes épuisées », et boutons pour créer l'article ou le conditionnement supérieur ou inférieur absent.
- Client comptoir : une case « Nom du client (facultatif) » sous CLIENT COMPTOIR ; le nom s'imprime sur la facture et se retrouve dans le registre des ventes.
- Scanner le code du carton ajoute un carton (« 3*code » pour 3 cartons) ; « Varier » passe une ligne du carton au paquet ou à l'unité. Le ticket et la facture A4 affichent « 2 Carton x 10 500 ».
- Tarif de chaque client (Détail, Gros, Super gros) sur sa fiche : la caisse applique ses prix dès qu'il est choisi, sans code gérant ; un prix de gros vide reprend le prix de détail. Les promotions ne s'appliquent qu'au détail.
- Bons de commande, réceptions et réception libre se saisissent par conditionnement (1 carton à 10 000 FCFA plutôt que 100 ampoules à 100 FCFA), proposé par défaut au conditionnement d'achat. L'état du stock affiche aussi la quantité en cartons, paquets et unités.

**Étiquettes de rayon et inventaire**
- Produit › Étiquettes de rayon : liste « À refaire » des étiquettes à imprimer, articles reçus jamais étiquetés et prix changés depuis la dernière impression (ancien prix barré), par rayon ou par recherche. Une étiquette par unité et par conditionnement (Carton de 100 : 10 500 F, soit 105 F l'unité).
- Prix du magasin, promotion comprise (ancien prix barré, bandeau PROMO ou « 3 pour 2 »), code-barres EAN-13, EAN-8 ou Code 128 dessiné sur l'étiquette, date d'impression pour repérer une étiquette périmée.
- Planches A4 de 24, 40 ou 65 étiquettes, ou rouleau d'imprimante d'étiquettes 50 × 30 mm. Aperçu fidèle avant impression, nombre d'exemplaires par article, et « étiquettes déjà utilisées » pour finir une planche entamée.
- Inventaire saisi en cartons, paquets et unités (3 cartons 2 paquets 4 ampoules = 324). Fiche de comptage A4 par rayon, avec une case par conditionnement, à imprimer avant de compter.

**Devis et factures proforma**
- Devis (DV-) ou facture proforma (PF-) pour un client enregistré ou un simple prospect, avec durée de validité, remises par ligne (code du gérant pour un caissier) et conditions.
- Impression A4 avec le montant en lettres (« Arrêtée la présente facture proforma à la somme de cent-cinquante-cinq-mille francs CFA »), la date de validité et le « Bon pour accord » du client.
- Facturation depuis la caisse (Action › Facturer un devis / proforma) : les lignes et le client sont repris, et les prix du document sont garantis jusqu'à sa date de validité même si le tarif a augmenté entre-temps, sans code gérant. Le document passe « facturé » sur tous les PC ; un devis expiré ou annulé ne se facture plus.

**Pilotage et administration**
- Page d'accueil au nom du magasin avec les fenêtres les plus utilisées ; écrans en couleurs (bandeaux verts, lignes alternées, champs clés en jaune, tuiles de chiffres colorées).
- Tableau de bord du jour : CA, tickets, panier moyen, marge par rayon, ventes par heure, meilleures ventes.
- Export CSV des ventes.
- Caisses attribuées aux utilisateurs : l'administrateur crée, renomme et désactive autant de caisses qu'il veut (Administration › Caisses) et attribue une caisse à chaque utilisateur (Administration › Utilisateurs). Le caissier ou le vendeur vend sur sa caisse depuis n'importe quel PC du magasin ; sans caisse attribuée il ne peut pas vendre. Le gérant et l'administrateur sans caisse choisissent la leur au moment de vendre (barre d'état ou Trésorerie). La numérotation des tickets et des Z reprend après les numéros reçus des autres PC. À la mise à jour, chaque caissier garde la caisse de sa dernière vente.
- Magasins, caisses (code d'activation), dépôts, utilisateurs et rôles (administrateur, gérant, caissier, vendeur, responsable d'achat (appro), magasinier, comptable), paramètres, journal d'audit.
- Droits par rôle (Administration › Droits par rôle) : l'administrateur coche pour le gérant, le caissier, le vendeur, le responsable d'achat, le magasinier et le comptable les fenêtres qu'ils ouvrent et les actions de caisse et de gestion qu'ils font (changer un prix, remise sans code, sortie de caisse, inventaire, import…). L'administrateur garde tous les droits. Les réglages partent au serveur central et valent sur tous les PC.

**Rapports de ventes**
- Vente › Rapports de ventes : chiffre d'affaires TTC et HT, marge brute et taux de marge, tickets, panier moyen, retours, remises et promotions, sur une période toute faite (aujourd'hui, semaine, mois, mois dernier, année) ou libre.
- Regroupement au choix : jour, semaine, mois, heure, jour de la semaine, rayon, famille, article (avec quantités), caissier, caisse, client ou moyen de paiement (espèces nettes de la monnaie rendue). Colonnes triables et part de chaque ligne dans le CA.
- Comparaison avec la période précédente (un mois entier avec le mois d'avant) ou la même période de l'an dernier, avec l'évolution en % par ligne.
- Export Excel (.xlsx) pour le comptable : synthèse, regroupement choisi, encaissements par moyen de paiement, TVA collectée par taux et détail de chaque ligne vendue (date, ticket, caissier, client, article, quantité, prix, TVA, coût, marge). Les retours sont déduits au coût de la vente d'origine.

**Menus rangés comme KONTROL**
- Vente, Achats, Trésorerie, Produit, Fournisseur, Client et Charge reprennent l'ordre et les intitulés des menus de KONTROL, en groupes séparés par un trait.
- Vente : ouvrir une facture par son numéro, registre des ventes de toutes les caisses (recherche par numéro, client ou montant, export Excel), retours clients, tickets annulés, factures cumulées par client, situation des ventes, évolution périodique et alertes sur les ventes (ventes à perte, remises importantes, annulations, retours, plafonds de crédit forcés).
- Achats : nouvel achat, registre des achats, registre des achats par produit (coût mini, maxi et dernier coût, fournisseurs), registre des réceptions et marchandises commandées non encore reçues (reliquats, retards de livraison).
- Trésorerie : positions des caisses, banques et Mobile Money, extrait de compte, listing des opérations de caisse (fonds de caisse, apports, prélèvements, dépenses au tiroir, règlements clients, écarts de clôture) et recherche dans les caisses.
- Produit : ajouter / paramétrer une marchandise, articles par dépôt, rayonnage (rayons et familles avec stock et ruptures), historique des ajustements de stock, déstockages et stocks critiques.
- Fournisseur et Client : extrait de compte, situation, comptes dont le solde a bougé récemment ; contrôle des plafonds d'autorisation des clients à crédit.
- Charge : types de charge, définition des charges fixes (loyer, ENEO, salaires, CNPS… avec rythme et jour d'échéance), historique des dépenses et constats de charges : chaque échéance est « constatée » par la dépense qui la paie, en un clic depuis l'échéancier. Les charges en retard sont signalées dans la barre d'état.

**Sauvegardes**
- Copie de la base une fois par jour, sans arrêter la caisse (Administration › Sauvegardes), dans le dossier « sauvegardes » à côté de la base ou un autre dossier. Chaque copie est relue et vérifiée, les 14 plus récentes sont gardées (nombre réglable).
- Copie de chaque sauvegarde vers un second dossier : clé USB ou dossier OneDrive / Google Drive. Une clé débranchée est signalée sans bloquer la sauvegarde.
- « Sauvegarder maintenant », « Copier sur une clé USB… » (jamais effacée par la rotation) et « Sauvegarde en retard » dans la barre d'état après 2 jours sans sauvegarde réussie.
- Restauration par l'administrateur, depuis la liste ou un fichier : contrôle du fichier, confirmation en tapant RESTAURER, copie « Avant restauration » de la base actuelle, redémarrage, trace dans le journal d'audit. Les réglages de sauvegarde du PC sont conservés.

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

1. Hébergement du serveur central (VPS ou PC toujours allumé) et adresse de mise à jour automatique.
