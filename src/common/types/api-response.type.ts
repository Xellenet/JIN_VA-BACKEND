export interface MetaData {
  timestamp: string;
  path: string;
  statusCode: number;
  pagination?: {
    page: number;
    limit: number;
    totalItems: number;
    totalPages: number;
  };
  error?: string;
}

export interface SuccessResponse<T> {
  status: 'success';
  message: string;
  data: T;
  meta: MetaData;
}

export interface ErrorResponse {
  status: 'error';
  message: string | string[];
  meta: MetaData;
}
