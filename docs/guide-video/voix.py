"""Fait la voix off du guide vidéo : un .wav par texte, avec Piper (voix française hors ligne).

    pip install piper-tts
    python3 -I docs/guide-video/voix.py BRUT/chapitres.json VOIX MODELE.onnx

VOIX reçoit les .wav (nommés comme les attend monter.py) et durees.json ; refilmer avec
VOIX=... cale chaque étape sur la durée de sa voix.
"""
import hashlib
import json
import os
import subprocess
import sys
import wave


def nom_voix(texte):
    return hashlib.sha1(texte.encode('utf-8')).hexdigest()[:16] + '.wav'


def a_dire(texte):
    """Le texte tel qu'il se prononce : guillemets et sigles lus correctement."""
    for a, b in (("« ? »", "point d'interrogation"), ('«', ''), ('»', ''), ('Ctrl + K', 'Contrôle K'), ('Ctrl + E', 'Contrôle E'), ('Ctrl + Entrée', 'Contrôle Entrée'),
                 ('MoMo', 'Momo'), ('ONIX 360', 'Onix trois-cent-soixante'), ('F1', 'F 1'), ('F2', 'F 2'), ('F4', 'F 4'), ('F8', 'F 8'),
                 ('V. cash 1', 'V cash 1'), (' Z ', ' Zède '), ('…', '.')):
        texte = texte.replace(a, b)
    return texte


def main():
    chapitres, sortie, modele = sys.argv[1], sys.argv[2], sys.argv[3]
    os.makedirs(sortie, exist_ok=True)
    d = json.load(open(chapitres, encoding='utf-8'))
    durees = {}
    for c in d['chapitres']:
        for t in c['textes']:
            f = os.path.join(sortie, nom_voix(t['texte']))
            if not os.path.exists(f):
                subprocess.run([sys.executable, '-m', 'piper', '-m', modele, '-f', f, '--sentence-silence', '0.25'],
                               input=a_dire(t['texte']).encode('utf-8'), check=True, capture_output=True)
            with wave.open(f) as w:
                durees[t['texte']] = round(w.getnframes() / w.getframerate(), 2)
    json.dump(durees, open(os.path.join(sortie, 'durees.json'), 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
    print(len(durees), 'textes,', round(sum(durees.values())), 's de voix')


if __name__ == '__main__':
    main()
