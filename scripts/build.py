"""Build a self-contained, dependency-free static Pages artifact."""
import csv
import json
import shutil
from pathlib import Path
from collect import ROOT, read_json, validate, months_between, CATS


def build():
    data = read_json(ROOT/'data/qdii.json')
    validate(data)
    destination = ROOT/'dist'
    destination.mkdir(exist_ok=True)
    for name in ['index.html', 'app.js']:
        shutil.copy2(ROOT/'site'/name, destination/name)
    public = json.loads(json.dumps(data))
    for r in public['reports']:
        r.pop('archivePath', None)
    payload = json.dumps(public, ensure_ascii=False, separators=(',', ':')).replace('</', '<\\/')
    (destination/'data.js').write_text('window.QDII_DATA='+payload+';', encoding='utf-8')
    (destination/'data.json').write_text(json.dumps(public,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
    (destination/'.nojekyll').touch()
    with (destination/'monthly.csv').open('w',encoding='utf-8-sig',newline='') as out:
        writer = csv.writer(out)
        writer.writerow(['月份','截至日','发布日','机构数','累计额度_亿美元',*CATS,'官方PDF'])
        lookup = {r['month']:r for r in data['reports']}
        for month in months_between(data['meta']['rangeStart'],data['meta']['rangeEnd']):
            r=lookup.get(month)
            writer.writerow([month,r['date'],r.get('publishedDate'),r['count'],r['total'],*[r['categories'][c] for c in CATS],r['pdfUrl']] if r else [month])
    if (ROOT/'data/last-check.json').exists():
        shutil.copy2(ROOT/'data/last-check.json',destination/'status.json')
    print(f'Built {len(data["reports"])} verified reports in dist/')


if __name__=='__main__':
    build()
