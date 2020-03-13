/*
 * Copyright (C) 2020 HERE Europe B.V.
 * Licensed under Apache 2.0, see full license in LICENSE
 * SPDX-License-Identifier: Apache-2.0
 */

import { Vector3Like } from "@here/harp-geoutils";
import { hasDisplacementFeature } from "@here/harp-materials";
import { assert, sampleBilinear } from "@here/harp-utils";
import * as THREE from "three";

class IndexedPositionCache {
    private static MAX_CACHE_ENTRIES = 3;
    private static CACHE_STRIDE = 4;
    private static MAX_CACHE_SIZE =
        IndexedPositionCache.MAX_CACHE_ENTRIES * IndexedPositionCache.CACHE_STRIDE;

    private m_cache: number[] = []; // index,x,y,z...
    private m_nextEvictIndex: number = 0;

    constructor() {
        this.m_cache.length = IndexedPositionCache.MAX_CACHE_SIZE;
        this.m_cache.fill(-1);
    }
    get(bufferIndex: number, position: Vector3Like): boolean {
        const cacheIndex = this.findIndex(bufferIndex);
        if (cacheIndex === undefined) {
            return false;
        }

        position.x = this.m_cache[cacheIndex + 1];
        position.y = this.m_cache[cacheIndex + 2];
        position.z = this.m_cache[cacheIndex + 3];
        return true;
    }

    set(bufferIndex: number, position: Vector3Like) {
        const cacheIndex = this.m_nextEvictIndex;
        this.m_cache[cacheIndex] = bufferIndex;
        this.m_cache[cacheIndex + 1] = position.x;
        this.m_cache[cacheIndex + 2] = position.y;
        this.m_cache[cacheIndex + 3] = position.z;
        this.m_nextEvictIndex =
            (this.m_nextEvictIndex + IndexedPositionCache.CACHE_STRIDE) %
            IndexedPositionCache.MAX_CACHE_SIZE;
    }

    private findIndex(bufferIndex: number): number | undefined {
        const size = this.m_cache.length;
        for (let i = 0; i < size; i += IndexedPositionCache.CACHE_STRIDE) {
            if (this.m_cache[i] === bufferIndex) {
                return i;
            }
        }
        return undefined;
    }

    private evictLRU(): number {
        return 0;
    }
}
class DisplacedBufferAttribute extends THREE.BufferAttribute {
    originalAttribute?: THREE.BufferAttribute | THREE.InterleavedBufferAttribute;
    private m_normals?: THREE.BufferAttribute | THREE.InterleavedBufferAttribute;
    private m_uvs?: THREE.BufferAttribute | THREE.InterleavedBufferAttribute;
    private m_texture?: Float32Array;
    private m_textureWidth: number = 0;
    private m_textureHeight: number = 0;

    private m_cache = new IndexedPositionCache();
    private m_lastBufferIndex: number = -1;
    private m_lastPos = new THREE.Vector3();
    private m_tmpNormal = new THREE.Vector3();

    constructor() {
        super(new Uint8Array(), 1);
    }
    displace(
        originalAttribute: THREE.BufferAttribute | THREE.InterleavedBufferAttribute,
        normals: THREE.BufferAttribute | THREE.InterleavedBufferAttribute,
        uvs: THREE.BufferAttribute | THREE.InterleavedBufferAttribute,
        displacementMap: THREE.DataTexture
    ) {
        this.array = originalAttribute.array;
        this.itemSize = originalAttribute.itemSize;
        this.normalized = originalAttribute.normalized;
        this.originalAttribute = originalAttribute;
        this.m_normals = normals;
        this.m_uvs = uvs;
        this.m_texture = new Float32Array(displacementMap.image.data.buffer);
        this.m_textureWidth = displacementMap.image.width;
        this.m_textureHeight = displacementMap.image.height;
    }

    /** @override */
    getX(index: number): number {
        return this.getDisplacedCoordinate(index).x;
    }

    /** @override */
    getY(index: number): number {
        return this.getDisplacedCoordinate(index).y;
    }

    /** @override */
    getZ(index: number): number {
        return this.getDisplacedCoordinate(index).z;
    }

    private getDisplacedCoordinate(bufferIndex: number): Vector3Like {
        if (bufferIndex === this.m_lastBufferIndex) {
            return this.m_lastPos;
        }

        this.m_lastBufferIndex = bufferIndex;
        if (this.m_cache.get(bufferIndex, this.m_lastPos)) {
            return this.m_lastPos;
        }

        this.displacePosition(bufferIndex);

        this.m_cache.set(bufferIndex, this.m_lastPos);
        return this.m_lastPos;
    }

    private displacePosition(bufferIndex: number) {
        this.m_lastPos.set(
            super.getX(bufferIndex),
            super.getY(bufferIndex),
            super.getZ(bufferIndex)
        );
        const normals = this.m_normals!;
        this.m_tmpNormal.set(
            normals.getX(bufferIndex),
            normals.getY(bufferIndex),
            normals.getZ(bufferIndex)
        );
        const uvs = this.m_uvs!;
        const displacement = sampleBilinear(
            this.m_texture!,
            this.m_textureWidth,
            this.m_textureHeight,
            uvs.getX(bufferIndex),
            uvs.getY(bufferIndex)
        );
        this.m_lastPos.add(this.m_tmpNormal.multiplyScalar(displacement));
    }
}

const tmpDisplacedAttribute = new DisplacedBufferAttribute();

function displaceGeometryForTask(
    displacementMap: THREE.DataTexture,
    geometry: THREE.BufferGeometry,
    task: () => void
) {
    const positions = geometry.getAttribute("position");
    const normals = geometry.getAttribute("normal");
    const uvs = geometry.getAttribute("uv");
    tmpDisplacedAttribute.displace(positions, normals, uvs, displacementMap);

    geometry.setAttribute("position", tmpDisplacedAttribute);
    task();
    geometry.setAttribute("position", tmpDisplacedAttribute.originalAttribute!);
}

/**
 * Mesh with geometry modified by a displacement map. Overrides raycasting behaviour to apply
 * displacement map before intersection test.
 * @internal
 * @hidden
 */
export class DisplacedMesh extends THREE.Mesh {
    /** @override */
    raycast(raycaster: THREE.Raycaster, intersects: THREE.Intersection[]): void {
        const material: THREE.Material = Array.isArray(this.material)
            ? this.material[0]
            : this.material;

        // Use default raycasting implementation if some type is unexpected.
        if (
            !(this.geometry instanceof THREE.BufferGeometry) ||
            !hasDisplacementFeature(material) ||
            !(material.displacementMap instanceof THREE.DataTexture)
        ) {
            super.raycast(raycaster, intersects);
            return;
        }
        const displacementMap = material.displacementMap;

        // All materials in the object are expected to have the same displacement map.
        assert(
            !Array.isArray(this.material) ||
                this.material.every(
                    mat => hasDisplacementFeature(mat) && mat.displacementMap === displacementMap
                )
        );

        displaceGeometryForTask(
            displacementMap,
            this.geometry,
            super.raycast.bind(this, raycaster, intersects)
        );
    }
}
