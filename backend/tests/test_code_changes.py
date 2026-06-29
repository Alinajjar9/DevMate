import json
import unittest

from backend.app.code_changes import (
    MAX_FILE_CHANGE_CHARACTERS,
    CodeChangeParseError,
    parse_code_change_response,
)


class CodeChangeResponseTests(unittest.TestCase):
    def test_parses_plain_or_fenced_change_json(self) -> None:
        payload = {
            "summary": "Updated the feature.",
            "changes": [
                {"path": "src\\feature.ts", "content": "export const ready = true;\n"}
            ],
        }

        for serialized in (
            json.dumps(payload),
            f"```json\n{json.dumps(payload)}\n```",
        ):
            with self.subTest(serialized=serialized[:10]):
                summary, changes = parse_code_change_response(serialized)
                self.assertEqual(summary, "Updated the feature.")
                self.assertEqual(changes[0].path, "src/feature.ts")
                self.assertEqual(changes[0].content, "export const ready = true;\n")

    def test_rejects_invalid_json_and_unsafe_paths(self) -> None:
        invalid_values = [
            "not json",
            json.dumps({"summary": "Bad", "changes": [{"path": "../outside", "content": ""}]}),
            json.dumps({"summary": "Bad", "changes": [{"path": "C:\\outside", "content": ""}]}),
        ]

        for value in invalid_values:
            with self.subTest(value=value[:20]):
                with self.assertRaises(CodeChangeParseError):
                    parse_code_change_response(value)

    def test_rejects_duplicate_and_oversized_changes(self) -> None:
        with self.assertRaises(CodeChangeParseError):
            parse_code_change_response(
                json.dumps(
                    {
                        "summary": "Duplicates",
                        "changes": [
                            {"path": "src/app.ts", "content": "one"},
                            {"path": "SRC/APP.ts", "content": "two"},
                        ],
                    }
                )
            )

        with self.assertRaises(CodeChangeParseError):
            parse_code_change_response(
                json.dumps(
                    {
                        "summary": "Too large",
                        "changes": [
                            {
                                "path": "src/app.ts",
                                "content": "a" * (MAX_FILE_CHANGE_CHARACTERS + 1),
                            }
                        ],
                    }
                )
            )


if __name__ == "__main__":
    unittest.main()
