# Sauvegardes et reprise après panne — ONIX 360

*Guide pour le gérant et l'administrateur, à partir de la version 0.101.0. Il couvre le poste seul et le magasin à plusieurs PC, avec ou sans serveur central.*

À garder imprimé dans le bureau, avec la **fiche de secours** remplie (partie 4).

---

## 1. Comment ONIX 360 garde vos données

- **Chaque PC a sa propre base**, complète, sur son disque. Il vend même sans réseau.
- **Le serveur central** (ONIX 360 Serveur, sur un PC du magasin ou sur internet) n'est pas « la » base. C'est un carrefour : toutes les 20 secondes, chaque PC lui envoie ses opérations et reçoit celles des autres.
- **Conséquence** : quand plusieurs PC sont reliés, les données du magasin existent en plusieurs exemplaires (chaque caisse et le serveur). Une seule machine en panne ne fait presque rien perdre.
- **Une sauvegarde** est un seul fichier qui contient toute la boutique : articles, stock, ventes, clients, fournisseurs, caisses, comptabilité, utilisateurs et leurs codes.
  - Sur un PC : `superette-<magasin>-<caisse>-2026-10-29-1430-auto.db`.
  - Sur le serveur : `fedo-serveur-2026-10-29_14-30-00.tar.gz`.
- Chaque sauvegarde est **relue et vérifiée** au moment où elle est faite.

```
 Poste seul                         Plusieurs PC
 ┌──────────┐                       ┌──────────┐   ┌──────────┐   ┌──────────┐
 │  Caisse  │── clé USB             │ Caisse 1 │   │ Caisse 2 │   │  Bureau  │
 │ (sa base)│── OneDrive            │(sa base) │   │(sa base) │   │(sa base) │
 └──────────┘                       └────┬─────┘   └────┬─────┘   └────┬─────┘
                                         └──────┬───────┴──────────────┘
                                         ┌──────┴───────┐
                                         │ONIX 360      │── clé USB / 2e disque
                                         │Serveur       │── téléchargement du soir
                                         └──────────────┘
```

---

## 2. Les règles d'or

1. **Trois copies, deux supports, une hors du magasin.** Le disque du PC, une clé USB ou un second disque, et une copie qui quitte le magasin (OneDrive, Google Drive, clé emportée le soir, ou serveur sur internet). Un incendie, un vol ou la foudre touchent tout ce qui est dans la boutique.
2. **Une sauvegarde qu'on ne contrôle pas n'existe pas.** Regardez chaque matin la date de la dernière sauvegarde (partie 3.4).
3. **Une restauration jamais essayée ne marchera pas le jour J.** Faites un essai une fois par trimestre sur un autre PC.
4. **Le serveur central ne doit pas être une caisse.** S'il l'est, une seule panne vous fait perdre deux machines à la fois.
5. **Notez sur papier ce qu'il faut pour repartir** (fiche de secours, partie 4) et rangez-la hors du PC.

---

## 3. Régler les sauvegardes

### 3.1 Sur chaque PC (poste seul ou caisse d'un magasin)

Menu **Administration › Sauvegardes** (administrateur).

| Réglage | Où | Valeur conseillée |
| --- | --- | --- |
| Sauvegarde automatique | liste « Sauvegarde automatique » | **Toutes les heures** (toutes les 30 minutes si la boutique est très active) |
| Dossier des sauvegardes | « Changer » | Laisser le dossier proposé |
| Copie de chaque sauvegarde vers | « Choisir » | **Une clé USB laissée branchée** à l'arrière du PC, ou un dossier OneDrive / Google Drive |
| Sauvegardes automatiques gardées | nombre | 48 (deux jours avec une sauvegarde par heure) |

Ce que fait ONIX 360 tout seul :

- La sauvegarde se fait sans arrêter la caisse.
- Elle est recopiée sur la clé et relue là-bas.
- Si la clé était débranchée, les sauvegardes manquées y sont recopiées dès qu'elle revient.
- « Sauvegarde en retard » s'affiche dans la barre d'état après 2 jours sans sauvegarde réussie, et « Clé USB : copie en échec » si la copie ne passe pas.

À faire à la main :

- **Chaque soir, « Copier sur une clé USB… »** sur une **deuxième clé** que le gérant emporte chez lui. Cette copie n'est jamais effacée automatiquement.
- **Copie chiffrée sur le serveur central** (bas de la page) : à activer si le PC est relié à un serveur. Choisissez une **phrase secrète** et **notez-la sur papier** : sans elle, la copie est illisible, même pour l'éditeur. Attention : cette copie est rangée sur le serveur central. Si le serveur est un PC du magasin, elle reste dans le magasin.

### 3.2 Sur ONIX 360 Serveur (magasin à plusieurs PC)

Sur le PC serveur, ouvrez l'interface (`http://localhost:3000`, mot de passe de l'interface), onglet **Sauvegardes**.

| Réglage | Valeur conseillée |
| --- | --- |
| Fréquence | **Toutes les heures** ou toutes les 2 heures (6 heures par défaut) |
| Dossier des sauvegardes | Laisser `Documents\FEDO Serveur\Sauvegardes` |
| Copie vers un second dossier | **Une clé USB laissée branchée, ou un second disque**, par exemple `E:\ONIX-Serveur` |
| Nombre gardé | 48 ou plus |

- Sans second dossier, un message rouge rappelle que les sauvegardes restent sur le disque du serveur et disparaîtraient avec lui.
- Chaque sauvegarde est relue, copiée dans le second dossier, puis relue là-bas. Une clé débranchée est rattrapée quand elle revient.
- Si une sauvegarde du serveur échoue, prend du retard ou ne peut pas être copiée, **toutes les caisses** affichent « Serveur : sauvegarde à vérifier » dans leur barre d'état.
- **Chaque soir**, cliquez sur **« Télécharger »** à côté de la dernière sauvegarde, depuis n'importe quel PC du magasin, et copiez le fichier sur la clé que le gérant emporte.

### 3.3 Serveur sur internet

Le serveur loué (VPS) fait ses propres sauvegardes, hors du magasin. Il les garde dans `/opt/fedonix/donnees/sauvegardes`. Activez aussi la sauvegarde automatique proposée par l'hébergeur, et téléchargez une sauvegarde par semaine depuis l'interface. Voir [serveur-internet.md](serveur-internet.md).

### 3.4 Contrôle de tous les jours

**Le matin (2 minutes) :**

- [ ] Sur chaque PC, la barre d'état ne montre ni « Sauvegarde en retard », ni « Clé USB : copie en échec », ni « Serveur : sauvegarde à vérifier ».
- [ ] Le point à côté de l'état de la synchronisation est vert (plusieurs PC).
- [ ] La clé USB est branchée sur chaque PC qui en a une.

**Le soir :**

- [ ] « Copier sur une clé USB… » sur la clé du gérant (poste seul), ou « Télécharger » la dernière sauvegarde du serveur (plusieurs PC).
- [ ] La clé du gérant quitte le magasin.
- [ ] Les tickets et factures papier de la journée sont gardés jusqu'au lendemain.

**Une fois par trimestre :** essai de restauration sur un autre PC (partie 5.1), puis effacez ce PC d'essai.

### 3.5 Réglages conseillés selon le magasin

| Magasin | PC | Serveur | Copies à mettre en place |
| --- | --- | --- | --- |
| Petite boutique | 1 PC | aucun | Sauvegarde toutes les heures, clé USB branchée, OneDrive, clé du soir |
| Superette | 2 à 5 PC | ONIX 360 Serveur sur un PC qui n'est pas une caisse | Chaque PC : clé USB branchée. Serveur : toutes les heures, second disque ou clé, téléchargement du soir |
| Plusieurs magasins, ou gérant souvent absent | 1 à 10 PC par magasin | Serveur sur internet | Chaque PC : clé USB. Serveur : sauvegardes de l'hébergeur et téléchargement hebdomadaire |

---

## 4. La fiche de secours (à remplir et à ranger hors du PC)

| Information | À noter |
| --- | --- |
| Version d'ONIX 360 installée (barre d'état, en bas à gauche) | |
| Identifiant et code de l'administrateur | |
| Adresse du serveur central (ex. `http://192.168.1.20:3000`) | |
| Mot de passe de l'interface d'ONIX 360 Serveur | |
| Clé d'enrôlement (interface du serveur, onglet Réglages) | |
| Codes d'activation des caisses (Administration › Caisses) | |
| Phrase secrète de la copie chiffrée | |
| Nom et mot de passe de la box ou du routeur | |
| Réservations d'adresses IP faites dans la box | |
| Contact pour obtenir une nouvelle licence | |
| Où sont les clés USB et les copies OneDrive | |

---

## 5. Que faire en cas de panne

Avant tout : **ne réinstallez pas un PC qui marche encore, ne cliquez pas sur « Délier » au hasard**, et gardez les tickets papier. Trouvez votre cas ci-dessous.

| Ce qui est en panne | Les ventes s'arrêtent ? | Partie |
| --- | --- | --- |
| Le seul PC du magasin | Oui | 5.1 |
| Une caisse, le serveur marche | Seulement sur cette caisse | 5.2 |
| Le PC serveur (qui n'est pas une caisse) | Non | 5.3 |
| Le PC qui était à la fois serveur et caisse | Seulement sur cette caisse | 5.4 |
| Plusieurs PC à la fois (incendie, vol, foudre) | Oui | 5.5 |
| Le serveur sur internet | Non | 5.6 |
| La base ne s'ouvre plus au démarrage | Sur ce PC | 5.7 |

### 5.1 Poste seul : le PC est en panne ou volé

Il faut la clé USB, la copie OneDrive ou la clé du soir.

1. Installez ONIX 360 sur le nouveau PC, **même version que l'ancien ou plus récente**.
2. Branchez la clé (ou ouvrez le dossier OneDrive sur ce PC).
3. Au premier démarrage, cliquez sur **« Restaurer une sauvegarde (clé USB, OneDrive…) »**.
4. Choisissez le fichier `.db` **le plus récent** (la date et l'heure sont dans le nom). S'il y a un dossier sur la clé, regardez dedans. Si le fichier est refusé (« abîmé », « illisible »), prenez le précédent.
5. Vérifiez la fenêtre qui s'affiche : nom du magasin, nombre d'articles et de tickets, date de la dernière vente. Confirmez.
6. ONIX 360 redémarre. Connectez-vous avec **vos identifiants habituels**.
7. Faites les vérifications de la partie 6, puis **« Sauvegarder maintenant »**.
8. Refaites les réglages propres au PC (partie 8) : clé USB de copie, imprimantes, licence.
9. **Ressaisissez** les ventes, réceptions et dépenses faites après la sauvegarde, à partir des tickets et factures papier.

### 5.2 Plusieurs PC : une caisse est en panne, le serveur marche

Rien n'est perdu : ce que la caisse a fait est déjà sur le serveur et les autres PC (envoi toutes les 20 secondes). Il est inutile de restaurer sa clé USB.

1. Sur un autre PC, notez le **code d'activation** de la caisse : **Administration › Caisses**.
2. Dans l'interface du serveur, onglet **Postes**, cliquez sur **« Délier »** sur la ligne de l'ancien PC. Sans cela, le serveur répond « Cette caisse est déjà reliée à un autre PC ».
3. Installez ONIX 360 sur le nouveau PC.
4. Au premier démarrage, choisissez **« Rejoindre un magasin existant »**. Tapez l'adresse du serveur et le code d'activation.
5. Le PC récupère catalogue, utilisateurs, clients, ventes et stock du magasin. Connectez-vous avec vos identifiants habituels.
6. Réglez la sauvegarde de ce PC (partie 3.1) et ses imprimantes.

Seules les opérations que la caisse n'avait pas encore envoyées sont perdues : les dernières secondes avant la panne, ou toute la période où elle était coupée du réseau.

### 5.3 Plusieurs PC : le PC serveur est en panne

**Les caisses continuent de vendre.** Chaque PC garde ses opérations et les enverra tout seul au retour du serveur.

Pendant la panne, ce qui ne marche plus :

- une vente sur une caisse ne baisse plus le stock affiché sur les autres ;
- un nouveau produit ou un prix changé sur un PC n'arrive pas sur les autres ;
- le plafond de crédit d'un client n'est contrôlé qu'avec les ventes de la caisse où l'on est ;
- les factures de comptoir du vendeur, les téléphones ONIX 360 Mobile, la page du gérant et les accords à distance ;
- l'ajout d'un nouveau PC.

Consignes pendant la panne :

1. Changez les prix et les produits **sur un seul PC**.
2. Faites les ventes à crédit **sur une seule caisse**, ou vérifiez le crédit du client à la main.
3. Les vendeurs passent par la caisse directement.
4. Ne déliez aucune caisse.

**Remettre le serveur en route, avec une sauvegarde du serveur** (clé USB, second disque, fichier téléchargé) :

1. Choisissez un PC qui reste allumé et qui n'est pas une caisse. Installez **ONIX 360 Serveur**, de préférence la même version que l'ancien.
2. Donnez-lui **la même adresse IP que l'ancien serveur** (partie 7.3). Les caisses n'auront alors rien à changer.
3. Ouvrez `http://localhost:3000`, onglet **Sauvegardes**, partie « Remettre une sauvegarde venue d'ailleurs ». Choisissez le fichier `fedo-serveur-….tar.gz` le plus récent, puis **« Ajouter à la liste »**. Le fichier est vérifié.
4. Sur sa ligne, cliquez sur **« Restaurer »** et confirmez.
5. Les caisses se reconnectent seules. Chacune voit que le serveur a été restauré, **lui renvoie ce qu'il a perdu** (ventes, journées de caisse, règlements, réceptions, mouvements de stock…) et reçoit de nouveau les opérations des autres.
6. Si le nouveau serveur a **une autre adresse** : sur chaque caisse, **Administration › Serveur central › « Nouvelle adresse du même serveur »**, tapez la nouvelle adresse, puis **« Changer l'adresse »**. La caisse garde sa liaison : pas besoin de délier ni de clé d'enrôlement.
7. Sur chaque caisse, ouvrez **« État de la synchronisation »** : tout doit être vert. Une ligne orange se renvoie avec son bouton.
8. Réglez de nouveau la copie vers un second dossier et la fréquence (partie 3.2), puis faites « Sauvegarder maintenant ».

**Remettre le serveur en route sans aucune sauvegarde du serveur :**

1. Installez ONIX 360 Serveur neuf, de préférence à la même adresse IP. Notez sa nouvelle **clé d'enrôlement** (onglet Réglages).
2. Sur le poste principal : **Administration › Serveur central › « Délier ce PC »**, puis reliez-le avec l'adresse et la nouvelle clé. Il renvoie tout son historique au serveur.
3. Faites de même sur chaque autre caisse. Chacune renvoie ses données et celles qu'elle connaît des autres.
4. Vérifiez « État de la synchronisation » sur chaque caisse.
5. Reliez de nouveau les téléphones avec le QR code de la page « Téléphones » du serveur.

### 5.4 Le PC qui portait le serveur était aussi une caisse

On perd deux choses : le serveur et la base de cette caisse. Ce que la caisse avait envoyé se trouve sur les autres PC.

1. Remettez d'abord le serveur en route sur **un autre PC** (partie 5.3). Les autres caisses lui renvoient tout ce qu'elles ont, y compris les ventes de la caisse perdue.
2. Puis remplacez la caisse par **« Rejoindre un magasin existant »** (partie 5.2).
3. Profitez-en pour **séparer** : le serveur sur un PC qui n'est pas une caisse.

Les sauvegardes du serveur étaient sur le même disque par défaut : sans second dossier ni téléchargement, suivez « sans aucune sauvegarde du serveur » (partie 5.3).

### 5.5 Plusieurs PC en panne en même temps (incendie, vol, foudre)

Il faut une copie qui était **hors du magasin** : clé du gérant, OneDrive, serveur sur internet.

1. Rassemblez toutes les copies disponibles et regardez leurs dates. **Partez de la plus récente.**
2. **Si le serveur était sur internet** : il a tout. Sur chaque nouveau PC, « Rejoindre un magasin existant » (partie 5.2), en commençant par une caisse.
3. **Si vous avez une sauvegarde du serveur** : remettez le serveur en route (partie 5.3), puis chaque caisse par « Rejoindre un magasin existant ».
4. **Si vous n'avez que la sauvegarde d'un PC** (clé du soir, OneDrive) :
   1. Sur le premier nouveau PC, restaurez cette sauvegarde (partie 5.1, étapes 1 à 6).
   2. Installez un ONIX 360 Serveur neuf, puis reliez ce PC avec la clé d'enrôlement (partie 5.3, « sans aucune sauvegarde du serveur »). Il envoie tout son historique.
   3. Ajoutez les autres PC par « Rejoindre un magasin existant ».
5. Ressaisissez ce qui a été fait après la copie la plus récente, à partir des papiers.

### 5.6 Le serveur sur internet est en panne

Les caisses continuent de vendre (consignes de la partie 5.3). L'hébergeur remet le serveur en route, ou vous le réinstallez avec `installer.sh` puis restaurez une sauvegarde depuis l'interface. Les caisses s'en aperçoivent seules et renvoient ce qui manque. Si le nom de domaine reste le même, elles n'ont rien à changer.

### 5.7 La base ne s'ouvre plus au démarrage

ONIX 360 propose tout seul la dernière bonne sauvegarde du dossier « sauvegardes ». La base abîmée est gardée à côté, avec l'extension `.abimee`. Acceptez, puis faites les vérifications de la partie 6. Dans un magasin à plusieurs PC, préférez « Rejoindre un magasin existant » sur ce PC (partie 5.2) : il récupère aussi ce qui a été fait après la sauvegarde.

---

## 6. Vérifier après une restauration

1. Le nom du magasin et la caisse, dans la barre d'état.
2. Le nombre d'articles, et le stock de 3 ou 4 produits connus.
3. **La dernière vente** dans le registre des ventes : c'est le point où reprennent vos données.
4. Les soldes de quelques clients à crédit et fournisseurs.
5. L'état des caisses : une caisse restée ouverte au moment de la sauvegarde apparaît ouverte. Clôturez-la.
6. Plusieurs PC : « État de la synchronisation » en vert sur chaque caisse, et un même produit avec le même stock sur deux caisses.
7. Faites **« Sauvegarder maintenant »**.

---

## 7. Adresses du serveur et des PC selon le réseau

### 7.1 Ce qu'il faut savoir

- Les caisses trouvent le serveur grâce à son **adresse** : `http://` + **adresse IP** du PC serveur + `:3000`. Exemple : `http://192.168.1.20:3000`.
- **3000** est le port d'ONIX 360 Serveur. Il se change dans `%APPDATA%\FEDO Serveur\reglages.json` ; ne le changez que si un autre logiciel l'utilise déjà.
- Par défaut, la box ou le routeur donne une adresse IP **au hasard** à chaque appareil, et elle peut changer après une coupure de courant. **Seul le serveur a besoin d'une adresse qui ne change jamais.** Les caisses peuvent garder une adresse automatique.
- L'installateur d'ONIX 360 Serveur ouvre lui-même le pare-feu de Windows.
- Les caisses se parlent par le réseau local : **internet n'est pas nécessaire** pour que plusieurs PC du même magasin se synchronisent. Il faut seulement une box ou un routeur qui les relie.

### 7.2 Poste seul, sans réseau

Rien à régler. Les sauvegardes vont sur la clé USB et, si le PC a internet, sur OneDrive ou Google Drive.

### 7.3 Plusieurs PC dans un magasin (box ou routeur, câble ou Wi-Fi)

C'est le cas le plus courant. Il faut donner au PC serveur une adresse fixe. Deux méthodes :

**Méthode conseillée : la réservation dans la box (ou le routeur).**

1. Sur le PC serveur, ouvrez l'interface d'ONIX 360 Serveur : son adresse actuelle y est affichée. Ou tapez `ipconfig` dans l'invite de commandes et notez « Adresse IPv4 » et « Adresse physique ».
2. Ouvrez la page de la box dans un navigateur (souvent `http://192.168.1.1` ou `http://192.168.0.1` ; l'adresse et le mot de passe sont sous la box).
3. Cherchez **« DHCP »**, **« Réservation d'adresse »** ou **« Bail statique »**. Ajoutez le PC serveur avec son adresse actuelle (ex. `192.168.1.20`).
4. Redémarrez le PC serveur et vérifiez qu'il garde la même adresse.

Avantage : si le PC serveur est remplacé, on réserve la même adresse pour le nouveau, et les caisses n'ont rien à changer.

**Autre méthode : l'adresse fixe dans Windows**, si la box ne permet pas de réserver.

1. Sur le PC serveur : **Paramètres › Réseau et Internet › Ethernet (ou Wi-Fi) › Attribution d'adresse IP › Modifier › Manuel › IPv4**.
2. Adresse IP : choisissez une adresse **en dehors de celles que distribue la box**, par exemple `192.168.1.200` si la box distribue de `.2` à `.100`.
3. Masque de sous-réseau : `255.255.255.0`. Passerelle et DNS : l'adresse de la box (ex. `192.168.1.1`).
4. Enregistrez, puis vérifiez depuis une caisse que `http://192.168.1.200:3000` ouvre l'interface du serveur.

Conseils :

- **Branchez le serveur par câble** à la box. Le Wi-Fi convient aux caisses.
- Mettez le serveur et la box sur un **onduleur** : une coupure de courant ne doit pas couper le carrefour.
- **Ne mettez pas le serveur sur un partage de connexion de téléphone** : son adresse change à chaque fois.
- **Changement de box** (nouvel opérateur) : gardez la même plage d'adresses (`192.168.1.x`) et refaites la réservation. Sinon, sur chaque caisse : Administration › Serveur central › « Changer l'adresse ».
- **Le nom du PC** à la place de l'adresse (ex. `http://SERVEUR-ONIX:3000`) marche sur la plupart des réseaux de magasin. Il ne change pas avec l'adresse IP, mais certaines box ne le transmettent pas. Essayez-le depuis chaque caisse avant de l'adopter. Sinon, gardez l'adresse IP réservée.

### 7.4 Magasin sans internet fixe (clé 4G, partage de connexion)

- Pour relier les PC entre eux, achetez un **petit routeur ou une box sans abonnement** : elle crée le réseau local, même sans internet. Le serveur y a une adresse réservée (partie 7.3).
- Branchez la clé 4G sur ce routeur s'il le permet, pour les copies OneDrive et la mise à jour. Sinon, la synchronisation entre les PC marche quand même.

### 7.5 Plusieurs magasins, ou gérant qui suit le magasin à distance

- Mettez le serveur **sur internet** (serveur loué, voir [serveur-internet.md](serveur-internet.md)). Son adresse est un **nom de domaine** en `https://` (ex. `https://onix.mamaboutique.cm`). Elle ne dépend d'aucune box.
- Chaque PC de chaque magasin utilise cette même adresse. Sans internet, il continue de vendre et envoie tout au retour de la connexion.
- C'est aussi la meilleure protection contre l'incendie ou le vol : les données sont hors du magasin.

### 7.6 Dépôt éloigné sans réseau

Un dépôt sans aucun réseau fonctionne en **poste distant** : il échange un fichier de journée (`.fedonix-journee`) avec la caisse du magasin, par clé USB ou WhatsApp. Voir Administration › Postes distants.

### 7.7 Le serveur a changé d'adresse : que faire sur les caisses ?

| Situation | Sur chaque caisse |
| --- | --- |
| Même serveur, nouvelle adresse IP | Administration › Serveur central › « Changer l'adresse » |
| Sauvegarde du serveur remise sur un autre PC | Rien si l'adresse est la même ; sinon « Changer l'adresse » |
| Serveur neuf, sans sauvegarde | « Délier ce PC », puis le relier avec l'adresse et la nouvelle clé d'enrôlement |
| « Changer l'adresse » répond que le serveur ne connaît pas ce PC | Le serveur est neuf, ou sa sauvegarde est plus ancienne que la liaison de ce PC : « Délier ce PC », puis le relier avec la clé d'enrôlement |

---

## 8. Ce que la sauvegarde ne contient pas

Ces réglages sont propres à chaque PC. Après une restauration ou un « Rejoindre », refaites-les :

- la **licence** : elle est liée au code machine du PC. Le nouveau PC démarre en essai ; demandez une clé pour son code machine (Administration › Licence) ;
- les **imprimantes**, le tiroir-caisse et l'afficheur client ;
- le **dossier de copie** des sauvegardes (clé USB, OneDrive) ;
- les clés du paiement Mobile Money automatique ;
- le dossier partagé et l'envoi des rapports par e-mail.

---

## 9. Messages et solutions

| Message | Ce qu'il veut dire | Que faire |
| --- | --- | --- |
| Sauvegarde en retard | Aucune sauvegarde réussie sur ce PC depuis 2 jours | Administration › Sauvegardes : lire le problème, « Sauvegarder maintenant » |
| Clé USB : copie en échec | Clé débranchée, pleine, ou lettre de clé changée | Rebrancher la clé, ou choisir de nouveau le dossier de copie |
| Serveur : sauvegarde à vérifier | La sauvegarde du serveur échoue, est en retard, ou sa copie ne passe pas | Interface du serveur, onglet Sauvegardes |
| Serveur central injoignable | Serveur éteint, câble, Wi-Fi ou adresse changée | Vérifier le PC serveur et le réseau ; si l'adresse a changé, « Changer l'adresse » |
| Poste inconnu ou révoqué | Le serveur ne connaît pas ce PC | « Délier ce PC », puis le relier |
| Cette caisse est déjà reliée à un autre PC | L'ancien PC de cette caisse est encore inscrit | Interface du serveur › Postes › « Délier » sur l'ancien PC |
| Sauvegarde faite par une version plus récente | Le nouveau PC a une version plus ancienne d'ONIX 360 | Installer la même version ou une plus récente |
| Fichier abîmé, illisible | La copie est endommagée | Prendre la sauvegarde précédente |
| Phrase secrète incorrecte | La copie chiffrée ne peut pas être lue | Retrouver la phrase sur la fiche de secours |
