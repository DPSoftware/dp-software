import type { ErrorCode } from "../../errors.js";

export type RGB = [number, number, number];

export interface PointCloudData {
    points: [number, number, number][];
    colors?: RGB[];
    normals?: [number, number, number][];
    /** Per-point intensity normalised to 0..1; only some formats/engines provide it. */
    intensities?: number[];
    /** Index of the scan this batch came from, for multi-scan formats such as E57. */
    scanIndex?: number;
}

/** Fully resolved parser options handed to an engine. */
export interface ResolvedPtsOptions {
    /** Edge length of the voxel cell used for downsampling. */
    voxelSize: number;
    /** Whether rows without r g b values are accepted. */
    acceptColorless: boolean;
    /** Color assigned to colorless points when `acceptColorless` is true. */
    defaultColor: RGB;
}

/** Callbacks an engine uses to report results back to `PTSParser`. */
export interface PtsEngineSink {
    /** Point count read from the header line. */
    header(total: number): void;
    /** A batch of kept points. */
    points(data: PointCloudData): void;
    /** Loading progress in the range 0..1. */
    progress(value: number): void;
    /**
     * A row or stream error. `code` defaults to UNKNOWN and `fatal` to false.
     * An engine reporting a fatal error must still call `finish()` once.
     */
    error(message: string, code?: ErrorCode, fatal?: boolean): void;
    /** Parsing ended. Must be called exactly once per run. */
    finish(): void;
}

/** A pluggable PTS parsing implementation. */
export interface PtsEngine {
    /** Parses `file`, reporting everything through `sink`. */
    run(file: Blob, opts: ResolvedPtsOptions, sink: PtsEngineSink): void;
}
