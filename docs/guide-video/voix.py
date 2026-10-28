"""Fait la voix off du guide vidéo : un .wav par texte, avec Kokoro (voix française « ff_siwis »,
hors ligne, licence Apache 2.0).

    pip install kokoro-onnx soundfile
    python3 -I docs/guide-video/voix.py BRUT/chapitres.json VOIX DOSSIER_DU_MODELE

DOSSIER_DU_MODELE contient kokoro-v1.0.onnx et voices-v1.0.bin
(https://github.com/thewh1teagle/kokoro-onnx/releases/tag/model-files-v1.0).

VOIX reçoit les .wav (nommés comme les attend monter.py) et durees.json ; refilmer avec
VOIX=... cale chaque étape sur la durée de sa voix.
"""
import hashlib
import json
import os
import sys
import wave

import numpy as np
import soundfile as sf
from kokoro_onnx import Kokoro

VOIX_KOKORO = 'ff_siwis'
VITESSE = 1.0
SILENCE = 0.25  # entre deux phrases d'un même texte


def nom_voix(texte):
    return hashlib.sha1(texte.encode('utf-8')).hexdigest()[:16] + '.wav'


def a_dire(texte):
    """Le texte tel qu'il se prononce : guillemets et sigles lus correctement."""
    for a, b in (("« ? »", "point d'interrogation"), ('«', ''), ('»', ''), ('Ctrl + K', 'Contrôle K'), ('Ctrl + E', 'Contrôle E'), ('Ctrl + Entrée', 'Contrôle Entrée'),
                 ('MoMo', 'Momo'), ('ONIX 360', 'Onix trois-cent-soixante'), ('F1', 'F 1'), ('F2', 'F 2'), ('F4', 'F 4'), ('F8', 'F 8'),
                 ('V. cash 1', 'V cash 1'), (' Z ', ' Zède '), ('…', '.')):
        texte = texte.replace(a, b)
    return texte


def parler(kokoro, texte):
    """Phrase par phrase, avec un court silence entre elles : le débit reste posé."""
    morceaux, sr = [], 24000
    for phrase in [p.strip() for p in texte.replace('?', '?|').replace('!', '!|').replace('. ', '.|').split('|') if p.strip()]:
        s, sr = kokoro.create(phrase, voice=VOIX_KOKORO, speed=VITESSE, lang='fr-fr')
        morceaux += [s, np.zeros(int(sr * SILENCE), dtype=s.dtype)]
    return np.concatenate(morceaux[:-1]), sr


def main():
    chapitres, sortie, modele = sys.argv[1], sys.argv[2], sys.argv[3]
    kokoro = Kokoro(os.path.join(modele, 'kokoro-v1.0.onnx'), os.path.join(modele, 'voices-v1.0.bin'))
    os.makedirs(sortie, exist_ok=True)
    d = json.load(open(chapitres, encoding='utf-8'))
    durees = {}
    for c in d['chapitres']:
        for t in c['textes']:
            f = os.path.join(sortie, nom_voix(t['texte']))
            if not os.path.exists(f):
                son, sr = parler(kokoro, a_dire(t['texte']))
                sf.write(f, son, sr, subtype='PCM_16')
            with wave.open(f) as w:
                durees[t['texte']] = round(w.getnframes() / w.getframerate(), 2)
    json.dump(durees, open(os.path.join(sortie, 'durees.json'), 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
    print(len(durees), 'textes,', round(sum(durees.values())), 's de voix')


if __name__ == '__main__':
    main()
