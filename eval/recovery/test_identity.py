import unittest
from identity import lead_identity

class IdentityTests(unittest.TestCase):
    def item(self,counts='7 advisories, 79 fixes'):
        return dict(package='pkg',installed='1.0.0',target='2.0.0',evidence_url='https://example.test/release',sites=['src/a.ts'],summary=f'pkg 1.0.0 → 2.0.0 picks up {counts}; leads with breaking: Removed oldCall. [pkg:oldCall] (`oldCall` at src/a.ts)')
    def test_counts_can_change_without_a_new_finding(self):
        self.assertEqual(lead_identity(self.item()),lead_identity(self.item('5 advisories, 78 fixes')))
    def test_evidence_and_version_changes_never_reuse_the_identity(self):
        original=self.item()
        for field,value in [('package','other'),('installed','1.1.0'),('target','3.0.0'),('evidence_url','https://other.test'),('evidence_url',''),('summary',original['summary'].replace('at src/a.ts','at src/b.ts')),('summary',original['summary'].replace('pkg:oldCall','pkg:newCall')),('summary',original['summary'].replace('Removed oldCall','Changed oldCall'))]:
            with self.subTest(field=field,value=value):
                changed={**original,field:value};self.assertNotEqual(lead_identity(original),lead_identity(changed))
    def test_other_records_related_files_are_not_the_cited_site(self):
        original=self.item();other={**original,'sites':['other-record.ts']}
        self.assertEqual(lead_identity(original),lead_identity(other))
    def test_a_count_without_a_record_is_never_enough(self):
        item=self.item();item['summary']=item['summary'].replace('[pkg:oldCall]','')
        self.assertIsNone(lead_identity(item))
        item['summary']='pkg 1.0.0 → 2.0.0 picks up 7 fixes';self.assertIsNone(lead_identity(item))

if __name__=='__main__':unittest.main()
