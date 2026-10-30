"""
Entraînement du petit réseau de chiffres du carnet de coupure (packages/core/src/digitNet.ts).

  python3 -m venv venv && venv/bin/pip install torch numpy
  # MNIST (CC BY-SA 3.0) dans le dossier D ci-dessous : train/t10k images et labels .gz
  venv/bin/python tools/chiffres/train.py 15

Écrit packages/core/src/digitWeights.ts (poids en entiers sur 8 bits). Rien n'est envoyé nulle part :
le réseau est calculé ensuite sur le PC, dans l'application.
"""
import gzip, json, base64, sys, numpy as np, torch, torch.nn as nn, torch.nn.functional as F
torch.manual_seed(0); np.random.seed(0)
torch.set_num_threads(4)
import os
D=os.environ.get('MNIST', 'mnist/')
def imgs(f): return np.frombuffer(gzip.open(D+f).read(),np.uint8,offset=16).reshape(-1,28,28)
def labs(f): return np.frombuffer(gzip.open(D+f).read(),np.uint8,offset=8)
Xtr=torch.tensor(imgs('train-images-idx3-ubyte.gz')).float().div(255).unsqueeze(1)
Ytr=torch.tensor(labs('train-labels-idx1-ubyte.gz')).long()
Xte=torch.tensor(imgs('t10k-images-idx3-ubyte.gz')).float().div(255).unsqueeze(1)
Yte=torch.tensor(labs('t10k-labels-idx1-ubyte.gz')).long()

class Net(nn.Module):
    def __init__(s):
        super().__init__()
        s.c1=nn.Conv2d(1,16,3,padding=1); s.c2=nn.Conv2d(16,32,3,padding=1)
        s.f1=nn.Linear(32*7*7,64); s.f2=nn.Linear(64,10)
    def forward(s,x):
        x=F.max_pool2d(F.relu(s.c1(x)),2); x=F.max_pool2d(F.relu(s.c2(x)),2)
        x=F.relu(s.f1(x.flatten(1))); return s.f2(x)

def augment(x):
    n=x.shape[0]
    ang=(torch.rand(n)-.5)*2*0.26   # ±15°
    sc=1+(torch.rand(n)-.5)*0.3      # ±15 %
    sh=(torch.rand(n)-.5)*0.4        # cisaillement (écriture penchée)
    tx=(torch.rand(n)-.5)*0.2; ty=(torch.rand(n)-.5)*0.2
    c,s_=torch.cos(ang),torch.sin(ang)
    th=torch.zeros(n,2,3)
    th[:,0,0]=c/sc; th[:,0,1]=(-s_+sh)/sc; th[:,0,2]=tx
    th[:,1,0]=s_/sc; th[:,1,1]=c/sc; th[:,1,2]=ty
    g=F.affine_grid(th,x.shape,align_corners=False)
    x=F.grid_sample(x,g,align_corners=False)
    # épaisseur du trait : plus épais (stylo bille appuyé) ou plus fin
    r=torch.rand(n)
    thick=F.max_pool2d(x,3,1,1); thin=-F.max_pool2d(-x,3,1,1)
    x=torch.where((r<.3).view(-1,1,1,1),thick,torch.where((r>.85).view(-1,1,1,1),(x+thin)/2,x))
    # bruit et petites taches
    x=x+torch.randn_like(x)*0.05*torch.rand(n,1,1,1)
    spk=(torch.rand_like(x)<0.003).float()*torch.rand(n,1,1,1).gt(.5).float()
    x=(x+spk).clamp(0,1)
    # contraste variable (encre pâle)
    x=x*(0.6+0.4*torch.rand(n,1,1,1))
    x=x/x.amax(dim=(1,2,3),keepdim=True).clamp_min(1e-3)
    return x

net=Net(); opt=torch.optim.Adam(net.parameters(),1e-3)
E=int(sys.argv[1]) if len(sys.argv)>1 else 8
sched=torch.optim.lr_scheduler.OneCycleLR(opt,3e-3,total_steps=E*(60000//128+1))
for ep in range(E):
    net.train(); perm=torch.randperm(60000)
    for i in range(0,60000,128):
        idx=perm[i:i+128]; xb=augment(Xtr[idx]); yb=Ytr[idx]
        loss=F.cross_entropy(net(xb),yb,label_smoothing=0.05); opt.zero_grad(); loss.backward(); opt.step(); sched.step()
    net.eval()
    with torch.no_grad():
        acc=(net(Xte).argmax(1)==Yte).float().mean().item()
        acca=(net(augment(Xte)).argmax(1)==Yte).float().mean().item()
    print(ep,round(loss.item(),4),'test',acc,'test augm',acca,flush=True)
torch.save(net.state_dict(),'/tmp/claude-0/ml/net.pt')

# Export : int8 par tenseur, échelle à part ; biais en float32
lines=["/* Fichier produit par l'entraînement du réseau de chiffres (voir digitNet.ts) : ne pas modifier à la main. */",
"export const DIGIT_WEIGHTS: { arch: string; layers: Record<string, { shape: number[]; scale: number; q: string } | { shape: number[]; f: string }> } = {",
"  arch: 'c16-c32-f64-f10',","  layers: {"]
for k,v in net.state_dict().items():
    a=v.detach().numpy().astype(np.float32)
    if k.endswith('weight'):
        sc=float(np.abs(a).max()/127) or 1.0
        q=np.clip(np.round(a/sc),-127,127).astype(np.int8)
        lines.append(f"    '{k}': {{ shape: {json.dumps(list(a.shape))}, scale: {sc!r}, q: '{base64.b64encode(q.tobytes()).decode()}' }},")
    else:
        lines.append(f"    '{k}': {{ shape: {json.dumps(list(a.shape))}, f: '{base64.b64encode(a.tobytes()).decode()}' }},")
lines+=["  },","};",""]
open(os.path.join(os.path.dirname(__file__),'../../packages/core/src/digitWeights.ts'),'w').write("\n".join(lines))
