/**
 * Pages publiques du magasin, servies par le serveur : la boutique en ligne
 * (`/boutique/<code>`) et le vérificateur de prix (`/prix/<code>`). Elles sont
 * écrites ici (et non dans un fichier .html) pour partir avec le serveur sans
 * rien copier à la construction. Pas de bibliothèque, faites pour le téléphone.
 */

const esc = (v: string) => v.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** Page « fermée » (404) : boutique non ouverte en ligne, vérificateur non activé, magasin inconnu. */
export function closedPage(title: string, text: string): string {
  return `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${esc(title)}</title>
<style>
  body { margin: 0; font: 16px/1.5 system-ui, "Segoe UI", Roboto, sans-serif; background: #f4f5f7; color: #1d2430; }
  div { max-width: 480px; margin: 80px auto; padding: 24px; background: #fff; border: 1px solid #e4e7ec; border-radius: 14px; text-align: center; }
  h1 { font-size: 20px; margin: 0 0 10px; color: #155c39; }
  p { margin: 0; color: #667085; }
</style>
</head>
<body><div><h1>${esc(title)}</h1><p>${esc(text)}</p></div></body>
</html>`;
}

/** Boutique en ligne : catalogue, panier, livraison ou retrait, coordonnées, envoi de la commande. */
export const SHOP_PAGE = String.raw`<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#1f7a4d">
<title>Boutique en ligne</title>
<style>
  :root {
    --vert: #1f7a4d; --vert-fonce: #155c39; --vert-clair: #e7f4ec;
    --fond: #f4f5f7; --carte: #fff; --texte: #1d2430; --gris: #667085; --ligne: #e4e7ec;
    --rouge: #b42318; --rouge-clair: #fef3f2; --orange: #b54708; --orange-clair: #fffaeb;
  }
  * { box-sizing: border-box; -webkit-tap-highlight-color: transparent; }
  body { margin: 0; font: 15px/1.45 system-ui, "Segoe UI", Roboto, sans-serif; background: var(--fond); color: var(--texte); padding-bottom: calc(80px + env(safe-area-inset-bottom)); }
  header { background: var(--vert); color: #fff; padding: calc(14px + env(safe-area-inset-top)) 16px 14px; }
  header h1 { font-size: 19px; margin: 0; font-weight: 600; }
  header p { margin: 2px 0 0; font-size: 13px; opacity: .9; }
  main { max-width: 760px; margin: 0 auto; padding: 12px 16px 24px; }
  .message { background: var(--vert-clair); color: var(--vert-fonce); border-radius: 10px; padding: 10px 12px; margin-bottom: 12px; white-space: pre-line; }
  .erreur { background: var(--rouge-clair); color: var(--rouge); border-radius: 10px; padding: 10px 12px; margin-bottom: 12px; }
  input, textarea { font: inherit; font-size: 16px; width: 100%; padding: 10px 12px; border: 1px solid #d0d5dd; border-radius: 10px; background: #fff; color: var(--texte); }
  textarea { resize: vertical; min-height: 64px; }
  label { display: block; font-size: 14px; color: var(--gris); margin: 12px 0 4px; }
  .chercher { position: sticky; top: 0; z-index: 4; background: var(--fond); padding: 8px 0; }
  .rayons { display: flex; gap: 6px; overflow-x: auto; padding: 4px 0 8px; scrollbar-width: none; }
  .rayons button { white-space: nowrap; }
  button { font: inherit; font-size: 14px; padding: 7px 14px; border-radius: 999px; border: 1px solid var(--ligne); background: #fff; color: var(--texte); cursor: pointer; }
  button.actif { background: var(--vert); border-color: var(--vert); color: #fff; }
  button.principal { background: var(--vert); border-color: var(--vert); color: #fff; border-radius: 10px; padding: 12px 18px; font-size: 16px; font-weight: 600; width: 100%; }
  button:disabled { opacity: .55; cursor: default; }
  .liste { background: var(--carte); border: 1px solid var(--ligne); border-radius: 12px; }
  .art { display: flex; gap: 10px; align-items: center; padding: 10px 12px; border-top: 1px solid var(--ligne); }
  .art:first-child { border-top: 0; }
  .art img, .art .vignette { width: 52px; height: 52px; border-radius: 8px; object-fit: cover; background: #f2f4f7; flex: none; }
  .art .g { flex: 1; min-width: 0; }
  .art .nom { font-weight: 500; }
  .art .prix { font-weight: 600; color: var(--vert-fonce); }
  .art .prix s { color: var(--gris); font-weight: 400; font-size: 13px; margin-left: 4px; }
  .qte { display: flex; align-items: center; gap: 6px; flex: none; }
  .qte button { width: 36px; height: 36px; padding: 0; font-size: 20px; line-height: 1; border-radius: 50%; }
  .qte span { min-width: 44px; text-align: center; font-weight: 600; }
  .ajouter { flex: none; }
  .barre { position: fixed; left: 0; right: 0; bottom: 0; z-index: 6; background: #fff; border-top: 1px solid var(--ligne); padding: 10px 16px calc(10px + env(safe-area-inset-bottom)); }
  .barre div { max-width: 760px; margin: 0 auto; display: flex; gap: 12px; align-items: center; }
  .barre .total { flex: 1; }
  .barre .total small { display: block; color: var(--gris); font-size: 13px; }
  .barre button { width: auto; }
  .bloc { background: var(--carte); border: 1px solid var(--ligne); border-radius: 12px; padding: 14px; margin-bottom: 12px; }
  .bloc h2 { font-size: 16px; margin: 0 0 6px; }
  .somme { display: flex; justify-content: space-between; padding: 4px 0; }
  .somme.grand { font-weight: 700; font-size: 17px; border-top: 1px solid var(--ligne); margin-top: 6px; padding-top: 8px; }
  .choix { display: flex; gap: 8px; }
  .choix label { flex: 1; margin: 0; border: 1px solid var(--ligne); border-radius: 10px; padding: 10px; color: var(--texte); cursor: pointer; }
  .choix input { width: auto; margin-right: 6px; }
  .choix small { display: block; color: var(--gris); }
  .muted { color: var(--gris); }
  .merci { text-align: center; padding: 28px 16px; }
  .merci .ref { font: 700 28px/1.2 ui-monospace, Consolas, monospace; letter-spacing: 2px; color: var(--vert-fonce); margin: 10px 0; }
  .retour { background: transparent; border: 0; color: var(--vert-fonce); padding: 6px 0; }
</style>
</head>
<body>
<header><h1 id="titre">Boutique en ligne</h1><p id="adresse"></p></header>
<main id="page"><p class="muted">Chargement du catalogue…</p></main>
<div class="barre" id="barre" hidden><div><div class="total" id="barre-total"></div><button class="principal" id="voir">Voir le panier</button></div></div>
<script>
(function () {
  'use strict';
  var code = decodeURIComponent(location.pathname.split('/').filter(Boolean)[1] || '');
  var api = '/api/v1/shop/' + encodeURIComponent(code);
  var page = document.getElementById('page');
  var barre = document.getElementById('barre');
  var boutique = null;
  var parId = {};
  var panier = {};
  var recherche = '';
  var rayon = '';
  var montres = 60;
  var vue = 'catalogue';
  var cle = 'boutique-panier-' + code.toUpperCase();
  var coordonnees = {};

  function esc(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function fcfa(n) { return Math.round(Number(n) || 0).toLocaleString('fr-FR') + ' FCFA'; }
  function pas(a) { return a.unit === 'piece' ? 1000 : 500; }
  function unite(a) { return a.unit === 'kg' ? 'kg' : a.unit === 'litre' ? 'L' : (a.unitName || ''); }
  function quantite(a, q) {
    var n = (q / 1000).toLocaleString('fr-FR', { maximumFractionDigits: 3 });
    return a.unit === 'piece' ? n : n + ' ' + unite(a);
  }
  function plier(t) { return String(t || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, ''); }
  function lire(k) { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch (e) { return null; } }
  function ecrire(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* navigation privée */ } }

  function appel(chemin, corps) {
    var init = corps === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(corps) };
    return fetch(api + chemin, init).then(function (r) {
      return r.text().then(function (t) {
        var d = null;
        try { d = t ? JSON.parse(t) : null; } catch (e) { d = null; }
        if (!r.ok) {
          var m = d && d.message;
          throw new Error(Array.isArray(m) ? m.join(', ') : (m || 'Le serveur ne répond pas (erreur ' + r.status + ').'));
        }
        return d;
      });
    });
  }

  function lignes() {
    return Object.keys(panier).filter(function (id) { return parId[id] && panier[id] > 0; }).map(function (id) {
      var a = parId[id];
      return { a: a, qty: panier[id], montant: Math.round(a.price * panier[id] / 1000) };
    });
  }
  function sousTotal() { return lignes().reduce(function (s, l) { return s + l.montant; }, 0); }

  function changer(id, sens) {
    var a = parId[id];
    if (!a) return;
    var q = (panier[id] || 0) + sens * pas(a);
    if (q <= 0) delete panier[id];
    else panier[id] = Math.min(q, 1000000);
    ecrire(cle, panier);
    afficher();
  }

  function majBarre() {
    var l = lignes();
    if (vue !== 'catalogue' || !l.length) { barre.hidden = true; return; }
    barre.hidden = false;
    var n = l.length;
    document.getElementById('barre-total').innerHTML = '<strong>' + fcfa(sousTotal()) + '</strong><small>' + n + ' article' + (n > 1 ? 's' : '') + ' dans le panier</small>';
  }

  function controle(a) {
    var q = panier[a.id] || 0;
    if (!q) return '<button class="ajouter" data-plus="' + esc(a.id) + '">Ajouter</button>';
    return '<div class="qte"><button data-moins="' + esc(a.id) + '" aria-label="Retirer">−</button><span>' + esc(quantite(a, q)) + '</span><button data-plus="' + esc(a.id) + '" aria-label="Ajouter">+</button></div>';
  }

  function ligneArticle(a) {
    var img = a.photo ? '<img loading="lazy" alt="" src="' + api + '/articles/' + encodeURIComponent(a.id) + '/thumb">' : '<div class="vignette"></div>';
    var prix = fcfa(a.price) + (a.unit !== 'piece' ? ' le ' + unite(a) : '') + (a.price < a.regularPrice ? '<s>' + fcfa(a.regularPrice) + '</s>' : '');
    return '<div class="art">' + img + '<div class="g"><div class="nom">' + esc(a.name) + '</div><div class="prix">' + prix + '</div></div>' + controle(a) + '</div>';
  }

  function vueCatalogue() {
    var mots = plier(recherche).split(/\s+/).filter(Boolean);
    var liste = boutique.articles.filter(function (a) {
      if (rayon && a.department !== rayon) return false;
      var n = plier(a.name);
      return mots.every(function (m) { return n.indexOf(m) >= 0; });
    });
    var rayons = [];
    boutique.articles.forEach(function (a) { if (a.department && rayons.indexOf(a.department) < 0) rayons.push(a.department); });
    rayons.sort(function (x, y) { return x.localeCompare(y, 'fr'); });
    var h = '';
    if (boutique.message) h += '<div class="message">' + esc(boutique.message) + '</div>';
    h += '<div class="chercher"><input id="recherche" type="search" placeholder="Rechercher un produit…" autocomplete="off" value="' + esc(recherche) + '">';
    if (rayons.length > 1) {
      h += '<div class="rayons"><button data-rayon=""' + (rayon ? '' : ' class="actif"') + '>Tout</button>' + rayons.map(function (r) {
        return '<button data-rayon="' + esc(r) + '"' + (r === rayon ? ' class="actif"' : '') + '>' + esc(r) + '</button>';
      }).join('') + '</div>';
    }
    h += '</div>';
    if (!liste.length) {
      h += '<p class="muted">' + (boutique.articles.length ? 'Aucun produit ne correspond à votre recherche.' : 'Le catalogue en ligne est vide pour le moment.') + '</p>';
    } else {
      h += '<div class="liste">' + liste.slice(0, montres).map(ligneArticle).join('') + '</div>';
      if (liste.length > montres) h += '<p style="text-align:center"><button id="plus">Afficher plus de produits (' + (liste.length - montres) + ')</button></p>';
    }
    return h;
  }

  function vuePanier(erreur) {
    var l = lignes();
    var livraison = boutique.delivery && coordonnees.livraison;
    var frais = livraison ? boutique.deliveryFee : 0;
    var h = '<button class="retour" id="retour">‹ Continuer mes achats</button>';
    if (erreur) h += '<div class="erreur">' + esc(erreur) + '</div>';
    if (!l.length) return h + '<p class="muted">Votre panier est vide.</p>';
    h += '<div class="bloc"><h2>Votre panier</h2><div class="liste" style="border:0">' + l.map(function (x) {
      return '<div class="art" style="padding:8px 0"><div class="g"><div class="nom">' + esc(x.a.name) + '</div><div class="muted">' + fcfa(x.a.price) + (x.a.unit !== 'piece' ? ' le ' + unite(x.a) : '') + ' · ' + fcfa(x.montant) + '</div></div>' + controle(x.a) + '</div>';
    }).join('') + '</div>';
    h += '<div class="somme"><span>Articles</span><span>' + fcfa(sousTotal()) + '</span></div>';
    if (livraison) h += '<div class="somme"><span>Livraison</span><span>' + (frais ? fcfa(frais) : 'à convenir') + '</span></div>';
    h += '<div class="somme grand"><span>Total</span><span>' + fcfa(sousTotal() + frais) + '</span></div>';
    if (boutique.minOrder && sousTotal() < boutique.minOrder) h += '<p class="erreur" style="margin:8px 0 0">Le montant minimal d’une commande est de ' + fcfa(boutique.minOrder) + '.</p>';
    h += '</div><div class="bloc"><h2>Retrait ou livraison</h2>';
    if (boutique.delivery) {
      h += '<div class="choix"><label><input type="radio" name="mode" value="retrait"' + (livraison ? '' : ' checked') + '>Retrait au magasin<small>Gratuit</small></label>' +
        '<label><input type="radio" name="mode" value="livraison"' + (livraison ? ' checked' : '') + '>Livraison<small>' + (boutique.deliveryFee ? fcfa(boutique.deliveryFee) : 'Frais à convenir') + '</small></label></div>';
      if (livraison) h += '<label for="adresse-livraison">Adresse de livraison (quartier, repère)</label><textarea id="adresse-livraison" maxlength="200">' + esc(coordonnees.adresse || '') + '</textarea>';
    } else {
      h += '<p class="muted" style="margin:0">La commande est à retirer au magasin' + (boutique.store.address ? ' : ' + esc(boutique.store.address) : '') + '.</p>';
    }
    h += '<label for="creneau">' + (livraison ? 'Jour et heure de livraison souhaités' : 'Jour et heure de retrait souhaités') + '</label><input id="creneau" maxlength="60" placeholder="Par exemple : samedi matin" value="' + esc(coordonnees.creneau || '') + '">';
    h += '</div><div class="bloc"><h2>Vos coordonnées</h2>' +
      '<label for="nom">Votre nom</label><input id="nom" maxlength="60" autocomplete="name" value="' + esc(coordonnees.nom || '') + '">' +
      '<label for="tel">Votre téléphone</label><input id="tel" type="tel" inputmode="tel" autocomplete="tel" placeholder="6 77 12 34 56" value="' + esc(coordonnees.tel || '') + '">' +
      '<label for="note">Remarque (facultatif)</label><textarea id="note" maxlength="300">' + esc(coordonnees.note || '') + '</textarea>' +
      '<p class="muted" style="font-size:13px">Le magasin vous appelle pour confirmer la commande. Le paiement se fait au retrait ou à la livraison.</p>' +
      '<button class="principal" id="envoyer">Envoyer la commande</button></div>';
    return h;
  }

  function vueMerci(r) {
    return '<div class="bloc merci"><h2>Merci, votre commande est envoyée.</h2><div class="ref">' + esc(r.number) + '</div>' +
      '<p>Notez ce numéro. ' + esc(boutique.store.name) + ' vous appelle au ' + esc(r.phone) + ' pour confirmer la commande et vous dire quand elle sera prête.</p>' +
      '<p class="muted">Montant à payer : ' + fcfa(r.total) + (r.deliveryFee ? ' (livraison comprise)' : '') + '.</p>' +
      '<p><button id="nouvelle">Faire une autre commande</button></p></div>';
  }

  function telephoneValide(t) {
    var d = String(t || '').replace(/[\s.\-()\/]/g, '');
    if (d.indexOf('+237') === 0) d = d.slice(4);
    else if (d.indexOf('00237') === 0) d = d.slice(5);
    else if (d.length === 12 && d.indexOf('237') === 0) d = d.slice(3);
    return /^[62]\d{8}$/.test(d);
  }

  function relever() {
    var v = function (id) { var el = document.getElementById(id); return el ? el.value : undefined; };
    if (v('nom') !== undefined) coordonnees.nom = v('nom');
    if (v('tel') !== undefined) coordonnees.tel = v('tel');
    if (v('note') !== undefined) coordonnees.note = v('note');
    if (v('creneau') !== undefined) coordonnees.creneau = v('creneau');
    if (v('adresse-livraison') !== undefined) coordonnees.adresse = v('adresse-livraison');
    ecrire(cle + '-client', { nom: coordonnees.nom, tel: coordonnees.tel, adresse: coordonnees.adresse });
  }

  function envoyer(bouton) {
    relever();
    var livraison = boutique.delivery && coordonnees.livraison;
    if (!String(coordonnees.nom || '').trim()) return afficher('Indiquez votre nom.');
    if (!telephoneValide(coordonnees.tel)) return afficher('Numéro de téléphone invalide : 9 chiffres commençant par 6 ou 2 (par exemple 6 77 12 34 56).');
    if (livraison && !String(coordonnees.adresse || '').trim()) return afficher('Indiquez l’adresse de livraison.');
    bouton.disabled = true;
    bouton.textContent = 'Envoi en cours…';
    appel('/orders', {
      customerName: coordonnees.nom,
      phone: coordonnees.tel,
      address: livraison ? coordonnees.adresse : null,
      slot: coordonnees.creneau || null,
      note: coordonnees.note || null,
      lines: lignes().map(function (l) { return { articleId: l.a.id, qty: l.qty }; })
    }).then(function (r) {
      panier = {};
      ecrire(cle, panier);
      coordonnees.note = '';
      vue = 'merci';
      r.phone = coordonnees.tel;
      page.innerHTML = vueMerci(r);
      barre.hidden = true;
      window.scrollTo(0, 0);
      document.getElementById('nouvelle').onclick = function () { vue = 'catalogue'; afficher(); };
    }).catch(function (e) {
      afficher(e.message);
    });
  }

  function afficher(erreur) {
    if (vue === 'catalogue') {
      var focus = document.activeElement && document.activeElement.id === 'recherche';
      page.innerHTML = vueCatalogue();
      var r = document.getElementById('recherche');
      r.oninput = function () {
        recherche = r.value;
        montres = 60;
        var pos = r.selectionStart;
        afficher();
        var n = document.getElementById('recherche');
        n.focus();
        try { n.setSelectionRange(pos, pos); } catch (e) { /* type search */ }
      };
      if (focus) r.focus();
      var p = document.getElementById('plus');
      if (p) p.onclick = function () { montres += 60; afficher(); };
    } else if (vue === 'panier') {
      page.innerHTML = vuePanier(erreur);
      document.getElementById('retour').onclick = function () { relever(); vue = 'catalogue'; afficher(); window.scrollTo(0, 0); };
      var modes = document.querySelectorAll('input[name=mode]');
      for (var i = 0; i < modes.length; i++) modes[i].onchange = function (e) { relever(); coordonnees.livraison = e.target.value === 'livraison'; afficher(); };
      var b = document.getElementById('envoyer');
      if (b) b.onclick = function () { envoyer(b); };
      if (erreur) window.scrollTo(0, 0);
    }
    majBarre();
  }

  page.onclick = function (e) {
    var t = e.target.closest ? e.target.closest('button') : e.target;
    if (!t) return;
    if (t.hasAttribute('data-plus')) { relever(); changer(t.getAttribute('data-plus'), 1); }
    else if (t.hasAttribute('data-moins')) { relever(); changer(t.getAttribute('data-moins'), -1); }
    else if (t.hasAttribute('data-rayon')) { rayon = t.getAttribute('data-rayon'); montres = 60; afficher(); }
  };
  document.getElementById('voir').onclick = function () { vue = 'panier'; afficher(); window.scrollTo(0, 0); };

  appel('/catalog').then(function (d) {
    boutique = d;
    document.title = d.store.name + ' · Boutique en ligne';
    document.getElementById('titre').textContent = d.store.name;
    document.getElementById('adresse').textContent = [d.store.address, d.store.phone].filter(Boolean).join(' · ');
    d.articles.forEach(function (a) { parId[a.id] = a; });
    var garde = lire(cle) || {};
    Object.keys(garde).forEach(function (id) { if (parId[id] && garde[id] > 0) panier[id] = garde[id]; });
    var client = lire(cle + '-client') || {};
    coordonnees = { nom: client.nom || '', tel: client.tel || '', adresse: client.adresse || '', livraison: false };
    afficher();
  }).catch(function (e) {
    page.innerHTML = '<div class="erreur">' + esc(e.message) + '</div>';
  });
})();
</script>
</body>
</html>
`;

/** Vérificateur de prix : grand écran au rayon, lecteur de codes-barres (ou saisie), caméra si le navigateur sait lire les codes. */
export const PRICE_PAGE = String.raw`<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#1f7a4d">
<meta name="robots" content="noindex">
<title>Vérificateur de prix</title>
<style>
  :root { --vert: #1f7a4d; --vert-fonce: #155c39; --vert-clair: #e7f4ec; --fond: #f4f5f7; --texte: #1d2430; --gris: #667085; --ligne: #e4e7ec; --rouge: #b42318; --rouge-clair: #fef3f2; --orange: #b54708; --orange-clair: #fffaeb; }
  * { box-sizing: border-box; }
  html, body { height: 100%; }
  body { margin: 0; font: 18px/1.4 system-ui, "Segoe UI", Roboto, sans-serif; background: var(--fond); color: var(--texte); display: flex; flex-direction: column; }
  header { background: var(--vert); color: #fff; padding: calc(14px + env(safe-area-inset-top)) 20px 14px; text-align: center; }
  header h1 { margin: 0; font-size: 22px; font-weight: 600; }
  main { flex: 1; width: 100%; max-width: 820px; margin: 0 auto; padding: 20px 16px; display: flex; flex-direction: column; gap: 18px; }
  form { display: flex; gap: 10px; }
  input { flex: 1; min-width: 0; font: inherit; font-size: 24px; padding: 14px 16px; border: 2px solid #d0d5dd; border-radius: 14px; background: #fff; }
  input:focus { outline: none; border-color: var(--vert); }
  button { font: inherit; font-size: 18px; padding: 0 18px; border-radius: 14px; border: 2px solid var(--vert); background: var(--vert); color: #fff; cursor: pointer; }
  button.second { background: #fff; color: var(--vert-fonce); }
  .resultat { flex: 1; display: flex; align-items: center; justify-content: center; text-align: center; background: #fff; border: 1px solid var(--ligne); border-radius: 20px; padding: 28px 20px; min-height: 280px; }
  .invite { color: var(--gris); font-size: 22px; }
  .nom { font-size: clamp(24px, 5vw, 40px); font-weight: 600; margin-bottom: 14px; }
  .prix { font-size: clamp(48px, 13vw, 110px); font-weight: 800; color: var(--vert-fonce); line-height: 1.05; }
  .prix small { font-size: .3em; font-weight: 600; color: var(--gris); }
  .ancien { font-size: clamp(22px, 5vw, 36px); color: var(--gris); text-decoration: line-through; }
  .promo { display: inline-block; background: var(--orange-clair); color: var(--orange); font-weight: 700; border-radius: 999px; padding: 4px 16px; margin-bottom: 10px; font-size: 20px; }
  .detail { color: var(--gris); margin-top: 12px; font-size: 18px; }
  .introuvable { color: var(--rouge); font-size: 24px; }
  video { width: 100%; max-height: 260px; border-radius: 14px; background: #000; object-fit: cover; }
  footer { text-align: center; color: var(--gris); font-size: 14px; padding: 8px 16px calc(12px + env(safe-area-inset-bottom)); }
</style>
</head>
<body>
<header><h1 id="titre">Vérificateur de prix</h1></header>
<main>
  <form id="form" autocomplete="off">
    <input id="code" inputmode="numeric" placeholder="Scannez le code-barres" autofocus>
    <button type="submit">Voir</button>
    <button type="button" class="second" id="camera" hidden>Caméra</button>
  </form>
  <video id="video" playsinline muted hidden></video>
  <div class="resultat" id="resultat"><div class="invite">Passez le code-barres de l’article devant le lecteur pour voir son prix.</div></div>
</main>
<footer>Prix en FCFA, toutes taxes comprises. En cas de doute, le prix de la caisse fait foi.</footer>
<script>
(function () {
  'use strict';
  var code = decodeURIComponent(location.pathname.split('/').filter(Boolean)[1] || '');
  var api = '/api/v1/shop/' + encodeURIComponent(code) + '/price?code=';
  var champ = document.getElementById('code');
  var resultat = document.getElementById('resultat');
  var INVITE = resultat.innerHTML;
  var minuterie = null;
  var video = document.getElementById('video');
  var flux = null;

  function esc(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function fcfa(n) { return Math.round(Number(n) || 0).toLocaleString('fr-FR'); }
  function jour(d) { return d ? new Date(d + 'T12:00:00').toLocaleDateString('fr-FR', { day: 'numeric', month: 'long' }) : ''; }
  function parUnite(a) { return a.unit === 'kg' ? ' le kg' : a.unit === 'litre' ? ' le litre' : (a.unitName ? ' l’' + a.unitName.toLowerCase() : ''); }

  function effacerPlusTard() {
    clearTimeout(minuterie);
    minuterie = setTimeout(function () { resultat.innerHTML = INVITE; champ.value = ''; champ.focus(); }, 15000);
  }

  function chercher(valeur) {
    var q = String(valeur || '').trim();
    if (!q) return;
    champ.value = '';
    resultat.innerHTML = '<div class="invite">Recherche…</div>';
    fetch(api + encodeURIComponent(q)).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (d) { return { ok: r.ok, d: d }; });
    }).then(function (x) {
      if (!x.ok) {
        resultat.innerHTML = '<div class="introuvable">' + esc((x.d && x.d.message) || 'Article introuvable : demandez à un vendeur.') + '</div>';
        return;
      }
      var a = x.d.article;
      var h = '<div>';
      if (a.promoPrice !== null) h += '<div class="promo">PROMOTION' + (a.promoEnds ? ' jusqu’au ' + esc(jour(a.promoEnds)) : '') + '</div>';
      h += '<div class="nom">' + esc(a.name) + '</div>';
      if (a.promoPrice !== null) {
        h += '<div class="prix">' + fcfa(a.promoPrice) + ' <small>FCFA' + esc(parUnite(a)) + '</small></div><div class="ancien">' + fcfa(a.price) + ' FCFA</div>';
      } else {
        h += '<div class="prix">' + fcfa(a.price) + ' <small>FCFA' + esc(parUnite(a)) + '</small></div>';
      }
      if (a.pack) h += '<div class="detail">' + esc(a.pack.name) + ' : ' + fcfa(a.pack.price) + ' FCFA</div>';
      h += '<div class="detail">Code ' + esc(a.code) + '</div></div>';
      resultat.innerHTML = h;
    }).catch(function () {
      resultat.innerHTML = '<div class="introuvable">Le serveur ne répond pas. Réessayez dans un instant.</div>';
    }).then(function () {
      effacerPlusTard();
      champ.focus();
    });
  }

  document.getElementById('form').onsubmit = function (e) { e.preventDefault(); chercher(champ.value); };
  // Le lecteur de codes-barres tape le code puis « Entrée » ; on garde le curseur dans le champ.
  document.addEventListener('click', function (e) { if (e.target.tagName !== 'BUTTON' && e.target.tagName !== 'INPUT') champ.focus(); });

  // Caméra : seulement si le navigateur sait lire les codes-barres (Chrome sur Android, connexion sécurisée).
  if ('BarcodeDetector' in window && navigator.mediaDevices && window.isSecureContext) {
    var bouton = document.getElementById('camera');
    bouton.hidden = false;
    var lecteur = null;
    try { lecteur = new window.BarcodeDetector({ formats: ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'code_39'] }); } catch (e) { bouton.hidden = true; }
    var arreter = function () {
      if (flux) flux.getTracks().forEach(function (t) { t.stop(); });
      flux = null;
      video.hidden = true;
      bouton.textContent = 'Caméra';
    };
    var lire = function () {
      if (!flux) return;
      lecteur.detect(video).then(function (codes) {
        if (codes.length) { arreter(); chercher(codes[0].rawValue); return; }
        setTimeout(lire, 250);
      }).catch(function () { setTimeout(lire, 500); });
    };
    bouton.onclick = function () {
      if (flux) { arreter(); return; }
      navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } }).then(function (s) {
        flux = s;
        video.srcObject = s;
        video.hidden = false;
        bouton.textContent = 'Arrêter';
        video.play();
        setTimeout(lire, 400);
        setTimeout(function () { if (flux) arreter(); }, 30000);
      }).catch(function () {
        resultat.innerHTML = '<div class="introuvable">La caméra n’est pas disponible : autorisez-la dans le navigateur ou utilisez le lecteur.</div>';
        effacerPlusTard();
      });
    };
  }

  fetch('/api/v1/shop/' + encodeURIComponent(code) + '/price-info').then(function (r) { return r.ok ? r.json() : null; }).then(function (d) {
    if (d && d.store) { document.getElementById('titre').textContent = d.store.name + ' · Vérificateur de prix'; document.title = d.store.name + ' · Prix'; }
  }).catch(function () { /* titre par défaut */ });
  champ.focus();
})();
</script>
</body>
</html>
`;
