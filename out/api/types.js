"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MAX_BACKEND_TOKEN_CHARACTERS = exports.MIN_BACKEND_TOKEN_CHARACTERS = exports.DEVMATE_BACKEND_TOKEN_ENVIRONMENT_VARIABLE = exports.DEVMATE_BACKEND_TOKEN_HEADER = exports.DEVMATE_BACKEND_CAPABILITIES = exports.DEVMATE_BACKEND_PROTOCOL_VERSION = exports.DEVMATE_BACKEND_SERVICE = void 0;
exports.DEVMATE_BACKEND_SERVICE = 'devmate-backend';
exports.DEVMATE_BACKEND_PROTOCOL_VERSION = 1;
exports.DEVMATE_BACKEND_CAPABILITIES = [
    'chat',
    'streaming',
    'request-authentication'
];
exports.DEVMATE_BACKEND_TOKEN_HEADER = 'X-DevMate-Backend-Token';
exports.DEVMATE_BACKEND_TOKEN_ENVIRONMENT_VARIABLE = 'DEVMATE_BACKEND_TOKEN';
exports.MIN_BACKEND_TOKEN_CHARACTERS = 32;
exports.MAX_BACKEND_TOKEN_CHARACTERS = 512;
//# sourceMappingURL=types.js.map