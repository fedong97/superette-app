# FEDONIX 360

Logiciel de FEDONG (anciennement « Superette Gestion »).

Logiciel de gestion de superette pour le Cameroun (FCFA, TVA 19,25 %, MTN Mobile Money, Orange Money).
Application de bureau Windows (installateur `.exe`), base locale hors ligne, multi-magasins et multi-caisses.

Ce dépôt couvre la **phase 1 : caisse et stock**, et le **serveur central** qui relie les caisses et les magasins.

## Ce qui fonctionne

**Caisse**
- Scan douchette (EAN-13, EAN-8, UPC), recherche par nom, touches rapides, `3*code` pour multiplier.
- Conditionnements (un code-barres « carton de 24 » sort 24 unités).
- Articles au poids : saisie du poids ou étiquette balance à prix ou poids intégré (préfixes 21/22 paramétrables).
- Paiements mixtes : espèces avec rendu monnaie, MTN Mobile Money et Orange Money (référence obligatoire), carte, bon d'achat.
- Paiement Mobile Money automatique (Administration › Paiement mobile) : la caisse envoie une demande de paiement au téléphone du client (MTN MoMo API Collection « requesttopay », Orange Money API paiement marchand) et ajoute le paiement avec le numéro de transaction quand le client a confirmé. Trois modes par moyen : Simulation (aucun compte, confirmation après 5 secondes, numéro finissant par 0 refusé), Test MTN (sandbox de momodeveloper.mtn.com : l'utilisateur et la clé de l'API sont créés avec la seule clé d'abonnement, montants en EUR comme l'exige le sandbox) et Réel (XAF, environnement `mtncameroon`). Les clés restent dans les réglages du poste (table `settings`, non synchronisée) ; les demandes sont gardées dans `mobile_payments`. Le mode Réel d'Orange Money est à valider avec les accès du compte marchand.
- Remises par ligne, validées par le code d'un gérant si le caissier n'en a pas le droit.
- Tickets en attente (F10 rappelle un ticket, le nombre en attente s'affiche sur le bouton), annulation et retour client sous code gérant, apports et prélèvements d'espèces.
- Aucune vente tant que la caisse n'est pas ouverte. Ouverture et clôture dans Trésorerie › Opérations de trésorerie : choix de la caisse, journée en cours, entrées et sorties d'espèces avec heure, montant, nature, motif et tiers, ventes à crédit, attendu, relevé et différentiel à la clôture, historique des journées.
- Fond de caisse : à l'ouverture, le fond laissé la veille est proposé ; un complément vient de la caisse centrale, un surplus y retourne. Le caissier ou le vendeur ouvre sa caisse seul avec le fond laissé la veille (ou moins) ; seul un complément pris dans la caisse centrale demande le code du gérant (droit « Compléter le fond de caisse »).
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
- Fiche de comptage au choix : modèle classique sans stock, avec le stock attendu, compté + attendu (contrôle) ou compté seulement ; en A4, ticket 80 mm, PDF ou fichier Excel à remplir puis réimporter (Excel ou CSV, en conditionnements et unités).
- Bons de transfert entre dépôts : n°, statut Brouillon › Expédié › Réceptionné, bon de route et bon de réception, saisie du produit en Cond. et Qté, somme, impression A4 des bons avec signatures, quantité reçue et écart à la réception, mouvements des marchandises du bon. Les lots et dates de péremption suivent la marchandise.
- Monitoring de l'évolution du stock (Stock › Monitoring) : pour un produit, une période et un dépôt, chaque modification effective avec le stock avant, après, le delta, le motif et le login. Le magasinier demande une correction de stock avec un motif ; le stock ne bouge qu'après la validation du gérant.
- Fiche d'inventaire : stock à l'ouverture, mouvements de la période, stock attendu, compté, écart, CMUP, montant de l'écart et valeur comptée, en rose les déficitaires, en bleu les excédentaires, en vert les produits sans écart. Filtres, historique des saisies, export Excel et CSV, import d'un CSV de comptage, impression du résultat A4 avec signatures.
- Date d'inventaire antidatée possible (31/12) : le stock est arrêté à la fin de ce jour. La clôture corrige le stock (mouvements « Inventaire n° X ») ; dans un inventaire global les produits non comptés passent à zéro après confirmation, dans un partiel ils ne changent pas. Droits séparés « compter » (magasinier) et « créer, clôturer, annuler » (gérant).
- Alertes de péremption (J-7, J-3, J-1, périmé), niveaux rupture/alerte/surstock.
- Inventaire sur téléphone Android (0.55.0, application FEDONIX 360 Inventaire, `apps/inventory`, Capacitor) : le gérant relie un téléphone au magasin avec le QR code de `/gerant/inventaire` (code d'une seule utilisation, 15 minutes ; le téléphone n'entre pas dans le nombre de PC de la licence et ne lit que le catalogue et les inventaires ouverts). Le compteur se connecte avec son identifiant et son code (droit « Saisir le stock physique »), scanne avec l'appareil photo (ML Kit), une douchette Bluetooth ou un terminal à scanner, saisit en conditionnements et unités, et compte hors ligne. Les quantités sont gardées par endroit (rayon, réserve…) : la dernière saisie d'un endroit l'emporte et le total des endroits devient la saisie de l'inventaire, envoyée aux PC (`inventory_line`, `inventory_entry`). Mode rafale (+1 par scan), annulation de la dernière saisie, codes inconnus avec photo, rayons confiés à chaque compteur, avancement et produits par heure, gros écarts (2 unités et 10 % du stock attendu) proposés à un autre compteur, stock attendu masqué sauf réglage. L'heure du téléphone est corrigée par celle du serveur. L'APK signé se construit dans GitHub Actions (Installateurs › artefact FEDONIX-360-Inventaire-android). Depuis 0.56.0 : catalogue envoyé sans les photos (la vignette d'une fiche est demandée à part, `/api/v1/mobile/articles/:id/thumb`) et recherche de secours sur le serveur (`/api/v1/mobile/find?q=`) quand un code ou un nom n'est pas sur le téléphone ; mode fichier sans serveur (fiche à remplir du PC en Excel ou CSV, ou fichier texte « code;nom (conditionnement);quantité »), export de la fiche remplie pour le bouton Importer du PC ; onglet Produits avec filtres À compter / Comptés ; remise à 0 d'un endroit ou de tout l'inventaire ; récapitulatif par endroit partagé en CSV ; inventaires clôturés gardés en lecture seule. Aides sans compte : `/gerant/inventaire` › « Ajouter un aide » crée un accès (table `mobile_guests`) à un seul inventaire, avec un code à 6 chiffres et un QR code `FEDONIX360:{"u":[...],"g":"123456"}` qui relie aussi le téléphone de l'aide ; 24 h au plus, fin à la clôture ou sur « Couper » ; sans prix ni stock attendu ; les saisies partent aux PC au nom du responsable choisi (`counted_by`, `user_id`) et gardent l'aide dans `counter` pour le suivi du gérant. Depuis 0.57.0 : à la première synchronisation avec un serveur, puis sur Administration › Serveur central › « Renvoyer au serveur ce qui lui manque », le PC demande au serveur les identifiants qu'il a pour chaque donnée de référence (`POST /api/v1/sync/known`) et remet dans sa file d'envoi ce qui manque (serveur réinstallé ou vidé, sauvegarde restaurée : la file était vide alors que le serveur n'avait pas les produits, et le téléphone recevait un catalogue vide).
- Inventaires à plusieurs PC : chaque PC compte sa partie et voit les comptages des autres ; pour un même produit, la saisie la plus récente l'emporte. Transferts, demandes de correction et leur validation passent aussi d'un PC à l'autre. Les numéros portent le code du poste (DLA11-4, DLA12-1) pour ne jamais se doubler.

**Fabrication**
- Recettes (menu Fabrication) : un produit fini fait de composants, pour un lot de N unités, avec le coût de revient estimé au CMUP actuel et la marge sur le prix de vente.
- Ordres de fabrication (OF-…) : brouillon avec les composants nécessaires et le stock disponible, puis « Fabriquer » sort les composants du stock et entre le produit fini au coût de revient (somme des CMUP). Refus si un composant manque, sauf avec « Ignorer la gestion des stocks ». Bon de fabrication A4 avec signatures, liste des ordres, droit « Fabrication » pour le gérant et le magasinier. Recettes et ordres se synchronisent.

**Fournisseurs et achats**
- Fiches fournisseurs (NIU, délais de paiement et de livraison, franco), articles référencés avec référence fournisseur, prix négocié, colisage et fournisseur principal.
- Bons de commande numérotés (BC-…), brouillon puis envoyé, impression A4, réception en une ou plusieurs fois avec reliquat, écart de prix signalé, solde ou annulation.
- Réception libre sans commande toujours possible depuis le Stock ; chaque réception produit un bon de réception (BR-…).
- Factures et avoirs fournisseurs (FF-…/AF-…) rapprochés des bons de réception, refus des doublons, échéance calculée sur le délai de paiement.
- Règlements en espèces, virement, chèque, MTN Mobile Money ou Orange Money (référence obligatoire hors espèces), échéancier avec retards, solde dû par fournisseur.
- Proposition de commande : ventes moyennes des 4 dernières semaines, délai de livraison, stock d'alerte et colisage ; filtres par rayon, par fournisseur et « ruptures seulement », quantité en cartons et pièces, export Excel et impression A4 par fournisseur ; un bon par fournisseur en un clic.
- Commandes, réceptions et factures se synchronisent entre les PC du magasin ; les fiches fournisseurs sont communes à tous les magasins.

**Clients et vente à crédit**
- Fiches clients (NIU, téléphone, plafond de crédit, délai de paiement), communes à tous les magasins ; création rapide depuis la caisse.
- Fiche « V. crédit » : choix du client (F8), acompte en espèces avec les billets, le reste va au compte du client avec son échéance. Au-delà du plafond, le code d'un gérant est demandé et tracé.
- Facture A4 de n'importe quel ticket (F9), avec le client, la TVA par taux et l'échéance.
- Règlements clients à la caisse (menu Action) ou au bureau : espèces, MoMo, Orange Money, virement, chèque, carte. Les espèces reçues à la caisse entrent dans le Z. Reçu imprimé.
- Les règlements soldent automatiquement les ventes les plus anciennes ; retour d'un ticket au compte du client.
- Compte client, relevé imprimable sur une période, balance âgée (non échu, 1-30, 31-60, 61-90, plus de 90 jours).
- Solde du client affiché en couleur sur la fiche de facturation dès qu'il est choisi : vert s'il a un avoir, rouge s'il doit, gris à zéro ; le bouton « J.. » ouvre son extrait de compte. En tapant un nom, les clients existants qui y ressemblent sont proposés.
- Paie avec retenues légales (Administration › Paramètres › Paie, désactivée par défaut) : CNPS salariale 4,2 % et patronale 11,2 % sous plafond de 750 000 FCFA, accidents du travail 1,75 %, IRPP au barème annuel (abattements 30 % et 500 000 FCFA, rien sous 62 000 FCFA brut), CAC 10 % de l'IRPP, crédit foncier 1 % et 1,5 %, FNE 1 %, RAV et TDL par tranches ; tout est modifiable. Les collaborateurs déclarés portent les retenues : le salaire constaté garde le détail (colonnes `cnps`, `tax`, `employer_social`, `employer_tax`, `payroll` de `staff_salaries`), le net payé en tient compte, et les écritures passent les retenues du sous-compte du collaborateur vers 4311 et 4471, les charges patronales en 664 et 641. Bulletin détaillé et état mensuel des montants à verser.
- Relances par WhatsApp (Client › Situation, ou compte du client) : message rempli pour le client (solde, part échue, factures dues) à partir d'un modèle réglable, ouvert dans WhatsApp au numéro du client (indicatif 237 ajouté), relevé A4 enregistré en PDF pour le joindre, relance de tous les clients en retard à la suite. Chaque relance est gardée (date, auteur, montants) et affichée dans la balance âgée.
- Carte de fidélité (à activer dans Administration › Paramètres) : 1 point par tranche d'achat (1 000 FCFA par défaut), 1 point vaut 10 FCFA de remise, minimum 100 points pour payer avec ; tout est réglable. À la caisse, scanner la carte (code du client) ou taper son téléphone choisit le client ; il paie avec « Points fidélité ». Annulation et retour reprennent les points ; correction à la main avec motif (droit du gérant). Carte au format carte bancaire à imprimer, points sur le ticket. Les mouvements de points circulent vers tous les magasins ; en compta, un paiement en points passe en remise accordée (7019).
- Ristournes des clients spécifiques (Client › Ristournes) : réglage de base par famille d'articles (taux du montant acheté, montant par unité, quantité minimale sur la période, frais d'enlèvement par unité déduits quand la superette livre le client), réglage propre à un client qui remplace la base. État des ristournes sur une période (report, calculée, constatée, accordée, reste), constatation d'une période terminée (jamais deux fois), ristourne accordée en avoir sur le compte du client ou en espèces depuis la caisse centrale avec bon de ristourne à signer, régularisations avec motif, reports à nouveau. Écritures : 7019 / 4198 à la constatation, 4198 / 411 pour l'avoir, 4198 / 5712 pour les espèces.

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
- Fiche « Ajouter / paramétrer une marchandise » : ligne 1, le conditionnement d'achat (PALETTE) avec ses prix d'achat, de revient, de vente, de gros et de super gros ; lignes 2 à 4, à cocher, les conditionnements de vente du plus grand au plus petit avec leur diviseur par rapport au conditionnement d'achat (CANETTE : 24). Leur achat et leur revient se calculent (17 000 / 24 = 708), leur prix de vente est proposé puis se modifie. Le dernier conditionnement coché est l'unité de stock.
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
- Lisibilité et aide (0.31.0) : menus, onglets et la plupart des textes en gras. Un bouton « ? » (ou F1, sauf à la caisse où F1 cherche un produit) explique la page affichée : à quoi elle sert, comment faire pas à pas, raccourcis ; seules les parties permises à l'utilisateur s'affichent. Ctrl+K (ou « Rechercher un écran » dans la barre des menus) ouvre un écran en tapant son nom, sans tenir compte des accents. Le chemin de la page (Trésorerie › Opérations de trésorerie) s'affiche sous les onglets, avec « Accueil » pour revenir. Onglets rapides personnalisables par utilisateur : clic droit pour déplacer ou retirer un onglet, clic droit sur un écran d'un menu pour l'épingler, Fichier › Personnaliser les onglets rapides. Page d'accueil avec de grosses tuiles adaptées au rôle (caissier, gérant, magasinier, appro, comptable, administrateur). Aide › Guide de démarrage (les cinq premières choses à faire selon le rôle, affiché à la première connexion) et Aide › Quoi de neuf (affiché une fois après chaque mise à jour). Les pages vides disent quoi faire ensuite.
- Droits détaillés et paramètres (0.32.0) : Administration › Droits par rôle range environ 110 droits en 16 groupes (Facturation, Trésorerie, Fichier des clients, Achat de marchandises, Gestion des stocks, Transferts, Inventaire, Comptabilité, Paramétrage du système…), chacun marqué Menu, Bouton ou Fonction, avec recherche et « Tout cocher » par groupe. Un droit nouveau suit son droit d'origine tant qu'il n'a pas été réglé, pour garder les réglages d'avant. Administration › Privilèges par utilisateur donne un droit en plus (« Attribué ») ou en retire un (« Retiré ») à une seule personne, montre ce que son rôle lui donne (« Via son rôle ») et qui d'autre a le droit choisi ; les privilèges voyagent vers les autres postes. Chaque écran masque ou désactive les boutons non permis, et le serveur local les refuse aussi. Administration › Paramètres est rangé en sections avec recherche : identité (logo imprimé sur tickets et factures, RCCM, message du ticket), ventes et caisse (remise maximale sans code, arrondi des espèces à 5/10/25/50 FCFA, nombre de tickets, client obligatoire au-delà d'un montant, délai d'annulation, factures en attente, prix sous le coût), crédit clients (plafond et délai proposés, blocage des clients en retard), stock (alerte de péremption, stock d'alerte proposé, transfert réceptionné par un autre utilisateur), achats (délai fournisseur, marge proposée), sécurité (déconnexion après inactivité, longueur du code, blocage 15 minutes après trop de codes faux, avec « Débloquer »), préfixes des numéros (factures, avoirs, devis, proformas, bons de commande), et pour ce PC : imprimante, balance, grand texte et sauvegarde à heure fixe.
- Caisses électroniques (0.33.0) : le journal d'une caisse électronique (Trésorerie › Opérations de trésorerie) liste ses entrées (ventes, règlements clients) et ses sorties (remboursements, dépenses, règlements fournisseurs, versement), avec le moyen et la référence du transfert. Une dépense ou un règlement fournisseur payé par MTN MoMo ou Orange Money sort d'une caisse électronique : à la caisse, celle du caissier (« Dépense payée en caisse » se paie en espèces ou avec son compte, avec le code du gérant au-delà de ses droits) ; au bureau, celle choisie, la centrale par défaut. L'attendu d'une clôture vaut solde de départ + encaissé + transferts reçus − sorties, et le caissier voit ses sorties avant de saisir le solde du téléphone. Administration › Paramètres › Caisses électroniques choisit le fonctionnement : avec une caisse électronique centrale (le numéro du magasin, attribué à personne), chaque caissier y verse sa recette à la clôture, par moyen, avec la référence du transfert et un bon de versement, et peut garder un reste qui devient son solde de départ ; en caisses indépendantes, le solde relevé passe au lendemain. Le terminal de carte vire à la banque et ne garde rien. Une ristourne peut aussi être payée par MTN MoMo ou Orange Money : elle sort d'une caisse électronique (la centrale par défaut), avec la référence sur le bon de ristourne, et passe au compte Mobile Money du moyen. Trésorerie › Caisses électroniques (MoMo, OM) et centrale montre le solde de chaque caisse électronique et son livre, et enregistre transferts, dépôts à la banque et mouvements de l'exploitant avec bon (table `emoney_movements`, synchronisée). Un versement ou un transfert entre caisses électroniques reste sur le compte Mobile Money ; banque, exploitant et autres mouvements passent en comptabilité. À la première ouverture après la mise à jour, le solde de départ reprend le solde relevé à la dernière clôture.
- Encaisser, décaisser et collaborateurs (0.34.0) : dans Trésorerie › Opérations de trésorerie, le volet des entrées a un bouton « Encaisser » (client qui règle, fournisseur qui rembourse un avoir, collaborateur qui rend une avance, autre recette sur un compte choisi, 4711 par défaut) et celui des sorties un bouton « Décaisser » (reversement à la caisse centrale ou à une caisse électronique, règlement d'une facture fournisseur, charge, avance ou salaire d'un collaborateur, avoir remboursé à un client, autre). Chaque saisie a son mode (espèces, ou MTN MoMo et Orange Money avec la référence pour une caisse électronique), son n° de pièce et son motif, et compte dans l'attendu de la journée ; une sortie demande le code du gérant. Le bouton « Action » agit sur la ligne choisie : reçu en ticket ou A4 (« DUPLICATA » à la réimpression, sauf si l'impression est annulée), décharge A4 à faire signer, antidater (entre l'ouverture et maintenant), convertir une sortie « Autre » en règlement fournisseur ou en remboursement client, supprimer (journée ouverte). « Totaux par nature d'entrée / sortie » résume la journée. Les pièces qui ne sont ni vente, ni règlement, ni dépense vont dans la table `treasury_entries` (synchronisée). Charge › Collaborateurs tient la fiche de chaque employé ; à sa création, ses sous-comptes 4211… (rémunérations dues) et 4251… (avances) sont ajoutés au plan comptable (tables `staff`, `staff_salaries`). Salaires du mois : le salaire constaté passe 661 contre 4211…, les avances retenues 4211… contre 4251…, et le net se paie au bureau (caisse centrale, MoMo/OM, banque) ou à la caisse ; bulletin de paie simplifié et extrait de compte imprimables. Les retenues CNPS et IRPP ne sont pas calculées.
- Photo, facture directe, remises à l'achat et rattachement (0.35.0) : la fiche article reçoit une photo, réduite par l'interface (environ 400 px en JPEG, miniature de 96 px) et rangée dans la table `article_photos` ; elle part aux autres postes avec l'article et s'affiche dans la liste des produits et dans la recherche de la caisse. Chaque ligne du bon de commande, de la réception et de la facture directe a une remise en % et une promo « N achetés, M payés » (12/10 : 2 gratuits par tranche de 12, comptés dans l'unité saisie) ; le stock entre au coût net (gratuits et remises compris) et le prix d'achat de la fiche reste le prix du fournisseur. Achats › Saisir une facture directe enregistre en une fois la réception (bon créé et rattaché) et la facture, avec une remise globale répartie sur les lignes au prorata, et peut la régler tout de suite (caisse centrale, MoMo/OM, virement, chèque) ; elle s'imprime en A4. Comptablement, les remises commerciales réduisent l'achat (601) sans écriture séparée. Chaque collaborateur a un compte de rattachement (4211 Personnel par défaut, 4311 CNPS, 4471 État, 4621 Associés ou un autre compte de tiers de la classe 4) sous lequel son sous-compte est créé ; il ne change plus une fois que le sous-compte a des écritures.
- TVA désactivée et stock multi-magasin (0.36.0) : quand l'administrateur désactive la TVA du magasin, tous les articles passent au taux « Exonéré » (sauf si un autre magasin reste assujetti, les articles étant communs), un nouvel article ou un article importé est exonéré, et la lecture d'un article dans ce magasin donne 0 % quel que soit le taux de sa fiche. Les écrans, impressions (bon de commande, facture d'achat, proposition de commande, Z) et exports (classeur des ventes, CSV) n'affichent plus ni TVA, ni HT, ni TTC ; la déclaration de TVA et les champs TVA (facture fournisseur, dépense) sont masqués. À la réactivation, un bouton remet les articles exonérés à 19,25 %. Stock › Stock multi-magasin (onglet Stock MM) donne pour chaque article son stock dans chaque magasin et chaque dépôt : chaque PC envoie au serveur, à chaque synchronisation, le stock de son magasin qui a changé (entité `stock_level`, table `stock_published`), et les autres magasins le rangent dans `stock_levels` avec sa date ; les mouvements de stock, eux, restent dans leur magasin.
- Licence (0.37.0) : chaque installation s'active avec une clé signée par l'éditeur (Ed25519). Administration › Licence montre le code machine du PC (tiré du MachineGuid de Windows) ; l'éditeur crée la clé avec `tools/generateur-licences.html` (Chrome ou Edge, hors ligne) en choisissant la validité : mensuelle, annuelle ou à vie, le nombre de PC et de magasins. Le logiciel ne contient que la clé publique : il vérifie une licence sans pouvoir en fabriquer. Sans licence, 15 jours d'essai ; à la fin de la licence, 15 jours de grâce puis la caisse ne vend plus (consultation, clôture, sauvegardes toujours possibles). Une date de Windows reculée bloque aussi la vente. Le PC où la licence est activée l'envoie au serveur central, qui la donne aux autres PC du magasin et refuse un PC de plus que le nombre permis. La clé secrète de l'éditeur n'est jamais dans ce dépôt.
- Résumé du jour (0.39.0, Administration › Résumé du jour) : ventes, encaissements par moyen de paiement, caisses clôturées ou ouvertes et écarts, dépenses, règlements clients, cinq meilleures ventes, ruptures, écarts à justifier et clients en retard. Envoi par WhatsApp depuis l'écran (numéro du gérant), ou par e-mail chaque soir à l'heure choisie, depuis le PC où l'administrateur l'a réglé (SMTP, par exemple Gmail avec un mot de passe d'application, chiffré par Windows sur ce PC et jamais synchronisé) ; un PC éteint le soir envoie la veille au démarrage.
- Contrat de licence (`apps/desktop/build/contrat-licence.txt`) accepté pendant l'installation et lisible dans Administration › Licence.
- Suivi des clients (générateur de licences, partie 4) : tarifs par formule dans le paramétrage, prix et paiement de chaque licence, état (en cours, à relancer, en grâce, caisse arrêtée, renouvelée), relance WhatsApp préremplie avant la fin, montant non payé et encaissé de l'année, export Excel. Brochure commerciale d'une page A4 : `tools/brochure-fedo-gestion.html`, contact et tarifs à saisir, puis « Enregistrer en PDF ».
- Page d'accueil au nom du magasin avec les fenêtres les plus utilisées ; écrans en couleurs (bandeaux verts, lignes alternées, champs clés en jaune, tuiles de chiffres colorées).
- Tableau de bord du jour : CA, tickets, panier moyen, marge par rayon, ventes par heure, meilleures ventes.
- Points d'attention (Vente › Points d'attention, ou l'onglet rapide « Attention ») : une tuile par point qui attend une action, ruptures et alertes de stock, écarts de caisse à justifier, transferts expédiés non reçus, demandes de correction, ristournes à constater ou à accorder, inventaires en cours, factures fournisseurs et clients en retard, ordres de fabrication. Chaque tuile ouvre la fenêtre qui la traite ; chaque utilisateur ne voit que les points de ses droits.
- Export CSV des ventes.
- Caisses attribuées aux utilisateurs : l'administrateur crée, renomme et désactive autant de caisses qu'il veut (Administration › Caisses) et attribue une caisse à chaque utilisateur (Administration › Utilisateurs). Le caissier ou le vendeur vend sur sa caisse depuis n'importe quel PC du magasin ; sans caisse attribuée il ne peut pas vendre. Le gérant et l'administrateur sans caisse choisissent la leur au moment de vendre (barre d'état ou Trésorerie). La numérotation des tickets et des Z reprend après les numéros reçus des autres PC. À la mise à jour, chaque caissier garde la caisse de sa dernière vente.
- Caisses espèces, électronique et banque : à la création, l'administrateur choisit le type de la caisse (Espèces ; Électronique pour MTN Mobile Money, Orange Money et carte ; Banque pour virement et chèque) et attribue à chaque caissier au plus une caisse de chaque type. Les caisses existantes deviennent des caisses espèces. À la vente, le ticket reste unique et chaque paiement va à la caisse de son type ; un paiement mixte alimente les deux. Ouvrir sa caisse espèces ouvre aussi ses caisses électronique et banque. À la clôture d'une caisse électronique ou banque, le caissier saisit le montant relevé sur chaque téléphone, terminal ou relevé (à l'aveugle sans le droit des montants), le logiciel le compare à l'encaissé de la journée, le gérant justifie l'écart comme pour les espèces, et un bon de clôture A4 s'imprime avec chaque paiement reçu et sa référence. Le Z montre chaque caisse séparément et Trésorerie filtre les caisses et leurs journées par type. L'écart d'une caisse électronique ou banque est passé au compte du moyen de paiement (MTN, Orange, banque).
- Magasins, caisses (code d'activation), dépôts, utilisateurs et rôles (administrateur, gérant, caissier, vendeur, responsable d'achat (appro), magasinier, comptable), paramètres, journal d'audit.
- Chaque utilisateur ne voit que ce qu'il a le droit de faire : les menus, lignes de menu, onglets rapides, onglets et boutons non autorisés ne s'affichent pas du tout (pas de ligne grisée). Un menu sans aucune fenêtre permise disparaît.
- Droits par rôle (Administration › Droits par rôle) : l'administrateur coche pour le gérant, le caissier, le vendeur, le responsable d'achat, le magasinier et le comptable les fenêtres qu'ils ouvrent et les actions de caisse et de gestion qu'ils font (changer un prix, remise sans code, sortie de caisse, inventaire, import…). L'administrateur garde tous les droits. Les réglages partent au serveur central et valent sur tous les PC.

**Rapports de ventes**
- Vente › Rapports de ventes : chiffre d'affaires TTC et HT, marge brute et taux de marge, tickets, panier moyen, retours, remises et promotions, sur une période toute faite (aujourd'hui, semaine, mois, mois dernier, année) ou libre.
- Regroupement au choix : jour, semaine, mois, heure, jour de la semaine, rayon, famille, article (avec quantités), caissier, caisse, client ou moyen de paiement (espèces nettes de la monnaie rendue). Colonnes triables et part de chaque ligne dans le CA.
- Comparaison avec la période précédente (un mois entier avec le mois d'avant) ou la même période de l'an dernier, avec l'évolution en % par ligne.
- Export Excel (.xlsx) pour le comptable : synthèse, regroupement choisi, encaissements par moyen de paiement, TVA collectée par taux et détail de chaque ligne vendue (date, ticket, caissier, client, article, quantité, prix, TVA, coût, marge). Les retours sont déduits au coût de la vente d'origine.

**Menus rangés par métier**
- Vente, Achats, Trésorerie, Produit, Fournisseur, Client et Charge reprennent l'ordre et les intitulés habituels des logiciels de gestion, en groupes séparés par un trait.
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

**Fiches boutique (0.58.0)**
- Chaque boutique est un fichier. Fichier › Ouvrir une boutique, ou « Changer de boutique » à la connexion, liste les boutiques du PC (`poste.json` dans le dossier de données retient la dernière ouverte) ; les nouvelles boutiques et les fiches copiées vont dans `Documents\FEDONIX 360\Dossiers`. Changer de boutique relance le logiciel ; chaque boutique a ses utilisateurs. L'essai de licence est commun aux boutiques d'un PC.
- Administration › Fiches boutique sort une fiche `.fedonix` (copie à chaud, sans arrêter la caisse, sans les réglages du PC : licence, serveur, imprimantes, clés de code-barres) : fiche d'intervention (administrateur), copie pour le comptable (droit « Exporter la comptabilité »), installation préparée.
- Une fiche ouverte affiche un bandeau, ne vend pas, ne se relie pas au serveur et ne fait pas de sauvegarde automatique ; ses numéros portent un « T » (`DLA11T-…`) pour ne jamais croiser ceux de la boutique.
- « Rapporter une fiche » ajoute à la boutique ce qui a été fait dans la fiche depuis sa sortie, par le même chemin que la synchronisation (la modification la plus récente l'emporte), plus les réglages de la boutique changés et le journal d'audit. Les ventes faites par la boutique entre-temps restent ; les modifications repartent ensuite vers le serveur et les autres PC. Une fiche ne se rapporte qu'une fois.
- Installation préparée : une boutique paramétrée au bureau dans un nouveau fichier, sans vente ni journée de caisse d'essai, s'installe au premier démarrage du PC du client (« Installer une boutique préparée ») ; le PC du client démarre sa propre licence d'essai.
- Envoi : « Envoyer… » compresse la fiche en `.fedonixz` (gzip) pour un e-mail ou WhatsApp ; « Ouvrir une fiche » et « Rapporter une fiche » la décompressent à part sans toucher au fichier reçu.
- Dossier partagé (dossier réseau, OneDrive, Google Drive ; réglage du PC `share.*`) : copie du comptable déposée dans `Comptable` à la fréquence choisie (une seule, remplacée), fiches déposées dans `Retours` listées à rapporter puis rangées dans `Retours\Rapportées`. Plusieurs PC n'ouvrent jamais le même fichier SQLite à travers le réseau (risque de base abîmée) : chaque boutique garde sa base et les échanges passent par des fiches.
- Réparation (Administration › Réparation, administrateur) : `quick_check`, liens entre données, stock et lots comparés aux mouvements ; « Réparer » fait une sauvegarde puis recalcule par paquets de 200 sans bloquer la caisse. Au démarrage, une base qui ne s'ouvre plus propose la dernière bonne sauvegarde du dossier « sauvegardes » (la base abîmée est gardée en `.abimee`).

**Reprises et formats paramétrables (0.59.0)**
- Modèles de boutique (`.fedonix-modele`, JSON) : cinq métiers livrés (rayons, familles, réglages) et modèles enregistrés dans `Documents\FEDONIX 360\Modèles` (rayons, réglages sans logo ni en-tête ni RCCM, droits des rôles, catalogue au choix). Choix à la création de la boutique ou Administration › Modèles de boutique ; appliquer n'efface rien.
- Formats paramétrables (réglage `formats`) : import du catalogue par numéro de colonne (séparateur, lignes à sauter, virgule décimale) et export des écritures (colonne sens : journal, date JJMMAA, pièce, compte, tiers, libellé, sens, montant ; colonnes débit et crédit ; formats maison).
- Postes distants (`.fedonix-journee`, gzip, table `relay_log`) : l'installation d'un poste distant est une installation préparée sur la caisse du dépôt ; la remontée porte les opérations de son outbox depuis la précédente et s'intègre comme une synchronisation (la plus récente l'emporte) ; la mise à jour renvoie les opérations de la boutique sauf celles des autres magasins. Un fichier ne s'intègre qu'une fois.
- Contrôle avant clôture : exercice terminé, exercices précédents et pièces équilibrées bloquent ; journées de caisse ouvertes, fiches d'intervention pas rapportées, stock et lots à recalculer, opérations pas envoyées au serveur sont signalés sans bloquer.

**Reprise d'un magasin existant (0.60.0)**
- Administration › Reprise des données : clients et ce qu'ils doivent, fournisseurs et ce qu'on leur doit, stock de départ, un fichier Excel ou CSV par sujet (modèle téléchargeable, en-têtes reconnus avec ou sans accents). Aperçu ligne par ligne avant import ; une seule ligne en erreur et rien n'est importé.
- À-nouveaux passés seuls au journal AN contre le compte d'attente 4711 (411 / 4711, 4711 / 401, 311 / 4711). Les dettes et le stock repris ne sont ni des achats ni de la TVA déductible, et sortent des registres d'achats et des réceptions à facturer.
- Test automatique de la journée complète (`packages/db/test/journee.test.ts`) : commande, réception, ouverture de caisse, ventes en espèces, Mobile Money et à crédit, retour, règlement client, dépense, retrait vers le coffre, clôture Z, facture fournisseur, puis stock, caisse centrale, écritures et synchronisation vérifiés.

**Immobilisations (0.61.0)**
- Comptabilité › Immobilisations : registre des biens (catégories SYSCOHADA avec compte et durée proposés), amortissement linéaire au prorata des jours, plan d'amortissement imprimable.
- Écritures automatiques : acquisition (481, 521 ou à-nouveau 4711 avec amortissements antérieurs), dotation 681x / 28xx à chaque fin d'exercice, sortie (vente ou mise au rebut) avec 812, 485 et 822.

**Afficheur client (0.62.0)**
- Administration › Paramètres, section « Afficheur client (ce PC de caisse) », désactivé par défaut.
- Deuxième écran : fenêtre plein écran sur l'écran choisi, avec le logo, le dernier article scanné, le total, puis la monnaie rendue.
- Afficheur VFD à deux lignes (ESC/POS, Epson DM-D, CD5220…) sur un port COM. Une panne de l'afficheur ne bloque jamais la vente.

**Export, import complet et dépôts (0.63.0)**
- Produits › « Exporter Excel » / « Exporter CSV » : modèles catalogue complet (ré-importable tel quel), tarifs, codes-barres, comptage, terminal d'inventaire (.txt), valeur du stock, et modèles de colonnes enregistrés par magasin. Filtres rayon, famille, fournisseur, état ; choix du dépôt ; séparateur et décimale du CSV.
- Import des produits : tous les prix (achat, vente, gros, super gros), seuils mini / alerte / maxi, 3 conditionnements avec nombre, prix et code-barres, remplaçant. Modes créer + mettre à jour, créer seulement, mettre à jour seulement ; vérification ligne par ligne avant import ; reconnaissance des en-têtes de FEDONIX et des logiciels de gestion courants, et format intégré à colonnes fixes.
- Dépôts : modification (nom, type, responsable, téléphone, adresse), désactivation refusée tant que le dépôt a du stock, un transfert ou un inventaire en cours, ou qu'il est le dépôt des ventes.
- Mise à jour des prix en masse (pourcentage, montant, coefficient sur l'achat, arrondi) avec aperçu, produit remplaçant proposé en caisse, emplacements par dépôt, codification automatique par famille (paramètre), palmarès avec classes ABC et produits sans vente, en-têtes des logiciels de gestion courants reconnus dans la reprise des clients et fournisseurs.

**Roulette et écrans protégés (0.63.1)**
- La roulette de la souris fait défiler les menus de la barre verte qui dépassent l'écran, sans les fermer.
- Un écran en erreur affiche « Cet écran a rencontré un problème » avec « Réessayer », sans emporter le reste du logiciel.
- Tests automatiques dans le logiciel lancé (`npm run test:ecrans`, Playwright) : chaque menu et chacun de ses écrans s'ouvrent sans erreur, une vente complète au scan, la roulette des menus, et les écrans du caissier en anglais. Ils tournent aussi dans la vérification de chaque PR.

**Commandes clients (0.64.0)**
- Facturation et Vente › Commandes clients : commande par téléphone ou WhatsApp, numéro `CC-<poste>-00001` (préfixe dans Administration › Paramètres), confirmation par WhatsApp, retrait au magasin ou livraison avec frais.
- « Préparée » met la marchandise de côté : la caisse refuse de la vendre à un autre client. La caisse charge la commande (Action › Charger une commande client) et l'encaisse ; la commande passe à « Facturée ».
- Annulation avec motif (droit dédié), synchronisée avec le serveur central.

**Objectifs et commissions des vendeurs (0.65.0)**
- Charge › Collaborateurs › Objectifs et commissions : objectif du mois et du jour, taux atteint, nombre de tickets, commission au taux général ou par famille d'articles (0 à 50 %).
- Ventes comptées : ventes validées sous le compte du collaborateur (au comptant et à crédit) moins ses retours, frais de livraison exclus.
- Salaires du mois : brut proposé = salaire de base + commission, colonne Commission, libellé « commission comprise ».

**Serveur sur internet (0.66.0)**
- Image Docker du serveur (base intégrée, sauvegardes quotidiennes) et Caddy pour le HTTPS automatique ; `installer.sh` installe Docker, charge l'image, demande le domaine et le mot de passe, crée la clé d'enrôlement.
- Paquet `FEDONIX-360-serveur-internet-<version>` produit avec les installateurs ; guide pas à pas dans [docs/serveur-internet.md](docs/serveur-internet.md).

**Version anglaise (0.67.0)**
- Langue choisie par utilisateur (français par défaut), bouton « English / Français » dans la barre d'état et sur l'écran de connexion.
- Entièrement traduits : connexion, caisse, trésorerie, clients, ventes, commandes et livraisons, avec les messages d'erreur. Écrans du gérant et de la comptabilité : menus et titres.
- Langue du client (fiche client) pour ses tickets, factures, devis, bons de livraison, reçus et relevés, montant en lettres compris ; bons de caisse et rapport Z dans la langue de l'utilisateur.

**Employés, badge et pointage (0.68.0)**
- Fiche utilisateur : identifiant modifiable (unique, `a-z 0-9 . _ -`) ; suppression : effacé s'il n'a aucune opération et que le PC n'est pas relié au serveur, sinon retiré des listes (connexion impossible, nom gardé sur l'historique, identifiant libéré). Un administrateur actif reste toujours.
- « Ajouter un employé » : utilisateur, collaborateur (poste, téléphone, salaire) et badge en une transaction.
- Badge `FX` + 8 chiffres (Code128, format carte) : scanné à la connexion, il remplit l'identifiant.
- Pointage (droit « Pointage du personnel ») : arrivée à la première connexion du jour, départ à la clôture de caisse ou « Je pars » ; rapport du mois (heures, retards au-delà de la tolérance, absences sur les jours travaillés) ; correction avec motif. Synchronisé : première arrivée et dernier départ entre PC.

**Ma journée et mode formation (0.69.0)**
- Tuile « Ma journée » à l'accueil : ventes, retours, tickets, panier moyen, objectif du jour et du mois, commission.
- Mode formation (droit dédié) : copie de la boutique (fiche de type formation), bandeau orange, en-tête de ticket « FORMATION », aucune synchronisation ni sauvegarde ; ne se rapporte pas dans la boutique.

**WhatsApp (0.70.0)**
- Ticket envoyé au client (son numéro ou celui saisi), facture A4 en PDF en option ; bon de commande envoyé au fournisseur avec le PDF.

**Relève d'équipe (0.71.0)**
- Comptage à l'aveugle du caissier sortant, connexion du caissier entrant, bon de passation (attendu, compté, écart du tour). Table `cash_handovers` synchronisée ; le Z détaille chaque caissier (ventes nettes, tickets, écart de son tour).

**Téléphone du gérant (0.72.0)**
- Accord à distance : `POST /api/v1/approvals` (PC), réponse sur la page `/gerant` avec le code d'un gérant ou administrateur (vérifié sur la fiche synchronisée), lecture unique par le PC ; valable 2 minutes sur le PC, 3 minutes pour répondre.
- Alertes : écarts, remises au-delà du seuil, annulations, ruptures, PC muets, demandes d'accord. Son sur la page ouverte ; notifications Web Push (VAPID, sans bibliothèque) avec un serveur en HTTPS.

**Panier préparé au rayon (0.73.0)**
- Application Android : onglet panier pour un utilisateur qui a le droit « Préparer un panier au rayon » (prix indicatif du catalogue) ; envoi à `POST /api/v1/mobile/carts`, sans doublon.
- Caisse : « Rappeler » liste les paniers du magasin (`GET /api/v1/carts`), une seule caisse prend un panier ; la vente porte `seller_id` et compte pour le vendeur dans ses objectifs et commissions.

**Couleurs de l'entreprise et badge du personnel (0.74.0)**
- Administration › Couleurs et badges : couleur principale et secondaire (`brandColor`, `brandColor2` dans les paramètres, copiés dans tous les magasins). L'écran réécrit ses variables CSS (`--brand`, `--brand-soft`…), le texte posé dessus passe en noir ou blanc selon le contraste ; les documents A4 et les cartes de fidélité suivent.
- Badge : trois modèles (Bandeau, Arcs, Angles), carte bancaire, grand badge ou format libre, horizontal ou vertical, éléments au choix et verso (règles, dates, signature). Photo de l'employé dans la fiche utilisateur (caméra ou image), matricule, poste, téléphone et date d'entrée pris dans la fiche collaborateur.

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
apps/server-app   FEDONIX 360 Serveur : le serveur central en application Windows (base intégrée, interface, sauvegardes)
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

Sur GitHub, la vérification (`.github/workflows/verification.yml`) lance à chaque envoi sur `main` et à chaque demande de fusion la vérification des types, tous les tests, les tests du serveur sur PostgreSQL et la construction de l'application.

`npm test` recompile `better-sqlite3` pour Node, `npm run dev` le recompile pour Electron : c'est normal que le premier lancement de chacun prenne quelques secondes.

## Construire l'installateur Windows

Sur un PC Windows :

```bash
npm install
npm run build:win        # produit apps/desktop/release/Fedonix360-Setup-<version>.exe
```

Page du gérant : `/gerant` sur l'adresse du serveur est faite pour le téléphone et s'installe comme une application (manifeste et service worker, « Ajouter à l'écran d'accueil »). Après connexion avec le mot de passe de l'interface (case « Rester connecté » : 30 jours), elle montre pour chaque magasin, à partir du dernier état des fiches reçues des PC : chiffre du jour et de la veille, tickets et panier moyen, paiements par moyen, ventes par heure, meilleures ventes, état de chaque caisse (caissier, ouverture, dernière vente, PC muet), écarts des clôtures, ruptures (stock du magasin à zéro) et stock sous le seuil d'alerte, et les alertes. Elle s'actualise chaque minute ; un autre jour se choisit en haut.

Mise à jour automatique : on dépose `Fedonix360-Setup-<version>.exe` dans l'interface de FEDONIX 360 Serveur, onglet « Mises à jour ». Le serveur écrit lui-même `latest.yml` (version, empreinte SHA-512, taille) et sert les deux fichiers à l'adresse `/mises-a-jour/`. Chaque PC relié y cherche une nouvelle version au démarrage puis toutes les 4 heures, la télécharge et l'installe à sa fermeture (Administration › Mises à jour : état, « Installer maintenant », adresse internet pour une boutique sans serveur). Le serveur affiche la version de chaque PC.

## Installer le serveur central

### FEDONIX 360 Serveur pour Windows (le plus simple)

`apps/server-app` emballe le serveur dans une application Windows, **FEDONIX 360 Serveur**, avec sa base intégrée ([PGlite](https://pglite.dev), PostgreSQL compilé en WebAssembly) : rien d'autre à installer, ni PostgreSQL ni Node.js.

```bash
npm run build:win -w @superette/server-app   # → apps/server-app/release/Fedonix360-Serveur-Setup-<version>.exe
```

- L'installateur ouvre le pare-feu Windows pour l'application, et FEDONIX 360 Serveur démarre avec Windows (icône près de l'horloge ; fermer la fenêtre laisse le serveur tourner).
- La base est dans `%APPDATA%\FEDO Serveur\donnees`, les sauvegardes dans `Documents\FEDO Serveur\Sauvegardes` (une par jour, les 30 dernières gardées ; dossier et nombre réglables).
- L'interface (`http://localhost:3000/`, ou l'adresse du PC depuis un autre PC ou un téléphone, avec un mot de passe) montre l'état des postes, les ventes du jour par magasin, le journal de tout ce que les PC envoient, les ventes des 14 derniers jours, les sauvegardes (télécharger, restaurer) et la clé d'enrôlement, créée au premier démarrage.
- Le port (3000) se change dans `%APPDATA%\FEDO Serveur\reglages.json`.

### Serveur sur internet (VPS, Docker)

`deploy/` contient l'image Docker du serveur (base intégrée, sauvegardes quotidiennes), Caddy pour le HTTPS automatique et `installer.sh`, qui installe tout sur un serveur Ubuntu ou Debian en posant deux questions (nom de domaine, mot de passe). Le paquet `FEDONIX-360-serveur-internet-<version>` (image comprise) est construit par l'action Installateurs ; le pas-à-pas est dans [docs/serveur-internet.md](docs/serveur-internet.md).

```bash
docker build -f deploy/Dockerfile -t fedonix360-serveur .
```

### Serveur Node.js et PostgreSQL (VPS)

Sur un serveur Linux (VPS) ou un PC toujours allumé, avec Node.js 22 et PostgreSQL 14 ou plus :

```bash
npm install
npm run build -w @superette/server
DATABASE_URL=postgres://utilisateur:motdepasse@localhost:5432/superette \
ENROLLMENT_KEY=une-longue-phrase-secrete \
PORT=3000 \
npm start -w @superette/server
```

Les tables sont créées au premier démarrage. Sans `DATABASE_URL`, `DATA_DIR=/chemin/vers/un/dossier` utilise la base intégrée (sauvegardes dans `BACKUP_DIR`). Sans `ENROLLMENT_KEY`, le serveur crée une clé et l'affiche dans son interface (`http://adresse:3000/`). Le mot de passe de cette interface se donne dans `ADMIN_PASSWORD` (il se change ensuite dans l'interface). À chaque nouvelle version qui synchronise de nouvelles données (0.29.0 : inventaires, transferts, demandes de correction, ristournes, fabrication ; 0.36.0 : stock de chaque dépôt pour le stock multi-magasin), mettez à jour le serveur central avant les PC. `ENROLLMENT_KEY` (12 caractères minimum) protège l'enrôlement du premier PC ; les PC suivants n'en ont pas besoin, le code d'activation de leur caisse suffit. Sur Internet, placez le serveur derrière un proxy HTTPS (Caddy, Nginx).

## Données

La base est dans `%APPDATA%\Superette Gestion\superette.db` (variable `SUPERETTE_DB` pour en utiliser une autre).

