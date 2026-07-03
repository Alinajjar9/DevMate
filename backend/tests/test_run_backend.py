import argparse
import unittest

from backend.run_backend import _port


class BackendEntrypointTests(unittest.TestCase):
    def test_accepts_only_non_privileged_ports(self) -> None:
        self.assertEqual(_port("1024"), 1024)
        self.assertEqual(_port("65535"), 65535)
        for value in ("0", "80", "65536"):
            with self.assertRaises(argparse.ArgumentTypeError):
                _port(value)


if __name__ == "__main__":
    unittest.main()
