"""Offline production initiator/rerun authorization regression tests."""
import os
from pathlib import Path
import subprocess
import unittest

ROOT = Path(__file__).resolve().parents[1]


class ProductionOwnerTests(unittest.TestCase):
    def allowed(self, actor_id, triggering_actor):
        env = dict(os.environ)
        env.pop("GITHUB_ACTOR_ID", None)
        env.pop("GITHUB_TRIGGERING_ACTOR", None)
        if actor_id is not None:
            env["GITHUB_ACTOR_ID"] = actor_id
        if triggering_actor is not None:
            env["GITHUB_TRIGGERING_ACTOR"] = triggering_actor
        return subprocess.run(["bash", str(ROOT / "scripts/check-production-owner.sh")],
                              env=env, capture_output=True, check=False).returncode == 0

    def test_owner_accounts(self):
        for actor_id in ("252574334", "345803507", "119937906"):
            for owner in ("niho3", "taku-niho", "takuyatakahama3"):
                self.assertTrue(self.allowed(actor_id, owner))

    def test_unknown_missing_and_rerun_identity(self):
        for actor_id in (None, "", "57525817", "2525743340"):
            self.assertFalse(self.allowed(actor_id, "niho3"))
        for actor in (None, "", "another-user", "niho3[bot]"):
            self.assertFalse(self.allowed("252574334", actor))

    def test_all_production_paths_wait_for_authorization(self):
        text = (ROOT / ".github/workflows/deploy-production.yml").read_text()
        self.assertIn("run: bash scripts/check-production-owner.sh", text)
        self.assertIn("  build:\n    needs: authorize\n", text)
        self.assertIn("    needs: build\n", text)
        self.assertIn("  promote:\n    needs: authorize\n", text)
        setup = (ROOT / "scripts/gcp/setup-production.sh").read_text()
        self.assertIn("'actor_id' in assertion", setup)
        self.assertIn("assertion.actor_id in ['252574334', '345803507', '119937906']", setup)


if __name__ == "__main__":
    unittest.main()
