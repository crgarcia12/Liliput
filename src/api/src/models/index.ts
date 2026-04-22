// Domain models — populated during spec2cloud Phase 4

export interface ApiError {
  error: string;
  details?: string;
}

export interface HealthResponse {
  status: string;
  timestamp: string;
}

export interface InfoResponse {
  version: string;
  framework: string;
}
