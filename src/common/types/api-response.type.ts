export interface MetaData {
  timestamp: string;
  path: string;
  statusCode: number;
  error?: string;
  pagination?: {
    page: number;
    limit: number;
    totalItems: number;
    totalPages: number;
  };
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
