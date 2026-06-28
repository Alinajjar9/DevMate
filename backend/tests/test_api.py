import unittest

from fastapi.testclient import TestClient

from backend.app.main import app


class DevMateApiTests(unittest.TestCase):
    client = TestClient(app)

    def test_health_reports_online_backend(self) -> None:
        response = self.client.get("/health")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(
            response.json(),
            {
                "status": "ok",
                "data": {"backend": "online", "version": "0.1.0"},
            },
        )

    def test_ask_returns_deterministic_selection_response(self) -> None:
        response = self.client.post(
            "/ask",
            json={
                "question": "What does this function do?",
                "mode": "code",
                "scope": {
                    "type": "selection",
                    "workspacePath": "C:\\repo",
                    "filePath": "C:\\repo\\src\\app.ts",
                    "selectedText": "return 42;",
                    "selectedCharacters": 10,
                },
                "settings": {
                    "provider": "openai",
                    "model": "gpt-4.1-mini",
                    "maxTokens": 1200,
                    "temperature": 0.2,
                },
            },
        )

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertEqual(payload["status"], "ok")
        self.assertEqual(payload["data"]["usedFiles"], ["C:\\repo\\src\\app.ts"])
        self.assertIn("Question: What does this function do?", payload["data"]["answer"])
        self.assertIn("Selected context: 10 characters", payload["data"]["answer"])

    def test_project_scope_does_not_report_workspace_as_used_file(self) -> None:
        response = self.client.post(
            "/ask",
            json={
                "question": "Describe this project",
                "mode": "ideas",
                "scope": {
                    "type": "project",
                    "workspacePath": "C:\\repo",
                },
                "settings": {
                    "provider": "openai",
                    "model": "gpt-4.1-mini",
                    "maxTokens": 1200,
                    "temperature": 0.2,
                },
            },
        )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["data"]["usedFiles"], [])


if __name__ == "__main__":
    unittest.main()
