from typing import Annotated, NoReturn

from fastapi import APIRouter, Depends, Header

from .api_models import (
    KnowledgeIndexApplyRequest,
    KnowledgeIndexEmbeddingConfigurationData,
    KnowledgeIndexEmbeddingData,
    KnowledgeIndexEmbeddingRequest,
    KnowledgeIndexEmbeddingResult,
    KnowledgeIndexFileFingerprintData,
    KnowledgeIndexFileInput,
    KnowledgeIndexMetadataData,
    KnowledgeIndexMetadataResult,
    KnowledgeIndexMetadataUpdateRequest,
    KnowledgeIndexOpenData,
    KnowledgeIndexOpenRequest,
    KnowledgeIndexOpenResult,
    KnowledgeIndexSearchData,
    KnowledgeIndexSearchItemData,
    KnowledgeIndexSearchRequest,
    KnowledgeIndexSearchResult,
    KnowledgeIndexWorkspaceData,
    KnowledgeIndexWriteData,
    KnowledgeIndexWriteResult,
)
from .dependencies import get_embedding_index_service, get_knowledge_repository
from .embedding_index_service import (
    EmbeddingIndexError,
    EmbeddingIndexProfile,
    EmbeddingIndexService,
)
from .embedding_providers import MAX_EMBEDDING_API_KEY_CHARACTERS
from .errors import BackendApiError
from .knowledge_contracts import DEVMATE_KNOWLEDGE_INDEX_API_VERSION
from .knowledge_repository import (
    IndexedChunk,
    IndexedFile,
    IndexMetadataRecord,
    KnowledgeRepository,
    KnowledgeRepositoryError,
    KnowledgeRepositoryNotFoundError,
    KnowledgeRepositoryValidationError,
)
from .providers import ProviderError


knowledge_router = APIRouter(
    prefix=f"/index/v{DEVMATE_KNOWLEDGE_INDEX_API_VERSION}",
)


def _raise_repository_error(error: KnowledgeRepositoryError) -> NoReturn:
    if isinstance(error, KnowledgeRepositoryValidationError):
        raise BackendApiError(422, "request_validation_failed", str(error)) from error
    if isinstance(error, KnowledgeRepositoryNotFoundError):
        raise BackendApiError(
            404,
            "knowledge_workspace_not_found",
            "The requested workspace index does not exist.",
        ) from error
    raise BackendApiError(
        500,
        "knowledge_index_failure",
        "The local DevMate knowledge index operation failed.",
    ) from error


def _metadata_data(metadata: IndexMetadataRecord) -> KnowledgeIndexMetadataData:
    return KnowledgeIndexMetadataData(
        workspaceKey=metadata.workspace_key,
        chunkingVersion=metadata.chunking_version,
        indexState=metadata.index_state,
        lastFullScanAt=metadata.last_full_scan_at,
    )


def _indexed_file(value: KnowledgeIndexFileInput) -> IndexedFile:
    return IndexedFile(
        relative_path=value.relativePath,
        language_id=value.languageId,
        content_hash=value.contentHash,
        size_bytes=value.sizeBytes,
        modified_at=value.modifiedAt,
        chunks=tuple(
            IndexedChunk(
                stable_id=chunk.stableId,
                ordinal=chunk.ordinal,
                start_line=chunk.startLine,
                end_line=chunk.endLine,
                content=chunk.content,
                content_hash=chunk.contentHash,
                chunking_version=chunk.chunkingVersion,
            )
            for chunk in value.chunks
        ),
    )


@knowledge_router.post("/workspaces/open", response_model=KnowledgeIndexOpenResult)
async def open_knowledge_index(
    request: KnowledgeIndexOpenRequest,
    repository: Annotated[KnowledgeRepository, Depends(get_knowledge_repository)],
) -> KnowledgeIndexOpenResult:
    try:
        workspace = repository.register_workspace(
            request.workspaceKey,
            request.rootPath,
            chunking_version=request.chunkingVersion,
        )
        metadata = repository.index_metadata(request.workspaceKey)
        if metadata is None:
            raise KnowledgeRepositoryError("The workspace index metadata is missing.")
        fingerprints = repository.file_fingerprints(request.workspaceKey)
    except KnowledgeRepositoryError as error:
        _raise_repository_error(error)
    return KnowledgeIndexOpenResult(
        status="ok",
        data=KnowledgeIndexOpenData(
            workspace=KnowledgeIndexWorkspaceData(
                id=workspace.id,
                workspaceKey=workspace.workspace_key,
                rootPath=workspace.root_path,
            ),
            metadata=_metadata_data(metadata),
            files=[
                KnowledgeIndexFileFingerprintData(
                    relativePath=fingerprint.relative_path,
                    contentHash=fingerprint.content_hash,
                    sizeBytes=fingerprint.size_bytes,
                    modifiedAt=fingerprint.modified_at,
                )
                for fingerprint in fingerprints
            ],
        ),
    )


@knowledge_router.post("/files/apply", response_model=KnowledgeIndexWriteResult)
async def apply_knowledge_index_files(
    request: KnowledgeIndexApplyRequest,
    repository: Annotated[KnowledgeRepository, Depends(get_knowledge_repository)],
) -> KnowledgeIndexWriteResult:
    try:
        result = repository.apply_file_changes(
            request.workspaceKey,
            upserts=tuple(_indexed_file(file) for file in request.upserts),
            deleted_paths=tuple(request.deletedPaths),
        )
    except KnowledgeRepositoryError as error:
        _raise_repository_error(error)
    return KnowledgeIndexWriteResult(
        status="ok",
        data=KnowledgeIndexWriteData(
            upsertedFiles=result.upserted_files,
            deletedFiles=result.deleted_files,
        ),
    )


@knowledge_router.post("/metadata/update", response_model=KnowledgeIndexMetadataResult)
async def update_knowledge_index_metadata(
    request: KnowledgeIndexMetadataUpdateRequest,
    repository: Annotated[KnowledgeRepository, Depends(get_knowledge_repository)],
) -> KnowledgeIndexMetadataResult:
    try:
        metadata = repository.update_index_metadata(
            request.workspaceKey,
            chunking_version=request.chunkingVersion,
            index_state=request.indexState,
            last_full_scan_at=request.lastFullScanAt,
        )
    except KnowledgeRepositoryError as error:
        _raise_repository_error(error)
    return KnowledgeIndexMetadataResult(status="ok", data=_metadata_data(metadata))


@knowledge_router.post("/search", response_model=KnowledgeIndexSearchResult)
async def search_knowledge_index(
    request: KnowledgeIndexSearchRequest,
    repository: Annotated[KnowledgeRepository, Depends(get_knowledge_repository)],
) -> KnowledgeIndexSearchResult:
    try:
        if repository.index_metadata(request.workspaceKey) is None:
            raise KnowledgeRepositoryNotFoundError("The workspace index does not exist.")
        results = repository.search_lexical(
            request.workspaceKey,
            request.query,
            limit=request.limit,
        )
    except KnowledgeRepositoryError as error:
        _raise_repository_error(error)
    return KnowledgeIndexSearchResult(
        status="ok",
        data=KnowledgeIndexSearchData(
            results=[
                KnowledgeIndexSearchItemData(
                    relativePath=result.relative_path,
                    languageId=result.language_id,
                    stableId=result.stable_id,
                    ordinal=result.ordinal,
                    startLine=result.start_line,
                    endLine=result.end_line,
                    content=result.content,
                    contentHash=result.content_hash,
                    score=result.score,
                )
                for result in results
            ]
        ),
    )


@knowledge_router.post(
    "/embeddings/synchronize",
    response_model=KnowledgeIndexEmbeddingResult,
)
async def synchronize_knowledge_index_embeddings(
    request: KnowledgeIndexEmbeddingRequest,
    service: Annotated[EmbeddingIndexService, Depends(get_embedding_index_service)],
    provider_api_key: Annotated[
        str | None,
        Header(
            alias="X-DevMate-Provider-Key",
            max_length=MAX_EMBEDDING_API_KEY_CHARACTERS,
        ),
    ] = None,
) -> KnowledgeIndexEmbeddingResult:
    try:
        result = await service.synchronize_workspace(
            request.workspaceKey,
            EmbeddingIndexProfile(
                profile_id=request.profileId,
                provider=request.provider,
                model=request.model,
                base_url=request.baseUrl,
                api_key=provider_api_key,
                remote_allowed=request.remoteAllowed,
                vector_version=request.vectorVersion,
            ),
            batch_size=request.batchSize,
            max_batches=request.maxBatches,
        )
    except KnowledgeRepositoryError as error:
        _raise_repository_error(error)
    except ProviderError as error:
        raise BackendApiError(
            error.status_code,
            error.error_code,
            str(error),
        ) from error
    except EmbeddingIndexError as error:
        raise BackendApiError(
            502,
            "provider_invalid_response",
            "The embedding provider returned invalid vector data.",
        ) from error

    configuration = result.configuration
    return KnowledgeIndexEmbeddingResult(
        status="ok",
        data=KnowledgeIndexEmbeddingData(
            configuration=(
                KnowledgeIndexEmbeddingConfigurationData(
                    profileId=configuration.profile_id,
                    provider=configuration.provider,
                    model=configuration.model,
                    dimensions=configuration.dimensions,
                    vectorVersion=configuration.vector_version,
                )
                if configuration is not None
                else None
            ),
            embeddedChunks=result.embedded_chunks,
            processedBatches=result.processed_batches,
            complete=result.complete,
        ),
    )
