import { retrieveProjectChunks } from './projectIndex';
import type {
  ProjectChunkRetrievalLimits,
  ProjectIndex,
  RetrievedProjectChunk
} from './projectIndex';

export type ProjectRetrievalRequest = {
  index: ProjectIndex;
  question: string;
  limits: ProjectChunkRetrievalLimits;
};

export interface ProjectRetriever {
  retrieve(request: ProjectRetrievalRequest): Promise<RetrievedProjectChunk[]>;
}

export class LexicalProjectRetriever implements ProjectRetriever {
  retrieve(request: ProjectRetrievalRequest): Promise<RetrievedProjectChunk[]> {
    return Promise.resolve(
      retrieveProjectChunks(request.index, request.question, request.limits)
    );
  }
}
