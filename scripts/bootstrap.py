"""Reconstruct the initial archive directly from its independently verified sources."""
import hashlib
import json
from collect import ROOT, read_json, write_json, fetch, independent_audit, validate
from pdf_parser import parse


def row_hash(rows):
    return hashlib.sha256(json.dumps(rows,ensure_ascii=False,sort_keys=True,separators=(',',':')).encode()).hexdigest()


def bootstrap():
    destination=ROOT/'data/qdii.json'
    if destination.exists():
        validate(read_json(destination))
        print('Existing archive verified; initialization skipped')
        return
    seed=read_json(ROOT/'data/seed.json')
    reports=[]
    for expected in seed['reports']:
        path=ROOT/expected['archivePath']
        path.parent.mkdir(parents=True,exist_ok=True)
        if not path.exists():
            raw=fetch(expected['pdfUrl'])
            if hashlib.sha256(raw).hexdigest()!=expected['sha256']:
                raise ValueError('Initial official PDF changed: '+expected['date'])
            path.write_bytes(raw)
        elif hashlib.sha256(path.read_bytes()).hexdigest()!=expected['sha256']:
            raise ValueError('Initial archive hash mismatch')
        report=parse({**expected,'localPdf':str(path)})
        independent_audit(report,path)
        if row_hash(report['institutions']) != expected['institutionSha256']:
            raise ValueError('Initial institution data differs from verified record: '+expected['date'])
        for key in ['date','count','total','sha256']:
            if report[key]!=expected[key]:
                raise ValueError('Initial report metadata mismatch: '+key)
        reports.append(report)
        print('Initialized',report['date'],report['count'],flush=True)
    data={'meta':seed['meta'],'reports':reports,'missingMonths':seed['missingMonths']}
    validate(data)
    write_json(destination,data)
    print('Initial archive rebuilt and verified:',len(reports),'reports')


if __name__=='__main__':
    bootstrap()

