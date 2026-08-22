from .api_models import BackendErrorCode


class BackendApiError(Exception):
    def __init__(
        self,
        status_code: int,
        error_code: BackendErrorCode,
        message: str,
    ) -> None:
        super().__init__(message)
        self.status_code = status_code
        self.error_code = error_code
        self.message = message
