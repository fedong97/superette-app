"""Monte le guide vidéo à partir du film brut de apps/desktop/e2e/video.spec.ts.

    python3 -I docs/guide-video/monter.py BRUT SORTIE [VOIX]

BRUT contient le film (.webm) et chapitres.json ; SORTIE reçoit une vidéo MP4 par sujet et
le guide complet. Les textes passent en sous-titres dans une bande sous l'image ; avec VOIX
(un .wav par texte, nommé par voix.py), la voix off est posée à l'heure de chaque texte.
Les cartons de titre verts sont repérés dans le film pour caler le minutage.
"""
import hashlib
import json
import os
import subprocess
import sys

BANDE = 150  # hauteur de la bande des sous-titres, sous l'image


def nom_voix(texte):
    return hashlib.sha1(texte.encode('utf-8')).hexdigest()[:16] + '.wav'


def cartons_du_film(video):
    """Instants (s) où le film passe au carton vert plein écran."""
    p = subprocess.run(['ffmpeg', '-v', 'error', '-i', video, '-vf', 'fps=4,scale=32:18', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'],
                       capture_output=True, check=True)
    n = 32 * 18 * 3
    vus, dedans = [], False
    for k in range(len(p.stdout) // n):
        f = p.stdout[k * n:(k + 1) * n]
        vert = sum(1 for i in range(0, n, 3) if f[i] < 60 and 70 < f[i + 1] < 140 and f[i + 2] < 100) / (n / 3)
        if vert > 0.8 and not dedans:
            vus.append(k / 4)
            dedans = True
        elif vert < 0.5:
            dedans = False
    return vus


def duree_media(f):
    out = subprocess.run(['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f], capture_output=True, text=True)
    return float(out.stdout.strip())


def ass_temps(t):
    t = max(0.0, t)
    h, r = divmod(t, 3600)
    m, s = divmod(r, 60)
    return f'{int(h)}:{int(m):02d}:{s:05.2f}'


def main():
    brut, sortie = sys.argv[1], sys.argv[2]
    voix = sys.argv[3] if len(sys.argv) > 3 else None
    os.makedirs(sortie, exist_ok=True)
    d = json.load(open(os.path.join(brut, 'chapitres.json'), encoding='utf-8'))
    video = os.path.join(brut, os.path.basename(d['video']))
    w, h = map(int, subprocess.run(['ffprobe', '-v', 'error', '-select_streams', 'v', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', video],
                                   capture_output=True, text=True).stdout.strip().split(','))
    reels = d['cartons']
    vus = cartons_du_film(video)
    if len(vus) != len(reels):
        sys.exit(f'{len(vus)} cartons vus dans le film, {len(reels)} attendus')

    def cale(t):
        """Heure réelle (s depuis le lancement) vers heure du film, d'un carton à l'autre."""
        for i in range(len(reels) - 1):
            if t < reels[i + 1] or i == len(reels) - 2:
                return vus[i] + (t - reels[i]) * (vus[i + 1] - vus[i]) / (reels[i + 1] - reels[i])

    faits = []
    for c in d['chapitres']:
        i = reels.index(c['carton'])
        debut, fin = vus[i] - 0.1, vus[i + 1] - 0.15
        lignes = []
        textes = c['textes']
        for k, t in enumerate(textes):
            a = cale(t['t']) - debut
            b = (cale(textes[k + 1]['t']) - debut) if k + 1 < len(textes) else fin - debut
            if voix and os.path.exists(os.path.join(voix, nom_voix(t['texte']))):
                b = max(b, a + duree_media(os.path.join(voix, nom_voix(t['texte']))))
            lignes.append((a, min(b, fin - debut), t['texte']))
        ass = os.path.join(sortie, c['id'] + '.ass')
        with open(ass, 'w', encoding='utf-8') as f:
            f.write(f"""[Script Info]
ScriptType: v4.00+
PlayResX: {w}
PlayResY: {h + BANDE}
WrapStyle: 0

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Texte,Inter,38,&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,-1,0,0,0,100,100,0,0,1,0,0,5,60,60,0,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
""")
            for a, b, texte in lignes:
                f.write(f'Dialogue: 0,{ass_temps(a)},{ass_temps(b)},Texte,,0,0,0,,{{\\pos({w // 2},{h + BANDE // 2})}}{texte}\n')
        mp4 = os.path.join(sortie, c['id'] + '.mp4')
        filtre = f"[0:v]pad={w}:{h + BANDE}:0:0:color=0x0f2e20,ass='{ass}',fps=30,format=yuv420p[v]"
        cmd = ['ffmpeg', '-v', 'error', '-y', '-ss', f'{debut:.2f}', '-to', f'{fin:.2f}', '-i', video]
        sons = [(a, os.path.join(voix, nom_voix(texte))) for a, b, texte in lignes if voix and os.path.exists(os.path.join(voix, nom_voix(texte)))]
        if sons:
            # La piste de voix d'abord, à la longueur exacte du sujet, puis l'image et le son ensemble.
            piste = os.path.join(sortie, c['id'] + '.wav')
            entrees = [x for _, s in sons for x in ('-i', s)]
            parts = [f'[{k}:a]aresample=48000,adelay={int(a * 1000)}:all=1[a{k}]' for k, (a, _) in enumerate(sons)]
            mix = ';'.join(parts) + ';' + ''.join(f'[a{k}]' for k in range(len(sons))) + f'amix=inputs={len(sons)}:normalize=0:duration=longest,apad=whole_dur={fin - debut:.2f},loudnorm=I=-16:TP=-1.5:LRA=11,aresample=48000[a]'
            subprocess.run(['ffmpeg', '-v', 'error', '-y', *entrees, '-filter_complex', mix, '-map', '[a]', '-t', f'{fin - debut:.2f}', piste], check=True)
            cmd += ['-i', piste, '-filter_complex', filtre, '-map', '[v]', '-map', '1:a', '-c:a', 'aac', '-b:a', '128k']
        else:
            piste = None
            cmd += ['-filter_complex', filtre, '-map', '[v]']
        cmd += ['-c:v', 'libx264', '-preset', 'medium', '-crf', '23', '-movflags', '+faststart', mp4]
        subprocess.run(cmd, check=True)
        os.remove(ass)
        if piste:
            os.remove(piste)
        faits.append(mp4)
        print(f"{c['id']} : {fin - debut:.0f} s")

    faits.sort()
    liste = os.path.join(sortie, 'liste.txt')
    with open(liste, 'w', encoding='utf-8') as f:
        f.writelines(f"file '{os.path.abspath(m)}'\n" for m in faits)
    subprocess.run(['ffmpeg', '-v', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', liste, '-c', 'copy', '-movflags', '+faststart',
                    os.path.join(sortie, 'Guide-video-ONIX-360-complet.mp4')], check=True)
    os.remove(liste)


if __name__ == '__main__':
    main()
