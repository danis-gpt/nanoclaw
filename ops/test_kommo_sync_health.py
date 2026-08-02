#!/usr/bin/env python3

import importlib.util
import os
import pathlib
import unittest
from unittest.mock import patch


MODULE_PATH = pathlib.Path(__file__).with_name("kommo-sync-health.py")
SPEC = importlib.util.spec_from_file_location("kommo_sync_health", MODULE_PATH)
assert SPEC and SPEC.loader
kommo_sync_health = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(kommo_sync_health)


class RequestTimeoutTests(unittest.TestCase):
    def test_defaults_to_90_seconds(self) -> None:
        with patch.dict(os.environ, {}, clear=True):
            self.assertEqual(kommo_sync_health.request_timeout_seconds(), 90)

    def test_reads_positive_timeout_from_environment(self) -> None:
        with patch.dict(
            os.environ,
            {"KOMMO_MCP_REQUEST_TIMEOUT_SECONDS": "7200"},
            clear=True,
        ):
            self.assertEqual(kommo_sync_health.request_timeout_seconds(), 7200)

    def test_rejects_non_positive_timeout(self) -> None:
        with patch.dict(
            os.environ,
            {"KOMMO_MCP_REQUEST_TIMEOUT_SECONDS": "0"},
            clear=True,
        ):
            with self.assertRaisesRegex(ValueError, "must be positive"):
                kommo_sync_health.request_timeout_seconds()


if __name__ == "__main__":
    unittest.main()
