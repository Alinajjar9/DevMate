import unittest

from fastapi.testclient import TestClient

from backend.app.main import MAX_CONTEXT_CHARACTERS, app


class DevMateApiTests(unittest.TestCase):
    client = TestClient(app)

    def test_health_reports_online_backend(self) -> None:
        response = self.client.get("/health")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(
            response.json(),
            {
                "status": "ok",
                "data": {"backend": "online", "version": "0.2.0"},
            },
        )

    def test_ask_uses_selection_context(self) -> None:
        response = self.client.post(
            "/ask",
            json=self._ask_payload(
                scope_type="selection",
                items=[
                    self._context_item(
                        source="selection",
                        content="return 42;",
                        file_path="C:\\repo\\src\\app.ts",
                    )
                ],
            ),
        )

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertEqual(payload["status"], "ok")
        self.assertEqual(payload["data"]["usedFiles"], ["C:\\repo\\src\\app.ts"])
        self.assertIn("Question: What does this code do?", payload["data"]["answer"])
        self.assertIn("Selection context: 10 characters", payload["data"]["answer"])

    def test_ask_uses_normal_file_context(self) -> None:
        content = "export const answer = 42;"
        response = self.client.post(
            "/ask",
            json=self._ask_payload(
                scope_type="file",
                items=[self._context_item(source="file", content=content)],
            ),
        )

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertEqual(payload["data"]["usedFiles"], ["C:\\repo\\src\\app.ts"])
        self.assertIn(
            f"File context: {len(content)} characters from C:\\repo\\src\\app.ts [typescript]",
            payload["data"]["answer"],
        )

    def test_ask_accepts_empty_file_context(self) -> None:
        response = self.client.post(
            "/ask",
            json=self._ask_payload(
                scope_type="file",
                items=[self._context_item(source="file", content="")],
            ),
        )

        self.assertEqual(response.status_code, 200)
        self.assertIn("File context: 0 characters", response.json()["data"]["answer"])

    def test_ask_accepts_truncated_file_context(self) -> None:
        content = "a" * MAX_CONTEXT_CHARACTERS
        item = self._context_item(source="file", content=content)
        item["totalCharacters"] = MAX_CONTEXT_CHARACTERS + 500
        item["truncated"] = True

        response = self.client.post(
            "/ask",
            json=self._ask_payload(scope_type="file", items=[item]),
        )

        self.assertEqual(response.status_code, 200)
        self.assertIn(
            f"File context: {MAX_CONTEXT_CHARACTERS} of {MAX_CONTEXT_CHARACTERS + 500} characters (truncated)",
            response.json()["data"]["answer"],
        )

    def test_ask_rejects_unbounded_file_content(self) -> None:
        content = "a" * (MAX_CONTEXT_CHARACTERS + 1)
        response = self.client.post(
            "/ask",
            json=self._ask_payload(
                scope_type="file",
                items=[self._context_item(source="file", content=content)],
            ),
        )

        self.assertEqual(response.status_code, 422)

    def test_ask_rejects_incorrect_character_metadata(self) -> None:
        item = self._context_item(source="file", content="hello")
        item["includedCharacters"] = 4

        response = self.client.post(
            "/ask",
            json=self._ask_payload(scope_type="file", items=[item]),
        )

        self.assertEqual(response.status_code, 422)

    def test_project_scope_does_not_report_workspace_as_used_file(self) -> None:
        response = self.client.post(
            "/ask",
            json=self._ask_payload(scope_type="project", items=[]),
        )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["data"]["usedFiles"], [])

    @staticmethod
    def _ask_payload(scope_type: str, items: list[dict[str, object]]) -> dict[str, object]:
        return {
            "question": "What does this code do?",
            "mode": "code",
            "scope": {
                "type": scope_type,
                "workspacePath": "C:\\repo",
                "items": items,
            },
            "settings": {
                "provider": "openai",
                "model": "gpt-4.1-mini",
                "maxTokens": 1200,
                "temperature": 0.2,
            },
        }

    @staticmethod
    def _context_item(
        source: str,
        content: str,
        file_path: str = "C:\\repo\\src\\app.ts",
    ) -> dict[str, object]:
        return {
            "source": source,
            "filePath": file_path,
            "languageId": "typescript",
            "content": content,
            "includedCharacters": len(content),
            "totalCharacters": len(content),
            "truncated": False,
        }


if __name__ == "__main__":
    unittest.main()
