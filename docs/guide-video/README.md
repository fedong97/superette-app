# Guide vidéo ONIX 360

Onze courtes vidéos (et le guide complet en un seul fichier), filmées dans le logiciel sur la
superette d'exemple du manuel, avec un curseur visible, les touches affichées, les textes en
sous-titres sous l'image et une voix off française.

1. Créer votre magasin
2. Se repérer dans l'écran
3. Ouvrir la caisse le matin
4. Vendre et encaisser
5. Vendre à crédit à un client
6. Créer un article
7. Recevoir la marchandise
8. Enregistrer une dépense
9. Ajouter un caissier
10. Sauvegarder vos données
11. Fermer la caisse le soir

## Refaire les vidéos

Les scénarios et les textes sont dans `apps/desktop/e2e/video.spec.ts`.

```sh
# 1. Filmer (le film brut et chapitres.json vont dans $BRUT)
cd apps/desktop
VIDEO=1 VIDEOS=$BRUT NODE_OPTIONS= xvfb-run -a npx playwright test video

# 2. La voix : Piper, voix française « siwis » (hors ligne)
#    pip install piper-tts
#    modèle : https://github.com/rhasspy/piper/releases/download/v0.0.2/voice-fr-siwis-medium.tar.gz
python3 -I docs/guide-video/voix.py $BRUT/chapitres.json $VOIX fr-siwis-medium.onnx

# 3. Refilmer en calant chaque étape sur la durée de sa voix, puis monter
VIDEO=1 VOIX=$VOIX VIDEOS=$BRUT NODE_OPTIONS= xvfb-run -a npx playwright test video
python3 -I docs/guide-video/monter.py $BRUT $SORTIE $VOIX
```

`CHAP=04,05` ne filme que ces sujets (pour mettre un scénario au point). Sans `VOIX`, le montage
donne des vidéos sous-titrées, sans son.
