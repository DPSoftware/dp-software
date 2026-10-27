export const ErrorCode = {
    NO_COLOR: 'NO_COLOR',
    INVALID_ROW: 'INVALID_ROW',
    INVALID_HEADER: 'INVALID_HEADER',
    UNKNOWN_FORMAT: 'UNKNOWN_FORMAT',
    UNSUPPORTED_FORMAT: 'UNSUPPORTED_FORMAT',
    CLOUD_ERROR: 'CLOUD_ERROR',
    READ_ERROR: 'READ_ERROR',
    INIT_FAILED: 'INIT_FAILED',
    BUSY: 'BUSY',
    UNKNOWN: 'UNKNOWN',
} as const;
export type ErrorCode = typeof ErrorCode[keyof typeof ErrorCode];

/** A machine-readable parse error. */
export interface PointCloudError {
    code: ErrorCode;
    message: string;
    /** True when the run stops because of this error. */
    fatal: boolean;
    /** Sub-cloud index, for CLOUD_ERROR. */
    cloud?: number;
}

export type ParseStatus = 'OK' | 'CANCELLED' | ErrorCode;

/** Outcome handed to `onFinish`. */
export interface ParseResult {
    /** 'OK' without fatal errors, otherwise the code of the first fatal error. */
    status: ParseStatus;
    /** All errors reported in the run, fatal and non-fatal. */
    errorCount: number;
}

/** Error carrying an `ErrorCode`. */
export class PointCloudParseError extends Error {
    public readonly code: ErrorCode;

    public constructor(code: ErrorCode, message: string) {
        super(message);
        this.name = 'PointCloudParseError';
        this.code = code;
        Object.setPrototypeOf(this, PointCloudParseError.prototype);
    }
}
