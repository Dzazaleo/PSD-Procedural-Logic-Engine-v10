import React, { memo, useEffect, useRef, useState, useMemo, useCallback } from 'react';
import { Handle, Position, NodeProps, NodeResizer, useEdges } from 'reactflow';
import { useProceduralStore } from '../store/ProceduralContext';
import { PSDNodeData, TransformedLayer, TransformedPayload } from '../types';
import { findLayerByPath } from '../services/psdService';
import { Psd } from 'ag-psd';
import { Monitor, Eye, Activity, Grid3X3, Maximize, Scan, ZoomIn, ZoomOut, MousePointer2, Layers } from 'lucide-react';

// --- HELPER: Render Single Layer ---
const renderLayer = (ctx: CanvasRenderingContext2D, layer: TransformedLayer, psd: Psd, isPolishedView: boolean) => {
    if (!layer.isVisible) return;

    if (layer.children && layer.children.length > 0) {
        // Reverse iteration for bottom-up composition
        for (let i = layer.children.length - 1; i >= 0; i--) {
            renderLayer(ctx, layer.children[i], psd, isPolishedView);
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
        
        // Handle Rotation
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

            // C) Surgical Approval Dot (Polished Mode Only)
            if (isPolishedView) {
                const cx = layer.coords.x + layer.coords.w / 2;
                const cy = layer.coords.y + layer.coords.h / 2;
                
                ctx.beginPath();
                ctx.arc(cx, cy, 3, 0, Math.PI * 2);
                ctx.fillStyle = '#10b981'; // Emerald-500
                ctx.fill();
                ctx.lineWidth = 1;
                ctx.strokeStyle = '#064e3b'; // Emerald-900
                ctx.stroke();
            }

        } catch(e) { /* Ignore empty/invalid canvas draw attempts */ }
        ctx.restore();
    }
};

// --- HELPER: Diagnostic Overlays ---
const drawDiagnostics = (ctx: CanvasRenderingContext2D, w: number, h: number, showGrid: boolean, showSafe: boolean) => {
    ctx.save();
    
    // 1. Rule of Thirds Grid
    if (showGrid) {
        ctx.strokeStyle = 'rgba(16, 185, 129, 0.3)'; // Emerald-500/30
        ctx.lineWidth = 1;
        
        // Verticals
        ctx.beginPath();
        ctx.moveTo(w / 3, 0); ctx.lineTo(w / 3, h);
        ctx.moveTo((w / 3) * 2, 0); ctx.lineTo((w / 3) * 2, h);
        ctx.stroke();

        // Horizontals
        ctx.beginPath();
        ctx.moveTo(0, h / 3); ctx.lineTo(w, h / 3);
        ctx.moveTo(0, (h / 3) * 2); ctx.lineTo(w, (h / 3) * 2);
        ctx.stroke();

        // Center Crosshair
        ctx.strokeStyle = 'rgba(16, 185, 129, 0.6)';
        ctx.setLineDash([5, 5]);
        ctx.beginPath();
        ctx.moveTo(w / 2, 0); ctx.lineTo(w / 2, h);
        ctx.moveTo(0, h / 2); ctx.lineTo(w, h / 2);
        ctx.stroke();
        ctx.setLineDash([]);
    }

    // 2. Title Safe Area (90%)
    if (showSafe) {
        const paddingX = w * 0.05;
        const paddingY = h * 0.05;
        const safeW = w * 0.9;
        const safeH = h * 0.9;

        ctx.strokeStyle = 'rgba(239, 68, 68, 0.4)'; // Red-500/40
        ctx.lineWidth = 1;
        ctx.setLineDash([2, 2]);
        ctx.strokeRect(paddingX, paddingY, safeW, safeH);
        
        ctx.fillStyle = 'rgba(239, 68, 68, 0.4)';
        ctx.font = '9px monospace';
        ctx.fillText('TITLE SAFE', paddingX + 4, paddingY + 10);
    }

    ctx.restore();
};

export const DesignPreviewNode = memo(({ id }: NodeProps<PSDNodeData>) => {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const containerRef = useRef<HTMLDivElement>(null);
    
    // State: Viewport & Interaction
    const [viewport, setViewport] = useState({ x: 0, y: 0, k: 1 });
    const [isDragging, setIsDragging] = useState(false);
    const lastMousePos = useRef({ x: 0, y: 0 });

    // State: Diagnostics & Modes
    const [mode, setMode] = useState<'REMAPPER' | 'CARO_FINAL'>('REMAPPER');
    const [showGrid, setShowGrid] = useState(false);
    const [showSafe, setShowSafe] = useState(true);
    const [status, setStatus] = useState<'NO_SIGNAL' | 'RENDERING' | 'RASTER_LIVE'>('NO_SIGNAL');

    const edges = useEdges();
    
    // Connect to Store
    const { payloadRegistry, reviewerRegistry, psdRegistry, unregisterNode } = useProceduralStore();

    useEffect(() => {
        return () => unregisterNode(id);
    }, [id, unregisterNode]);

    // 1. Resolve Connected Payload based on Mode
    const payload = useMemo(() => {
        const edge = edges.find(e => e.target === id && e.targetHandle === 'payload-in');
        if (!edge) return null;
        
        if (mode === 'CARO_FINAL') {
             // Prefer Reviewer data
             if (reviewerRegistry[edge.source]?.[edge.sourceHandle || '']) {
                 return reviewerRegistry[edge.source][edge.sourceHandle || ''];
             }
        }
        
        // Fallback or Remapper Mode
        if (payloadRegistry[edge.source]?.[edge.sourceHandle || '']) {
             return payloadRegistry[edge.source][edge.sourceHandle || ''];
        }
        return null;
    }, [edges, id, payloadRegistry, reviewerRegistry, mode]);

    // 2. Viewport Handlers
    const handleWheel = useCallback((e: React.WheelEvent) => {
        e.stopPropagation();
        e.preventDefault();
        
        const zoomSensitivity = 0.001;
        const delta = -e.deltaY * zoomSensitivity;
        const newScale = Math.min(Math.max(viewport.k + delta, 0.1), 10);
        
        setViewport(prev => ({ ...prev, k: newScale }));
    }, [viewport.k]);

    const handleMouseDown = useCallback((e: React.MouseEvent) => {
        e.stopPropagation();
        setIsDragging(true);
        lastMousePos.current = { x: e.clientX, y: e.clientY };
    }, []);

    const handleMouseMove = useCallback((e: React.MouseEvent) => {
        if (!isDragging) return;
        e.stopPropagation();
        
        const dx = e.clientX - lastMousePos.current.x;
        const dy = e.clientY - lastMousePos.current.y;
        
        setViewport(prev => ({ ...prev, x: prev.x + dx, y: prev.y + dy }));
        lastMousePos.current = { x: e.clientX, y: e.clientY };
    }, [isDragging]);

    const handleMouseUp = useCallback(() => {
        setIsDragging(false);
    }, []);

    const fitToView = useCallback(() => {
        if (!payload || !containerRef.current) return;
        
        const { w, h } = payload.metrics.target;
        const container = containerRef.current.getBoundingClientRect();
        
        // Calculate fit scale (with 20px padding)
        const scaleX = (container.width - 40) / w;
        const scaleY = (container.height - 40) / h;
        const scale = Math.min(scaleX, scaleY, 1); // Cap at 100% if smaller than viewport

        setViewport({ x: 0, y: 0, k: scale });
    }, [payload]);

    // Auto-fit on first load
    useEffect(() => {
        if (status === 'RASTER_LIVE' && viewport.k === 1 && viewport.x === 0) {
            fitToView();
        }
    }, [status]);

    // 3. Rendering Loop
    useEffect(() => {
        let animationFrameId: number;

        const render = () => {
            if (!payload || !canvasRef.current) {
                setStatus('NO_SIGNAL');
                return;
            }

            const psd = psdRegistry[payload.sourceNodeId];
            if (!psd) {
                setStatus('NO_SIGNAL'); 
                return;
            }

            setStatus('RENDERING');
            const canvas = canvasRef.current;
            const ctx = canvas.getContext('2d');
            if (!ctx) return;

            const { w, h } = payload.metrics.target;
            
            // Resize canvas if needed (Always match physical pixel count for accuracy)
            if (canvas.width !== w || canvas.height !== h) {
                canvas.width = w;
                canvas.height = h;
            }

            // A) Background
            ctx.fillStyle = '#1e293b'; // Slate-800
            ctx.fillRect(0, 0, w, h);

            // B) Layers
            const isPolished = mode === 'CARO_FINAL' && !!payload.isPolished;
            for (let i = payload.layers.length - 1; i >= 0; i--) {
                renderLayer(ctx, payload.layers[i], psd, isPolished);
            }
            
            // C) Diagnostic Overlays
            drawDiagnostics(ctx, w, h, showGrid, showSafe);
            
            setStatus('RASTER_LIVE');
        };

        animationFrameId = requestAnimationFrame(render);
        return () => cancelAnimationFrame(animationFrameId);
    }, [payload, psdRegistry, mode, showGrid, showSafe]);

    return (
        <div className="bg-slate-900 rounded-lg shadow-2xl border border-slate-600 w-[400px] h-[340px] font-sans flex flex-col overflow-hidden relative group transition-colors hover:border-slate-500">
             <NodeResizer minWidth={350} minHeight={250} isVisible={true} lineStyle={{ border: 'none' }} handleStyle={{ background: 'transparent' }} />
            
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
                 
                 {/* A/B Switch */}
                 <div className="flex bg-slate-900 rounded border border-slate-700 p-0.5">
                     <button 
                        onClick={() => setMode('REMAPPER')}
                        className={`text-[9px] px-2 py-0.5 rounded font-bold transition-colors ${mode === 'REMAPPER' ? 'bg-indigo-600 text-white' : 'text-slate-500 hover:text-slate-300'}`}
                     >
                        RAW
                     </button>
                     <button 
                        onClick={() => setMode('CARO_FINAL')}
                        className={`text-[9px] px-2 py-0.5 rounded font-bold transition-colors ${mode === 'CARO_FINAL' ? 'bg-emerald-600 text-white' : 'text-slate-500 hover:text-slate-300'}`}
                     >
                        POLISHED
                     </button>
                 </div>
             </div>

             {/* Canvas Container (Infinite Viewport) */}
             <div 
                ref={containerRef}
                className="flex-1 bg-[#111] relative overflow-hidden cursor-move bg-[radial-gradient(#222_1px,transparent_1px)] [background-size:16px_16px]"
                onWheel={handleWheel}
                onMouseDown={handleMouseDown}
                onMouseMove={handleMouseMove}
                onMouseUp={handleMouseUp}
                onMouseLeave={handleMouseUp}
             >
                  {status === 'NO_SIGNAL' && (
                      <div className="absolute inset-0 flex flex-col items-center justify-center text-slate-600 opacity-50 space-y-2 pointer-events-none">
                          <Eye className="w-8 h-8" />
                          <span className="text-[10px] font-mono">WAITING FOR PAYLOAD</span>
                      </div>
                  )}
                  
                  <div 
                    style={{
                        transform: `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.k})`,
                        transformOrigin: '0 0',
                        willChange: 'transform',
                        position: 'absolute',
                        top: '50%',
                        left: '50%',
                        marginTop: payload ? -payload.metrics.target.h / 2 : 0,
                        marginLeft: payload ? -payload.metrics.target.w / 2 : 0,
                    }}
                  >
                      <canvas 
                         ref={canvasRef}
                         className={`shadow-2xl transition-opacity duration-300 ${status === 'NO_SIGNAL' ? 'opacity-0' : 'opacity-100'}`}
                         // Image-rendering: pixelated ensures sharpness when zoomed in
                         style={{ imageRendering: 'pixelated' }} 
                      />
                  </div>
             </div>

             {/* Footer Controls */}
             <div className="bg-slate-900 border-t border-slate-800 p-2 flex items-center justify-between shrink-0">
                 
                 {/* Diagnostics Toggles */}
                 <div className="flex items-center space-x-1">
                     <button 
                        onClick={() => setShowGrid(!showGrid)}
                        className={`p-1.5 rounded border transition-colors ${showGrid ? 'bg-emerald-900/40 text-emerald-400 border-emerald-500/40' : 'bg-slate-800 text-slate-500 border-slate-700'}`}
                        title="Toggle Rule of Thirds"
                     >
                         <Grid3X3 className="w-3 h-3" />
                     </button>
                     <button 
                        onClick={() => setShowSafe(!showSafe)}
                        className={`p-1.5 rounded border transition-colors ${showSafe ? 'bg-red-900/30 text-red-400 border-red-500/30' : 'bg-slate-800 text-slate-500 border-slate-700'}`}
                        title="Toggle Safe Areas"
                     >
                         <Scan className="w-3 h-3" />
                     </button>
                 </div>

                 {/* Zoom Metrics & Fit */}
                 <div className="flex items-center space-x-3">
                     <div className="flex items-center space-x-1 text-[9px] font-mono text-slate-500 bg-black/20 px-1.5 py-0.5 rounded">
                         <ZoomIn className="w-3 h-3" />
                         <span>{Math.round(viewport.k * 100)}%</span>
                     </div>
                     
                     <button 
                        onClick={fitToView}
                        className="flex items-center space-x-1 px-2 py-1 bg-slate-800 hover:bg-slate-700 text-slate-300 text-[9px] font-bold uppercase rounded border border-slate-700 transition-colors"
                     >
                         <Maximize className="w-3 h-3" />
                         <span>Fit</span>
                     </button>
                 </div>
             </div>
        </div>
    );
});