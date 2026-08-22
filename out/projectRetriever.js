"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.LexicalProjectRetriever = void 0;
const projectIndex_1 = require("./projectIndex");
class LexicalProjectRetriever {
    retrieve(request) {
        return Promise.resolve((0, projectIndex_1.retrieveProjectChunks)(request.index, request.question, request.limits));
    }
}
exports.LexicalProjectRetriever = LexicalProjectRetriever;
//# sourceMappingURL=projectRetriever.js.map