"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MAX_BACKEND_TOKEN_CHARACTERS = exports.MIN_BACKEND_TOKEN_CHARACTERS = exports.DEVMATE_KNOWLEDGE_STORE_FILE_NAME = exports.DEVMATE_KNOWLEDGE_STORE_PATH_ENVIRONMENT_VARIABLE = exports.DEVMATE_BACKEND_TOKEN_ENVIRONMENT_VARIABLE = exports.DEVMATE_BACKEND_TOKEN_HEADER = exports.DEVMATE_BACKEND_ERROR_CODES = exports.DEVMATE_BACKEND_CAPABILITIES = exports.DEVMATE_BACKEND_PROTOCOL_VERSION = exports.DEVMATE_BACKEND_SERVICE = void 0;
exports.DEVMATE_BACKEND_SERVICE = 'devmate-backend';
exports.DEVMATE_BACKEND_PROTOCOL_VERSION = 2;
exports.DEVMATE_BACKEND_CAPABILITIES = [
    'chat',
    'streaming',
    'request-authentication',
    'strict-response-contracts'
];
exports.DEVMATE_BACKEND_ERROR_CODES = [
    'backend_authentication_failed',
    'request_validation_failed',
    'route_unavailable',
    'provider_configuration',
    'provider_authentication_failed',
    'provider_not_found',
    'provider_rate_limited',
    'provider_timeout',
    'provider_unavailable',
    'provider_invalid_response',
    'model_invalid_response',
    'internal_error'
];
exports.DEVMATE_BACKEND_TOKEN_HEADER = 'X-DevMate-Backend-Token';
exports.DEVMATE_BACKEND_TOKEN_ENVIRONMENT_VARIABLE = 'DEVMATE_BACKEND_TOKEN';
exports.DEVMATE_KNOWLEDGE_STORE_PATH_ENVIRONMENT_VARIABLE = 'DEVMATE_KNOWLEDGE_STORE_PATH';
exports.DEVMATE_KNOWLEDGE_STORE_FILE_NAME = 'devmate-knowledge.sqlite3';
exports.MIN_BACKEND_TOKEN_CHARACTERS = 32;
exports.MAX_BACKEND_TOKEN_CHARACTERS = 512;
//# sourceMappingURL=types.js.map