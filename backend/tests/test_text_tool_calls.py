import unittest

from backend.app.text_tool_calls import (
    classify_text_tool_call_prefix,
    looks_like_text_tool_call,
    parse_text_tool_calls,
)


class TextToolCallTests(unittest.TestCase):
    def test_parses_bounded_nemotron_style_tool_call(self) -> None:
        calls = parse_text_tool_calls(
            """
<tool_call>
<function=read_file>
<parameter=endLine>
1950
</parameter>
<parameter=path>
styles.css
</parameter>
<parameter=startLine>
1
</parameter>
</function>
</tool_call>
"""
        )

        self.assertIsNotNone(calls)
        self.assertEqual(len(calls), 1)
        self.assertEqual(calls[0].name, "read_file")
        self.assertEqual(
            calls[0].arguments,
            '{"endLine":1950,"path":"styles.css","startLine":1}',
        )
        self.assertTrue(calls[0].id.startswith("compat-"))

    def test_parses_multiple_calls_and_json_parameter_values(self) -> None:
        calls = parse_text_tool_calls(
            """
<tool_call><function=list_files><parameter=path>src</parameter></function></tool_call>
<tool_call><function=search_code><parameter=query>button</parameter><parameter=maxResults>20</parameter></function></tool_call>
"""
        )

        self.assertIsNotNone(calls)
        self.assertEqual([call.name for call in calls], ["list_files", "search_code"])
        self.assertIn('"maxResults":20', calls[1].arguments)

    def test_rejects_malformed_mixed_or_ambiguous_blocks(self) -> None:
        values = (
            "I will inspect it.\n<tool_call><function=read_file></function></tool_call>",
            "<tool_call><function=read_file><parameter=path>a.py</parameter>",
            (
                "<tool_call><function=read_file>"
                "<parameter=path>a.py</parameter><parameter=path>b.py</parameter>"
                "</function></tool_call>"
            ),
            "<tool_call><function=read-file></function></tool_call>",
        )
        for value in values:
            with self.subTest(value=value):
                self.assertIsNone(parse_text_tool_calls(value))

    def test_classifies_partial_stream_prefix_without_exposing_it(self) -> None:
        self.assertEqual(classify_text_tool_call_prefix("\n<tool_"), "pending")
        self.assertEqual(classify_text_tool_call_prefix("<tool_call>"), "tool")
        self.assertEqual(classify_text_tool_call_prefix("Completed the edit."), "answer")
        self.assertTrue(looks_like_text_tool_call(" \n<tool_call>"))


if __name__ == "__main__":
    unittest.main()
