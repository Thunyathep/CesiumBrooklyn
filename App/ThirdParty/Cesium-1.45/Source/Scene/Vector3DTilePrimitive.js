define([
        '../Core/Cartesian3',
        '../Core/Color',
        '../Core/ComponentDatatype',
        '../Core/defaultValue',
        '../Core/defined',
        '../Core/defineProperties',
        '../Core/destroyObject',
        '../Core/IndexDatatype',
        '../Core/Matrix4',
        '../Core/PrimitiveType',
        '../Renderer/Buffer',
        '../Renderer/BufferUsage',
        '../Renderer/DrawCommand',
        '../Renderer/Pass',
        '../Renderer/RenderState',
        '../Renderer/ShaderProgram',
        '../Renderer/ShaderSource',
        '../Renderer/VertexArray',
        '../Shaders/ShadowVolumeFS',
        '../Shaders/ShadowVolumeVS',
        './BlendingState',
        './Cesium3DTileFeature',
        './ClassificationType',
        './DepthFunction',
        './Expression',
        './StencilFunction',
        './StencilOperation',
        './Vector3DTileBatch'
    ], function(
        Cartesian3,
        Color,
        ComponentDatatype,
        defaultValue,
        defined,
        defineProperties,
        destroyObject,
        IndexDatatype,
        Matrix4,
        PrimitiveType,
        Buffer,
        BufferUsage,
        DrawCommand,
        Pass,
        RenderState,
        ShaderProgram,
        ShaderSource,
        VertexArray,
        ShadowVolumeFS,
        ShadowVolumeVS,
        BlendingState,
        Cesium3DTileFeature,
        ClassificationType,
        DepthFunction,
        Expression,
        StencilFunction,
        StencilOperation,
        Vector3DTileBatch) {
    'use strict';

    /**
     * Creates a batch of classification meshes.
     *
     * @alias Vector3DTilePrimitive
     * @constructor
     *
     * @param {Object} options An object with following properties:
     * @param {Float32Array} options.positions The positions of the meshes.
     * @param {Uint16Array|Uint32Array} options.indices The indices of the triangulated meshes. The indices must be contiguous so that
     * the indices for mesh n are in [i, i + indexCounts[n]] where i = sum{indexCounts[0], indexCounts[n - 1]}.
     * @param {Uint32Array} options.indexCounts The number of indices for each mesh.
     * @param {Uint32Array} options.indexOffsets The offset into the index buffer for each mesh.
     * @param {Vector3DTileBatch[]} options.batchedIndices The index offset and count for each batch with the same color.
     * @param {Cartesian3} [options.center=Cartesian3.ZERO] The RTC center.
     * @param {Cesium3DTileBatchTable} options.batchTable The batch table for the tile containing the batched meshes.
     * @param {Uint16Array} options.batchIds The batch ids for each mesh.
     * @param {Uint16Array} options.vertexBatchIds The batch id for each vertex.
     * @param {BoundingSphere} options.boundingVolume The bounding volume for the entire batch of meshes.
     * @param {BoundingSphere[]} options.boundingVolumes The bounding volume for each mesh.
     * @param {ClassificationType} [options.classificationType] What this tile will classify.
     *
     * @private
     */
    function Vector3DTilePrimitive(options) {
        options = defaultValue(options, defaultValue.EMPTY_OBJECT);

        this._batchTable = options.batchTable;
        this._batchIds = options.batchIds;

        // These arrays are released after VAO creation.
        this._positions = options.positions;
        this._vertexBatchIds = options.vertexBatchIds;

        // These arrays are kept for re-batching indices based on colors.
        // If WebGL 2 is supported, indices will be released and re-batching uses buffer-to-buffer copies.
        this._indices = options.indices;
        this._indexCounts = options.indexCounts;
        this._indexOffsets = options.indexOffsets;
        this._batchedIndices = options.batchedIndices;

        this._boundingVolume = options.boundingVolume;
        this._boundingVolumes = options.boundingVolumes;

        this._center = defaultValue(options.center, Cartesian3.ZERO);

        this._va = undefined;
        this._sp = undefined;
        this._spStencil = undefined;
        this._spPick = undefined;
        this._uniformMap = undefined;

        // Only used with WebGL 2 to ping-pong ibos after copy.
        this._vaSwap = undefined;

        this._rsStencilPreloadPass = undefined;
        this._rsStencilDepthPass = undefined;
        this._rsColorPass = undefined;
        this._rsPickPass = undefined;
        this._rsWireframe = undefined;

        this._commands = [];
        this._commandsIgnoreShow = [];
        this._pickCommands = [];

        this._constantColor = Color.clone(Color.WHITE);
        this._highlightColor = this._constantColor;

        this._batchDirty = true;
        this._pickCommandsDirty = true;
        this._framesSinceLastRebatch = 0;

        this._updatingAllCommands = false;

        this._trianglesLength = this._indices.length / 3;
        this._geometryByteLength = this._indices.byteLength + this._positions.byteLength + this._vertexBatchIds.byteLength;

        /**
         * Draw the wireframe of the classification meshes.
         * @type {Boolean}
         * @default false
         */
        this.debugWireframe = false;
        this._debugWireframe = this.debugWireframe;
        this._wireframeDirty = false;

        /**
         * Forces a re-batch instead of waiting after a number of frames have been rendered. For testing only.
         * @type {Boolean}
         * @default false
         */
        this.forceRebatch = false;

        /**
         * What this tile will classify.
         * @type {ClassificationType}
         * @default ClassificationType.BOTH
         */
        this.classificationType = defaultValue(options.classificationType, ClassificationType.BOTH);

        // Hidden options
        this._vertexShaderSource = options._vertexShaderSource;
        this._fragmentShaderSource = options._fragmentShaderSource;
        this._attributeLocations = options._attributeLocations;
        this._pickVertexShaderSource = options._pickVertexShaderSource;
        this._pickFragmentShaderSource = options._pickFragmentShaderSource;
        this._uniformMap = options._uniformMap;
        this._pickUniformMap = options._pickUniformMap;
        this._modelMatrix = options._modelMatrix;
        this._boundingSphere = options._boundingSphere;

        this._batchIdLookUp = {};

        var length = this._batchIds.length;
        for (var i = 0; i < length; ++i) {
            var batchId = this._batchIds[i];
            this._batchIdLookUp[batchId] = i;
        }
    }

    defineProperties(Vector3DTilePrimitive.prototype, {
        /**
         * Gets the number of triangles.
         *
         * @memberof Vector3DTilePrimitive.prototype
         *
         * @type {Number}
         * @readonly
         */
        trianglesLength : {
            get : function() {
                return this._trianglesLength;
            }
        },

        /**
         * Gets the geometry memory in bytes.
         *
         * @memberof Vector3DTilePrimitive.prototype
         *
         * @type {Number}
         * @readonly
         */
        geometryByteLength : {
            get : function() {
                return this._geometryByteLength;
            }
        }
    });

    var defaultAttributeLocations = {
        position : 0,
        a_batchId : 1
    };

    function createVertexArray(primitive, context) {
        if (defined(primitive._va)) {
            return;
        }

        var positionBuffer = Buffer.createVertexBuffer({
            context : context,
            typedArray : primitive._positions,
            usage : BufferUsage.STATIC_DRAW
        });
        var idBuffer = Buffer.createVertexBuffer({
            context : context,
            typedArray : primitive._vertexBatchIds,
            usage : BufferUsage.STATIC_DRAW
        });
        var indexBuffer = Buffer.createIndexBuffer({
            context : context,
            typedArray : primitive._indices,
            usage : BufferUsage.DYNAMIC_DRAW,
            indexDatatype : (primitive._indices.BYTES_PER_ELEMENT === 2) ?  IndexDatatype.UNSIGNED_SHORT : IndexDatatype.UNSIGNED_INT
        });

        var vertexAttributes = [{
            index : 0,
            vertexBuffer : positionBuffer,
            componentDatatype : ComponentDatatype.fromTypedArray(primitive._positions),
            componentsPerAttribute : 3
        }, {
            index : 1,
            vertexBuffer : idBuffer,
            componentDatatype : ComponentDatatype.fromTypedArray(primitive._vertexBatchIds),
            componentsPerAttribute : 1
        }];

        primitive._va = new VertexArray({
            context : context,
            attributes : vertexAttributes,
            indexBuffer : indexBuffer
        });

        if (context.webgl2) {
            primitive._vaSwap = new VertexArray({
                context : context,
                attributes : vertexAttributes,
                indexBuffer : Buffer.createIndexBuffer({
                    context : context,
                    sizeInBytes : indexBuffer.sizeInBytes,
                    usage : BufferUsage.DYNAMIC_DRAW,
                    indexDatatype : indexBuffer.indexDatatype
                })
            });
        }

        primitive._batchedPositions = undefined;
        primitive._transferrableBatchIds = undefined;
        primitive._vertexBatchIds = undefined;
        primitive._verticesPromise = undefined;
    }

    function createShaders(primitive, context) {
        if (defined(primitive._sp)) {
            return;
        }

        var batchTable = primitive._batchTable;
        var attributeLocations = defaultValue(primitive._attributeLocations, defaultAttributeLocations);

        var vertexShaderSource = primitive._vertexShaderSource;
        if (defined(vertexShaderSource)) {
            primitive._sp = ShaderProgram.fromCache({
                context : context,
                vertexShaderSource : vertexShaderSource,
                fragmentShaderSource : primitive._fragmentShaderSource,
                attributeLocations : attributeLocations
            });
            primitive._spStencil = primitive._sp;
            primitive._spPick = ShaderProgram.fromCache({
                context : context,
                vertexShaderSource : primitive._pickVertexShaderSource,
                fragmentShaderSource : primitive._pickFragmentShaderSource,
                attributeLocations : attributeLocations
            });
            return;
        }

        var vsSource = batchTable.getVertexShaderCallback(false, 'a_batchId', undefined)(ShadowVolumeVS);
        var fsSource = batchTable.getFragmentShaderCallback()(ShadowVolumeFS, false, undefined);

        var vs = new ShaderSource({
            defines : ['VECTOR_TILE'],
            sources : [vsSource]
        });
        var fs = new ShaderSource({
            defines : ['VECTOR_TILE'],
            sources : [fsSource]
        });

        primitive._sp = ShaderProgram.fromCache({
            context : context,
            vertexShaderSource : vs,
            fragmentShaderSource : fs,
            attributeLocations : attributeLocations
        });

        vs = new ShaderSource({
            defines : ['VECTOR_TILE'],
            sources : [ShadowVolumeVS]
        });
        fs = new ShaderSource({
            defines : ['VECTOR_TILE'],
            sources : [ShadowVolumeFS]
        });

        primitive._spStencil = ShaderProgram.fromCache({
            context : context,
            vertexShaderSource : vs,
            fragmentShaderSource : fs,
            attributeLocations : attributeLocations
        });

        vsSource = batchTable.getPickVertexShaderCallbackIgnoreShow('a_batchId')(ShadowVolumeVS);
        fsSource = batchTable.getPickFragmentShaderCallbackIgnoreShow()(ShadowVolumeFS);

        var pickVS = new ShaderSource({
            defines : ['VECTOR_TILE'],
            sources : [vsSource]
        });
        var pickFS = new ShaderSource({
            defines : ['VECTOR_TILE'],
            sources : [fsSource]
        });
        primitive._spPick = ShaderProgram.fromCache({
            context : context,
            vertexShaderSource : pickVS,
            fragmentShaderSource : pickFS,
            attributeLocations : attributeLocations
        });
    }

    var stencilReference = 0;
    var stencilMask = 0x0F;

    var stencilPreloadRenderState = {
        colorMask : {
            red : false,
            green : false,
            blue : false,
            alpha : false
        },
        stencilTest : {
            enabled : true,
            frontFunction : StencilFunction.ALWAYS,
            frontOperation : {
                fail : StencilOperation.KEEP,
                zFail : StencilOperation.DECREMENT_WRAP,
                zPass : StencilOperation.DECREMENT_WRAP
            },
            backFunction : StencilFunction.ALWAYS,
            backOperation : {
                fail : StencilOperation.KEEP,
                zFail : StencilOperation.INCREMENT_WRAP,
                zPass : StencilOperation.INCREMENT_WRAP
            },
            reference : stencilReference,
            mask : stencilMask
        },
        depthTest : {
            enabled : false
        },
        depthMask : false
    };

    var stencilDepthRenderState = {
        colorMask : {
            red : false,
            green : false,
            blue : false,
            alpha : false
        },
        stencilTest : {
            enabled : true,
            frontFunction : StencilFunction.ALWAYS,
            frontOperation : {
                fail : StencilOperation.KEEP,
                zFail : StencilOperation.KEEP,
                zPass : StencilOperation.INCREMENT_WRAP
            },
            backFunction : StencilFunction.ALWAYS,
            backOperation : {
                fail : StencilOperation.KEEP,
                zFail : StencilOperation.KEEP,
                zPass : StencilOperation.DECREMENT_WRAP
            },
            reference : stencilReference,
            mask : stencilMask
        },
        depthTest : {
            enabled : true,
            func : DepthFunction.LESS_OR_EQUAL
        },
        depthMask : false
    };

    var colorRenderState = {
        stencilTest : {
            enabled : true,
            frontFunction : StencilFunction.NOT_EQUAL,
            frontOperation : {
                fail : StencilOperation.KEEP,
                zFail : StencilOperation.KEEP,
                zPass : StencilOperation.DECREMENT_WRAP
            },
            backFunction : StencilFunction.NOT_EQUAL,
            backOperation : {
                fail : StencilOperation.KEEP,
                zFail : StencilOperation.KEEP,
                zPass : StencilOperation.DECREMENT_WRAP
            },
            reference : stencilReference,
            mask : stencilMask
        },
        depthTest : {
            enabled : false
        },
        depthMask : false,
        blending : BlendingState.ALPHA_BLEND
    };

    var pickRenderState = {
        stencilTest : {
            enabled : true,
            frontFunction : StencilFunction.NOT_EQUAL,
            frontOperation : {
                fail : StencilOperation.KEEP,
                zFail : StencilOperation.KEEP,
                zPass : StencilOperation.DECREMENT_WRAP
            },
            backFunction : StencilFunction.NOT_EQUAL,
            backOperation : {
                fail : StencilOperation.KEEP,
                zFail : StencilOperation.KEEP,
                zPass : StencilOperation.DECREMENT_WRAP
            },
            reference : stencilReference,
            mask : stencilMask
        },
        depthTest : {
            enabled : false
        },
        depthMask : false
    };

    function createRenderStates(primitive) {
        if (defined(primitive._rsStencilPreloadPass)) {
            return;
        }

        primitive._rsStencilPreloadPass = RenderState.fromCache(stencilPreloadRenderState);
        primitive._rsStencilDepthPass = RenderState.fromCache(stencilDepthRenderState);
        primitive._rsColorPass = RenderState.fromCache(colorRenderState);
        primitive._rsPickPass = RenderState.fromCache(pickRenderState);
    }

    var modifiedModelViewScratch = new Matrix4();
    var rtcScratch = new Cartesian3();

    function createUniformMap(primitive, context) {
        if (defined(primitive._uniformMap)) {
            return;
        }

        var uniformMap = {
            u_modifiedModelViewProjection : function() {
                var viewMatrix = context.uniformState.view;
                var projectionMatrix = context.uniformState.projection;
                Matrix4.clone(viewMatrix, modifiedModelViewScratch);
                Matrix4.multiplyByPoint(modifiedModelViewScratch, primitive._center, rtcScratch);
                Matrix4.setTranslation(modifiedModelViewScratch, rtcScratch, modifiedModelViewScratch);
                Matrix4.multiply(projectionMatrix, modifiedModelViewScratch, modifiedModelViewScratch);
                return modifiedModelViewScratch;
            },
            u_highlightColor : function() {
                return primitive._highlightColor;
            }
        };

        primitive._uniformMap = primitive._batchTable.getUniformMapCallback()(uniformMap);
        primitive._pickUniformMap = primitive._batchTable.getPickUniformMapCallback()(primitive._uniformMap);
    }

    function copyIndicesCPU(indices, newIndices, currentOffset, offsets, counts, batchIds, batchIdLookUp) {
        var sizeInBytes = indices.constructor.BYTES_PER_ELEMENT;

        var batchedIdsLength = batchIds.length;
        for (var j = 0; j < batchedIdsLength; ++j) {
            var batchedId = batchIds[j];
            var index = batchIdLookUp[batchedId];
            var offset = offsets[index];
            var count = counts[index];

            var subarray = new indices.constructor(indices.buffer, sizeInBytes * offset, count);
            newIndices.set(subarray, currentOffset);

            offsets[index] = currentOffset;
            currentOffset += count;
        }

        return currentOffset;
    }

    function rebatchCPU(primitive, batchedIndices) {
        var indices = primitive._indices;
        var indexOffsets = primitive._indexOffsets;
        var indexCounts = primitive._indexCounts;
        var batchIdLookUp = primitive._batchIdLookUp;

        var newIndices = new indices.constructor(indices.length);

        var current = batchedIndices.pop();
        var newBatchedIndices = [current];

        var currentOffset = copyIndicesCPU(indices, newIndices, 0, indexOffsets, indexCounts, current.batchIds, batchIdLookUp);

        current.offset = 0;
        current.count = currentOffset;

        while (batchedIndices.length > 0) {
            var next = batchedIndices.pop();
            if (Color.equals(next.color, current.color)) {
                currentOffset = copyIndicesCPU(indices, newIndices, currentOffset, indexOffsets, indexCounts, next.batchIds, batchIdLookUp);
                current.batchIds = current.batchIds.concat(next.batchIds);
                current.count = currentOffset - current.offset;
            } else {
                var offset = currentOffset;
                currentOffset = copyIndicesCPU(indices, newIndices, currentOffset, indexOffsets, indexCounts, next.batchIds, batchIdLookUp);

                next.offset = offset;
                next.count = currentOffset - offset;
                newBatchedIndices.push(next);
                current = next;
            }
        }

        primitive._va.indexBuffer.copyFromArrayView(newIndices);

        primitive._indices = newIndices;
        primitive._batchedIndices = newBatchedIndices;
    }

    function copyIndicesGPU(readBuffer, writeBuffer, currentOffset, offsets, counts, batchIds, batchIdLookUp) {
        var sizeInBytes = readBuffer.bytesPerIndex;

        var batchedIdsLength = batchIds.length;
        for (var j = 0; j < batchedIdsLength; ++j) {
            var batchedId = batchIds[j];
            var index = batchIdLookUp[batchedId];
            var offset = offsets[index];
            var count = counts[index];

            writeBuffer.copyFromBuffer(readBuffer, offset * sizeInBytes, currentOffset * sizeInBytes, count * sizeInBytes);

            offsets[index] = currentOffset;
            currentOffset += count;
        }

        return currentOffset;
    }

    function rebatchGPU(primitive, batchedIndices) {
        var indexOffsets = primitive._indexOffsets;
        var indexCounts = primitive._indexCounts;
        var batchIdLookUp = primitive._batchIdLookUp;

        var current = batchedIndices.pop();
        var newBatchedIndices = [current];

        var readBuffer = primitive._va.indexBuffer;
        var writeBuffer = primitive._vaSwap.indexBuffer;

        var currentOffset = copyIndicesGPU(readBuffer, writeBuffer, 0, indexOffsets, indexCounts, current.batchIds, batchIdLookUp);

        current.offset = 0;
        current.count = currentOffset;

        while (batchedIndices.length > 0) {
            var next = batchedIndices.pop();
            if (Color.equals(next.color, current.color)) {
                currentOffset = copyIndicesGPU(readBuffer, writeBuffer, currentOffset, indexOffsets, indexCounts, next.batchIds, batchIdLookUp);
                current.batchIds = current.batchIds.concat(next.batchIds);
                current.count = currentOffset - current.offset;
            } else {
                var offset = currentOffset;
                currentOffset = copyIndicesGPU(readBuffer, writeBuffer, currentOffset, indexOffsets, indexCounts, next.batchIds, batchIdLookUp);
                next.offset = offset;
                next.count = currentOffset - offset;
                newBatchedIndices.push(next);
                current = next;
            }
        }

        var temp = primitive._va;
        primitive._va = primitive._vaSwap;
        primitive._vaSwap = temp;

        primitive._batchedIndices = newBatchedIndices;
    }

    function compareColors(a, b) {
        return b.color.toRgba() - a.color.toRgba();
    }

    // PERFORMANCE_IDEA: For WebGL 2, we can use copyBufferSubData for buffer-to-buffer copies.
    // PERFORMANCE_IDEA: Not supported, but we could use glMultiDrawElements here.
    function rebatchCommands(primitive, context) {
        if (!primitive._batchDirty) {
            return false;
        }

        var batchedIndices = primitive._batchedIndices;
        var length = batchedIndices.length;

        var needToRebatch = false;
        var colorCounts = {};

        for (var i = 0; i < length; ++i) {
            var color = batchedIndices[i].color;
            var rgba = color.toRgba();
            if (defined(colorCounts[rgba])) {
                needToRebatch = true;
                break;
            } else {
                colorCounts[rgba] = true;
            }
        }

        if (!needToRebatch) {
            primitive._batchDirty = false;
            return false;
        }

        if (needToRebatch && !primitive.forceRebatch && primitive._framesSinceLastRebatch < 120) {
            ++primitive._framesSinceLastRebatch;
            return;
        }

        batchedIndices.sort(compareColors);

        if (context.webgl2) {
            rebatchGPU(primitive, batchedIndices);
        } else {
            rebatchCPU(primitive, batchedIndices);
        }

        primitive._framesSinceLastRebatch = 0;
        primitive._batchDirty = false;
        primitive._pickCommandsDirty = true;
        primitive._wireframeDirty = true;
        return true;
    }

    function createColorCommands(primitive, context) {
        var needsRebatch = rebatchCommands(primitive, context);

        var commands = primitive._commands;
        var batchedIndices = primitive._batchedIndices;
        var length = batchedIndices.length;
        var commandsLength = length * 3;

        if (defined(commands) &&
            !needsRebatch &&
            commands.length === commandsLength) {
            return;
        }

        commands.length = commandsLength;

        var vertexArray = primitive._va;
        var sp = primitive._sp;
        var modelMatrix = defaultValue(primitive._modelMatrix, Matrix4.IDENTITY);
        var uniformMap = primitive._uniformMap;
        var bv = primitive._boundingVolume;

        for (var j = 0; j < length; ++j) {
            var offset = batchedIndices[j].offset;
            var count = batchedIndices[j].count;

            var stencilPreloadCommand = commands[j * 3];
            if (!defined(stencilPreloadCommand)) {
                stencilPreloadCommand = commands[j * 3] = new DrawCommand({
                    owner : primitive
                });
            }

            stencilPreloadCommand.vertexArray = vertexArray;
            stencilPreloadCommand.modelMatrix = modelMatrix;
            stencilPreloadCommand.offset = offset;
            stencilPreloadCommand.count = count;
            stencilPreloadCommand.renderState = primitive._rsStencilPreloadPass;
            stencilPreloadCommand.shaderProgram = sp;
            stencilPreloadCommand.uniformMap = uniformMap;
            stencilPreloadCommand.boundingVolume = bv;
            stencilPreloadCommand.cull = false;

            var stencilDepthCommand = commands[j * 3 + 1];
            if (!defined(stencilDepthCommand)) {
                stencilDepthCommand = commands[j * 3 + 1] = new DrawCommand({
                    owner : primitive
                });
            }

            stencilDepthCommand.vertexArray = vertexArray;
            stencilDepthCommand.modelMatrix = modelMatrix;
            stencilDepthCommand.offset = offset;
            stencilDepthCommand.count = count;
            stencilDepthCommand.renderState = primitive._rsStencilDepthPass;
            stencilDepthCommand.shaderProgram = sp;
            stencilDepthCommand.uniformMap = uniformMap;
            stencilDepthCommand.boundingVolume = bv;
            stencilDepthCommand.cull = false;

            var colorCommand = commands[j * 3 + 2];
            if (!defined(colorCommand)) {
                colorCommand = commands[j * 3 + 2] = new DrawCommand({
                    owner : primitive
                });
            }

            colorCommand.vertexArray = vertexArray;
            colorCommand.modelMatrix = modelMatrix;
            colorCommand.offset = offset;
            colorCommand.count = count;
            colorCommand.renderState = primitive._rsColorPass;
            colorCommand.shaderProgram = sp;
            colorCommand.uniformMap = uniformMap;
            colorCommand.boundingVolume = bv;
            colorCommand.cull = false;
        }

        primitive._commandsDirty = true;
    }

    function createColorCommandsIgnoreShow(primitive, frameState) {
        if (primitive.classificationType === ClassificationType.TERRAIN ||
            !frameState.invertClassification ||
            (defined(primitive._commandsIgnoreShow) && !primitive._commandsDirty)) {
            return;
        }

        var commands = primitive._commands;
        var commandsIgnoreShow = primitive._commandsIgnoreShow;
        var spStencil = primitive._spStencil;

        var commandsLength = commands.length;
        var length = commandsIgnoreShow.length = commandsLength / 3 * 2;

        var commandIndex = 0;
        for (var j = 0; j < length; j += 2) {
            var commandIgnoreShow = commandsIgnoreShow[j] = DrawCommand.shallowClone(commands[commandIndex], commandsIgnoreShow[j]);
            commandIgnoreShow.shaderProgram = spStencil;
            commandIgnoreShow.pass = Pass.CESIUM_3D_TILE_CLASSIFICATION_IGNORE_SHOW;

            commandIgnoreShow = commandsIgnoreShow[j + 1] = DrawCommand.shallowClone(commands[commandIndex + 1], commandsIgnoreShow[j + 1]);
            commandIgnoreShow.shaderProgram = spStencil;
            commandIgnoreShow.pass = Pass.CESIUM_3D_TILE_CLASSIFICATION_IGNORE_SHOW;

            commandIndex += 3;
        }

        primitive._commandsDirty = false;
    }

    function createPickCommands(primitive) {
        if (!primitive._pickCommandsDirty) {
            return;
        }

        var length = primitive._indexOffsets.length;
        var pickCommands = primitive._pickCommands;
        pickCommands.length = length * 3;

        var vertexArray = primitive._va;
        var spStencil = primitive._spStencil;
        var spPick = primitive._spPick;
        var modelMatrix = defaultValue(primitive._modelMatrix, Matrix4.IDENTITY);
        var uniformMap = primitive._pickUniformMap;

        for (var j = 0; j < length; ++j) {
            var offset = primitive._indexOffsets[j];
            var count = primitive._indexCounts[j];
            var bv = defined(primitive._boundingVolumes) ? primitive._boundingVolumes[j] : primitive.boundingVolume;

            var stencilPreloadCommand = pickCommands[j * 3];
            if (!defined(stencilPreloadCommand)) {
                stencilPreloadCommand = pickCommands[j * 3] = new DrawCommand({
                    owner : primitive
                });
            }

            stencilPreloadCommand.vertexArray = vertexArray;
            stencilPreloadCommand.modelMatrix = modelMatrix;
            stencilPreloadCommand.offset = offset;
            stencilPreloadCommand.count = count;
            stencilPreloadCommand.renderState = primitive._rsStencilPreloadPass;
            stencilPreloadCommand.shaderProgram = spStencil;
            stencilPreloadCommand.uniformMap = uniformMap;
            stencilPreloadCommand.boundingVolume = bv;

            var stencilDepthCommand = pickCommands[j * 3 + 1];
            if (!defined(stencilDepthCommand)) {
                stencilDepthCommand = pickCommands[j * 3 + 1] = new DrawCommand({
                    owner : primitive
                });
            }

            stencilDepthCommand.vertexArray = vertexArray;
            stencilDepthCommand.modelMatrix = modelMatrix;
            stencilDepthCommand.offset = offset;
            stencilDepthCommand.count = count;
            stencilDepthCommand.renderState = primitive._rsStencilDepthPass;
            stencilDepthCommand.shaderProgram = spStencil;
            stencilDepthCommand.uniformMap = uniformMap;
            stencilDepthCommand.boundingVolume = bv;

            var colorCommand = pickCommands[j * 3 + 2];
            if (!defined(colorCommand)) {
                colorCommand = pickCommands[j * 3 + 2] = new DrawCommand({
                    owner : primitive
                });
            }

            colorCommand.vertexArray = vertexArray;
            colorCommand.modelMatrix = modelMatrix;
            colorCommand.offset = offset;
            colorCommand.count = count;
            colorCommand.renderState = primitive._rsPickPass;
            colorCommand.shaderProgram = spPick;
            colorCommand.uniformMap = uniformMap;
            colorCommand.boundingVolume = bv;
        }

        primitive._pickCommandsDirty = false;
    }

    /**
     * Creates features for each mesh and places it at the batch id index of features.
     *
     * @param {Vector3DTileContent} content The vector tile content.
     * @param {Cesium3DTileFeature[]} features An array of features where the polygon features will be placed.
     */
    Vector3DTilePrimitive.prototype.createFeatures = function(content, features) {
        var batchIds = this._batchIds;
        var length = batchIds.length;
        for (var i = 0; i < length; ++i) {
            var batchId = batchIds[i];
            features[batchId] = new Cesium3DTileFeature(content, batchId);
        }
    };

    /**
     * Colors the entire tile when enabled is true. The resulting color will be (mesh batch table color * color).
     *
     * @param {Boolean} enabled Whether to enable debug coloring.
     * @param {Color} color The debug color.
     */
    Vector3DTilePrimitive.prototype.applyDebugSettings = function(enabled, color) {
        this._highlightColor = enabled ? color : this._constantColor;
    };

    function clearStyle(polygons, features) {
        polygons._updatingAllCommands = true;

        var batchIds = polygons._batchIds;
        var length = batchIds.length;
        var i;

        for (i = 0; i < length; ++i) {
            var batchId = batchIds[i];
            var feature = features[batchId];

            feature.show = true;
            feature.color = Color.WHITE;
        }

        var batchedIndices = polygons._batchedIndices;
        length = batchedIndices.length;

        for (i = 0; i < length; ++i) {
            batchedIndices[i].color = Color.clone(Color.WHITE);
        }

        polygons._updatingAllCommands = false;
        polygons._batchDirty = true;
    }

    var scratchColor = new Color();

    var DEFAULT_COLOR_VALUE = Color.WHITE;
    var DEFAULT_SHOW_VALUE = true;

    var complexExpressionReg = /\$/;

    /**
     * Apply a style to the content.
     *
     * @param {FrameState} frameState The frame state.
     * @param {Cesium3DTileStyle} style The style.
     * @param {Cesium3DTileFeature[]} features The array of features.
     */
    Vector3DTilePrimitive.prototype.applyStyle = function(frameState, style, features) {
        if (!defined(style)) {
            clearStyle(this, features);
            return;
        }

        var colorExpression = style.color;
        var isSimpleStyle = colorExpression instanceof Expression && !complexExpressionReg.test(colorExpression.expression);
        this._updatingAllCommands = isSimpleStyle;

        var batchIds = this._batchIds;
        var length = batchIds.length;
        var i;

        for (i = 0; i < length; ++i) {
            var batchId = batchIds[i];
            var feature = features[batchId];

            feature.color = defined(style.color) ? style.color.evaluateColor(frameState, feature, scratchColor) : DEFAULT_COLOR_VALUE;
            feature.show = defined(style.show) ? style.show.evaluate(frameState, feature) : DEFAULT_SHOW_VALUE;
        }

        if (isSimpleStyle) {
            var batchedIndices = this._batchedIndices;
            length = batchedIndices.length;

            for (i = 0; i < length; ++i) {
                batchedIndices[i].color = Color.clone(Color.WHITE);
            }

            this._updatingAllCommands = false;
            this._batchDirty = true;
        }
    };

    /**
     * Call when updating the color of a mesh with batchId changes color. The meshes will need to be re-batched
     * on the next update.
     *
     * @param {Number} batchId The batch id of the meshes whose color has changed.
     * @param {Color} color The new polygon color.
     */
    Vector3DTilePrimitive.prototype.updateCommands = function(batchId, color) {
        if (this._updatingAllCommands) {
            return;
        }

        var batchIdLookUp = this._batchIdLookUp;
        var index = batchIdLookUp[batchId];
        if (!defined(index)) {
            return;
        }

        var indexOffsets = this._indexOffsets;
        var indexCounts = this._indexCounts;

        var offset = indexOffsets[index];
        var count = indexCounts[index];

        var batchedIndices = this._batchedIndices;
        var length = batchedIndices.length;

        var i;
        for (i = 0; i < length; ++i) {
            var batchedOffset = batchedIndices[i].offset;
            var batchedCount = batchedIndices[i].count;

            if (offset >= batchedOffset && offset < batchedOffset + batchedCount) {
                break;
            }
        }

        batchedIndices.push(new Vector3DTileBatch({
            color : Color.clone(color),
            offset : offset,
            count : count,
            batchIds : [batchId]
        }));

        var startIds = [];
        var endIds = [];

        var batchIds = batchedIndices[i].batchIds;
        var batchIdsLength = batchIds.length;

        for (var j = 0; j < batchIdsLength; ++j) {
            var id = batchIds[j];
            if (id === batchId) {
                continue;
            }

            var offsetIndex = batchIdLookUp[id];
            if (indexOffsets[offsetIndex] < offset) {
                startIds.push(id);
            } else {
                endIds.push(id);
            }
        }

        if (endIds.length !== 0) {
            batchedIndices.push(new Vector3DTileBatch({
                color : Color.clone(batchedIndices[i].color),
                offset : offset + count,
                count : batchedIndices[i].offset + batchedIndices[i].count - (offset + count),
                batchIds : endIds
            }));
        }

        if (startIds.length !== 0) {
            batchedIndices[i].count = offset - batchedIndices[i].offset;
            batchedIndices[i].batchIds = startIds;
        } else {
            batchedIndices.splice(i, 1);
        }

        this._batchDirty = true;
    };

    function queueCommands(frameState, pass, commands, commandsIgnoreShow) {
        var commandList = frameState.commandList;
        var commandLength = commands.length;
        var i;
        for (i = 0; i < commandLength; ++i) {
            var command = commands[i];
            command.pass = pass;
            commandList.push(command);
        }

        if (!frameState.invertClassification || !defined(commandsIgnoreShow)) {
            return;
        }

        commandLength = commandsIgnoreShow.length;
        for (i = 0; i < commandLength; ++i) {
            commandList.push(commandsIgnoreShow[i]);
        }
    }

    function queueWireframeCommands(frameState, commands) {
        var commandList = frameState.commandList;
        var commandLength = commands.length;
        for (var i = 0; i < commandLength; i += 3) {
            var command = commands[i + 2];
            command.pass = Pass.OPAQUE;
            commandList.push(command);
        }
    }

    function updateWireframe(primitive) {
        var earlyExit = primitive.debugWireframe === primitive._debugWireframe;
        earlyExit = earlyExit && !(primitive.debugWireframe && primitive._wireframeDirty);
        if (earlyExit) {
            return;
        }

        if (!defined(primitive._rsWireframe)) {
            primitive._rsWireframe = RenderState.fromCache({});
        }

        var rs;
        var type;

        if (primitive.debugWireframe) {
            rs = primitive._rsWireframe;
            type = PrimitiveType.LINES;
        } else {
            rs = primitive._rsColorPass;
            type = PrimitiveType.TRIANGLES;
        }

        var commands = primitive._commands;
        var commandLength = commands.length;
        for (var i = 0; i < commandLength; i += 3) {
            var command = commands[i + 2];
            command.renderState = rs;
            command.primitiveType = type;
        }

        primitive._debugWireframe = primitive.debugWireframe;
        primitive._wireframeDirty = false;
    }

    /**
     * Updates the batches and queues the commands for rendering.
     *
     * @param {FrameState} frameState The current frame state.
     */
    Vector3DTilePrimitive.prototype.update = function(frameState) {
        var context = frameState.context;

        createVertexArray(this, context);
        createShaders(this, context);
        createRenderStates(this);
        createUniformMap(this, context);

        var pass;
        switch (this.classificationType) {
            case ClassificationType.TERRAIN:
                pass = Pass.TERRAIN_CLASSIFICATION;
                break;
            case ClassificationType.CESIUM_3D_TILE:
                pass = Pass.CESIUM_3D_TILE_CLASSIFICATION;
                break;
            default:
                pass = Pass.CLASSIFICATION;
        }

        var passes = frameState.passes;
        if (passes.render) {
            createColorCommands(this, context);
            createColorCommandsIgnoreShow(this, frameState);
            updateWireframe(this);

            if (this._debugWireframe) {
                queueWireframeCommands(frameState, this._commands);
            } else {
                queueCommands(frameState, pass, this._commands, this._commandsIgnoreShow);
            }
        }

        if (passes.pick) {
            createPickCommands(this);
            queueCommands(frameState, pass, this._pickCommands);
        }
    };

    /**
     * Returns true if this object was destroyed; otherwise, false.
     * <p>
     * If this object was destroyed, it should not be used; calling any function other than
     * <code>isDestroyed</code> will result in a {@link DeveloperError} exception.
     * </p>
     *
     * @returns {Boolean} <code>true</code> if this object was destroyed; otherwise, <code>false</code>.
     */
    Vector3DTilePrimitive.prototype.isDestroyed = function() {
        return false;
    };

    /**
     * Destroys the WebGL resources held by this object.  Destroying an object allows for deterministic
     * release of WebGL resources, instead of relying on the garbage collector to destroy this object.
     * <p>
     * Once an object is destroyed, it should not be used; calling any function other than
     * <code>isDestroyed</code> will result in a {@link DeveloperError} exception.  Therefore,
     * assign the return value (<code>undefined</code>) to the object as done in the example.
     * </p>
     *
     * @exception {DeveloperError} This object was destroyed, i.e., destroy() was called.
     */
    Vector3DTilePrimitive.prototype.destroy = function() {
        this._va = this._va && this._va.destroy();
        this._sp = this._sp && this._sp.destroy();
        this._spPick = this._spPick && this._spPick.destroy();
        this._vaSwap = this._vaSwap && this._vaSwap.destroy();
        return destroyObject(this);
    };

    return Vector3DTilePrimitive;
});
