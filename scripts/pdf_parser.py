import json, re, calendar, hashlib, csv, io
from pathlib import Path
from collections import Counter
from decimal import Decimal
import pdfplumber

ROOT=Path(__file__).resolve().parents[1]
CATS=['银行类','证券基金类','保险类','信托类']
def clean(s): return re.sub(r'\s+','',s or '')
def dec(s): return Decimal(clean(s).replace(',',''))
def parse(e):
    path=Path(e.get('localPdf') or e.get('pdf_file'))
    with pdfplumber.open(path) as pdf:
        text='\n'.join(p.extract_text() or '' for p in pdf.pages)
        header=clean(text[:350])
        m=re.search(r'截至日期[：:]?(\d{4})年(\d{1,2})月(?:(\d{1,2})日|(末))',header)
        if not m: raise ValueError('No header date '+str(path))
        y,mo=int(m[1]),int(m[2]); d=int(m[3]) if m[3] else calendar.monthrange(y,mo)[1]
        date=f'{y:04}-{mo:02}-{d:02}'
        raw=[]
        for p in pdf.pages:
            for table in p.extract_tables():
                raw+=table
    rows=[]; pending=[]; sums={}; total=None
    for row in raw:
        vals=[clean(v) for v in row]
        joined=' '.join(vals)
        cat=next((c for c in CATS if c+'合计' in joined),None)
        if '证券类合计' in joined: cat='证券基金类'
        if cat:
            nums=[v for v in vals if re.fullmatch(r'[\d,.]+',v)]
            if not nums: raise ValueError('Missing category sum '+joined)
            sums[cat]=dec(nums[-1])
            for r in pending: r['category']=cat
            rows+=pending; pending=[]
        elif any(v=='总计' for v in vals):
            total=dec([v for v in vals if re.fullmatch(r'[\d,.]+',v)][-1])
        elif vals and re.fullmatch(r'\d+',vals[0] or ''):
            if len(vals)!=4: raise ValueError('Unexpected columns '+str(vals))
            seq,name,approval,quota=vals
            # August 2026 has an overflowing two-line name across row borders.
            # Verified against independent pypdf text and the rendered source PDF.
            if date=='2026-08-31' and seq=='87': name='申万宏源证券有限公司（申万宏源证券资产管理有限公司）'
            if date=='2026-08-31' and seq=='88': name='中银国际证券股份有限公司'
            if not re.fullmatch(r'\d{4}\.\d{1,2}\.\d{1,2}',approval): raise ValueError('Bad approval '+str(vals))
            pending.append({'sequence':int(seq),'name':name,'id':name.replace('（','(').replace('）',')'),'approvedDate':'-'.join(f'{int(v):02}' if i else v for i,v in enumerate(approval.split('.'))),'quota':float(dec(quota))})
    if pending: raise ValueError('Uncategorized rows '+str(path))
    assert total is not None and len(sums)==4, (str(path),sums,total)
    assert [r['sequence'] for r in rows]==list(range(1,len(rows)+1)),str(path)
    assert sum(sums.values())==total,(str(path),'total mismatch',sums,total)
    for cat in CATS:
        s=sum(Decimal(str(r['quota'])) for r in rows if r['category']==cat)
        assert s==sums[cat],(str(path),cat,s,sums[cat])
    assert len(set(r['id'] for r in rows))==len(rows),(str(path),'duplicate names')
    page=e.get('pageUrl') or e.get('source_page'); url=e.get('pdfUrl') or e.get('pdf_url')
    published=e.get('publishedDate')
    # Read publication metadata from the saved official page, never infer it from URL.
    candidates=list(path.parent.glob('*.html'))
    for hp in candidates:
        body=hp.read_text(encoding='utf8',errors='replace')
        if path.stem in hp.stem or (page and page.rsplit('/',1)[-1].replace('.html','') in hp.stem):
            pm=re.search(r'<meta[^>]+name=[\"\']PubDate[\"\'][^>]+content=[\"\']([^\"\']+)',body,re.I)
            if pm: published=pm[1][:10]; break
    return {'month':date[:7],'date':date,'dateLabel':f'{y}年{mo}月末' if m[4] else f'{y}年{mo}月{d}日','total':float(total),'count':len(rows),'categories':{k:float(v) for k,v in sums.items()},'categoryCounts':dict(Counter(r['category'] for r in rows)),'pageUrl':page,'pdfUrl':url,'publisher':e.get('publisher'),'publishedDate':published,'sha256':hashlib.sha256(path.read_bytes()).hexdigest(),'institutions':rows,'archivePath':str(path.relative_to(ROOT)).replace(chr(92),'/')}
