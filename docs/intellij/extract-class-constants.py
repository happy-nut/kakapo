import struct,sys,zipfile,re
def strings(data):
    n=struct.unpack('>H',data[8:10])[0]; i=10; utf={}; strs=[]; k=1
    while k<n:
        t=data[i]
        if t==1:
            l=struct.unpack('>H',data[i+1:i+3])[0]; utf[k]=data[i+3:i+3+l].decode('utf8','replace'); i+=3+l
        elif t==8: strs.append(struct.unpack('>H',data[i+1:i+3])[0]); i+=3
        elif t in(3,4,9,10,11,12,17,18): i+=5
        elif t in(5,6): i+=9; k+=1
        elif t in(7,16,19,20): i+=3
        elif t==15: i+=4
        else: raise Exception(t)
        k+=1
    return [utf[s] for s in strs if s in utf]
jar,cls,out=sys.argv[1:4]
z=zipfile.ZipFile(jar)
res=[]
for nm in z.namelist():
    if nm==cls+'.class' or nm.startswith(cls+'$'):
        res+=[s for s in strings(z.read(nm)) if re.fullmatch(r'[A-Za-z][A-Za-z0-9_.]*',s)]
seen=[];[seen.append(s) for s in res if s not in seen]
open(out,'w').write('\n'.join(seen)+'\n'); print(cls,len(seen))
