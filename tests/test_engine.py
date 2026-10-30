from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))
from engine import progress_snapshot


class EngineProgressTest(unittest.TestCase):
    def test_progress_does_not_serialize_document_or_result_objects(self):
        event = {"type":"progress_update", "stage":"Translate Paragraphs", "stage_current":8,
                 "stage_total":40, "overall_progress":61.2, "translate_result":object()}
        snapshot = progress_snapshot(event)
        self.assertEqual(snapshot["overall_progress"],61.2)
        self.assertNotIn("translate_result",snapshot)
        self.assertIsNone(progress_snapshot({"type":"finish","translate_result":object()}))


if __name__ == "__main__":
    unittest.main()
