import React, { memo, useEffect, useRef, useState, useMemo } from 'react';
import { Handle, Position, NodeProps, NodeResizer, useEdges } from 'reactflow';
import { useProceduralStore } from '../store/ProceduralContext';
import { PSDNodeData, TransformedLayer, TransformedPayload } from '../types';
import { findLayerByPath } from '../services/psdService';
import { Psd } from 'ag-psd';
import { Monitor, Eye, Activity } from 'lucide-react';

// Helper: Recursive Layer Renderer
const renderLayer = (ctx: CanvasRenderingContext2D, layer: TransformedLayer, psd: Psd) => {
    if (!layer.isVisible) return;

    if (layer.children && layer.children.length > 0) {
        // Reverse iteration for bottom-up composition
        for (let i = layer.children.length - 1; i >= 0; i--) {
            renderLayer(ctx, layer.children[i], psd);
        }
        return;
    }

    // A) Generative Placeholder
    if (layer.type === 'generative') {
        ctx.save();
        ctx.fillStyle = 'rgba(168, 85, 247, 0.15)'; 
        ctx.strokeStyle = 'rgba(168, 85, 247, 0.6)';
        ctx.setLineDash([4, 4]);
        ctx.lineWidth = 1;
        ctx.fillRect(layer.coords.x, layer.coords.y, layer.coords.w, layer.coords.h);
        ctx.strokeRect(layer.coords.x, layer.coords.y, layer.coords.w, layer.coords.h);
        
        // Label
        ctx.fillStyle = 'rgba(168, 85, 247, 0.9)';
        ctx.font = '10px monospace';
        ctx.fillText('AI GEN', layer.coords.x + 4, layer.coords.y + 12);
        ctx.restore();
        return;
    }

    // B) Standard Layer Pixel Data
    const originalLayer = findLayerByPath(psd, layer.id);
    if (originalLayer && originalLayer.canvas) {
        ctx.save();
        ctx.globalAlpha = layer.opacity;
        
        // Handle Rotation if present (Polished by CARO)
        if (layer.transform?.rotation) {
             const cx = layer.coords.x + layer.coords.w / 2;
             const cy = layer.coords.y + layer.coords.h / 2;
             ctx.translate(cx, cy);
             ctx.rotate((layer.transform.rotation * Math.PI) / 180);
             ctx.translate(-cx, -cy);
        }

        try {
            ctx.drawImage(
                originalLayer.canvas,
                layer.coords.x,
                layer.coords.y,
                layer.coords.w,
                layer.coords.h
            );
        } catch(e) { /* Ignore empty/invalid canvas draw attempts */ }
        ctx.restore();
    }
};

export const DesignPreviewNode = memo(({ id }: NodeProps<PSDNodeData>) => {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const [status, setStatus] = useState<'NO_SIGNAL' | 'RENDERING' | 'RASTER_LIVE'>('NO_SIGNAL');
    const edges = useEdges();
    
    // Connect to Store
    const { payloadRegistry, reviewerRegistry, psdRegistry, unregisterNode } = useProceduralStore();

    useEffect(() => {
        return () => unregisterNode(id);
    }, [id, unregisterNode]);

    // 1. Resolve Connected Payload (Priority: Reviewer -> Remapper)
    const payload = useMemo(() => {
        const edge = edges.find(e => e.target === id && e.targetHandle === 'payload-in');
        if (!edge) return null;
        
        // Check Reviewer Registry First
        if (reviewerRegistry[edge.source]?.[edge.sourceHandle || '']) {
            return reviewerRegistry[edge.source][edge.sourceHandle || ''];
        }
        // Check Standard Payload Registry
        if (payloadRegistry[edge.source]?.[edge.sourceHandle || '']) {
             return payloadRegistry[edge.source][edge.sourceHandle || ''];
        }
        return null;
    }, [edges, id, payloadRegistry, reviewerRegistry]);

    // 2. Rendering Loop
    useEffect(() => {
        let animationFrameId: number;

        const render = () => {
            if (!payload || !canvasRef.current) {
                setStatus('NO_SIGNAL');
                return;
            }

            const psd = psdRegistry[payload.sourceNodeId];
            if (!psd) {
                // Payload exists but binary is missing (e.g. not loaded)
                setStatus('NO_SIGNAL'); 
                return;
            }

            setStatus('RENDERING');
            const canvas = canvasRef.current;
            const ctx = canvas.getContext('2d');
            if (!ctx) return;

            const { w, h } = payload.metrics.target;
            
            // Resize canvas if needed
            if (canvas.width !== w || canvas.height !== h) {
                canvas.width = w;
                canvas.height = h;
            }

            // Clear Background (Neutral Grey #333333 as requested)
            ctx.fillStyle = '#333333';
            ctx.fillRect(0, 0, w, h);

            // Draw Layers
            for (let i = payload.layers.length - 1; i >= 0; i--) {
                renderLayer(ctx, payload.layers[i], psd);
            }
            
            setStatus('RASTER_LIVE');
        };

        // Trigger Render
        animationFrameId = requestAnimationFrame(render);
        return () => cancelAnimationFrame(animationFrameId);
    }, [payload, psdRegistry]);

    return (
        <div className="bg-slate-900 rounded-lg shadow-2xl border border-slate-600 w-[400px] h-[300px] font-sans flex flex-col overflow-hidden relative group transition-colors hover:border-slate-500">
             <NodeResizer minWidth={300} minHeight={200} isVisible={true} lineStyle={{ border: 'none' }} handleStyle={{ background: 'transparent' }} />
            
             {/* Input Handle */}
             <Handle 
                type="target" 
                position={Position.Left} 
                id="payload-in" 
                className="!w-3 !h-3 !bg-indigo-500 !border-2 !border-slate-800 z-50 transition-colors" 
                style={{ top: '50%', left: -5 }}
                title="Input: Transformed Payload"
             />

             {/* Header */}
             <div className="bg-slate-950 p-2 border-b border-slate-800 flex items-center justify-between shrink-0">
                 <div className="flex items-center space-x-2">
                     <Monitor className="w-4 h-4 text-indigo-400" />
                     <span className="text-xs font-bold text-slate-200 tracking-wider">VIEWPORT</span>
                 </div>
                 <div className="flex items-center space-x-2">
                     {status === 'RASTER_LIVE' && (
                         <Activity className="w-3 h-3 text-emerald-500 animate-pulse" />
                     )}
                     <span className={`text-[9px] font-mono px-1.5 py-0.5 rounded border ${
                         status === 'RASTER_LIVE' ? 'bg-emerald-900/30 text-emerald-400 border-emerald-500/30' : 'bg-slate-800 text-slate-500 border-slate-700'
                     }`}>
                         {status}
                     </span>
                 </div>
             </div>

             {/* Canvas Container */}
             <div className="flex-1 bg-[#111] relative flex items-center justify-center p-4 overflow-hidden bg-[radial-gradient(#222_1px,transparent_1px)] [background-size:16px_16px]">
                  {status === 'NO_SIGNAL' && (
                      <div className="flex flex-col items-center justify-center text-slate-600 opacity-50 space-y-2">
                          <Eye className="w-8 h-8" />
                          <span className="text-[10px] font-mono">WAITING FOR PAYLOAD</span>
                      </div>
                  )}
                  <canvas 
                     ref={canvasRef}
                     className={`shadow-2xl transition-opacity duration-300 ${status === 'NO_SIGNAL' ? 'opacity-0' : 'opacity-100'}`}
                     style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }}
                  />
             </div>
        </div>
    );
});