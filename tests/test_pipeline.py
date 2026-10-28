import copy
import sys
import tempfile
import unittest
from datetime import datetime
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'scripts'))
from collect import ROOT, read_json, validate, merge_report, months_between, pdf_links
from month_end import is_month_end


class PipelineTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.data=read_json(ROOT/'data/qdii.json')

    def test_imported_archive_hashes_and_sums(self):
        validate(self.data)

    def test_corrupt_amount_is_rejected(self):
        broken=copy.deepcopy(self.data)
        broken['reports'][0]['institutions'][0]['quota']+=0.01
        with self.assertRaises(ValueError): validate(broken)

    def test_month_end_and_leap_year(self):
        for day,expected in [('2024-02-28',False),('2024-02-29',True),('2025-02-28',True),('2026-04-30',True),('2026-10-30',False),('2026-10-31',True)]:
            self.assertEqual(is_month_end(datetime.fromisoformat(day)),expected)

    def test_new_period_with_same_quota_is_archived(self):
        old=self.data['reports'][-1]
        new=copy.deepcopy(old)
        new.update(month='2099-01',date='2099-01-31',sha256='new')
        records={old['month']:old}
        self.assertEqual(merge_report(records,new)['kind'],'new')
        self.assertIsNone(merge_report(records,new))

    def test_conflicting_regional_reprint_cannot_overwrite(self):
        old=self.data['reports'][-1]
        revised=copy.deepcopy(old)
        revised.update(total=old['total']+1,sha256='revision')
        records={old['month']:old}
        with self.assertRaises(ValueError): merge_report(records,revised)
        self.assertEqual(records[old['month']],old)
        self.assertEqual(merge_report(records,revised,True)['kind'],'revised')

    def test_missing_months_preserved(self):
        self.assertEqual(months_between('2025-12','2026-02'),['2025-12','2026-01','2026-02'])

    def test_only_official_pdf_attachments(self):
        body='<a href="/safe/file/file/20261031/a.pdf">file</a><a href="https://evil.example/a.pdf">x</a>'
        self.assertEqual(pdf_links(body,'https://www.safe.gov.cn/safe/1.html'),['https://www.safe.gov.cn/safe/file/file/20261031/a.pdf'])


if __name__=='__main__': unittest.main()
