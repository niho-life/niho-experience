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

    def test_each_production_job_checks_identity_before_credentials(self):
        text = (ROOT / ".github/workflows/deploy-production.yml").read_text()
        self.assertIn("  build:\n    needs: authorize\n", text)
        self.assertIn("    needs: build\n", text)
        self.assertIn("  promote:\n    needs: authorize\n", text)
        # Successful dependencies are not rerun for a failed-job or single-job rerun.
        # Every credential-bearing job must recheck the current triggering actor itself.
        for name, end in (("deploy", "promote"), ("promote", None)):
            job = text.split(f"\n  {name}:\n", 1)[1]
            if end:
                job = job.split(f"\n  {end}:\n", 1)[0]
            guard = job.index("run: bash scripts/check-production-owner.sh")
            self.assertLess(job.index("uses: actions/checkout@"), guard)
            self.assertLess(guard, job.index("uses: google-github-actions/auth@"))
        self.assertIn("sparse-checkout: scripts\n", text)
        setup = (ROOT / "scripts/gcp/setup-production.sh").read_text()
        self.assertIn("'actor_id' in assertion", setup)
        self.assertIn("assertion.actor_id in ['252574334', '345803507', '119937906']", setup)


if __name__ == "__main__":
    unittest.main()
