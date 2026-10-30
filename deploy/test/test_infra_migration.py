import copy
import importlib.util
from pathlib import Path
import unittest

path = Path(__file__).resolve().parents[2] / "consumers/joblander/terraform/validate-migration.py"
spec = importlib.util.spec_from_file_location("infra_migration", path)
migration = importlib.util.module_from_spec(spec)
spec.loader.exec_module(migration)


def plan(address, actions, before, after):
    return {"resource_changes": [{"address": address, "change": {
        "actions": actions, "before": before, "after": after}}]}


class InfraMigrationTest(unittest.TestCase):
    def test_only_startup_metadata_can_change_on_the_vm(self):
        before = {"machine_type": "e2-standard-2", "metadata": {"chatwoot-domain": "existing", "startup-script": "old"}}
        after = copy.deepcopy(before)
        after["metadata"]["startup-script"] = "config/run.py config/render.py"
        self.assertTrue(migration.validate(plan(migration.VM, ["update"], before, after)))
        for mutation in ({"machine_type": "other"}, {"metadata": {"startup-script": "config/run.py config/render.py"}}):
            with self.assertRaises(ValueError):
                migration.validate(plan(migration.VM, ["update"], before, {**after, **mutation}))

    def test_no_deletion_replacement_or_unrelated_resource_change(self):
        for address, actions in [(migration.VM, ["delete", "create"]),
                                  (migration.VM, ["delete"]),
                                  ("module.watchdog.google_storage_bucket_object.source", ["delete", "create"]),
                                  ("google_compute_disk.boot", ["update"])]:
            with self.assertRaises(ValueError):
                migration.validate(plan(address, actions, {}, {}))

    def test_dashboard_creates_only_in_selected_project(self):
        for address in migration.NEW_RESOURCES:
            self.assertTrue(migration.validate(plan(address, ["create"], None, {"project": migration.PROJECT})))
            with self.assertRaises(ValueError):
                migration.validate(plan(address, ["create"], None, {"project": "other"}))

    def test_alert_wording_may_change_but_threshold_and_route_cannot(self):
        before = {"display_name": "old", "documentation": [], "notification_channels": ["existing"],
                  "conditions": [{"display_name": "old", "condition_absent": [{"duration": "14400s"}]}]}
        after = copy.deepcopy(before)
        after["display_name"] = "new"
        after["conditions"][0]["display_name"] = "new"
        self.assertTrue(migration.validate(plan(migration.ALERT, ["update"], before, after)))
        after["notification_channels"] = []
        with self.assertRaises(ValueError):
            migration.validate(plan(migration.ALERT, ["update"], before, after))
        after["notification_channels"] = ["existing"]
        after["conditions"][0]["condition_absent"][0]["duration"] = "3600s"
        with self.assertRaises(ValueError):
            migration.validate(plan(migration.ALERT, ["update"], before, after))


if __name__ == "__main__":
    unittest.main()
