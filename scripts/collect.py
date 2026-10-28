"""Incrementally archive official nationwide QDII reports; fail closed on bad data."""
import argparse
import calendar
import hashlib
import html
import json
import os
import re
import time
from datetime import datetime, timezone, timedelta
from decimal import Decimal
from pathlib import Path
from urllib.parse import urljoin, urlsplit, quote
from urllib.request import Request, urlopen

from pdf_parser import parse, CATS

ROOT = Path(__file__).resolve().parents[1]
MAIN = 'https://www.safe.gov.cn/safe/2018/0425/16849.html'
TZ = timezone(timedelta(hours=8))


def read_json(path):
    return json.loads(path.read_text(encoding='utf-8'))


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + '.tmp')
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    temporary.replace(path)


def official(url):
    return urlsplit(url).scheme == 'https' and urlsplit(url).hostname in {'www.safe.gov.cn', 'm.safe.gov.cn'}


def fetch(url):
    if not official(url):
        raise ValueError('Unexpected source domain: ' + url)
    url = quote(url, safe=':/?=&%')
    for attempt in range(3):
        try:
            with urlopen(Request(url, headers={'User-Agent': 'Mozilla/5.0 (QDII public archive)'}), timeout=45) as response:
                if not official(response.url):
                    raise ValueError('Unexpected redirect domain')
                body = response.read(20_000_001)
                if len(body) > 20_000_000:
                    raise ValueError('Source exceeds 20 MB')
                return body
        except Exception:
            if attempt == 2:
                raise
            time.sleep(2 ** attempt)


def anchors(body, url):
    for match in re.finditer(r'<a\b([^>]*?)>(.*?)</a>', body, re.I | re.S):
        href = re.search(r'href\s*=\s*[\"\']([^\"\']+)', match[1], re.I)
        if not href:
            continue
        title = re.search(r'title\s*=\s*[\"\']([^\"\']+)', match[1], re.I)
        label = html.unescape(title[1] if title else re.sub('<[^>]+>', '', match[2]))
        yield urljoin(url, html.unescape(href[1])).replace('http://', 'https://'), label


def pdf_links(body, page):
    links = set()
    for value in re.findall(r'[\"\']([^\"\'<>]*?\.pdf(?:\?[^\"\'<>]*)?)[\"\']', body, re.I):
        url = urljoin(page, html.unescape(value)).replace('http://', 'https://')
        if official(url) and '/file/file/' in urlsplit(url).path:
            links.add(url)
    return sorted(links)


def months_between(start, end):
    year, month = map(int, start.split('-'))
    result = []
    while f'{year:04}-{month:02}' <= end:
        result.append(f'{year:04}-{month:02}')
        month += 1
        if month == 13:
            month, year = 1, year + 1
    return result


def validate(data, root=ROOT):
    dates, months = set(), set()
    for report in data['reports']:
        if report['month'] != report['date'][:7] or report['month'] in months:
            raise ValueError('Duplicate/incorrect report month')
        months.add(report['month'])
        dates.add(report['date'])
        path = (root / report['archivePath']).resolve()
        if not path.is_relative_to((root/'data/pdf').resolve()):
            raise ValueError('Unsafe archive path')
        if hashlib.sha256(path.read_bytes()).hexdigest() != report['sha256']:
            raise ValueError('PDF hash mismatch: ' + report['date'])
        rows = report['institutions']
        if len(rows) != report['count'] or [r['sequence'] for r in rows] != list(range(1, len(rows)+1)):
            raise ValueError('Institution sequence/count mismatch')
        if len({r['id'] for r in rows}) != len(rows):
            raise ValueError('Duplicate institution ID')
        for row in rows:
            datetime.strptime(row['approvedDate'], '%Y-%m-%d')
            if row['category'] not in CATS or Decimal(str(row['quota'])) < 0 or not row['name']:
                raise ValueError('Invalid institution row')
        for category in CATS:
            subset = [r for r in rows if r['category'] == category]
            if sum(Decimal(str(r['quota'])) for r in subset) != Decimal(str(report['categories'][category])):
                raise ValueError('Category sum mismatch')
            if len(subset) != report['categoryCounts'][category]:
                raise ValueError('Category count mismatch')
        if sum(Decimal(str(v)) for v in report['categories'].values()) != Decimal(str(report['total'])):
            raise ValueError('Grand total mismatch')
        if not official(report['pageUrl']) or not official(report['pdfUrl']):
            raise ValueError('Nonofficial source URL')
    if not dates or data['meta']['rangeEnd'] != max(dates)[:7]:
        raise ValueError('Invalid archive range')
    missing = [m for m in months_between(data['meta']['rangeStart'], data['meta']['rangeEnd']) if m not in months]
    if missing != data['missingMonths']:
        raise ValueError('Missing-month metadata mismatch')


def independent_audit(report, path):
    from pypdf import PdfReader
    text = '\n'.join(p.extract_text() or '' for p in PdfReader(path).pages)
    compact = re.sub(r'\s+', '', text)
    if '合格境内机构投资者' not in compact or '亿美元' not in compact:
        raise ValueError('Not the expected nationwide QDII table')
    if any(s in compact[:250] for s in ['辖内', '辖区', '广东省', '深圳市', '安徽省']):
        raise ValueError('Local report, not nationwide data')
    cutoff = re.search(r'截至日期[：:]?(\d{4})年(\d{1,2})月(?:(\d{1,2})日|末)', compact)
    if not cutoff:
        raise ValueError('Independent date missing')
    year, month = int(cutoff[1]), int(cutoff[2])
    day = int(cutoff[3]) if cutoff[3] else calendar.monthrange(year, month)[1]
    if report['date'] != f'{year:04}-{month:02}-{day:02}':
        raise ValueError('Independent cutoff mismatch')
    total = re.findall(r'总计([\d,.]+)', compact)
    if not total or Decimal(total[-1].replace(',', '')) != Decimal(str(report['total'])):
        raise ValueError('Independent total mismatch')
    pattern = r'^\s*(\d+)\s+([^\d]+?)\s+(\d{4}\.\d{1,2}\.\d{1,2})\s+([\d,.]+)'
    matches = list(re.finditer(pattern, text, re.M))
    if len(matches) != report['count']:
        raise ValueError('Independent row count mismatch')
    for expected, match in zip(report['institutions'], matches):
        name = re.sub(r'\s+', '', match[2])
        approved = '-'.join(f'{int(v):02}' if i else v for i,v in enumerate(match[3].split('.')))
        if (int(match[1]) != expected['sequence'] or name != expected['name'] or
                approved != expected['approvedDate'] or Decimal(match[4].replace(',', '')) != Decimal(str(expected['quota']))):
            raise ValueError(f'Independent row mismatch: {report["date"]} #{expected["sequence"]}')


def merge_report(existing, candidate, authoritative=False):
    old = existing.get(candidate['month'])
    if old and candidate['date'] < old['date']:
        return None
    if old and candidate['sha256'] == old['sha256']:
        return None
    if old and candidate['date'] == old['date']:
        fields = ['total', 'count', 'categories', 'institutions']
        changed = any(candidate[k] != old[k] for k in fields)
        if changed and not authoritative:
            raise ValueError('Conflicting regional reprint; manual review required for '+candidate['date'])
        if not changed:
            return None
    existing[candidate['month']] = candidate
    return {'kind': 'revised' if old else 'new', 'date': candidate['date'], 'sha256': candidate['sha256'],
            'previousSha256': old['sha256'] if old else None}


def collect():
    data = read_json(ROOT/'data/qdii.json')
    validate(data)
    cache_path = ROOT/'data/source-cache.json'
    cache = read_json(cache_path) if cache_path.exists() else {}
    reports = {r['month']: r for r in data['reports']}
    hashes = {r['sha256'] for r in reports.values()}
    pages, warnings, changes, source_checks = {MAIN: '国家外汇管理局'}, [], [], []
    # Recent regional archive pages recover missed monthly reports after a delayed run.
    for number in range(1, 5):
        url = f'https://www.safe.gov.cn/guangdong/glxx/index{"_"+str(number) if number>1 else ""}.html'
        try:
            body = fetch(url).decode('utf-8')
            for page, title in anchors(body, url):
                if 'QDII' in title.upper() and re.search(r'20\d{2}年', title) and '辖' not in title and official(page):
                    pages[page] = '国家外汇管理局广东省分局'
        except Exception as exc:
            warnings.append(f'Archive listing unavailable: {url}: {exc}')
    # Process regional reprints first; current national source has revision authority.
    ordered = [p for p in pages if p != MAIN] + [MAIN]
    for page in ordered:
        try:
            body = fetch(page).decode('utf-8')
            links = pdf_links(body, page)
            if not links:
                raise ValueError('No official PDF attachment found')
            pub = re.search(r'<meta[^>]+name=[\"\']PubDate[\"\'][^>]+content=[\"\']([^\"\']+)', body, re.I)
            for url in links:
                # Always fetch the central PDF, even when its URL is unchanged (in-place revisions).
                if page != MAIN and url in cache and cache[url] in hashes:
                    continue
                raw = fetch(url)
                if not raw.startswith(b'%PDF'):
                    raise ValueError('Attachment is not a PDF')
                digest = hashlib.sha256(raw).hexdigest()
                cache[url] = digest
                if digest in hashes:
                    continue
                scratch = ROOT/'data/pdf'/f'{digest}.pdf'
                scratch.write_bytes(raw)
                entry = {'localPdf': str(scratch), 'pageUrl': page, 'pdfUrl': url,
                         'publisher': pages[page], 'publishedDate': pub[1][:10] if pub else None}
                report = parse(entry)
                independent_audit(report, scratch)
                if report['date'] > datetime.now(TZ).date().isoformat():
                    raise ValueError('Future-dated report')
                if report['month'] < data['meta']['rangeStart']:
                    scratch.unlink()
                    continue
                target = ROOT/'data/pdf'/f'{report["date"]}-{digest[:12]}.pdf'
                scratch.replace(target)
                report['archivePath'] = target.relative_to(ROOT).as_posix()
                change = merge_report(reports, report, page == MAIN)
                if change:
                    changes.append(change)
                hashes.add(digest)
            source_checks.append({'pageUrl': page, 'pdfCount': len(links)})
        except Exception as exc:
            # An inaccessible optional listing can be reported; a discovered report cannot be silently skipped.
            raise RuntimeError(f'Failed source {page}: {exc}') from exc
    now = datetime.now(TZ).isoformat(timespec='seconds')
    data['reports'] = [reports[m] for m in sorted(reports)]
    data['meta']['rangeEnd'] = data['reports'][-1]['month']
    data['meta']['checkedAt'] = now
    data['meta']['retrievedAt'] = now[:10]
    data['meta']['automationStatus'] = '月底云端更新'
    data['missingMonths'] = [m for m in months_between(data['meta']['rangeStart'], data['meta']['rangeEnd']) if m not in reports]
    validate(data)
    summary = {'checkedAt': now, 'newReports': changes, 'latestDate': data['reports'][-1]['date'],
               'total': data['reports'][-1]['total'], 'count': data['reports'][-1]['count'],
               'reports': len(reports), 'warnings': warnings, 'sources': source_checks,
               'missingMonths': data['missingMonths']}
    # These files are committed only after collection, audit, build and tests all succeed.
    write_json(ROOT/'data/qdii.json', data)
    write_json(cache_path, cache)
    write_json(ROOT/'data/last-check.json', summary)
    log = ROOT/'data/revisions.json'
    if changes:
        write_json(log, (read_json(log) if log.exists() else []) + [{'checkedAt': now, **c} for c in changes])
    print(json.dumps({k:v for k,v in summary.items() if k!='sources'}, ensure_ascii=False))


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--validate-only', action='store_true')
    args = parser.parse_args()
    if args.validate_only:
        validate(read_json(ROOT/'data/qdii.json'))
        print('Archive checks passed')
    else:
        collect()
