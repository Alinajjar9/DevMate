import hashlib
import json
import shutil
import unittest
from pathlib import Path
from uuid import uuid4

from backend.app.knowledge_repository import IndexedChunk, IndexedFile, KnowledgeRepository
from backend.app.knowledge_store import KnowledgeStore


class SqliteRetrievalEvaluationTests(unittest.TestCase):
    def setUp(self) -> None:
        repository_root = Path(__file__).resolve().parents[2]
        self.fixture = json.loads(
            (repository_root / "tests" / "fixtures" / "project-retrieval-evaluation.json")
            .read_text(encoding="utf-8")
        )
        self.temporary_directory = repository_root / f".devmate-test-{uuid4().hex}"
        self.temporary_directory.mkdir()
        self.store = KnowledgeStore(self.temporary_directory / "retrieval.sqlite3").open()
        self.repository = KnowledgeRepository(self.store)
        self.repository.register_workspace(
            "workspace-evaluation",
            str(self.temporary_directory / "workspace"),
            chunking_version=2,
        )
        self.repository.apply_file_changes(
            "workspace-evaluation",
            upserts=tuple(self._indexed_file(file) for file in self.fixture["files"]),
        )

    def tearDown(self) -> None:
        self.store.close()
        shutil.rmtree(self.temporary_directory)

    def test_records_the_sqlite_fts_retrieval_baseline(self) -> None:
        cases = []
        for evaluation_case in self.fixture["cases"]:
            ranked_files = [
                result.relative_path
                for result in self.repository.search_lexical(
                    "workspace-evaluation",
                    evaluation_case["question"],
                    limit=20,
                )
            ]
            ranks = [
                ranked_files.index(file_path) + 1
                if file_path in ranked_files
                else None
                for file_path in evaluation_case["relevantFiles"]
            ]
            first_rank = min((rank for rank in ranks if rank is not None), default=None)
            cases.append({
                "id": evaluation_case["id"],
                "category": evaluation_case["category"],
                "first_rank": first_rank,
                "recall_at_five": sum(
                    rank is not None and rank <= 5 for rank in ranks
                ) / len(ranks),
            })

        report = {
            "case_count": len(cases),
            "top_one_hits": sum(case["first_rank"] == 1 for case in cases),
            "top_three_hits": sum(
                case["first_rank"] is not None and case["first_rank"] <= 3
                for case in cases
            ),
            "mean_reciprocal_rank": round(sum(
                0 if case["first_rank"] is None else 1 / case["first_rank"]
                for case in cases
            ) / len(cases), 4),
            "mean_recall_at_five": round(sum(
                case["recall_at_five"] for case in cases
            ) / len(cases), 4),
            "missed_case_ids": [
                case["id"] for case in cases if case["first_rank"] is None
            ],
        }

        self.assertEqual(report, {
            "case_count": 11,
            "top_one_hits": 7,
            "top_three_hits": 7,
            "mean_reciprocal_rank": 0.6364,
            "mean_recall_at_five": 0.6364,
            "missed_case_ids": [
                "conceptual-provider-recovery",
                "conceptual-terminal-diagnostics",
                "conceptual-linked-directory",
                "ambiguous-edit-permission",
            ],
        })

    @staticmethod
    def _indexed_file(file: dict[str, str]) -> IndexedFile:
        content = file["content"]
        content_hash = hashlib.sha256(content.encode("utf-8")).hexdigest()
        relative_path = file["relativePath"]
        return IndexedFile(
            relative_path=relative_path,
            language_id=file["languageId"],
            content_hash=content_hash,
            size_bytes=len(content.encode("utf-8")),
            modified_at=1,
            chunks=(IndexedChunk(
                stable_id=f"{relative_path}:1:0",
                ordinal=0,
                start_line=1,
                end_line=max(1, len(content.splitlines())),
                content=content,
                content_hash=content_hash,
                chunking_version=2,
            ),),
        )


if __name__ == "__main__":
    unittest.main()
