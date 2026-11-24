import json, math
from pathlib import Path
import fitz
from PIL import Image, ImageDraw
ROOT=Path(__file__).resolve().parents[1]
OUT=ROOT/'docs/audit/evidence/rendered';OUT.mkdir(parents=True,exist_ok=True)
results=[]
pdfs=list((ROOT/'docs/audit/evidence/pdf-samples').glob('*.pdf'))+list((ROOT/'docs/audit/evidence/training').glob('*.pdf'))+list((ROOT/'docs/user-guide').glob('*.pdf'))
word=ROOT/'docs/audit/evidence/word-manual-render.pdf'
if word.exists():pdfs.append(word)
for file in pdfs:
    doc=fitz.open(file);issues=[]; thumbs=[]
    for n,page in enumerate(doc):
        if not page.get_text().strip(): issues.append(f'Page {n+1} has no extracted text')
        for block in page.get_text('dict')['blocks']:
            for line in block.get('lines',[]):
                for span in line['spans']:
                    x0,y0,x1,y1=span['bbox']
                    if x0 < -1 or y0 < -1 or x1 > page.rect.width+1 or y1 > page.rect.height+1: issues.append(f'Text outside page {n+1}')
        pix=page.get_pixmap(matrix=fitz.Matrix(.5,.5),alpha=False)
        im=Image.frombytes('RGB',[pix.width,pix.height],pix.samples)
        canvas=Image.new('RGB',(310,460),'#e2e8f0');im.thumbnail((295,425));canvas.paste(im,((310-im.width)//2,20));ImageDraw.Draw(canvas).text((8,443),f'{file.stem} p{n+1}',fill='black');thumbs.append(canvas)
    for start in range(0,len(thumbs),12):
        selected=thumbs[start:start+12];sheet=Image.new('RGB',(310*4,460*math.ceil(len(selected)/4)),'white')
        for i,im in enumerate(selected):sheet.paste(im,((i%4)*310,(i//4)*460))
        sheet.save(OUT/f'{file.stem}-sheet-{start//12+1}.png')
    results.append({'file':str(file.relative_to(ROOT)),'pages':len(doc),'issues':sorted(set(issues))})
(ROOT/'docs/audit/evidence/pdf-qa.json').write_text(json.dumps(results,indent=2),encoding='utf-8')
print(json.dumps({'pdfs':len(results),'pages':sum(x['pages'] for x in results),'issues':[r for r in results if r['issues']]},indent=2))
