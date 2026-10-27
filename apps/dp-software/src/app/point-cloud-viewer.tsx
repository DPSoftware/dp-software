import {forwardRef, useEffect, useImperativeHandle, useRef} from 'react';
import styled from 'styled-components';
import * as THREE from 'three';
import {OrbitControls} from 'three/examples/jsm/controls/OrbitControls.js';

const Container = styled.div`
    width: 100%;
    height: 70vh;
    background: #111;
    margin-top: 12px;

    canvas {
        display: block;
    }
`;

export interface PointCloudViewerHandle {
    /** Drops the current cloud and preallocates room for `capacity` points. */
    reset(capacity?: number): void;
    /** Appends points with 0..255 RGB colors (white when colors are missing). */
    append(points: [number, number, number][], colors?: [number, number, number][]): void;
    /** Appends interleaved xyz positions with interleaved 0..255 RGB colors. */
    appendTyped(positions: Float64Array, colors: Uint8Array): void;
    /** Fits the camera and orbit target to the bounding sphere of the cloud. */
    fit(): void;
}

const DEFAULT_CAPACITY = 100000;

const NOOP_HANDLE: PointCloudViewerHandle = {
    reset: () => undefined,
    append: () => undefined,
    appendTyped: () => undefined,
    fit: () => undefined,
};

function hasWebGL(): boolean {
    try {
        const canvas = document.createElement('canvas');
        return !!(canvas.getContext('webgl2') || canvas.getContext('webgl'));
    } catch {
        return false;
    }
}

/** Streams points into a preallocated THREE.Points buffer so the cloud builds up live. */
export const PointCloudViewer = forwardRef<PointCloudViewerHandle>(function PointCloudViewer(_props, ref) {
    const containerRef = useRef<HTMLDivElement>(null);
    const handleRef = useRef<PointCloudViewerHandle>(NOOP_HANDLE);

    useImperativeHandle(ref, () => ({
        reset: capacity => handleRef.current.reset(capacity),
        append: (points, colors) => handleRef.current.append(points, colors),
        appendTyped: (positions, colors) => handleRef.current.appendTyped(positions, colors),
        fit: () => handleRef.current.fit(),
    }), []);

    useEffect(() => {
        const container = containerRef.current;
        if (!container || !hasWebGL()) {
            return undefined;
        }

        const renderer = new THREE.WebGLRenderer({antialias: false});
        renderer.setPixelRatio(window.devicePixelRatio);
        container.appendChild(renderer.domElement);

        const scene = new THREE.Scene();
        const camera = new THREE.PerspectiveCamera(60, 1, 0.01, 1e7);
        camera.position.set(0, 0, 10);
        const controls = new OrbitControls(camera, renderer.domElement);
        controls.enableDamping = false;

        const material = new THREE.PointsMaterial({vertexColors: true, sizeAttenuation: false, size: 2});
        let geometry = new THREE.BufferGeometry();
        let positions = new Float32Array(0);
        let colors = new Float32Array(0);
        let count = 0;
        const points = new THREE.Points(geometry, material);
        points.frustumCulled = false;
        scene.add(points);

        const render = () => renderer.render(scene, camera);
        controls.addEventListener('change', render);

        const allocate = (capacity: number) => {
            geometry.dispose();
            geometry = new THREE.BufferGeometry();
            positions = new Float32Array(capacity * 3);
            colors = new Float32Array(capacity * 3);
            geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
            geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
            geometry.setDrawRange(0, 0);
            points.geometry = geometry;
            count = 0;
        };

        const grow = (needed: number) => {
            const capacity = Math.max(needed, Math.ceil((positions.length / 3) * 1.5));
            const oldPositions = positions.subarray(0, count * 3);
            const oldColors = colors.subarray(0, count * 3);
            const kept = count;
            allocate(capacity);
            positions.set(oldPositions);
            colors.set(oldColors);
            count = kept;
        };

        let frame = 0;
        const scheduleRender = () => {
            if (!frame) {
                frame = requestAnimationFrame(() => {
                    frame = 0;
                    render();
                });
            }
        };

        const resize = () => {
            const width = container.clientWidth || 1;
            const height = container.clientHeight || 1;
            renderer.setSize(width, height);
            camera.aspect = width / height;
            camera.updateProjectionMatrix();
            render();
        };

        handleRef.current = {
            reset: capacity => {
                allocate(Math.max(capacity ?? 0, DEFAULT_CAPACITY));
                scheduleRender();
            },
            append: (newPoints, newColors) => {
                const n = newPoints.length;
                if (count + n > positions.length / 3) {
                    grow(count + n);
                }
                for (let i = 0; i < n; i++) {
                    const p = newPoints[i];
                    const o = (count + i) * 3;
                    positions[o] = p[0];
                    positions[o + 1] = p[1];
                    positions[o + 2] = p[2];
                    const c = newColors?.[i];
                    colors[o] = c ? c[0] / 255 : 1;
                    colors[o + 1] = c ? c[1] / 255 : 1;
                    colors[o + 2] = c ? c[2] / 255 : 1;
                }
                count += n;
                geometry.setDrawRange(0, count);
                geometry.getAttribute('position').needsUpdate = true;
                geometry.getAttribute('color').needsUpdate = true;
                scheduleRender();
            },
            appendTyped: (newPositions, newColors) => {
                const n = Math.floor(newPositions.length / 3);
                if (count + n > positions.length / 3) {
                    grow(count + n);
                }
                const o = count * 3;
                positions.set(newPositions.subarray(0, n * 3), o);
                for (let i = 0; i < n * 3; i++) {
                    colors[o + i] = newColors[i] / 255;
                }
                count += n;
                geometry.setDrawRange(0, count);
                geometry.getAttribute('position').needsUpdate = true;
                geometry.getAttribute('color').needsUpdate = true;
                scheduleRender();
            },
            fit: () => {
                if (!count) {
                    return;
                }
                geometry.computeBoundingSphere();
                const sphere = geometry.boundingSphere;
                if (!sphere) {
                    return;
                }
                const radius = Math.max(sphere.radius, 1e-6);
                const distance = radius / Math.sin((camera.fov * Math.PI) / 360);
                const direction = camera.position.clone().sub(controls.target);
                if (direction.lengthSq() === 0) {
                    direction.set(0, 0, 1);
                }
                direction.normalize();
                controls.target.copy(sphere.center);
                camera.position.copy(sphere.center).addScaledVector(direction, distance);
                camera.near = radius / 100;
                camera.far = distance + radius * 10;
                camera.updateProjectionMatrix();
                controls.update();
                render();
            },
        };

        allocate(DEFAULT_CAPACITY);
        resize();
        const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(resize);
        observer?.observe(container);
        window.addEventListener('resize', resize);

        return () => {
            handleRef.current = NOOP_HANDLE;
            window.removeEventListener('resize', resize);
            observer?.disconnect();
            cancelAnimationFrame(frame);
            controls.removeEventListener('change', render);
            controls.dispose();
            geometry.dispose();
            material.dispose();
            renderer.dispose();
            container.removeChild(renderer.domElement);
        };
    }, []);

    return <Container ref={containerRef} id="viewer"/>;
});

export default PointCloudViewer;
